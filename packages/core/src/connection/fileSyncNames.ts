// Filename grammar for the file-sync wire protocol: pure predicates and name
// builders for the files the `sftp` and `filedrop` channels exchange, kept in one
// place so enforcement sites cannot diverge. The grammar: docs/EXCHANGE_REFERENCE.md
// (Filename grammar); the state machine that consumes it: docs/spec/FILE_SYNC.md.

import {
  v4 as uuidv4,
  validate as uuidValidate,
  version as uuidVersion,
} from "uuid";

// The lock-mode tiebreaker, `<peer1>-<peer2>-lock.json`. Zero-length; its
// terminal segment is the type word `lock`, not digits, so the message scan
// excludes it.
export const LOCK_SUFFIX = "-lock.json";

/**
 * The control files that have a body, each named
 * `<id>-<type>-<byteCount>.json`: the rendezvous hello, the lock-path
 * joiner-arrival sentinel (docs/spec/FILE_SYNC.md, Phase 1 -- rendezvous, lock
 * path), and the authenticated cross-party abort marker.
 */
export type SizedControlType = "hello" | "joining" | "abort";

const SIZED_CONTROL_TYPES: ReadonlySet<string> = new Set<SizedControlType>([
  "hello",
  "joining",
  "abort",
]);

// The declared byte count of a size-terminal filename: the last `-` segment
// before `.json`, parsed right-anchored so an id containing hyphens cannot
// corrupt it. Undefined when the name has no `-` or that segment is not a
// non-negative integer. True of a message and of a sized control file alike;
// isMessageName tells the two apart.
/** @internal */
export const parseMessageByteCount = (name: string): number | undefined => {
  const stem = name.slice(0, -".json".length);
  const lastDash = stem.lastIndexOf("-");
  if (lastDash < 0) return undefined;
  const lastSegment = stem.slice(lastDash + 1);
  if (!/^\d+$/.test(lastSegment)) return undefined;
  return Number(lastSegment);
};

/** @internal */
export const sizedControlName = (
  id: string,
  type: SizedControlType,
  byteCount: number,
): string => `${id}-${type}-${byteCount}.json`;

// The writer id, type and declared byte count of a sized control name, or
// undefined for any other name. The id may be empty (a bare `-hello-48.json`);
// peerIdFromControlName refuses that.
/** @internal */
export const parseSizedControlName = (
  name: string,
): { id: string; type: SizedControlType; byteCount: number } | undefined => {
  if (!name.endsWith(".json")) return undefined;
  const byteCount = parseMessageByteCount(name);
  if (byteCount === undefined) return undefined;
  const stem = name.slice(0, -".json".length);
  const head = stem.slice(0, stem.lastIndexOf("-"));
  const typeDash = head.lastIndexOf("-");
  if (typeDash < 0) return undefined;
  const type = head.slice(typeDash + 1);
  if (!SIZED_CONTROL_TYPES.has(type)) return undefined;
  return {
    id: head.slice(0, typeDash),
    type: type as SizedControlType,
    byteCount,
  };
};

/**
 * True for a message name: a size-terminal `.json` name whose segment before
 * the byte count is not a sized control type word. A message name built from
 * a UUID id, or with a timestamp and counter, never has one there.
 *
 * @internal
 */
export const isMessageName = (name: string): boolean =>
  name.endsWith(".json") &&
  parseMessageByteCount(name) !== undefined &&
  parseSizedControlName(name) === undefined;

// The NNN sequence counter of a timestamped message filename
// (`<id>-<ts>-<NNN>-<byteCount>.json`), parsed right-anchored. Only meaningful
// for a timestamped name (retain mode): on any other name the segment is part of
// the id and the result is wrong, not undefined, and nothing guards it at runtime;
// the "is not read outside retain mode" test in fileSyncMessageLoop.test.ts holds its one caller to retain mode.
/** @internal */
export const parseTimestampedMessageNNN = (
  name: string,
): number | undefined => {
  const stem = name.slice(0, -".json".length);
  const withoutByteCount = stem.slice(0, stem.lastIndexOf("-"));
  const nnnStr = withoutByteCount.slice(withoutByteCount.lastIndexOf("-") + 1);
  if (!/^\d+$/.test(nnnStr)) return undefined;
  return Number(nnnStr);
};

// The acknowledgment marker for `<originalName>.json`:
// `<writerId>-<originalName>-ack.json`, used where a transport cannot delete.
// Construct-and-match only: ids may contain `-`, so the name is never parsed back
// into its ids; both ends already know the acknowledged file's exact name.
/** @internal */
export const ackMarkerName = (writerId: string, originalName: string): string =>
  `${writerId}-${originalName}-ack.json`;

// The writer id of a `<id>-<type>-<byteCount>.json` control file, or undefined
// when the name is not of that type or the id is empty. A bare `-hello-48.json`
// is never a peer identity: adopting "" would let any writer on an
// unauthenticated transport stall rendezvous (docs/spec/FILE_SYNC.md, The five
// enforcement sites, site 5).
/** @internal */
export const peerIdFromControlName = (
  name: string,
  type: SizedControlType,
): string | undefined => {
  const parsed = parseSizedControlName(name);
  if (parsed === undefined || parsed.type !== type) return undefined;
  return parsed.id.length > 0 ? parsed.id : undefined;
};

