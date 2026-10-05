#!/usr/bin/env node
// Web route render check, run by `npm run check:all` and by
// eb_build_and_test.yaml against the production build it packages.
//
// A module that links in the browser can still fail to link under Node's own
// ESM loader during a server render, as a named import from a CommonJS
// package does. The page still answers 200 and the only trace is a line on
// the server's stderr, so a status check alone does not see it.
//
// So this starts the built server (`apps/web/.output/server/index.mjs`),
// requests every page route the checked-in route tree names, one at a time,
// and fails on a 5xx, a request that does not complete, or a render error on
// the server's stderr, attributed to the route whose request was in flight;
// any other stderr line is printed as a warning. A
// dynamic segment takes a fixed value. The `/api` routes are left out: they
// are request handlers rather than renders, and one of them streams.
//
// With `--build` it runs `npm run build -w apps/web` first, and writes the
// route tree's checked-in bytes back afterwards, since the build regenerates
// that file. Without it, it requests against the build already in
// apps/web/.output: `npm run check:all` runs it that way on the build the
// deploy-trigger check made, and CI runs it on the build it packages. The requests are bounded by RUN_TIMEOUT_MS, and
// teardown signals the server's process group.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { withRestoreOnSignal } from "./lib/regenerationChecks.mjs";

/** The checked-in route tree the page routes are read from. */
export const ROUTE_TREE = "apps/web/src/routeTree.gen.ts";

/** The Nitro entry the production build emits. */
export const SERVER_ENTRY = "apps/web/.output/server/index.mjs";

/** The value every dynamic route segment takes. */
export const DYNAMIC_SEGMENT_VALUE = "route-render-check";

const BUILD_ARGV = ["npm", "run", "build", "-w", "apps/web"];
const BUILD_TIMEOUT_MS = 600_000;
const RUN_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
// A render's stderr line arrives through the pipe after its response body.
const STDERR_SETTLE_MS = 150;

/**
 * The full paths the route tree's `FileRoutesByFullPath` interface names, in
 * file order. Throws when the interface is missing or empty, so a generator
 * change cannot leave the check requesting nothing.
 */
export function fullPathsOf(routeTreeSource) {
  const block = routeTreeSource.match(
    /export interface FileRoutesByFullPath \{([^}]*)\}/,
  );
  if (!block)
    throw new Error(
      `${ROUTE_TREE} has no FileRoutesByFullPath interface to read the routes from.`,
    );
  const paths = [...block[1].matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]);
  if (paths.length === 0)
    throw new Error(`${ROUTE_TREE} names no route in FileRoutesByFullPath.`);
  return paths;
}

/**
 * The URL path to request for one route: each `$name` segment, a bare `$`
 * splat, and an optional `{-$name}` segment take DYNAMIC_SEGMENT_VALUE, and a
 * trailing slash is dropped (the index route of `/x/` is requested as `/x`).
 * Throws on a path still holding `$` or `{` after that, rather than requesting
 * a URL no route answers.
 */
export function requestPathFor(fullPath) {
  const path = fullPath
    .replace(/\{-?\$[^}]*\}/g, DYNAMIC_SEGMENT_VALUE)
    .replace(/\$[A-Za-z0-9_]*/g, DYNAMIC_SEGMENT_VALUE);
  if (/[${}]/.test(path))
    throw new Error(
      `Route ${fullPath} has a segment form this check does not fill; teach requestPathFor the form.`,
    );
  return path.length > 1 ? path.replace(/\/$/, "") : path;
}

/** The deduplicated page routes to request, `/api` routes left out. */
export function pageRequestPaths(fullPaths) {
  const pages = fullPaths.filter(
    (path) => path !== "/api" && !path.startsWith("/api/"),
  );
  return [...new Set(pages.map(requestPathFor))];
}

/**
 * The stderr lines that signal a render error: the render-failure prefix the
 * server prints, or an `Error` line followed by a stack frame line.
 */
export function renderErrorOf(stderr) {
  const lines = stderr.split("\n");
  const errors = lines.filter(
    (line, i) =>
      line.includes("Error in renderToReadableStream") ||
      (/\bError\b/.test(line) && /^\s+at /.test(lines[i + 1] ?? "")),
  );
  return errors.length > 0 ? stderr.trimEnd() : null;
}

