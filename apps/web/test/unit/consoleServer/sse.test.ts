import http from "node:http";

import { afterEach, describe, expect, test, vi } from "vitest";

import { JobManager } from "@jobs/jobManager";
import { SSE_KEEPALIVE_FRAME } from "@jobs/sse";

import { STUB_CLI_PATH, validIntent } from "../../utils/jobFixtures";

import {
  enableJobApi,
  resetConsoleServerTests,
  scratchDir,
  startServer,
  waitUntil,
} from "./serverHarness";

import type { JobRecord } from "@jobs/jobManager";

afterEach(async () => {
  vi.useRealTimers();
  await resetConsoleServerTests();
});

const RUN_EVENTS = [
  { v: 1, type: "stages", stages: [{ id: "one", label: "One" }] },
  { v: 1, type: "stage", id: "one" },
  { v: 1, type: "result", resultWritten: true },
];

/** Install a job manager on an enabled job API whose stub CLI emits `events`
 * and then exits, or stays up for `delayMs` first. */
async function startJob(
  events: ReadonlyArray<unknown>,
  delayMs?: number,
): Promise<{ id: string; record: JobRecord }> {
  const dataRoot = enableJobApi();
  const manager = new JobManager({
    dataRoot,
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: scratchDir("console-sse-rvz"),
    childEnv: {
      STUB_FD3_EVENTS: JSON.stringify(events),
      STUB_EXIT_CODE: "0",
      ...(delayMs === undefined ? {} : { STUB_DELAY_MS: String(delayMs) }),
    },
  });
  globalThis.jobManagerInstance = manager;
  const id = await manager.createJob(validIntent());
  return { id, record: manager.getJob(id)! };
}

/** Open the job's event stream; `onData` sees the body as it accumulates. */
function openEvents(
  port: number,
  id: string,
  headers: Record<string, string> = {},
): Promise<{
  request: http.ClientRequest;
  response: http.IncomingMessage;
  body: () => string;
  ended: Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port,
        path: `/api/jobs/${id}/events`,
        agent: false,
        headers: { host: "localhost", ...headers },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        const ended = new Promise<void>((resolveEnd) =>
          response.on("end", resolveEnd),
        );
        resolve({ request, response, body: () => body, ended });
      },
    );
    request.on("error", (error) => {
      if (!request.destroyed) reject(error);
    });
  });
}

/** The ids of the `id:` lines in an event-stream body. */
function frameIds(body: string): Array<number> {
  return [...body.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
}

describe("the job event stream through the console server", () => {
  test("replays the whole history and closes after the terminal event", async () => {
    const { id, record } = await startJob(RUN_EVENTS);
    await waitUntil(() => record.terminalEmitted, 30_000);
    const port = await startServer();
    const stream = await openEvents(port, id);
    expect(stream.response.statusCode).toBe(200);
    expect(stream.response.headers["content-type"]).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(stream.response.headers["cache-control"]).toBe("no-store");
    await stream.ended;
    expect(frameIds(stream.body())).toEqual(record.events.map((e) => e.id));
    expect(stream.body()).toMatch(/"type":"result"/);
  });

  test("Last-Event-ID resumes after the given event", async () => {
    const { id, record } = await startJob(RUN_EVENTS);
    await waitUntil(() => record.terminalEmitted, 30_000);
    const port = await startServer();
    const first = record.events[0].id;
    const stream = await openEvents(port, id, {
      "last-event-id": String(first),
    });
    await stream.ended;
    expect(frameIds(stream.body())).toEqual(
      record.events.filter((e) => e.id > first).map((e) => e.id),
    );
  });

  test("a waiting stream answers with its headers before any event and writes keepalives", async () => {
    const { id, record } = await startJob([], 30_000);
    const port = await startServer();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stream = await openEvents(port, id);
    expect(stream.response.statusCode).toBe(200);
    await waitUntil(() => record.listeners.size === 1);
    vi.advanceTimersByTime(15_000);
    await waitUntil(() => stream.body().includes(SSE_KEEPALIVE_FRAME));
    stream.request.destroy();
  });

  test("a client that closes the stream releases its job subscription", async () => {
    const { id, record } = await startJob([], 30_000);
    const port = await startServer();
    const stream = await openEvents(port, id);
    await waitUntil(() => record.listeners.size === 1);
    stream.request.destroy();
    await waitUntil(() => record.listeners.size === 0);
  });
});
