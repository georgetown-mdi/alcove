#!/usr/bin/env node
// URL-literal egress guard: `npm run check:egress-claims`, run by
// static_checks.yaml on every PR. Holds PRIVACY.md's no-egress claims against
// first-party drift.
//
// Fails (exit 1) when a URL literal under the http, https, stun, stuns, turn,
// or turns scheme names a host that is not on ALLOWLIST, each entry stating why
// it does not contradict PRIVACY.md. Reads every file git does not ignore under
// SCANNED_ROOTS plus SCANNED_FILES, skipping BINARY_EXTENSIONS and license
// files. JavaScript and TypeScript are read from the literal nodes of a parse,
// comments excluded; every other format, and a file that fails to parse, is
// scanned raw. It is a safety check, not a proof of no egress: its limits are
// published in docs/SECURITY_DESIGN.md and PRIVACY.md, so narrowing one moves
// all three. Rationale, the scanned set and the full limits:
// docs/notes/repo-check-scripts.md.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { lineOf } from "./lib/text.mjs";

/** Shipped-source trees the egress claims are made about. */
export const SCANNED_ROOTS = [
  "apps/web/src",
  "apps/cli/src",
  "packages/core/src",
  "packages/cli-contract/src",
  "packages/peerjs-broker/src",
  "apps/web/public",
  "apps/web/server",
];

/** Shipped files that build or run the container, outside any scanned tree. */
export const SCANNED_FILES = [
  "Dockerfile",
  "docker-entrypoint.sh",
  "Dockerfile.fips",
  "docker-entrypoint-fips.sh",
  "support/fips-probe/engagement.mjs",
  "support/fips-probe/image-engagement.mjs",
];

/**
 * Absolute URL literals that do not contradict PRIVACY.md, each with the reason
 * it does not. `exact` matches the literal; `prefix` also admits a longer URL
 * whose next character is `/`, `?`, or `#`, so the entry cannot be extended
 * into another host or another repository.
 */
export const ALLOWLIST = [
  {
    url: "stun:stun.l.google.com:19302",
    match: "exact",
    reason:
      "default public STUN server, the one third-party host the web app intends to reach; already named in PRIVACY.md's supporting-services table",
  },
  {
    url: "stun:44.247.30.68:443",
    match: "exact",
    reason: "second default public STUN server, same basis as the first",
  },
  {
    url: "https://peerjs",
    match: "exact",
    reason:
      "dummy base handed to `new URL()` so a request path can be parsed; never dereferenced",
  },
  {
    url: "http://127.0.0.1",
    match: "exact",
    reason:
      "fixed origin the console server builds each request's URL on so the request target can be parsed; never dereferenced",
  },
  {
    url: "http://www.w3.org/2000/svg",
    match: "exact",
    reason:
      "XML namespace identifier inside an inline SVG data URI; a namespace name, never fetched",
  },
  {
    url: "https://nodejs.org/dist",
    match: "prefix",
    reason:
      "the FIPS variant image's build fetches the official Node runtime tarball from here, because Amazon Linux 2023 packages no Node 26; what the build fetches, not a connection the running container makes, and the same class as the Alpine mirror the default image's one apk install reaches",
  },
  {
    url: "turns:relay.example.org:443?transport=tcp",
    match: "exact",
    reason:
      "the example form inside the connection schema's refusal of a host-less turn url; a reserved documentation domain shown to the operator, never dialed",
  },
  {
    url: "stun:stun.example.org:3478",
    match: "exact",
    reason:
      "the same example form in the refusal of a host-less stun entry, on the same basis",
  },
  {
    url: "https://relay.example.org:8443",
    match: "exact",
    reason:
      "the example form inside the connection schema's refusal of a malformed relay_registrar url; a reserved documentation domain shown to the operator, never dialed",
  },
  {
    url: "https://app.example.org/",
    match: "exact",
    reason:
      "the example web app address in the CLI invite's usage text and its refusal of an address with a path; a reserved documentation domain shown to the operator, never dialed",
  },
  {
    url: "https://github.com/georgetown-mdi/alcove",
    match: "prefix",
    reason:
      "operator-clicked hyperlinks into this project's own repository documentation: user navigation, not app-initiated egress; a prefix because UI work adds these routinely, scoped to this repository so a link to any other host still fails",
  },
];

