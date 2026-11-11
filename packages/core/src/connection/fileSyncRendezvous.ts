// Rendezvous for the file-sync wire protocol.
//
// The module holds two things: pure rendezvous helpers (the hello payload
// builder, the bilateral-mode-mismatch comparison, the peer control-file
// name recognizers, and the partial-sync-gated control-file read) and the
// FileSyncRendezvous coordinator, the stateful negotiation (entry-directory
// scan and sweep, lock-joiner fast-path, and the symmetric hello-exchange).
// The coordinator reads the connection's identity/config through
// RendezvousDeps accessors and writes role/peerId/handshakeRole back
// through its setters, mutating the connection's
// responsibleFiles/foreignFileSnapshot Sets by shared reference.
//
// FileSyncConnection's public synchronize() entry calls
// validateSynchronizeEntry() then rendezvous.run(scope).
//
// The protocol itself -- wire names, ordering, lock-vs-lockless
// negotiation, bilateral-mismatch and joiner-recovery guarantees -- is
// specified in docs/spec/FILE_SYNC.md and docs/spec/CHANNEL_SECURITY.md.

import * as z from "zod";
import { NIL as NIL_UUID } from "uuid";

import {
  clipToRenderedCost,
  renderedDisplayCost,
  DEFAULT_MAX_DISPLAY_LENGTH,
} from "../utils/sanitizeForDisplay";
import {
  keepFirstPartyLineBreaks,
  redactAndSanitizeForDisplay,
  redactPrivateKeyMaterial,
} from "../utils/sanitizeErrorForDisplay";
import {
  parseBoundedJson,
  JsonStructureBoundError,
} from "../utils/boundedJson";
import type { getLoggerForVerbosity } from "../utils/logger";
import type { HandshakeRole } from "../types";
import {
  UsageError,
  BilateralModeMismatchError,
  FrameSizeExceededError,
  PartnerProtocolRefusalError,
  TransportWriteIndeterminateError,
  chainDetailCauses,
  markPeerWaitTimeout,
  markStatesItsOwnNextStep,
  errorMessage,
} from "../errors";
import {
  failureCauseError,
  failureCauseSentence,
  formatFileAge,
  formatWaitDuration,
  markFailureCause,
  type FailureCause,
} from "../failureCause";
import {
  IGNORE_FILES_OLDER_THAN_INFINITE,
  IGNORE_FILES_OLDER_THAN_KEY,
} from "../config/connection";
import { classifyRetainLeftovers } from "./fileSyncLeftovers";
import {
  ADVERTISE_HELLO_RETRY_ATTEMPTS,
  cancellableDelay,
} from "./fileSyncConstants";
import { MAX_FRAME_SIZE_BYTES } from "./frameSize";
import { joinFileSyncPath } from "./fileSyncPath";
import { renameOwnTemp } from "./fileSyncWrite";
import {
  getUpToNamedCount,
  largerThanNamedCountMessage,
} from "./namedCountRead";
import {
  LOCK_SUFFIX,
  ackMarkerName,
  parseSizedControlName,
  peerIdFromControlName,
  sizedControlName,
  type SizedControlType,
  type AgreedHelloNames,
  helloTempName,
  isHelloTempName,
  isProtocolTempName,
  isProtocolGrammarName,
  isRetainMessageAck,
} from "./fileSyncNames";
import { MAX_MESSAGE_SEQ, messageFilename } from "./fileSyncMessageLoop";
import {
  HELLO_VERSIONS_WHEN_ABSENT,
  HelloEnvelopeSchema,
  serializeEnvelope,
  type HelloEnvelope,
  type HelloVersions,
} from "./controlEnvelope";
import { selectLayerVersion } from "../versionHello";
import type { FileInfo, FileTransportClient } from "./fileSyncConnection";

// The path/display scope a synchronize() call computes once at entry (from
// this.path/this.outbound) and threads through its phase methods, so no
// phase re-derives it. `inboundPath` is where this party reads the peer's
// files; `outboundPath` is where it writes its own (equal in shared mode);
// `split` is true only with a separate outbound directory; `dirsDisplay` is
// the operator-facing scope naming both halves in split mode.
/** @internal */
export interface RendezvousScope {
  inboundPath: string;
  outboundPath: string;
  split: boolean;
  dirsDisplay: string;
}

/**
 * Composes the operator-facing directory scope, redacting each path where
 * it is interpolated rather than the composed result: redacting the
 * composite would let a marker in the inbound path consume the split-mode
 * labels and the outbound path under the fail-closed dangling rule (see
 * {@link redactPrivateKeyMaterial}). Every production producer of a
 * {@link RendezvousScope}'s `dirsDisplay` goes through here -- a
 * convention, not a guarantee, since `dirsDisplay` is a plain string.
 *
 * @internal
 */
export function composeDirsDisplay(
  inboundPath: string,
  outboundPath: string | undefined,
): string {
  const inbound = redactPrivateKeyMaterial(inboundPath);
  return outboundPath === undefined
    ? inbound
    : `${inbound} (inbound) and ` +
        `${redactPrivateKeyMaterial(outboundPath)} (outbound)`;
}

// What a caller of the read gate knows about the hello it is asking for: whether
// it was in the directory when this run scanned it, or appeared afterwards. The
// same distinction the bounded ack window is armed on, and for the same reason:
// the entry-present hello is the only one an interrupted run in this directory
// can have left behind, so it is the only one an operator-facing message may
// attribute to residue.
/** @internal */
type PeerHelloProvenance = "presentAtEntry" | "appearedAfterEntry";

// Cap on a hello read: the envelope is under 100 bytes, and the gate may
// re-read the file every poll cycle until its deadline, so the frame cap
// would be far too generous for it. Applied to the listed size before any
// get() and as the get() byte cap.
/** @internal */
export const HELLO_MAX_BYTES = 1024;

// A fully read hello whose body is not a valid hello. Typed so the forced
// pre-sweep inspection can tell it from a stalled read, which stays terminal.
class MalformedHelloError extends UsageError {}

// Why the pre-sweep inspection could not read a peer hello, for the forced
// sweep's warning; undefined for any error the force flag does not clear.
const unreadableHelloReason = (err: unknown): string | undefined => {
  if (err instanceof FrameSizeExceededError)
    return `it is larger than the ${HELLO_MAX_BYTES}-byte limit for a hello`;
  if (err instanceof MalformedHelloError)
    return "its contents are not a valid hello";
  return undefined;
};

// The unforced refusal's next step for a peer hello the force flag clears.
const FORCE_RETAIN_SWEEP_STEP =
  "A peer hello could not be read, so retain mode cannot be ruled out and " +
  "--sweep-exchange-files will not delete anything. If no other exchange " +
  "uses this folder, re-run with --force-retain-sweep to delete this " +
  "exchange's files in it, including any retained transcript.";

// Chains the step as a cause link of its own, so the display cap on a link
// holding partner-chosen text cannot cut it: behind the class's own next step
// (its first cause link) and ahead of every detail fragment.
const chainForceRetainSweepStep = (err: UsageError): void => {
  if (err instanceof FrameSizeExceededError && err.cause instanceof Error) {
    err.cause.cause = chainDetailCauses(
      [FORCE_RETAIN_SWEEP_STEP],
      err.cause.cause,
    );
    return;
  }
  err.cause = chainDetailCauses([FORCE_RETAIN_SWEEP_STEP], err.cause);
  markStatesItsOwnNextStep(err);
};

// The hello read gate (docs/spec/FILE_SYNC.md, Invariants, I5a and I5b):
// refuses on the name and the listed size before any read, retries a
// transient get() failure or a short body until timeToLive, and refuses
// every other fault terminally, since retrying would let a hostile server
// hold the gate open until the deadline. It validates the body only; the
// peer id comes from the name.
/** @internal */
export async function readControlFileWithGate(
  client: FileTransportClient,
  filePath: string,
  listedSize: number,
  timeToLive: Date,
  pollingFrequency: number,
  schema: z.ZodType<HelloEnvelope>,
  provenance: PeerHelloProvenance,
  signal: AbortSignal,
): Promise<HelloEnvelope> {
  const declaredSize = parseSizedControlName(
    filePath.slice(filePath.lastIndexOf("/") + 1),
  )?.byteCount;
  if (declaredSize === undefined)
    throw new MalformedHelloError(
      `control file at ${redactPrivateKeyMaterial(filePath)} has no byte ` +
        "count in its name",
    );
  if (declaredSize === 0)
    throw new MalformedHelloError(
      `control file at ${redactPrivateKeyMaterial(filePath)} states 0 bytes ` +
        "in its name, and a hello is never empty",
    );
  if (listedSize > HELLO_MAX_BYTES || declaredSize > HELLO_MAX_BYTES)
    throw new FrameSizeExceededError(
      `a peer hello is listed at ${listedSize} byte(s) and its name states ` +
        `${declaredSize}, exceeding the maximum control file size of ` +
        `${HELLO_MAX_BYTES} bytes; refusing to read it`,
      { details: [`control file: ${redactPrivateKeyMaterial(filePath)}`] },
    );
  const sizeMismatch = (actual: number) =>
    new MalformedHelloError(
      `control file at ${redactPrivateKeyMaterial(filePath)} is ${actual} ` +
        `byte(s), more than the ${declaredSize} its name states`,
    );
  if (listedSize > declaredSize) throw sizeMismatch(listedSize);
  // do-while guarantees at least one read attempt even when timeToLive has
  // already expired by the time the gate is entered (e.g. a slow polling loop
  // that exhausts the budget before reaching this call). Without this a fully-
  // present file would produce a spurious "timed out" error.
  do {
    // Here and after the read, so once close() has aborted no read starts and
    // no step follows one.
    signal.throwIfAborted();
    let raw: Buffer<ArrayBufferLike>;
    try {
      // Bounded by the count the name states, already refused above when
      // over HELLO_MAX_BYTES: a larger body is never buffered past it.
      raw = await getUpToNamedCount(
        client,
        filePath,
        declaredSize,
        "utf-8",
        () =>
          new MalformedHelloError(
            largerThanNamedCountMessage(
              `control file at ${redactPrivateKeyMaterial(filePath)}`,
              declaredSize,
            ),
          ),
      );
    } catch (err) {
      // A typed UsageError from get() (a body past the named count, a
      // stalled read) is terminal: rethrow so
      // synchronize() exits as the typed exit-64 failure instead of being
      // retried, which would let a hostile server hold the gate open every
      // cycle until the deadline. The malformed-payload UsageError thrown
      // below is terminal for the same reason.
      if (err instanceof UsageError) throw err;
      // File may not be readable yet (TOCTOU or partial sync); retry.
      await cancellableDelay(pollingFrequency, signal);
      continue;
    }
    signal.throwIfAborted();
    if (raw.length > declaredSize) throw sizeMismatch(raw.length);
    if (raw.length < declaredSize) {
      // Partial write or sync: not all the declared bytes have arrived yet.
      await cancellableDelay(pollingFrequency, signal);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseBoundedJson(raw.toString());
    } catch (err) {
      // Every declared byte has arrived, so the body is fully formed and
      // retrying cannot make it valid: refused like a message body that fails
      // to parse after its size gate.
      throw new MalformedHelloError(
        `control file at ${redactPrivateKeyMaterial(filePath)} has a ` +
          "malformed payload: " +
          (err instanceof JsonStructureBoundError
            ? "structure exceeds the permitted bound"
            : "it is not valid JSON"),
      );
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new MalformedHelloError(
        `control file at ${redactPrivateKeyMaterial(filePath)} has a ` +
          `malformed payload: ${result.error.message}`,
      );
    }
    return result.data;
  } while (Date.now() <= timeToLive.getTime());
  // A plain Error, not a UsageError, which the pre-sweep inspection would
  // refuse on the bare flag; the text by provenance is in
  // docs/spec/FILE_SYNC.md, Invariants, I5a. The path takes a detail link of
  // its own, so the display cap on a long path never cuts the recovery step.
  throw new Error(
    provenance === "presentAtEntry"
      ? "peer hello never became readable; it predates this run and may be " +
          "left over. Re-run; remove only if it persists and no other " +
          "exchange uses its folder."
      : "peer hello never became readable; it appeared during this run, so a " +
          "peer may still be writing it. Re-run; remove only if it persists.",
    {
      cause: chainDetailCauses([
        `peer hello: ${redactPrivateKeyMaterial(filePath)}`,
      ]),
    },
  );
}

// Builds a party's hello payload: the two bilateral mode flags it advertises
// so the peer can detect a mismatch and fail fast, and the versions a run with
// no key exchange offers. Written into the hello body in both rendezvous
// branches. The hello is the only control file with a body; the lockless ack
// is a zero-length marker with no flags.
/** @internal */
export function helloEnvelope(
  flags: {
    locklessRendezvous: boolean;
    retainFiles: boolean;
  },
  versions?: HelloVersions,
): HelloEnvelope {
  return {
    locklessRendezvous: flags.locklessRendezvous,
    retainFiles: flags.retainFiles,
    ...(versions !== undefined && {
      versions: { protocol: versions.protocol, envelope: versions.envelope },
    }),
  };
}

