import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

import {
  decodeInvitation,
  deriveRelayExchangeId,
  deriveRelayKey,
} from "@alcove/core";

import {
  cliEntry,
  fillInConnection,
  pairsFromResultCsv,
  resultFileIn,
} from "../interop/cliParty.ts";
import { trackChild } from "../utils/childProcess.ts";

import {
  CLI_IDENTITY,
  CLI_PARTY_CSV,
  LEG_ENVIRONMENT_FAILURE,
} from "./legTypes.ts";

import type { LiveLegCliOutcome, MatchedPair } from "./legTypes.ts";
import type { ChildProcessByStdio } from "node:child_process";
import type { LiveRelay } from "./liveRelay.ts";
import type { Readable } from "node:stream";

/**
 * The `alcove` party of the live WebRTC leg: the real command-line program,
 * spawned the way the console's job driver spawns it, holding the inviter
 * seat while the browser peer accepts.
 *
 * The CLI takes the inviter seat rather than the acceptor because that is what
 * puts the broker on an origin of its own: the invitation the CLI mints from
 * its `ws://` coordination-server URL names that broker's host, port and mount,
 * and the browser peer dials what the invitation names. A browser inviter would
 * name its own deployment's signaling address instead (`ownSignalingAddress`).
 *
 * Nothing here parses the CLI's output beyond two fixed things -- the
 * invitation on stdout, and the timestamp of the "closing connection" line the
 * close wait is measured from.
 */

/** Longest to wait for the invitation to reach stdout. The mint is local work
 * (reading the CSV, inferring terms, writing the key file), so this bounds a
 * process that failed to start rather than a slow one. */
const INVITATION_TIMEOUT_MS = 60_000;

/**
 * The inviting party's budget for the whole run: the wait for the browser peer
 * to accept, plus the peer waits of the exchange after it. It has to clear a
 * cold Chromium start, the browser's WASM engine load, and an ICE round, so it
 * is sized well above the exchange itself.
 */
export const CLI_ACCEPT_TIMEOUT_MS = 240_000;

/**
 * Hard deadline on the process, past the budget above so a run that hangs is
 * reported as killed rather than absorbed into the budget's own expiry.
 */
const CLI_DEADLINE_MS = 300_000;

/** Longest to wait for the relay case's CLI party to reach the relay. Its
 * dial starts with its rendezvous, so this bounds a run that failed to start
 * rather than a slow one. */
const RELAY_HELLO_TIMEOUT_MS = 60_000;

/** A STUN address nothing answers on, so the relay case's parties gather host
 * candidates only and contact no server off this machine. */
const UNREACHABLE_STUN = "stun:127.0.0.1:9";

/** The message fragment the close wait is measured from: the CLI writes it
 * immediately before the transport close that drains to acknowledgement and
 * tears the channel down (`closeRunLayers` in apps/cli/src/protocol.ts). */
const CLOSING_CONNECTION_LINE = "closing connection";

/** An invitation is the one base64url run long enough to be a token. */
const INVITATION_SHAPE = /^[A-Za-z0-9_-]{200,}$/;

/** An `alcove` inviter that has printed its invitation and is waiting for the
 * partner. */
export interface CliInviter {
  /** The invitation it printed, for the browser peer to accept. */
  invitation: string;
  /** Wait for the run to end and report what it did. */
  outcome: () => Promise<LiveLegCliOutcome>;
  /** Kill the run if it is still going, and remove its working directory.
   * Idempotent. */
  stop: () => Promise<void>;
}

/** What is spawned: this process's own `node` running the built CLI entry,
 * which a test overrides to drive a spawn that does not happen. */
interface CliProgram {
  executable: string;
  entry: string;
}

const BUILT_CLI: CliProgram = { executable: process.execPath, entry: cliEntry };

/** One spawned `alcove` invocation and what it has written so far. */
interface SpawnedCli {
  child: ChildProcessByStdio<null, Readable, Readable>;
  stdout: () => string;
  /** stdout and stderr interleaved in arrival order. */
  output: () => string;
  killedOnDeadline: () => boolean;
  ended: Promise<{ exitCode: number | null; endedAt: number }>;
  /** Kill the run if it is still going. Idempotent. */
  stop: () => Promise<void>;
}

