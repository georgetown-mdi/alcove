import { describe, expect, test } from "vitest";

import {
  RelayedTerminalError,
  relayedTermsChangeOf,
} from "@psi/jobClient/serverJobExchangeDriver";
import { applyJobTermsProposal } from "@psi/jobClient/termsProposalClient";
import { buildImageReference } from "@psi/dockerRunCommand";
import { failureFor } from "@exchange/useInviterExchange";
import { termsApplyOutcomeMessage } from "@console/termsChangeRecoveryModel";
import { termsChangeView } from "@psi/termsChangeView";

import type { RelayEvent } from "@jobContract/relayEvent";

/** The sentence an apply outcome shows, without its command. */
function termsApplyOutcomeText(
  ...args: Parameters<typeof termsApplyOutcomeMessage>
): string {
  return termsApplyOutcomeMessage(...args).message;
}

/** A run id, the name of its folder in the working folder. */
const JOB_ID = "3f2b8c1e-0d4a-4c6e-9a51-7e2f0b9c4d13";

/** The proposal a run composed in its own folder left there. */
const RUN_FOLDER = { jobId: JOB_ID };

/** The proposal a run of the working folder's own alcove.yaml left beside it. */
const WORKING_FOLDER = { inWorkingFolder: true } as const;

const RELAYED_EVENT: RelayEvent = {
  v: 1,
  type: "error",
  category: "config",
  message: "Your partner's linkage terms changed.",
  termsChange: {
    proposalWritten: true,
    received: { added: ["county"], removed: ["notes"] },
    partnerDeduplicate: { expected: false, presented: true },
    otherTerms: [],
  },
};

describe("a relayed terms change", () => {
  test("is read off the terminal event whole", () => {
    expect(relayedTermsChangeOf(RELAYED_EVENT)).toEqual({
      proposalWritten: true,
      delta: {
        received: { added: ["county"], removed: ["notes"] },
        sent: undefined,
        partnerDeduplicate: { expected: false, presented: true },
        otherTerms: [],
      },
    });
  });

  test("is absent where the event states none or states a malformed one", () => {
    expect(
      relayedTermsChangeOf({ ...RELAYED_EVENT, termsChange: undefined }),
    ).toBeUndefined();
    expect(
      relayedTermsChangeOf({
        ...RELAYED_EVENT,
        termsChange: { proposalWritten: true, otherTerms: [], sent: {} },
      }),
    ).toBeUndefined();
  });

  test("becomes a config failure the run step shows with the change, offering no retry", () => {
    const error = new RelayedTerminalError(RELAYED_EVENT.message as string);
    error.termsChange = relayedTermsChangeOf(RELAYED_EVENT);
    const failure = failureFor("exchange", error);
    expect(failure.category).toBe("config");
    expect(failure.title).toBe("Your partner's linkage terms changed");
    expect(failure.message).toBe("Your partner's linkage terms changed.");
    expect(failure.termsChange).toBe(error.termsChange);
    expect(failure.retry).toBe("withheld");
  });
});

describe("the terms change as the web app shows it", () => {
  const delta = {
    received: { added: ["a\u202eb"], removed: [] },
    sent: { added: ["zip"], removed: [] },
    partnerDeduplicate: { expected: false, presented: true },
    otherTerms: ["algorithm mismatch"],
  };

  test("uses the command line's sections and labels, escaping a raw name", () => {
    expect(termsChangeView(delta, false)).toEqual([
      {
        label: "Columns your partner now sends you",
        entries: ["a\\u202eb"],
      },
      {
        label:
          "Columns you no longer send your partner (your partner decides on these)",
        entries: ["zip"],
      },
      { label: "Your partner's deduplicate", entries: ["false -> true"] },
      { label: "Other terms that differ", entries: ["algorithm mismatch"] },
    ]);
  });

  test("leaves a name the console already escaped as it arrived", () => {
    expect(
      termsChangeView(
        { ...delta, received: { added: ["a\\u202eb"], removed: [] } },
        true,
      )[0]?.entries,
    ).toEqual(["a\\u202eb"]);
  });
});