/** The versions a run with no key exchange selects from the two hellos. */
export interface RendezvousSelectedVersions {
  protocol: number;
  envelope: number;
}

// The version refusals selectRendezvousVersions raised, so the cleanup sites
// leave the refusing party's hello in place, as they do for a
// BilateralModeMismatchError: the peer reaches the same verdict only by
// reading it.
const noCommonVersionRefusals = new WeakSet<Error>();

const VERSION_LAYER_LABELS: Record<keyof HelloVersions, string> = {
  protocol: "protocol",
  envelope: "message envelope",
};

/**
 * Selects, per layer, the highest version both hellos offer, by the
 * key-exchange hello's rule; a peer hello with no `versions` member offers
 * {@link HELLO_VERSIONS_WHEN_ABSENT}. With no version in common in a layer,
 * the refusal names both parties' lists for it. Both parties read both hellos,
 * so both reach the same result.
 *
 * @internal exported for the rendezvous version tests.
 */
export function selectRendezvousVersions(
  own: HelloVersions,
  peer: HelloEnvelope,
):
  | { ok: true; selected: RendezvousSelectedVersions }
  | { ok: false; refusal: PartnerProtocolRefusalError } {
  const offered = peer.versions ?? HELLO_VERSIONS_WHEN_ABSENT;
  const selected: Partial<RendezvousSelectedVersions> = {};
  for (const layer of ["protocol", "envelope"] as const) {
    const selection = selectLayerVersion(own[layer], offered[layer]);
    if (!selection.ok) {
      const refusal = new PartnerProtocolRefusalError(
        "the partner is running an Alcove version this one cannot " +
          `exchange with: this party supports ${VERSION_LAYER_LABELS[layer]} ` +
          `versions ${own[layer].join(", ")} and the partner supports ` +
          `${offered[layer].join(", ")}; the party on the older version ` +
          "must update",
        { olderVersion: selection.olderVersion },
      );
      noCommonVersionRefusals.add(refusal);
      return { ok: false, refusal };
    }
    selected[layer] = selection.version;
  }
  return { ok: true, selected: selected as RendezvousSelectedVersions };
}

// Compares a peer's advertised hello flags against a party's own
// configuration. Returns a BilateralModeMismatchError naming both sides'
// settings for the offending flag, or undefined when both match. Called at
// every site that reads a peer hello.
//
// retain_files is compared first, since it implies lockless_rendezvous: the
// only way both flags differ is retain=true/lockless=true vs
// retain=false/lockless=false, and naming retain_files lets the operator
// realign both in one rerun instead of landing on the invalid
// retain=true/lockless=false state. A lockless-only divergence still
// reports lockless.
/** @internal */
export function bilateralMismatch(
  peer: HelloEnvelope,
  own: { locklessRendezvous: boolean; retainFiles: boolean },
): BilateralModeMismatchError | undefined {
  if (peer.retainFiles !== own.retainFiles)
    return new BilateralModeMismatchError(
      `retain_files mismatch: this party has retain_files=` +
        `${own.retainFiles} but the peer has retain_files=` +
        `${peer.retainFiles}; both parties must use the same setting`,
    );
  if (peer.locklessRendezvous !== own.locklessRendezvous)
    return new BilateralModeMismatchError(
      `lockless_rendezvous mismatch: this party has lockless_rendezvous=` +
        `${own.locklessRendezvous} but the peer has ` +
        `lockless_rendezvous=${peer.locklessRendezvous}; both parties must ` +
        `use the same setting`,
    );
  return undefined;
}

/**
 * The file name byte limit (NAME_MAX) on the filesystems and SFTP servers the
 * file-sync transport targets: the bound on every name the protocol writes,
 * and the per-entry bound a transport's directory listing enforces.
 */
export const MAX_FILE_NAME_BYTES = 255;

// The longest name either party writes that holds both ids: the retain-mode
// ack of a timestamped message, sized at the highest counter send() allows and
// the frame cap's byte count. Its length depends only on the sum of the two
// ids, so both parties reach the same verdict.
const longestTwoIdNameBytes = (selfId: string, peerId: string): number =>
  new TextEncoder().encode(
    ackMarkerName(
      selfId,
      messageFilename({
        id: peerId,
        timestampInFilename: true,
        byteCount: MAX_FRAME_SIZE_BYTES,
        seq: MAX_MESSAGE_SEQ,
        ts: 0,
      }).slice(0, -".json".length),
    ),
  ).length;

// Typed so the cleanup sites leave the refusing party's hello in place, as
// they do for a BilateralModeMismatchError: the peer reaches the same verdict
// only by reading it.
class PeerIdsTooLongError extends UsageError {}
class PeerIdsPrefixError extends UsageError {}

// Refuses a peer id that, with this party's id, would make a file name the
// exchange writes longer than MAX_FILE_NAME_BYTES. Applied, with the prefix
// refusal, at every site that reads a peer hello before writing a name derived
// from it.
/** @internal */
export function peerIdLengthRefusal(
  selfId: string,
  peerId: string,
): UsageError | undefined {
  const bytes = longestTwoIdNameBytes(selfId, peerId);
  if (bytes <= MAX_FILE_NAME_BYTES) return undefined;
  const idBytes = (id: string) => new TextEncoder().encode(id).length;
  return new PeerIdsTooLongError(
    `the two parties' ids are too long together: the partner's id is ` +
      `${idBytes(peerId)} bytes and this party's is ${idBytes(selfId)}, so ` +
      `file names built from them reach ${bytes} bytes, over the ` +
      `${MAX_FILE_NAME_BYTES}-byte limit. Set a shorter peer_id on the ` +
      "party that configured a long one.",
  );
}

// Refuses an id pair where one id extends the other at a '-' boundary (e.g.
// 'site' / 'site-2'): a file named for one party would then parse as the
// other's. Needs only the two ids, so it runs where a peer hello is read,
// before any write that hello leads to.
/** @internal */
export function peerIdPrefixRefusal(
  selfId: string,
  peerId: string,
): UsageError | undefined {
  if (!peerId.startsWith(selfId + "-") && !selfId.startsWith(peerId + "-"))
    return undefined;
  return new PeerIdsPrefixError(
    `the partner's id '${redactPrivateKeyMaterial(peerId)}' and this ` +
      `party's id '${selfId}' are too alike: one is the other followed by ` +
      "'-' and more text (as 'site' and 'site-2' are), so the two parties' " +
      "file names would be confused. Set a different peer_id on one side.",
  );
}

// The id-pair refusals every peer-hello read applies before it writes.
function peerIdPairRefusal(
  selfId: string,
  peerId: string,
): UsageError | undefined {
  return (
    peerIdLengthRefusal(selfId, peerId) ?? peerIdPrefixRefusal(selfId, peerId)
  );
}

// The refusals of a peer hello: a failed hello exchange that throws one leaves
// this party's hello in place, since the peer reaches the same verdict only by
// reading it.
const keepsAdvertisedHello = (err: unknown): boolean =>
  err instanceof BilateralModeMismatchError ||
  (err instanceof Error && noCommonVersionRefusals.has(err)) ||
  err instanceof PeerIdsTooLongError ||
  err instanceof PeerIdsPrefixError;

// True when `name` is a peer's hello (`<peerId>-hello-<byteCount>.json`): it
// recovers a non-empty id (peerIdFromControlName), and that id is not one the
// querying party writes (isOwnId: its own id, or under a peer_id holding
// fields, any run's). The single definition of "a peer hello", shared by the
// entry guard and the in-flight lock/lockless scans: a bare `-hello-<n>.json`
// (empty id) is never a peer hello, at entry or injected mid-rendezvous.
/** @internal */
export function isPeerHelloName(
  name: string,
  isOwnId: (id: string) => boolean,
): boolean {
  const id = peerIdFromControlName(name, "hello");
  return id !== undefined && !isOwnId(id);
}

// True when `name` is a peer's joining sentinel
// (`<peerId>-joining-<byteCount>.json`): the joining counterpart of
// isPeerHelloName. A bare `-joining-<n>.json` (empty id) is rejected, so it is
// never treated as a real joiner arrival and never starts the lock-path
// joiner-recovery (joinerRecoveryMs) window.
/** @internal */
export function isPeerJoiningName(
  name: string,
  isOwnId: (id: string) => boolean,
): boolean {
  const id = peerIdFromControlName(name, "joining");
  return id !== undefined && !isOwnId(id);
}

// True when `name` is a hello whose non-empty id is one this party writes:
// its own leftover, or a partner whose id fits this party's peer_id, which no
// scan can tell apart.
function isOwnPatternHelloName(
  name: string,
  isOwnId: (id: string) => boolean,
): boolean {
  const id = peerIdFromControlName(name, "hello");
  return id !== undefined && isOwnId(id);
}

// The writer id of a hello or joining sentinel a scan has already matched by
// name, so it parses.
const controlWriterId = (name: string): string =>
  parseSizedControlName(name)!.id;

// The pre-sweep retain inspection's hello-read bound, in poll cycles
// (docs/spec/FILE_SYNC.md, Invariants, I5a): it absorbs flush jitter only,
// since the gate's do-while still makes one read.
const RETAIN_INSPECTION_POLL_CYCLES = 2;

// Every rendezvous-time hello read's bound, in poll cycles, never the full
// peer timeout: three times the inspection's, since this read races a peer
// still writing (docs/spec/FILE_SYNC.md, Invariants, I5a).
const RENDEZVOUS_HELLO_READ_POLL_CYCLES = 6;

// The wall-clock floor under every bound this module derives from poll
// cycles; no bound it floors extends a wait past the remaining peer budget
// (docs/spec/FILE_SYNC.md, Phase 1 -- entry-present peer hello).
const rendezvousBoundMs = (
  options: RendezvousOptions,
  pollCycles: number,
): number =>
  Math.max(pollCycles * options.pollingFrequency, options.joinerRecoveryMs);

// A near-future deadline for a bounded hello read, capped at the remaining peer
// budget so it is never longer than the operator asked for. open() sets
// timeToLive before synchronize() runs, so the non-null assertion is safe at
// every call site.
const boundedReadDeadline = (
  options: RendezvousOptions,
  pollCycles: number,
): Date =>
  new Date(
    Math.min(
      Date.now() + rendezvousBoundMs(options, pollCycles),
      options.timeToLive!.getTime(),
    ),
  );

const helloReadDeadline = (options: RendezvousOptions): Date =>
  boundedReadDeadline(options, RENDEZVOUS_HELLO_READ_POLL_CYCLES);

// Classifies the hello a rendezvous-time read is about against the at-most-one
// hello the entry scan found, so no call site has to reason about which of its
// branches a leftover can reach: a site the entry-present hello cannot reach
// passes an undefined entryPeerHello and classifies as appearedAfterEntry by
// the comparison rather than by an assertion in a comment.
const peerHelloProvenance = (
  name: string,
  entryPeerHello: string | undefined,
): PeerHelloProvenance =>
  name === entryPeerHello ? "presentAtEntry" : "appearedAfterEntry";

// The entry-present hello's ack window, as a fraction of the remaining peer
// budget, and its floor in poll cycles (docs/spec/FILE_SYNC.md, Phase 1 --
// entry-present peer hello). The one bound this design leaves to be tuned:
// these two and rendezvousBoundMs's floor are the only places to change it.
const ENTRY_HELLO_ACK_WINDOW_FRACTION = 1 / 8;
const ENTRY_HELLO_ACK_WINDOW_MIN_POLL_CYCLES = 6;

// The instant an entry-present peer hello stops getting the benefit of the
// doubt, or undefined when the window cannot fit strictly inside the
// remaining budget, which `now` and the budget are read once to check.
const entryHelloAckDeadline = (
  options: RendezvousOptions,
  now: number,
): number | undefined => {
  const remaining = options.timeToLive!.getTime() - now;
  const windowMs = Math.max(
    rendezvousBoundMs(options, ENTRY_HELLO_ACK_WINDOW_MIN_POLL_CYCLES),
    remaining * ENTRY_HELLO_ACK_WINDOW_FRACTION,
  );
  return windowMs < remaining ? now + windowMs : undefined;
};

// The longest filename the protocol's own constructors build from UUID
// identities: a retain-mode message ack over a timestamped message at the
// maximum frame size, with a three-digit counter. Computed by calling
// those two constructors, so it follows a change to either name shape
// instead of restating one. The nil UUID stands in for the two identities:
// only their length reaches this arithmetic, and it has the canonical UUID
// text length without drawing randomness at module load.
//
// Reserved out of the detail link's budget for the enumeration before the
// directory scope is fitted, so an operator-chosen path cannot crowd the
// names out. A name built from a longer identity -- a configured
// `peer_id`, or a session past message 999 -- may still not fit; it is
// then counted rather than shown. A test pins that the reservation shows a
// constructor-built name whole, and its value.
/** @internal */
export const ENTRY_GUARD_NAME_BUDGET_FLOOR = renderedDisplayCost(
  ackMarkerName(
    NIL_UUID,
    messageFilename({
      id: NIL_UUID,
      timestampInFilename: true,
      byteCount: MAX_FRAME_SIZE_BYTES,
      seq: 999,
      ts: 0,
    }).slice(0, -".json".length),
  ),
);

const andMoreSuffix = (count: number): string => ` (and ${count} more)`;

