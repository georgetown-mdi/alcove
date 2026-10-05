import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  latestRunStamp,
  parseRunArtifactName,
  runArtifactNames,
  stampOfResultPath,
} from "@jobs/runArtifactNames";
import { JOB_FILE_NAMES } from "@jobs/intentSchemas";
import { JobManager } from "@jobs/jobManager";
import { latestRunStampIn } from "@jobs/runArtifacts";
import { outputFolderArgument } from "@jobs/cliDriver";
import { readJobFolderContents } from "@jobs/jobFolder";

import {
  STUB_CLI_PATH,
  TEST_RUN_CREATED_AT,
  TEST_RUN_STAMP,
  tempDataRoot,
  validIntent,
  validZeroSetupIntent,
} from "../../utils/jobFixtures";

import type { JobCreateIntent } from "@jobs/intentSchemas";

// The console runs the CLI on the output-folder form: the job's workdir is the
// OUTPUT positional and the folder the child runs in, no `--record-file` and no
// `signing.receipt_output` are passed, and every run artifact is found by the
// run's stamp rather than by a fixed name.

const PARTNER_FINGERPRINT = "C".repeat(42) + "A";

const EARLIER_STAMP = "2026-07-08T09-00-00-000Z";
const LATER_STAMP = "2026-07-08T20-15-30-500Z";

const roots: Array<string> = [];
const managers: Array<JobManager> = [];

