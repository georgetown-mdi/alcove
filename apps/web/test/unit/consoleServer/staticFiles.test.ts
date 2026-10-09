import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { JobApiConfigError } from "@jobs/gate";
import { securityResponseHeaders } from "@utils/securityHeaders";

import { createStaticFileHandler } from "../../../server/console/staticFiles";

import {
  enableJobApi,
  resetConsoleServerTests,
  scratchDir,
  send,
  startServer,
} from "./serverHarness";

import type { Answer } from "./serverHarness";

const INDEX = "<!doctype html><title>console</title>";
const ASSET = "export const asset = 1;";
const OUTSIDE = "outside the client";

let root: string;
let outsideFile: string;
let port: number;

afterEach(resetConsoleServerTests);

/** A built client under a fresh directory, with a file beside it that no
 * request may reach. */
function writeClient(): void {
  const parent = scratchDir("console-static");
  root = path.join(parent, "client");
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.mkdirSync(path.join(root, ".hidden"));
  fs.writeFileSync(path.join(root, "index.html"), INDEX);
  fs.writeFileSync(path.join(root, "assets", "index-abc123.js"), ASSET);
  fs.writeFileSync(path.join(root, "favicon.ico"), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(root, "a b.txt"), "spaced");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
  fs.writeFileSync(path.join(root, ".hidden", "x.js"), "hidden");
  outsideFile = path.join(parent, "outside.txt");
  fs.writeFileSync(outsideFile, OUTSIDE);
  fs.symlinkSync(outsideFile, path.join(root, "linked.txt"));
  fs.symlinkSync(path.join(root, ".env"), path.join(root, "env.txt"));
}

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

function expectIndex(answer: Answer): void {
  expect(answer.status).toBe(200);
  expect(answer.body).toBe(INDEX);
  expect(answer.headers["content-type"]).toBe("text/html; charset=utf-8");
  expect(answer.headers["cache-control"]).toBe("no-cache");
  expectSecurityHeaders(answer);
}

