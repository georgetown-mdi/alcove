import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DYNAMIC_SEGMENT_VALUE,
  ROUTE_TREE,
  failureOf,
  fullPathsOf,
  pageRequestPaths,
  requestPathFor,
} from "./check-web-route-render.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("web route render check", () => {
  it("reads the page routes out of the real route tree, /api left out", () => {
    const paths = pageRequestPaths(
      fullPathsOf(readFileSync(resolve(root, ROUTE_TREE), "utf8")),
    );
    expect(paths).toContain("/");
    expect(paths).toContain("/exchange");
    expect(paths).toContain(`/saved/${DYNAMIC_SEGMENT_VALUE}`);
    expect(paths.some((path) => path.startsWith("/api"))).toBe(false);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("fails on a route tree with no full-path interface", () => {
    expect(() => fullPathsOf("export const routeTree = {}")).toThrow(
      /FileRoutesByFullPath/,
    );
  });

  it("fills every dynamic segment form and drops a trailing slash", () => {
    expect(requestPathFor("/saved/$id")).toBe(
      `/saved/${DYNAMIC_SEGMENT_VALUE}`,
    );
    expect(requestPathFor("/files/$")).toBe(`/files/${DYNAMIC_SEGMENT_VALUE}`);
    expect(requestPathFor("/a/{-$lang}/b")).toBe(
      `/a/${DYNAMIC_SEGMENT_VALUE}/b`,
    );
    expect(requestPathFor("/saved/")).toBe("/saved");
    expect(requestPathFor("/")).toBe("/");
  });

  it("refuses a segment form it does not fill", () => {
    expect(() => requestPathFor("/a/{name}")).toThrow(/segment form/);
  });

  it("fails a route on a 5xx, a request error, or stderr output", () => {
    const base = { path: "/x", status: 200, error: undefined, stderr: "" };
    expect(failureOf(base)).toBeNull();
    expect(failureOf({ ...base, status: 404 })).toBeNull();
    expect(failureOf({ ...base, status: 500 })).toMatch(/answered 500/);
    expect(failureOf({ ...base, status: 0, error: "timeout" })).toMatch(
      /request failed: timeout/,
    );
    expect(
      failureOf({ ...base, stderr: "Error in renderToReadableStream" }),
    ).toMatch(/stderr while rendering/);
  });
});