// Composes a strict-empty entry-guard refusal: `refusalAndRecovery` becomes
// the error's own message, and the directory scope plus offending
// filenames become its own `cause` link. Both refusals are built here so
// the shape they share cannot drift.
//
// The message and the detail are split into two cause-chain links because
// sanitizeErrorForDisplay caps and truncates each link independently; one
// link could not hold the refusal, the recovery step, the directory path,
// and the filenames without competing budgets. What each message measures
// at the rendered boundary is pinned by a test.
//
// The detail link is fitted to DEFAULT_MAX_DISPLAY_LENGTH, the per-value
// budget, not the wider link cap, since it holds partner-chosen values;
// the enumeration is bounded by that budget rather than by a count, since
// a protocol filename runs from roughly 47 characters to
// ENTRY_GUARD_NAME_BUDGET_FLOOR. Each name is fit-checked in listing order
// so one long name cannot suppress shorter names behind it; a name that
// does not fit is counted rather than shown, since a chopped name reads
// like a whole one the operator could go delete.
//
// Names and the directory scope are partner-controlled and redacted before
// the fit loop (see redactPrivateKeyMaterial), so the budget is spent on
// what the operator is actually shown.
const entryGuardRefusal = (
  refusalAndRecovery: string,
  kindPlural: string,
  rawDirsDisplay: string,
  rawNames: string[],
): UsageError => {
  const dirsDisplay = redactPrivateKeyMaterial(rawDirsDisplay);
  const names = rawNames.map(redactPrivateKeyMaterial);
  const head = `${names.length} ${kindPlural} in `;
  // The floor plus the widest count suffix the enumeration can end on, held
  // back before the directory scope is fitted.
  const namesFloor =
    ENTRY_GUARD_NAME_BUDGET_FLOOR +
    (names.length > 1
      ? renderedDisplayCost(andMoreSuffix(names.length - 1))
      : 0);
  const dirs = clipToRenderedCost(
    dirsDisplay,
    DEFAULT_MAX_DISPLAY_LENGTH -
      renderedDisplayCost(head) -
      renderedDisplayCost(": ") -
      namesFloor,
  );
  const prefix = `${head}${dirs}: `;
  const namesBudget = DEFAULT_MAX_DISPLAY_LENGTH - renderedDisplayCost(prefix);
  let listed = "";
  let listedCost = 0;
  let shown = 0;
  // `remaining` is what the count suffix would say if this name were the last
  // one shown, so the width reserved on the iteration that admits the final name
  // is exactly the width the enumeration ends on, and every earlier iteration
  // reserves at least it -- skipping a name only lowers the final count.
  for (const name of names) {
    const candidate = shown === 0 ? name : `, ${name}`;
    const remaining = names.length - shown - 1;
    const cost =
      listedCost +
      renderedDisplayCost(candidate) +
      (remaining > 0 ? renderedDisplayCost(andMoreSuffix(remaining)) : 0);
    if (cost > namesBudget) continue;
    listed += candidate;
    listedCost += renderedDisplayCost(candidate);
    shown += 1;
  }
  const omitted = names.length - shown;
  return new UsageError(refusalAndRecovery, {
    cause: new Error(
      shown === 0
        ? `${prefix}name(s) too long to display`
        : omitted > 0
          ? `${prefix}${listed}${andMoreSuffix(omitted)}`
          : `${prefix}${listed}`,
    ),
  });
};

// The rendezvous-relevant subset of the connection's Options, read live
// through the deps `options` accessor. The connection's full Options is a
// superset, so `() => this.options` satisfies this; naming only what the
// coordinator reads keeps this boundary's dependency on the connection's
// config explicit and narrow.
/** @internal */
export interface RendezvousOptions {
  timeToLive?: Date;
  pollingFrequency: number;
  locklessRendezvous: boolean;
  retainFiles: boolean;
  sweepExchangeFiles: boolean;
  forceRetainSweep: boolean;
  joinerRecoveryMs: number;
  ignoreFilesOlderThanMs?: number | typeof IGNORE_FILES_OLDER_THAN_INFINITE;
  writeWithoutRenaming?: boolean;
  renameRefusedGuidance?: string;
}

// What the entry scan hands the rendezvous: the at-most-one tolerated peer
// hello, and in retain mode the youngest unanswered partner hello it ignored.
interface EntryScan {
  peerHellos: FileInfo[];
  // The youngest ignored partner hello nobody answered, its age at entry, and
  // the window it was older than.
  unansweredHello:
    { name: string; ageMs: number; windowMs: number } | undefined;
}

// What the two hello-exchange waits share with the rollback around them.
interface HelloExchangeState {
  scope: RendezvousScope;
  helloPath: string;
  // The peer hello the entry scan found, and the deadline its bounded ack
  // window is armed with, if any.
  entryPeerHello: string | undefined;
  entryHelloDeadline: number | undefined;
  unansweredHello: EntryScan["unansweredHello"];
  // This party's lock and ack once their paths are known: a failure that is
  // not a refusal deletes them.
  lockPath: string | undefined;
  ackPath: string | undefined;
  // The first hello a wait skipped as this party's own, other than the hello
  // this run wrote; the peer timeout then names it.
  ignoredOwnPatternHello: string | undefined;
}

// With `ignoredOwnPatternHello`, the cause states the shared name and the
// catalog sentence is followed by the hello the wait skipped as this party's
// own. With `unansweredHello`, the cause states the partner hello the entry
// scan ignored and its age, and the sentence is followed by that hello's name.
// Each app's remedy then names its own way to change the name or the window.
const partnerNeverArrived = (
  deps: RendezvousDeps,
  ignoredOwnPatternHello: string | undefined,
  unansweredHello: EntryScan["unansweredHello"],
): Error => {
  const cause: FailureCause = {
    kind: "partner-never-arrived",
    channel: deps.channel(),
    waitedMs: deps.arrivalBudgetMs(),
    ...(ignoredOwnPatternHello !== undefined ? { sharedName: true } : {}),
    ...(unansweredHello !== undefined
      ? {
          ignoredHello: {
            ageMs: Math.max(0, Math.floor(unansweredHello.ageMs)),
            windowMs: unansweredHello.windowMs,
          },
        }
      : {}),
  };
  if (ignoredOwnPatternHello === undefined && unansweredHello === undefined)
    return failureCauseError(cause);
  const ownPattern =
    ignoredOwnPatternHello === undefined
      ? ""
      : (unansweredHello === undefined
          ? " This run took it for its own leftover and ignored it."
          : " This run took the file with this side's name for its own " +
            "leftover and ignored it.") +
        ` The ignored file: ${redactPrivateKeyMaterial(ignoredOwnPatternHello)}`;
  const first = `${failureCauseSentence(cause)}${ownPattern}`;
  if (unansweredHello === undefined)
    return markFailureCause(new Error(first), cause);
  const unanswered =
    "The ignored partner hello file: " +
    redactPrivateKeyMaterial(unansweredHello.name);
  if (ignoredOwnPatternHello === undefined)
    return markFailureCause(new Error(`${first} ${unanswered}`), cause);
  // Each ignored file's name ends a line of its own.
  const lines = [first, unanswered];
  return markFailureCause(
    keepFirstPartyLineBreaks(new Error(lines.join("\n")), lines),
    cause,
  );
};

// The connection-owned state the coordinator reads and writes across this
// boundary. Three kinds:
//   - SHARED OBJECT REFERENCES (never copies): responsibleFiles and
//     foreignFileSnapshot are the same Set instances poll()/cleanup()/close()
//     hold, so every add/delete/clear/forEach here is observed there.
//   - LIVE ACCESSORS (read fresh per call, never hoisted): signal/wait/role/
//     id/client/outbound/log/options/peerId/handshakeRole. signal() must not
//     be cached: the connection swaps its AbortController per session, so a
//     concurrent close() abort must reach an in-flight rendezvous wait.
//   - FIELD-BACKED SETTERS AND DELEGATES: setRole/setPeerId/setHandshakeRole
//     commit identity in place at the current commit sites; resetSessionState,
//     clearAbortMarker, and writeAck forward to the connection.
/** @internal */
export interface RendezvousDeps {
  responsibleFiles: Set<string>;
  foreignFileSnapshot: Set<string>;
  // Inbound names a retain-mode entry scan ignores as an earlier exchange's;
  // the message loop's listings drop them too.
  startupIgnoredFiles: Set<string>;
  client: () => FileTransportClient;
  id: () => string;
  // Whether an id is one this party's configuration writes on any run: its
  // own id, or with a peer_id holding fields, any expansion of it.
  isOwnId: (id: string) => boolean;
  role: () => string;
  outbound: () => string | undefined;
  log: () => ReturnType<typeof getLoggerForVerbosity>;
  options: () => RendezvousOptions;
  // The configured channel and arrival budget, for the partner-never-arrived
  // sentence; either is unset when the connection has no config to read it
  // from, and the sentence then leaves that part out.
  channel: () => "filedrop" | "sftp" | undefined;
  arrivalBudgetMs: () => number | undefined;
  signal: () => AbortSignal;
  wait: (ms: number) => Promise<void>;
  peerId: () => string | undefined;
  handshakeRole: () => HandshakeRole | undefined;
  setRole: (role: string) => void;
  // Commits the peer id with the two hello names the message loop recognizes,
  // or clears both with undefined.
  setPeerId: (
    peerId: string | undefined,
    helloNames: AgreedHelloNames | undefined,
  ) => void;
  setHandshakeRole: (role: HandshakeRole | undefined) => void;
  // Records the peer hello found in the directory at entry, and clears it (with
  // undefined) at the first observation attributable to a LIVE peer. The
  // connection exposes the surviving value so a consumer can distinguish "a peer
  // completed the rendezvous and then went silent" from "this run rendezvoused
  // against a hello nothing has confirmed", which the entry-time directory
  // contents are the only local evidence for.
  setEntryPeerHello: (name: string | undefined) => void;
  resetSessionState: () => void;
  clearAbortMarker: () => void;
  writeAck: (dir: string, originalName: string) => Promise<string>;
}

/**
 * The stateful file-sync rendezvous negotiation as a coordinator
 * {@link FileSyncConnection} composes. It owns no durable state beyond the
 * versions a run offers and selects: it reads the
 * connection's identity/config through {@link RendezvousDeps} accessors and
 * writes role/peerId/handshakeRole back through its setters at the commit sites,
 * mutating the connection's responsibleFiles/foreignFileSnapshot Sets by shared
 * reference. The protocol is specified in docs/spec/FILE_SYNC.md and
 * docs/spec/CHANNEL_SECURITY.md.
 *
 * @internal
 */
export class FileSyncRendezvous {
  constructor(private readonly deps: RendezvousDeps) {}

  // Set by run(): the versions this party's hello offers on a run with no key
  // exchange (undefined on any other run, whose hello offers none), and what
  // the read of the peer hello selected from the two.
  private offeredVersions: HelloVersions | undefined;
  private selected: RendezvousSelectedVersions | undefined;

  /** The versions the last successful {@link run} that offered any selected. */
  get selectedVersions(): RendezvousSelectedVersions | undefined {
    return this.selected;
  }

  // The body of this party's hello and joining sentinel. It depends only on
  // the two mode flags and the offered versions, so both names state one byte
  // count for the whole run.
  private helloBody(): Buffer {
    return serializeEnvelope(
      helloEnvelope(this.deps.options(), this.offeredVersions),
    );
  }

  // A version refusal is checked first: a different build is the likelier
  // root cause of any flag difference beside it.
  private peerHelloRefusal(peerEnvelope: HelloEnvelope): Error | undefined {
    if (this.offeredVersions !== undefined) {
      const selection = selectRendezvousVersions(
        this.offeredVersions,
        peerEnvelope,
      );
      if (!selection.ok) return selection.refusal;
      this.selected = selection.selected;
    }
    return bilateralMismatch(peerEnvelope, this.deps.options());
  }

  private ownControlName(type: Exclude<SizedControlType, "abort">): string {
    return sizedControlName(this.deps.id(), type, this.helloBody().length);
  }

  private agreedHelloNames(peerHelloName: string): AgreedHelloNames {
    return { self: this.ownControlName("hello"), peer: peerHelloName };
  }

  // Every rendezvous read of a peer hello: the read gate under the rendezvous
  // read bound, then the refusal the hello earns, if any -- the version and
  // mode-flag refusals, then the id-pair refusals. The caller throws the
  // refusal after its own cleanup.
  private async readPeerHello(
    inboundPath: string,
    file: FileInfo,
    provenance: PeerHelloProvenance,
  ): Promise<Error | undefined> {
    const { deps } = this;
    const envelope = await readControlFileWithGate(
      deps.client(),
      joinFileSyncPath(inboundPath, file.name),
      file.size,
      helloReadDeadline(deps.options()),
      deps.options().pollingFrequency,
      HelloEnvelopeSchema,
      provenance,
      deps.signal(),
    );
    return (
      this.peerHelloRefusal(envelope) ??
      peerIdPairRefusal(deps.id(), controlWriterId(file.name))
    );
  }

