import {
  InternalConsistencyError,
  runEnrollsAtInvitationRegistrar,
  selectRunRelay,
  UsageError,
} from "@alcove/core";
import type {
  ConnectionConfig,
  RelayCredential,
  RunTurnServer,
  WebRTCConnectionConfig,
} from "@alcove/core";
import type { RTCIceServer } from "werift";

import { NO_RELAY_CANDIDATE_GATHERED } from "../connection/webrtc/iceDiagnostics";
import {
  ICE_PROVISION_REFUSAL,
  turnIceServer,
} from "../connection/webrtc/weriftPeer";
import {
  enrollAtInvitationRelay,
  invitationRelayEnrolledNotice,
  invitationRelayNotEnrolledStatement,
} from "../invitationRelayEnrollment";
import type { InvitationRelayEnrollment } from "../invitationRelayEnrollment";
import type {
  DoctorCheckRecord,
  DoctorReport,
  RelayTransport,
} from "./verdict";
import { fail, ok, warn } from "./verdict";

// `alcove doctor relay`: whether this host reaches each TURN relay a webrtc
// run lists, asked as the run's ICE gathering asks. werift allocates on the
// first TURN url a peer is given and ignores the rest, so only the first url's
// outcome decides the verdict. Before it asks them it enrolls at the registrar
// the invitation's relay names, as a run does before it dials when that relay
// is the one it allocates on; it contacts nothing else, and runs only when the
// operator names it. Contract:
// docs/spec/CLI_DOCTOR.md; operator page: docs/CLI.md, Checking the relay of a
// WebRTC exchange.

/**
 * The one bound on the whole check: every relay is asked at once, and one
 * that has given no relay candidate when it expires is reported as not
 * reached. An arbitrary working value; see docs/spec/CLI_DOCTOR.md, The relay
 * check.
 */
export const RELAY_CHECK_BOUND_MS = 30_000;

/**
 * What to do when no relay candidate was gathered from a configured relay,
 * as docs/CLI.md, When a WebRTC exchange does not connect, states it.
 */
export const RELAY_NOT_REACHED_REMEDY =
  "Fix the relay, or arrange a direct path; waiting longer changes nothing.";

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

// werift retries a failed UDP allocation over TCP to the same host and port,
// for a url naming `?transport=udp` as for one naming no transport
// (test/integration/webrtc/doctorRelayGathering.test.ts).
const TRANSPORT_LABEL: Record<RelayTransport, string> = {
  udp: "UDP, then TCP",
  tcp: "TCP",
  tls: "TLS",
};

function sourceLabel(server: RunTurnServer): string {
  return server.source === "invitation"
    ? "from your partner's invitation"
    : "from connection.turn";
}

/**
 * The lines printed before any request: every host the check contacts, which
 * url a run allocates on, which hosts a run of this configuration does not
 * contact, and what the check does and does not do there. Raw: the urls and
 * the registrar are configuration text, escaped where the lines are shown.
 */
