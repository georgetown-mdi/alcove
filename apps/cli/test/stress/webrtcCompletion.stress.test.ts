import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { expect, test } from "vitest";

import {
  CLI,
  EXTRA_CLI_ARGS,
  GB,
  LOG_DIR,
  RUN_TIMEOUT_MS,
  cliPartyNeedBytes,
  hostDescription,
  hostMemory,
  maxLoopLagSince,
  peakGb,
  resultDifference,
  runParty,
  writeInput,
} from "./completionRun";

import type { PartyRun } from "./completionRun";

// The built `alcove` exchanging CLI to CLI over WebRTC, to completion: the
// WebRTC counterpart of fileSyncCompletion.stress.test.ts, over the same
// population and known result. Logs the wall time and each party's peak
// resident set, PSI worker included. Two modes, chosen by environment
// variable:
//
// - Both parties on this host over loopback (the default).
// - One party on this host, against a partner on another
//   (ALCOVE_STRESS_COMPLETION_PARTY=inviter or acceptor, with
//   ALCOVE_STRESS_COMPLETION_SECRET holding the shared secret both hosts set,
//   43 base64url characters, and ALCOVE_STRESS_COMPLETION_BROKER_URL naming
//   a broker both hosts reach). Each host runs its own party at the same row
//   count, in either order: a party waits up to an hour for its partner.
//
// Each party runs `alcove exchange` on the configuration `alcove init` writes
// from its input, with the connection block replaced by a `channel: webrtc`
// one -- one party `role: inviter`, the other `role: acceptor` -- and a key
// file holding one shared secret. The signaling broker is not started here:
// run `npm start -w packages/peerjs-broker -- --port 9000` first, or name
// another with ALCOVE_STRESS_COMPLETION_BROKER_URL (a ws:// URL, mount path
// included).
//
// ALCOVE_STRESS_COMPLETION_ROWS lowers the row count;
// ALCOVE_STRESS_COMPLETION_TIMEOUT_MS bounds each party (four hours by
// default); ALCOVE_STRESS_COMPLETION_CLI_ARGS adds arguments, separated by
// whitespace, to each party's command line;
// ALCOVE_STRESS_COMPLETION_LOG_DIR, a directory the test creates, keeps each
// party's log there as it runs (party-<name>.log), each time its event loop
// ran over a second late (loop-lag-<name>.log), and a summary of the run
// (webrtc-completion.json, or party-<name>.json in one-party mode). A summary
// names the candidate pair the channel opened over when the party logs at
// debug level (--log-level debug in ALCOVE_STRESS_COMPLETION_CLI_ARGS).

// Past the 7,643,790 elements one WebRTC frame holds (docs/spec/PROTOCOL.md,
// The memory ceiling and the CSV intake cap), so each first-round set goes in
// two parts.
const ROWS = Number(process.env.ALCOVE_STRESS_COMPLETION_ROWS ?? 7_700_000);
const BROKER_URL = new URL(
  process.env.ALCOVE_STRESS_COMPLETION_BROKER_URL ?? "ws://127.0.0.1:9000/api",
);
const SHARED = Math.floor(ROWS / 2);
const PARTY = process.env.ALCOVE_STRESS_COMPLETION_PARTY;
const PARTY_SECRET = process.env.ALCOVE_STRESS_COMPLETION_SECRET;
// The shape the CLI's key file requires of a shared secret.
const SHARED_SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;
// One-party mode's wait for the partner at the rendezvous, so the two hosts
// need not start together: an arbitrary working value.
const ONE_PARTY_PEER_TIMEOUT_MS = 3_600_000;

// The inviter holds the population from 0, as the file-sync starter does; the
// acceptor holds it from SHARED, as the joiner does.
type PartyName = "inviter" | "acceptor";
const POPULATION_PARTY = {
  inviter: "starter",
  acceptor: "joiner",
} as const;
const POPULATION_OFFSET: Record<PartyName, number> = {
  inviter: 0,
  acceptor: SHARED,
};