  // Returns the connection to its pre-synchronize identity, so the "already
  // synchronized" guard does not block a retry on this instance and a stale
  // role does not appear in the retry's first log line.
  private resetIdentity(): void {
    const { deps } = this;
    deps.setPeerId(undefined, undefined);
    deps.setRole("unknown role");
    deps.setHandshakeRole(undefined);
    deps.clearAbortMarker();
    deps.resetSessionState();
  }

  /**
   * Negotiates rendezvous with the peer: scans and classifies the entry
   * directory, then dispatches to the lock-joiner fast-path or the symmetric
   * hello-exchange. The connection's public synchronize() validates entry and
   * threads the resulting {@link RendezvousScope} here. `offeredVersions` is
   * passed by a run with no key exchange only: its hello offers them, and a
   * peer hello sharing no version in a layer is refused.
   */
  async run(
    scope: RendezvousScope,
    offeredVersions?: HelloVersions,
  ): Promise<void> {
    const { deps } = this;
    this.offeredVersions = offeredVersions;
    this.selected = undefined;

    // Scan and classify the entry directory (recognize orphaned temps and
    // leftover abort markers, snapshot foreign files, sweep-or-reject
    // unexpected protocol files, then delete the recognized leftovers once
    // entry is accepted). Yields the at-most-one tolerated peer hello.
    const entry = await this.scanEntryDirectory(scope);
    const { peerHellos } = entry;
    // close() waits for the whole rendezvous, so each step checks its abort
    // before starting: an operation in flight lands, and nothing follows it.
    deps.signal().throwIfAborted();

    // This party's own hello is a self-write, so it goes to the outbound
    // directory; the peer reads it from its inbound (which is this outbound). In
    // shared mode outboundPath === inboundPath. The lock-mode branches that also
    // reference helloPath only run in shared mode (split requires retain, which
    // requires lockless), so routing it through outbound is correct there too.
    const helloPath = joinFileSyncPath(
      scope.outboundPath,
      this.ownControlName("hello"),
    );

    // The at-most-one peer hello that PREDATED this run. It is the only hello
    // whose writer has already demonstrated a propagation leg, and equally the
    // only one that can be residue of an interrupted run in this directory --
    // the two are indistinguishable on disk, which is why both the bounded
    // window below and the connection's unconfirmed-hello fact are armed on this
    // case alone. A hello that appears AFTER entry is an ordinary peer arriving.
    const entryPeerHello =
      peerHellos.length === 1 ? peerHellos[0].name : undefined;
    deps.setEntryPeerHello(entryPeerHello);

    if (peerHellos.length === 1 && !deps.options().locklessRendezvous) {
      await this.rendezvousAsLockJoiner(scope, peerHellos[0], helloPath);
    } else {
      await this.rendezvousViaHelloExchange(
        scope,
        helloPath,
        entryPeerHello,
        entry,
      );
    }
  }

  // Writes this party's hello or sentinel temp-then-rename, its temp swept
  // inline on failure and never tracked; the caller tracks the final name
  // with no throwable statement after the rename. With writeWithoutRenaming
  // the body goes straight to `dir/name`, pre-tracked in delete mode where
  // the caller tracks it (`track`) (docs/spec/FILE_SYNC.md, Invariants, I4a).
  private async writeHello(
    dir: string,
    name: string,
    track: boolean,
  ): Promise<void> {
    const { deps } = this;
    const finalPath = joinFileSyncPath(dir, name);
    const body = this.helloBody();
    if (deps.options().writeWithoutRenaming) {
      if (track && !deps.options().retainFiles) deps.responsibleFiles.add(name);
      await deps
        .client()
        .put(body, finalPath, { flags: "w", encoding: "utf-8" });
      return;
    }
    const tempPath = joinFileSyncPath(dir, helloTempName());
    try {
      await deps
        .client()
        .put(body, tempPath, { flags: "w", encoding: "utf-8" });
      await renameOwnTemp(
        deps.client(),
        tempPath,
        finalPath,
        name,
        deps.options().renameRefusedGuidance,
      );
    } catch (err: unknown) {
      await deps.client().safeDelete(tempPath);
      throw err instanceof Error ? err : new Error(errorMessage(err));
    }
  }

  // The pre-sweep retain-signal inspection, then the --sweep-exchange-files
  // deletes through client.delete, so a failed delete is a transport error
  // (docs/spec/FILE_SYNC.md, The five enforcement sites, site 1(c)).
  // Non-atomic: a live peer can write between the scan and the deletes, which
  // the flag asserts away (I1).
  //
  // Known gap: a peer-less, self-started retain half-start whose process
  // died before its own rollback ran, re-run in delete mode under the same
  // peer_id, is caught only by local retain mode -- a delete-mode re-run
  // loses only that operator's own abandoned half-start, never a two-party
  // transcript.
  private async sweepProtocolFiles(
    inboundPath: string,
    peerHellos: Array<FileInfo>,
    unexpectedProtocol: Array<{ file: FileInfo; dir: string }>,
  ): Promise<void> {
    const { deps } = this;
    // The directory scope this sweep touches, for operator-facing messages: in
    // split mode the sweep deletes from BOTH directories (peer leftovers in
    // inbound, this party's own leftovers in outbound), so name both; in shared
    // mode it collapses to the inbound display path.
    const dirsDisplay = composeDirsDisplay(inboundPath, deps.outbound());

    const signals: string[] = [];
    let unreadableHello:
      { name: string; size: number; reason: string } | undefined;

    if (deps.options().retainFiles)
      signals.push("this party is in retain mode");

    // A retain message ack matches the protocol grammar (-ack.json) and is
    // not a peer hello, so it is already in unexpectedProtocol -- scan that
    // set rather than the raw entry listing, keeping this in step with the
    // ignored-filtered classification. In split mode this also catches a
    // retain transcript leftover in this party's own outbound directory,
    // since outbound leftovers are folded into the same set.
    const messageAck = unexpectedProtocol.find((e) =>
      isRetainMessageAck(e.file.name),
    );
    if (messageAck)
      signals.push(`a retain-mode message ack (${messageAck.file.name})`);

    // Read peer hello bodies only when no cheaper signal has decided it
    // already: the hello read is the critical check, and the only one that
    // costs a network round trip.
    if (signals.length === 0) {
      // One deadline shared across all peer hellos, bounding the total
      // inspection even in the all-readable case (a readable hello returns
      // as soon as its body resolves). The first hello that cannot be read
      // is recorded and breaks out: uncertainty is sticky and
      // already forces the refuse-or-force decision, so reading the rest
      // cannot change the outcome, and breaking caps the work a pile of
      // unreadable hellos (a hostile directory under --sweep-exchange-files)
      // can impose.
      const inspectionDeadline = boundedReadDeadline(
        deps.options(),
        RETAIN_INSPECTION_POLL_CYCLES,
      );
      for (const hello of peerHellos) {
        try {
          const envelope = await readControlFileWithGate(
            deps.client(),
            joinFileSyncPath(inboundPath, hello.name),
            hello.size,
            inspectionDeadline,
            deps.options().pollingFrequency,
            HelloEnvelopeSchema,
            // These hellos are the entry scan's own listing.
            "presentAtEntry",
            deps.signal(),
          );
          if (envelope.retainFiles) {
            signals.push(
              `peer hello ${hello.name} advertises retain_files=true`,
            );
            break;
          }
        } catch (err) {
          if (deps.signal().aborted) throw err;
          // Terminal unless the force flag clears this refusal.
          const reason = unreadableHelloReason(err);
          if (
            err instanceof UsageError &&
            (reason === undefined || !deps.options().forceRetainSweep)
          ) {
            if (reason !== undefined) chainForceRetainSweepStep(err);
            throw err;
          }
          // Sticky: a later hello reading retain_files=false does not clear
          // it, since this one could be a retain hello.
          unreadableHello = {
            name: hello.name,
            size: hello.size,
            reason: reason ?? "it did not become readable in the time allowed",
          };
          break;
        }
      }
    }

    const retainInPlay = signals.length > 0 || unreadableHello !== undefined;

    if (retainInPlay && !deps.options().forceRetainSweep) {
      const reason =
        signals.length > 0
          ? signals.join("; ")
          : "a peer hello could not be read in the time allowed, so retain " +
            "mode cannot be ruled out";
      throw new UsageError(
        `path ${redactPrivateKeyMaterial(dirsDisplay)} may hold a retain-mode ` +
          `transcript (${redactPrivateKeyMaterial(reason)}), so ` +
          "--sweep-exchange-files will not delete it: it may be an audit " +
          "record. Confirm no other exchange is using this path, then re-run " +
          "with --force-retain-sweep to delete the earlier transcript and " +
          "start a fresh exchange.",
      );
    }

    // Dir-qualified so each file is deleted from the directory it was listed
    // in (peer hellos are inbound; unexpectedProtocol contains its own dir,
    // which is the outbound directory for a split-mode self leftover).
    const toDelete: Array<{ name: string; dir: string }> = [
      ...peerHellos.map((file) => ({ name: file.name, dir: inboundPath })),
      ...unexpectedProtocol.map((e) => ({ name: e.file.name, dir: e.dir })),
    ];

    // Nothing to delete (e.g. local retain mode is the only signal and the
    // directory holds no peer protocol files): return before the warning so it
    // never claims to be deleting zero files.
    if (toDelete.length === 0) return;

    // Entry-time logs use the party id, not the role: the sweep runs before
    // rendezvous, so the role is still the "unknown role" sentinel. For the
    // destructive-wipe warning especially, the party id is the useful identifier.
    if (deps.options().forceRetainSweep && signals.length > 0)
      deps
        .log()
        .warn(
          `[${deps.id()}] --force-retain-sweep: permanently deleting a ` +
            `retain-mode audit transcript (${toDelete.length} protocol file(s)) ` +
            `in ${redactAndSanitizeForDisplay(dirsDisplay)}. This is destructive and ` +
            `irreversible; the prior ` +
            "transcript will be lost. Only use --force-retain-sweep when you " +
            "intend to discard it.",
        );
    else if (deps.options().forceRetainSweep && unreadableHello !== undefined)
      deps
        .log()
        .warn(
          `[${deps.id()}] --force-retain-sweep: permanently deleting ` +
            `${toDelete.length} protocol file(s) in ` +
            `${redactAndSanitizeForDisplay(dirsDisplay)}, which may be a ` +
            "retain-mode audit transcript. The peer hello " +
            redactAndSanitizeForDisplay(
              joinFileSyncPath(inboundPath, unreadableHello.name),
            ) +
            ` (${unreadableHello.size} bytes) could not be read because ` +
            `${unreadableHello.reason}, so retain mode could not be ruled ` +
            "out. This is destructive and irreversible. Only use " +
            "--force-retain-sweep when you intend to discard these files.",
        );

    // A close() may have raced the inspection; do not dispatch deletes against a
    // tearing-down client. Propagate the abort reason (ConnectionClosedError) so
    // it classifies as a clean shutdown (exit 69), not a delete transport error.
    if (deps.signal().aborted) throw deps.signal().reason;

    deps
      .log()
      .info(
        `[${deps.id()}] sweeping ${toDelete.length} protocol file(s) at ` +
          `${redactAndSanitizeForDisplay(dirsDisplay)} (--sweep-exchange-files): ` +
          `${toDelete.map((f) => redactAndSanitizeForDisplay(f.name)).join(", ")}`,
      );
    // allSettled, not all: await every delete before reporting, so a single
    // rejection does not leave the others running unobserved while synchronize()
    // unwinds. The directory then reaches a known (fully-attempted) state and the
    // error names all failures. A delete failure is a transport error (exit 69),
    // never a UsageError. The non-atomicity caveat above still holds: a live peer
    // could write between the listing and these deletes.
    const results = await Promise.allSettled(
      toDelete.map((entry) =>
        deps.client().delete(joinFileSyncPath(entry.dir, entry.name)),
      ),
    );
    // Name and transport error are partner- or server-controlled and sit ahead
    // of the "partially swept" warning and the re-run step in this one link (see
    // redactPrivateKeyMaterial).
    const failures = results.flatMap((result, i) =>
      result.status === "rejected"
        ? [
            `${redactPrivateKeyMaterial(toDelete[i].name)} ` +
              `(${redactPrivateKeyMaterial(errorMessage(result.reason))})`,
          ]
        : [],
    );
    if (failures.length > 0)
      throw new Error(
        `--sweep-exchange-files failed to delete ${failures.length} of ` +
          `${toDelete.length} protocol file(s) at ` +
          `${redactPrivateKeyMaterial(dirsDisplay)}: ` +
          `${failures.join("; ")}. The directory may be partially swept; ` +
          "resolve the transport error and re-run.",
      );
  }

