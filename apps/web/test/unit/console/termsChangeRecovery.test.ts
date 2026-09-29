import { describe, expect, test } from "vitest";

import {
  RelayedTerminalError,
  relayedTermsChangeOf,
} from "@psi/jobClient/serverJobExchangeDriver";
import { applyJobTermsProposal } from "@psi/jobClient/termsProposalClient";
import { failureFor } from "@exchange/useInviterExchange";
import { termsApplyOutcomeText } from "@console/termsChangeRecoveryModel";
import { termsChangeView } from "@psi/termsChangeView";

import type { RelayEvent } from "@jobs/cliDriver";

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
    sent: { added: [], removed: ["zip"] },
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
          "Columns you no longer send your partner (your partner decides on this)",
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
      expect(termsApplyOutcomeText(outcome)).toMatch(/\.$/);
    expect(termsApplyOutcomeText("configuration-changed")).toContain(
      "nothing was applied",
    );
    expect(termsApplyOutcomeText("run-terms-differ")).toContain(
      "from the command line with alcove apply",
    );
    expect(termsApplyOutcomeText("run-terms-differ")).toContain(
      "open the configuration again",
    );
  });
});
