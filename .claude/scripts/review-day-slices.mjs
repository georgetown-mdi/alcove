#!/usr/bin/env node
// Review-day slice cutter, run at the review day's slice step. Usage is USAGE
// below. Writes `<dayDir>/SLICES.md` and `<dayDir>/plan.json` and prints the
// day's total cost estimate. Every file is read at the pinned sha (`git
// cat-file`, `git ls-tree`, and `git log` and `git diff` between commits), never
// from the checkout, which the container's session shares. Git runs in the
// worktree the process starts in.
//
// The window and the previous day:
//
// - The previous day is the newest directory beside `<dayDir>` (normally
//   `scratch/review-days/<date>/`) whose name sorts before `<dayDir>`'s own and
//   that holds `FINAL/`. A newer one without `FINAL/`, a day stopped at a failed
//   precondition, is skipped and named on stdout. With none, the day runs with
//   no owed passes and nothing skipped. A previous day whose `FINAL/` has no
//   `owed.md` runs with no owed passes, and says so on stdout and in SLICES.md.
// - The window is `git log --first-parent <prev>..<sha>`, one first-parent
//   commit per merged pull request. `<prev>` is `--prev <sha>` when given, else
//   the `sha` of the previous day's `FINAL/record.json`; with neither, the run
//   stops and asks for `--prev`.
// - Files a day read whole are the `filesReadWhole` lists of its
//   `FINAL/record.json` slices, read at that record's `sha`.
//
// `owed.md` (the previous day's `FINAL/owed.md`) holds one owed pass per list
// line, four fields split by " | ":
//
//   - <lens 1-4> | <files or slice> | <reason> | <blocked by>
//
// "blocked by" is "-", or one or more comma-separated board items
// (`<board>/<itemId>`) whose fix edits the pass's files. Backticked paths in
// the second field name its files: a path with an extension matches the tracked
// files equal to it or ending in `/<path>`, one ending in "/" every file under
// it, and a `:<line>` suffix is dropped. A pass blocked by an item whose body has
// no `Delivered by:` line (`.claude/pm/ruleset.md`, Task template), by an item
// not found, or by anything that is not a board item, is carried over to
// plan.json's `carried` list instead of being emitted. Items are read through
// `fetch-issues.mjs`.
//
// Selectors, in slice order: owed passes; census changes (lens 2); hot files
// (lens 4, plus lens 2 for the hot files on a trust boundary not already in a
// census slice), N fitted after the previous day's unchanged whole reads are
// skipped; outward text (lens 3); stale spec statements (lens 1); one rotation
// slice, from the directory whose least recently read file was read whole
// longest ago (never first), its oldest-read files up to the bound. Each
// selector's set is cut by directory into slices of at most `maxSliceLines`, a
// small directory joining its neighbour. A user-string or stale-spec slice
// lists the lines it matched and is sized by them, `matchContextLines` either
// side of each; a stale-spec slice also lists each code file where a name its
// statements use occurs, and counts `matchContextLines` either side of each such
// line, each line once, up to the file's line count. The merged ranges counted
// are the slice's `regions` and follow the path in SLICES.md. A statement that
// names a code file only by its stem has no such line: it charges the lines the
// window changed in that file instead, widened the same way, or the whole file
// when the window has no hunk for it. One spec file over the bound is split by
// statement into consecutive parts (`stale-spec-N.1`, `.2`, ...), each charging
// its own statements; a single statement over the bound stops the run. Every
// other slice is sized by its files' whole line counts.
//
// Exit 0 written; 1 a slice over `maxSliceLines`, nothing written; 2 usage, an
// unreadable input, a git error, or a failed board read.

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Working values fitted from the 2026-11-06 review pass and re-fitted at each
 * retro, not constants: the slice size bound, the hot-file line target the
 * threshold N is fitted to, the lines of context charged either side of a
 * matched string or spec statement, and the cost of one slice by lens (each
 * including reviewer, verifier and triage share), with the mean for a slice of
 * no lens.
 */
export const WORKING_VALUES = Object.freeze({
  maxSliceLines: 8000,
  hotLineTarget: 45000,
  matchContextLines: 5,
  unitCosts: Object.freeze({ 1: 8.41, 2: 7.36, 3: 4.97, 4: 6.39 }),
  meanUnitCost: 7.18,
});

const spec = (name) => (name.includes("/") ? name : `docs/spec/${name}.md`);

/**
 * The lens-2 trust boundaries, first match wins. A path ending in "/" matches
 * every file under it; a `*` matches within one path segment.
 */
