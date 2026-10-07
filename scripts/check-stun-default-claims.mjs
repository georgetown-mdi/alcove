#!/usr/bin/env node
// Built-in STUN default claim check: `npm run check:stun-default-claims`, run
// by static_checks.yaml on every pull request. SOURCE is the one place the
// default endpoint is decided, and the CLI's WebRTC integration suite measures
// it against the library. This check fails unless every hand-written copy
// agrees with SOURCE: each CODE_COPIES constant, and each claim in a
// CLAIM_TEXTS file, read from the word "built-in" to the end of its sentence.
// It also fails when SOURCE or a copy is not found, and when a `stated` file
// holds no claim writing the endpoint. Exit 0 clean, 1 on a finding.
// Rationale and limits: docs/notes/repo-check-scripts.md.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { lineOf } from "./lib/text.mjs";

/** The constant every copy below is held to, and the file that declares it. */
const SOURCE = {
  file: "apps/cli/src/connection/webrtc/weriftPeer.ts",
  name: "WERIFT_BUILT_IN_STUN_URI",
};

/** First-party source holding its own copy because it cannot import SOURCE. */
const CODE_COPIES = [
  {
    file: "apps/web/src/recurring/managedCronExportModel.ts",
    name: "CLI_BUILT_IN_STUN_URI",
  },
];

/**
 * Prose read for endpoints written as the built-in default. A `stated` file must
 * hold at least one such claim, so the sentence cannot be quietly dropped; the
 * others normally write no endpoint at all -- they interpolate a constant -- and
 * are read so that a literal written back into the prose is still held to the
 * source rather than escaping the tie by leaving the constant unused.
 */
const CLAIM_TEXTS = [
  { file: "docs/CLI.md", stated: true },
  { file: "docs/spec/DEPENDENCY_PINS.md", stated: true },
  { file: "docs/notes/cli-webrtc-stack.md", stated: true },
  { file: "apps/web/src/recurring/ManagedCronExportPanel.tsx", stated: false },
];

/**
 * A STUN endpoint as either half of the spellings the copies use: the full
 * `stun:host:port` URI, or the bare `host:port` authority a sentence writes when
 * the scheme would read as noise. Matched on a host name or an IPv4 literal.
 */
const ENDPOINT =
  /(?:\bstuns?:)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}|(?:\d{1,3}\.){3}\d{1,3}):(\d{2,5})\b/gi;

/** Extract the `host:port` authority a `stun:` URI names. */
export function stunAuthority(uri) {
  const match = /^stuns?:(.+)$/.exec(uri);
  return match === null ? undefined : match[1];
}

/**
 * The value a `export const <name> = "..."` declaration in `source` holds, or
 * undefined when no such declaration is there.
 */
export function declaredStringConstant(source, name) {
  const match = new RegExp(`export const ${name}\\s*=\\s*"([^"]*)"`, "u").exec(
    source,
  );
  return match === null ? undefined : match[1];
}

/**
 * How far past "built-in" a claim is read when the sentence does not end first.
 * A document states the default in one sentence; the cap keeps a paragraph whose
 * sentence boundary is unpunctuated (a list item, a heading) from swallowing an
 * unrelated endpoint further down.
 */
const CLAIM_WINDOW_CHARS = 200;

/**
 * Every endpoint `text` presents AS a built-in default, with its line, as
 * `{line, endpoint}` pairs normalized to the `host:port` authority. A claim is
 * read from the word "built-in" to the end of its sentence, so a document that
 * mentions the built-in default in one sentence and a `stun:` example in the
 * next (as docs/CLI.md does) yields the first and not the second, and a claim
 * that wraps across hard-wrapped lines is still read whole. A sentence naming no
 * endpoint is not a claim: it holds nothing that can drift.
 */
export function builtInDefaultClaims(text) {
  const claims = [];
  for (const anchor of text.matchAll(/built-in/gi)) {
    const rest = text.slice(anchor.index, anchor.index + CLAIM_WINDOW_CHARS);
    const sentenceEnd = /[.!?](?:\s|$)/.exec(rest);
    const window =
      sentenceEnd === null ? rest : rest.slice(0, sentenceEnd.index + 1);
    for (const match of window.matchAll(ENDPOINT))
      claims.push({
        line: lineOf(text, anchor.index),
        endpoint: `${match[1]}:${match[2]}`,
      });
  }
  return claims;
}

/**
 * The claims in `text` naming an endpoint other than `authority`. Empty when
 * every claim agrees with the source.
 */
export function claimMismatches(text, authority) {
  return builtInDefaultClaims(text).filter(
    ({ endpoint }) => endpoint.toLowerCase() !== authority.toLowerCase(),
  );
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const read = (file) => readFileSync(resolve(root, file), "utf8");
  const failures = [];

  const uri = declaredStringConstant(read(SOURCE.file), SOURCE.name);
  if (uri === undefined) {
    console.error(
      `${SOURCE.file}: no \`export const ${SOURCE.name} = "..."\` declaration was found. If you moved or reshaped the constant, update SOURCE or the pattern in scripts/check-stun-default-claims.mjs to match.`,
    );
    process.exit(1);
  }
  const authority = stunAuthority(uri);
  if (authority === undefined) {
    console.error(
      `${SOURCE.file}: ${SOURCE.name} is "${uri}", which is not a stun: URI -- the copies below are compared by endpoint, so it must name one.`,
    );
    process.exit(1);
  }

  for (const copy of CODE_COPIES) {
    const declared = declaredStringConstant(read(copy.file), copy.name);
    if (declared === undefined)
      failures.push(
        `${copy.file}: no \`export const ${copy.name} = "..."\` declaration matched -- the copy moved or was renamed; update scripts/check-stun-default-claims.mjs to follow it.`,
      );
    else if (declared !== uri)
      failures.push(
        `${copy.file}: ${copy.name} is "${declared}", but ${SOURCE.file} names "${uri}". An operator is told this endpoint before handing over a secret; change both, or neither.`,
      );
  }

  for (const { file, stated } of CLAIM_TEXTS) {
    const text = read(file);
    if (stated && builtInDefaultClaims(text).length === 0)
      failures.push(
        `${file}: states no built-in STUN default any more -- if it should no longer carry that claim, drop it from CLAIM_TEXTS in scripts/check-stun-default-claims.mjs.`,
      );
    for (const { line, endpoint } of claimMismatches(text, authority))
      failures.push(
        `${file}:${line}: names built-in default "${endpoint}", but ${SOURCE.file} names "${authority}".`,
      );
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log(
    `STUN default claim check passed: ${uri} in ${SOURCE.file}, matched by ${[...CODE_COPIES.map((c) => c.file), ...CLAIM_TEXTS.map((c) => c.file)].join(", ")}.`,
  );
}