/** The timestamp of the first log line holding `fragment`, read from the head
 * of the CLI's own log format, or null when no line holds it. */
function loggedAt(output: string, fragment: string): number | null {
  const line = output.split("\n").find((one) => one.includes(fragment));
  const stamp = line?.match(/^\[([^\]]+)\]/)?.[1];
  const parsed = stamp === undefined ? Number.NaN : Date.parse(stamp);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The matched pairs in the result file of the CLI party's output folder, or
 * null when the folder does not exist or holds no result file.
 *
 * Read only from a run that exited 0 within its deadline: a killed or failing
 * run can leave a truncated file, and the parse error that file raises would be
 * the first thing the leg reported about the run, ahead of the kill or the exit
 * status that explains it. A file that will not parse after a clean exit is
 * raised with the run's own output beside it, which is what diagnoses it.
 */
function readPairs(
  outputFolder: string,
  output: string,
): Array<MatchedPair> | null {
  if (
    !existsSync(outputFolder) ||
    !readdirSync(outputFolder).some(
      (name) => name.startsWith("alcove-results-") && name.endsWith(".csv"),
    )
  )
    return null;
  try {
    return pairsFromResultCsv(resultFileIn(outputFolder));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `the CLI party exited 0, but no parsable result file in ` +
        `${outputFolder}: ${reason}\n${output}`,
    );
  }
}

function requireBuiltCli(program: CliProgram): void {
  if (!existsSync(program.entry))
    throw new Error(
      `${LEG_ENVIRONMENT_FAILURE} the CLI party is the built program at ` +
        `${program.entry}, which is absent. Run 'npm run build -w apps/cli'.`,
    );
}

/** Spawn `alcove <args>` in `cwd`, killed at `deadlineMs`, with `env` added
 * to this process's environment. */
function spawnCli(
  program: CliProgram,
  args: Array<string>,
  options: { cwd: string; deadlineMs: number; env?: NodeJS.ProcessEnv },
): SpawnedCli {
  const child = spawn(program.executable, [program.entry, ...args], {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...options.env },
  });
  const stopTracked = trackChild(child);

  let output = "";
  let stdout = "";
  let killedOnDeadline = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
  });
  // A failure raised on the child rather than by its exit -- a spawn that
  // never happened, a signal that could not be delivered. Unlistened, Node
  // throws it as an uncaught exception that takes the vitest worker with it.
  // Registered first and for the whole run, so its text is in the output
  // before any later listener reads it.
  child.on("error", (error: Error) => {
    output += `${error.message}\n`;
  });
  const deadline = setTimeout(() => {
    killedOnDeadline = true;
    child.kill("SIGKILL");
  }, options.deadlineMs);

  const ended = new Promise<{ exitCode: number | null; endedAt: number }>(
    (resolve) => {
      child.once("close", (exitCode) => {
        clearTimeout(deadline);
        resolve({ exitCode, endedAt: Date.now() });
      });
    },
  );

  return {
    child,
    stdout: () => stdout,
    output: () => output,
    killedOnDeadline: () => killedOnDeadline,
    ended,
    stop: async () => {
      clearTimeout(deadline);
      await stopTracked();
    },
  };
}

/** Wait for `run` to end and report what it did, its result file read from
 * `outputPath`. */
async function outcomeOf(
  run: SpawnedCli,
  outputPath: string,
): Promise<LiveLegCliOutcome> {
  const { exitCode, endedAt } = await run.ended;
  const output = run.output();
  const closingAt = loggedAt(output, CLOSING_CONNECTION_LINE);
  const killedOnDeadline = run.killedOnDeadline();
  const ranToCompletion = !killedOnDeadline && exitCode === 0;
  return {
    exitCode,
    killedOnDeadline,
    pairs: ranToCompletion ? readPairs(outputPath, output) : null,
    closeWaitMs: closingAt === null ? null : endedAt - closingAt,
    closingConnectionAt: closingAt,
    output,
  };
}

/**
 * Spawn `alcove invite` against `brokerUrl` and resolve once it has printed
 * its invitation.
 *
 * Rejects with a {@link LEG_ENVIRONMENT_FAILURE} message when the CLI is not
 * built, cannot be spawned, exits before printing, or prints nothing that looks
 * like an invitation -- none of which is an interop divergence.
 */
