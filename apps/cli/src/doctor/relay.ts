import {
  InternalConsistencyError,
  LATER_TURN_URL_NOT_CONTACTED,
  RELAY_CHECK_BOUND_MS,
  RELAY_CHECK_ENROLLMENT_ID,
  registrarNotContactedReason,
  relayCheckHeadline,
  relayCheckPlan as relayCheckHostPlan,
  selectRunRelay,
  turnUrlTransport,
  UsageError,
} from "@alcove/core";
import type {
  ConnectionConfig,
  RelayCheckContact,
  RelayCheckHeadlineOptions,
  RelayCheckPlan as RelayCheckHostPlan,
  RelayCredential,
  RunRelayConnection,
  RunTurnServer,
  WebRTCConnectionConfig,
} from "@alcove/core";
import type { RTCIceServer } from "werift";

import {
  ICE_PROVISION_REFUSAL,
  turnIceServer,
} from "../connection/webrtc/weriftPeer";
import { enrollAtInvitationRelay } from "../invitationRelayEnrollment";
import type { InvitationRelayEnrollment } from "../invitationRelayEnrollment";
import type { DoctorCheck, DoctorCheckRecord, DoctorReport } from "./verdict";

// `alcove doctor relay`: whether this host reaches the TURN relay a webrtc run
// allocates on, asked as the run's ICE gathering asks. It contacts exactly the
// relay hosts a run of the configuration contacts: the first TURN url the run
// lists, and the invitation's registrar only where the run enrolls there. It
// runs only when the operator names it. The plan, the host statement and each
// check's headline are composed in core (relayCheck.ts).
// Contract: docs/spec/CLI_DOCTOR.md; operator page: docs/CLI.md, Checking the
// relay of a WebRTC exchange.

export { turnUrlTransport };

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

/**
 * The refusal of a webrtc configuration whose every TURN url
 * `allowed_relays` leaves out, naming them; raw, escaped where shown.
 */
export function relayCheckAllLeftOutMessage(
  leftOut: ReadonlyArray<RunTurnServer>,
): string {
  return (
    `connection.allowed_relays leaves out every TURN url this configuration ` +
    `lists (${leftOut.map((server) => server.url).join(", ")}), so a run ` +
    "contacts no relay and there is none to check. Nothing was contacted."
  );
}

/** The TURN url the check asks, with what it presents there. */
export interface RelayCheckTarget extends RelayCheckContact {
  iceServer: RTCIceServer;
}

/** Core's plan, with what the check presents to the url it asks. */
export interface RelayCheckPlan extends RelayCheckHostPlan {
  contacted: RelayCheckTarget;
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
  const { turn, turnLeftOut } = selectRunRelay(connection);
  if ((turn ?? []).length === 0)
    throw new UsageError(
      turnLeftOut === undefined
        ? RELAY_CHECK_NO_TURN_URL
        : relayCheckAllLeftOutMessage(turnLeftOut),
    );
  return connection;
}

/**
 * What the check contacts for `connection` ({@link relayCheckHostPlan}), with
 * what it presents to the first TURN url: the entry's static pair or else the
 * credential the run mints.
 *
 * @throws {Error} if the connection lists no TURN url, which
 *   {@link relayCheckConnection} refuses first.
 */
export function relayCheckPlan(
  connection: RunRelayConnection,
  runRelayCredential: RelayCredential | undefined,
): RelayCheckPlan {
  const plan = relayCheckHostPlan(connection);
  return {
    ...plan,
    contacted: {
      ...plan.contacted,
      iceServer: turnIceServer(plan.contacted.server, runRelayCredential),
    },
  };
}

/**
 * The record of `check`, its summary the headline core composes from the
 * check's own `--json` fields.
 */
function withHeadline(
  check: DoctorCheck,
  options?: RelayCheckHeadlineOptions,
): DoctorCheckRecord {
  const summary = relayCheckHeadline(check, options);
  if (summary === undefined)
    throw new InternalConsistencyError(
      `the relay check composed no headline for its ${check.id} check`,
    );
  return { ...check, summary };
}

/** The id of the enrollment's check line. */
export const ENROLLMENT_CHECK_ID = RELAY_CHECK_ENROLLMENT_ID;

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
  "this same enrollment just before it connects, because it uses a TURN " +
  "relay or a WebSocket relay that your partner's invitation names.";

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
    return withHeadline({
      id: ENROLLMENT_CHECK_ID,
      status: "ok",
      registrar,
      ...(outcome.lapsesAt !== null && { lapses_at: outcome.lapsesAt }),
    });
  return withHeadline(
    {
      id: ENROLLMENT_CHECK_ID,
      status: "warn",
      meaning: ENROLLMENT_FAILED_MEANING,
      action: ENROLLMENT_FAILED_ACTION,
      registrar,
    },
    { registrarAnswer: outcome.detail },
  );
}

/** The check line of a registrar a run of the configuration does not enroll at. */
function registrarNotContactedRecord(plan: RelayCheckPlan): DoctorCheckRecord {
  const registrar = plan.registrar?.url;
  if (registrar === undefined)
    throw new InternalConsistencyError(
      "registrarNotContactedRecord: the configuration names no registrar",
    );
  return withHeadline({
    id: ENROLLMENT_CHECK_ID,
    status: "skipped",
    meaning:
      "a run of this configuration does not enroll at this registrar, " +
      `because ${registrarNotContactedReason(plan)}, so the check does ` +
      "not contact it.",
    registrar,
  });
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

/**
 * The check record of the relay a run allocates on, given whether a relay
 * candidate came back and the enrollment made before it was asked, if any.
 */
export function relayCheckRecord(
  target: RelayCheckContact,
  relayGathered: boolean,
  boundMs: number = RELAY_CHECK_BOUND_MS,
  enrollment?: RelayCheckEnrollment,
): DoctorCheckRecord {
  const id = "turn_1";
  const { server, transport } = target;
  if (relayGathered)
    return withHeadline({ id, status: "ok", url: server.url, transport });
  return withHeadline(
    {
      id,
      status: "fail",
      meaning: notReachedMeaning(server, enrollment),
      action: RELAY_NOT_REACHED_REMEDY,
      url: server.url,
      transport,
    },
    { boundMs },
  );
}

const LATER_URL_NOT_CONTACTED_MEANING =
  `a run of this configuration does not contact this relay: ` +
  `${LATER_TURN_URL_NOT_CONTACTED}, so the check does not ask it.`;

/** What to do about a later url the check did not contact. */
export const NOT_CONTACTED_ACTION =
  "If this relay should be the one a run allocates on, list it first under " +
  "connection.turn and run this check again.";

function laterUrlRecord(
  server: RunTurnServer,
  index: number,
): DoctorCheckRecord {
  const id = `turn_${index + 2}`;
  return withHeadline({
    id,
    status: "skipped",
    meaning: LATER_URL_NOT_CONTACTED_MEANING,
    action: NOT_CONTACTED_ACTION,
    url: server.url,
    transport: turnUrlTransport(server.url),
  });
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
