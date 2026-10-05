import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { MAX_SFTP_AUTHOR_BODY_BYTES } from "@jobs/routeSupport";
import { securityResponseHeaders } from "@utils/securityHeaders";

import {
  compileJobRoutes,
  jobRoutes,
  matchJobRoute,
} from "../../../server/console/routeTable";
import { defineJobRoute } from "../../../server/console/jobRoute";

import {
  enableJobApi,
  rawStatus,
  resetConsoleServerTests,
  send,
  sendRaw,
  startServer,
} from "./serverHarness";

import type { Answer } from "./serverHarness";

afterEach(resetConsoleServerTests);

const ROUTES_DIR = path.resolve(
  import.meta.dirname,
  "../../../server/console/routes",
);

/** Every route module under the job routes directory. */
function routeFiles(dir = ROUTES_DIR): Array<string> {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? routeFiles(path.join(dir, entry.name))
        : entry.name.endsWith(".ts")
          ? [path.join(dir, entry.name)]
          : [],
    );
}

/** The answer every request the server serves nothing for gets. */
function expectEmptyNotFound(answer: Answer): void {
  expect(answer.status).toBe(404);
  expect(answer.body).toBe("");
  expect(answer.headers["cache-control"]).toBe("no-store");
  expect(answer.headers["content-type"]).toBeUndefined();
  expectSecurityHeaders(answer);
}

function expectSecurityHeaders(answer: Answer): void {
  for (const [name, value] of Object.entries(securityResponseHeaders))
    expect(answer.headers[name.toLowerCase()]).toBe(value);
}

describe("the route table", () => {
  test("serves every job route module at the path its location names", async () => {
    const files = routeFiles();
    expect(files.length).toBe(jobRoutes.length);
    for (const file of files) {
      const segments = path
        .relative(ROUTES_DIR, file)
        .replace(/\.ts$/, "")
        .split(path.sep);
      if (segments.at(-1) === "index") segments.pop();
      const module = (await import(pathToFileURL(file).href)) as {
        route: unknown;
      };
      const entry = jobRoutes.find((route) => route === module.route);
      expect(entry, file).toBeDefined();
      expect(entry!.path).toBe(["/api/jobs", ...segments].join("/"));
    }
  });

  test("a static segment is matched before a parameter in its position", () => {
    const routes = compileJobRoutes([
      defineJobRoute({ path: "/api/jobs/$jobId", handlers: {} }),
      defineJobRoute({ path: "/api/jobs/slot", handlers: {} }),
    ]);
    expect(matchJobRoute(routes, "/api/jobs/slot")?.params).toEqual({});
    expect(matchJobRoute(routes, "/api/jobs/other")?.params).toEqual({
      jobId: "other",
    });
  });

  test("a parameter is decoded once, and one that does not decode matches nothing", () => {
    const routes = compileJobRoutes([
      defineJobRoute({ path: "/api/jobs/$jobId/log", handlers: {} }),
    ]);
    expect(matchJobRoute(routes, "/api/jobs/a%2525b/log")?.params).toEqual({
      jobId: "a%25b",
    });
    expect(matchJobRoute(routes, "/api/jobs/a%E0%A4%A/log")).toBeNull();
  });

  test("an empty segment matches nothing", () => {
    const routes = compileJobRoutes([
      defineJobRoute({ path: "/api/jobs/slot", handlers: {} }),
      defineJobRoute({ path: "/api/jobs/$jobId", handlers: {} }),
    ]);
    for (const pathname of [
      "/api/jobs/slot/",
      "/api//jobs/slot",
      "/api/jobs//",
      "api/jobs/slot",
    ])
      expect(matchJobRoute(routes, pathname), pathname).toBeNull();
  });

  test("a duplicate or malformed path is refused when the table is compiled", () => {
    expect(() =>
      compileJobRoutes([
        defineJobRoute({ path: "/api/jobs/$a", handlers: {} }),
        defineJobRoute({ path: "/api/jobs/$b", handlers: {} }),
      ]),
    ).toThrow(/Duplicate/);
    expect(() =>
      compileJobRoutes([defineJobRoute({ path: "/api/jobs/", handlers: {} })]),
    ).toThrow(/Malformed/);
  });

  test("a path outside the job API prefix is refused when the table is compiled", () => {
    expect(() =>
      compileJobRoutes([defineJobRoute({ path: "/other/slot", handlers: {} })]),
    ).toThrow(/outside \/api\/jobs/);
  });

  test("an unsupported method or non-function handler is refused when the table is compiled", () => {
    expect(() =>
      compileJobRoutes([
        defineJobRoute({
          path: "/api/jobs/slot",
          handlers: { PATCH: () => new Response() } as never,
        }),
      ]),
    ).toThrow(/invalid handler PATCH/);
    expect(() =>
      compileJobRoutes([
        defineJobRoute({
          path: "/api/jobs/slot",
          handlers: { GET: "nope" } as never,
        }),
      ]),
    ).toThrow(/invalid handler GET/);
  });
});

