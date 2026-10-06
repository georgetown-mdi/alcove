import { securityResponseHeaders } from "../src/utils/securityHeaders.ts";

import type { Plugin } from "vite";

/** The `Cache-Control` the host sends for `/assets/`, whose file names hold a
 * content hash, so a file at one URL never changes. */
export const HASHED_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** The rules of the static host's `_headers` file: the security headers on
 * every path, and a long-lived cache on the hashed assets. */
export const hostedHeaderRules: ReadonlyArray<{
  readonly pattern: string;
  readonly headers: Readonly<Record<string, string>>;
}> = [
  { pattern: "/*", headers: securityResponseHeaders },
  {
    pattern: "/assets/*",
    headers: { "Cache-Control": HASHED_ASSET_CACHE_CONTROL },
  },
];

/** {@link hostedHeaderRules} in the `_headers` format Cloudflare Pages reads: a
 * path pattern, then its headers indented one per line. */
export function hostedHeadersFileSource(): string {
  return hostedHeaderRules
    .map(({ pattern, headers }) =>
      [
        pattern,
        ...Object.entries(headers).map(
          ([name, value]) => `  ${name}: ${value}`,
        ),
      ].join("\n"),
    )
    .join("\n\n")
    .concat("\n");
}

/**
 * Writes `_headers` into the hosted build's output. It is emitted by the build,
 * not kept in `public/`, so no other server built from this app (the console)
 * serves it as a file.
 */
export function hostedHeadersFile(): Plugin {
  return {
    name: "alcove-hosted-headers-file",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "_headers",
        source: hostedHeadersFileSource(),
      });
    },
  };
}
