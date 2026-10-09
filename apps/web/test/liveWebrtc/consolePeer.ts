import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  CONSOLE_BUILD_COMMAND,
  getFreePort,
  hasConsoleBuild,
  sleep,
  spawnConsoleServer,
  stopProdServer,
  waitForRoot,
} from "../integration/prodServer.ts";
import { cliEntry, pairsFromResultText } from "../interop/cliParty.ts";

import { LEG_ENVIRONMENT_FAILURE } from "./legTypes.ts";

import type { ConsoleJobOutcome, ConsoleLegStart } from "./legTypes.ts";
import type { ChildProcess } from "node:child_process";

/**
 * The console party of the live WebRTC leg: the built console server, with the
 * job API on, running a webrtc job through its own CLI driver. The test reaches
 * it the way the console's browser does -- `PUT /api/jobs/webrtc`, then
 * `POST /api/jobs` -- and reads the run back through the job's status, events
 * and result routes, so what is exercised is the server's composition of the
 * run, not a configuration the harness wrote.
 */

/** The console party's budget for the whole job: the wait for the browser
 * peer, plus the exchange. Sized as the CLI leg's party budget is
 * (`CLI_ACCEPT_TIMEOUT_MS` in ./cliPeer.ts), to clear a cold Chromium start, the
 * browser's WASM engine load and an ICE round. */
const CONSOLE_JOB_DEADLINE_MS = 300_000;

/** How often the job's status is asked for while it runs. */
const STATUS_POLL_INTERVAL_MS = 500;

/** Longest one replay of a settled job's event stream may take; the console
 * closes it after the terminal event. */
const EVENTS_READ_TIMEOUT_MS = 10_000;

/** A console server standing with its coordination server authored. */
export interface ConsoleParty {
  /** The coordination server as the console reported it. */
  signaling: ConsoleLegStart["signaling"];
  /** Create the webrtc job from `intent`, resolving its id. */
  createJob: (intent: unknown) => Promise<string>;
  /** Wait for the job to leave `running` and report what it did. */
  outcome: () => Promise<ConsoleJobOutcome>;
  /** Stop the server and its CLI child, and remove the data root.
   * Idempotent. */
  stop: () => Promise<void>;
}

/** Fail with the leg's environment prefix, quoting what the console answered. */
async function environmentFailure(
  what: string,
  response: Response,
): Promise<Error> {
  const body = await response.text().catch(() => "");
  return new Error(
    `${LEG_ENVIRONMENT_FAILURE} ${what}: HTTP ${response.status} ${body}`,
  );
}

/**
 * Start the console server and author `brokerUrl` as the coordination server
 * its webrtc jobs dial.
 *
 * Rejects with a {@link LEG_ENVIRONMENT_FAILURE} message when the console or
 * the CLI is not built, the server does not come up, or the console refuses the
 * address -- none of which is an interop divergence.
 */
export async function startConsoleParty(
  brokerUrl: string,
): Promise<ConsoleParty> {
  if (!hasConsoleBuild)
    throw new Error(
      `${LEG_ENVIRONMENT_FAILURE} the console party is the built console ` +
        `server, which is absent. Run '${CONSOLE_BUILD_COMMAND}'.`,
    );
  if (!existsSync(cliEntry))
    throw new Error(
      `${LEG_ENVIRONMENT_FAILURE} the console runs the built program at ` +
        `${cliEntry}, which is absent. Run 'npm run build -w apps/cli'.`,
    );

  const dataRoot = mkdtempSync(path.join(tmpdir(), "alcove-live-console-"));
  const credentialDir = mkdtempSync(
    path.join(tmpdir(), "alcove-live-console-cred-"),
  );
  let child: ChildProcess | undefined;
  let jobId: string | undefined;

  const stop = async (): Promise<void> => {
    const running = child;
    child = undefined;
    await stopProdServer(running);
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(credentialDir, { recursive: true, force: true });
  };

  try {
    const port = await getFreePort();
    const origin = `http://127.0.0.1:${port}`;
    const spawned = await spawnConsoleServer(port, {
      JOB_DATA_ROOT: dataRoot,
      // The server runs as an ordinary user here, so the pasted-credential
      // directory moves off the root-owned default the image provisions.
      JOB_SFTP_CREDENTIAL_DIR: credentialDir,
      JOB_CLI_BINARY: cliEntry,
    });
    child = spawned.child;
    await waitForRoot(`${origin}/`, spawned.child, spawned.getLaunchError);

    const authored = await fetch(`${origin}/api/jobs/webrtc`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: brokerUrl }),
    });
    if (!authored.ok)
      throw await environmentFailure(
        "the console refused the coordination server",
        authored,
      );
    const projection = (await authored.json()) as ConsoleLegStart["signaling"];

    const createJob = async (intent: unknown): Promise<string> => {
      const created = await fetch(`${origin}/api/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(intent),
      });
      if (created.status !== 201)
        throw await environmentFailure(
          "the console refused the webrtc job",
          created,
        );
      jobId = ((await created.json()) as { id: string }).id;
      return jobId;
    };

    const outcome = async (): Promise<ConsoleJobOutcome> => {
      if (jobId === undefined)
        throw new Error("no console job is running; none was created");
      const jobUrl = `${origin}/api/jobs/${jobId}`;
      let status = "running";
      let exitCode: number | null = null;
      // The status turns before the child's exit is reconciled, so the wait
      // holds for both.
      let settled = false;
      const deadline = Date.now() + CONSOLE_JOB_DEADLINE_MS;
      while (!settled && Date.now() < deadline) {
        const response = await fetch(jobUrl);
        if (response.ok) {
          const body = (await response.json()) as {
            status: string;
            terminal: { exitCode: number | null } | null;
          };
          status = body.status;
          exitCode = body.terminal?.exitCode ?? null;
          settled = status !== "running" && body.terminal !== null;
        } else await response.body?.cancel();
        if (!settled) await sleep(STATUS_POLL_INTERVAL_MS);
      }

      const events =
        status === "running"
          ? ""
          : await fetch(`${jobUrl}/events`, {
              headers: { Accept: "text/event-stream" },
              signal: AbortSignal.timeout(EVENTS_READ_TIMEOUT_MS),
            })
              .then((response) => response.text())
              .catch((error: unknown) => `events unread: ${String(error)}`);

      let pairs: ConsoleJobOutcome["pairs"] = null;
      if (status === "succeeded") {
        const result = await fetch(`${jobUrl}/result`);
        if (result.ok) pairs = pairsFromResultText(await result.text());
        else await result.body?.cancel();
      }
      return { status, exitCode, pairs, events };
    };

    return { signaling: projection, createJob, outcome, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
