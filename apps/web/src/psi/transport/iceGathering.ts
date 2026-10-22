import { ConnectionError } from "@alcove/core";

import { ALLOWED_RELAYS_REMEDY } from "./relayRestriction";
import { DEFAULT_RELAY_OFF_REMEDY } from "./defaultRelaySwitch";

import type { DataConnection } from "peerjs";

/**
 * What the browser reported while gathering ICE candidates for a data
 * connection, so a channel that never opens can name the relay that failed.
 * The browser reports a failed ICE server once, as an `icecandidateerror`
 * event, so the watch must attach before gathering starts: in the tick PeerJS
 * hands the connection out, since it gathers only after an asynchronous offer
 * or answer. test/browser/iceServerFailure.test.ts fails if that stops holding.
 */

/** One `icecandidateerror` the browser raised. */
export interface IceServerError {
  /** The ICE server url as the browser names it. */
  url: string;
  /** The STUN error code, or 701 where the server could not be reached. */
  errorCode: number;
  /** The browser's own description of the error. */
  errorText: string;
}

/** The candidates and errors one peer connection has reported so far. */
export interface IceGatheringRecord {
  /** `turn:` / `turns:` urls the peer connection was configured with. */
  turnUrls: ReadonlyArray<string>;
  /** Whether any local relay candidate was gathered. */
  relayGathered: boolean;
  /** Whether gathering finished. */
  gatheringComplete: boolean;
  /** Distinct url and code errors against a configured relay url, at most {@link MAX_RECORDED_ICE_ERRORS}. */
  turnErrors: Array<IceServerError>;
  /** The TURN urls the allowed relays left out of the run. */
  relaysLeftOut: ReadonlyArray<string>;
  /** Whether the run left out the build's default relay because it is
   * switched off in this browser. */
  defaultRelayOff: boolean;
}

/** What a run left out of the relays it lists. */
interface RunRelaysLeftOut {
  relaysLeftOut: ReadonlyArray<string>;
  defaultRelayOff: boolean;
}

/** How many relay errors one record keeps; a relay entry holds a few urls. */
export const MAX_RECORDED_ICE_ERRORS = 8;

/** How many relay servers one failure message names. */
const MAX_NAMED_SERVERS = 3;

/** Bound on the browser's error text as quoted in a failure message. */
const MAX_ERROR_TEXT_LENGTH = 200;

const records = new WeakMap<DataConnection, IceGatheringRecord>();

const relaysLeftOutByPeer = new WeakMap<object, RunRelaysLeftOut>();

/**
 * Record the TURN urls the allowed relays left out of the run `peer` serves,
 * and whether it left out the default relay because it is switched off, so a
 * connection of it that does not open names them.
 */
export function recordRelaysLeftOut(
  peer: object,
  relaysLeftOut: ReadonlyArray<string>,
  defaultRelayOff = false,
): void {
  relaysLeftOutByPeer.set(peer, { relaysLeftOut, defaultRelayOff });
}

function isTurnUrl(url: string): boolean {
  return /^turns?:/i.test(url);
}

/** The `turn:` / `turns:` urls a peer connection's configuration names. */
function configuredTurnUrls(pc: RTCPeerConnection): Array<string> {
  if (typeof pc.getConfiguration !== "function") return [];
  const servers = pc.getConfiguration().iceServers ?? [];
  return servers
    .flatMap((server) =>
      typeof server.urls === "string" ? [server.urls] : server.urls,
    )
    .filter(isTurnUrl);
}

/**
 * Whether `url` names one of `turnUrls`: as configured, or with the
 * `?transport=` suffix Chromium appends when it reports an error. Anything
 * else is not recorded, so a failure message names only configured relays.
 */
function isConfiguredTurnUrl(
  url: string,
  turnUrls: ReadonlyArray<string>,
): boolean {
  return turnUrls.some(
    (turnUrl) =>
      url === turnUrl ||
      url === `${turnUrl}?transport=udp` ||
      url === `${turnUrl}?transport=tcp`,
  );
}

/**
 * Start recording what `conn`'s peer connection gathers. Idempotent, and a
 * no-op for a connection with no peer connection.
 */
