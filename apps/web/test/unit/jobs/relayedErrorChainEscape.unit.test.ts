import { afterAll, afterEach, describe, expect, test, vi } from "vitest";

import { sanitizeErrorForDisplay } from "@alcove/core";

import {
  RelayedTerminalError,
  createFetchJobApiClient,
  createServerJobReattachDriver,
} from "@psi/jobClient/serverJobExchangeDriver";
import { JobManager } from "@jobs/jobManager";
import { sanitizedFailureMessage } from "@exchange/useInviterExchange";

import { route as EventsRoute } from "../../../server/console/routes/$jobId/events";

import {
  STUB_CLI_PATH,
  awaitTerminalEmitted,
  trackScratchDirs,
  validIntent,
} from "../../utils/jobFixtures";

// The terminal error's cause chain, driven from the `error` line a child
// writes on fd 3, through the real manager, SSE route and browser-side
// client, to the string a console seat renders. It takes three escape
// passes, a stated limit (docs/spec/DISPLAY_ESCAPE.md): this pins the count,
// so a change to it is seen.

/** A value holding a backslash, as an error's cause names it. */
const VALUE = "C:\\data\\in.csv";

/** `VALUE` after `passes` escapes: each one doubles every backslash. */
function escaped(passes: number): string {
  return VALUE.replaceAll("\\", "\\".repeat(2 ** passes));
}

const { scratchDir, cleanup: removeScratchDirs } = trackScratchDirs();
const managers: Array<JobManager> = [];

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
  removeScratchDirs();
  (globalThis as { jobManagerInstance?: unknown }).jobManagerInstance =
    undefined;
});

/** The fd-3 `error` line the CLI writes for `error`: its message is the
 * rendering stderr receives (`buildErrorEvent`, apps/cli/src/eventStream.ts). */
function cliErrorLine(error: Error): string {
  return `${JSON.stringify({
    v: 1,
    type: "error",
    category: "exchange",
    message: sanitizeErrorForDisplay(error),
    exitCode: 1,
  })}\n`;
}

async function runFailingJob(fd3: string): Promise<string> {
  vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
  const dataRoot = scratchDir("error-chain-root");
  vi.stubEnv("JOB_DATA_ROOT", dataRoot);
  const manager = new JobManager({
    dataRoot,
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: scratchDir("error-chain-rvz"),
    childEnv: { STUB_EXIT_CODE: "1", STUB_FD3_RAW: fd3 },
  });
  managers.push(manager);
  (globalThis as { jobManagerInstance?: JobManager }).jobManagerInstance =
    manager;
  const id = await manager.createJob(validIntent());
  await awaitTerminalEmitted(manager.getJob(id)!);
  return id;
}

async function sseBody(id: string): Promise<string> {
  const handlers = EventsRoute.handlers as Record<
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

/** The failure text a seat renders for the job's terminal error, by the
 * seat's own step (`sanitizedFailureMessage`). */
async function seatFailure(id: string, body: string): Promise<string> {
  const fetchImpl: typeof fetch = (input) =>
    Promise.resolve(
      String(input).endsWith("/events")
        ? new Response(body, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          })
        : new Response(null, { status: 404 }),
    );
  let failure: unknown;
  await createServerJobReattachDriver(
    id,
    createFetchJobApiClient(fetchImpl),
  ).run({
    signal: new AbortController().signal,
    onStages: () => undefined,
    onStage: () => undefined,
    onResult: () => undefined,
    onError: ({ error }) => {
      failure = error;
    },
    onWarning: () => undefined,
  });
  expect(failure).toBeInstanceOf(RelayedTerminalError);
  return sanitizedFailureMessage(failure);
}

describe("a relayed terminal error's cause chain in a console seat", () => {
  test("a backslash in a cause link is escaped by the CLI, the relay and the seat", async () => {
    const error = new Error("the exchange stopped", {
      cause: new Error(`cannot read ${VALUE}`),
    });
    const id = await runFailingJob(cliErrorLine(error));
    const shown = await seatFailure(id, await sseBody(id));
    expect(shown).toContain("the exchange stopped");
    expect(shown).toContain(`cannot read ${escaped(3)}`);
  });
});
