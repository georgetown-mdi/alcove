import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";

import {
  DISPLAY_TRUNCATION_MARKER,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
} from "@alcove/core";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createFetchJobApiClient,
  createServerJobReattachDriver,
} from "@psi/jobClient/serverJobExchangeDriver";
import { JobManager } from "@jobs/jobManager";
import { appendSanitizedRunWarning } from "@psi/runWarnings";

import { Route as EventsRoute } from "../../../src/routes/api/jobs/$jobId/events";

import {
  STUB_CLI_PATH,
  tempDataRoot,
  validIntent,
} from "../../utils/jobFixtures";

import type * as ChildProcessModule from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { JobRecord } from "@jobs/jobManager";

// The notice the console raises when the CLI child could not be spawned or
// died abnormally names the child's own error message, which can hold a path
// the operator or a partner chose. It is composed raw and the seat escapes it
// once. Driven here from the child's `error` event, through the real manager,
// SSE route and browser-side client, to the string a seat renders.

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcessModule>();
  spawnMock.mockImplementation(original.spawn);
  return { ...original, spawn: spawnMock };
});

/** A value holding a backslash and a non-ASCII character. */
const VALUE = "a\\b caf\u00e9";

/** That value as one escape renders it: the backslash doubled once, the
 * non-ASCII character as one `\xHH` escape whose backslash is not doubled. */
const ESCAPED_ONCE = "a\\\\b caf\\xe9";

/** What a second escape would add. */
const ESCAPED_TWICE_TELLS = ["\\\\\\\\", "\\\\xe9"];

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

const roots: Array<string> = [];
const managers: Array<JobManager> = [];

afterEach(() => {
  spawnMock.mockClear();
  vi.unstubAllEnvs();
  for (const manager of managers.splice(0)) manager.shutdown();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function scratchDir(label: string): string {
  const dir = tempDataRoot(label);
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

/** A child whose spawn fails with `message`, as Node reports it on the child's
 * `error` event. */
function failingChild(message: string): ChildProcess {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const fd3 = new PassThrough();
  Object.assign(child, {
    stdout,
    stderr,
    stdio: [null, stdout, stderr, fd3],
    exitCode: null,
    signalCode: null,
    kill: () => false,
  });
  setImmediate(() => child.emit("error", new Error(message)));
  return child as unknown as ChildProcess;
}

/** The job whose child fails to spawn with `message`, run to its terminal. */
async function runFailingJob(
  message: string,
): Promise<{ record: JobRecord; id: string }> {
  vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
  const dataRoot = scratchDir("process-error-root");
  vi.stubEnv("JOB_DATA_ROOT", dataRoot);
  const manager = new JobManager({
    dataRoot,
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: scratchDir("process-error-rvz"),
    childEnv: {},
  });
  managers.push(manager);
  (globalThis as { jobManagerInstance?: JobManager }).jobManagerInstance =
    manager;
  spawnMock.mockImplementationOnce(() => failingChild(message));
  const id = await manager.createJob(validIntent());
  const record = manager.getJob(id)!;
  const deadline = Date.now() + 5000;
  while (!record.terminalEmitted) {
    if (Date.now() > deadline)
      throw new Error("timed out waiting for terminal");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { record, id };
}

/** The job's whole SSE body, read off the real route. */
async function sseBody(id: string): Promise<string> {
  const handlers = EventsRoute.options.server?.handlers as Record<
    string,
    (ctx: { request: Request; params: Record<string, string> }) => unknown
  >;
  const response = (await handlers.GET({
    request: new Request(`http://localhost/api/jobs/${id}/events`, {
      headers: { host: "localhost" },
    }),
    params: { jobId: id },
  })) as Response;
  expect(response.status).toBe(200);
  return response.text();
}

/** The process-error notices the real browser-side client delivers to a seat
 * for an SSE body, folded through the seat's warning sink. */
async function seatNotices(id: string, body: string): Promise<Array<string>> {
  const fetchImpl: typeof fetch = (input) =>
    Promise.resolve(
      String(input).endsWith("/events")
        ? new Response(body, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          })
        : new Response(null, { status: 404 }),
    );
  let shown: Array<string> = [];
  await createServerJobReattachDriver(
    id,
    createFetchJobApiClient(fetchImpl),
  ).run({
    signal: new AbortController().signal,
    onStages: () => undefined,
    onStage: () => undefined,
    onResult: () => undefined,
    onError: () => undefined,
    onWarning: (message) => {
      shown = appendSanitizedRunWarning(shown, message);
    },
  });
  return shown.filter((warning) => warning.includes("CLI process error"));
}

/** The text of the one process-error notice a record buffered. */
function bufferedNotice(record: JobRecord): string {
  const notices = record.events
    .map((entry) => entry.event)
    .filter(
      (event) =>
        event.type === "warning" && event.source === "relayProcessError",
    );
  expect(notices).toHaveLength(1);
  return notices[0].message as string;
}

describe("the CLI process-error notice renders in a console seat escaped once", () => {
  test("a message with a backslash and a non-ASCII character, from the child's error event to the rendered string", async () => {
    const { record, id } = await runFailingJob(`spawn ${VALUE} ENOENT`);
    // The job stream holds the text unescaped, for the seat's one pass.
    expect(bufferedNotice(record)).toBe(
      `CLI process error: spawn ${VALUE} ENOENT`,
    );

    const shown = await seatNotices(id, await sseBody(id));
    expect(shown).toEqual([`CLI process error: spawn ${ESCAPED_ONCE} ENOENT`]);
    for (const tell of ESCAPED_TWICE_TELLS)
      expect(shown[0]).not.toContain(tell);
    expect(shown[0]).toMatch(PRINTABLE_ASCII);
  });

  test("a flooding message stays within the warning budget", async () => {
    const { record, id } = await runFailingJob(
      `spawn ${VALUE} ${"\u202e".repeat(200_000)}`,
    );
    expect(bufferedNotice(record).length).toBeLessThan(
      WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
    );

    const shown = await seatNotices(id, await sseBody(id));
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain(`spawn ${ESCAPED_ONCE} `);
    expect(shown[0]).toContain(DISPLAY_TRUNCATION_MARKER);
    expect(shown[0].length).toBeLessThanOrEqual(
      WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
    );
    expect(shown[0]).toMatch(PRINTABLE_ASCII);
  });
});
