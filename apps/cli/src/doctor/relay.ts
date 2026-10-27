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
  WEBSOCKET_RELAY_LINE_BELOW,
  webSocketRelayCheckId,
} from "@alcove/core";
import type {
  ConnectionConfig,
  RelayCheckContact,
  RelayCheckHeadlineOptions,
  RelayCheckPlan as RelayCheckHostPlan,
  RelayCheckWebSocketRelay,
  RelayCredential,
  RunRelayConnection,
  RunTurnServer,
  WebRTCConnectionConfig,
} from "@alcove/core";
import type { RTCIceServer } from "werift";

import type { WebSocketRelayDial } from "../connection/webrtc/websocketRelayConnection";
import {
  ICE_PROVISION_REFUSAL,
  turnIceServer,
} from "../connection/webrtc/weriftPeer";
import { enrollAtInvitationRelay } from "../invitationRelayEnrollment";
import type { InvitationRelayEnrollment } from "../invitationRelayEnrollment";
import type { DoctorCheck, DoctorCheckRecord, DoctorReport } from "./verdict";
import { askWebSocketRelay } from "./websocketRelay";
import type {
  WebSocketRelayAnswer,
  WebSocketRelayAsking,
} from "./websocketRelay";

// `alcove doctor relay`: whether this host reaches the relays a webrtc run
// uses: the TURN relay it allocates on, asked as the run's ICE gathering asks,
// and each WebSocket relay it dials, asked whether it admits the run's proof.
// It contacts exactly the relay hosts a run of the configuration contacts: the
// first TURN url the run lists, every WebSocket relay it dials, and the
// invitation's registrar only where the run enrolls there. It runs only when
// the operator names it. The plan, the host statement and each check's
// headline are composed in core (relayCheck.ts).
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

/** The refusal of a webrtc configuration that lists no relay. */
export const RELAY_CHECK_NO_RELAY =
  "this configuration lists no relay: no connection.turn entry, no " +
  "connection.websocket_relay, and no turn or websocket url in " +
  "connection.invitation_relay, so there is no relay to check. Nothing was " +
  "contacted.";

/**
 * The refusal of a webrtc configuration that lists a WebSocket relay and no
 * `role`, which the proof the relay takes names.
 */
export const RELAY_CHECK_ROLE_REQUIRED =
  "this webrtc connection has no `role`, and the proof a WebSocket relay " +
  "takes names this side's role. Set `role: inviter` or `role: acceptor` on " +
  "the connection block. Nothing was contacted.";

/**
 * The refusal of a webrtc configuration whose every relay url
 * `allowed_relays` leaves out, naming them; raw, escaped where shown.
 */
export function relayCheckAllLeftOutMessage(
  leftOut: ReadonlyArray<string>,
): string {
  return (
    `connection.allowed_relays leaves out every relay url this configuration ` +
    `lists (${leftOut.join(", ")}), so a run contacts no relay and there is ` +
    "none to check. Nothing was contacted."
  );
}

/** The TURN url the check asks, with what it presents there. */
export interface RelayCheckTarget extends RelayCheckContact {
  iceServer: RTCIceServer;
}

/**
 * Core's plan, with what the check presents to the TURN url it asks and to
 * each WebSocket relay, one dial for each, in the plan's order.
 */
export interface RelayCheckPlan extends RelayCheckHostPlan {
  contacted?: RelayCheckTarget;
  websocketDials: WebSocketRelayDial[];
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
 * not webrtc, one the run itself refuses for `ice_provision`, one that lists
 * no relay a run contacts, and one that lists a WebSocket relay and no role.
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
  const { turn, turnLeftOut, websocket, websocketLeftOut } =
    selectRunRelay(connection);
  if ((turn ?? []).length === 0 && (websocket ?? []).length === 0) {
    const leftOut = [...(turnLeftOut ?? []), ...(websocketLeftOut ?? [])];
    throw new UsageError(
      leftOut.length === 0
        ? RELAY_CHECK_NO_RELAY
        : relayCheckAllLeftOutMessage(leftOut.map((relay) => relay.url)),
    );
  }
  if ((websocket ?? []).length > 0 && connection.role === undefined)
    throw new UsageError(RELAY_CHECK_ROLE_REQUIRED);
  return connection;
}