  // Scans and classifies the entry directory before rendezvous: recognizes
  // orphaned in-flight temp writes and leftover abort markers, snapshots
  // foreign files, and either sweeps every protocol file
  // (--sweep-exchange-files) or rejects any unexpected protocol file. The
  // recognized leftovers are deleted only after that, so an entry it refuses
  // deletes nothing. In retain mode without the sweep flag, it first sets
  // aside the files an earlier exchange left (ignoreRetainLeftovers). Returns
  // the at-most-one tolerated peer hello and what was set aside.
  private async scanEntryDirectory(scope: RendezvousScope): Promise<EntryScan> {
    const { deps } = this;
    const { inboundPath, outboundPath, split, dirsDisplay } = scope;

    // Reset the foreign-file snapshot and the ignore list up front so both
    // are rebuilt fresh on every synchronize() entry even when the list()
    // below throws: a failed entry must not leave a prior session's behind
    // for a same-instance retry.
    deps.foreignFileSnapshot.clear();
    deps.startupIgnoredFiles.clear();

    let files: Array<FileInfo>;
    try {
      files = await deps.client().list(inboundPath);
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(errorMessage(err));
    }
    const fileNames = files.map((file) => file.name);
    deps
      .log()
      .trace(
        `[${deps.role()}] found ${files.length} file(s)` +
          `${
            files.length > 0
              ? `: ${fileNames.map((n) => redactAndSanitizeForDisplay(n)).join(", ")}`
              : ""
          }`,
      );
    if (!deps.options().retainFiles)
      deps.responsibleFiles.forEach((fileName) => {
        if (!fileNames.includes(fileName))
          deps.responsibleFiles.delete(fileName);
      });
    // Entry precondition, both modes: at most one peer hello (isPeerHelloName,
    // so a bare `-hello-<n>.json` is an unexpected protocol file) and foreign
    // files; any other protocol file is refused, or swept under
    // --sweep-exchange-files. `ignored` holds the kinds that may predate entry
    // without being refused (docs/spec/FILE_SYNC.md, Invariants, I0 and site 1).
    const ignored = new Set<string>();

    // A message or ack temp is orphaned by construction, since writing one
    // follows this party's hello, written only after this scan (an ordering
    // a test pins); it is deleted once entry is accepted (sweepOrphanedTemps)
    // (docs/spec/FILE_SYNC.md, Hello temp disposition).
    const orphanedTempFiles = files.filter(
      (file) => isProtocolTempName(file.name) && !isHelloTempName(file.name),
    );
    orphanedTempFiles.forEach((file) => ignored.add(file.name));

    // A hello temp is tolerated in place, never swept, even under
    // --sweep-exchange-files: a peer starting at the same instant can have one
    // in flight in this listing (docs/spec/FILE_SYNC.md, Hello temp
    // disposition).
    const helloTempFiles = files.filter((file) => isHelloTempName(file.name));
    if (helloTempFiles.length > 0) {
      deps
        .log()
        .info(
          `[${deps.id()}] tolerating ${helloTempFiles.length} in-flight hello ` +
            "write(s) left in place (a concurrently starting peer's write, " +
            "or a file left over from an earlier run that crashed): " +
            `${helloTempFiles
              .map((f) => redactAndSanitizeForDisplay(f.name))
              .join(", ")}`,
        );
      helloTempFiles.forEach((file) => ignored.add(file.name));
    }

    // All three classifications exclude `ignored`, kept symmetric with the two
    // filters below so a future `ignored` entry that could pass isPeerHelloName
    // is not silently reclassified.
    let peerHellos = files.filter(
      (file) =>
        !ignored.has(file.name) && isPeerHelloName(file.name, deps.isOwnId),
    );

    // Leftover abort markers, delete mode only: any well-formed marker,
    // whichever id wrote it, joins `ignored` and is deleted only once entry is
    // accepted, so a refused entry keeps its markers. A live peer's marker can
    // be swept before it polls, costing it the fast-fail (docs/spec/FILE_SYNC.md,
    // The five enforcement sites, site 1(d), and Abort-marker lifetime).
    const leftoverAbortFiles = deps.options().retainFiles
      ? []
      : files.filter(
          (file) =>
            !ignored.has(file.name) &&
            peerIdFromControlName(file.name, "abort") !== undefined,
        );
    leftoverAbortFiles.forEach((file) => ignored.add(file.name));

    // Single classification (isProtocolGrammarName), two sides: a FOREIGN file
    // fails the protocol grammar; an unexpected PROTOCOL file matches it but is
    // not the one tolerated peer hello. A name therefore cannot be both
    // snapshotted-as-foreign and a protocol file.
    const foreignFiles = files.filter(
      (file) => !ignored.has(file.name) && !isProtocolGrammarName(file.name),
    );
    // Protocol-grammar files that are not the tolerated peer hello: a
    // self-hello, a lock, a joining sentinel, an ack marker, or a stale
    // message. A second peer hello is counted in peerHellos, not here: the
    // no-sweep path's >1 guard rejects it, and --sweep-exchange-files
    // sweeps it along with the first. Dir-qualified so the sweep below
    // deletes each from the directory it was listed in: inbound files here,
    // outbound leftovers appended in the split block below.
    let unexpectedProtocol: Array<{ file: FileInfo; dir: string }> = files
      .filter(
        (file) =>
          !ignored.has(file.name) &&
          !isPeerHelloName(file.name, deps.isOwnId) &&
          isProtocolGrammarName(file.name),
      )
      .map((file) => ({ file, dir: inboundPath }));

    // Foreign-file snapshot (always, both modes, flag or not). Cleared at entry
    // above and populated here; it deletes nothing, so it is safe in retain mode
    // where sync-mediated conflict copies are expected noise. Feeds the poll
    // loop's isRecognizedLoopFile so these names are tolerated and the "new
    // foreign file" warning measures only names that appear after entry.
    foreignFiles.forEach((file) => deps.foreignFileSnapshot.add(file.name));
    if (foreignFiles.length > 0)
      deps
        .log()
        .info(
          `[${deps.id()}] tolerating ${foreignFiles.length} foreign file(s) ` +
            `present at entry in ${redactAndSanitizeForDisplay(scope.inboundPath)}: ` +
            `${foreignFiles.map((f) => redactAndSanitizeForDisplay(f.name)).join(", ")}`,
        );

    // Split mode: no peer file lands in outbound, so every protocol file there
    // is this party's own leftover, judged as on the inbound side except that
    // both temp shapes are swept (docs/spec/FILE_SYNC_MODES.md, Split
    // inbound/outbound directories, and docs/spec/FILE_SYNC.md, Hello temp
    // disposition).
    let outOrphans: FileInfo[] = [];
    let outFiles: FileInfo[] = [];
    if (split) {
      outFiles = await deps.client().list(outboundPath);
      outOrphans = outFiles.filter((file) => isProtocolTempName(file.name));
      const outOrphanNames = new Set(outOrphans.map((file) => file.name));
      const outForeign: FileInfo[] = [];
      for (const file of outFiles) {
        if (outOrphanNames.has(file.name)) continue;
        if (!isProtocolGrammarName(file.name)) {
          deps.foreignFileSnapshot.add(file.name);
          outForeign.push(file);
        } else {
          unexpectedProtocol.push({ file, dir: outboundPath });
        }
      }
      if (outForeign.length > 0)
        deps
          .log()
          .info(
            `[${deps.id()}] tolerating ${outForeign.length} foreign file(s) ` +
              `present at entry in the outbound directory ` +
              `${redactAndSanitizeForDisplay(outboundPath)}: ` +
              `${outForeign.map((f) => redactAndSanitizeForDisplay(f.name)).join(", ")}`,
          );
    }

    let unansweredHello: EntryScan["unansweredHello"];
    if (deps.options().retainFiles && !deps.options().sweepExchangeFiles) {
      const kept = this.ignoreRetainLeftovers(
        scope,
        [...files, ...outFiles].map((file) => file.name),
        peerHellos,
        unexpectedProtocol,
      );
      peerHellos = kept.peerHellos;
      unexpectedProtocol = kept.unexpectedProtocol;
      unansweredHello = kept.unansweredHello;
    }

    if (deps.options().sweepExchangeFiles) {
      // Opt-in sweep: clear this exchange's protocol files (its own AND the
      // peer's) and rendezvous against a clean slate, after a retain-signal
      // inspection that refuses to destroy an audit transcript without
      // --force-retain-sweep. Foreign files are never swept.
      await this.sweepProtocolFiles(inboundPath, peerHellos, [
        ...unexpectedProtocol,
        ...leftoverAbortFiles.map((file) => ({ file, dir: inboundPath })),
      ]);
      // Every protocol file was deleted, so rendezvous proceeds as if the
      // directory held only the (untouched) foreign files.
      peerHellos = [];
    } else {
      // Default strict-empty entry guard: only a single peer hello and the
      // snapshotted foreign files are tolerated; any other protocol file is a
      // terminal usage error pointing at the opt-in sweep.
      // An own-pattern hello in the outbound half of a split scope can only
      // be this party's own, so only the inbound half is checked.
      const holdsOwnPatternHello = unexpectedProtocol.some(
        ({ file, dir }) =>
          dir === inboundPath && isOwnPatternHelloName(file.name, deps.isOwnId),
      );
      if (unexpectedProtocol.length > 0) {
        // The shared-name refusal is a catalog cause: each app's remedy map
        // names its setting and its way to clear the files.
        const sharedName = { kind: "shared-name-at-entry" } as const;
        const refusal = entryGuardRefusal(
          holdsOwnPatternHello
            ? failureCauseSentence(sharedName)
            : "the exchange directory must be empty except for a single " +
                "peer hello, but holds unexpected protocol files. Remove them " +
                "after confirming no other session is using this path, or " +
                "re-run with --sweep-exchange-files to clear every protocol " +
                "file.",
          "unexpected protocol file(s)",
          // dirsDisplay names both halves in split mode: unexpectedProtocol
          // can hold outbound leftovers as well as inbound ones, so
          // directing the operator at the inbound path alone would mislead.
          dirsDisplay,
          unexpectedProtocol.map((e) => e.file.name),
        );
        throw holdsOwnPatternHello
          ? markFailureCause(refusal, sharedName)
          : refusal;
      }

      if (peerHellos.length > 1)
        throw entryGuardRefusal(
          "a shared folder serves one partner, but several partner " +
            "hello files are present. Check whether another session is using " +
            "this path. If none is, " +
            (deps.options().retainFiles
              ? deps.options().ignoreFilesOlderThanMs ===
                IGNORE_FILES_OLDER_THAN_INFINITE
                ? `set ${IGNORE_FILES_OLDER_THAN_KEY} to a duration, then ` +
                  "rerun once they are older than it, and the run starts."
                : `rerun once they are older than ${IGNORE_FILES_OLDER_THAN_KEY} ` +
                  "(your peer timeout when unset), and the run starts."
              : "one of you reruns with --sweep-exchange-files, then the " +
                "other starts."),
          "peer hello files",
          scope.inboundPath,
          peerHellos.map((f) => f.name),
        );

      if (leftoverAbortFiles.length > 0) {
        deps
          .log()
          .info(
            `[${deps.id()}] sweeping ${leftoverAbortFiles.length} leftover abort ` +
              "marker(s) from a prior failed exchange: " +
              `${leftoverAbortFiles
                .map((f) => redactAndSanitizeForDisplay(f.name))
                .join(", ")}`,
          );
        await Promise.all(
          leftoverAbortFiles.map((file) =>
            deps.client().safeDelete(joinFileSyncPath(inboundPath, file.name)),
          ),
        );
      }
    }

    await this.sweepOrphanedTemps(inboundPath, orphanedTempFiles, "");
    await this.sweepOrphanedTemps(
      outboundPath,
      outOrphans,
      " in the outbound directory " + redactAndSanitizeForDisplay(outboundPath),
    );

    return { peerHellos, unansweredHello };
  }

  // Retain mode reuses a directory, so the entry scan sets aside what an
  // earlier exchange left there (classifyRetainLeftovers): the files are
  // never deleted, and the inbound ones join startupIgnoredFiles, which every
  // later listing drops. Refuses a run whose own hello name an earlier
  // exchange already answered, since that exchange's acks would answer this
  // run's hello. Returns the peer hellos and unexpected files left to judge.
  private ignoreRetainLeftovers(
    scope: RendezvousScope,
    listed: string[],
    peerHellos: FileInfo[],
    unexpectedProtocol: Array<{ file: FileInfo; dir: string }>,
  ): Omit<EntryScan, "peerHellos"> & {
    peerHellos: FileInfo[];
    unexpectedProtocol: Array<{ file: FileInfo; dir: string }>;
  } {
    const { deps } = this;
    const outboundDir = scope.split ? scope.outboundPath : undefined;
    const now = Date.now();
    const setting = deps.options().ignoreFilesOlderThanMs;
    const windowMs =
      setting === IGNORE_FILES_OLDER_THAN_INFINITE
        ? undefined
        : (setting ??
          deps.arrivalBudgetMs() ??
          deps.options().timeToLive!.getTime() - now);
    const leftovers = classifyRetainLeftovers({
      inbound: [
        ...peerHellos,
        ...unexpectedProtocol
          .filter((e) => e.dir !== outboundDir)
          .map((e) => e.file),
      ],
      outbound: unexpectedProtocol
        .filter((e) => e.dir === outboundDir)
        .map((e) => e.file),
      listed,
      ownHelloName: this.ownControlName("hello"),
      isOwnId: deps.isOwnId,
      windowMs,
      now,
    });
    if (leftovers.ownNameAnswered !== undefined)
      throw entryGuardRefusal(
        "an earlier exchange in this folder answered a hello under the name " +
          "this run writes, so its files could be taken for this run's. Add " +
          "fields to peer_id, for example %Y%m%d%H%M%S, so each run writes " +
          "new names.",
        "file(s) from an earlier exchange",
        scope.dirsDisplay,
        [leftovers.ownNameAnswered],
      );

    const ignored = new Set(leftovers.ignored.map((entry) => entry.file));
    for (const { file, outbound } of leftovers.ignored)
      if (!outbound) deps.startupIgnoredFiles.add(file.name);

    let unansweredHello: EntryScan["unansweredHello"];
    for (const file of leftovers.unansweredHellos)
      if (
        windowMs !== undefined &&
        (unansweredHello === undefined ||
          now - file.modifyTime < unansweredHello.ageMs)
      )
        unansweredHello = {
          name: file.name,
          ageMs: now - file.modifyTime,
          windowMs,
        };

    if (ignored.size > 0) {
      const youngestAgeMs = leftovers.ignored.reduce(
        (age, entry) => Math.min(age, now - entry.file.modifyTime),
        Infinity,
      );
      deps
        .log()
        .info(
          `[${deps.id()}] ignoring ${ignored.size} file(s) an earlier ` +
            `exchange left in ${redactAndSanitizeForDisplay(scope.dirsDisplay)}; ` +
            `the youngest is ${formatFileAge(youngestAgeMs)} old` +
            (unansweredHello === undefined
              ? ""
              : `, and ${leftovers.unansweredHellos.length} of them are ` +
                "partner hellos nobody answered within " +
                `${formatWaitDuration(unansweredHello.windowMs)} ` +
                `(${IGNORE_FILES_OLDER_THAN_KEY})`),
        );
    }

    return {
      peerHellos: peerHellos.filter((file) => !ignored.has(file)),
      unexpectedProtocol: unexpectedProtocol.filter(
        (entry) => !ignored.has(entry.file),
      ),
      unansweredHello,
    };
  }

