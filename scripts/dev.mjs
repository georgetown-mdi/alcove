#!/usr/bin/env node
// Root dev loop: keep packages/core's dist in step with its sources for the
// duration of a web dev session, and run the signaling broker the hosted dev
// server forwards its /api/ to.
//
// The apps consume @alcove/core from its built dist/, never from its TypeScript
// sources, so an edit to core is invisible to a running dev server until someone
// remembers `npm run build -w packages/core`. Nothing reports that: the app goes
// on serving the previous build, and the only symptom is behavior that does not
// match the source in front of you. This brings dist up to date, then runs
// core's rollup watcher alongside the web dev server so every later edit
// rebuilds, and takes the whole loop down as soon as either side exits.
//
// Teardown holds for every signal in TEARDOWN_SIGNALS, whether it reaches the
// whole process group (a terminal Ctrl-C) or this process alone (`pkill -f
// scripts/dev.mjs`), and scripts/dev.test.mjs fails on a child that outlives the
// signal. SIGKILL runs no handler, so it orphans whatever was running. A signal
// during the initial build ends the loop there rather than starting the
// watchers, and the loop exits with the signal's conventional code.
//
// Bringing dist up to date BEFORE the dev server starts is the part that
// matters: rollup's watcher rebuilds asynchronously, so a dev server racing it
// would resolve whatever dist happened to be on disk at startup -- the stale
// build this exists to prevent.
//
// For an app script in SIGNALING_APP_SCRIPTS the loop also starts the
// standalone broker on a free loopback port, waits for its readiness endpoint,
// and only then starts the dev server, whose /api/ proxy forwards there. The
// broker is a watcher like the others: its exit ends the loop.
//
// Usage: node scripts/dev.mjs [web-script]   (default: dev)

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { constants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_MOUNT_PATH,
  READINESS_SEGMENT,
} from "@alcove/peerjs-broker/standaloneOptions";

import { DEV_SIGNALING_PORT_ENV } from "../apps/web/src/utils/devSignalingPort.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The workspace whose dev server this loop supervises. */
export const APP_WORKSPACE = "apps/web";

/** The workspace whose build output the app consumes. */
export const CORE_WORKSPACE = "packages/core";

/** The app script run when none is named. */
export const DEFAULT_APP_SCRIPT = "dev";

/** The workspace whose standalone signaling broker the hosted dev server
 * forwards to. */
export const BROKER_WORKSPACE = "packages/peerjs-broker";

/** The app scripts that serve the hosted app, whose page dials signaling at the
 * dev server's own /api/. The console serves no signaling. */
export const SIGNALING_APP_SCRIPTS = ["dev"];

/** Longest the loop waits for the broker's readiness endpoint to answer. */
export const SIGNALING_READY_TIMEOUT_MS = 30_000;

/**
 * The signals this loop forwards to its children. SIGHUP is here because the
 * children run in sessions of their own: a closed terminal reaches this process
 * and nothing under it.
 */
export const TEARDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

const ON_WINDOWS = process.platform === "win32";
const NPM = ON_WINDOWS ? "npm.cmd" : "npm";

// Node refuses to spawn a .cmd without a shell, so the Windows npm shim needs
// one. Every argument below is a literal except the app script name, which
// parseAppScript has already matched against the app's own declared scripts.
//
// `detached` puts each child in a process group of its own, which is what makes
// the teardown below reach the tool: npm runs a workspace script through a
// shell, and a signal delivered to npm alone kills npm and that shell while
// rollup and vite go on running, reparented to init.
const SPAWN_OPTIONS = {
  cwd: repoRoot,
  stdio: "inherit",
  shell: ON_WINDOWS,
  detached: !ON_WINDOWS,
};

/**
 * The app script named by `argv`, defaulting to DEFAULT_APP_SCRIPT. Validated
 * against `available` -- the app's own script names -- so a typo answers with the
 * scripts that exist instead of failing several layers down in npm.
 */
export function parseAppScript(argv, available) {
  if (argv.length > 1) {
    throw new Error(`expected at most one script name, got ${argv.length}`);
  }
  const script = argv[0] ?? DEFAULT_APP_SCRIPT;
  if (!available.includes(script)) {
    throw new Error(
      `${APP_WORKSPACE} has no '${script}' script; available: ${available.join(", ")}`,
    );
  }
  return script;
}

