import { selectRunRelay, UsageError } from "@alcove/core";
import type {
  ConnectionConfig,
  RelayCredential,
  RunTurnServer,
  WebRTCConnectionConfig,
} from "@alcove/core";
import type { RTCIceServer } from "werift";

import {
  NO_RELAY_CANDIDATE_GATHERED,
  RELAY_NOT_REACHED_REMEDY,
} from "../connection/webrtc/iceDiagnostics";
import {
  ICE_PROVISION_REFUSAL,
  turnIceServer,
} from "../connection/webrtc/weriftPeer";
import type {
  DoctorCheckRecord,
  DoctorReport,
  RelayTransport,
} from "./verdict";
import { fail, ok } from "./verdict";

// `alcove doctor relay`: whether this host reaches each TURN relay a webrtc
// run lists, asked as the run's ICE gathering asks. It contacts those relays
// and nothing else -- no registrar, no coordination server -- and runs only
// when the operator names it. Contract: docs/spec/CLI_DOCTOR.md; operator
// page: docs/CLI.md, Checking the relay of a WebRTC exchange.

/**
 * The one bound on the whole check: every relay is asked at once, and one
 * that has given no relay candidate when it expires is reported as not
 * reached. An arbitrary working value; see docs/spec/CLI_DOCTOR.md, The relay
 * check.
 */
export const RELAY_CHECK_BOUND_MS = 30_000;

/** The refusal of a configuration whose channel is not webrtc. */
export const RELAY_CHECK_WEBRTC_ONLY =
  "doctor relay checks the relay of a WebRTC exchange only, and this " +
  "configuration's connection is not a webrtc one. Nothing was contacted.";

/** The refusal of a webrtc configuration that lists no TURN url. */
export const RELAY_CHECK_NO_TURN_URL =
  "this configuration lists no TURN url -- no connection.turn entry and no " +
  "turn url in connection.invitation_relay -- so there is no relay to " +
  "check. Nothing was contacted.";

/** One TURN url the check asks, with what it presents there. */
export interface RelayCheckTarget {
  server: RunTurnServer;
  transport: RelayTransport;
  iceServer: RTCIceServer;
}

/**
 * Ask one relay for a relay address, resolving whether a relay candidate was
 * gathered by the time gathering ended or `signal` aborted
 * (`gatherRelayCandidate` in the CLI's werift peer).
 */
export type RelayCandidateGathering = (
  server: RTCIceServer,
  signal: AbortSignal,
) => Promise<boolean>;

/**
 * The transport a TURN url names, read as the ICE layer reads it: `turns:` is
 * TLS, `turn:` is TCP where its first `transport` parameter says `tcp`, and
 * UDP otherwise.
 */
export function turnUrlTransport(url: string): RelayTransport {
  if (url.startsWith("turns:")) return "tls";
  const queryStart = url.indexOf("?");
  const query = queryStart === -1 ? "" : url.slice(queryStart + 1);
  return new URLSearchParams(query).get("transport") === "tcp" ? "tcp" : "udp";
}

/** A connection the check applies to, and the TURN urls a run of it lists. */
export interface RelayCheckSelection {
  connection: WebRTCConnectionConfig;
  turn: RunTurnServer[];
}

/**
 * The TURN urls a run of `connection` lists, in its order, refusing a
 * connection the check does not apply to: one that is not webrtc, one the run
 * itself refuses for `ice_provision`, and one that lists no TURN url.
 *
 * @throws {UsageError} for each refusal above.
 */
export function relayCheckSelection(
  connection: ConnectionConfig,
): RelayCheckSelection {
  if (connection.channel !== "webrtc")
    throw new UsageError(RELAY_CHECK_WEBRTC_ONLY);
  if (connection.iceProvision !== undefined)
    throw new UsageError(ICE_PROVISION_REFUSAL);
  const turn = selectRunRelay(connection).turn ?? [];
  if (turn.length === 0) throw new UsageError(RELAY_CHECK_NO_TURN_URL);
  return { connection, turn };
}

