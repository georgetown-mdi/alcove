import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import {
  CLI,
  EXTRA_CLI_ARGS,
  GB,
  LOG_DIR,
  MAIN_THREAD_BYTES_PER_RECORD,
  RUN_TIMEOUT_MS,
  cliPartyNeedBytes,
  hostDescription,
  hostMemory,
  peakGb,
  resultDifference,
  runParty,
  writeInput,
} from "./completionRun";

import type { PartyRun } from "./completionRun";

// The built `alcove` exchanging over a synced folder or an SFTP server at 2^24
// records a side, to completion (docs/spec/FILE_SYNC.md, Measured runs at
// 2^24). Half of each side's input is shared with the other, one distinct SSN
// a record, so each party's result is known without running the exchange: the
// shared half, row for row, less the rows whose SSN the built-in
// standardization nulls. Logs the wall time and each party's peak resident
// set, PSI worker included. Two modes, chosen by environment variable:
//
// - Both parties on this host over a local directory (the default). For small
//   sizes: at 2^24 the pair needs about 64 GB.
// - One party on this host, against a partner on another
//   (ALCOVE_STRESS_COMPLETION_PARTY=starter or joiner, with
//   ALCOVE_STRESS_COMPLETION_URL naming the shared directory as a file:// or
//   sftp:// URL). Each host runs its own party at the same row count.
//
// ALCOVE_STRESS_COMPLETION_ROWS lowers the row count;
// ALCOVE_STRESS_COMPLETION_TIMEOUT_MS bounds each party (four hours by
// default); ALCOVE_STRESS_COMPLETION_CLI_ARGS adds arguments, separated by
// whitespace, to each party's command line, as SFTP credentials need;
// ALCOVE_STRESS_COMPLETION_LOG_DIR, a directory the test creates, keeps each
// party's log there as it runs (party-<name>.log) and, in one-party mode, a
// summary of the run (party-<name>.json).

const ROWS = Number(process.env.ALCOVE_STRESS_COMPLETION_ROWS ?? 2 ** 24);
const PARTY = process.env.ALCOVE_STRESS_COMPLETION_PARTY;
const URL_OF_DROP = process.env.ALCOVE_STRESS_COMPLETION_URL;
const SHARED = Math.floor(ROWS / 2);

type PartyName = "starter" | "joiner";

// The starter's round from the measured costs (docs/spec/FILE_SYNC.md, The
// measured costs): 983 bytes an element over a 62 MB baseline and an 80 MB
// intercept. The joiner's is the CLI's own budget, the costlier role.
const STARTER_BYTES_PER_ELEMENT = 983;
const STARTER_FIXED_BYTES = 142_000_000;
// The starter's measured peak a record: docs/spec/FILE_SYNC.md, Measured runs at 2^24.
const STARTER_MEASURED_PEAK_BYTES_PER_RECORD = 29_913_112_576 / 2 ** 24;
// 5% is an arbitrary working margin, raised or lowered on request.
const STARTER_PEAK_MARGIN = 1.05;

function partyNeedBytes(party: PartyName): number {
  if (party === "joiner") return cliPartyNeedBytes(ROWS);
  const modelled =
    STARTER_FIXED_BYTES +
    (STARTER_BYTES_PER_ELEMENT + MAIN_THREAD_BYTES_PER_RECORD) * ROWS;
  const measured =
    STARTER_MEASURED_PEAK_BYTES_PER_RECORD * STARTER_PEAK_MARGIN * ROWS;
  return Math.max(modelled, measured);
}

const ROLE_LINE = /\[alcove\] role: (sender|receiver)\b/;
// The starter sends; the joiner, the party arriving second, receives.
const ROLE_OF_PARTY: Record<PartyName, string> = {
  starter: "sender",
  joiner: "receiver",
};

function runFileSyncParty(
  dir: string,
  url: string,
  name: string,
  expectedRole?: string,
): Promise<PartyRun> {
  return runParty({
    dir,
    args: [
      "--no-record",
      ...EXTRA_CLI_ARGS,
      url,
      join(dir, "input.csv"),
      join(dir, "result.csv"),
    ],
    name,
    roleLine: ROLE_LINE,
    expectedRole,
  });
}

const PEER_HELLO = /-hello\.json$/;