/** The script names declared by the app's package.json. */
export function appScriptNames(root = repoRoot) {
  const manifest = JSON.parse(
    readFileSync(resolve(root, APP_WORKSPACE, "package.json"), "utf8"),
  );
  return Object.keys(manifest.scripts ?? {});
}

// The inputs rollup reads for core's build, alongside its src tree.
const CORE_BUILD_FILES = ["package.json", "rollup.config.ts", "tsconfig.json"];

/** The newest mtime among `paths`, skipping any that do not exist. */
function newestMtime(paths) {
  let newest = -Infinity;
  for (const path of paths) {
    try {
      newest = Math.max(newest, statSync(path).mtimeMs);
    } catch {
      continue;
    }
  }
  return newest;
}

/** Every regular file under `dir`, or an empty array when it does not exist. */
function filesUnder(dir) {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath ?? dir, entry.name));
  } catch {
    return [];
  }
}

/**
 * Whether core's dist is at least as new as every source its build reads.
 *
 * Only an optimization, and a cheap one by design: a false verdict costs a
 * redundant build, and a true verdict that is wrong is corrected within seconds
 * by the watcher's first pass, which rebuilds unconditionally. What it buys is
 * that the common warm start does not pay a full core build before the dev
 * server comes up.
 */
export function coreBuildIsCurrent(root = repoRoot) {
  const core = resolve(root, CORE_WORKSPACE);
  const dist = filesUnder(join(core, "dist"));
  if (dist.length === 0) return false;

  const sources = [
    ...filesUnder(join(core, "src")),
    ...CORE_BUILD_FILES.map((name) => join(core, name)),
    resolve(root, "tsconfig.base.json"),
    resolve(root, "package-lock.json"),
  ];
  const oldestBuilt = dist.reduce(
    (oldest, path) => Math.min(oldest, statSync(path).mtimeMs),
    Infinity,
  );
  return oldestBuilt >= newestMtime(sources);
}

/** A port the operating system reports free on the loopback interface. */
export function freeLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

/**
 * Whether the broker on loopback `port` answers its readiness endpoint within
 * SIGNALING_READY_TIMEOUT_MS.
 */
export async function signalingBrokerAnswers(port) {
  const url = `http://127.0.0.1:${port}${DEFAULT_MOUNT_PATH}/${READINESS_SEGMENT}`;
  const deadline = Date.now() + SIGNALING_READY_TIMEOUT_MS;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      await response.body?.cancel();
      if (response.ok) return true;
    } catch {
      // Not listening yet.
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}

/**
 * Bring core's dist up to date, then run its watcher, the signaling broker when
 * the app script needs one, and the app's dev server until one of them exits,
 * and resolve to the loop's exit code.
 *
 * `runToCompletion` runs one npm invocation and resolves to its exit code;
 * `startWatcher` starts a long-running one, with extra environment variables,
 * and returns `{ kill, exited }`; `pickSignalingPort` resolves to the port the
 * broker binds; `waitForSignaling` resolves to whether the broker on that port
 * answered; `teardownSignal` reports the teardown signal that has arrived,
 * or null. They and the currency check are injected so the ordering and the
 * teardown this function owns are exercisable without spawning a dev server.
 */