  // Deletes the orphaned temps the entry scan recognized, once entry is
  // accepted. Best-effort (safeDelete): a temp that fails to delete stays on
  // disk and entry proceeds past it, and the next entry recognizes it again.
  // Tracking it in `responsibleFiles` would not help, since its writer already
  // died and that process's cleanup() never runs.
  private async sweepOrphanedTemps(
    dir: string,
    orphans: Array<FileInfo>,
    whereDisplay: string,
  ): Promise<void> {
    if (orphans.length === 0) return;
    const { deps } = this;
    deps
      .log()
      .info(
        `[${deps.id()}] sweeping ${orphans.length} orphaned temp file(s) ` +
          `left by a prior crashed exchange${whereDisplay}: ` +
          `${orphans.map((f) => redactAndSanitizeForDisplay(f.name)).join(", ")}`,
      );
    await Promise.all(
      orphans.map((file) =>
        deps.client().safeDelete(joinFileSyncPath(dir, file.name)),
      ),
    );
  }

  // Writes this party's hello on the lock joiner's refusal path so the
  // peer reads it and refuses too. The one refusal site needing a new write
  // at detection time: if every attempt fails, the peer degrades to its peer
  // timeout. Never throws, so a transport rejection (exit 69) or a close()
  // cannot mask the refusal (exit 64) the caller throws next.
  private async advertiseHelloBeforeRefusal(
    scope: RendezvousScope,
  ): Promise<void> {
    const { deps } = this;
    for (
      let attempt = 1;
      attempt <= ADVERTISE_HELLO_RETRY_ATTEMPTS;
      attempt++
    ) {
      try {
        await this.writeHello(
          scope.outboundPath,
          this.ownControlName("hello"),
          false,
        );
        return;
      } catch (writeErr: unknown) {
        // The literal `joiner`, not `this.role`: the role is committed only
        // when rendezvous succeeds, so it still holds "unknown role" here.
        if (attempt === ADVERTISE_HELLO_RETRY_ATTEMPTS) {
          deps
            .log()
            .debug(
              `[joiner] could not advertise hello before refusing after ` +
                `${ADVERTISE_HELLO_RETRY_ATTEMPTS} attempts; peer may time out ` +
                `instead of fast-failing: ${redactAndSanitizeForDisplay(errorMessage(writeErr))}`,
            );
          return;
        }
        deps
          .log()
          .debug(
            `[joiner] advertise-hello write failed (attempt ` +
              `${attempt}/${ADVERTISE_HELLO_RETRY_ATTEMPTS}); retrying: ` +
              `${redactAndSanitizeForDisplay(errorMessage(writeErr))}`,
          );
        try {
          await deps.wait(deps.options().pollingFrequency);
        } catch {
          // deps.wait rejects only on a concurrent close()'s abort.
          deps
            .log()
            .debug(
              `[joiner] advertise-hello retry aborted by connection ` +
                `close after attempt ${attempt}/` +
                `${ADVERTISE_HELLO_RETRY_ATTEMPTS}; peer may time out ` +
                `instead of fast-failing`,
            );
          return;
        }
      }
    }
  }

  // Lock-mode joiner fast-path: a single peer hello is already present and
  // this party is in lock mode, so it arrives via a `<id>-joining-<n>.json`
  // sentinel that holds its hello body, deletes the discovered peer hello,
  // and renames the sentinel into place. Commits role/peerId only after
  // both writes succeed.
  //
  //   A list
  //   A hello
  //   B list
  //   B joining                       (sentinel holding B's hello body)
  //   B delete A hello
  //   B rename joining -> B hello
  //   A list
  //   A delete B hello
  //
  // This is B. With writeWithoutRenaming on, the rename step becomes
  // "B hello" (written directly) then "B delete joining", so A may list the
  // sentinel beside B's hello, or after its own loop has started.
  private async rendezvousAsLockJoiner(
    scope: RendezvousScope,
    peerHello: FileInfo,
    helloPath: string,
  ): Promise<void> {
    const { deps } = this;
    const otherFile = peerHello;
    const otherPath = joinFileSyncPath(scope.inboundPath, otherFile.name);
    const peerId = controlWriterId(otherFile.name);

    deps
      .log()
      .debug(
        `[joiner] arriving via ${this.ownControlName("joining")} sentinel, ` +
          `deleting discovered ${redactAndSanitizeForDisplay(otherFile.name)}`,
      );

    // Read before the peer hello is deleted. This fast path exists only for
    // the hello the entry scan found.
    const refusal = await this.readPeerHello(
      scope.inboundPath,
      otherFile,
      "presentAtEntry",
    );

    // A flag mismatch here means the peer is lockless: only a lockless peer
    // leaves its hello for a lock joiner to find. On any refusal the joiner
    // writes its own hello first, so the peer reads it and refuses too, and
    // keeps the peer hello: both are the directory's terminal state, untracked
    // so close()/cleanup() does not sweep them.
    if (refusal) {
      await this.advertiseHelloBeforeRefusal(scope);
      this.resetIdentity();
      throw refusal;
    }

    // The sentinel spans the window where the peer hello is gone and ours is
    // not yet present, so the peer can tell a joiner mid-arrival from a
    // crashed one (docs/spec/FILE_SYNC.md, Phase 1 -- rendezvous, lock path).
    // Never re-create the peer's hello on failure: that can trip the
    // two-hello collision check (I1).
    const joiningName = this.ownControlName("joining");
    const joiningPath = joinFileSyncPath(scope.inboundPath, joiningName);
    const helloName = this.ownControlName("hello");
    try {
      // The `!options.retainFiles` guards below match the file-wide
      // responsibleFiles idiom (every mutation is `!retainFiles`-guarded, I4a);
      // retain mode never reaches this lock joiner fast-path.
      //
      // The sentinel holds the hello body so the rename below yields a
      // fully-valid `<id>-hello-<n>.json` the peer reads through its gate; the
      // peer itself matches the sentinel by name existence and never reads
      // it. Written temp-then-rename like the hello.
      await this.writeHello(scope.inboundPath, joiningName, true);
      // Track the sentinel only until the peer hello is deleted: before that
      // point a failure leaves the peer hello intact, so cleanup() may safely
      // sweep the sentinel (the peer is no worse off than if we never
      // started). The add follows the put with no throwable statement between,
      // matching the hello write in the else branch.
      if (!deps.options().retainFiles) deps.responsibleFiles.add(joiningName);

      // The last check: from the peer hello's delete, the steps run through to
      // this party's hello, tracked, so close() sweeps the hello.
      deps.signal().throwIfAborted();
      await deps.client().delete(otherPath);

      // The peer hello is gone, so the sentinel is the peer's recovery signal
      // and must survive a later failure: released from responsibleFiles.
      if (!deps.options().retainFiles)
        deps.responsibleFiles.delete(joiningName);

      if (deps.options().writeWithoutRenaming) {
        // The hello is written beside the sentinel (pre-tracked, so a put
        // that throws leaves it to cleanup() while the untracked sentinel
        // stays as the peer's recovery signal), and only then is the
        // sentinel deleted. The peer tolerates its sentinel beside its hello
        // (waitForPeerViaLock) and in its message loop (isRecognizedLoopFile).
        await this.writeHello(scope.outboundPath, helloName, true);
        await this.deleteOwnSentinel(joiningPath, joiningName);
      } else {
        await renameOwnTemp(
          deps.client(),
          joiningPath,
          helloPath,
          helloName,
          deps.options().renameRefusedGuidance,
        );
      }
      // The sentinel is now our hello: stop tracking the (gone) sentinel name
      // and own the hello so cleanup() sweeps it at close().
      if (!deps.options().retainFiles) deps.responsibleFiles.add(helloName);
    } catch (err: unknown) {
      // No resetSessionState() here: this.role, this.peerId,
      // this.handshakeRole, and the sequence counters are all committed only
      // after this try/catch (see below), so a throw leaves the connection in
      // its pre-synchronize state with nothing to reset.
      throw err instanceof Error ? err : new Error(errorMessage(err));
    }

    // Commit role and peerId only after both writes have succeeded. If
    // either write threw above, the connection stays in its
    // pre-synchronize state: `this.peerId` remains undefined, so the
    // "already synchronized" guard does not block a retry on the same
    // instance, and `handshakeRole` does not point at a peer that may
    // not actually exist.
    deps.setHandshakeRole("initiator");
    deps.setRole("joiner");
    deps.setPeerId(peerId, this.agreedHelloNames(otherFile.name));
  }

  // The joiner's sentinel delete after a direct hello write. The hello is
  // already visible and the partner may have read it, so a failed delete must
  // not fail the rendezvous: the sentinel is left to cleanup() at close (delete
  // mode), and this party's loop recognizes it by name meanwhile.
  private async deleteOwnSentinel(
    joiningPath: string,
    joiningName: string,
  ): Promise<void> {
    const { deps } = this;
    try {
      await deps.client().delete(joiningPath);
    } catch (err: unknown) {
      if (err instanceof TransportWriteIndeterminateError) throw err;
      if (!deps.options().retainFiles) deps.responsibleFiles.add(joiningName);
      deps
        .log()
        .warn(
          `[joiner] could not delete ${redactAndSanitizeForDisplay(joiningName)} ` +
            `after writing this party's hello ` +
            `(${redactAndSanitizeForDisplay(errorMessage(err))}); it is ` +
            "removed when the exchange closes.",
        );
    }
  }

  // Symmetric hello-exchange rendezvous: this party writes its own hello, then
  // waits for the peer via either the lockless ack-handshake barrier or the lock
  // poll loop, committing role/peerId only on completion. Reached
  // when the joiner fast-path does not apply -- no peer hello yet, or lockless
  // mode -- covering every rendezvous shape below:
  //
  //   A ~ B list
  //   A ~ B hello
  //   A list
  //   A lock
  //
  //   or
  //
  //   A ~ B list
  //   A ~ B hello
  //   A ~ B list
  //   A ~ B lock
  //
  //   or (lockless mode, joiner fast-path bypassed):
  //
  //   A list
  //   A hello
  //   B list (sees A hello)
  //   B hello (does not delete A hello)
  //   A ~ B ack-handshake barrier
  private async rendezvousViaHelloExchange(
    scope: RendezvousScope,
    helloPath: string,
    entryPeerHello: string | undefined,
    entry: EntryScan,
  ): Promise<void> {
    const { deps } = this;
    const { outboundPath } = scope;

    deps
      .log()
      .debug(
        `[${deps.role()}] creating initial ${this.ownControlName("hello")}`,
      );
    await this.writeHello(outboundPath, this.ownControlName("hello"), true);
    // Tracked after the durable rename (delete mode only), with no throwable
    // statement between it and the rename inside writeHello, exactly as the
    // ack write does (docs/spec/FILE_SYNC.md, Invariants, I4a). A direct write is
    // pre-tracked inside writeHello instead.
    if (!deps.options().retainFiles)
      deps.responsibleFiles.add(this.ownControlName("hello"));

    const state: HelloExchangeState = {
      scope,
      helloPath,
      entryPeerHello,
      // Measured from here, the instant this party's own hello is on disk:
      // before that there is nothing for a live peer to acknowledge.
      entryHelloDeadline:
        entryPeerHello === undefined
          ? undefined
          : entryHelloAckDeadline(deps.options(), Date.now()),
      unansweredHello: entry.unansweredHello,
      lockPath: undefined,
      ackPath: undefined,
      ignoredOwnPatternHello: undefined,
    };

    try {
      if (deps.options().locklessRendezvous)
        await this.waitForPeerLockless(state);
      else await this.waitForPeerViaLock(state);
      // No clear() here: branches that finish their own cleanup
      // (responder, lock-detection, EEXIST loser, lockless) clear or
      // retain explicitly before returning. The createExclusive-winner and
      // lockless paths are the exception -- they leave hello (and lock or
      // ack) in responsibleFiles so cleanup() can sweep them if the peer
      // never arrives. Clearing here would lose that safety net.
      //
      // The last gate on the committed id, behind every peer-hello read's
      // checks (docs/spec/FILE_SYNC.md, The five enforcement sites, site 5):
      // an empty id would let poll() treat every "-"-prefixed file as a peer
      // message.
      if (deps.peerId()!.length === 0)
        throw new UsageError(
          "rendezvous recovered an empty peer id; a bare " +
            "'-hello-<bytes>.json' is not a usable peer hello",
        );
      const prefixRefusal = peerIdPrefixRefusal(deps.id(), deps.peerId()!);
      if (prefixRefusal) throw prefixRefusal;
      return;
    } catch (err: unknown) {
      // A refusal of the peer hello keeps this party's advertised hello as the
      // directory's terminal state, so the peer reads it and refuses too
      // (docs/spec/FILE_SYNC.md, Phase 1 -- terminal rendezvous failure);
      // clearing responsibleFiles and the identity reset still run, so the
      // instance is not wedged.
      if (!keepsAdvertisedHello(err)) {
        if (state.lockPath) await deps.client().safeDelete(state.lockPath);
        if (state.ackPath) await deps.client().safeDelete(state.ackPath);
        await deps.client().safeDelete(helloPath);
      }
      if (!deps.options().retainFiles) deps.responsibleFiles.clear();
      // The final gate fires after a wait has already committed the peer id,
      // role, and handshake role.
      this.resetIdentity();
      throw err instanceof Error ? err : new Error(errorMessage(err));
    }
  }