export async function startCliInviter(
  brokerUrl: string,
  program: CliProgram = BUILT_CLI,
): Promise<CliInviter> {
  requireBuiltCli(program);

  const work = mkdtempSync(path.join(tmpdir(), "alcove-live-webrtc-"));
  const inputPath = path.join(work, "input.csv");
  const outputPath = path.join(work, "results");
  writeFileSync(inputPath, CLI_PARTY_CSV);

  const run = spawnCli(
    program,
    [
      "invite",
      brokerUrl,
      inputPath,
      outputPath,
      "--config-file",
      path.join(work, "alcove.yaml"),
      "--key-file",
      path.join(work, "alcove.key"),
      "--identity",
      CLI_IDENTITY,
      "--accept-timeout",
      `${CLI_ACCEPT_TIMEOUT_MS / 1000}s`,
      "--no-record",
      // The close wait is read off this party's own timestamped log, so the
      // level has to be one that writes the line it is measured from.
      "--log-level",
      "info",
    ],
    { cwd: work, deadlineMs: CLI_DEADLINE_MS },
  );
  const { child } = run;

  const stop = async (): Promise<void> => {
    await run.stop();
    rmSync(work, { recursive: true, force: true });
  };

  const invitation = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      action();
    };
    const fail = (reason: string): void =>
      settle(() =>
        reject(
          new Error(`${LEG_ENVIRONMENT_FAILURE} ${reason}\n${run.output()}`),
        ),
      );
    const timer = setTimeout(
      () =>
        fail(
          `the CLI party printed no invitation within ` +
            `${INVITATION_TIMEOUT_MS}ms`,
        ),
      INVITATION_TIMEOUT_MS,
    );
    const onData = (): void => {
      const stdout = run.stdout();
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      const line = stdout.slice(0, newline).trim();
      // Matched by shape rather than by the sentence beside it: the invitation
      // is the whole of what this command writes to stdout.
      if (INVITATION_SHAPE.test(line)) settle(() => resolve(line));
      else fail("the CLI party's first stdout line is not an invitation");
    };
    child.stdout.on("data", onData);
    // Settling once makes a later failure a no-op for this wait.
    child.on("error", () => fail("the CLI party could not be spawned"));
    void run.ended.then(({ exitCode }) =>
      fail(`the CLI party exited with code ${exitCode} before inviting`),
    );
  }).catch(async (error: unknown) => {
    await stop();
    throw error;
  });

  return {
    invitation,
    outcome: () => outcomeOf(run, outputPath),
    stop,
  };
}

/** Run one short `alcove <args>` to its exit and resolve with its stdout,
 * rejecting with a {@link LEG_ENVIRONMENT_FAILURE} message unless it exits 0
 * within {@link INVITATION_TIMEOUT_MS}. */
async function runCliToExit(
  program: CliProgram,
  args: Array<string>,
  cwd: string,
): Promise<string> {
  const run = spawnCli(program, args, {
    cwd,
    deadlineMs: INVITATION_TIMEOUT_MS,
  });
  const what = `'alcove ${args[0]}'`;
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      run.child.once("error", () =>
        reject(
          new Error(
            `${LEG_ENVIRONMENT_FAILURE} ${what} could not be spawned\n` +
              run.output(),
          ),
        ),
      );
      void run.ended.then((ended) => resolve(ended.exitCode));
    });
    if (run.killedOnDeadline() || exitCode !== 0)
      throw new Error(
        `${LEG_ENVIRONMENT_FAILURE} ${what} ` +
          (run.killedOnDeadline()
            ? `was killed after ${INVITATION_TIMEOUT_MS}ms`
            : `exited with code ${exitCode}`) +
          `\n${run.output()}`,
      );
    return run.stdout();
  } finally {
    await run.stop();
  }
}

/** The relay case's connection block: a webrtc inviter at the broker, with
 * `relayUrl` as its own WebSocket relay. */
