import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { DEV_SIGNALING_PORT_ENV } from "../../src/utils/devSignalingPort.ts";
import { startStandaloneBroker } from "../utils/standaloneBroker.ts";

import { waitForColdSignaling } from "./signalingProbe.ts";

import type { TestProject } from "vitest/node";

// Vitest globalSetup shared by the `integration` and `browser` projects: it
// starts the standalone signaling broker and the dev server, which forwards its
// /api/ to that broker, and stops both on teardown (docs/TESTING.md). The broker
// port is published via `provide()`. A server already listening on
// 127.0.0.1:PORT (`process.env.PORT ?? "3000"`; a PORT set only in `.env` is
// unsupported) is reused, left running, and not probed for signaling.

declare module "vitest" {
  interface ProvidedContext {
    signalingBrokerPort?: number;
  }
}

/** What marks a failure this setup reports as the test environment's. */
const SETUP_FAILURE = "dev-server setup failure:";

const here = dirname(fileURLToPath(import.meta.url));
// apps/web/test/devServer -> apps/web is two levels up.
const webRoot = resolve(here, "../..");

const READY_TIMEOUT_MS = 60_000;
// Per-probe abort: how long a single readiness request waits for an HTTP
// response when the server has accepted the TCP connection but is slow to
// answer (e.g. Vite still compiling). A refused connection rejects near-
// instantly, well before this fires.
const PROBE_TIMEOUT_MS = 1_000;
// Sleep between probes. With a refused connection returning immediately, this
// is roughly the effective poll cadence while the server is still coming up.
const PROBE_SLEEP_MS = 250;
// Short probe to detect an already-running server so we reuse rather than
// start a second one -- and leave it running on teardown.
const REUSE_PROBE_TIMEOUT_MS = 500;
// After SIGTERM, how long to wait for the process group to exit before
// escalating to SIGKILL, so teardown cannot hang on a stuck dev server.
const STOP_TIMEOUT_MS = 5_000;

function getPort(): number {
  return parseInt(process.env.PORT ?? "3000", 10);
}

// Returns true if the server responds to an HTTP request within timeoutMs,
// false on connection refusal or timeout. Any HTTP status code counts as ready.
async function httpAccepts(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (await httpAccepts(url, PROBE_TIMEOUT_MS)) return;
    if (Date.now() >= deadline)
      throw new Error(
        `Dev server did not become ready at ${url} within ` +
          `${READY_TIMEOUT_MS / 1000}s. Check that \`npm run dev\` starts ` +
          `cleanly from ${webRoot}.`,
      );
    await new Promise((r) => setTimeout(r, PROBE_SLEEP_MS));
  }
}

export default async function setup({
  provide,
}: TestProject): Promise<() => Promise<void>> {
  const port = getPort();
  const url = `http://127.0.0.1:${port}/`;

  const broker = await startStandaloneBroker(SETUP_FAILURE);
  console.log(`[dev-server] signaling broker on port ${broker.port}`);
  // Published before the reuse early-return so it is set on every path.
  provide("signalingBrokerPort", broker.port);

  // Reuse a server already listening on the port (manual `npm run dev`, or a
  // warm one from a prior run): skip launch and leave it running on teardown.
  if (await httpAccepts(url, REUSE_PROBE_TIMEOUT_MS)) {
    console.log(
      `[dev-server] reusing server already listening on port ${port}`,
    );
    return () => broker.stop();
  }

  // Strip VITEST so the dev server loads vite.config.ts as `npm run dev` does
  // rather than as the vitest run this setup is part of.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [DEV_SIGNALING_PORT_ENV]: String(broker.port),
  };
  delete env.VITEST;

  console.log(`[dev-server] starting dev server on port ${port}`);
  // detached: true groups npm and its children (sh -> vite) under one process
  // group so teardown can kill the whole tree with process.kill(-pid, SIGTERM).
  const child = spawn("npm", ["run", "dev"], {
    cwd: webRoot,
    env,
    detached: true,
    stdio: "ignore",
  });
  // unref so this process group does not prevent the vitest process from
  // exiting if teardown is never reached (e.g. an uncaught exception before
  // the return below).
  child.unref();

  let launchError: Error | undefined;
  child.once("error", (err) => {
    launchError = err;
  });

  // Sends SIGTERM to the whole process group, then waits for the child to exit
  // before resolving -- otherwise a back-to-back run's reuse probe could see
  // the still-dying server holding the port and treat it as a warm one, or the
  // fresh spawn could fail with EADDRINUSE. Escalates to SIGKILL if the group
  // does not exit within STOP_TIMEOUT_MS, so teardown cannot hang.
  const stopServer = (): Promise<void> => {
    if (child.pid === undefined || child.exitCode !== null)
      return Promise.resolve();
    const pid = child.pid;
    // Re-ref the child while we wait for it to exit: it was unref'd at spawn
    // so a never-reached teardown does not pin the process, but here we are
    // actively awaiting its exit. Without the ref, the event loop could drain
    // and the process exit 0 mid-await -- before the child is killed and the
    // setup error is re-thrown -- turning a failed setup into a silent pass.
    // The child's exit releases the ref.
    child.ref();
    return new Promise<void>((resolveStop) => {
      const timer = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // already gone
        }
      }, STOP_TIMEOUT_MS);
      timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolveStop();
      });
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // already gone -- the exit listener may never fire, so settle here.
        clearTimeout(timer);
        resolveStop();
      }
    });
  };

  try {
    // Yield one tick so the error handler can fire if npm is not found.
    await new Promise<void>((r) => setImmediate(r));
    if (launchError) throw launchError;
    await waitForServer(url);
    if (!(await waitForColdSignaling(port, { deadlineMs: READY_TIMEOUT_MS })))
      throw new Error(
        `${SETUP_FAILURE} a signaling dial at ${url}api/ did not open within ` +
          `${READY_TIMEOUT_MS / 1000}s, so the dev server is not forwarding ` +
          `/api/ to the broker on port ${broker.port}. Check the proxy in ` +
          `vite.config.ts.`,
      );
  } catch (err) {
    await stopServer();
    await broker.stop();
    throw err;
  }

  console.log(`[dev-server] ready on port ${port}`);

  return async () => {
    console.log("[dev-server] stopping dev server and signaling broker");
    await stopServer();
    await broker.stop();
  };
}
