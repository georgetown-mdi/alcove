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
import { fail, ok, skipped, warn } from "./verdict";

// `alcove doctor relay`: whether this host reaches the TURN relay a webrtc run
// allocates on, asked as the run's ICE gathering asks. It contacts exactly the
// relay hosts a run of the configuration contacts: the first TURN url the run
// lists, and the invitation's registrar only where the run enrolls there. It
// runs only when the operator names it. Contract: docs/spec/CLI_DOCTOR.md;
// operator page: docs/CLI.md, Checking the relay of a WebRTC exchange.

/**
 * The one bound on the relay request: a relay that has given no relay
 * candidate when it expires is reported as not reached. An arbitrary working
 * value; see docs/spec/CLI_DOCTOR.md, The relay check.
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

/** The TURN url the check asks, with what it presents there. */
export interface RelayCheckTarget {
  server: RunTurnServer;
  transport: RelayTransport;
  iceServer: RTCIceServer;
}

/** The registrar `invitation_relay` names, and whether a run enrolls there. */
export interface RelayCheckRegistrar {
  url: string;
  /** `runEnrollsAtInvitationRegistrar` for the configuration. */
  contacted: boolean;
}

/** What the check contacts, and what a run lists that it does not. */
export interface RelayCheckPlan {
  /** The first TURN url a run lists: the one it allocates on. */
  contacted: RelayCheckTarget;
  /** Every later TURN url a run lists, in its order; none is contacted. */
  notContacted: RunTurnServer[];
  /** Absent where the configuration's `invitation_relay` names no registrar. */
  registrar?: RelayCheckRegistrar;
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

/**
 * The connection the check applies to, refusing one it does not: one that is
 * not webrtc, one the run itself refuses for `ice_provision`, and one that
 * lists no TURN url.
 *
 * @throws {UsageError} for each refusal above.
 */
export function relayCheckConnection(
  connection: ConnectionConfig,
): WebRTCConnectionConfig {
  if (connection.channel !== "webrtc")
    throw new UsageError(RELAY_CHECK_WEBRTC_ONLY);
  if (connection.iceProvision !== undefined)
    throw new UsageError(ICE_PROVISION_REFUSAL);
  if ((selectRunRelay(connection).turn ?? []).length === 0)
    throw new UsageError(RELAY_CHECK_NO_TURN_URL);
  return connection;
}

/**
 * What the check contacts for `connection`, as a run of it does: the first
 * TURN url the run lists, presented the entry's static pair or else the
 * credential the run mints, and the invitation's registrar where the run
 * enrolls there.
 *
 * @throws {Error} if the connection lists no TURN url, which
 *   {@link relayCheckConnection} refuses first.
 */
export function relayCheckPlan(
  connection: Pick<WebRTCConnectionConfig, "stun" | "turn" | "invitationRelay">,
  runRelayCredential: RelayCredential | undefined,
): RelayCheckPlan {
  const [first, ...rest] = selectRunRelay(connection).turn ?? [];
  if (first === undefined)
    throw new InternalConsistencyError(
      "relayCheckPlan: the relay check was given no TURN url",
    );
  const registrar = connection.invitationRelay?.registrar;
  return {
    contacted: {
      server: first,
      transport: turnUrlTransport(first.url),
      iceServer: turnIceServer(first, runRelayCredential),
    },
    notContacted: rest,
    ...(registrar !== undefined && {
      registrar: {
        url: registrar,
        contacted: runEnrollsAtInvitationRegistrar(connection),
      },
    }),
  };
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

const LATER_URL_NOT_CONTACTED =
  "a run allocates on the first TURN url it lists alone";

const REGISTRAR_NAMED = "The relay registrar your partner's invitation names";

function capitalized(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** Why a run of the configuration does not enroll at the registrar. */
function registrarNotContactedReason(plan: RelayCheckPlan): string {
  return plan.contacted.server.credential !== undefined
    ? "the relay it allocates on is sent its connection.turn entry's own " +
        "credential"
    : "the relay it allocates on is not one the invitation names";
}

/**
 * The lines printed before any request: the hosts the check contacts, then
 * each host the configuration names that a run of it, and so the check, does
 * not contact, with the reason. Raw: the urls and the registrar are
 * configuration text, escaped where the lines are shown. Each host is on a
 * line of its own and each explanation on the lines below it, every one short
 * of the display bound that cuts a longer line.
 */
export function relayHostStatement(
  plan: RelayCheckPlan,
  connection: Pick<WebRTCConnectionConfig, "invitationRelay">,
): string[] {
  const { contacted, notContacted, registrar } = plan;
  const lines = [
    "This check contacts these hosts, as a run of this configuration does:",
    `  ${contacted.server.url} over ${TRANSPORT_LABEL[contacted.transport]}, ` +
      sourceLabel(contacted.server),
    "    The relay a run allocates on. The check asks it for a relay " +
      "address, sending the credential a run sends there.",
  ];
  if (registrar?.contacted === true)
    lines.push(
      `  ${registrar.url}`,
      `    ${REGISTRAR_NAMED}. Before it asks the relay, the check enrolls ` +
        "this exchange's relay key there, as a run does just before it " +
        "connects.",
      "    Whoever runs that registrar learns this machine's network address.",
    );
  const skippedRegistrar =
    registrar?.contacted === false ? registrar : undefined;
  if (notContacted.length > 0 || skippedRegistrar !== undefined)
    lines.push(
      "It does not contact these hosts, because a run of this configuration " +
        "does not:",
      ...notContacted.flatMap((server) => [
        `  ${server.url}, ${sourceLabel(server)}`,
        `    ${capitalized(LATER_URL_NOT_CONTACTED)}.`,
      ]),
      ...(skippedRegistrar === undefined
        ? []
        : [
            `  ${skippedRegistrar.url}`,
            `    ${REGISTRAR_NAMED}. A run does not enroll there, because ` +
              `${registrarNotContactedReason(plan)}.`,
          ]),
    );
  lines.push(
    connection.invitationRelay !== undefined && registrar === undefined
      ? "It contacts nothing else. This configuration's invitation_relay " +
          "names no relay registrar, so it contacts none and enrolls nothing."
      : "It contacts nothing else.",
    "",
  );
  return lines;
}

/** The id of the enrollment's check line. */
export const ENROLLMENT_CHECK_ID = "enrollment";

/**
 * The enrollment the check made at the invitation relay's registrar before
 * it asked the relay. Never cancelled: the check passes no signal.
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
export async function enrollBeforeRelayCheck(
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
  "this same enrollment just before it connects, because the relay it " +
  "allocates on is one your partner's invitation names.";

/** What to do about a failed enrollment. */
export const ENROLLMENT_FAILED_ACTION =
  "Run this check again. If the enrollment keeps failing, ask your partner " +
  "whether the relay registrar their invitation names is up. A run goes on " +
  "without this enrollment, but the relay your partner's invitation names " +
  "refuses the run's credential until either of you enrolls the exchange " +
  "there.";

/**
 * The check line of the enrollment. A failed one is a `warn`: the enrollment
 * serves the relay a run allocates on, whose own line has the consequence.
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

/** The check line of a registrar a run of the configuration does not enroll at. */
function registrarNotContactedRecord(plan: RelayCheckPlan): DoctorCheckRecord {
  const registrar = plan.registrar?.url;
  if (registrar === undefined)
    throw new InternalConsistencyError(
      "registrarNotContactedRecord: the configuration names no registrar",
    );
  return skipped(
    ENROLLMENT_CHECK_ID,
    `the relay registrar at ${registrar} that your partner's invitation ` +
      "names: not contacted.",
    {
      meaning:
        "a run of this configuration does not enroll at this registrar, " +
        `because ${registrarNotContactedReason(plan)}, so the check does ` +
        "not contact it.",
      registrar,
    },
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
  if (enrollment !== undefined)
    return enrollment.outcome.kind === "enrolled"
      ? NOT_REACHED_MEANING
      : `${NOT_REACHED_MEANING} The likely cause is the failed enrollment ` +
          "above: this relay refuses the credential derived from the " +
          "exchange's shared secret until the exchange's relay key is " +
          "enrolled at its registrar.";
  if (server.source === "invitation")
    return (
      `${NOT_REACHED_MEANING} This relay refuses the credential derived ` +
      "from the exchange's shared secret until the exchange's relay key " +
      "is enrolled there."
    );
  return (
    `${NOT_REACHED_MEANING} A relay that takes enrolled keys refuses the ` +
    "credential derived from the exchange's shared secret until the " +
    "exchange's relay key is enrolled there with alcove enroll-relay."
  );
}

function boundSeconds(boundMs: number): string {
  return `${Math.round(boundMs / 1000)} s`;
}

/**
 * The check record of the relay a run allocates on, given whether a relay
 * candidate came back and the enrollment made before it was asked, if any.
 */
export function relayCheckRecord(
  target: RelayCheckTarget,
  relayGathered: boolean,
  boundMs: number = RELAY_CHECK_BOUND_MS,
  enrollment?: RelayCheckEnrollment,
): DoctorCheckRecord {
  const id = "turn_1";
  const { server, transport } = target;
  const heading = `${server.url} over ${TRANSPORT_LABEL[transport]}, the relay a run allocates on`;
  const located = { url: server.url, transport };
  if (relayGathered)
    return ok(
      id,
      `${heading}: reached; the relay gave a relay address.`,
      located,
    );
  return fail(
    id,
    `${heading}: ${NO_RELAY_CANDIDATE_GATHERED} within ${boundSeconds(boundMs)}.`,
    notReachedMeaning(server, enrollment),
    RELAY_NOT_REACHED_REMEDY,
    located,
  );
}

const LATER_URL_NOT_CONTACTED_MEANING =
  `a run of this configuration does not contact this relay: ` +
  `${LATER_URL_NOT_CONTACTED}, so the check does not ask it.`;

/** What to do about a later url the check did not contact. */
export const NOT_CONTACTED_ACTION =
  "If this relay should be the one a run allocates on, list it first under " +
  "connection.turn and run this check again.";

function laterUrlRecord(
  server: RunTurnServer,
  index: number,
): DoctorCheckRecord {
  return skipped(
    `turn_${index + 2}`,
    `${server.url}, listed after the relay a run allocates on: not contacted.`,
    {
      meaning: LATER_URL_NOT_CONTACTED_MEANING,
      action: NOT_CONTACTED_ACTION,
      url: server.url,
      transport: turnUrlTransport(server.url),
    },
  );
}

/**
 * Ask the relay a run allocates on under the one bound, and report it after
 * the registrar's line, if the configuration names a registrar, and before a
 * `skipped` line for each later url. `enrollment` is the one made before the
 * request, present exactly where the plan's registrar is contacted.
 */
export async function runRelayCheck(
  plan: RelayCheckPlan,
  gather: RelayCandidateGathering,
  boundMs: number = RELAY_CHECK_BOUND_MS,
  enrollment?: RelayCheckEnrollment,
): Promise<DoctorReport> {
  if ((plan.registrar?.contacted === true) !== (enrollment !== undefined))
    throw new InternalConsistencyError(
      "runRelayCheck: an enrollment is given exactly where a run enrolls",
    );
  const bound = new AbortController();
  const timer = setTimeout(() => bound.abort(), boundMs);
  try {
    const gathered = await gather(plan.contacted.iceServer, bound.signal);
    const registrarRecords =
      enrollment !== undefined
        ? [enrollmentCheckRecord(enrollment)]
        : plan.registrar !== undefined
          ? [registrarNotContactedRecord(plan)]
          : [];
    return {
      mode: "relay",
      checks: [
        ...registrarRecords,
        relayCheckRecord(plan.contacted, gathered, boundMs, enrollment),
        ...plan.notContacted.map(laterUrlRecord),
      ],
    };
  } finally {
    clearTimeout(timer);
    bound.abort();
  }
}