export const BOUNDARIES = [
  {
    id: "L2-protocol",
    paths: [
      "packages/core/src/psi/",
      "packages/core/src/exchange/",
      "packages/core/src/exchange.ts",
      "packages/core/src/consent/",
      "apps/cli/src/protocol.ts",
      "apps/cli/src/invitationDecode.ts",
      "apps/cli/src/partyIdentity.ts",
      "apps/cli/src/signingIdentity*.ts",
      "apps/cli/src/receiptFile.ts",
      "apps/cli/src/commands/verifyReceipt.ts",
      "apps/cli/src/psiWorker*.ts",
      "apps/cli/src/psiBackend.ts",
    ],
    except: [],
    specs: [
      "PROTOCOL",
      "KEY_EXCHANGE",
      "PSI_C",
      "SHARED_SECRET_ROTATION",
      "RELAY_CREDENTIALS",
      "RELAY_REGISTRAR",
      "CANONICAL_ENCODING",
      "INVITATION_TOKEN",
      "CHANNEL_SECURITY",
    ].map(spec),
    assets:
      "PSI keys and blinded sets, the invitation token and its secret, channel keys and MACs, signing identities, receipts and their signatures, the match result and its counts.",
  },
  {
    id: "L2-webrtc",
    paths: [
      "packages/core/src/connection/",
      "apps/web/src/psi/transport/",
      "apps/web/src/psi/workers/",
      "apps/cli/src/connection/webrtc/",
      "apps/cli/src/webrtcPeerRole.ts",
      "apps/cli/src/transportTeardown.ts",
    ],
    except: ["packages/core/src/connection/fileSync*"],
    specs: ["WEBRTC_TRANSPORT", "TRANSPORT_BOUNDS", "TRANSPORT_LIVENESS"].map(
      spec,
    ),
    assets:
      "Frames and messages from the partner, DTLS fingerprints, ICE and TURN credentials, peer metadata.",
  },
  {
    id: "L2-sftp",
    paths: [
      "apps/cli/src/connection/",
      "packages/core/src/connection/fileSync*",
      "apps/cli/src/hostKeyTrust.ts",
      "apps/cli/src/literalCredentials.ts",
      "apps/cli/src/serverProvision.ts",
      "apps/cli/src/connectionFromUrl.ts",
    ],
    except: ["apps/cli/src/connection/webrtc/"],
    specs: [
      "SFTP_CONNECTION",
      "SFTP_SESSION_RECOVERY",
      "FILE_SYNC",
      "FILE_SYNC_MEMORY",
      "docs/FIPS_SFTP_PROFILE.md",
    ].map(spec),
    assets:
      "SSH private key and passphrase, host key pins, file names, sizes and contents a malicious server or folder peer returns.",
  },
  {
    id: "L2-atrest",
    paths: [
      "apps/web/src/psi/managed/",
      "apps/cli/src/keyFile.ts",
      "apps/cli/src/keyFilePreflight.ts",
      "apps/cli/src/sensitiveFile.ts",
      "apps/cli/src/resultFile.ts",
      "apps/cli/src/recordFile.ts",
      "apps/cli/src/acceptedTermsRecords.ts",
      "apps/cli/src/termsUpdateFiles.ts",
      "apps/cli/src/relayKeyRotation.ts",
    ],
    except: [],
    specs: [
      "CREDENTIAL_STORAGE",
      "EXCHANGE_RECORD",
      "MANAGED_EXCHANGE_RECORD",
      "MANAGED_EXCHANGE_SCHEDULE",
    ].map(spec),
    assets:
      "Managed records in browser storage (keys, partner identity, schedules), the CLI key file, result and receipt files, accepted terms.",
  },
  {
    id: "L2-signaling",
    paths: [
      "packages/peerjs-broker/",
      "infra/broker/",
      "apps/cli/src/webAppSignaling.ts",
      "apps/cli/src/onlineBootstrap.ts",
    ],
    except: [],
    specs: ["SIGNALING_SERVER_BOUNDS"].map(spec),
    assets:
      "Peer ids, broker TLS key and certificate, connection metadata (who talks to whom, when), broker logs.",
  },
  {
    id: "L2-delivery",
    paths: [
      "apps/web/public/",
      "apps/web/index.html",
      "apps/web/hosted/",
      "apps/web/vite.config.ts",
      ".github/workflows/",
      "Dockerfile*",
      "docker-entrypoint*.sh",
      "allowed_signers",
    ],
    except: [],
    specs: [
      "CONTAINER_IMAGES",
      "DEPENDENCY_PINS",
      "SFTP_STACK",
      "WEBRTC_STACK",
      "THIRD_PARTY_CODE",
      "docs/RELEASES.md",
      "docs/DEPLOYMENT.md",
    ].map(spec),
    assets:
      "The deployed bundle and its service-worker cache, the CSP and security headers, release signing keys, workflow tokens and secrets, the published images.",
  },
  {
    id: "L2-console",
    paths: [
      "apps/web/server/",
      "apps/web/src/console/",
      "apps/web/src/jobs/",
      "apps/web/src/jobContract/",
      "packages/cli-contract/",
      "apps/cli/src/eventStream.ts",
      "apps/cli/src/run/",
    ],
    except: [],
    specs: [
      "SERVER_JOB_API",
      "CLI_EVENTS",
      "DISPLAY_ESCAPE",
      "DISPLAY_REDACTION",
      "docs/CONSOLE.md",
    ].map(spec),
    assets:
      "The loopback API's auth token and origin checks, the mounted working directory's files, the job's secret and config, partner-controlled strings the console displays.",
  },
  {
    id: "L2-input",
    paths: [
      "packages/core/src/records/",
      "packages/core/src/standardization.ts",
      "packages/core/src/config/",
      "apps/cli/src/config/",
      "apps/cli/src/config.ts",
      "apps/cli/src/configTemplate.ts",
      "apps/cli/src/inputHeapCheck.ts",
      "apps/web/src/psi/authoring/",
    ],
    except: [],
    specs: [
      "PARSED_INPUT_BOUNDS",
      "TRANSFORM_PARAMETER_BOUNDS",
      "TRANSFORM_REGEX_DIALECT",
      "DEFAULT_STANDARDIZATION",
      "EXCHANGE_FILE",
    ].map(spec),
    assets:
      "Record file contents (personal data), config fields a partner's shared config can set (transforms, regexes), file paths.",
  },
];

/** The reviewer-facing governance documents, all read when any is touched. */
export const GOVERNANCE_DOCS = [
  "docs/COMPLIANCE.md",
  "docs/INCIDENT_RESPONSE.md",
  "docs/SERVICE_FACT_SHEET.md",
  "docs/SHARED_RESPONSIBILITY.md",
  "docs/SECURITY_DESIGN.md",
  "docs/ACCESSIBILITY.md",
  "README.md",
  "SECURITY.md",
  "PRIVACY.md",
  "SUPPORT.md",
  "docs/index.md",
  "docs/README.md",
  "apps/web/public/.well-known/",
];

/** Paths whose window changes are census changes whatever the diff adds. */
export const DELIVERY_PATHS = [
  ".github/workflows/",
  "**/Dockerfile*",
  "apps/web/public/serviceWorker.js",
  "infra/",
];

const CENSUS_ROOTS = ["apps/", "packages/", "infra/"];

/**
 * What a line the window adds must match for its file to be a census change.
 * Best effort: a listener or parser written another way is missed.
 */