export async function runDevLoop({
  appScript,
  isCoreBuildCurrent,
  runToCompletion,
  startWatcher,
  pickSignalingPort = freeLoopbackPort,
  waitForSignaling = signalingBrokerAnswers,
  teardownSignal = () => null,
}) {
  if (!isCoreBuildCurrent()) {
    const built = await runToCompletion(["run", "build", "-w", CORE_WORKSPACE]);
    if (built !== 0) return built;
  }

  // The signal that tore the build down reaches nothing started after it, so
  // the watchers are gated on the signal rather than on the build's outcome:
  // starting them here brings rollup and the dev server up for the session the
  // operator has already asked to end, on a build that never finished.
  const interrupted = teardownSignal();
  if (interrupted !== null) return signalExitCode(interrupted);

  const signalingPort = SIGNALING_APP_SCRIPTS.includes(appScript)
    ? String(await pickSignalingPort())
    : undefined;

  const watchers = [startWatcher(["run", "dev", "-w", CORE_WORKSPACE], {})];
  const stopAll = async () => {
    for (const watcher of watchers) watcher.kill("SIGTERM");
    await Promise.allSettled(watchers.map((watcher) => watcher.exited));
  };

  if (signalingPort !== undefined) {
    watchers.push(
      startWatcher(
        [
          "run",
          "start",
          "-w",
          BROKER_WORKSPACE,
          "--",
          "--port",
          signalingPort,
          "--host",
          "127.0.0.1",
        ],
        {},
      ),
    );
    const outcome = await Promise.race([
      waitForSignaling(signalingPort).then((ready) => ({ ready })),
      ...watchers.map((watcher) =>
        watcher.exited.then((code) => ({ exited: code })),
      ),
    ]);
    const interruptedWhileWaiting = teardownSignal();
    if ("exited" in outcome || interruptedWhileWaiting !== null) {
      await stopAll();
      return interruptedWhileWaiting !== null
        ? signalExitCode(interruptedWhileWaiting)
        : outcome.exited;
    }
    if (!outcome.ready) {
      await stopAll();
      process.stderr.write(
        `The signaling broker on port ${signalingPort} did not answer within ${SIGNALING_READY_TIMEOUT_MS / 1000}s, so the dev server was not started. Check the broker's output above.\n`,
      );
      return 1;
    }
  }

  watchers.push(
    startWatcher(
      ["run", appScript, "-w", APP_WORKSPACE],
      signalingPort === undefined
        ? {}
        : { [DEV_SIGNALING_PORT_ENV]: signalingPort },
    ),
  );

  const first = await Promise.race(watchers.map((watcher) => watcher.exited));
  await stopAll();
  return first;
}

/** The conventional exit code for a process `signal` terminated. */
function signalExitCode(signal) {
  return 128 + (constants.signals[signal] ?? 0);
}

// A child a signal killed reports no exit code, and reporting it as 0 tells
// every caller the work succeeded -- the build gate above included.
function exitCodeOf(child) {
  return new Promise((resolveCode) => {
    child.on("close", (code, signal) =>
      resolveCode(code ?? (signal ? signalExitCode(signal) : 1)),
    );
  });
}

/**
 * Starts one npm invocation, with `env` added to this process's environment,
 * and returns a handle that signals its whole process group, so the tool npm
 * launched through a shell goes down with it. Windows gets no process group of
 * its own, so there the signal reaches npm alone.
 *
 * @internal
 */
export function startProcess(args, env = {}) {
  const child = spawn(NPM, args, {
    ...SPAWN_OPTIONS,
    env: { ...process.env, ...env },
  });
  return {
    kill: (signal) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (!SPAWN_OPTIONS.detached) {
        child.kill(signal);
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    },
    exited: exitCodeOf(child),
  };
}

/**
 * The teardown state main() shares with the loop: the children to signal, the
 * first teardown signal to arrive, and the kill that goes out to each child.
 *
 * @internal
 */
export function createTeardown() {
  const live = new Set();
  let received = null;
  return {
    track(handle) {
      live.add(handle);
      void handle.exited.then(() => live.delete(handle));
      return handle;
    },
    signal: () => received,
    tearDown(signal) {
      received ??= signal;
      for (const handle of live) handle.kill(signal);
    },
  };
}

async function main() {
  let appScript;
  try {
    appScript = parseAppScript(process.argv.slice(2), appScriptNames());
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }

  const teardown = createTeardown();

  // Every child this loop starts is forwarded these signals, the core build
  // included: a signal addressed to this process alone otherwise leaves rollup
  // and the dev server holding the port and the file watches.
  for (const signal of TEARDOWN_SIGNALS) {
    process.on(signal, () => teardown.tearDown(signal));
  }

  const code = await runDevLoop({
    appScript,
    isCoreBuildCurrent: () => coreBuildIsCurrent(),
    runToCompletion: (args) => teardown.track(startProcess(args)).exited,
    startWatcher: (args, env) => teardown.track(startProcess(args, env)),
    teardownSignal: teardown.signal,
  });
  process.exit(code);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
