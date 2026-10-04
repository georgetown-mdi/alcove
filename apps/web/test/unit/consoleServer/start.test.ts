import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import {
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
  listenersBefore = new Map(
    PROCESS_EVENTS.map((event) => [
      event,
      process.listeners(event) as Array<unknown>,
    ]),
  );
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
