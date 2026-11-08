// The shipped source the claim checks read, and how each JavaScript-family
// file in it is parsed: check-egress-claims.mjs scans every file here, and
// check-crypto-claims.mjs the JavaScript-family ones, so the two read the same
// set.

import { extname } from "node:path";
import ts from "typescript";

/** Shipped-source trees the egress claims are made about. */
export const SCANNED_ROOTS = [
  "apps/web/src",
  "apps/cli/src",
  "packages/core/src",
  "packages/cli-contract/src",
  "packages/peerjs-broker/src",
  "packages/websocket-relay/src",
  "packages/sftp-relay/src",
  "apps/web/public",
  "apps/web/server",
];

/** Shipped files that build or run the container, outside any scanned tree. */
export const SCANNED_FILES = [
  "Dockerfile",
  "docker-entrypoint.sh",
  "Dockerfile.fips",
  "docker-entrypoint-fips.sh",
  "packages/sftp-relay/Dockerfile",
  "support/fips-probe/engagement.mjs",
  "support/fips-probe/image-engagement.mjs",
];

// How the TypeScript parser is to read each JavaScript-family extension. The
// kind decides the language variant, and with it whether `<p>` opens a JSX
// element or a type assertion, so it is chosen per extension rather than
// guessed: .mts and .cts are TypeScript without JSX, .js is JavaScript with it.
const SCRIPT_KIND_BY_EXTENSION = new Map([
  [".cjs", ts.ScriptKind.JS],
  [".cts", ts.ScriptKind.TS],
  [".js", ts.ScriptKind.JS],
  [".jsx", ts.ScriptKind.JSX],
  [".mjs", ts.ScriptKind.JS],
  [".mts", ts.ScriptKind.TS],
  [".ts", ts.ScriptKind.TS],
  [".tsx", ts.ScriptKind.TSX],
]);

/** The script kind the TypeScript parser reads `path` as, or undefined for a file scanned raw. */
export function scriptKindOf(path) {
  return SCRIPT_KIND_BY_EXTENSION.get(extname(path).toLowerCase());
}

/** Whether `path` is read by the TypeScript parser rather than scanned raw. */
export function isJavaScriptFamily(path) {
  return scriptKindOf(path) !== undefined;
}