describe("the console server's answers", () => {
  test("a job route answers through its handler with the security headers", async () => {
    enableJobApi();
    const port = await startServer();
    const answer = await send(port, { path: "/api/jobs/slot" });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({ occupied: false });
    expect(answer.headers["cache-control"]).toBe("no-store");
    expectSecurityHeaders(answer);
  });

  test("a HEAD request is answered by the GET handler without a body", async () => {
    enableJobApi();
    const port = await startServer();
    const answer = await send(port, { method: "HEAD", path: "/api/jobs/slot" });
    expect(answer.status).toBe(200);
    expect(answer.body).toBe("");
    expect(answer.headers["content-type"]).toMatch(/^application\/json/);
  });

  test("every job route answers the empty 404 while the job API is disabled", async () => {
    const port = await startServer();
    expectEmptyNotFound(await send(port, { path: "/api/jobs/slot" }));
    expectEmptyNotFound(await send(port, { path: "/api/jobs" }));
  });

  test.each([
    ["GET", "/api/jobs/slot/"],
    ["GET", "/api//jobs/slot"],
    ["GET", "/api/jobs/nothing-here"],
    ["GET", "/api/nothing-here"],
    ["GET", "/api"],
    ["GET", "/api/peerjs/id"],
    ["GET", "/API/peerjs/id"],
    ["GET", "/nothing-here"],
    ["GET", "/"],
    ["GET", "//api/jobs/slot"],
    ["GET", "/api/jobs/not-a-uuid/log"],
    ["POST", "/api/jobs/slot"],
    ["PATCH", "/api/jobs/slot"],
    ["OPTIONS", "/api/jobs/slot"],
    ["DELETE", "/api/jobs/config"],
  ])("%s %s answers the empty 404", async (method, requestPath) => {
    enableJobApi();
    const port = await startServer();
    expectEmptyNotFound(await send(port, { method, path: requestPath }));
  });

  test.each([
    ["TRACE", "TRACE /api/jobs/slot HTTP/1.1"],
    ["an absolute-form target", "GET http://localhost/api/jobs/slot HTTP/1.1"],
    ["an asterisk-form target", "OPTIONS * HTTP/1.1"],
  ])("%s answers the empty 404", async (_label, requestLine) => {
    enableJobApi();
    const port = await startServer();
    const answer = await sendRaw(
      port,
      `${requestLine}\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
    );
    expect(rawStatus(answer)).toBe(404);
    expect(answer).toMatch(/\r\ncache-control: no-store\r\n/i);
    expect(answer).toMatch(/\r\ncontent-length: 0\r\n/i);
    expect(answer).not.toMatch(/\r\ncontent-type:/i);
  });

  test.each([
    ["TRACE", "TRACE /api/jobs/slot HTTP/1.1"],
    ["an absolute-form target", "PUT http://localhost/api/jobs/slot HTTP/1.1"],
    ["an asterisk-form target", "OPTIONS * HTTP/1.1"],
  ])(
    "%s with an unread body is discarded whole, so the next request on the connection is parsed from its own first byte",
    async (_label, requestLine) => {
      enableJobApi();
      const port = await startServer();
      const smuggled = "GET /nothing-here HTTP/1.1\r\nHost: localhost\r\n\r\n";
      const answer = await sendRaw(
        port,
        `${requestLine}\r\nHost: localhost\r\nContent-Length: ${smuggled.length}\r\n\r\n` +
          smuggled +
          "GET /api/jobs/slot HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      );
      const statuses = [...answer.matchAll(/^HTTP\/1\.1 (\d{3}) /gm)].map(
        (match) => Number(match[1]),
      );
      expect(statuses).toEqual([404, 200]);
    },
  );

  test("a WebSocket upgrade is answered as an ordinary request, never with 101", async () => {
    enableJobApi();
    const port = await startServer();
    for (const [target, status] of [
      ["/api/peerjs/peerjs", 404],
      ["/api/jobs/slot", 200],
    ] as const) {
      const answer = await sendRaw(
        port,
        `GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\n` +
          "Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
      expect(rawStatus(answer), target).toBe(status);
    }
  });

  test("a CONNECT request gets no answer and its connection is closed", async () => {
    enableJobApi();
    const port = await startServer();
    expect(
      await sendRaw(
        port,
        "CONNECT localhost:22 HTTP/1.1\r\nHost: localhost\r\n\r\n",
      ),
    ).toBe("");
  });

  test("the job gate refuses a foreign Host and a cross-origin caller", async () => {
    enableJobApi();
    const port = await startServer();
    const foreignHost = await send(port, {
      path: "/api/jobs/slot",
      headers: { host: "attacker.example" },
    });
    expect(foreignHost.status).toBe(403);
    expectSecurityHeaders(foreignHost);
    const crossOrigin = await send(port, {
      path: "/api/jobs/slot",
      headers: { origin: "http://attacker.example" },
    });
    expect(crossOrigin.status).toBe(403);
    const crossSite = await send(port, {
      path: "/api/jobs/slot",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    const sameOrigin = await send(port, {
      path: "/api/jobs/slot",
      headers: { origin: `http://localhost:${port}` },
    });
    expect(sameOrigin.status).toBe(200);
  });

  test("a body over a route's cap is refused with 413", async () => {
    enableJobApi();
    const port = await startServer();
    const answer = await send(port, {
      method: "PUT",
      path: "/api/jobs/sftp",
      headers: { "content-type": "application/json" },
      body: Buffer.alloc(MAX_SFTP_AUTHOR_BODY_BYTES + 1, 0x20),
    });
    expect(answer.status).toBe(413);
    expectSecurityHeaders(answer);
  });

  test("a handler that throws answers an empty no-store 500", async () => {
    enableJobApi();
    const port = await startServer([
      defineJobRoute({
        path: "/api/jobs/slot",
        handlers: {
          GET: () => {
            throw new Error("handler failure");
          },
        },
      }),
    ]);
    const answer = await send(port, { path: "/api/jobs/slot" });
    expect(answer.status).toBe(500);
    expect(answer.body).toBe("");
    expect(answer.headers["cache-control"]).toBe("no-store");
    expectSecurityHeaders(answer);
  });
});