export function watchIceGathering(conn: DataConnection): void {
  if (records.has(conn)) return;
  // PeerJS types the field as always present, but its cleanup nulls it.
  const pc = conn.peerConnection as RTCPeerConnection | null | undefined;
  if (pc === null || pc === undefined) return;
  const record: IceGatheringRecord = {
    turnUrls: configuredTurnUrls(pc),
    relayGathered: false,
    gatheringComplete: pc.iceGatheringState === "complete",
    turnErrors: [],
    ...relaysLeftOutOf(conn),
  };
  records.set(conn, record);
  pc.addEventListener("icecandidate", (event) => {
    const { candidate } = event;
    if (candidate === null) record.gatheringComplete = true;
    else if (candidate.type === "relay") record.relayGathered = true;
  });
  pc.addEventListener("icegatheringstatechange", () => {
    if (pc.iceGatheringState === "complete") record.gatheringComplete = true;
  });
  pc.addEventListener("icecandidateerror", (event) => {
    const { url, errorCode, errorText } = event;
    if (typeof url !== "string" || !isConfiguredTurnUrl(url, record.turnUrls))
      return;
    const code = typeof errorCode === "number" ? errorCode : 0;
    if (
      record.turnErrors.some(
        (error) => error.url === url && error.errorCode === code,
      )
    )
      return;
    if (record.turnErrors.length >= MAX_RECORDED_ICE_ERRORS) return;
    record.turnErrors.push({
      url,
      errorCode: code,
      errorText: typeof errorText === "string" ? errorText : "",
    });
  });
}

/** @internal */
export function iceGatheringRecordFor(
  conn: DataConnection,
): IceGatheringRecord | undefined {
  return records.get(conn);
}

function describeCode(error: IceServerError): string {
  const text = error.errorText.trim().slice(0, MAX_ERROR_TEXT_LENGTH);
  return text === ""
    ? `error ${error.errorCode}`
    : `error ${error.errorCode}: ${text}`;
}

function describeFailures(
  errors: ReadonlyArray<IceServerError>,
): Array<string> {
  const byUrl = new Map<string, Map<number, string>>();
  for (const error of errors) {
    let codes = byUrl.get(error.url);
    if (codes === undefined) {
      codes = new Map();
      byUrl.set(error.url, codes);
    }
    if (!codes.has(error.errorCode))
      codes.set(error.errorCode, describeCode(error));
  }
  return [...byUrl].map(
    ([url, codes]) => `${url} (${[...codes.values()].join("; ")})`,
  );
}

function listNamed(items: ReadonlyArray<string>): string {
  const named = items.slice(0, MAX_NAMED_SERVERS).join("; ");
  const rest = items.length - MAX_NAMED_SERVERS;
  return rest > 0 ? `${named}; and ${rest} more` : named;
}

const RELAY_REMEDY =
  "Check that the relay address is correct and that this network allows " +
  "connections to it, then try again.";

/**
 * The message for a channel that did not open because no configured relay
 * gave a relay candidate, or `undefined` where the record does not show that:
 * no relay is configured, or a relay candidate was gathered.
 *
 * A relay the browser reported no error for is named only when `timedOut`, or
 * when gathering finished: an open that failed early for another reason can
 * end before a working relay has answered. Chromium was measured taking about
 * 40 seconds to report an unanswered UDP relay, past the open timeout.
 *
 * Where the allowed relays left TURN urls out of the run, the message names
 * them and {@link ALLOWED_RELAYS_REMEDY} after the relay failure, and where
 * the run left out the default relay because it is switched off,
 * {@link DEFAULT_RELAY_OFF_REMEDY}.
 *
 * The url and error text are raw here and escaped where the failure is shown.
 *
 * @internal
 */
export function relayFailureMessage(
  record: IceGatheringRecord,
  timedOut: boolean,
): string | undefined {
  const relayFailure = gatheringFailureMessage(record, timedOut);
  const leftOut = relaysLeftOutNote(record);
  return relayFailure === undefined || leftOut === undefined
    ? relayFailure
    : `${relayFailure} ${leftOut}`;
}

function relaysLeftOutNote({
  relaysLeftOut,
  defaultRelayOff,
}: RunRelaysLeftOut): string | undefined {
  const notes = [
    ...(relaysLeftOut.length > 0
      ? [
          `Your allowed relays left out ${listNamed([...new Set(relaysLeftOut)])}. ` +
            ALLOWED_RELAYS_REMEDY,
        ]
      : []),
    ...(defaultRelayOff ? [DEFAULT_RELAY_OFF_REMEDY] : []),
  ];
  return notes.length === 0 ? undefined : notes.join(" ");
}