function relayCaseConnectionBlock(
  broker: { port: number; path: string },
  relayUrl: string,
): string {
  return [
    "connection:",
    "  channel: webrtc",
    "  role: inviter",
    "  server:",
    "    host: 127.0.0.1",
    `    port: ${broker.port}`,
    `    path: ${broker.path}`,
    "    secure: false",
    "  stun:",
    `    - ${UNREACHABLE_STUN}`,
    `  websocket_relay: ${relayUrl}`,
    "  options:",
    `    peer_timeout_ms: ${CLI_ACCEPT_TIMEOUT_MS}`,
    "",
  ].join("\n");
}

/**
 * Start the relay case's CLI party and resolve once it waits at the broker and
 * at `relay`: an `alcove exchange` over a webrtc configuration naming the
 * broker and the relay, with an invitation minted from that configuration, so
 * the invitation names both. The exchange's relay key is enrolled at `relay`
 * before the run starts, and the run trusts the relay's certificate.
 *
 * The configuration is written the way an operator writes it: a first
 * `alcove invite` writes it with a connection block to fill in, whose
 * invitation and key are discarded, and the second mints from it.
 *
 * Rejects with a {@link LEG_ENVIRONMENT_FAILURE} message when the CLI is not
 * built, an invite fails, or the run exits or sends no hello to the relay
 * within {@link RELAY_HELLO_TIMEOUT_MS}.
 */
export async function startCliRelayInviter(
  broker: { port: number; path: string },
  relay: LiveRelay,
  program: CliProgram = BUILT_CLI,
): Promise<CliInviter> {
  requireBuiltCli(program);

  const work = mkdtempSync(path.join(tmpdir(), "alcove-live-relay-cli-"));
  const inputPath = path.join(work, "input.csv");
  const outputPath = path.join(work, "results");
  const configPath = path.join(work, "alcove.yaml");
  const keyPath = path.join(work, "alcove.key");
  writeFileSync(inputPath, CLI_PARTY_CSV);

  let run: SpawnedCli | undefined;
  const stop = async (): Promise<void> => {
    await run?.stop();
    rmSync(work, { recursive: true, force: true });
  };

  try {
    await runCliToExit(
      program,
      [
        "invite",
        inputPath,
        "--config-file",
        configPath,
        "--key-file",
        path.join(work, "discarded.key"),
        "--identity",
        CLI_IDENTITY,
      ],
      work,
    );
    fillInConnection(configPath, relayCaseConnectionBlock(broker, relay.url));
    const invitation = (
      await runCliToExit(
        program,
        [
          "invite",
          inputPath,
          "--config-file",
          configPath,
          "--key-file",
          keyPath,
        ],
        work,
      )
    ).trim();
    if (!INVITATION_SHAPE.test(invitation))
      throw new Error(
        `${LEG_ENVIRONMENT_FAILURE} 'alcove invite' printed no invitation ` +
          `from ${configPath}`,
      );
    const { sharedSecret } = await decodeInvitation(invitation);
    relay.enroll(
      await deriveRelayExchangeId(sharedSecret),
      await deriveRelayKey(sharedSecret),
    );

    const started = spawnCli(
      program,
      [
        "exchange",
        inputPath,
        outputPath,
        "--config-file",
        configPath,
        "--key-file",
        keyPath,
        "--no-record",
        "--log-level",
        "info",
      ],
      {
        cwd: work,
        deadlineMs: CLI_DEADLINE_MS,
        env: { NODE_EXTRA_CA_CERTS: relay.certificatePath },
      },
    );
    run = started;
    await new Promise<void>((resolve, reject) => {
      const fail = (reason: string): void => {
        clearTimeout(timer);
        reject(
          new Error(
            `${LEG_ENVIRONMENT_FAILURE} ${reason}\n${started.output()}`,
          ),
        );
      };
      const timer = setTimeout(
        () =>
          fail(
            "the CLI party sent the WebSocket relay no hello within " +
              `${RELAY_HELLO_TIMEOUT_MS}ms`,
          ),
        RELAY_HELLO_TIMEOUT_MS,
      );
      void relay.firstHello.then(() => {
        clearTimeout(timer);
        resolve();
      });
      started.child.once("error", () =>
        fail("the CLI party could not be spawned"),
      );
      void started.ended.then(({ exitCode }) =>
        fail(
          `the CLI party exited with code ${exitCode} before reaching the ` +
            "WebSocket relay",
        ),
      );
    });

    return {
      invitation,
      outcome: () => outcomeOf(started, outputPath),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
