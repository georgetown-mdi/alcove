import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { stringify as stringifyYaml } from "yaml";

import { snakeizeKeys } from "@alcove/core";

import { ERROR_MESSAGE_CHAIN_FIELD } from "@psi/relayErrorChain";

import {
  JobManager,
  TERMS_CHANGE_REFUSAL,
  TERMS_PROPOSAL_REFUSAL,
} from "@jobs/jobManager";
import { TERMS_PROPOSAL_FILE_NAME, termsApplyArgv } from "@jobs/termsProposal";
import { validateAndSanitizeEvent } from "@jobs/cliDriver";

import {
  STUB_CLI_PATH,
  VALID_SHARED_SECRET,
  tempDataRoot,
  validIntent,
  validLinkageTerms,
} from "../../utils/jobFixtures";

import type { JobFiledropExchangeIntent } from "@jobs/intentSchemas";
import type { JobRecord } from "@jobs/jobManager";

const roots: Array<string> = [];
const managers: Array<JobManager> = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function scratch(label: string): string {
  const dir = tempDataRoot(label);
  roots.push(dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The terminal event the CLI emits for a partner terms change it wrote as a
 * proposal, naming the job's own configuration path as the real one does. */
const REFUSAL_EVENT = {
  v: 1,
  type: "error",
  category: "config",
  message:
    "this run is not attended. Your partner's terms were written to " +
    "__CONFIG_FILE__. Review and apply them.",
  termsChange: {
    proposalWritten: true,
    received: { added: ["county"], removed: [] },
    otherTerms: [],
  },
};

/** A mounted working folder holding a configuration and the key beside it. */
function mountedRoot(): string {
  const root = scratch("apply-terms");
  fs.writeFileSync(
    path.join(root, "alcove.yaml"),
    stringifyYaml(
      snakeizeKeys({
        connection: { channel: "filedrop", path: "/srv/exchange" },
        linkageTerms: validLinkageTerms(),
      }),
    ),
  );
  fs.writeFileSync(
    path.join(root, ".alcove.key"),
    JSON.stringify({ sharedSecret: VALID_SHARED_SECRET }),
    { mode: 0o600 },
  );
  return root;
}

function managerFor(
  root: string,
  stub: NodeJS.ProcessEnv = {},
  events: Array<unknown> = [REFUSAL_EVENT],
): JobManager {
  const manager = new JobManager({
    dataRoot: root,
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: scratch("rvz"),
    childEnv: {
      STUB_FD3_EVENTS: JSON.stringify(events),
      STUB_EXIT_CODE: "64",
      STUB_TERMS_PROPOSAL: "proposal",
      ...stub,
    },
  });
  managers.push(manager);
  return manager;
}

function openedIntent(): JobFiledropExchangeIntent {
  const { sharedSecret: _omitted, ...intent } = validIntent();
  return { ...intent, mountedConfigurationOpened: true };
}

async function settledRun(manager: JobManager, id: string): Promise<JobRecord> {
  const record = manager.getJob(id)!;
  const deadline = Date.now() + 5000;
  while (record.terminal === null) {
    if (Date.now() > deadline) throw new Error("the child did not exit");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return record;
}

describe("applying the terms proposal a run of the opened configuration stopped on", () => {
  test("runs alcove apply against the mounted files, answering its prompt", async () => {
    const root = mountedRoot();
    const answerFile = path.join(scratch("answer"), "stdin");
    const manager = managerFor(root, {
      STUB_APPLY_STDIN_FILE: answerFile,
    });
    manager.openMountedConfiguration();
    const id = await manager.createJob(openedIntent());
    const record = await settledRun(manager, id);
    expect(record.termsProposal).toBe("available");
    expect(
      fs.existsSync(path.join(record.workdir, TERMS_PROPOSAL_FILE_NAME)),
    ).toBe(true);

    const before = fs.readFileSync(path.join(root, "alcove.yaml"), "utf8");
    expect(await manager.applyTermsProposal(id)).toEqual({ kind: "applied" });
    expect(fs.readFileSync(answerFile, "utf8")).toBe("y\n");
    expect(fs.readFileSync(path.join(root, "alcove.yaml"), "utf8")).not.toBe(
      before,
    );
    expect(record.termsProposal).toBe("applied");
    // Applied once: a second request has nothing left to apply.
    expect(await manager.applyTermsProposal(id)).toEqual({
      kind: "unavailable",
    });
  });

  test("names the mounted configuration, the key file beside it, and the run's proposal", () => {
    expect(
      termsApplyArgv({
        binaryPath: "/app/cli.js",
        configPath: "/data/alcove.yaml",
        keyPath: "/data/.alcove.key",
        proposalPath: "/data/job/alcove.proposed-terms",
      }),
    ).toEqual([
      "/app/cli.js",
      "apply",
      "--config-file=/data/alcove.yaml",
      "--key-file=/data/.alcove.key",
      "@/data/job/alcove.proposed-terms",
    ]);
  });

  test("replaces the CLI's refusal, which names container paths, with the console's", async () => {
    const root = mountedRoot();
    const manager = managerFor(root);
    manager.openMountedConfiguration();
    const id = await manager.createJob(openedIntent());
    const record = await settledRun(manager, id);
    const terminal = record.events.at(-1)!.event;
    expect(terminal.message).toBe(TERMS_PROPOSAL_REFUSAL);
    expect(terminal[ERROR_MESSAGE_CHAIN_FIELD]).toEqual([
      TERMS_PROPOSAL_REFUSAL,
    ]);
    expect(terminal.termsChange).toEqual(REFUSAL_EVENT.termsChange);
  });

  test("is unavailable to a run composed from the browser's own settings", async () => {
    const root = mountedRoot();
    const manager = managerFor(root);
    const id = await manager.createJob(validIntent());
    const record = await settledRun(manager, id);
    expect(record.termsProposal).toBe("none");
    expect(record.events.at(-1)!.event.message).toBe(TERMS_CHANGE_REFUSAL);
    expect(await manager.applyTermsProposal(id)).toEqual({
      kind: "unavailable",
    });
  });

  test("is unavailable to a run that wrote no proposal", async () => {
    const root = mountedRoot();
    const manager = managerFor(root, {}, [
      {
        ...REFUSAL_EVENT,
        category: "exchange",
        termsChange: { ...REFUSAL_EVENT.termsChange, proposalWritten: false },
      },
    ]);
    manager.openMountedConfiguration();
    const id = await manager.createJob(openedIntent());
    await settledRun(manager, id);
    expect(await manager.applyTermsProposal(id)).toEqual({
      kind: "unavailable",
    });
  });

  test("refuses where the mounted configuration changed after it was opened", async () => {
    const root = mountedRoot();
    const manager = managerFor(root);
    manager.openMountedConfiguration();
    const id = await manager.createJob(openedIntent());
    await settledRun(manager, id);
    fs.appendFileSync(path.join(root, "alcove.yaml"), "# edited\n");
    const edited = fs.readFileSync(path.join(root, "alcove.yaml"), "utf8");
    expect(await manager.applyTermsProposal(id)).toEqual({
      kind: "configuration-changed",
    });
    expect(fs.readFileSync(path.join(root, "alcove.yaml"), "utf8")).toBe(
      edited,
    );
  });

  test("reports the CLI's refusal and leaves the proposal available", async () => {
    const root = mountedRoot();
    const manager = managerFor(root, { STUB_APPLY_EXIT_CODE: "64" });
    manager.openMountedConfiguration();
    const id = await manager.createJob(openedIntent());
    const record = await settledRun(manager, id);
    expect(await manager.applyTermsProposal(id)).toEqual({ kind: "refused" });
    expect(record.termsProposal).toBe("available");
  });

  test("an apply that exits 0 without rewriting the configuration is not applied", async () => {
    const root = mountedRoot();
    const manager = managerFor(root, { STUB_APPLY_EXIT_CODE: "0" });
    manager.openMountedConfiguration();
    const id = await manager.createJob(openedIntent());
    await settledRun(manager, id);
    expect(await manager.applyTermsProposal(id)).toEqual({ kind: "error" });
  });
});

describe("the relayed terms change", () => {
  test("keeps the known fields, each string escaped again", () => {
    const event = validateAndSanitizeEvent({
      ...REFUSAL_EVENT,
      termsChange: {
        proposalWritten: true,
        received: { added: ["a\u202eb"], removed: [] },
        partnerDeduplicate: { expected: false, presented: true },
        otherTerms: ["x".repeat(600)],
        smuggled: "field",
      },
    });
    expect(event?.termsChange).toEqual({
      proposalWritten: true,
      received: { added: ["a\\u202eb"], removed: [] },
      partnerDeduplicate: { expected: false, presented: true },
      otherTerms: ["x".repeat(600)],
    });
  });

  test("drops a change that is not the shape the CLI emits", () => {
    for (const termsChange of [
      "text",
      { proposalWritten: "yes", otherTerms: [] },
      { proposalWritten: true, otherTerms: [1] },
      { proposalWritten: true, otherTerms: [], received: { added: [] } },
      {
        proposalWritten: true,
        otherTerms: [],
        partnerDeduplicate: { expected: "false", presented: true },
      },
      {
        proposalWritten: true,
        otherTerms: Array.from({ length: 257 }, () => "x"),
      },
    ])
      expect(
        validateAndSanitizeEvent({ ...REFUSAL_EVENT, termsChange }),
      ).not.toHaveProperty("termsChange");
  });
});