function connectionBlock(role: PartyName, peerTimeoutMs?: number): string {
  const secure = BROKER_URL.protocol === "wss:";
  const port = BROKER_URL.port === "" ? (secure ? 443 : 80) : BROKER_URL.port;
  // The host-candidates-only form docs/CLI.md documents (STUN, and what it
  // discloses): both parties are on this host or on one network.
  return (
    "connection:\n" +
    "  channel: webrtc\n" +
    "  server:\n" +
    `    host: ${BROKER_URL.hostname}\n` +
    `    port: ${port}\n` +
    `    path: ${BROKER_URL.pathname}\n` +
    `    secure: ${secure}\n` +
    `  role: ${role}\n` +
    "  stun:\n" +
    "    - stun:127.0.0.1:3478\n" +
    (peerTimeoutMs === undefined
      ? ""
      : `  options:\n    peer_timeout_ms: ${peerTimeoutMs}\n`)
  );
}

// Writes the party's alcove.yaml and .alcove.key into `dir`: the linkage terms
// `alcove init` infers from the input under a webrtc connection block.
function writeConfiguration(
  dir: string,
  role: PartyName,
  sharedSecret: string,
  peerTimeoutMs?: number,
): void {
  const configPath = join(dir, "alcove.yaml");
  const init = spawnSync(
    process.execPath,
    [
      CLI,
      "init",
      join(dir, "input.csv"),
      "--config-file",
      configPath,
      "--identity",
      role,
    ],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  );
  if (init.status !== 0)
    throw new Error(
      `alcove init exited ${init.status} for the ${role}:\n${init.stderr}`,
    );
  const template = readFileSync(configPath, "utf8");
  const start = template.indexOf("\nconnection:\n");
  const end = template.indexOf("\nlinkage_terms:\n");
  if (start === -1 || end === -1 || end < start)
    throw new Error(
      "the alcove init template has no connection block ahead of its " +
        "linkage_terms block",
    );
  writeFileSync(
    configPath,
    template.slice(0, start + 1) +
      connectionBlock(role, peerTimeoutMs) +
      template.slice(end + 1),
  );
  writeFileSync(
    join(dir, ".alcove.key"),
    JSON.stringify({ sharedSecret }, null, 2) + "\n",
    { mode: 0o600 },
  );
}

const ROLE_LINE = /\[exchange\] role: (sender|receiver)\b/;

// The line a party logs once its data channel is open, with the time it did.
const CHANNEL_OPEN_LINE = /^\[(\S+)\] \[INFO\] \[exchange\] authenticating$/m;

// An arbitrary working value, raised or lowered on request (docs/spec/
// WEBRTC_TRANSPORT.md, The main thread on an open channel).
const MAX_CONNECTED_LOOP_LAG_MS = 15_000;

// The longest the party's main thread was held from its channel opening on, or
// undefined when its log has no line stating when that was.
function connectedLoopLagMs(run: PartyRun): number | undefined {
  const openedAt = CHANNEL_OPEN_LINE.exec(run.log)?.[1];
  return openedAt === undefined
    ? undefined
    : maxLoopLagSince(run, Date.parse(openedAt));
}

// The line a party logs at debug level once its channel is open.
const CANDIDATE_PAIR_LINE =
  /\[DEBUG\] .*the data channel opened over candidate pair (.+)$/m;

function candidatePair(run: PartyRun): string | undefined {
  return CANDIDATE_PAIR_LINE.exec(run.log)?.[1];
}

function partySummary(run: PartyRun, difference: string | undefined) {
  return {
    wallMs: run.wallMs,
    peakRssBytes: run.peakRssBytes,
    maxConnectedLoopLagMs: connectedLoopLagMs(run) ?? null,
    candidatePair: candidatePair(run) ?? null,
    loggedRole: run.loggedRole,
    loggedRoleAtMs: run.loggedRoleAtMs,
    exitCode: run.exitCode,
    resultDifference: difference ?? null,
  };
}

function expectConnectedLoopLagWithinBound(
  name: PartyName,
  run: PartyRun,
): void {
  const lagMs = connectedLoopLagMs(run);
  if (lagMs === undefined)
    expect.fail(
      `the ${name}'s log has no "[exchange] authenticating" line, so ` +
        `when its channel opened is unknown`,
    );
  expect(lagMs, `the ${name}'s longest hold`).toBeLessThanOrEqual(
    MAX_CONNECTED_LOOP_LAG_MS,
  );
}