/**
 * The two hello names rendezvous agreed on: this party's own and the peer's it
 * read. The poll loop recognizes these, and the joining sentinels and hello
 * acks named after them, by exact name.
 */
export interface AgreedHelloNames {
  self: string;
  peer: string;
}

// The joining sentinel paired with a hello: same writer, same byte count, since
// the sentinel holds the hello body. Undefined for a name that is not a hello.
/** @internal */
export const joiningNameForHello = (helloName: string): string | undefined => {
  const parsed = parseSizedControlName(helloName);
  if (parsed === undefined || parsed.type !== "hello") return undefined;
  return sizedControlName(parsed.id, "joining", parsed.byteCount);
};

const TEMP_PREFIX = "temp-";

// A hello temp keeps the `temp-` prefix, so it is still a protocol temp, but the
// entry sweep can tell it apart and spare it (docs/spec/FILE_SYNC.md, Hello temp
// disposition).
const HELLO_TEMP_PREFIX = "temp-hello-";

// Only the lowercase v4 UUID uuidv4() emits: the uuid package's validate() is
// case-insensitive, and an uppercase foreign temp must not be swept.
// uuidVersion() throws on a non-UUID, so uuidValidate() must run first.
const isUuidV4Stem = (stem: string): boolean => {
  if (stem !== stem.toLowerCase()) return false;
  return uuidValidate(stem) && uuidVersion(stem) === 4;
};

// The in-flight temp name of a rendezvous hello write,
// `temp-hello-<uuidv4()>.tmp`; the only producer of what isHelloTempName matches.
/** @internal */
export const helloTempName = (): string =>
  `${HELLO_TEMP_PREFIX}${uuidv4()}.tmp`;

// True only for the shape helloTempName builds. The entry sweep spares it: a peer
// starting at the same instant may have one in flight, and deleting it would break
// that peer's rename (docs/spec/FILE_SYNC.md, Hello temp disposition).
/** @internal */
export const isHelloTempName = (name: string): boolean =>
  name.startsWith(HELLO_TEMP_PREFIX) &&
  name.endsWith(".tmp") &&
  isUuidV4Stem(name.slice(HELLO_TEMP_PREFIX.length, -".tmp".length));

/**
 * True only for the protocol's own in-flight temp files, `temp-<uuidv4()>.tmp`
 * and `temp-hello-<uuidv4()>.tmp`. Any other `temp-*.tmp` is foreign and is
 * tolerated, not swept. Public so a `FileTransportClient` can tell its own
 * in-flight write apart: the CLI's SFTP adapter re-issues a deferred cleanup
 * delete only for this shape, whose per-file UUID keeps it on the one file.
 */
export const isProtocolTempName = (name: string): boolean => {
  if (isHelloTempName(name)) return true;
  if (!name.startsWith(TEMP_PREFIX) || !name.endsWith(".tmp")) return false;
  return isUuidV4Stem(name.slice(TEMP_PREFIX.length, -".tmp".length));
};

/**
 * True for any `<id>-abort-<byteCount>.json` under any id, so the entry guard
 * sweeps a leftover marker rather than refusing it as foreign. Every name the
 * poll loop expects as an abort marker (`isExpectedAbortName` in
 * abortMarker.ts) also matches. A bare `-abort-<n>.json` matches too but is
 * never swept, so it fails closed as an unexpected protocol file.
 */
export const isAbortMarkerName = (name: string): boolean =>
  parseSizedControlName(name)?.type === "abort";

// The single inverse of "foreign" the entry guard and the foreign-file snapshot
// share, so no name is both. A message-shaped `<id>-<digits>.json` is a protocol
// file: refused at the no-flag entry guard, swept under --sweep-exchange-files.
/** Whether a filename is in the exchange's protocol filename grammar rather than
 * foreign; the console's start-of-run preflight shares this classification. */
export const isProtocolGrammarName = (name: string): boolean => {
  if (isProtocolTempName(name)) return true;
  if (!name.endsWith(".json")) return false;
  if (
    name.endsWith(LOCK_SUFFIX) ||
    // Broad by design: a foreign name ending -ack.json is refused or swept as a
    // protocol file rather than tolerated, so no ack-shaped name slips past.
    name.endsWith("-ack.json")
  )
    return true;
  return parseMessageByteCount(name) !== undefined;
};

// True for a name shaped like a retain-mode message ack, whose two trailing
// segments (NNN and byte count) are both digits. A heuristic: a contrived foreign
// name can match, which only refuses a sweep the operator clears with
// --force-retain-sweep; the peer hello's retain_files flag is the authoritative
// signal (docs/spec/FILE_SYNC.md, Invariants, I0).
/** @internal */
export const isRetainMessageAck = (name: string): boolean => {
  if (!name.endsWith("-ack.json")) return false;
  // split, not lastIndexOf arithmetic, which mis-slices a single segment ("100").
  const segments = name.slice(0, -"-ack.json".length).split("-");
  if (segments.length < 2) return false;
  const nnn = segments[segments.length - 2];
  const byteCount = segments[segments.length - 1];
  return /^\d+$/.test(nnn) && /^\d+$/.test(byteCount);
};