export function relayHostStatement(
  targets: ReadonlyArray<RelayCheckTarget>,
  connection: Pick<WebRTCConnectionConfig, "stun" | "turn" | "invitationRelay">,
): string[] {
  const allocating = targets[0];
  if (allocating === undefined)
    throw new InternalConsistencyError(
      "relayHostStatement: the relay check was given no TURN url",
    );
  const registrar = connection.invitationRelay?.registrar;
  const relays = [
    "This check contacts these relays, asking each for a relay address:",
    ...targets.map(
      ({ server, transport }, index) =>
        `  ${server.url} over ${TRANSPORT_LABEL[transport]}, ${sourceLabel(server)}` +
        (index === 0
          ? ""
          : "; a run of this configuration does not contact it, and the " +
            "check asks it so you can see whether listing it first would work"),
    ),
    ...(targets.length === 1
      ? ["A run allocates on this relay."]
      : [
          `A run allocates on the first of them alone, ${allocating.server.url}.`,
        ]),
    "It sends each relay the credential a run sends.",
  ];
  if (registrar === undefined)
    return [
      ...relays,
      "It contacts nothing else. This configuration's invitation_relay " +
        "names no relay registrar, so it contacts none and enrolls nothing.",
      "",
    ];
  return [
    ...relays,
    runEnrollsAtInvitationRegistrar(connection)
      ? "Before it asks them, it enrolls this exchange's relay key at the " +
        "relay registrar your partner's invitation names, as a run does " +
        "just before it connects when that relay is the one it allocates on:"
      : "A run of this configuration does not contact the relay registrar " +
        "your partner's invitation names. This check contacts it only " +
        "because you asked for the check, so that the invitation's relay " +
        "can be asked: before it asks the relays, it enrolls this " +
        "exchange's relay key there:",
    `  ${registrar}`,
    "Whoever runs that registrar learns this machine's network address. " +
      "It contacts nothing else.",
    "",
  ];
}

/** The id of the enrollment's check line. */
export const ENROLLMENT_CHECK_ID = "enrollment";

/**
 * The enrollment the check made at the invitation relay's registrar before
 * it asked the relays. Never cancelled: the check passes no signal.
 */
export interface RelayCheckEnrollment {
  registrar: string;
  outcome: Exclude<InvitationRelayEnrollment, { kind: "cancelled" }>;
}

/**
 * Enroll at `registrar` as a run does before it dials
 * ({@link enrollAtInvitationRelay}): one attempt without a token, under the
 * run's wait.
 */
export async function enrollBeforeRelayChecks(
  registrar: string,
  sharedSecret: string,
  fetch: typeof globalThis.fetch | undefined,
): Promise<RelayCheckEnrollment> {
  const outcome = await enrollAtInvitationRelay(
    registrar,
    sharedSecret,
    fetch === undefined ? {} : { fetch },
  );
  if (outcome.kind === "cancelled")
    throw new InternalConsistencyError(
      "the relay check's enrollment was cancelled with no signal to cancel it",
    );
  return { registrar, outcome };
}

const ENROLLMENT_FAILED_MEANING =
  "the registrar did not record this exchange's relay key. A run makes " +
  "this same enrollment just before it connects when the relay your " +
  "partner's invitation names is the one it allocates on.";

/** What to do about a failed enrollment. */
export const ENROLLMENT_FAILED_ACTION =
  "Run this check again. If the enrollment keeps failing, ask your partner " +
  "whether the relay registrar their invitation names is up. A run goes on " +
  "without this enrollment, but the relay your partner's invitation names " +
  "refuses the run's credential until either of you enrolls the exchange " +
  "there.";

/**
 * The check line of the enrollment. A failed one is a `warn`: the enrollment
 * serves the invitation's relay, whose own line has the consequence.
 */
export function enrollmentCheckRecord(
  enrollment: RelayCheckEnrollment,
): DoctorCheckRecord {
  const { registrar, outcome } = enrollment;
  if (outcome.kind === "enrolled")
    return ok(
      ENROLLMENT_CHECK_ID,
      `${invitationRelayEnrolledNotice(registrar, outcome.lapsesAt)}.`,
      {
        registrar,
        ...(outcome.lapsesAt !== null && { lapses_at: outcome.lapsesAt }),
      },
    );
  return warn(
    ENROLLMENT_CHECK_ID,
    invitationRelayNotEnrolledStatement(registrar, outcome.detail),
    ENROLLMENT_FAILED_MEANING,
    ENROLLMENT_FAILED_ACTION,
    { registrar },
  );
}

const NOT_REACHED_MEANING =
  "nothing on this host reached this relay, the relay refused the " +
  "credential, or it presented a certificate this host does not trust; " +
  "the reason is not reported, so the check cannot tell which.";