const NOTHING_LEFT_OUT: RunRelaysLeftOut = {
  relaysLeftOut: [],
  defaultRelayOff: false,
};

/** What the run `conn` belongs to left out of its relays. */
function relaysLeftOutOf(conn: DataConnection): RunRelaysLeftOut {
  // PeerJS types the provider as always present; a test double may lack it.
  const provider = conn.provider as object | undefined;
  return provider === undefined
    ? NOTHING_LEFT_OUT
    : (relaysLeftOutByPeer.get(provider) ?? NOTHING_LEFT_OUT);
}

// The note is added to `failure` itself, so it keeps its class and kind and
// the caller redacts its message as it would have.
function withNoteAdded(failure: Error, note: string): Error {
  const separator = /[.!?]$/.test(failure.message) ? " " : ". ";
  const message = `${failure.message}${separator}${note}`;
  try {
    failure.message = message;
    return failure;
  } catch {
    // A read-only `message`: a copy of the same kind, without the cause.
    if (failure instanceof ConnectionError)
      return new ConnectionError(message, failure.kind);
    const copy = new Error(message);
    copy.name = failure.name;
    return copy;
  }
}

function gatheringFailureMessage(
  record: IceGatheringRecord,
  timedOut: boolean,
): string | undefined {
  if (record.turnUrls.length === 0 || record.relayGathered) return undefined;
  const lead = "The connection did not open: no relay candidate was gathered.";
  if (record.turnErrors.length > 0) {
    const failures = describeFailures(record.turnErrors);
    const subject =
      record.turnErrors.length === 1
        ? `The browser reported an error for relay server ${failures[0]}.`
        : failures.length === 1
          ? `The browser reported errors for relay server ${failures[0]}.`
          : `The browser reported errors for relay servers ${listNamed(failures)}.`;
    return `${lead} ${subject} ${RELAY_REMEDY}`;
  }
  if (!timedOut && !record.gatheringComplete) return undefined;
  const servers = [...new Set(record.turnUrls)];
  const subject =
    servers.length === 1
      ? `Relay server ${servers[0]} did not give a relay address.`
      : `Relay servers ${listNamed(servers)} did not give a relay address.`;
  return `${lead} ${subject} ${RELAY_REMEDY}`;
}

/**
 * `failure` as the error an unopened `conn` rejects with: a `transport`
 * {@link ConnectionError} naming the failed relay where
 * {@link relayFailureMessage} finds one; else `failure` with the relays the
 * allowed relays left out and {@link ALLOWED_RELAYS_REMEDY} added to its
 * message where the run left any out, and {@link DEFAULT_RELAY_OFF_REMEDY}
 * where it left out the default relay switched off, whether or not `conn`
 * was watched; else `failure` unchanged.
 * `timedOut` says the open ran out its time rather than failing early.
 * `failure` is not kept as a cause: a PeerJS negotiation error names the
 * remote rendezvous id, and the callers redact only the error they throw.
 */
export function withIceServerFailure(
  conn: DataConnection,
  failure: Error,
  timedOut: boolean,
): Error {
  const record = records.get(conn);
  if (record !== undefined) {
    const message = relayFailureMessage(record, timedOut);
    if (message !== undefined) return new ConnectionError(message, "transport");
  }
  return withRelaysLeftOut(record ?? relaysLeftOutOf(conn), failure);
}

/**
 * `failure`, from the run `peer` serves when no connection of it is open,
 * with the notes {@link withIceServerFailure} adds for what the run left out
 * of its relays; else `failure` unchanged. Its class and kind are kept.
 */
export function withPeerRelaysLeftOut(peer: object, failure: Error): Error {
  return withRelaysLeftOut(
    relaysLeftOutByPeer.get(peer) ?? NOTHING_LEFT_OUT,
    failure,
  );
}

function withRelaysLeftOut(leftOut: RunRelaysLeftOut, failure: Error): Error {
  const note = relaysLeftOutNote(leftOut);
  return note === undefined ? failure : withNoteAdded(failure, note);
}
