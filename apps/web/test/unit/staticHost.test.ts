import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  DEFAULT_CACHE_CONTROL,
  resolveStaticFile,
  startStaticHost,
} from "../staticHost/server";
import { headersForPath, parseHeadersFile } from "../staticHost/headersFile";
import { HASHED_ASSET_CACHE_CONTROL } from "../../hosted/headersFile";

import type { StaticHost } from "../staticHost/server";

let root = "";
let host: StaticHost | undefined;

function write(path: string, content: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "alcove-static-host-"));
});

afterEach(async () => {
  await host?.close();
  host = undefined;
  rmSync(root, { recursive: true, force: true });
});

async function get(path: string): Promise<{ body: string; headers: Headers }> {
  if (host === undefined) throw new Error("static host not started");
  const response = await fetch(`${host.origin}${path}`);
  expect(response.status, `status of ${path}`).toBe(200);
  return { body: await response.text(), headers: response.headers };
}

describe("the static host's file resolution", () => {
  beforeEach(async () => {
    write("index.html", "root");
    write("accept.html", "accept");
    write("saved.html", "saved");
    write("saved/_.html", "saved-item");
    write("assets/app-AAAA1111.js", "code");
    write(
      "_headers",
      `/*\n  X-Test: on\n/assets/*\n  Cache-Control: ${HASHED_ASSET_CACHE_CONTROL}\n`,
    );
    host = await startStaticHost(root);
  });

  test.each([
    ["/", "root"],
    ["/accept", "accept"],
    ["/saved", "saved"],
    ["/saved/_", "saved-item"],
    ["/assets/app-AAAA1111.js", "code"],
    ["/saved/an-id", "root"],
    ["/assets/missing-BBBB2222.js", "root"],
    ["/not-a-route/deeper", "root"],
    ["/_headers", "root"],
    ["//_headers", "root"],
    ["/./_headers", "root"],
  ])("answers %s with %s", async (path, expected) => {
    expect((await get(path)).body).toBe(expected);
  });

  test("never resolves a path outside the output", () => {
    for (const path of ["/../outside", "/%2e%2e%2foutside", "/%E0%A4%A"])
      expect(resolveStaticFile(root, path)).toBe(join(root, "index.html"));
  });

  test("states the served file's type, not the requested path's", async () => {
    const asset = await get("/assets/app-AAAA1111.js");
    expect(asset.headers.get("content-type")).toBe("application/javascript");
    const fallback = await get("/assets/missing-BBBB2222.js");
    expect(fallback.headers.get("content-type")).toMatch(/^text\/html/);
  });

  test("sends a missing asset the root document with the immutable cache", async () => {
    const { headers } = await get("/assets/missing-BBBB2222.js");
    expect(headers.get("content-type")).toMatch(/^text\/html/);
    expect(headers.get("cache-control")).toBe(HASHED_ASSET_CACHE_CONTROL);
  });

  test("applies _headers by request path over the default cache", async () => {
    const { headers } = await get("/saved/an-id");
    expect(headers.get("x-test")).toBe("on");
    expect(headers.get("cache-control")).toBe(DEFAULT_CACHE_CONTROL);
  });
});

describe("the static host's refusals", () => {
  test.each(["_redirects", "404.html"])(
    "refuses an output holding %s",
    async (name) => {
      write("index.html", "root");
      write(name, "");
      await expect(startStaticHost(root)).rejects.toThrow(name);
    },
  );

  test("refuses an output with no index.html", async () => {
    write("accept.html", "accept");
    await expect(startStaticHost(root)).rejects.toThrow(/no index\.html/);
  });
});

describe("parseHeadersFile", () => {
  test("reads rules, comments and blank lines", () => {
    const rules = parseHeadersFile(
      "# security\n/*\n  A: one\n\n/assets/*\n  B: two: three\n",
    );
    expect(rules).toEqual([
      { pattern: "/*", headers: [["A", "one"]] },
      { pattern: "/assets/*", headers: [["B", "two: three"]] },
    ]);
    expect(Object.fromEntries(headersForPath(rules, "/assets/x.js"))).toEqual({
      A: "one",
      B: "two: three",
    });
    expect(Object.fromEntries(headersForPath(rules, "/assetsx"))).toEqual({
      A: "one",
    });
  });

  test.each([
    ["a placeholder", "/saved/:id\n  A: one\n"],
    ["an absolute URL", "https://example.org/*\n  A: one\n"],
    ["a header removal", "/*\n  ! A\n"],
    ["a header before any pattern", "  A: one\n"],
    ["a pattern with no header", "/*\n"],
    ["a line with no name", "/*\n  : one\n"],
  ])("refuses %s", (_name, source) => {
    expect(() => parseHeadersFile(source)).toThrow();
  });

  test("refuses one header set by two matching rules", () => {
    const rules = parseHeadersFile("/*\n  A: one\n/assets/*\n  a: two\n");
    expect(() => headersForPath(rules, "/assets/x.js")).toThrow(/both set/);
    expect(Object.fromEntries(headersForPath(rules, "/"))).toEqual({
      A: "one",
    });
  });
});
