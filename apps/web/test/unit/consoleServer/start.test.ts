import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import util from "node:util";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { JobApiConfigError } from "@jobs/gate";

import {
  exitOnBootFailure,
  logUncaughtException,
  logUnhandledRejection,
  startConsoleServer,
} from "../../../server/console/start";
import { CLIENT_BUILD_COMMAND } from "../../../server/console/staticFiles";
import { jobRoutes } from "../../../server/console/routeTable";

import {
  enableJobApi,
  resetConsoleServerTests,
  scratchDir,
} from "./serverHarness";

import type { Server } from "node:http";

const PROCESS_EVENTS = [
  "SIGINT",
  "SIGTERM",
  "unhandledRejection",
  "uncaughtException",
] as const;
const started: Array<Server> = [];
let listenersBefore: Map<string, Array<unknown>>;

beforeEach(() => {
  listenersBefore = new Map(
    PROCESS_EVENTS.map((event) => [
      event,
      process.listeners(event) as Array<unknown>,
    ]),
  );
});

afterEach(async () => {
  for (const server of started.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const emitter: NodeJS.EventEmitter = process;
  for (const event of PROCESS_EVENTS)
    for (const listener of emitter.listeners(event))
      if (!(listenersBefore.get(event) ?? []).includes(listener))
        emitter.removeListener(event, listener as () => void);
  await resetConsoleServerTests();
});

test("starting two servers in one process installs one uncaught-error listener for each event", async () => {
  enableJobApi();
  vi.stubEnv("PORT", "0");
  vi.stubEnv("HOST", "127.0.0.1");
  vi.stubEnv(
    "JOB_SFTP_CREDENTIAL_DIR",
    path.join(scratchDir("console-start-scratch"), "credentials"),
  );
  for (let count = 0; count < 2; count++)
    started.push((await startConsoleServer({ routes: jobRoutes })).server);
  expect(
    process
      .listeners("unhandledRejection")
      .filter((listener) => listener === logUnhandledRejection),
  ).toHaveLength(1);
  expect(
    process
      .listeners("uncaughtException")
      .filter((listener) => listener === logUncaughtException),
  ).toHaveLength(1);
});

/** Run {@link exitOnBootFailure} on `error` with the exit and the console
 * stubbed, returning the exit status and everything printed. */
function bootFailureReport(error: unknown): { code: unknown; printed: string } {
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exited");
  });
  const printed = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(() => exitOnBootFailure(error)).toThrow("exited");
    return {
      code: exit.mock.calls[0]?.[0],
      printed: printed.mock.calls
        .map((args) => util.format(...args))
        .join("\n"),
    };
  } finally {
    exit.mockRestore();
    printed.mockRestore();
  }
}

test("a boot refusal prints its message as one line and exits 1", () => {
  const { code, printed } = bootFailureReport(
    new JobApiConfigError("set SOME_SETTING to fix it"),
  );
  expect(code).toBe(1);
  expect(printed).toBe("The console did not start: set SOME_SETTING to fix it");
});

test("an unexpected boot failure prints its stack and exits 1", () => {
  const error = new Error("listen EADDRINUSE");
  const { code, printed } = bootFailureReport(error);
  expect(code).toBe(1);
  expect(error.stack).toMatch(/\n\s+at /);
  expect(printed).toContain(error.stack);
});

/** Enable the job API with a scratch directory of its own, listening at
 * loopback on `port`. */
function bootEnv(port: number): void {
  enableJobApi();
  vi.stubEnv("PORT", String(port));
  vi.stubEnv("HOST", "127.0.0.1");
  vi.stubEnv(
    "JOB_SFTP_CREDENTIAL_DIR",
    path.join(scratchDir("console-start-scratch"), "credentials"),
  );
}

/** What {@link exitOnBootFailure} reports for the way `start` fails. */
async function startFailureReport(
  start: Promise<unknown>,
): Promise<{ code: unknown; printed: string }> {
  const error = await start.then(
    () => {
      throw new Error("the console started");
    },
    (reason: unknown) => reason,
  );
  return bootFailureReport(error);
}

test("a port in use prints one line naming the port and PORT, and exits 1", async () => {
  const holder = net.createServer();
  await new Promise<void>((resolve) =>
    holder.listen({ port: 0, host: "127.0.0.1" }, resolve),
  );
  try {
    const { port } = holder.address() as net.AddressInfo;
    bootEnv(port);
    const { code, printed } = await startFailureReport(
      startConsoleServer({ routes: jobRoutes }),
    );
    expect(code).toBe(1);
    expect(printed).toBe(
      `The console did not start: port ${port} at 127.0.0.1 is already in ` +
        "use; set PORT to a free port, or stop the program using it",
    );
  } finally {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
  }
});

test("a static root with no client prints one line naming the build command, and exits 1", async () => {
  bootEnv(0);
  const staticRoot = scratchDir("console-start-static");
  const { code, printed } = await startFailureReport(
    startConsoleServer({ routes: jobRoutes, staticRoot }),
  );
  expect(code).toBe(1);
  expect(printed).toBe(
    "The console did not start: the console client is not built (no file " +
      `at ${path.join(staticRoot, "index.html")}); from a source checkout run npm run ` +
      "build:console -w apps/web; a container image without it was built without the client",
  );
});

test("the client build command names a script of the web app", () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, "../../../package.json"),
      "utf8",
    ),
  ) as { scripts: Partial<Record<string, string>> };
  const [script, workspace] =
    /^npm run (\S+) -w (\S+)$/.exec(CLIENT_BUILD_COMMAND)?.slice(1) ?? [];
  expect(workspace).toBe("apps/web");
  expect(manifest.scripts[script]).toContain("vite build");
});