/**
 * A route's outcome as a failure line, or null when it passed: a 5xx, a
 * request error, or a render error on stderr while its request was in flight.
 * Other stderr output does not fail the route.
 */
export function failureOf({ path, status, error, stderr }) {
  if (error) return `${path}: the request failed: ${error}`;
  if (status >= 500) return `${path}: answered ${status}`;
  if (renderErrorOf(stderr))
    return `${path}: the server wrote a render error to stderr:\n${stderr.trimEnd()}`;
  return null;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function request(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // Reading the whole body waits out a streamed render, so a render error has
  // been logged by the time the next request starts.
  await response.arrayBuffer();
  return response.status;
}

async function waitForServer(origin, child) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `The built server exited before answering (code ${child.exitCode}, signal ${child.signalCode}).`,
      );
    try {
      await request(`${origin}/`);
      return;
    } catch {
      if (Date.now() >= deadline)
        throw new Error(
          `The built server did not answer ${origin}/ within ${READY_TIMEOUT_MS / 1000}s.`,
        );
      await sleep(250);
    }
  }
}

// The spawned server, so the run-timeout path can stop it too.
let liveServer;

function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

async function run(root) {
  const entry = resolve(root, SERVER_ENTRY);
  if (!existsSync(entry)) {
    console.error(
      `No production build at ${SERVER_ENTRY}. Build it with \`npm run build -w apps/web\`, then rerun this check.`,
    );
    return false;
  }
  const paths = pageRequestPaths(
    fullPathsOf(readFileSync(resolve(root, ROUTE_TREE), "utf8")),
  );

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [entry], {
    cwd: resolve(root, "apps/web"),
    env: { ...process.env, PORT: String(port), NITRO_HOST: "127.0.0.1" },
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  liveServer = child;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const failures = [];
  try {
    await waitForServer(origin, child);
    if (stderr.trim())
      failures.push(
        `the server wrote to stderr while starting:\n${stderr.trimEnd()}`,
      );
    for (const path of paths) {
      const stderrStart = stderr.length;
      const outcome = { path, status: 0, error: undefined, stderr: "" };
      try {
        outcome.status = await request(`${origin}${path}`);
      } catch (error) {
        outcome.error = error instanceof Error ? error.message : String(error);
      }
      await sleep(STDERR_SETTLE_MS);
      outcome.stderr = stderr.slice(stderrStart);
      const failure = failureOf(outcome);
      if (!failure && outcome.stderr.trim())
        console.warn(
          `warning: ${path} wrote to stderr:\n${outcome.stderr.trimEnd()}`,
        );
      console.log(
        `${failure ? "FAIL" : "ok  "}  ${outcome.status || "---"}  ${path}`,
      );
      if (failure) failures.push(failure);
    }
  } finally {
    stopServer(child);
  }

  if (failures.length > 0) {
    console.error(
      `\n${failures.length} route render failure(s) in the production build:\n\n${failures.join("\n\n")}`,
    );
    return false;
  }
  console.log(`\nAll ${paths.length} page routes rendered on the server.`);
  return true;
}

/**
 * Runs the production build, writing the route tree's original bytes back
 * whatever the outcome. Returns false, with the build's output printed, when
 * the build fails.
 */
function build(root) {
  const routeTree = resolve(root, ROUTE_TREE);
  const original = readFileSync(routeTree);
  return withRestoreOnSignal(
    () => writeFileSync(routeTree, original),
    () => {
      const [command, ...args] = BUILD_ARGV;
      const result = spawnSync(command, args, {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: BUILD_TIMEOUT_MS,
      });
      if (result.status === 0) return true;
      console.error(
        `\`${BUILD_ARGV.join(" ")}\` failed, so no route was rendered:\n\n${[result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n")}`,
      );
      return false;
    },
  );
}

// Only runs when invoked directly, so the test can import the pure functions.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (process.argv.includes("--build") && !build(root)) process.exit(1);
  const timer = setTimeout(() => {
    console.error(
      `The route render check did not finish within ${RUN_TIMEOUT_MS / 1000}s.`,
    );
    stopServer(liveServer);
    process.exit(1);
  }, RUN_TIMEOUT_MS);
  timer.unref();
  run(root).then(
    (ok) => process.exit(ok ? 0 : 1),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