/**
 * What the check asks each url with: the entry's static pair, or the
 * credential the run mints, exactly as the run lists it.
 */
export function relayCheckTargets(
  turn: ReadonlyArray<RunTurnServer>,
  runRelayCredential: RelayCredential | undefined,
): RelayCheckTarget[] {
  return turn.map((server) => ({
    server,
    transport: turnUrlTransport(server.url),
    iceServer: turnIceServer(server, runRelayCredential),
  }));
}

const TRANSPORT_LABEL: Record<RelayTransport, string> = {
  udp: "UDP",
  tcp: "TCP",
  tls: "TLS",
};

function sourceLabel(server: RunTurnServer): string {
  return server.source === "invitation"
    ? "from your partner's invitation"
    : "from connection.turn";
}

/**
 * The lines printed before any request: every host the check contacts, and
 * what it does and does not do there. Raw: the urls are configuration text,
 * escaped where the lines are shown.
 */
export function relayHostStatement(
  targets: ReadonlyArray<RelayCheckTarget>,
): string[] {
  return [
    "This check contacts these relays and nothing else, asking each for a " +
      "relay address as an exchange run does:",
    ...targets.map(
      ({ server, transport }) =>
        `  ${server.url} over ${TRANSPORT_LABEL[transport]}, ${sourceLabel(server)}`,
    ),
    "It sends each relay the credential a run sends. It contacts no relay " +
      "registrar and enrolls nothing: a run enrolls just before it connects, " +
      "and this check asks only whether each relay answers.",
    "",
  ];
}

const NOT_REACHED_MEANING =
  "nothing on this host reached this relay, the relay refused the " +
  "credential, or it presented a certificate this host does not trust; " +
  "the reason is not reported, so the check cannot tell which.";

function notReachedMeaning(server: RunTurnServer): string {
  if (server.credential !== undefined) return NOT_REACHED_MEANING;
  return server.source === "invitation"
    ? `${NOT_REACHED_MEANING} This relay refuses the credential derived ` +
        "from the exchange's shared secret until a run has enrolled the " +
        "exchange's relay key there, which it does just before it connects."
    : `${NOT_REACHED_MEANING} This relay refuses the credential derived ` +
        "from the exchange's shared secret until the exchange's relay key " +
        "is enrolled there with alcove enroll-relay.";
}

function boundSeconds(boundMs: number): string {
  return `${Math.round(boundMs / 1000)} s`;
}

/** The check record for one url, given whether a relay candidate came back. */
export function relayCheckRecord(
  target: RelayCheckTarget,
  index: number,
  relayGathered: boolean,
  boundMs: number = RELAY_CHECK_BOUND_MS,
): DoctorCheckRecord {
  const id = `turn_${index + 1}`;
  const { server, transport } = target;
  const heading = `${server.url} over ${TRANSPORT_LABEL[transport]}`;
  const located = { url: server.url, transport };
  if (relayGathered)
    return ok(id, `${heading}: reached; the relay gave a relay address.`, {
      ...located,
    });
  return fail(
    id,
    `${heading}: ${NO_RELAY_CANDIDATE_GATHERED} within ${boundSeconds(boundMs)}.`,
    notReachedMeaning(server),
    RELAY_NOT_REACHED_REMEDY,
    located,
  );
}

/**
 * Ask every target at once under the one bound, and report each in the run's
 * order.
 */
export async function runRelayChecks(
  targets: ReadonlyArray<RelayCheckTarget>,
  gather: RelayCandidateGathering,
  boundMs: number = RELAY_CHECK_BOUND_MS,
): Promise<DoctorReport> {
  const bound = new AbortController();
  const timer = setTimeout(() => bound.abort(), boundMs);
  try {
    const gathered = await Promise.all(
      targets.map((target) => gather(target.iceServer, bound.signal)),
    );
    return {
      mode: "relay",
      checks: targets.map((target, index) =>
        relayCheckRecord(target, index, gathered[index] === true, boundMs),
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}