/**
 * What the check contacts for `connection` ({@link relayCheckHostPlan}), with
 * what it presents to the first TURN url, the entry's static pair or else the
 * credential the run mints, and to each WebSocket relay, the run's dial
 * (`webSocketRelayDialsFor`).
 *
 * @throws {Error} if the connection lists no relay, which
 *   {@link relayCheckConnection} refuses first, or if `websocketDials` is not
 *   one dial for each WebSocket relay of the plan, in its order.
 */
export function relayCheckPlan(
  connection: RunRelayConnection,
  runRelayCredential: RelayCredential | undefined,
  websocketDials: WebSocketRelayDial[] = [],
): RelayCheckPlan {
  const plan = relayCheckHostPlan(connection);
  if (
    websocketDials.length !== plan.websocket.length ||
    plan.websocket.some(
      (relay, index) => websocketDials[index]?.url !== relay.url,
    )
  )
    throw new InternalConsistencyError(
      "relayCheckPlan: the WebSocket relay dials are not the plan's relays",
    );
  const { contacted, ...rest } = plan;
  return {
    ...rest,
    ...(contacted !== undefined && {
      contacted: {
        ...contacted,
        iceServer: turnIceServer(contacted.server, runRelayCredential),
      },
    }),
    websocketDials,
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
 * candidate came back, the enrollment made before it was asked, if any, and
 * whether the run also dials a WebSocket relay.
 */
export function relayCheckRecord(
  target: RelayCheckContact,
  relayGathered: boolean,
  boundMs: number = RELAY_CHECK_BOUND_MS,
  enrollment?: RelayCheckEnrollment,
  dialsWebSocketRelay = false,
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
      action: dialsWebSocketRelay
        ? `${RELAY_NOT_REACHED_REMEDY} ${WEBSOCKET_RELAY_LINE_BELOW}`
        : RELAY_NOT_REACHED_REMEDY,
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

const WEBSOCKET_RELAY_RETRY = "then run this check again.";

/** What a WebSocket relay's refusal of the proof means, and what to do. */
function webSocketRefusalWords(
  relay: RelayCheckWebSocketRelay,
  refusal: Extract<WebSocketRelayAnswer, { outcome: "not_admitted" }>,
  enrollment: RelayCheckEnrollment | undefined,
): { meaning: string; action: string } {
  switch (refusal.closeCode) {
    case 4003: {
      const enrollmentFailed =
        enrollment !== undefined &&
        enrollment.outcome.kind !== "enrolled" &&
        relay.enrollsAtInvitationRegistrar;
      return {
        meaning:
          "the relay holds no key for this exchange, so it refuses the " +
          "proof a run presents until the exchange's relay key is enrolled " +
          "there." +
          (enrollmentFailed
            ? " The likely cause is the failed enrollment above."
            : ""),
        action: relay.enrollsAtInvitationRegistrar
          ? "Run this check again. If the relay still holds no key, ask " +
            "your partner whether the relay registrar their invitation " +
            "names is up, since either of you enrolling the exchange there " +
            "lets the relay admit it."
          : relay.partnersUnderInvitationExchangeId
            ? "Ask your partner to enroll this exchange's relay key at " +
              "their relay's registrar by running alcove enroll-relay with " +
              "their relay-owner token, which this side does not hold, " +
              WEBSOCKET_RELAY_RETRY
            : "Enroll this exchange's relay key at the relay's registrar " +
              `with alcove enroll-relay, ${WEBSOCKET_RELAY_RETRY}`,
      };
    }
    case 4004:
      return {
        meaning:
          "the relay holds a key for this exchange other than the one this " +
          "side's shared secret derives, so it refuses the proof a run " +
          "presents.",
        action:
          "Register the current key with alcove enroll-relay " +
          `--replace-relay-key, ${WEBSOCKET_RELAY_RETRY}`,
      };
    case 4005:
      return refusal.proofRemadeOnRelayClock === true
        ? {
            meaning:
              "the relay refused the proof a run presents as expired twice, " +
              "the second time a proof made on the relay's own clock, so " +
              "this computer's clock is not the cause.",
            action:
              "Run this check again. If the relay refuses the proof the " +
              "same way, check the relay and the exchange's enrollment at " +
              "its registrar.",
          }
        : {
            meaning:
              "the relay refused the proof a run presents as expired " +
              "without stating its own clock, so the proof could not be " +
              "made again on that clock, and this computer's clock and the " +
              "relay's may differ by more than five minutes.",
            action:
              `Correct this computer's clock, ${WEBSOCKET_RELAY_RETRY} If ` +
              "the relay refuses the proof the same way, ask the relay's " +
              "operator to check its clock.",
          };
    case 4007:
      return {
        meaning:
          "the relay received no proof from this side within 10 seconds of " +
          "the connection opening, so something on the path may be slow or " +
          "holding messages back.",
        action:
          "Check the network path to the relay, including any proxy, " +
          WEBSOCKET_RELAY_RETRY,
      };
    case 4008:
      return {
        meaning:
          "the relay is serving as many exchanges as it allows, so it " +
          "refuses a run that arrives now.",
        action: "Run this check again later.",
      };
    case 1011:
      return {
        meaning: "the relay could not check the proof a run presents.",
        action:
          "Ask the relay's operator to check its key table, " +
          WEBSOCKET_RELAY_RETRY,
      };
    case 1001:
      return {
        meaning: "the relay is shutting down.",
        action: "Run this check again once the relay is back.",
      };
    default:
      return {
        meaning:
          "the relay refused a message this side sent before it admitted " +
          "the proof, so it may not be an Alcove WebSocket relay.",
        action:
          "Check that the url names an Alcove WebSocket relay, " +
          WEBSOCKET_RELAY_RETRY,
      };
  }
}

const WEBSOCKET_NOT_REACHED_MEANING =
  "nothing on this host reached this url as an Alcove WebSocket relay: the " +
  "network blocked it, nothing answered at that address and path, or the " +
  "connection closed before the relay answered the proof.";

const WEBSOCKET_NOT_REACHED_ACTION =
  "Check that this host can reach the relay and that the url names its " +
  `address and path, ${WEBSOCKET_RELAY_RETRY}`;

const TRUST_THE_NETWORK_CA =
  "add its certificate authority to this machine's trust store, or name a " +
  "file holding it in NODE_EXTRA_CA_CERTS";

/**
 * The check record of the WebSocket relay at `position` (from 1) a run dials,
 * given what the relay answered and the enrollment made before it was asked,
 * if any.
 */
export function webSocketRelayCheckRecord(
  relay: RelayCheckWebSocketRelay,
  position: number,
  answer: WebSocketRelayAnswer,
  boundMs: number = RELAY_CHECK_BOUND_MS,
  enrollment?: RelayCheckEnrollment,
): DoctorCheckRecord {
  const id = webSocketRelayCheckId(position);
  const { url } = relay;
  switch (answer.outcome) {
    case "admitted":
      return withHeadline({ id, status: "ok", url, outcome: "admitted" });
    case "not_admitted":
      return withHeadline({
        id,
        status: "fail",
        ...webSocketRefusalWords(relay, answer, enrollment),
        url,
        outcome: "not_admitted",
        close_code: answer.closeCode,
      });
    case "certificate_not_verified":
      return withHeadline({
        id,
        status: "fail",
        meaning:
          "the relay presented a TLS certificate that does not verify on " +
          "this host, as one does where the network intercepts TLS.",
        action:
          `If this network intercepts TLS, ${TRUST_THE_NETWORK_CA}, ` +
          `${WEBSOCKET_RELAY_RETRY} Otherwise ask the relay's operator ` +
          "whether its certificate is current and issued for its host.",
        url,
        outcome: "certificate_not_verified",
      });
    case "unexpected_message":
      return withHeadline({
        id,
        status: "fail",
        meaning:
          "the relay answered the proof with a message an Alcove WebSocket " +
          "relay does not send at that point, so the url may not name an " +
          "Alcove WebSocket relay.",
        action:
          "Check that the url names an Alcove WebSocket relay, " +
          WEBSOCKET_RELAY_RETRY,
        url,
        outcome: "unexpected_message",
      });
    case "not_reached":
      return withHeadline(
        {
          id,
          status: "fail",
          meaning: answer.certificateNotChecked
            ? `${WEBSOCKET_NOT_REACHED_MEANING} This run has Node's ` +
              "environment proxying turned on, so the relay's TLS " +
              "certificate was not checked."
            : WEBSOCKET_NOT_REACHED_MEANING,
          action: answer.certificateNotChecked
            ? `${WEBSOCKET_NOT_REACHED_ACTION} If a proxy intercepts TLS, ` +
              `${TRUST_THE_NETWORK_CA}.`
            : WEBSOCKET_NOT_REACHED_ACTION,
          url,
          outcome: "not_reached",
        },
        { boundMs },
      );
  }
}

/**
 * Ask the relay a run allocates on and every WebSocket relay it dials, at
 * once and under the one bound, and report them after the registrar's line,
 * if the configuration names a registrar: the TURN relay's line, a `skipped`
 * line for each later TURN url, then each WebSocket relay's line.
 * `enrollment` is the one made before the requests, present exactly where
 * the plan's registrar is contacted.
 */
export async function runRelayCheck(
  plan: RelayCheckPlan,
  gather: RelayCandidateGathering,
  boundMs: number = RELAY_CHECK_BOUND_MS,
  enrollment?: RelayCheckEnrollment,
  askWebSocket: WebSocketRelayAsking = askWebSocketRelay,
): Promise<DoctorReport> {
  if ((plan.registrar?.contacted === true) !== (enrollment !== undefined))
    throw new InternalConsistencyError(
      "runRelayCheck: an enrollment is given exactly where a run enrolls",
    );
  const bound = new AbortController();
  const timer = setTimeout(() => bound.abort(), boundMs);
  try {
    const { contacted } = plan;
    const [gathered, websocketAnswers] = await Promise.all([
      contacted === undefined
        ? undefined
        : gather(contacted.iceServer, bound.signal),
      Promise.all(
        plan.websocketDials.map((dial) => askWebSocket(dial, bound.signal)),
      ),
    ]);
    const registrarRecords =
      enrollment !== undefined
        ? [enrollmentCheckRecord(enrollment)]
        : plan.registrar !== undefined
          ? [registrarNotContactedRecord(plan)]
          : [];
    const turnRecords =
      contacted === undefined || gathered === undefined
        ? []
        : [
            relayCheckRecord(
              contacted,
              gathered,
              boundMs,
              enrollment,
              plan.websocket.length > 0,
            ),
            ...plan.notContacted.map(laterUrlRecord),
          ];
    return {
      mode: "relay",
      checks: [
        ...registrarRecords,
        ...turnRecords,
        ...plan.websocket.map((relay, index) => {
          const answer = websocketAnswers[index];
          if (answer === undefined)
            throw new InternalConsistencyError(
              "runRelayCheck: a WebSocket relay was not asked",
            );
          return webSocketRelayCheckRecord(
            relay,
            index + 1,
            answer,
            boundMs,
            enrollment,
          );
        }),
      ],
    };
  } finally {
    clearTimeout(timer);
    bound.abort();
  }
}