export const CENSUS_PATTERNS = [
  {
    kind: "listener or route",
    pattern:
      /\.(on|once|addEventListener|addListener)\(\s*["'`]|\b(createServer|listen)\(|\b(app|router|server|route)\.(get|post|put|patch|delete|all|use|route)\(/,
  },
  {
    kind: "frame or message handler",
    pattern:
      /\bon(message|data|frame)\s*[=:(]|\bhandle\w*(Message|Frame|Packet)\b/i,
  },
  {
    kind: "deserializer",
    pattern:
      /\bJSON\.parse\(|\.(safeParse|parse|parseAsync)\(|\b(unpack|decode)\w*\(|\bnew (DataView|TextDecoder)\b|\.getU?int(8|16|32)\(|\bread(UInt|Int|BigUInt)\w*\(|\bparse(Csv|CSV|Records)\w*\(/,
  },
  {
    kind: "read of supplied bytes",
    pattern:
      /\b(readFile|readFileSync|createReadStream|fastGet|getItem)\(|\.(arrayBuffer|text|json)\(\)|\bindexedDB\b/,
  },
  {
    kind: "write of key material",
    pattern:
      /\b(exportKey|wrapKey|setItem)\(|\b(write|store|save|put|persist)\w*\(.*\b(key|secret|seed|privateKey|passphrase)/i,
  },
];

const USER_STRING_ROOTS = ["apps/cli/src/", "apps/web/src/"];

const USER_STRING_PATTERN =
  /throw new \w*Error\(|console\.(error|warn)\(|process\.std(err|out)\.write\(|\b\w*([wW]arn|[rR]efus|[rR]emedy|[hH]int|[uU]sage|[hH]elp|[mM]essage|[tT]itle|[dD]escription|[lL]abel|[pP]laceholder|[eE]rror)\w*\s*[:=(]\s*["'`][^"'`]*[A-Za-z]{2}|(^|>)\s*[A-Z][a-z]+(\s+[a-z,.'-]+){2,}\s*(<|$)/;

const SOURCE_EXTENSION = /\.(ts|tsx|js|jsx|mjs|cjs|py|sh|ya?ml)$/;
const TEST_PATH =
  /(^|\/)(test|tests|__tests__|__mocks__|e2e|fixtures?)\/|\.(test|spec)\.[^/]+$/;
const MIN_NAME_LENGTH = 4;
// A name all in lower case ("exchange", "relay") cannot be told from prose.
const isDistinctiveName = (name) =>
  name.length >= MIN_NAME_LENGTH && /[A-Z_0-9$]/.test(name.slice(1));
const EXPORTED_NAME =
  /^export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
const BOARD_ITEM = /^\d+\/\d+$/;
const DELIVERED_BY_LINE = /^Delivered by: \S/m;
const FETCH_ISSUES = fileURLToPath(
  new URL("./fetch-issues.mjs", import.meta.url),
);

/** A slice over `maxSliceLines`: the run stops rather than emit it. */
export class SliceOverSizeError extends Error {}

/** Whether `path` matches a boundary-table pattern (see BOUNDARIES). */
export function pathMatches(pattern, path) {
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  if (!pattern.includes("*")) return path === pattern;
  const source = pattern
    .split(/(\*\*\/|\*)/)
    .map((part) =>
      part === "**/"
        ? "(?:.*/)?"
        : part === "*"
          ? "[^/]*"
          : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`).test(path);
}

const matchesAny = (patterns, path) =>
  patterns.some((pattern) => pathMatches(pattern, path));

/** The trust boundary `path` lies on, or null. */
export function boundaryOf(path) {
  return (
    BOUNDARIES.find(
      (boundary) =>
        matchesAny(boundary.paths, path) && !matchesAny(boundary.except, path),
    ) ?? null
  );
}

/** Whether `path` is a non-test source file. */
export function isSourcePath(path) {
  return SOURCE_EXTENSION.test(path) && !TEST_PATH.test(path);
}

/** Git over the worktree at `cwd`, reading only at the commits it is given. */
export function gitIn(cwd) {
  const text = (args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1 << 30,
      stdio: ["ignore", "pipe", "pipe"],
    });
  return {
    text,
    succeeds: (args) =>
      spawnSync("git", args, { cwd, stdio: "ignore" }).status === 0,
    blobs: (sha, paths) => readBlobs(cwd, sha, paths),
    /** `git show <sha>:<path> | wc -l` for each path, in one `cat-file` run. */
    lineCounts(sha, paths) {
      const counts = new Map();
      for (const [path, blob] of readBlobs(cwd, sha, paths)) {
        let lines = 0;
        for (let i = 0; i < blob.length; i += 1)
          if (blob[i] === 0x0a) lines += 1;
        counts.set(path, lines);
      }
      return counts;
    },
  };
}

/** Each path's content at `sha`, as a Buffer, from one `git cat-file --batch`. */
function readBlobs(cwd, sha, paths) {
  const blobs = new Map();
  if (paths.length === 0) return blobs;
  const out = execFileSync("git", ["cat-file", "--batch"], {
    cwd,
    input: paths.map((path) => `${sha}:${path}\n`).join(""),
    maxBuffer: 1 << 30,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let position = 0;
  for (const path of paths) {
    const headerEnd = out.indexOf(0x0a, position);
    const header = out.toString("utf8", position, headerEnd);
    const [, type, size] = header.split(" ");
    if (type !== "blob")
      throw new Error(`${path} is not a file at ${sha} (${header})`);
    const start = headerEnd + 1;
    const end = start + Number(size);
    blobs.set(path, out.subarray(start, end));
    position = end + 1;
  }
  return blobs;
}

/** The full sha `ref` names, or an error naming the ref. */
function resolveCommit(git, ref) {
  try {
    return git
      .text(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
      .trim();
  } catch {
    throw new Error(`${ref} does not name a commit in this repository`);
  }
}

/**
 * The window's first-parent commits and, per path, how many of them touched
 * it.
 */
export function windowCounts(git, prevSha, sha) {
  const out = git.text([
    "log",
    "--first-parent",
    "--diff-merges=first-parent",
    "--no-renames",
    "--name-only",
    "--format=%x00%H",
    `${prevSha}..${sha}`,
  ]);
  const prCounts = new Map();
  let commits = 0;
  for (const entry of out.split("\0")) {
    const lines = entry.split("\n").filter((line) => line !== "");
    if (lines.length === 0) continue;
    commits += 1;
    for (const path of new Set(lines.slice(1)))
      prCounts.set(path, (prCounts.get(path) ?? 0) + 1);
  }
  return { commits, prCounts };
}

/**
 * The lines the window's net diff adds, per file, each as its line number at
 * `sha` and its text.
 */
function addedLines(git, prevSha, sha, paths) {
  const added = new Map();
  if (paths.length === 0) return added;
  const out = git.text([
    "-c",
    "core.quotePath=false",
    "--literal-pathspecs",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    "-U0",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    prevSha,
    sha,
    "--",
    ...paths,
  ]);
  let current = null;
  let inHeader = false;
  let nextLine = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      current = null;
    } else if (inHeader && line.startsWith("+++ ")) {
      current = line.startsWith("+++ b/")
        ? line.slice(6).replace(/\t$/, "")
        : null;
    } else if (line.startsWith("@@")) {
      inHeader = false;
      nextLine = Number(/^@@ -\S+ \+(\d+)/.exec(line)?.[1] ?? 0);
    } else if (!inHeader && current !== null && line.startsWith("+")) {
      if (!added.has(current)) added.set(current, []);
      added.get(current).push({ line: nextLine, text: line.slice(1) });
      nextLine += 1;
    }
  }
  return added;
}

/**
 * The line ranges the window's net diff changes, per file, as `[start, end]`
 * at `sha` (a deletion marks the line it follows), one per hunk.
 */
function changedHunks(git, prevSha, sha, paths) {
  const hunks = new Map();
  if (paths.length === 0) return hunks;
  const out = git.text([
    "-c",
    "core.quotePath=false",
    "--literal-pathspecs",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    "-U0",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    prevSha,
    sha,
    "--",
    ...paths,
  ]);
  let current = null;
  let inHeader = false;
  for (const line of out.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      current = null;
    } else if (inHeader && line.startsWith("+++ ")) {
      current = line.startsWith("+++ b/")
        ? line.slice(6).replace(/\t$/, "")
        : null;
    } else if (line.startsWith("@@") && current !== null) {
      inHeader = false;
      const found = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (found === null) continue;
      const start = Math.max(1, Number(found[1]));
      const count = found[2] === undefined ? 1 : Number(found[2]);
      if (!hunks.has(current)) hunks.set(current, []);
      hunks.get(current).push([start, start + Math.max(count, 1) - 1]);
    }
  }
  return hunks;
}

/**
 * The hot-file threshold: the N whose set of files touched by N or more pull
 * requests comes closest to `target` lines, the larger N on a tie.
 */
export function fitHotThreshold(prCounts, lineOf, target) {
  const thresholds = [...new Set(prCounts.values())].sort((a, b) => b - a);
  let best = null;
  for (const threshold of thresholds) {
    const files = [...prCounts.keys()]
      .filter((path) => prCounts.get(path) >= threshold)
      .sort();
    const lines = files.reduce((sum, path) => sum + lineOf(path), 0);
    if (
      best === null ||
      Math.abs(lines - target) < Math.abs(best.lines - target)
    )
      best = { threshold, files, lines };
  }
  return best ?? { threshold: null, files: [], lines: 0 };
}

/**
 * Files cut by directory into groups of at most `maxLines`: a directory over
 * the bound is split in path order, then adjacent groups join while they fit.
 * A single file over the bound stays a group of its own, for the bound check
 * to refuse.
 */
export function cutByDirectory(
  files,
  lineOf,
  maxLines,
  groupLines = (group) => group.reduce((sum, path) => sum + lineOf(path), 0),
) {
  const byDirectory = new Map();
  for (const path of [...new Set(files)].sort()) {
    const directory = dirname(path);
    if (!byDirectory.has(directory)) byDirectory.set(directory, []);
    byDirectory.get(directory).push(path);
  }
  const pieces = [];
  for (const directory of [...byDirectory.keys()].sort()) {
    let piece = { files: [], lines: 0 };
    for (const path of byDirectory.get(directory)) {
      if (
        piece.files.length > 0 &&
        groupLines([...piece.files, path]) > maxLines
      ) {
        pieces.push(piece);
        piece = { files: [], lines: 0 };
      }
      piece.files.push(path);
      piece.lines = groupLines(piece.files);
    }
    pieces.push(piece);
  }
  const joined = [];
  for (const piece of pieces) {
    const last = joined.at(-1);
    const together =
      last === undefined ? 0 : groupLines([...last.files, ...piece.files]);
    if (last !== undefined && together <= maxLines) {
      last.files.push(...piece.files);
      last.lines = together;
    } else joined.push({ files: [...piece.files], lines: piece.lines });
  }
  return joined;
}

/** `ranges` sorted, with overlapping or touching ones merged. */
export function mergeRanges(ranges) {
  const merged = [];
  for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last !== undefined && from <= last[1] + 1)
      last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/**
 * The line ranges the matches at line numbers `lines` select, each with
 * `context` lines either side, within the file's `fileLines` (a match past it
 * keeps its own line), overlapping or touching ranges merged: 1-based,
 * inclusive `[start, end]` pairs.
 */
export function selectedRanges(lines, fileLines, context) {
  return widenRanges(
    [...new Set(lines)].map((line) => [line, line]),
    fileLines,
    context,
  );
}

/**
 * `ranges` each widened by `context` lines either side, within the file's
 * `fileLines` (a range ending past it keeps its own end), then merged.
 */
export function widenRanges(ranges, fileLines, context) {
  return mergeRanges(
    ranges
      .map(([from, to]) => [
        Math.max(1, from - context),
        Math.min(Math.max(fileLines, to), to + context),
      ])
      .filter(([from, to]) => to >= from),
  );
}

/** How many lines `selectedRanges` selects for the same arguments. */
export function selectedLineCount(lines, fileLines, context) {
  return selectedRanges(lines, fileLines, context).reduce(
    (sum, [from, to]) => sum + to - from + 1,
    0,
  );
}

/** Refuse any slice over `maxLines`, naming each. */
export function assertSliceBound(slices, maxLines) {
  const over = slices.filter((slice) => slice.lines > maxLines);
  if (over.length === 0) return;
  throw new SliceOverSizeError(
    over
      .map(
        (slice) =>
          `slice ${slice.id} (${slice.selector}, lens ${slice.lens ?? "-"}) is ${slice.lines} lines, over the ${maxLines}-line bound: ${slice.files.join(", ")}${
            slice.statements?.length === 1
              ? ` (the single statement at ${slice.statements[0].path}:${slice.statements[0].line})`
              : ""
          }`,
      )
      .join("\n"),
  );
}

/** The owed passes in an `owed.md` text (format in this file's header). */
export function parseOwed(text) {
  const passes = [];
  text.split("\n").forEach((line, index) => {
    if (!line.startsWith("- ")) return;
    const fields = line.slice(2).split(" | ");
    if (fields.length < 4)
      throw new Error(
        `owed.md line ${index + 1}: a list line has ${fields.length} of the 4 fields "lens | files | reason | blocked by"`,
      );
    const lens = fields[0].trim();
    if (!/^[1-4]$/.test(lens))
      throw new Error(
        `owed.md line ${index + 1}: the lens field is "${lens}", not 1-4`,
      );
    const blockedBy = fields.at(-1).trim();
    passes.push({
      line: line.slice(2),
      lens: Number(lens),
      target: fields[1].trim(),
      reason: fields.slice(2, -1).join(" | ").trim(),
      blockedBy:
        blockedBy === "-"
          ? []
          : blockedBy
              .split(",")
              .map((ref) => ref.trim())
              .filter(Boolean),
    });
  });
  return passes;
}

/** The tracked files an owed pass's backticked paths name. */
export function owedFiles(target, tracked) {
  const files = new Set();
  for (const [, quoted] of target.matchAll(/`([^`]+)`/g)) {
    const token = quoted
      .trim()
      .split(/\s/)[0]
      .replace(/:[\d,-]*$/, "");
    if (token.endsWith("/")) {
      for (const path of tracked)
        if (path.startsWith(token) || path.includes(`/${token}`))
          files.add(path);
    } else if (/\.[A-Za-z0-9]+$/.test(token)) {
      for (const path of tracked)
        if (path === token || path.endsWith(`/${token}`)) files.add(path);
    }
  }
  return [...files].sort();
}

/**
 * For each `<board>/<itemId>`, whether the item's body has a `Delivered by:`
 * line, read through fetch-issues.mjs; undefined for an item not found.
 */
export function deliveredByOnBoard(refs) {
  const byBoard = new Map();
  for (const ref of refs) {
    const [board, id] = ref.split("/");
    if (!byBoard.has(board)) byBoard.set(board, []);
    byBoard.get(board).push(id);
  }
  const delivered = new Map();
  for (const [board, ids] of byBoard) {
    let out;
    try {
      out = execFileSync(
        process.execPath,
        [FETCH_ISSUES, "--json", board, ...ids],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      throw new Error(
        `reading board ${board} items ${ids.join(", ")} failed: ${error.stderr || error.message}`,
      );
    }
    for (const item of JSON.parse(out))
      delivered.set(
        `${board}/${item.id}`,
        item.type === "missing" || typeof item.body !== "string"
          ? undefined
          : DELIVERED_BY_LINE.test(item.body),
      );
  }
  return delivered;
}

function readJsonIfPresent(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not readable JSON: ${error.message}`);
  }
}

/** The day directories beside `dayDir` whose names sort before its own. */
export function earlierDays(dayDir) {
  const root = dirname(resolve(dayDir));
  const name = basename(resolve(dayDir));
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter(
      (entry) => entry < name && statSync(join(root, entry)).isDirectory(),
    )
    .sort()
    .map((entry) => join(root, entry));
}

function dayRecord(day) {
  const record = readJsonIfPresent(join(day, "FINAL", "record.json"));
  if (record === null) return null;
  const filesReadWhole = new Set();
  for (const slice of Array.isArray(record.slices) ? record.slices : [])
    for (const path of Array.isArray(slice.filesReadWhole)
      ? slice.filesReadWhole
      : [])
      filesReadWhole.add(path);
  return {
    sha: typeof record.sha === "string" ? record.sha : null,
    filesReadWhole,
  };
}

/**
 * The `docs/spec` lines (outside `wording-changes/`) naming a file's stem or
 * exported name as a whole word, each with `code`: the files whose names it
 * uses, each mapped to the sorted names it uses from that file.
 */
export function specStatements(git, sha, files, tracked) {
  const names = new Map();
  const nameFile = (name, path) => {
    if (!names.has(name)) names.set(name, new Set());
    names.get(name).add(path);
  };
  const sources = git.blobs(
    sha,
    files.filter((path) => /\.(ts|tsx|js|mjs|cjs)$/.test(path)),
  );
  for (const path of files) {
    const stem = basename(path).replace(/\..*$/, "");
    if (isSourcePath(path) && isDistinctiveName(stem)) nameFile(stem, path);
    const source = sources.get(path)?.toString("utf8") ?? "";
    for (const [, name] of source.matchAll(EXPORTED_NAME))
      if (isDistinctiveName(name)) nameFile(name, path);
  }
  if (names.size === 0) return [];
  const specPaths = tracked.filter(
    (path) =>
      path.startsWith("docs/spec/") &&
      !path.startsWith("docs/spec/wording-changes/"),
  );
  const codeNamed = (named) => {
    const code = {};
    for (const name of [...named].sort())
      for (const path of [...names.get(name)].sort())
        (code[path] ??= []).push(name);
    return code;
  };
  const statements = [];
  for (const [path, blob] of git.blobs(sha, specPaths))
    blob
      .toString("utf8")
      .split("\n")
      .forEach((text, index) => {
        const named = new Set(
          (text.match(/[\w$]+/g) ?? []).filter((word) => names.has(word)),
        );
        if (named.size > 0)
          statements.push({
            path,
            line: index + 1,
            names: [...named].sort(),
            code: codeNamed(named),
          });
      });
  return statements;
}

/**
 * The day's plan: every slice from the selectors in this file's header, the
 * owed passes carried over, and the cost estimate. Throws SliceOverSizeError
 * when a slice exceeds the bound.
 */
export function planDay({
  cwd = process.cwd(),
  sha: shaRef,
  dayDir,
  prevSha: prevRef = null,
  deliveredBy = deliveredByOnBoard,
  workingValues = WORKING_VALUES,
}) {
  const git = gitIn(cwd);
  const {
    maxSliceLines,
    hotLineTarget,
    matchContextLines,
    unitCosts,
    meanUnitCost,
  } = workingValues;
  const sha = resolveCommit(git, shaRef);
  const days = earlierDays(dayDir);
  const previousDay =
    days.findLast((day) => existsSync(join(day, "FINAL"))) ?? null;
  const skippedDays = days.slice(days.indexOf(previousDay) + 1);
  const previousRecord = previousDay === null ? null : dayRecord(previousDay);
  const windowRef = prevRef ?? previousRecord?.sha ?? null;
  if (windowRef === null)
    throw new Error(
      `no previous day's FINAL/record.json names a sha; name the window's start with --prev <sha>`,
    );
  const prevSha = resolveCommit(git, windowRef);
  if (!git.succeeds(["merge-base", "--is-ancestor", prevSha, sha]))
    throw new Error(`${prevSha} is not an ancestor of ${sha}`);

  const tracked = git
    .text(["ls-tree", "-r", "--name-only", "-z", sha])
    .split("\0")
    .filter(Boolean);
  const trackedSet = new Set(tracked);
  const { commits, prCounts } = windowCounts(git, prevSha, sha);
  const windowFiles = [...prCounts.keys()]
    .filter((path) => trackedSet.has(path))
    .sort();

  const lineCache = new Map();
  const ensureLines = (paths) => {
    const missing = [...new Set(paths)].filter((path) => !lineCache.has(path));
    for (const [path, lines] of git.lineCounts(sha, missing))
      lineCache.set(path, lines);
  };
  const lineOf = (path) => {
    if (!lineCache.has(path)) ensureLines([path]);
    return lineCache.get(path);
  };

  const slices = [];
  const counters = new Map();
  const addSlices = (
    selector,
    lens,
    files,
    extra = {},
    sizeOf = lineOf,
    groupLines = undefined,
    refine = (pieces) => pieces,
  ) => {
    ensureLines(files);
    // An owed pass whose text names no tracked file is still a pass to run.
    const pieces =
      files.length > 0
        ? refine(cutByDirectory(files, sizeOf, maxSliceLines, groupLines))
        : selector === "owed"
          ? [{ files: [], lines: 0 }]
          : [];
    for (const piece of pieces) {
      if (piece.part === undefined || piece.part === 1)
        counters.set(selector, (counters.get(selector) ?? 0) + 1);
      const n = counters.get(selector);
      slices.push({
        id: `${selector}-${n}${piece.part === undefined ? "" : `.${piece.part}`}`,
        lens,
        selector,
        files: piece.files,
        lines: piece.lines,
        estimatedCost: lens === null ? meanUnitCost : unitCosts[lens],
        ...(typeof extra === "function" ? extra(piece.files, piece) : extra),
      });
    }
  };
  const matchedSize = (matches) => {
    const linesByPath = new Map();
    for (const { path, line } of matches) {
      if (!linesByPath.has(path)) linesByPath.set(path, []);
      linesByPath.get(path).push(line);
    }
    return (path) =>
      selectedLineCount(
        linesByPath.get(path) ?? [],
        lineOf(path),
        matchContextLines,
      );
  };
  const boundaryExtra = (boundary) =>
    boundary === null
      ? { boundary: null, specs: [], assets: null }
      : {
          boundary: boundary.id,
          specs: boundary.specs.filter((path) => trackedSet.has(path)),
          assets: boundary.assets,
        };
  const byBoundary = (files) => {
    const groups = new Map();
    for (const path of files) {
      const boundary = boundaryOf(path);
      const key = boundary?.id ?? "";
      if (!groups.has(key)) groups.set(key, { boundary, files: [] });
      groups.get(key).files.push(path);
    }
    return [...groups.values()].sort((a, b) =>
      (a.boundary?.id ?? "~").localeCompare(b.boundary?.id ?? "~"),
    );
  };

  // 1. Owed passes.
  const owedPath =
    previousDay === null ? null : join(previousDay, "FINAL", "owed.md");
  const hasOwedFile = owedPath !== null && existsSync(owedPath);
  const owedNote =
    previousDay !== null && !hasOwedFile
      ? `Owed passes: ${previousDay} has a FINAL/ directory but no owed.md, so no owed passes were read from it.`
      : null;
  const owed = hasOwedFile ? parseOwed(readFileSync(owedPath, "utf8")) : [];
  const itemRefs = [
    ...new Set(
      owed.flatMap((pass) =>
        pass.blockedBy.filter((ref) => BOARD_ITEM.test(ref)),
      ),
    ),
  ];
  const delivered = itemRefs.length === 0 ? new Map() : deliveredBy(itemRefs);
  const carried = [];
  for (const pass of owed) {
    const blocks = pass.blockedBy.flatMap((ref) => {
      if (!BOARD_ITEM.test(ref)) return [`${ref} is not a board item`];
      const state = delivered.get(ref);
      if (state === undefined) return [`${ref} was not found on its board`];
      return state ? [] : [`${ref} has no Delivered by: line`];
    });
    if (blocks.length > 0) {
      carried.push({ ...pass, why: blocks.join("; ") });
      continue;
    }
    addSlices("owed", pass.lens, owedFiles(pass.target, tracked), {
      target: pass.target,
      reason: pass.reason,
      owedLine: pass.line,
    });
  }

  // 2. Census changes.
  const censusCandidates = windowFiles.filter(
    (path) =>
      isSourcePath(path) && CENSUS_ROOTS.some((root) => path.startsWith(root)),
  );
  const userStringCandidates = windowFiles.filter(
    (path) =>
      isSourcePath(path) &&
      USER_STRING_ROOTS.some((root) => path.startsWith(root)),
  );
  const added = addedLines(git, prevSha, sha, [
    ...new Set([...censusCandidates, ...userStringCandidates]),
  ]);
  const censusKinds = new Map();
  for (const path of censusCandidates) {
    const kinds = CENSUS_PATTERNS.filter(({ pattern }) =>
      (added.get(path) ?? []).some(({ text }) => pattern.test(text)),
    ).map(({ kind }) => kind);
    if (kinds.length > 0) censusKinds.set(path, kinds);
  }
  for (const path of windowFiles)
    if (matchesAny(DELIVERY_PATHS, path))
      censusKinds.set(path, [
        ...(censusKinds.get(path) ?? []),
        "delivery path",
      ]);
  const censusFiles = [...censusKinds.keys()].sort();
  for (const { boundary, files } of byBoundary(censusFiles))
    addSlices("census", 2, files, (sliceFiles) => ({
      ...boundaryExtra(boundary),
      kinds: Object.fromEntries(
        sliceFiles.map((path) => [path, censusKinds.get(path)]),
      ),
    }));

  // 3. Hot files.
  const readSha =
    previousRecord?.sha == null ? null : resolveCommit(git, previousRecord.sha);
  const previouslyRead = [...(previousRecord?.filesReadWhole ?? [])].filter(
    (path) => trackedSet.has(path),
  );
  const changedSinceRead = new Set(
    readSha === null || previouslyRead.length === 0
      ? []
      : git
          .text([
            "--literal-pathspecs",
            "diff",
            "--name-only",
            "--no-renames",
            readSha,
            sha,
            "--",
            ...previouslyRead,
          ])
          .split("\n")
          .filter(Boolean),
  );
  const unchangedSinceRead = new Set(
    readSha === null
      ? []
      : previouslyRead.filter((path) => !changedSinceRead.has(path)),
  );
  const hotCandidates = new Map();
  const skippedHotFiles = [];
  for (const path of windowFiles) {
    if (!isSourcePath(path)) continue;
    if (unchangedSinceRead.has(path)) skippedHotFiles.push(path);
    else hotCandidates.set(path, prCounts.get(path));
  }
  ensureLines([...hotCandidates.keys()]);
  const hot = fitHotThreshold(hotCandidates, lineOf, hotLineTarget);
  addSlices("hot", 4, hot.files, { boundary: null, specs: [], assets: null });
  const censusSet = new Set(censusFiles);
  const hotOnBoundary = hot.files.filter(
    (path) => boundaryOf(path) !== null && !censusSet.has(path),
  );
  for (const { boundary, files } of byBoundary(hotOnBoundary))
    addSlices("hot", 2, files, boundaryExtra(boundary));

  // 4. Outward text.
  const governance = tracked.filter((path) =>
    matchesAny(GOVERNANCE_DOCS, path),
  );
  const governanceTouched = windowFiles.some((path) =>
    matchesAny(GOVERNANCE_DOCS, path),
  );
  // The agent instructions are lens 4's ground (L4-instructions), not outward text.
  const outwardDocs = [
    ...new Set([
      ...windowFiles.filter(
        (path) =>
          path.endsWith(".md") &&
          !path.startsWith("docs/spec/") &&
          !path.startsWith(".claude/") &&
          path !== "CLAUDE.md",
      ),
      ...(governanceTouched ? governance : []),
    ]),
  ];
  if (outwardDocs.length > 0)
    addSlices("outward", 3, outwardDocs, { kind: "docs" });
  const userStrings = userStringCandidates.flatMap((path) =>
    (added.get(path) ?? [])
      .filter(({ text }) => USER_STRING_PATTERN.test(text))
      .map(({ line, text }) => ({ path, line, text: text.trim() })),
  );
  if (userStrings.length > 0)
    addSlices(
      "outward",
      3,
      [...new Set(userStrings.map(({ path }) => path))],
      (sliceFiles) => ({
        kind: "user-visible strings",
        strings: userStrings.filter(({ path }) => sliceFiles.includes(path)),
      }),
      matchedSize(userStrings),
    );

  // 5. Stale spec statements.
  const statements = specStatements(
    git,
    sha,
    [...new Set([...hot.files, ...censusFiles])],
    tracked,
  );
  const specFiles = [...new Set(statements.map(({ path }) => path))];
  if (specFiles.length > 0) {
    const wantedNames = new Map();
    for (const { code } of statements)
      for (const [path, named] of Object.entries(code)) {
        if (!wantedNames.has(path)) wantedNames.set(path, new Set());
        for (const name of named) wantedNames.get(path).add(name);
      }
    ensureLines([...wantedNames.keys()]);
    const occurrences = new Map();
    for (const [path, blob] of git.blobs(sha, [...wantedNames.keys()])) {
      const found = new Map();
      blob
        .toString("utf8")
        .split("\n")
        .forEach((text, index) => {
          for (const word of new Set(text.match(/[\w$]+/g) ?? []))
            if (wantedNames.get(path).has(word)) {
              if (!found.has(word)) found.set(word, []);
              found.get(word).push(index + 1);
            }
        });
      occurrences.set(path, found);
    }
    const linesNamed = (path, named) =>
      named.flatMap((name) => occurrences.get(path).get(name) ?? []);
    const stemOnlyPaths = new Set(
      statements.flatMap(({ code }) =>
        Object.entries(code)
          .filter(([path, named]) => linesNamed(path, named).length === 0)
          .map(([path]) => path),
      ),
    );
    const hunks = changedHunks(git, prevSha, sha, [...stemOnlyPaths]);
    const changedRanges = (path) => {
      const fileLines = lineOf(path);
      const own = hunks.get(path) ?? [];
      if (own.length === 0) return fileLines > 0 ? [[1, fileLines]] : [];
      return widenRanges(own, fileLines, matchContextLines);
    };
    const codeRegionsOf = (subset) => {
      const linesByPath = new Map();
      const stemOnlyBy = new Set();
      for (const { code } of subset)
        for (const [path, named] of Object.entries(code)) {
          if (!linesByPath.has(path)) linesByPath.set(path, new Set());
          const lines = linesNamed(path, named);
          if (lines.length === 0) stemOnlyBy.add(path);
          for (const line of lines) linesByPath.get(path).add(line);
        }
      const regions = new Map();
      for (const [path, lines] of [...linesByPath].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        const ranges = mergeRanges([
          ...selectedRanges([...lines], lineOf(path), matchContextLines),
          ...(stemOnlyBy.has(path) ? changedRanges(path) : []),
        ]);
        if (ranges.length > 0) regions.set(path, ranges);
      }
      return regions;
    };
    const staleSize = (subset) => {
      const specSize = matchedSize(subset);
      let total = 0;
      for (const path of new Set(subset.map((s) => s.path)))
        total += specSize(path);
      for (const ranges of codeRegionsOf(subset).values())
        for (const [from, to] of ranges) total += to - from + 1;
      return total;
    };
    addSlices(
      "stale-spec",
      1,
      specFiles,
      (sliceFiles, piece) => {
        const subset =
          piece.statements ??
          statements.filter(({ path }) => sliceFiles.includes(path));
        const regions = codeRegionsOf(subset);
        return {
          files: [...sliceFiles, ...regions.keys()],
          regions: Object.fromEntries(regions),
          statements: subset,
        };
      },
      lineOf,
      (group) =>
        staleSize(statements.filter(({ path }) => group.includes(path))),
      (pieces) =>
        pieces.flatMap((piece) => {
          if (piece.lines <= maxSliceLines || piece.files.length !== 1)
            return [piece];
          const groups = [];
          let current = [];
          for (const statement of statements.filter(
            ({ path }) => path === piece.files[0],
          )) {
            if (
              current.length > 0 &&
              staleSize([...current, statement]) > maxSliceLines
            ) {
              groups.push(current);
              current = [];
            }
            current.push(statement);
          }
          groups.push(current);
          if (groups.length === 1) return [piece];
          return groups.map((group, index) => ({
            files: piece.files,
            lines: staleSize(group),
            statements: group,
            part: index + 1,
          }));
        }),
    );
  }

  // 6. Rotation.
  const lastRead = new Map();
  for (const day of days) {
    const record = dayRecord(day);
    for (const path of record?.filesReadWhole ?? [])
      lastRead.set(path, basename(day));
  }
  const covered = new Set(
    slices
      .filter(
        (slice) =>
          slice.strings === undefined && slice.statements === undefined,
      )
      .flatMap((slice) => slice.files),
  );
  const rotationByDirectory = new Map();
  for (const path of tracked) {
    if (!isSourcePath(path) || covered.has(path)) continue;
    const directory = dirname(path);
    if (!rotationByDirectory.has(directory))
      rotationByDirectory.set(directory, []);
    rotationByDirectory.get(directory).push(path);
  }
  const readOf = (path) => lastRead.get(path) ?? "";
  const directoryRead = (directory) =>
    rotationByDirectory.get(directory).map(readOf).sort()[0];
  const rotationDirectory = [...rotationByDirectory.keys()].sort(
    (a, b) =>
      directoryRead(a).localeCompare(directoryRead(b)) || a.localeCompare(b),
  )[0];
  if (rotationDirectory !== undefined) {
    const candidates = rotationByDirectory
      .get(rotationDirectory)
      .sort((a, b) => readOf(a).localeCompare(readOf(b)) || a.localeCompare(b));
    ensureLines(candidates);
    const picked = [];
    let lines = 0;
    for (const path of candidates) {
      if (picked.length > 0 && lines + lineOf(path) > maxSliceLines) break;
      picked.push(path);
      lines += lineOf(path);
    }
    const boundary =
      picked.map(boundaryOf).find((found) => found !== null) ?? null;
    addSlices("rotation", boundary === null ? 4 : 2, picked, {
      ...boundaryExtra(boundary),
      directory: rotationDirectory,
      lastWholeRead: directoryRead(rotationDirectory) || null,
    });
  }

  assertSliceBound(slices, maxSliceLines);

  const prior = days
    .map((day) => join(day, "FINAL", "ledger.jsonl"))
    .filter((path) => existsSync(path));
  const totalEstimate =
    Math.round(
      slices.reduce((sum, slice) => sum + slice.estimatedCost, 0) * 100,
    ) / 100;
  return {
    day: basename(resolve(dayDir)),
    sha,
    prevSha,
    previousDay,
    skippedDays,
    owedNote,
    window: { from: prevSha, to: sha, commits },
    hotThreshold: hot.threshold,
    hotLines: hot.lines,
    workingValues,
    prior,
    slices,
    carried: carried.map(({ line, lens, target, reason, blockedBy, why }) => ({
      line,
      lens,
      target,
      reason,
      blockedBy,
      why,
    })),
    skippedHotFiles,
    totalEstimate,
  };
}

const money = (value) => `$${value.toFixed(2)}`;

/** The plan as the day's SLICES.md. */
export function renderSlices(plan) {
  const { workingValues: values } = plan;
  const out = [
    `# Review-day slices for ${plan.day}`,
    "",
    `Pinned sha: ${plan.sha}.`,
    `Window: ${plan.prevSha}..${plan.sha}, ${plan.window.commits} first-parent commits.`,
    `Previous day: ${plan.previousDay ?? "none"}.`,
    ...plan.skippedDays.map(
      (day) => `Not the previous day: ${day}, which has no FINAL/ directory.`,
    ),
    ...(plan.owedNote === null ? [] : [plan.owedNote]),
    plan.hotThreshold === null
      ? "Hot files: none in the window."
      : `Hot files: touched by ${plan.hotThreshold} or more pull requests, ${plan.hotLines} lines (target ${values.hotLineTarget}).`,
    `Working values, fitted from the 2026-11-06 review pass and re-fitted at each retro: at most ${values.maxSliceLines} lines a slice; a user-string or stale-spec slice counts ${values.matchContextLines} lines either side of each match; a slice costs ${[1, 2, 3, 4].map((lens) => `${money(values.unitCosts[lens])} at lens ${lens}`).join(", ")}.`,
    `Estimated total: ${money(plan.totalEstimate)} over ${plan.slices.length} slices.`,
    "",
    "Paths are relative to the repository root; read each at the pinned sha (`git show <sha>:<path>`).",
  ];
  for (const slice of plan.slices) {
    out.push(
      "",
      `## ${slice.id}: ${slice.selector}, lens ${slice.lens}`,
      "",
      `- Lines: ${slice.lines}. Estimate: ${money(slice.estimatedCost)}.`,
    );
    if (slice.owedLine !== undefined)
      out.push(`- Owed pass: ${slice.target} -- ${slice.reason}`);
    if (slice.directory !== undefined)
      out.push(
        `- Rotation: ${slice.directory}, last read whole ${slice.lastWholeRead ?? "never"}.`,
      );
    if (slice.kind !== undefined) out.push(`- Text: ${slice.kind}.`);
    out.push(slice.files.length === 0 ? "- Paths: none resolved." : "- Paths:");
    for (const path of slice.files) {
      const ranges = slice.regions?.[path];
      out.push(
        `  - ${path}${slice.kinds?.[path] ? ` (${slice.kinds[path].join(", ")})` : ""}${ranges ? `: lines ${ranges.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join(", ")}` : ""}`,
      );
    }
    if (slice.statements !== undefined) {
      out.push("- Statements:");
      const byPath = new Map();
      for (const { path, line, names } of slice.statements) {
        if (!byPath.has(path)) byPath.set(path, []);
        byPath.get(path).push(`${line} (${names.join(", ")})`);
      }
      for (const [path, lines] of byPath)
        out.push(`  - ${path}: ${lines.join("; ")}`);
    }
    if (slice.strings !== undefined) {
      out.push("- Strings:");
      for (const { path, line, text } of slice.strings)
        out.push(`  - ${path}:${line}: ${text}`);
    }
    if (slice.specs?.length > 0) out.push(`- Specs: ${slice.specs.join(", ")}`);
    if (slice.assets) out.push(`- Assets: ${slice.assets}`);
    out.push(
      `- Prior: ${plan.prior.length === 0 ? "none" : plan.prior.join(", ")}`,
    );
  }
  if (plan.carried.length > 0) {
    out.push("", "## Carried over", "");
    for (const pass of plan.carried) out.push(`- ${pass.line} (${pass.why})`);
  }
  if (plan.skippedHotFiles.length > 0) {
    out.push(
      "",
      "## Hot-file candidates skipped: read whole by the previous day, unchanged since",
      "",
    );
    for (const path of plan.skippedHotFiles) out.push(`- ${path}`);
  }
  return `${out.join("\n")}\n`;
}

/** Write the plan's SLICES.md and plan.json into `dayDir`. */
export function writeDay(plan, dayDir) {
  mkdirSync(dayDir, { recursive: true });
  writeFileSync(join(dayDir, "SLICES.md"), renderSlices(plan));
  writeFileSync(
    join(dayDir, "plan.json"),
    `${JSON.stringify(plan, null, 2)}\n`,
  );
}

const USAGE =
  "Usage: node .claude/scripts/review-day-slices.mjs <sha> <dayDir> [--prev <sha>]\n" +
  "Writes <dayDir>/SLICES.md and <dayDir>/plan.json for the review day pinned at <sha>,\n" +
  "and prints the total cost estimate. The previous day is the newest directory beside\n" +
  "<dayDir> whose name sorts before it and that holds FINAL/; its FINAL/owed.md lists\n" +
  "the owed passes and its FINAL/record.json the window's start, which --prev <sha>\n" +
  "overrides. Refs resolve in the git worktree this is run from.\n";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const prevAt = args.indexOf("--prev");
  const prevSha = prevAt === -1 ? null : args[prevAt + 1];
  const positional =
    prevAt === -1
      ? args
      : args.filter((_, i) => i !== prevAt && i !== prevAt + 1);
  if (
    positional.length !== 2 ||
    positional.some((arg) => arg.startsWith("--")) ||
    (prevAt !== -1 && (prevSha === undefined || prevSha.startsWith("--")))
  ) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const [sha, dayDir] = positional;
  try {
    const plan = planDay({ sha, dayDir, prevSha });
    writeDay(plan, dayDir);
    process.stdout.write(
      plan.skippedDays
        .map(
          (day) =>
            `not the previous day: ${day}, which has no FINAL/ directory\n`,
        )
        .join("") +
        (plan.owedNote === null ? "" : `${plan.owedNote}\n`) +
        `wrote ${join(dayDir, "SLICES.md")} and ${join(dayDir, "plan.json")}\n` +
        `${plan.slices.length} slices, ${plan.carried.length} owed passes carried over\n` +
        `estimated total: ${money(plan.totalEstimate)}\n`,
    );
    process.exit(0);
  } catch (error) {
    process.stderr.write(`error: ${error.message ?? error}\n`);
    process.exit(error instanceof SliceOverSizeError ? 1 : 2);
  }
}