// A party's hello, on a directory this host can list. The joiner is the party
// that finds its partner's hello there on arrival.
function peerHelloPresent(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => PEER_HELLO.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

test(
  `two file-sync parties of ${ROWS} records a side complete with the known result`,
  { timeout: RUN_TIMEOUT_MS + 30 * 60_000 },
  async (ctx) => {
    ctx.skip(
      PARTY !== undefined,
      "ALCOVE_STRESS_COMPLETION_PARTY selects the one-party mode",
    );
    ctx.skip(
      !existsSync(CLI),
      "the completion run drives the built CLI; run npm run build -w apps/cli",
    );
    const need = partyNeedBytes("starter") + partyNeedBytes("joiner");
    const memory = hostMemory();
    ctx.skip(
      memory.bytes < need,
      `two parties of ${ROWS} records need about ` +
        `${(need / GB).toFixed(1)} GB; this host's ${memory.measure} is ` +
        `${(memory.bytes / GB).toFixed(1)} GB`,
    );
    const root = mkdtempSync(join(tmpdir(), "alcove-completion-"));
    try {
      const drop = join(root, "drop");
      const a = join(root, "a");
      const b = join(root, "b");
      for (const dir of [drop, a, b]) mkdirSync(dir);
      await writeInput(join(a, "input.csv"), ROWS, 0);
      await writeInput(join(b, "input.csv"), ROWS, SHARED);

      const startedAt = performance.now();
      const [partyA, partyB] = await Promise.all([
        runFileSyncParty(a, `file://${drop}`, "a"),
        runFileSyncParty(b, `file://${drop}`, "b"),
      ]);
      const wallMs = Math.round(performance.now() - startedAt);
      console.log(
        `${ROWS} records a side: wall ${wallMs} ms; peak RSS ` +
          `${peakGb(partyA)} GB and ${peakGb(partyB)} GB; exit ` +
          `${partyA.exitCode} and ${partyB.exitCode}`,
      );
      for (const party of [partyA, partyB])
        if (party.exitCode !== 0) console.log(party.log.slice(-4000));

      expect([partyA.exitCode, partyB.exitCode]).toEqual([0, 0]);
      expect(resultDifference(join(a, "result.csv"), ROWS, "starter")).toBe(
        undefined,
      );
      expect(resultDifference(join(b, "result.csv"), ROWS, "joiner")).toBe(
        undefined,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  `one file-sync party of ${ROWS} records completes with the known result against a partner on another host`,
  { timeout: 2 * RUN_TIMEOUT_MS + 30 * 60_000 },
  async (ctx) => {
    ctx.skip(
      PARTY === undefined,
      "set ALCOVE_STRESS_COMPLETION_PARTY to starter or joiner, and " +
        "ALCOVE_STRESS_COMPLETION_URL, to run one party",
    );
    if (PARTY !== "starter" && PARTY !== "joiner")
      throw new Error(
        `ALCOVE_STRESS_COMPLETION_PARTY is ${PARTY}; set it to starter or joiner`,
      );
    if (URL_OF_DROP === undefined || !/^(file|sftp|ssh):\/\//.test(URL_OF_DROP))
      throw new Error(
        "set ALCOVE_STRESS_COMPLETION_URL to the shared directory as a " +
          "file://, sftp:// or ssh:// URL",
      );
    ctx.skip(
      !existsSync(CLI),
      "the completion run drives the built CLI; run npm run build -w apps/cli",
    );
    const need = partyNeedBytes(PARTY);
    const memory = hostMemory();
    ctx.skip(
      memory.bytes < need,
      `the ${PARTY} of ${ROWS} records needs about ` +
        `${(need / GB).toFixed(1)} GB; this host's ${memory.measure} is ` +
        `${(memory.bytes / GB).toFixed(1)} GB`,
    );
    const localDrop = URL_OF_DROP.startsWith("file://")
      ? fileURLToPath(URL_OF_DROP)
      : undefined;
    if (PARTY === "starter" && localDrop !== undefined) {
      if (!existsSync(localDrop))
        throw new Error(
          `${localDrop} does not exist: create the shared directory before ` +
            "the starter runs",
        );
      if (peerHelloPresent(localDrop))
        throw new Error(
          `${localDrop} already holds a hello: the starter arrives first, so ` +
            "clear the directory and start the joiner after the starter",
        );
    }

    const root = mkdtempSync(join(tmpdir(), "alcove-completion-"));
    try {
      await writeInput(
        join(root, "input.csv"),
        ROWS,
        PARTY === "starter" ? 0 : SHARED,
      );
      // The joiner must arrive second. On a directory this host lists, it
      // waits for the starter's hello; over SFTP the operator starts it after
      // the starter's log shows "synchronizing".
      if (PARTY === "joiner" && localDrop !== undefined) {
        console.log(`waiting for the starter's hello in ${localDrop}`);
        const deadline = performance.now() + RUN_TIMEOUT_MS;
        while (!peerHelloPresent(localDrop)) {
          if (performance.now() > deadline)
            throw new Error(
              `no starter's hello appeared in ${localDrop} within ` +
                `${RUN_TIMEOUT_MS} ms`,
            );
          await delay(2_000);
        }
      }

      const startedAt = new Date();
      const run = await runFileSyncParty(
        root,
        URL_OF_DROP,
        PARTY,
        ROLE_OF_PARTY[PARTY],
      );
      const difference =
        run.exitCode === 0
          ? resultDifference(join(root, "result.csv"), ROWS, PARTY)
          : undefined;
      console.log(
        `${PARTY}, ${ROWS} records: wall ${run.wallMs} ms; peak RSS ` +
          `${peakGb(run)} GB; role ${run.loggedRole ?? "not logged"} at ` +
          `${run.loggedRoleAtMs ?? "-"} ms; exit ${run.exitCode}`,
      );
      if (LOG_DIR !== undefined)
        writeFileSync(
          join(LOG_DIR, `party-${PARTY}.json`),
          JSON.stringify(
            {
              party: PARTY,
              rows: ROWS,
              scheme: URL_OF_DROP.slice(0, URL_OF_DROP.indexOf(":")),
              startedAt: startedAt.toISOString(),
              wallMs: run.wallMs,
              peakRssBytes: run.peakRssBytes,
              loggedRole: run.loggedRole,
              loggedRoleAtMs: run.loggedRoleAtMs,
              exitCode: run.exitCode,
              resultDifference: difference ?? null,
              host: hostDescription(),
            },
            null,
            2,
          ) + "\n",
        );
      if (run.exitCode !== 0) console.log(run.log.slice(-4000));

      expect(
        run.stoppedForRole,
        `the ${PARTY} logged role ${run.stoppedForRole} and was stopped: ` +
          "start the starter first and the joiner after it",
      ).toBe(undefined);
      expect(run.exitCode).toBe(0);
      expect(difference).toBe(undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