describe("applying the proposal from the run step", () => {
  const respond =
    (status: number, body?: unknown): typeof fetch =>
    () =>
      Promise.resolve(
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
        }),
      );

  test("reads each answer the console gives", async () => {
    expect(
      await applyJobTermsProposal("id", respond(200, { status: "applied" })),
    ).toBe("applied");
    expect(
      await applyJobTermsProposal(
        "id",
        respond(200, { status: "configuration-changed" }),
      ),
    ).toBe("configuration-changed");
    expect(
      await applyJobTermsProposal(
        "id",
        respond(200, { status: "run-terms-differ" }),
      ),
    ).toBe("run-terms-differ");
    expect(await applyJobTermsProposal("id", respond(404))).toBe("unavailable");
    expect(await applyJobTermsProposal("id", respond(409))).toBe("busy");
    expect(
      await applyJobTermsProposal("id", respond(200, { status: "timeout" })),
    ).toBe("error");
    expect(
      await applyJobTermsProposal("id", () =>
        Promise.reject(new Error("offline")),
      ),
    ).toBe("error");
  });

  test("says what happened and what to do where nothing was applied", () => {
    for (const outcome of [
      "busy",
      "configuration-changed",
      "run-terms-differ",
      "refused",
      "unavailable",
      "error",
    ] as const)
      expect(termsApplyOutcomeText(outcome, RUN_FOLDER)).toMatch(/\.$/);
    expect(
      termsApplyOutcomeText("configuration-changed", RUN_FOLDER),
    ).toContain("nothing was applied");
    expect(termsApplyOutcomeText("run-terms-differ", RUN_FOLDER)).toContain(
      "open the configuration again",
    );
  });

  test("names the apply as the command over the working folder for each system, on this run's proposal", () => {
    const image = buildImageReference();
    for (const outcome of [
      "run-terms-differ",
      "unavailable",
      "error",
    ] as const) {
      const message = termsApplyOutcomeMessage(outcome, RUN_FOLDER);
      expect(message.message).toContain("the command below for your system");
      expect(message.command).toEqual({
        runCommand:
          'docker run --rm -it --user "$(id -u):$(id -g)" --mount ' +
          '"type=bind,src=/path/to/your/working-folder,dst=/work" ' +
          `${image} apply @${JOB_ID}/alcove.proposed-terms`,
        windowsRunCommand:
          "docker run --rm -it --mount " +
          '"type=bind,src=C:\\path\\to\\your\\working-folder,dst=/work" ' +
          `${image} apply "@${JOB_ID}/alcove.proposed-terms"`,
        podmanRunCommand:
          "podman run --rm -it --userns=keep-id:uid=1000,gid=1000 --mount " +
          '"type=bind,src=/path/to/your/working-folder,dst=/work" ' +
          `${image} apply @${JOB_ID}/alcove.proposed-terms`,
      });
    }
    for (const outcome of [
      "busy",
      "configuration-changed",
      "refused",
    ] as const) {
      const message = termsApplyOutcomeMessage(outcome, RUN_FOLDER);
      expect(message.command).toBeUndefined();
      expect(message.message).not.toContain("command below");
    }
  });

  test("names the proposal beside the working folder's alcove.yaml for a run of that file", () => {
    const image = buildImageReference();
    for (const outcome of ["unavailable", "error"] as const) {
      const { command } = termsApplyOutcomeMessage(outcome, WORKING_FOLDER);
      expect(command?.runCommand).toBe(
        'docker run --rm -it --user "$(id -u):$(id -g)" --mount ' +
          '"type=bind,src=/path/to/your/working-folder,dst=/work" ' +
          `${image} apply alcove.proposed-terms`,
      );
      expect(command?.windowsRunCommand).toBe(
        "docker run --rm -it --mount " +
          '"type=bind,src=C:\\path\\to\\your\\working-folder,dst=/work" ' +
          `${image} apply alcove.proposed-terms`,
      );
      expect(Object.values(command ?? {}).join(" ")).not.toContain("@");
    }
    expect(
      termsApplyOutcomeText("configuration-changed", WORKING_FOLDER),
    ).toContain("after this run started");
  });
});
