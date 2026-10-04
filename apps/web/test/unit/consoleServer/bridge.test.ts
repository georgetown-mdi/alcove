import http from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import { JOB_RESPONSE_HEADERS } from "@jobs/gate";

import { defineJobRoute } from "../../../server/console/routeTable";

import {
  enableJobApi,
  resetConsoleServerTests,
  send,
  startServer,
  waitUntil,
} from "./serverHarness";

import type { JobRouteHandlers } from "../../../server/console/routeTable";

afterEach(resetConsoleServerTests);

const PROBE_PATH = "/api/jobs/slot";

/** Serve `handlers` at {@link PROBE_PATH} on an enabled job API. The job gate
 * is not in front of them, so they see the request as the bridge built it. */
function serveProbe(handlers: JobRouteHandlers): Promise<number> {
  enableJobApi();
  return startServer([defineJobRoute({ path: PROBE_PATH, handlers })]);
}

/** Open a GET to the probe path and resolve with the request once the
 * response's headers have arrived. */
function openStream(
  port: number,
): Promise<{ request: http.ClientRequest; response: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port,
        path: PROBE_PATH,
        agent: false,
        headers: { host: "localhost" },
      },
      (response) => resolve({ request, response }),
    );
    request.on("error", (error) => {
      if (!request.destroyed) reject(error);
    });
  });
}

describe("the node-to-web request bridge", () => {
  test("the handler sees the target's path and query, the client's headers, and a fixed origin", async () => {
    let seen: Request | undefined;
    const port = await serveProbe({
      GET: ({ request }) => {
        seen = request;
        return new Response(null, { status: 204 });
      },
    });
    await send(port, {
      path: `${PROBE_PATH}?x=1&y=%2F`,
      headers: { host: "localhost:8080", "x-probe": "kept" },
    });
    const url = new URL(seen!.url);
    expect(url.origin).toBe("http://127.0.0.1");
    expect(url.pathname).toBe(PROBE_PATH);
    expect(url.search).toBe("?x=1&y=%2F");
    expect(seen!.headers.get("host")).toBe("localhost:8080");
    expect(seen!.headers.get("x-probe")).toBe("kept");
  });

  test("a request body reaches the handler whole", async () => {
    const port = await serveProbe({
      POST: async ({ request }) => new Response(await request.text()),
    });
    const sent = "x".repeat(200_000);
    const answer = await send(port, {
      method: "POST",
      path: PROBE_PATH,
      body: sent,
    });
    expect(answer.body).toBe(sent);
  });

  test("a client that disconnects mid-response aborts the handler's signal", async () => {
    let signal: AbortSignal | undefined;
    const port = await serveProbe({
      GET: ({ request }) => {
        signal = request.signal;
        return new Response(new ReadableStream({ start() {} }));
      },
    });
    const { request } = await openStream(port);
    expect(signal?.aborted).toBe(false);
    request.destroy();
    await waitUntil(() => signal?.aborted === true);
  });

  test("a response that completes leaves the signal unaborted", async () => {
    let signal: AbortSignal | undefined;
    const port = await serveProbe({
      GET: ({ request }) => {
        signal = request.signal;
        return new Response("done");
      },
    });
    expect((await send(port, { path: PROBE_PATH })).body).toBe("done");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(signal?.aborted).toBe(false);
  });
});

describe("the web-to-node response bridge", () => {
  test("a client that disconnects while the handler runs has its idle response body cancelled", async () => {
    let cancelled = false;
    let requestArrived = false;
    const port = await serveProbe({
      GET: async ({ request }) => {
        requestArrived = true;
        await new Promise((resolve) =>
          request.signal.addEventListener("abort", resolve),
        );
        return new Response(
          new ReadableStream({
            start() {},
            cancel() {
              cancelled = true;
            },
          }),
        );
      },
    });
    const request = http.get({
      host: "127.0.0.1",
      port,
      path: PROBE_PATH,
      agent: false,
      headers: { host: "localhost" },
    });
    request.on("error", () => undefined);
    await waitUntil(() => requestArrived);
    request.destroy();
    await waitUntil(() => cancelled, 1000);
  });

  test("status and headers reach the client before the body's first chunk", async () => {
    const port = await serveProbe({
      GET: () =>
        new Response(new ReadableStream({ start() {} }), {
          status: 202,
          headers: { "x-probe": "sent", ...JOB_RESPONSE_HEADERS },
        }),
    });
    const { request, response } = await openStream(port);
    expect(response.statusCode).toBe(202);
    expect(response.headers["x-probe"]).toBe("sent");
    expect(response.headers["cache-control"]).toBe("no-store");
    request.destroy();
  });

  test("every Set-Cookie header is sent", async () => {
    const port = await serveProbe({
      GET: () => {
        const headers = new Headers();
        headers.append("set-cookie", "a=1");
        headers.append("set-cookie", "b=2");
        return new Response(null, { status: 204, headers });
      },
    });
    const answer = await send(port, { path: PROBE_PATH });
    expect(answer.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
  });

  test("a client that stops reading stops the body being read, and closing cancels it", async () => {
    const chunk = new Uint8Array(64 * 1024);
    let pulledBytes = 0;
    let cancelled = false;
    const port = await serveProbe({
      GET: () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                pulledBytes += chunk.byteLength;
                controller.enqueue(chunk);
              },
              cancel() {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    });
    const { request, response } = await openStream(port);
    response.pause();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const pulledWhilePaused = pulledBytes;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pulledBytes).toBe(pulledWhilePaused);
    expect(pulledBytes).toBeLessThan(64 * 1024 * 1024);
    expect(cancelled).toBe(false);
    request.destroy();
    await waitUntil(() => cancelled);
  });
});