// Extensions whose bytes are not text. Everything else is read and scanned.
const BINARY_EXTENSIONS = new Set([
  ".avif",
  ".bin",
  ".bmp",
  ".br",
  ".class",
  ".dll",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".icns",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".node",
  ".ogg",
  ".otf",
  ".pdf",
  ".png",
  ".so",
  ".svgz",
  ".tgz",
  ".ttf",
  ".wasm",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

const NOTICE_BASENAMES = new Set([
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "LICENCE",
  "LICENCE.md",
  "LICENCE.txt",
  "NOTICE",
  "NOTICE.md",
  "COPYING",
]);

// Where a URL ends inside the text holding it: whitespace, the quote forms,
// and the punctuation that brackets one in TypeScript, JSX, and CSS. Braces are
// left out and read at endOfUrl instead, where whether a `}` closes syntax or
// spells text is a question about the candidate rather than the character. `[`
// and `]` are left out so an IPv6 host literal is not truncated to nothing.
const URL_TERMINATOR = /[\s"'`<>(),;\\]/;

const URL_SCHEME = new RegExp(
  `(?<![A-Za-z0-9_])(?<scheme>https?|stuns?|turns?):`,
  "gi",
);

// An authority that survives interpolation as nothing but a port. A numeric
// port is literal text a fully interpolated authority leaves behind
// (`${host}:8443`), and `new URL()` rejects a non-numeric one, so nothing a
// host could hide in is dropped with it.
const TRAILING_PORT = /:\d*$/;

// The parser resolves the elided placeholder text of the invitation field
// (`https://...#...`) to a host of nothing but dots, which names no server.
const DOTS_ONLY = /^\.+$/;

/** Whether `path` is scanned at all (a text file that is not license text). */
export function isScannedFile(path) {
  if (NOTICE_BASENAMES.has(basename(path))) return false;
  return !BINARY_EXTENSIONS.has(extname(path).toLowerCase());
}

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

/** Whether `path` is read by the TypeScript parser rather than scanned raw. */
export function isJavaScriptFamily(path) {
  return SCRIPT_KIND_BY_EXTENSION.has(extname(path).toLowerCase());
}

/** The 1-based line the character at `position` of `source` sits on. */

/**
 * One candidate: the text a matcher reads, assembled from the segments that
 * wrote it. A segment is either literal text or, in a template, the `${...}`
 * span between two literal ones, and each records where its text starts in the
 * file. A segment whose text the file spells verbatim maps its own offsets
 * straight back; one the parser rewrote (a literal holding an escape) reports
 * the position it begins at.
 *
 * A `raw` candidate is the whole text of a file no parser was run for, which
 * is what decides how a brace in it is read (endOfUrl).
 */
function candidateOf(source, segments, raw = false) {
  let text = "";
  const placed = [];
  for (const segment of segments) {
    placed.push({
      ...segment,
      at: text.length,
      verbatim: source.startsWith(segment.text, segment.sourceStart),
    });
    text += segment.text;
  }
  return { text, segments: placed, raw };
}

/** The segment `offset` falls in. */
function segmentAt(candidate, offset) {
  return candidate.segments.findLast((segment) => segment.at <= offset);
}

/** Whether `offset` is interpolated text rather than text the literal spells. */
function isInterpolated(candidate, offset) {
  return segmentAt(candidate, offset).interpolation === true;
}

/** Where in the file the character at `offset` of the candidate sits. */
function positionOf(candidate, offset) {
  const segment = segmentAt(candidate, offset);
  return segment.verbatim
    ? segment.sourceStart + (offset - segment.at)
    : segment.sourceStart;
}

/**
 * A template as one candidate, its literal spans holding the source text of
 * each `${...}` between them. Both template expressions and template literal
 * types are written this way, and the spans are read the same for either.
 *
 * The head token ends just past the `${` it opens, and each following literal
 * token starts at the `}` that closes it, which is what bounds the span.
 */
function templateCandidate(source, parsed, node) {
  const segments = [
    { text: node.head.text, sourceStart: node.head.getStart(parsed) + 1 },
  ];
  let opened = node.head.end;
  for (const span of node.templateSpans) {
    const closing = span.literal.getStart(parsed);
    segments.push({
      text: source.slice(opened - "${".length, closing + "}".length),
      sourceStart: opened - "${".length,
      interpolation: true,
    });
    segments.push({
      text: span.literal.text,
      sourceStart: closing + "}".length,
    });
    opened = span.literal.end;
  }
  return candidateOf(source, segments);
}

/**
 * The literals a TypeScript parse of `source` holds, or undefined when the
 * parser reports a syntax error: a broken parse yields no literal nodes, so the
 * caller scans such a file raw rather than reading nothing out of it.
 */
function parsedLiterals(source, path) {
  const parsed = ts.createSourceFile(
    basename(path),
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    SCRIPT_KIND_BY_EXTENSION.get(extname(path).toLowerCase()),
  );
  // `parseDiagnostics` is off the public SourceFile type. A TypeScript upgrade
  // that renames it therefore is treated as "cannot parse", which scans the
  // file raw and over-reports, rather than as "parsed clean".
  if (parsed.parseDiagnostics?.length !== 0) return undefined;

  const literals = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      literals.push(
        candidateOf(source, [
          { text: node.text, sourceStart: node.getStart(parsed) + 1 },
        ]),
      );
    } else if (ts.isJsxText(node)) {
      literals.push(
        candidateOf(source, [{ text: node.text, sourceStart: node.pos }]),
      );
    } else if (
      ts.isTemplateExpression(node) ||
      ts.isTemplateLiteralTypeNode(node)
    ) {
      literals.push(templateCandidate(source, parsed, node));
    }
    node.forEachChild(visit);
  };
  visit(parsed);
  return literals;
}

/**
 * Where the URL beginning at `start` ends: the first terminator the candidate's
 * own reading of the text admits.
 *
 * A parsed candidate holds the parser's word on which spans interpolate, so a
 * terminator inside one of them belongs to the expression rather than to the
 * URL, and a brace is never a terminator at all: in a template it opens or
 * closes a span whose text belongs to the authority the literal writes, and in
 * a string or a JSX attribute value the parser says those characters are text.
 *
 * A raw candidate has no such word, and the formats scanned raw write braces as
 * syntax of their own: shell and Dockerfile parameter expansion. There a `${`
 * opens a span its matching `}` closes, both part of the URL
 * (`https://nodejs.org/dist/${NODE_VERSION}/x`), while a `}` that opened
 * nothing ends it -- the one closing `${SFTP_ENDPOINT:-https://host}`, which
 * lands in the reported host if the URL swallows it.
 */
function endOfUrl(candidate, start) {
  let depth = 0;
  for (let offset = start; offset < candidate.text.length; offset += 1) {
    const char = candidate.text[offset];
    if (candidate.raw) {
      if (char === "$" && candidate.text[offset + 1] === "{") {
        depth += 1;
        offset += 1;
        continue;
      }
      if (char === "}") {
        if (depth === 0) return offset;
        depth -= 1;
        continue;
      }
    }
    if (URL_TERMINATOR.test(char) && !isInterpolated(candidate, offset)) {
      return offset;
    }
  }
  return candidate.text.length;
}

/**
 * The host `new URL()` resolves `authority` to, or undefined where it rejects
 * it outright. The parser is the oracle for both directions, and it is handed
 * an authority position rather than the literal as written: `stun:` and `turn:`
 * URIs have no `//` (RFC 7064, RFC 7065), and the slash count of a web URL
 * means nothing either, since `new URL()` resolves `https:host/x` through
 * `https:////host/x` alike and `fetch` dereferences them alike too.
 *
 * What that buys over judging the characters: an internationalized host is a
 * host, whatever alphabet it is written in (`https://пример.рф/` resolves to
 * `xn--e1afmkfd.xn--p1ai`, which resolves and serves), a bracketed `[::]` is
 * one, and a port is separated from the host by the same rules the runtime
 * applies rather than by a rule of our own.
 */
function resolvedHost(authority) {
  try {
    return new URL(`https://${authority}`).hostname;
  } catch {
    return undefined;
  }
}

/**
 * The absolute URL literals `candidate` holds, as `{url, host, line}`, where
 * `host` is what the URL parser resolved and undefined where it rejected the
 * authority as unparseable -- reported all the same, and loudly.
 *
 * Two shapes are excluded here rather than allowlisted, because neither names a
 * host:
 *
 *   - An empty authority -- a scheme followed by nothing but slashes, which is
 *     what a protocol comparison (`location.protocol === "https:"`) is, and
 *     what makes the check usable at all for the other schemes: `stun:` and
 *     `turn:` are also object-property syntax in a Zod schema, the head of a
 *     `/^turns?:/` anchor, and the tail of prose like "must begin with turn:".
 *   - An authority a template interpolates away, as the `URL`-parsing helpers
 *     over an inbound `Host` header write it (`http://${host}`,
 *     `http://${host}:8443`). Only text the parser calls an interpolation is
 *     removed, so the same characters inside a string or a JSX attribute value
 *     stay the literal host they are.
 */
function urlsIn(source, candidate) {
  const found = [];
  for (const match of candidate.text.matchAll(URL_SCHEME)) {
    // A scheme inside an interpolation belongs to the expression, whose own
    // literals are candidates in their own right.
    if (isInterpolated(candidate, match.index)) continue;

    const start = match.index + match[0].length;
    const end = endOfUrl(candidate, start);
    const body = candidate.text.slice(start, end);
    const authorityStart = start + /^\/*/.exec(body)[0].length;
    let authority = "";
    for (let offset = authorityStart; offset < end; offset += 1) {
      if (!isInterpolated(candidate, offset)) {
        authority += candidate.text[offset];
      }
    }
    if (authority === "") continue;
    // What an interpolation left behind can still be a whole authority's worth
    // of punctuation, which is why the port comes off before the parser sees it.
    const interpolated = authority.length !== end - authorityStart;
    if (
      interpolated &&
      authority.split(/[/?#]/, 1)[0].replace(TRAILING_PORT, "") === ""
    ) {
      continue;
    }

    const host = resolvedHost(authority);
    if (host !== undefined && DOTS_ONLY.test(host)) continue;
    found.push({
      url: `${match.groups.scheme}:${body}`,
      host,
      line: lineOf(source, positionOf(candidate, match.index)),
    });
  }
  return found;
}

/**
 * Absolute URL literals in `source` as `{url, host, line}`, read from the
 * parser's literal nodes for a JavaScript-family file and from the raw text for
 * every other format.
 */
export function urlLiterals(source, path) {
  const parsed = isJavaScriptFamily(path)
    ? parsedLiterals(source, path)
    : undefined;
  const candidates = parsed ?? [
    candidateOf(source, [{ text: source, sourceStart: 0 }], /* raw */ true),
  ];
  return candidates.flatMap((candidate) => urlsIn(source, candidate));
}

/** The allowlist entry admitting `url`, or undefined if none does. */
export function allowlistEntryFor(url) {
  return ALLOWLIST.find((entry) => {
    if (url === entry.url) return true;
    if (entry.match !== "prefix") return false;
    return url.startsWith(entry.url) && "/?#".includes(url[entry.url.length]);
  });
}

/** Unallowlisted URL literals in one file, as violation strings (empty = clean). */
export function fileViolations(path, source) {
  if (!isScannedFile(path)) return [];
  return urlLiterals(source, path)
    .filter(({ url }) => allowlistEntryFor(url) === undefined)
    .map(
      ({ url, line }) =>
        `${path}:${line}: unallowlisted URL literal \`${url}\` -- PRIVACY.md tells agency reviewers the container "makes no other network connection" and the hosted web application "makes no request to any host other than the supporting services named below"`,
    );
}

/**
 * Scan the real paths under `root`, returning the files read and what failed.
 *
 * Each pathspec is listed on its own and required to match something. `git
 * ls-files` reports a pathspec that matches nothing by printing nothing and
 * exiting 0, so a renamed or deleted shipped tree would otherwise leave the
 * check passing over a smaller scan than it claims.
 *
 * The listing covers tracked and untracked files but not ignored ones, which
 * keeps build output out of the scan and leaves a generated file dropped into a
 * scanned tree unread.
 *
 * `-z` is what makes a non-ASCII filename readable: the default `core.quotePath`
 * has git print such a path quoted and C-escaped, and that spelling names no
 * file on disk, so the read of it would fail with a bare ENOENT rather than any
 * egress finding.
 */
export function scanRepo(root) {
  const matched = new Set();
  const unresolved = [];
  for (const pathspec of [...SCANNED_ROOTS, ...SCANNED_FILES]) {
    const listed = execFileSync(
      "git",
      [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        pathspec,
      ],
      { cwd: root, encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean);
    if (listed.length === 0) unresolved.push(pathspec);
    for (const file of listed) matched.add(file);
  }
  if (unresolved.length > 0) {
    throw new Error(
      `Egress claim check: ${unresolved.join(", ")} matches no file. A scanned tree or file was renamed or removed; point SCANNED_ROOTS or SCANNED_FILES in scripts/check-egress-claims.mjs at the path that ships.`,
    );
  }
  const files = [...matched].sort().filter(isScannedFile);
  const violations = files.flatMap((file) =>
    fileViolations(file, readFileSync(resolve(root, file), "utf8")),
  );
  return { files, violations };
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { files, violations } = scanRepo(root);
  if (violations.length > 0) {
    console.error(
      `Egress claim check failed (${violations.length} unallowlisted URL literal${violations.length === 1 ? "" : "s"}):\n`,
    );
    for (const v of violations) console.error("  " + v);
    console.error(
      "\nA new host reached from shipped source falsifies PRIVACY.md, which is written for agency security reviewers: no analytics or third-party tracking scripts, no script, style, or font from a third-party host, no update ping, no telemetry.",
    );
    console.error(
      "If the literal is egress the document does not disclose, it is the document that has to change, not this list. If it does not contradict the document -- because it names no host anything contacts (a namespace identifier, a document link the operator clicks, a base URL only handed to a parser), or because the host it names is already in PRIVACY.md's supporting-services table -- add it to ALLOWLIST in scripts/check-egress-claims.mjs with the one-line reason why.",
    );
    process.exit(1);
  }
  console.log(
    `Egress claim check passed: ${files.length} files across ${SCANNED_ROOTS.length} shipped-source trees and ${SCANNED_FILES.length} container files hold no URL literal outside the ${ALLOWLIST.length}-entry allowlist.`,
  );
}