beforeEach(() => {
  vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const manager of managers.splice(0)) manager.shutdown();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function directory(label: string): string {
  const dir = tempDataRoot(label);
  roots.push(dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function recordJson(createdAt: string): string {
  return JSON.stringify({
    createdAt,
    outcome: "completed",
    certificateMismatchObserved: false,
  });
}

/** Run one job against the stub CLI to its terminal event, returning the
 * manager, the job id, its workdir and the argv the stub was spawned with. */
async function runJob(
  intent: JobCreateIntent,
  stubEnv: Record<string, string>,
): Promise<{
  manager: JobManager;
  id: string;
  workdir: string;
  argv: Array<string>;
}> {
  const dataRoot = directory("run-artifacts");
  const argvFile = path.join(directory("run-artifacts-argv"), "argv.json");
  const manager = new JobManager({
    dataRoot,
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: directory("run-artifacts-rvz"),
    childEnv: { STUB_ARGV_FILE: argvFile, ...stubEnv },
  });
  managers.push(manager);
  const id = await manager.createJob(intent);
  const deadline = Date.now() + 10_000;
  for (;;) {
    const record = manager.getJob(id);
    if (record !== undefined && record.terminal !== null) break;
    if (Date.now() > deadline) throw new Error("the job did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const argv = (
    JSON.parse(fs.readFileSync(argvFile, "utf8")) as Array<string>
  ).slice(2);
  return { manager, id, workdir: manager.getJob(id)!.workdir, argv };
}

const RESULT_EVENT = { v: 1, type: "result", resultWritten: true };

describe("run artifact names", () => {
  test("each kind parses back to its stamp", () => {
    const names = runArtifactNames(TEST_RUN_STAMP);
    for (const [kind, name] of Object.entries(names))
      expect(parseRunArtifactName(name)).toEqual({
        kind,
        stamp: TEST_RUN_STAMP,
      });
  });

  test.each([
    ["results.csv"],
    ["record.json"],
    ["alcove-results-latest.csv"],
    ["alcove-results-2026-07-08T14-32-00-000Z.json"],
    ["alcove-receipt-2026-07-08T14-32-00-000Z.keys.json"],
    ["alcove-record-2026-07-08T14:32:00.000Z.json"],
    ["alcove-results-../2026-07-08T14-32-00-000Z.csv"],
  ])("%s is not a run artifact", (name) => {
    expect(parseRunArtifactName(name)).toBeNull();
  });

  test("the latest stamp is the latest instant, whatever the fraction's width", () => {
    expect(
      latestRunStamp([
        LATER_STAMP,
        "2026-07-08T20-15-30Z",
        EARLIER_STAMP,
        "2026-07-08T20-15-30-49Z",
      ]),
    ).toBe(LATER_STAMP);
    expect(latestRunStamp([])).toBeNull();
  });

  test("a result path's stamp is read off its last segment only", () => {
    expect(
      stampOfResultPath(`/data/job/alcove-results-${TEST_RUN_STAMP}.csv`),
    ).toBe(TEST_RUN_STAMP);
    expect(stampOfResultPath(`/data/job/alcove-results-2026-07-0`)).toBeNull();
    expect(
      stampOfResultPath(`/data/job/alcove-record-${TEST_RUN_STAMP}.json`),
    ).toBeNull();
    expect(stampOfResultPath(undefined)).toBeNull();
  });
});

describe("the console runs the CLI on the output-folder form", () => {
  test("an exchange run passes the job folder as OUTPUT, no --record-file, and no receipt_output", async () => {
    const { workdir, argv } = await runJob(
      validIntent({
        signing: {
          mode: "certificate",
          partnerFingerprint: PARTNER_FINGERPRINT,
        },
      }),
      { STUB_FD3_EVENTS: JSON.stringify([RESULT_EVENT]) },
    );
    expect(argv[0]).toBe("exchange");
    expect(argv.some((token) => token.startsWith("--record-file"))).toBe(false);
    expect(argv[argv.length - 1]).toBe(outputFolderArgument(workdir));

    const config = parseYaml(
      fs.readFileSync(path.join(workdir, JOB_FILE_NAMES.config), "utf8"),
    ) as { signing?: Record<string, unknown> };
    expect(config.signing?.mode).toBe("certificate");
    expect(config.signing).not.toHaveProperty("receipt_output");
  });

  test("a zero-setup run passes the job folder as OUTPUT and no --record-file", async () => {
    const { workdir, argv } = await runJob(validZeroSetupIntent(), {
      STUB_FD3_EVENTS: JSON.stringify([RESULT_EVENT]),
    });
    expect(argv.some((token) => token.startsWith("--record-file"))).toBe(false);
    expect(argv[argv.length - 1]).toBe(outputFolderArgument(workdir));
  });

  test("the run's result, record, keys and receipt are found under the stamp the CLI wrote", async () => {
    const { manager, id, workdir } = await runJob(
      validIntent({
        signing: {
          mode: "certificate",
          partnerFingerprint: PARTNER_FINGERPRINT,
        },
      }),
      {
        STUB_FD3_EVENTS: JSON.stringify([RESULT_EVENT]),
        STUB_OUTPUT_FILE: "id\n1\n",
        STUB_RECORD_JSON: recordJson(TEST_RUN_CREATED_AT),
        STUB_RECEIPT_JSON: JSON.stringify({ version: 1 }),
      },
    );
    const names = runArtifactNames(TEST_RUN_STAMP);
    const view = manager.getJobView(id)!;
    expect(view.status).toBe("succeeded");
    expect(view.outputPath).toBe(path.join(workdir, names.result));
    expect(view.resultFileName).toBe(names.result);
    expect(view.recordPath).toBe(path.join(workdir, names.record));
    expect(view.keysPath).toBe(path.join(workdir, names.keys));
    expect(view.receiptPath).toBe(path.join(workdir, names.receipt));
    expect(view.recordAvailable).toBe(true);
    expect(view.receiptAvailable).toBe(true);
    for (const name of [names.result, names.record, names.keys, names.receipt])
      expect(fs.existsSync(path.join(workdir, name)), name).toBe(true);
  });
});

describe("a job folder holding several runs' artifacts", () => {
  test("the run the result event named is served whole, a later run's record notwithstanding", async () => {
    const { manager, id, workdir } = await runJob(validIntent(), {
      STUB_FD3_EVENTS: JSON.stringify([RESULT_EVENT]),
      STUB_OUTPUT_FILE: "id\n1\n",
      STUB_RECORD_JSON: recordJson(TEST_RUN_CREATED_AT),
    });
    const later = runArtifactNames(LATER_STAMP);
    fs.writeFileSync(
      path.join(workdir, later.record),
      recordJson("2026-07-08T20:15:30.500Z"),
    );
    fs.writeFileSync(path.join(workdir, later.keys), "{}");
    expect(latestRunStampIn(workdir)).toBe(LATER_STAMP);

    const own = runArtifactNames(TEST_RUN_STAMP);
    const view = manager.getJobView(id)!;
    expect(view.outputPath).toBe(path.join(workdir, own.result));
    expect(view.recordPath).toBe(path.join(workdir, own.record));
    expect(view.keysPath).toBe(path.join(workdir, own.keys));
    expect(view.recordCreatedAt).toBe(TEST_RUN_CREATED_AT);
  });

  test("a run whose event named no result file is the latest run, and an earlier run's record is not taken for it", async () => {
    const { manager, id, workdir } = await runJob(validIntent(), {
      STUB_FD3_EVENTS: JSON.stringify([]),
    });
    const earlier = runArtifactNames(EARLIER_STAMP);
    const later = runArtifactNames(LATER_STAMP);
    fs.writeFileSync(
      path.join(workdir, earlier.record),
      recordJson("2026-07-08T09:00:00.000Z"),
    );
    fs.writeFileSync(path.join(workdir, earlier.keys), "{}");
    fs.writeFileSync(path.join(workdir, later.result), "id\n1\n");

    const view = manager.getJobView(id)!;
    expect(view.outputPath).toBe(path.join(workdir, later.result));
    expect(view.recordPath).toBe(path.join(workdir, later.record));
    expect(view.recordAvailable).toBe(false);
    expect(view.recordUnavailableReason).toBe("no-record");
  });

  test("a finished run whose event named no result file lists its folder once, not on every status read", async () => {
    const { manager, id, workdir } = await runJob(validIntent(), {
      STUB_FD3_EVENTS: JSON.stringify([]),
    });
    const later = runArtifactNames(LATER_STAMP);
    fs.writeFileSync(path.join(workdir, later.result), "id\n1\n");
    expect(manager.getJobView(id)!.outputPath).toBe(
      path.join(workdir, later.result),
    );

    const readdir = vi.spyOn(fs, "readdirSync");
    try {
      const view = manager.getJobView(id)!;
      manager.getJobView(id);
      expect(view.outputPath).toBe(path.join(workdir, later.result));
      expect(
        readdir.mock.calls.filter(([dir]) => String(dir) === workdir),
      ).toEqual([]);
    } finally {
      readdir.mockRestore();
    }
  });

  test("the folder answer counts each kind of artifact whichever run wrote it", () => {
    const workdir = directory("run-artifacts-folder");
    fs.writeFileSync(
      path.join(workdir, runArtifactNames(EARLIER_STAMP).receipt),
      "{}",
    );
    fs.writeFileSync(
      path.join(workdir, runArtifactNames(LATER_STAMP).result),
      "id\n",
    );
    fs.writeFileSync(path.join(workdir, "results.csv"), "id\n");
    expect(readJobFolderContents(workdir)).toEqual({
      results: true,
      record: false,
      sharedSecret: false,
      receipt: true,
      log: false,
      input: false,
    });
  });
});