function notReachedMeaning(
  server: RunTurnServer,
  enrollment: RelayCheckEnrollment | undefined,
): string {
  if (server.credential !== undefined) return NOT_REACHED_MEANING;
  if (server.source !== "invitation")
    return (
      `${NOT_REACHED_MEANING} A relay that takes enrolled keys refuses the ` +
      "credential derived from the exchange's shared secret until the " +
      "exchange's relay key is enrolled there with alcove enroll-relay."
    );
  if (enrollment === undefined)
    return (
      `${NOT_REACHED_MEANING} This relay refuses the credential derived ` +
      "from the exchange's shared secret until the exchange's relay key " +
      "is enrolled there."
    );
  if (enrollment.outcome.kind === "enrolled") return NOT_REACHED_MEANING;
  return (
    `${NOT_REACHED_MEANING} The likely cause is the failed enrollment ` +
    "above: this relay refuses the credential derived from the exchange's " +
    "shared secret until the exchange's relay key is enrolled at its " +
    "registrar."
  );
}

function boundSeconds(boundMs: number): string {
  return `${Math.round(boundMs / 1000)} s`;
}

const NOT_ALLOCATED_MEANING =
  "a run allocates on the first TURN url it lists alone, so it does not " +
  "allocate on this relay, and this result does not block a run as " +
  "configured.";

/** What to do about a later url that was not reached. */
export const NOT_ALLOCATED_ACTION =
  "If this relay should be the one a run allocates on, list it first under " +
  "connection.turn and run this check again.";

function capitalized(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * The check record for one url, given whether a relay candidate came back and
 * the enrollment made before it was asked, if any. The url at `index` 0 is the
 * one a run allocates on, and only its miss is a `fail`; a later url's miss is
 * a `warn`.
 */
export function relayCheckRecord(
  target: RelayCheckTarget,
  index: number,
  relayGathered: boolean,
  boundMs: number = RELAY_CHECK_BOUND_MS,
  enrollment?: RelayCheckEnrollment,
): DoctorCheckRecord {
  const id = `turn_${index + 1}`;
  const { server, transport } = target;
  const allocating = index === 0;
  const heading =
    `${server.url} over ${TRANSPORT_LABEL[transport]}, ` +
    (allocating
      ? "the relay a run allocates on"
      : "listed but not allocated on by a run");
  const located = { url: server.url, transport };
  if (relayGathered)
    return ok(
      id,
      `${heading}: reached; the relay gave a relay address.`,
      located,
    );
  const summary = `${heading}: ${NO_RELAY_CANDIDATE_GATHERED} within ${boundSeconds(boundMs)}.`;
  const meaning = notReachedMeaning(server, enrollment);
  if (allocating)
    return fail(id, summary, meaning, RELAY_NOT_REACHED_REMEDY, located);
  return warn(
    id,
    summary,
    `${NOT_ALLOCATED_MEANING} ${capitalized(meaning)}`,
    NOT_ALLOCATED_ACTION,
    located,
  );
}

/**
 * Ask every target at once under the one bound, and report each in the run's
 * order, after the line of the enrollment made before them, if any.
 */
export async function runRelayChecks(
  targets: ReadonlyArray<RelayCheckTarget>,
  gather: RelayCandidateGathering,
  boundMs: number = RELAY_CHECK_BOUND_MS,
  enrollment?: RelayCheckEnrollment,
): Promise<DoctorReport> {
  const bound = new AbortController();
  const timer = setTimeout(() => bound.abort(), boundMs);
  try {
    const gathered = await Promise.all(
      targets.map((target) => gather(target.iceServer, bound.signal)),
    );
    return {
      mode: "relay",
      checks: [
        ...(enrollment === undefined
          ? []
          : [enrollmentCheckRecord(enrollment)]),
        ...targets.map((target, index) =>
          relayCheckRecord(
            target,
            index,
            gathered[index] === true,
            boundMs,
            enrollment,
          ),
        ),
      ],
    };
  } finally {
    clearTimeout(timer);
    bound.abort();
  }
}
