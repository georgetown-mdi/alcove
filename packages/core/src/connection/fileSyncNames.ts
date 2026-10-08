// Filename grammar for the file-sync wire protocol: pure predicates and name
// builders for the files the `sftp` and `filedrop` channels exchange, kept in one
// place so enforcement sites cannot diverge. The grammar: docs/EXCHANGE_REFERENCE.md
// (Filename grammar); the state machine that consumes it: docs/spec/FILE_SYNC.md.

import {
  v4 as uuidv4,
  validate as uuidValidate,
  version as uuidVersion,
} from "uuid";

export const HELLO_SUFFIX = "-hello.json";

// The lock-mode tiebreaker, `<peer1>-<peer2>-lock.json`. Its terminal segment is
// the type word `lock`, not digits, so the message scan excludes it.
export const LOCK_SUFFIX = "-lock.json";

// The lock-path joiner-arrival sentinel, `<id>-joining.json`, which lets the peer
// tell a joiner mid-arrival from a crashed one (docs/spec/FILE_SYNC.md, Phase 1 --
// rendezvous, lock path). Its type word `joining` keeps it out of the message scan.
export const JOINING_SUFFIX = "-joining.json";

// The authenticated cross-party abort marker, `<writerId>-abort.json`. Its type
// word `abort` is not all digits, so it is never consumed as a message.
export const ABORT_SUFFIX = "-abort.json";

// The declared byte count of a message filename: the last `-` segment before
// `.json`, parsed right-anchored so an id containing hyphens cannot corrupt it.
// Undefined when the name has no `-` or that segment is not a non-negative integer.
/** @internal */
export const parseMessageByteCount = (name: string): number | undefined => {
  const stem = name.slice(0, -".json".length);
  const lastDash = stem.lastIndexOf("-");
  if (lastDash < 0) return undefined;
  const lastSegment = stem.slice(lastDash + 1);
  if (!/^\d+$/.test(lastSegment)) return undefined;
  return Number(lastSegment);
};

// The NNN sequence counter of a timestamped message filename
// (`<id>-<ts>-<NNN>-<byteCount>.json`), parsed right-anchored. Only meaningful
// for a timestamped name (retain mode): on any other name the segment is part of
// the id and the result is wrong, not undefined, and nothing guards it at runtime;
// fileSyncNames.test.ts holds its one caller to retain mode.
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

// The peer id of a `<id><suffix>` hello or joining sentinel, or undefined when
// the name lacks the suffix or the id is empty. A bare `-hello.json` is never a
// peer identity: adopting "" would let any writer on an unauthenticated transport
// stall rendezvous (docs/spec/FILE_SYNC.md, The five enforcement sites, site 5).
/** @internal */
export const peerIdFromControlName = (
  name: string,
  suffix: string,
): string | undefined => {
  if (!name.endsWith(suffix)) return undefined;
  const id = name.slice(0, -suffix.length);
  return id.length > 0 ? id : undefined;
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

// The in-flight temp name of a rendezvous hello publish,
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
 * True for any `<id>-abort.json` under any id, so the entry guard sweeps a
 * leftover marker rather than refusing it as foreign. Every name
 * {@link isExpectedAbortName} accepts also matches. A bare `-abort.json` matches
 * too but is never swept, so it fails closed as an unexpected protocol file.
 */
export const isAbortMarkerName = (name: string): boolean =>
  name.endsWith(ABORT_SUFFIX);

/**
 * True only for this party's or the peer's abort marker. The poll loop tolerates
 * these two by exact name, so a planted `<other>-abort.json` still meets the
 * unexpected-files policy.
 */
export const isExpectedAbortName = (
  name: string,
  selfId: string,
  peerId: string,
): boolean =>
  name === `${selfId}${ABORT_SUFFIX}` || name === `${peerId}${ABORT_SUFFIX}`;

// The single inverse of "foreign" the entry guard and the foreign-file snapshot
// share, so no name is both. A message-shaped `<id>-<digits>.json` is a protocol
// file: refused at the no-flag entry guard, swept under --sweep-exchange-files.
/** Whether a filename is in the exchange's protocol filename grammar rather than
 * foreign; the console's start-of-run preflight shares this classification. */
export const isProtocolGrammarName = (name: string): boolean => {
  if (isProtocolTempName(name)) return true;
  if (!name.endsWith(".json")) return false;
  if (
    name.endsWith(HELLO_SUFFIX) ||
    name.endsWith(LOCK_SUFFIX) ||
    name.endsWith(JOINING_SUFFIX) ||
    isAbortMarkerName(name) ||
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