  // One poll of the inbound directory for either wait: the listing without the
  // files the entry scan ignored, so no check can read one (an ignored name
  // stays ignored for the run, whatever its listed time or size), with
  // responsibleFiles pruned against it and the first own-pattern hello noted.
  private async listForWait(state: HelloExchangeState): Promise<FileInfo[]> {
    const { deps } = this;
    const listed = await deps.client().list(state.scope.inboundPath);
    const currentFiles = listed.filter(
      (file) => !deps.startupIgnoredFiles.has(file.name),
    );
    const fileNames = currentFiles.map((file) => file.name);
    if (!deps.options().retainFiles)
      deps.responsibleFiles.forEach((fileName) => {
        if (!fileNames.includes(fileName))
          deps.responsibleFiles.delete(fileName);
      });
    // In a shared directory a partner hello with this run's exact name cannot
    // be told from its own, so only a split scope counts that name.
    if (state.ignoredOwnPatternHello === undefined) {
      const ownHello = this.ownControlName("hello");
      state.ignoredOwnPatternHello = currentFiles.find(
        (file) =>
          (state.scope.split || file.name !== ownHello) &&
          isOwnPatternHelloName(file.name, deps.isOwnId),
      )?.name;
    }
    return currentFiles;
  }

  private peerWaitTimeout(state: HelloExchangeState): Error {
    return markPeerWaitTimeout(
      partnerNeverArrived(
        this.deps,
        state.ignoredOwnPatternHello,
        state.unansweredHello,
      ),
    );
  }

  // Lockless ack-handshake barrier: completes rendezvous using neither
  // createExclusive nor delete (docs/spec/FILE_SYNC.md, Phase 1 -- rendezvous,
  // lockless path). A peer hello already present before this loop (joiner
  // fast-path bypassed) satisfies the condition on the first iteration.
  private async waitForPeerLockless(state: HelloExchangeState): Promise<void> {
    const { deps } = this;
    const { scope } = state;
    const { outboundPath } = scope;
    let ackedPeerHelloName: string | undefined;
    // open() set timeToLive before synchronize() can run, so the
    // non-null assertion is safe here.
    while (Date.now() <= deps.options().timeToLive!.getTime()) {
      deps.signal().throwIfAborted();
      const currentFiles = await this.listForWait(state);

      // isPeerHelloName excludes our own hello and a bare `-hello-<n>.json`
      // (empty id) injected after entry, which would otherwise be
      // adopted as peerId="".
      const peerHellos = currentFiles.filter((file) =>
        isPeerHelloName(file.name, deps.isOwnId),
      );

      if (peerHellos.length === 0) {
        deps.log().trace(`[${deps.role()}] no peer hello found; polling`);
        await deps.wait(deps.options().pollingFrequency);
        continue;
      }

      if (peerHellos.length > 1) {
        throw new UsageError(
          `more than one peer hello file in ` +
            `${redactPrivateKeyMaterial(scope.inboundPath)} - are ` +
            "there other sessions using this path?",
        );
      }

      const peerHello = peerHellos[0];
      const peerId = controlWriterId(peerHello.name);

      // The checks below ran on the hello this party acked; a different
      // one in a later listing was neither read nor acked.
      if (
        ackedPeerHelloName !== undefined &&
        peerHello.name !== ackedPeerHelloName
      )
        throw new UsageError(
          "the peer hello changed during the rendezvous in " +
            `${redactPrivateKeyMaterial(scope.inboundPath)} - are ` +
            "there other sessions using this path?",
        );

      // Write our ack once on the first sighting of the peer's hello.
      if (state.ackPath === undefined) {
        // Read before writing our ack, so a truncated body is not treated as
        // malformed. The checks run on this peer-HELLO read, never on the
        // peer-ack match below. On a refusal, throw without writing the ack:
        // our hello stays for the peer to read and refuse too.
        const refusal = await this.readPeerHello(
          scope.inboundPath,
          peerHello,
          peerHelloProvenance(peerHello.name, state.entryPeerHello),
        );
        if (refusal) throw refusal;

        // A zero-length self-write (`<myId>-<peerHelloStem>-ack.json`) to the
        // outbound directory, temp-then-rename, matched by the peer by name.
        const peerHelloStem = peerHello.name.slice(0, -".json".length);
        deps
          .log()
          .debug(
            `[${deps.role()}] writing handshake ack for ` +
              `${redactAndSanitizeForDisplay(peerHello.name)}`,
          );
        // A direct write can leave the ack on disk when it throws, so its
        // path is known to the outer catch's sweep before the write, as
        // lockPath is before createExclusive.
        if (deps.options().writeWithoutRenaming)
          state.ackPath = joinFileSyncPath(
            outboundPath,
            ackMarkerName(deps.id(), peerHelloStem),
          );
        const ackName = await deps.writeAck(outboundPath, peerHelloStem);
        state.ackPath = joinFileSyncPath(outboundPath, ackName);
        ackedPeerHelloName = peerHello.name;
        // Track after the durable rename (delete mode only), with no
        // throwable statement between it and the add (I4a). The in-flight
        // temp-*.tmp is swept inline by writeAck.
        if (!deps.options().retainFiles) deps.responsibleFiles.add(ackName);
        // Re-enter the loop so hasPeerAck is checked against a fresh
        // listing: this iteration's may miss a peer ack that arrived
        // between list() and the write.
        continue;
      }

      // Barrier completes when the peer's ack of THIS party's hello is
      // visible in the current listing (always fresh because of the
      // continue above), matched by name: the marker is zero-length.
      const myHelloName = this.ownControlName("hello");
      const peerAckName = ackMarkerName(
        peerId,
        myHelloName.slice(0, -".json".length),
      );
      const hasPeerAck = currentFiles.some((file) => file.name === peerAckName);

      if (!hasPeerAck) {
        // The bounded window on an entry-present peer hello, which is never
        // deleted here (docs/spec/FILE_SYNC.md, Phase 1 -- entry-present
        // peer hello). Its limit: a partner whose round trip outruns the
        // window is alive and mid-answer, so the text names residue as a
        // reading and puts the re-run ahead of the removal.
        if (
          state.entryHelloDeadline !== undefined &&
          peerHello.name === state.entryPeerHello &&
          Date.now() > state.entryHelloDeadline
        )
          throw new UsageError(
            "peer hello present at start never answered; it may be " +
              "left over, not a live peer. Re-run; remove only if it " +
              "persists and no other exchange uses this path: " +
              `${redactPrivateKeyMaterial(peerHello.name)}`,
          );
        deps
          .log()
          .trace(
            `[${deps.role()}] waiting for peer ack ` +
              `${redactAndSanitizeForDisplay(peerAckName)}`,
          );
        await deps.wait(deps.options().pollingFrequency);
        continue;
      }

      // The peer's ack of a hello this party wrote after its own entry
      // scan: an observation attributable to a LIVE peer, which is what
      // clears an entry-present hello from the unconfirmed-residue case.
      deps.setEntryPeerHello(undefined);

      // Peer ack confirmed -- commit roles and peerId as the last step,
      // the same invariant as the joiner path: if the ack write fails
      // before this point, this.peerId stays undefined and the "already
      // synchronized" guard allows a retry on this instance.
      const arrivedFirst = this.ownControlName("hello") < peerHello.name;
      deps.setHandshakeRole(arrivedFirst ? "responder" : "initiator");
      deps.setRole(arrivedFirst ? "starter" : "joiner");
      deps.setPeerId(peerId, this.agreedHelloNames(peerHello.name));

      deps
        .log()
        .debug(
          `[${deps.role()}] lockless rendezvous complete with ` +
            `${redactAndSanitizeForDisplay(peerId)}`,
        );

      // Do NOT clear responsibleFiles: hello and ack remain so
      // cleanup() can sweep them at close() time, the same as the
      // lock-winner path.
      return;
    }

    // No role tag even in the debug line: this lockless timeout can fire
    // after the peer hello was seen and acked but the peer's return ack
    // never arrived, where hello-filename order may make this party the
    // joiner, so the role is indeterminate here.
    deps.log().debug("synchronization has timed out");
    throw this.peerWaitTimeout(state);
  }

