import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DEFAULT_CACHE_CONTROL, startStaticHost } from "../staticHost/server";

import { hasHostedBuild, hostedOutput } from "./prodServer.js";

import type { StaticHost } from "../staticHost/server";

// These assert at the HTTP boundary that the defense-in-depth response headers
// reach the wire: from the Start dev server on an SSR document route, which
// flows through the server-entry chokepoint (src/server.ts), and from the hosted
// static site's `_headers` behind the static-host harness, on documents and
// assets alike. Values are pinned here as the observable contract, not imported
// from the source that sets them, since the integration project resolves no
// `@utils` alias and a black-box check should not read the value it verifies.
// The dev server forwards /api/ to the signaling broker, so the /api refusal's
// headers are held against the built servers instead (apiNamespace.test.ts,
// REFUSAL).
//
// The port matches the dev-server globalSetup, which derives it the same way.
const port = parseInt(process.env.PORT ?? "3000", 10);
const base = `http://127.0.0.1:${port}`;

const expectedHeaders: Record<string, string> = {
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
};

async function expectSecurityHeaders(
  path: string,
  origin = base,
): Promise<Headers> {
  const response = await fetch(`${origin}${path}`);
  // Release the socket: only the headers matter here.
  await response.body?.cancel();
  for (const [name, value] of Object.entries(expectedHeaders)) {
    expect(response.headers.get(name), `${name} on ${path}`).toBe(value);
  }
  return response.headers;
}

describe("security response headers (app-wide, at the HTTP boundary)", () => {
  test("an SSR document route includes them", async () => {
    await expectSecurityHeaders("/");
  });
});

describe.skipIf(!hasHostedBuild)(
  "security response headers from the hosted static site's _headers",
  () => {
    let host: StaticHost | undefined;

    beforeAll(async () => {
      host = await startStaticHost(hostedOutput);
    });

    afterAll(async () => {
      await host?.close();
    });

    function origin(): string {
      if (host === undefined) throw new Error("static host not started");
      return host.origin;
    }

    // A route's own document, a parameterized route's, and paths only the
    // root-document fallback answers.
    test.each([
      "/",
      "/accept",
      "/saved/_",
      "/saved/an-id",
      "/not-a-route/deeper",
    ])("the document at %s includes them and revalidates", async (path) => {
      const headers = await expectSecurityHeaders(path, origin());
      expect(headers.get("content-type")).toMatch(/^text\/html/);
      expect(headers.get("cache-control")).toBe(DEFAULT_CACHE_CONTROL);
    });

    test("the service worker includes them and revalidates", async () => {
      const headers = await expectSecurityHeaders(
        "/serviceWorker.js",
        origin(),
      );
      expect(headers.get("cache-control")).toBe(DEFAULT_CACHE_CONTROL);
    });

    test("a hashed asset includes them and is cached as immutable", async () => {
      const asset = readdirSync(resolve(hostedOutput, "assets")).find((name) =>
        name.endsWith(".js"),
      );
      expect(asset).toBeDefined();
      const headers = await expectSecurityHeaders(`/assets/${asset}`, origin());
      expect(headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });
  },
);
