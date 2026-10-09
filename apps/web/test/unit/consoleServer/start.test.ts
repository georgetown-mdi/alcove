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
