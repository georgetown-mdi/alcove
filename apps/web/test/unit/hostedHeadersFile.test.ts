import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { securityResponseHeaders } from "@utils/securityHeaders";

import {
  HASHED_ASSET_CACHE_CONTROL,
  hostedHeadersFileSource,
} from "../../hosted/headersFile";
import { headersForPath, parseHeadersFile } from "../staticHost/headersFile";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const builtHeadersFile = `${appRoot}dist/hosted/_headers`;

// The static host sends the security headers from `_headers` rather than from
// src/server.ts, so the file must state exactly what securityResponseHeaders
// does, as the service worker's offline response must.
describe("the hosted _headers file", () => {
  const rules = parseHeadersFile(hostedHeadersFileSource());

  test.each(["/", "/accept", "/saved/an-id", "/serviceWorker.js"])(
    "sets exactly the security headers on %s",
    (path) => {
      expect(Object.keys(securityResponseHeaders).length).toBe(4);
      expect(Object.fromEntries(headersForPath(rules, path))).toEqual(
        securityResponseHeaders,
      );
    },
  );

  test("adds an immutable cache to the hashed assets", () => {
    expect(
      Object.fromEntries(headersForPath(rules, "/assets/index-AAAA1111.js")),
    ).toEqual({
      ...securityResponseHeaders,
      "Cache-Control": HASHED_ASSET_CACHE_CONTROL,
    });
  });

  test("is not a public/ file, which the console would serve", () => {
    expect(existsSync(`${appRoot}public/_headers`)).toBe(false);
  });

  // Needs `npm run build:hosted -w apps/web` first.
  test.skipIf(!existsSync(builtHeadersFile))(
    "is what the hosted build wrote",
    () => {
      expect(readFileSync(builtHeadersFile, "utf8")).toBe(
        hostedHeadersFileSource(),
      );
    },
  );
});