function runWebRtcParty(dir: string, name: PartyName): Promise<PartyRun> {
  return runParty({
    dir,
    args: [
      "exchange",
      "--no-record",
      ...EXTRA_CLI_ARGS,
      join(dir, "input.csv"),
      join(dir, "result.csv"),
    ],
    name,
    roleLine: ROLE_LINE,
  });
}

// The broker's readiness endpoint, `health` under its mount path.
async function brokerIsReady(): Promise<boolean> {
  const health = new URL(BROKER_URL.href);
  health.protocol = BROKER_URL.protocol === "wss:" ? "https:" : "http:";
  health.pathname = `${BROKER_URL.pathname.replace(/\/$/, "")}/health`;
  try {
    const response = await fetch(health, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

const NO_BROKER_MESSAGE =
  `no signaling broker answers at ${BROKER_URL.href}: start one with ` +
  "npm start -w packages/peerjs-broker -- --port 9000, or set " +
  "ALCOVE_STRESS_COMPLETION_BROKER_URL";

test(
  `two WebRTC parties of ${ROWS} records a side complete with the known result`,
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
    const need = 2 * cliPartyNeedBytes(ROWS);
    const memory = hostMemory();
    ctx.skip(
      memory.bytes < need,
      `two parties of ${ROWS} records need about ` +
        `${(need / GB).toFixed(1)} GB; this host's ${memory.measure} is ` +
        `${(memory.bytes / GB).toFixed(1)} GB`,
    );
    if (!(await brokerIsReady())) throw new Error(NO_BROKER_MESSAGE);
    const root = mkdtempSync(join(tmpdir(), "alcove-completion-"));
    try {
      const a = join(root, "a");
      const b = join(root, "b");
      for (const dir of [a, b]) mkdirSync(dir);
      await writeInput(join(a, "input.csv"), ROWS, POPULATION_OFFSET.inviter);
      await writeInput(join(b, "input.csv"), ROWS, POPULATION_OFFSET.acceptor);
      const sharedSecret = randomBytes(32).toString("base64url");
      writeConfiguration(a, "inviter", sharedSecret);
      writeConfiguration(b, "acceptor", sharedSecret);

      const startedAt = new Date();
      const startedAtMs = performance.now();
      const [inviter, acceptor] = await Promise.all([
        runWebRtcParty(a, "inviter"),
        runWebRtcParty(b, "acceptor"),
      ]);
      const wallMs = Math.round(performance.now() - startedAtMs);
      console.log(
        `${ROWS} records a side: wall ${wallMs} ms; peak RSS ` +
          `${peakGb(inviter)} GB and ${peakGb(acceptor)} GB; roles ` +
          `${inviter.loggedRole ?? "not logged"} and ` +
          `${acceptor.loggedRole ?? "not logged"}; exit ` +
          `${inviter.exitCode} and ${acceptor.exitCode}; longest hold of ` +
          `the main thread on an open channel ` +
          `${connectedLoopLagMs(inviter) ?? "not logged"} ms and ` +
          `${connectedLoopLagMs(acceptor) ?? "not logged"} ms`,
      );
      const inviterDifference =
        inviter.exitCode === 0
          ? resultDifference(
              join(a, "result.csv"),
              ROWS,
              POPULATION_PARTY.inviter,
            )
          : undefined;
      const acceptorDifference =
        acceptor.exitCode === 0
          ? resultDifference(
              join(b, "result.csv"),
              ROWS,
              POPULATION_PARTY.acceptor,
            )
          : undefined;
      if (LOG_DIR !== undefined) {
        writeFileSync(
          join(LOG_DIR, "webrtc-completion.json"),
          JSON.stringify(
            {
              rows: ROWS,
              broker: BROKER_URL.href,
              startedAt: startedAt.toISOString(),
              wallMs,
              inviter: partySummary(inviter, inviterDifference),
              acceptor: partySummary(acceptor, acceptorDifference),
              host: {
                ...hostDescription(),
                gateMemoryBytes: memory.bytes,
                gateNeedBytes: need,
              },
            },
            null,
            2,
          ) + "\n",
        );
      }
      for (const party of [inviter, acceptor])
        if (party.exitCode !== 0) console.log(party.log.slice(-4000));

      expect([inviter.exitCode, acceptor.exitCode]).toEqual([0, 0]);
      expect(inviterDifference).toBe(undefined);
      expect(acceptorDifference).toBe(undefined);
      expectConnectedLoopLagWithinBound("inviter", inviter);
      expectConnectedLoopLagWithinBound("acceptor", acceptor);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  `one WebRTC party of ${ROWS} records completes with the known result against a partner on another host`,
  { timeout: RUN_TIMEOUT_MS + ONE_PARTY_PEER_TIMEOUT_MS + 30 * 60_000 },
  async (ctx) => {
    ctx.skip(
      PARTY === undefined,
      "set ALCOVE_STRESS_COMPLETION_PARTY to inviter or acceptor, and " +
        "ALCOVE_STRESS_COMPLETION_SECRET and " +
        "ALCOVE_STRESS_COMPLETION_BROKER_URL, to run one party",
    );
    if (PARTY !== "inviter" && PARTY !== "acceptor")
      throw new Error(
        `ALCOVE_STRESS_COMPLETION_PARTY is ${PARTY}; set it to inviter or acceptor`,
      );
    if (PARTY_SECRET === undefined || !SHARED_SECRET_SHAPE.test(PARTY_SECRET))
      throw new Error(
        "set ALCOVE_STRESS_COMPLETION_SECRET to one 43-character base64url " +
          "value on both hosts, for example the output of node -e " +
          "\"console.log(crypto.randomBytes(32).toString('base64url'))\"",
      );
    ctx.skip(
      !existsSync(CLI),
      "the completion run drives the built CLI; run npm run build -w apps/cli",
    );
    const need = cliPartyNeedBytes(ROWS);
    const memory = hostMemory();
    ctx.skip(
      memory.bytes < need,
      `the ${PARTY} of ${ROWS} records needs about ` +
        `${(need / GB).toFixed(1)} GB; this host's ${memory.measure} is ` +
        `${(memory.bytes / GB).toFixed(1)} GB`,
    );
    if (!(await brokerIsReady())) throw new Error(NO_BROKER_MESSAGE);

    const root = mkdtempSync(join(tmpdir(), "alcove-completion-"));
    try {
      await writeInput(join(root, "input.csv"), ROWS, POPULATION_OFFSET[PARTY]);
      writeConfiguration(root, PARTY, PARTY_SECRET, ONE_PARTY_PEER_TIMEOUT_MS);
      const partner = PARTY === "inviter" ? "acceptor" : "inviter";
      console.log(
        `the ${PARTY} waits up to ${ONE_PARTY_PEER_TIMEOUT_MS / 60_000} ` +
          `minutes at ${BROKER_URL.href} for the ${partner}: start it on the ` +
          "other host with the same ALCOVE_STRESS_COMPLETION_ROWS, " +
          "ALCOVE_STRESS_COMPLETION_SECRET and " +
          "ALCOVE_STRESS_COMPLETION_BROKER_URL",
      );

      const startedAt = new Date();
      const run = await runWebRtcParty(root, PARTY);
      const difference =
        run.exitCode === 0
          ? resultDifference(
              join(root, "result.csv"),
              ROWS,
              POPULATION_PARTY[PARTY],
            )
          : undefined;
      console.log(
        `${PARTY}, ${ROWS} records: wall ${run.wallMs} ms; peak RSS ` +
          `${peakGb(run)} GB; role ${run.loggedRole ?? "not logged"} at ` +
          `${run.loggedRoleAtMs ?? "-"} ms; candidate pair ` +
          `${candidatePair(run) ?? "not logged"}; exit ${run.exitCode}; ` +
          `longest hold of the main thread on an open channel ` +
          `${connectedLoopLagMs(run) ?? "not logged"} ms`,
      );
      if (LOG_DIR !== undefined)
        writeFileSync(
          join(LOG_DIR, `party-${PARTY}.json`),
          JSON.stringify(
            {
              party: PARTY,
              rows: ROWS,
              broker: BROKER_URL.href,
              startedAt: startedAt.toISOString(),
              ...partySummary(run, difference),
              host: {
                ...hostDescription(),
                gateMemoryBytes: memory.bytes,
                gateNeedBytes: need,
              },
            },
            null,
            2,
          ) + "\n",
        );
      if (run.exitCode !== 0) console.log(run.log.slice(-4000));

      expect(run.exitCode).toBe(0);
      expect(difference).toBe(undefined);
      expectConnectedLoopLagWithinBound(PARTY, run);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