  // The lock poll loop (docs/spec/FILE_SYNC.md, Phase 1 -- rendezvous, lock
  // path): waits out a joiner's sentinel, then completes at whichever branch
  // the listing selects.
  private async waitForPeerViaLock(state: HelloExchangeState): Promise<void> {
    const { deps } = this;
    const { scope } = state;
    // Wall-clock instant this party first saw the joiner's mid-arrival
    // sentinel, paired with the sentinel name it belongs to (both undefined
    // when no sentinel is present). Reset whenever a peer hello appears, the
    // sentinel disappears, or a sentinel with a different name takes its
    // place, so a later or different joiner always starts a fresh window.
    let joiningSeenAt: number | undefined;
    let joiningSeenName: string | undefined;
    // open() set timeToLive before synchronize() can run, so the non-null
    // assertion is safe here.
    while (Date.now() <= deps.options().timeToLive!.getTime()) {
      deps.signal().throwIfAborted();
      const currentFiles = await this.listForWait(state);

      // isPeerHelloName excludes our own hello and a bare `-hello-<n>.json`
      // (empty id) injected after entry, which would otherwise slice to
      // peerId="" at the role-commit sites below.
      const otherFiles = currentFiles.filter((file) =>
        isPeerHelloName(file.name, deps.isOwnId),
      );
      const theseFiles = currentFiles.filter(
        (file) => file.name === this.ownControlName("hello"),
      );
      const lockFiles = currentFiles.filter((file) =>
        file.name.endsWith(LOCK_SUFFIX),
      );
      // A `<peerId>-joining-<n>.json` sentinel marks a joiner mid-arrival.
      // isPeerJoiningName excludes a self-named sentinel and a bare
      // `-joining-<n>.json` (empty id), so a planted empty-id sentinel does
      // not start the joiner-recovery (joinerRecoveryMs) window below.
      const joiningFiles = currentFiles.filter((file) =>
        isPeerJoiningName(file.name, deps.isOwnId),
      );

      if (otherFiles.length === 0) {
        if (joiningFiles.length > 0) {
          // Exactly one sentinel is the only valid mid-arrival state: a
          // second is third-party contamination, refused like a second peer
          // hello or lock.
          if (joiningFiles.length > 1) {
            throw new UsageError(
              `more than one joining sentinel in ` +
                `${redactPrivateKeyMaterial(scope.inboundPath)} - ` +
                "are there other sessions using this path?",
            );
          }
          // Joiner is mid-arrival: wait the bounded recovery window for its
          // rename to land, then fail with a transport error (exit 69). Never
          // re-create our own hello: that races the joiner's rename (I1).
          const joiningName = joiningFiles[0].name;
          const now = Date.now();
          // Start (or restart) the window on the first sighting, or whenever
          // the sentinel's name changes: a different peer id is a fresh
          // arrival, not a continuation of the one being timed, so it must
          // not inherit the earlier deadline.
          if (joiningSeenAt === undefined || joiningSeenName !== joiningName) {
            joiningSeenAt = now;
            joiningSeenName = joiningName;
            deps
              .log()
              .debug(
                `[${deps.role()}] peer is mid-arrival ` +
                  `(${redactAndSanitizeForDisplay(joiningName)}); awaiting completion`,
              );
          } else if (now - joiningSeenAt > deps.options().joinerRecoveryMs) {
            // The window is a lower bound, not exact: the check runs once
            // per poll after a delay(), so the abort fires somewhere in
            // (joinerRecoveryMs, joinerRecoveryMs + pollingFrequency].
            // Labelled [starter]: only the party that wrote its hello first
            // reaches this branch -- the joiner takes the entry fast-path --
            // even though `this.role` is not committed until rendezvous
            // succeeds.
            deps
              .log()
              .debug(
                "[starter] partner began arriving but did not complete " +
                  "within the recovery window",
              );
            throw new Error(
              `The partner began arriving ` +
                `(${redactPrivateKeyMaterial(joiningName)}) but did ` +
                "not complete within the recovery window; it appears to " +
                "have failed after announcing its arrival but before " +
                "writing its hello. Retry the exchange.",
            );
          }
        } else {
          // No sentinel: the joiner has not started, or a prior sighting
          // vanished without producing a hello (only a crash mid-cleanup
          // does this). Reset so a later sentinel starts a fresh window.
          joiningSeenAt = undefined;
          joiningSeenName = undefined;
          deps.log().trace(`[${deps.role()}] no peer hello found; polling`);
        }
        await deps.wait(deps.options().pollingFrequency);
        continue;
      }

      // A peer hello is present, so the recovery timer is stale. A sentinel
      // whose id matches the peer hello is the peer completing its arrival
      // and is tolerated; one matching no peer hello is a third party
      // (docs/spec/FILE_SYNC.md, Phase 1 -- rendezvous, lock path). No
      // joiningFiles.length > 1 guard is needed: two tolerated sentinels
      // need two peer hellos, refused below.
      const peerHelloIds = new Set(
        otherFiles.map((file) => controlWriterId(file.name)),
      );
      const foreignSentinel = joiningFiles.find(
        (file) => !peerHelloIds.has(controlWriterId(file.name)),
      );
      if (foreignSentinel) {
        throw new UsageError(
          `joining sentinel ${redactPrivateKeyMaterial(foreignSentinel.name)} ` +
            `in ${redactPrivateKeyMaterial(scope.inboundPath)} ` +
            "matches no peer hello - are there other sessions using " +
            "this path?",
        );
      }
      joiningSeenAt = undefined;
      joiningSeenName = undefined;

      if (lockFiles.length > 0) {
        await this.completeAtPeerLock(state, lockFiles, otherFiles, theseFiles);
        return;
      }

      if (otherFiles.length > 1) {
        throw new UsageError(
          `more than one peer hello file in ` +
            `${redactPrivateKeyMaterial(scope.inboundPath)} - are ` +
            "there other sessions using this path?",
        );
      }
      if (theseFiles.length === 0) {
        await this.completeAsResponder(state, otherFiles[0]);
        return;
      }
      await this.raceForLock(state, otherFiles[0], theseFiles);
      return;
    }

    // TTL expired while still waiting. Both throws below are tagged
    // [starter]: reaching here means no peer hello was ever seen (every
    // branch that observes one commits a role and returns), so the
    // waiter is the lone starter, never the joiner.
    //
    // A sentinel still visible on the final poll means a stuck mid-arrival
    // joiner whose sentinel appeared with less than joinerRecoveryMs left.
    // Both fields are tested: they are set and cleared as a pair, so
    // testing joiningSeenName too keeps that coupling type-enforced.
    if (joiningSeenAt !== undefined && joiningSeenName !== undefined) {
      deps
        .log()
        .debug(
          "[starter] partner began arriving but the exchange timed out " +
            "before it completed",
        );
      throw new Error(
        `The partner began arriving ` +
          `(${redactPrivateKeyMaterial(joiningSeenName)}) but the ` +
          "exchange timed out before it completed; it appears to have " +
          "failed after announcing its arrival but before writing its " +
          "hello. Retry the exchange.",
      );
    }
    deps.log().debug("[starter] synchronization has timed out");
    throw this.peerWaitTimeout(state);
  }

  /**
   * A ~ B list
   * A ~ B hello
   * A list
   * A lock
   * B list
   * B delete A hello, B hello, lock
   *
   * This is B
   */
  private async completeAtPeerLock(
    state: HelloExchangeState,
    lockFiles: FileInfo[],
    otherFiles: FileInfo[],
    theseFiles: FileInfo[],
  ): Promise<void> {
    const { deps } = this;
    const { scope, helloPath } = state;
    if (lockFiles.length > 1) {
      throw new UsageError(
        "more than one lock file - are there other sessions using " +
          "this path?",
      );
    }
    if (otherFiles.length !== 1) {
      throw new UsageError(
        "lock file detected but no peer hello - are there other " +
          "sessions using this path?",
      );
    }
    if (theseFiles.length !== 1) {
      throw new UsageError(
        "lock file detected but no self hello - are there other " +
          "sessions using this path?",
      );
    }

    const lockFile = lockFiles[0];
    const otherFile = otherFiles[0];
    const thisFile = theseFiles[0];

    const thisId = controlWriterId(thisFile.name);
    const otherId = controlWriterId(otherFile.name);

    // Hello filename order, the same tiebreak the lock producer uses, never
    // a raw `thisId < otherId` compare (docs/spec/FILE_SYNC.md, Invariants, I7).
    const arrivedFirst = thisFile.name < otherFile.name;
    const expectedLockName = arrivedFirst
      ? `${thisId}-${otherId}${LOCK_SUFFIX}`
      : `${otherId}-${thisId}${LOCK_SUFFIX}`;

    // Pair validation via reconstruct-and-compare. A stale lock from a
    // different id-pair that happens to concatenate to the same
    // <a>-<b>-lock.json string is a theoretical residual; the single-lock
    // guard above (lockFiles.length > 1) is the primary protection, so
    // the peer_id charset is left unrestricted rather than working
    // around this edge case here.
    if (lockFile.name !== expectedLockName)
      throw new Error("lock file does not reference this connection");

    // Read before committing roles and before the sweep below. A lock implies
    // both parties are lock parties, so a refusal needs a corrupt directory;
    // on one, the peer-written lock goes first (a transient, and safeDelete
    // cannot throw over the refusal), and our own hello stays for the peer.
    const refusal = await this.readPeerHello(
      scope.inboundPath,
      otherFile,
      peerHelloProvenance(otherFile.name, state.entryPeerHello),
    );
    if (refusal) {
      await deps
        .client()
        .safeDelete(joinFileSyncPath(scope.inboundPath, lockFile.name));
      throw refusal;
    }

    // first to arrive => should wait for first message
    deps.setHandshakeRole(arrivedFirst ? "responder" : "initiator");
    deps.setRole(deps.handshakeRole() === "initiator" ? "joiner" : "starter");
    deps.setPeerId(otherId, this.agreedHelloNames(otherFile.name));

    deps
      .log()
      .debug(
        `[${deps.role()}] parsed ${redactAndSanitizeForDisplay(lockFile.name)}`,
      );

    await deps
      .client()
      .safeDelete(joinFileSyncPath(scope.inboundPath, lockFile.name));
    await deps
      .client()
      .safeDelete(joinFileSyncPath(scope.inboundPath, otherFile.name));
    await deps.client().safeDelete(helloPath);

    if (!deps.options().retainFiles) deps.responsibleFiles.clear();
  }

  /**
   * A list
   * A hello
   * B list
   * B joining
   * B delete A hello
   * B rename joining -> B hello
   * A delete B hello
   *
   * This is A
   */
  private async completeAsResponder(
    state: HelloExchangeState,
    otherFile: FileInfo,
  ): Promise<void> {
    const { deps } = this;
    const { scope } = state;
    const otherPath = joinFileSyncPath(scope.inboundPath, otherFile.name);

    // Read before deleting the joiner's hello. Our own hello is gone, which
    // only a lock joiner does, so a refusal needs a corrupt directory; on
    // one, the peer-hello delete and the sweep are both skipped.
    const refusal = await this.readPeerHello(
      scope.inboundPath,
      otherFile,
      peerHelloProvenance(otherFile.name, state.entryPeerHello),
    );
    if (refusal) throw refusal;

    // arrived first, should wait for a message
    deps.setHandshakeRole("responder");
    deps.setRole("starter");
    deps.setPeerId(
      controlWriterId(otherFile.name),
      this.agreedHelloNames(otherFile.name),
    );

    deps
      .log()
      .debug(
        `[${deps.role()}] detected ${redactAndSanitizeForDisplay(otherFile.name)}; ` +
          `deleting it`,
      );

    await deps.client().safeDelete(otherPath);

    if (!deps.options().retainFiles) deps.responsibleFiles.clear();
  }

  // The two-hello collision: both hellos present and no lock yet.
  private async raceForLock(
    state: HelloExchangeState,
    otherFile: FileInfo,
    theseFiles: FileInfo[],
  ): Promise<void> {
    const { deps } = this;
    const { scope, helloPath } = state;
    if (theseFiles.length > 1) {
      throw new UsageError(
        `more than one self hello file in ` +
          `${redactPrivateKeyMaterial(scope.inboundPath)} - are ` +
          "there other sessions using this path?",
      );
    }

    const thisFile = theseFiles[0];

    // Tiebreak on hello filename order alone, never modifyTime, which sync
    // tools stamp with the transfer time (docs/spec/FILE_SYNC.md, Invariants, I7).
    const arrivedFirst = thisFile.name < otherFile.name;
    deps.setHandshakeRole(arrivedFirst ? "responder" : "initiator");
    deps.setRole(arrivedFirst ? "starter" : "joiner");
    deps.setPeerId(
      controlWriterId(otherFile.name),
      this.agreedHelloNames(otherFile.name),
    );

    // Read before racing a lock: a lockless peer's hello can coexist with our
    // lock hello here, so this mismatch is reachable, and checking first means
    // a mismatched pair never races a lock. On a refusal our own hello stays
    // for the lockless peer to read and refuse too.
    const refusal = await this.readPeerHello(
      scope.inboundPath,
      otherFile,
      peerHelloProvenance(otherFile.name, state.entryPeerHello),
    );
    if (refusal) throw refusal;

    const lockName =
      `${arrivedFirst ? deps.id() : deps.peerId()}-` +
      `${arrivedFirst ? deps.peerId() : deps.id()}${LOCK_SUFFIX}`;
    const lockPath = joinFileSyncPath(scope.inboundPath, lockName);
    state.lockPath = lockPath;

    deps
      .log()
      .debug(
        `[${deps.role()}] attempting to create ` +
          `${redactAndSanitizeForDisplay(lockName)}`,
      );

    // Pre-emptively track lockName in delete mode: if createExclusive
    // only partially succeeds (file created on server but handle-close
    // fails with a non-EEXIST error), cleanup() will still attempt
    // safeDelete even though the EEXIST handler's
    // responsibleFiles.clear() is never reached. Both EEXIST branches
    // below call responsibleFiles.clear(), which also removes this
    // pre-emptive entry.
    if (!deps.options().retainFiles) deps.responsibleFiles.add(lockName);
    try {
      await deps.client().createExclusive(lockPath);
      deps
        .log()
        .debug(
          `[${deps.role()}] created lock file ` +
            `${redactAndSanitizeForDisplay(lockName)}; waiting for ` +
            "peer to finalize handshake",
        );

      /**
       * A ~ B list
       * A ~ B hello
       * A ~ list
       * A ~ createExclusive lock
       * ...
       *
       * This is A
       */
    } catch (err: unknown) {
      /**
       * A ~ B list
       * A ~ B hello
       * A ~ B list
       * A createExclusive lock
       * B createExclusive lock, EEXIST
       * B delete A hello, B hello, lock
       *
       * This is B
       */
      if (
        !(err instanceof Error) ||
        (err as NodeJS.ErrnoException).code !== "EEXIST"
      )
        throw err;

      const lockAlreadyExists = await deps.client().exists(lockPath);

      if (!lockAlreadyExists) {
        // The winner never deletes the lock in its normal path, so a lock
        // gone after EEXIST means the winner crashed or abandoned the
        // handshake: fail fast rather than stall to inactivityTimeoutMs,
        // after removing both hellos (docs/spec/FILE_SYNC.md, Phase 1 --
        // terminal rendezvous failure, the abandoned-lock carve-out).
        await deps
          .client()
          .safeDelete(joinFileSyncPath(scope.inboundPath, otherFile.name));
        await deps.client().safeDelete(helloPath);
        if (!deps.options().retainFiles) deps.responsibleFiles.clear();
        throw new UsageError(
          "peer appears to have abandoned the handshake: lock file " +
            "was claimed by the peer but disappeared before this " +
            "side could complete synchronization. Retry the exchange.",
        );
      } else {
        deps
          .log()
          .debug(
            `[${deps.role()}] lock file creation failed, assuming race ` +
              "condition",
          );

        await deps.client().safeDelete(lockPath);
        await deps
          .client()
          .safeDelete(joinFileSyncPath(scope.inboundPath, otherFile.name));
        await deps.client().safeDelete(helloPath);

        if (!deps.options().retainFiles) deps.responsibleFiles.clear();
      }
    }
  }
}