describe("the static file handler", () => {
  beforeEach(async () => {
    writeClient();
    enableJobApi();
    port = await startServer(undefined, root);
  });

  test("serves the index document at the root, with its length", async () => {
    const answer = await send(port, { path: "/" });
    expectIndex(answer);
    expect(answer.headers["content-length"]).toBe(String(INDEX.length));
  });

  test("serves a content-hashed asset as cacheable, with the security headers", async () => {
    const answer = await send(port, { path: "/assets/index-abc123.js" });
    expect(answer.status).toBe(200);
    expect(answer.body).toBe(ASSET);
    expect(answer.headers["content-type"]).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(answer.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expectSecurityHeaders(answer);
  });

  test("serves an unhashed file as revalidated, and decodes its name once", async () => {
    const icon = await send(port, { path: "/favicon.ico" });
    expect(icon.status).toBe(200);
    expect(icon.headers["content-type"]).toBe("image/x-icon");
    expect(icon.headers["cache-control"]).toBe("no-cache");
    const spaced = await send(port, { path: "/a%20b.txt" });
    expect(spaced.status).toBe(200);
    expect(spaced.body).toBe("spaced");
    expectEmptyNotFound(await send(port, { path: "/a%2520b.txt" }));
  });

  test("answers a client route with the index document", async () => {
    expectIndex(await send(port, { path: "/exchange" }));
    expectIndex(await send(port, { path: "/saved/abc?x=1" }));
  });

  test("never answers a path under /api with the index document, in any spelling", async () => {
    for (const target of [
      "/api",
      "/api/nope",
      "/api/jobs/nope",
      "/API/jobs",
      "/Api",
      "/%61pi/jobs",
      "/%2561pi/jobs",
      "/x/../api/nope",
      "/api/peerjs/id",
    ])
      expectEmptyNotFound(await send(port, { path: target }));
  });

  test("still answers a job route ahead of the client", async () => {
    const answer = await send(port, { path: "/api/jobs/slot" });
    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toMatch(/^application\/json/);
  });

  test("refuses dotfiles and a symlink to one", async () => {
    for (const target of [
      "/.env",
      "/%2eenv",
      "/.hidden/x.js",
      "/.hidden/missing",
      "/env.txt",
    ])
      expectEmptyNotFound(await send(port, { path: target }));
  });

  test("refuses a NUL, an encoded separator, and a sequence that does not decode", async () => {
    for (const target of [
      "/index.html%00",
      "/a%00b",
      "/assets%2findex-abc123.js",
      "/assets%5cindex-abc123.js",
      "/%E0%A4%A",
    ])
      expectEmptyNotFound(await send(port, { path: target }));
  });

  test("never reaches a file outside the root, lexically or through a symlink", async () => {
    const name = path.basename(outsideFile);
    for (const target of [
      `/../${name}`,
      `/%2e%2e/${name}`,
      `/assets/..%2f..%2f${name}`,
      `/assets/%2e%2e/%2e%2e/${name}`,
      `/..%5c${name}`,
    ]) {
      const answer = await send(port, { path: target });
      expect(answer.body, target).not.toContain(OUTSIDE);
    }
    expectEmptyNotFound(await send(port, { path: "/linked.txt" }));
  });

  test("answers a missing file, a trailing slash, and an encoded client route with the empty 404", async () => {
    for (const target of [
      "/assets/missing.js",
      "/missing.png",
      "/assets/",
      "/exchange/",
      "//exchange",
      "/ex%61mple",
    ])
      expectEmptyNotFound(await send(port, { path: target }));
  });

  test("answers HEAD with the headers and no body", async () => {
    const index = await send(port, { method: "HEAD", path: "/" });
    expect(index.status).toBe(200);
    expect(index.body).toBe("");
    expect(index.headers["content-length"]).toBe(String(INDEX.length));
    expectSecurityHeaders(index);
    const asset = await send(port, {
      method: "HEAD",
      path: "/assets/index-abc123.js",
    });
    expect(asset.headers["content-length"]).toBe(String(ASSET.length));
    expect(asset.body).toBe("");
  });

  test("answers every other method with the empty 404", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      expectEmptyNotFound(await send(port, { method, path: "/" }));
      expectEmptyNotFound(
        await send(port, { method, path: "/assets/index-abc123.js" }),
      );
    }
  });

  test("refuses a foreign Host with the job routes' empty 403, and admits an allowed one", async () => {
    for (const target of [
      "/",
      "/assets/index-abc123.js",
      "/some/client/route",
    ]) {
      const answer = await send(port, {
        path: target,
        headers: { host: "attacker.example" },
      });
      expect(answer.status, target).toBe(403);
      expect(answer.body, target).toBe("");
      expect(answer.headers["cache-control"], target).toBe("no-store");
      expectSecurityHeaders(answer);
    }
    expectIndex(await send(port, { path: "/", headers: { host: "[::1]" } }));
    vi.stubEnv("JOB_ALLOWED_HOSTS", "console.lan");
    expectIndex(
      await send(port, { path: "/", headers: { host: "console.lan:8080" } }),
    );
  });

  test("refuses a foreign Host whether or not the job API is enabled", async () => {
    vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "");
    const answer = await send(port, {
      path: "/",
      headers: { host: "attacker.example" },
    });
    expect(answer.status).toBe(403);
  });
});

describe("creating the static file handler", () => {
  test("refuses a root that is missing or has no index document file", () => {
    const empty = scratchDir("console-static-empty");
    const directoryIndex = scratchDir("console-static-dir-index");
    fs.mkdirSync(path.join(directoryIndex, "index.html"));
    for (const clientRoot of [
      empty,
      path.join(empty, "missing"),
      directoryIndex,
    ]) {
      const create = (): unknown => createStaticFileHandler(clientRoot);
      expect(create).toThrow(JobApiConfigError);
      expect(create).toThrow(
        `the console client is not built (no file at ${path.join(clientRoot, "index.html")}); ` +
          "run npm run build:console -w apps/web from the repository root to build it",
      );
    }
  });
});

describe("the console server without a static root", () => {
  test("answers a client path with the empty 404", async () => {
    enableJobApi();
    const bare = await startServer();
    expectEmptyNotFound(await send(bare, { path: "/" }));
    expectEmptyNotFound(await send(bare, { path: "/exchange" }));
  });
});
