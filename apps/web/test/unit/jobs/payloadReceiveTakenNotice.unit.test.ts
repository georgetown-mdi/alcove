import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  payloadReceiveTakenConsoleNotice,
  relayedTakenColumns,
} from "@jobs/payloadReceiveTakenNotice";
import { JOB_FILE_NAMES } from "@jobs/intentSchemas";
import { JobManager } from "@jobs/jobManager";
import { appendSanitizedRunWarning } from "@psi/runWarnings";

import {
  STUB_CLI_PATH,
  STUB_CONFIG_FILE_TOKEN,
  tempDataRoot,
  validIntent,
  validZeroSetupIntent,
} from "../../utils/jobFixtures";

import type { JobCreateIntent } from "@jobs/intentSchemas";
import type { JobRecord } from "@jobs/jobManager";
import type { RelayEvent } from "@jobs/cliDriver";

// What the console tells an operator when a run it drove took the payload
// columns its partner declares without asking. The CLI's own line names the
// configuration file it wrote them into, a path inside this container, and
// promises later exchanges hold the partner to them, which only that per-run
// file does; the relay rebuilds the notice from the event's column list.

const dirs: Array<string> = [];
const managers: Array<JobManager> = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function scratchDir(label: string): string {
  const dir = tempDataRoot(label);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

/** The CLI's fill warning as it writes it on fd 3: its message names the
 * configuration (the token the stub replaces with its --config-file value),
 * and its column list holds each name as the CLI escaped it. */
const CLI_TAKEN_EVENT = {
  v: 1,
  type: "warning",
  source: "payloadReceiveTaken",
  message:
    "this unattended run took the payload columns your partner declares it " +
    'sends you, without asking: "program", "county". They were written to ' +
    `${STUB_CONFIG_FILE_TOKEN} as linkage_terms.payload.receive, and later ` +
    "exchanges refuse a partner that sends a different list.",
  columns: ["program", "county"],
  columnCount: 3,
};

/** One job of `intent` driven to its terminal event, its child emitting the
 * fill warning and a result. */
async function runTakingJob(
  label: string,
  intent: JobCreateIntent,
): Promise<{ dataRoot: string; record: JobRecord }> {
  const dataRoot = scratchDir(`${label}-root`);
  const manager = new JobManager({
    dataRoot,
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: scratchDir(`${label}-rvz`),
    childEnv: {
      STUB_EXIT_CODE: "0",
      STUB_FD3_EVENTS: JSON.stringify([
        CLI_TAKEN_EVENT,
        { v: 1, type: "result", resultWritten: true },
      ]),
    },
  });
  managers.push(manager);
  const id = await manager.createJob(intent);
  const record = manager.getJob(id)!;
  const deadline = Date.now() + 5000;
  while (!record.terminalEmitted) {
    if (Date.now() > deadline)
      throw new Error("timed out waiting for terminal");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { dataRoot, record };
}

/** The single warning among the events a record buffered. */
function soleWarning(record: JobRecord): RelayEvent {
  const warnings = record.events
    .map((entry) => entry.event)
    .filter((event) => event.type === "warning");
  expect(warnings).toHaveLength(1);
  return warnings[0];
}

describe("the relayed fill notice states no container path", () => {
  test("an exchange run's notice is the console's, naming the columns and where to record them", async () => {
    const { dataRoot, record } = await runTakingJob("taken", validIntent());
    const notice = soleWarning(record);
    expect(notice.source).toBe("payloadReceiveTaken");
    expect(notice.columns).toEqual(["program", "county"]);
    expect(notice.columnCount).toBe(3);
    expect(notice.message).toBe(
      payloadReceiveTakenConsoleNotice("exchange", {
        columns: ["program", "county"],
        columnCount: 3,
      }),
    );
    expect(notice.message).toContain(
      'The columns taken: "program", "county", and 1 more.',
    );
    expect(notice.message).toContain("linkage_terms.payload.receive");
    expect(notice.message).not.toContain(dataRoot);
    expect(notice.message).not.toContain(
      path.join(record.workdir, JOB_FILE_NAMES.config),
    );
  });

  test("a direct exchange's notice says no configuration records them", async () => {
    const { dataRoot, record } = await runTakingJob(
      "taken-direct",
      validZeroSetupIntent(),
    );
    const notice = soleWarning(record);
    expect(notice.message).toBe(
      payloadReceiveTakenConsoleNotice("zeroSetup", {
        columns: ["program", "county"],
        columnCount: 3,
      }),
    );
    expect(notice.message).toContain("records them in no configuration");
    expect(notice.message).not.toContain(dataRoot);
  });
});

describe("the fill notice on the run view", () => {
  test("shows each partner column name quoted and escaped once, at the run view's warning sink", () => {
    const [shown] = appendSanitizedRunWarning(
      [],
      payloadReceiveTakenConsoleNotice("exchange", {
        columns: ["bell\u0007", "café", 'x", "y'],
        columnCount: 3,
      }),
    );
    expect(shown).toContain(
      'The columns taken: "bell\\x07", "caf\\xe9", "x\\\\", \\\\"y".',
    );
    expect(shown).not.toContain("\u0007");
    expect(shown).not.toContain("é");
  });

  test("a column list that is not the CLI's shape leaves the names out rather than the notice", () => {
    for (const malformed of [
      { columns: "program", columnCount: 1 },
      { columns: [1], columnCount: 1 },
      { columns: ["program"], columnCount: 0 },
      { columns: ["program"] },
    ]) {
      const taken = relayedTakenColumns({
        v: 1,
        type: "warning",
        ...malformed,
      });
      expect(taken).toBeUndefined();
      expect(payloadReceiveTakenConsoleNotice("exchange", taken)).not.toContain(
        "The columns taken",
      );
    }
  });
});
