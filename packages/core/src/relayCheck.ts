// The words and the plan of `alcove doctor relay`, held here so every surface
// that runs the check states it alike: the hosts the check contacts and those
// it does not, and the headline of each check its verdict reports, composed
// from the verdict's closed `--json` fields. Contract:
// docs/spec/CLI_DOCTOR.md, The relay check.

import type { WebRTCConnectionConfig } from "./config/connection.js";
import { InternalConsistencyError } from "./errors.js";
import {
  allowedRelaysLeaveOutInvitationRelay,
  runEnrollsAtInvitationRegistrar,
  selectRunRelay,
  webSocketRelayEnrollsAtInvitationRegistrar,
} from "./relayCredential.js";
import type {
  RunRelayConnection,
  RunTurnServer,
  RunWebSocketRelay,
} from "./relayCredential.js";

/**
 * The one bound on the relay request: a relay that has given no relay
 * candidate when it expires is reported as not reached. An arbitrary working
 * value; see docs/spec/CLI_DOCTOR.md, The relay check.
 */
export const RELAY_CHECK_BOUND_MS = 30_000;

/**
 * How long a run waits for its enrollment at the invitation relay's registrar
 * before it dials without it, and so how long the relay check waits for its
 * own before it asks the relay. An arbitrary working value, the browser's own
 * (`DEFAULT_RELAY_DIAL_WAIT_MS` in apps/web): a registrar that is up answers
 * one HTTPS request well inside it, and one that is down or slow costs a run
 * no more than this.
 */
export const INVITATION_RELAY_ENROLLMENT_WAIT_MS = 3_000;

/**
 * The clause a failure states when this side gathered no relay candidate,
 * shared by a CLI run's ICE diagnosis and `alcove doctor relay`.
 */
export const NO_RELAY_CANDIDATE_GATHERED = "no relay candidate gathered";

/**
 * The mark of a relay url `connection.allowed_relays` leaves out, as a CLI
 * run and `alcove doctor relay` state it.
 */
export const LEFT_OUT_BY_CONNECTION_ALLOWED_RELAYS =
  "left out by connection.allowed_relays";

/** The id of the relay check's enrollment line. */
export const RELAY_CHECK_ENROLLMENT_ID = "enrollment";

/** Why a run does not contact a TURN url listed after the first. */
export const LATER_TURN_URL_NOT_CONTACTED =
  "a run allocates on the first TURN url it lists alone";

/**
 * What a TURN relay not reached adds where a run also dials a WebSocket
 * relay, whose check is reported after the TURN relay's.
 */
export const WEBSOCKET_RELAY_LINE_BELOW =
  "Each WebSocket relay line below shows whether the exchange can still go " +
  "that way.";

/** The transport a TURN url names, as a `relay` check reports it. */
export type RelayTransport = "udp" | "tcp" | "tls";

/** The TURN url the check asks, and the transport it names. */
export interface RelayCheckContact {
  server: RunTurnServer;
  transport: RelayTransport;
}

/** The registrar `invitation_relay` names, and whether a run enrolls there. */
export interface RelayCheckRegistrar {
  url: string;
  /** `runEnrollsAtInvitationRegistrar` for the configuration. */
  contacted: boolean;
  /** Why a run does not enroll there, where it does not. */
  notContactedReason?: string;
}

/** A WebSocket relay a run dials, as the check plans it. */
export interface RelayCheckWebSocketRelay extends RunWebSocketRelay {
  /** `webSocketRelayEnrollsAtInvitationRegistrar` for this relay. */
  enrollsAtInvitationRegistrar: boolean;
}

/** What the check contacts, and what a run lists that it does not. */
export interface RelayCheckPlan {
  /**
   * The first TURN url a run lists: the one it allocates on. Absent where the
   * run lists no TURN url and so allocates on none.
   */
  contacted?: RelayCheckContact;
  /** Every later TURN url a run lists, in its order; none is contacted. */
  notContacted: RunTurnServer[];
  /** Every TURN url `allowed_relays` left out; none is contacted. */
  leftOut: RunTurnServer[];
  /** Every WebSocket relay a run dials, in its order; each is contacted. */
  websocket: RelayCheckWebSocketRelay[];
  /** Every WebSocket relay url `allowed_relays` left out; none is contacted. */
  websocketLeftOut: RunWebSocketRelay[];
  /** Absent where the configuration's `invitation_relay` names no registrar. */
  registrar?: RelayCheckRegistrar;
}

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
 * Why a run of `connection` does not enroll at the registrar its
 * `invitation_relay` names, for a connection whose run does not.
 */
function notEnrollingReason(connection: RunRelayConnection): string {
  if (allowedRelaysLeaveOutInvitationRelay(connection))
    return "connection.allowed_relays leaves out the relay it names";
  const { turn, websocket } = selectRunRelay(connection);
  const allocating = turn?.[0];
  const clauses: string[] = [];
  if (allocating !== undefined)
    clauses.push(
      allocating.credential !== undefined
        ? "the relay it allocates on is sent its connection.turn entry's " +
            "own credential"
        : "the relay it allocates on is not one the invitation names",
    );
  const invitationWebSocket = connection.invitationRelay?.websocket;
  if ((websocket ?? []).some((relay) => relay.url === invitationWebSocket))
    clauses.push(
      "it proves to the WebSocket relay the invitation names under the " +
        "exchange id the invitation names",
    );
  else if (allocating === undefined)
    clauses.push(
      "the WebSocket relay it dials is not one the invitation names",
    );
  return clauses.join(", and ");
}

/**
 * What the check contacts for `connection`, as a run of it does: the first
 * TURN url the run lists, every WebSocket relay it dials, and the
 * invitation's registrar where the run enrolls there.
 *
 * @throws {InternalConsistencyError} if the connection lists neither a TURN
 *   url nor a WebSocket relay, which the check refuses before it plans.
 */
export function relayCheckPlan(connection: RunRelayConnection): RelayCheckPlan {
  const { turn, turnLeftOut, websocket, websocketLeftOut } =
    selectRunRelay(connection);
  const [first, ...rest] = turn ?? [];
  if (first === undefined && (websocket ?? []).length === 0)
    throw new InternalConsistencyError(
      "relayCheckPlan: the relay check was given no TURN url and no " +
        "WebSocket relay",
    );
  const registrar = connection.invitationRelay?.registrar;
  const enrolls = runEnrollsAtInvitationRegistrar(connection);
  return {
    ...(first !== undefined && {
      contacted: { server: first, transport: turnUrlTransport(first.url) },
    }),
    notContacted: rest,
    leftOut: turnLeftOut ?? [],
    websocket: (websocket ?? []).map((relay) => ({
      ...relay,
      enrollsAtInvitationRegistrar: webSocketRelayEnrollsAtInvitationRegistrar(
        relay,
        connection,
      ),
    })),
    websocketLeftOut: websocketLeftOut ?? [],
    ...(registrar !== undefined && {
      registrar: {
        url: registrar,
        contacted: enrolls,
        ...(!enrolls && { notContactedReason: notEnrollingReason(connection) }),
      },
    }),
  };
}

// werift retries a failed UDP allocation over TCP to the same host and port,
// for a url naming `?transport=udp` as for one naming no transport
// (apps/cli/test/integration/webrtc/doctorRelayGathering.test.ts).
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

const REGISTRAR_NAMED = "The relay registrar your partner's invitation names";

const RELAY_DISCLOSURE =
  "Whoever runs that relay learns this machine's network address.";

function capitalized(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * Why a run of the configuration does not enroll at the registrar its
 * `invitation_relay` names, for a plan whose registrar is not contacted.
 *
 * @throws {InternalConsistencyError} for a plan whose registrar is contacted
 *   or absent.
 */
export function registrarNotContactedReason(plan: RelayCheckPlan): string {
  const reason = plan.registrar?.notContactedReason;
  if (reason === undefined)
    throw new InternalConsistencyError(
      "registrarNotContactedReason: the plan contacts its registrar or names none",
    );
  return reason;
}

function transportAndSource(server: RunTurnServer): string {
  return `over ${TRANSPORT_LABEL[turnUrlTransport(server.url)]}, ${sourceLabel(server)}`;
}

function webSocketSourceLabel(relay: RunWebSocketRelay): string {
  return relay.source === "invitation"
    ? "from your partner's invitation"
    : "from connection.websocket_relay";
}

/** One host of the host statement, with the lines that explain it. */
export interface RelayHostStatementEntry {
  /** A url or a registrar, as the configuration names it. */
  host: string;
  explanation: string[];
}

/**
 * The hosts the check contacts, then each host the configuration names that
 * a run of it, and so the check, does not contact, with the reason. Raw: the
 * urls and the registrar are configuration text, escaped where shown.
 */
export interface RelayHostStatement {
  contactedHeading: string;
  contacted: RelayHostStatementEntry[];
  /** Absent where the configuration names no host the check skips. */
  notContacted?: { heading: string; hosts: RelayHostStatementEntry[] };
  closing: string;
}

/** The statement the check makes before any request, for `plan`. */
export function relayHostStatement(
  plan: RelayCheckPlan,
  connection: Pick<WebRTCConnectionConfig, "invitationRelay">,
): RelayHostStatement {
  const { contacted, notContacted, leftOut, registrar } = plan;
  const contactedHosts: RelayHostStatementEntry[] = [];
  if (contacted !== undefined)
    contactedHosts.push({
      host: contacted.server.url,
      explanation: [
        `The relay a run allocates on, ${transportAndSource(contacted.server)}. ` +
          "The check asks it for a relay address, sending the credential a " +
          "run sends there.",
        RELAY_DISCLOSURE,
      ],
    });
  for (const relay of plan.websocket)
    contactedHosts.push({
      host: relay.url,
      explanation: [
        `A WebSocket relay a run dials, ${webSocketSourceLabel(relay)}. ` +
          "The check opens two connections to it, presents on each the " +
          "proof a run presents there, and closes both once the relay " +
          "answers.",
        RELAY_DISCLOSURE,
      ],
    });
  if (registrar?.contacted === true)
    contactedHosts.push({
      host: registrar.url,
      explanation: [
        `${REGISTRAR_NAMED}. Before it asks the relay, the check enrolls ` +
          "this exchange's relay key there, as a run does just before it " +
          "connects.",
        "Whoever runs that registrar learns this machine's network address.",
      ],
    });
  const skippedHosts: RelayHostStatementEntry[] = [
    ...notContacted.map((server) => ({
      host: server.url,
      explanation: [
        `${capitalized(transportAndSource(server))}. ` +
          `${capitalized(LATER_TURN_URL_NOT_CONTACTED)}.`,
      ],
    })),
    ...leftOut.map((server) => ({
      host: server.url,
      explanation: [
        `${capitalized(transportAndSource(server))}. ` +
          `${capitalized(LEFT_OUT_BY_CONNECTION_ALLOWED_RELAYS)}.`,
      ],
    })),
    ...plan.websocketLeftOut.map((relay) => ({
      host: relay.url,
      explanation: [
        `A WebSocket relay, ${webSocketSourceLabel(relay)}. ` +
          `${capitalized(LEFT_OUT_BY_CONNECTION_ALLOWED_RELAYS)}.`,
      ],
    })),
  ];
  if (registrar?.contacted === false)
    skippedHosts.push({
      host: registrar.url,
      explanation: [
        `${REGISTRAR_NAMED}. A run does not enroll there, because ` +
          `${registrarNotContactedReason(plan)}.`,
      ],
    });
  return {
    contactedHeading:
      "This check contacts these hosts, as a run of this configuration does:",
    contacted: contactedHosts,
    ...(skippedHosts.length > 0 && {
      notContacted: {
        heading:
          "It does not contact these hosts, because a run of this " +
          "configuration does not:",
        hosts: skippedHosts,
      },
    }),
    closing:
      connection.invitationRelay !== undefined && registrar === undefined
        ? "It contacts nothing else. This configuration's invitation_relay " +
          "names no relay registrar, so it contacts none and enrolls nothing."
        : "It contacts nothing else.",
  };
}

/**
 * The statement as the CLI prints it, ending in an empty line. Each host is
 * alone on its line, so a host longer than the display bound loses only its
 * own tail; its explanation is on the lines below it, every one short of
 * that bound.
 */
export function relayHostStatementLines(
  statement: RelayHostStatement,
): string[] {
  const hostLines = (hosts: RelayHostStatementEntry[]): string[] =>
    hosts.flatMap(({ host, explanation }) => [
      `  ${host}`,
      ...explanation.map((line) => `    ${line}`),
    ]);
  return [
    statement.contactedHeading,
    ...hostLines(statement.contacted),
    ...(statement.notContacted === undefined
      ? []
      : [
          statement.notContacted.heading,
          ...hostLines(statement.notContacted.hosts),
        ]),
    statement.closing,
    "",
  ];
}

/** The registrar as a message names it: its origin alone. */
function registrarOrigin(registrarUrl: string): string {
  return new URL(registrarUrl).origin;
}

/**
 * The line a run states when the invitation relay's registrar enrolls the
 * exchange, with the lapse the registrar states. Composed raw: the registrar
 * url is the partner's text, escaped at each sink.
 *
 * @throws {TypeError} if `registrarUrl` is not a url.
 */
export function invitationRelayEnrolledNotice(
  registrarUrl: string,
  lapsesAt: string | null,
): string {
  const lapse = lapsesAt === null ? "" : `, until ${lapsesAt}`;
  return (
    `the relay registrar at ${registrarOrigin(registrarUrl)} that your ` +
    `partner's invitation names enrolled this exchange${lapse}`
  );
}

/**
 * The sentence a run states when the invitation relay's registrar does not
 * enroll the exchange, holding the registrar's answer where `detail` is
 * given. Composed raw, as {@link invitationRelayEnrolledNotice} is.
 *
 * @throws {TypeError} if `registrarUrl` is not a url.
 */
export function invitationRelayNotEnrolledStatement(
  registrarUrl: string,
  detail?: string,
): string {
  const answer = detail === undefined ? "" : ` (${detail})`;
  return (
    `the relay registrar at ${registrarOrigin(registrarUrl)} that your ` +
    `partner's invitation names did not enroll this exchange${answer}.`
  );
}

/** What the check can find at a WebSocket relay a run dials, the closed set. */
export const WEBSOCKET_RELAY_CHECK_OUTCOMES = [
  "admitted",
  "not_admitted",
  "not_reached",
  "certificate_not_verified",
  "unexpected_message",
] as const;

/** What the check found at a WebSocket relay a run dials. */
export type WebSocketRelayCheckOutcome =
  (typeof WEBSOCKET_RELAY_CHECK_OUTCOMES)[number];

/** The id of the check of the `position`-th WebSocket relay a run dials, from 1. */
export function webSocketRelayCheckId(position: number): string {
  return `websocket_${position}`;
}

// The closes the WebSocket relay refuses a hello with, each with what it
// means for the check (docs/spec/WEBSOCKET_RELAY.md, Close codes). 4006, role
// taken, is absent: the relay sends it only once the proof has verified.
const WEBSOCKET_RELAY_REFUSALS: ReadonlyMap<number, string> = new Map([
  [1001, "the relay is shutting down"],
  [1009, "the relay refused a message this side sent"],
  [1011, "the relay could not check the proof"],
  [4001, "the relay refused a message this side sent"],
  [4002, "the relay refused a message this side sent"],
  [4003, "the relay holds no key for this exchange"],
  [
    4004,
    "the relay holds a key for this exchange other than the one this " +
      "side's shared secret derives",
  ],
  [4005, "the relay refused the proof as expired"],
  [4007, "the relay did not receive the proof in time"],
  [4008, "the relay is serving as many exchanges as it allows"],
]);

/**
 * Whether `code` is a close the WebSocket relay refuses a hello with before
 * it admits the proof, which the check reports as not admitted.
 */
export function isWebSocketRelayRefusal(code: number): boolean {
  return WEBSOCKET_RELAY_REFUSALS.has(code);
}

/** The closed fields of one check of a `relay` verdict, as `--json` has them. */
export interface RelayCheckFields {
  id: string;
  status: "ok" | "warn" | "fail" | "skipped";
  url?: string;
  transport?: RelayTransport;
  registrar?: string;
  lapses_at?: string;
  outcome?: WebSocketRelayCheckOutcome;
  close_code?: number;
}

/** What a headline adds to the verdict's fields, where its writer has it. */
export interface RelayCheckHeadlineOptions {
  /** The bound the relay request ran under: {@link RELAY_CHECK_BOUND_MS} unless a test set another. */
  boundMs?: number;
  /**
   * The registrar's answer to an enrollment it refused. The `--json` verdict
   * withholds it, so a headline composed from the verdict alone omits it.
   */
  registrarAnswer?: string;
}

const TURN_CHECK_ID = /^turn_([1-9][0-9]*)$/;
const WEBSOCKET_CHECK_ID = /^websocket_[1-9][0-9]*$/;

function boundSeconds(boundMs: number): string {
  return `${Math.round(boundMs / 1000)} s`;
}

function webSocketRelayHeadline(
  check: RelayCheckFields,
  boundMs: number,
): string | undefined {
  const { status, url, transport, outcome, close_code: code } = check;
  if (url === undefined || transport !== undefined) return undefined;
  const heading = `${url}, a WebSocket relay a run dials`;
  if (status === "ok")
    return outcome === "admitted" && code === undefined
      ? `${heading}: admitted; the relay accepted this exchange's proof.`
      : undefined;
  if (status !== "fail") return undefined;
  if (outcome === "not_admitted") {
    const refusal =
      code === undefined ? undefined : WEBSOCKET_RELAY_REFUSALS.get(code);
    return refusal === undefined
      ? undefined
      : `${heading}: not admitted; ${refusal} (close code ${code}).`;
  }
  if (code !== undefined) return undefined;
  if (outcome === "not_reached")
    return `${heading}: not reached within ${boundSeconds(boundMs)}.`;
  if (outcome === "certificate_not_verified")
    return `${heading}: not reached; its TLS certificate did not verify on this host.`;
  if (outcome === "unexpected_message")
    return `${heading}: did not answer as an Alcove WebSocket relay.`;
  return undefined;
}

/**
 * The headline of one check of a `relay` verdict: the summary line the CLI
 * prints after its label. Undefined for fields `doctor relay` never reports
 * together, or a registrar that is not a url. Raw: the url and the registrar
 * are configuration text, escaped where shown.
 */
export function relayCheckHeadline(
  check: RelayCheckFields,
  options: RelayCheckHeadlineOptions = {},
): string | undefined {
  const { id, status, url, transport, registrar } = check;
  const boundMs = options.boundMs ?? RELAY_CHECK_BOUND_MS;
  if (WEBSOCKET_CHECK_ID.test(id)) {
    return check.registrar === undefined && check.lapses_at === undefined
      ? webSocketRelayHeadline(check, boundMs)
      : undefined;
  }
  if (check.outcome !== undefined || check.close_code !== undefined)
    return undefined;
  if (id === RELAY_CHECK_ENROLLMENT_ID) {
    if (registrar === undefined) return undefined;
    try {
      if (status === "ok")
        return `${invitationRelayEnrolledNotice(registrar, check.lapses_at ?? null)}.`;
      if (status === "warn")
        return invitationRelayNotEnrolledStatement(
          registrar,
          options.registrarAnswer,
        );
    } catch (error) {
      if (error instanceof TypeError) return undefined;
      throw error;
    }
    return status === "skipped"
      ? `the relay registrar at ${registrar} that your partner's invitation ` +
          "names: not contacted."
      : undefined;
  }
  const position = TURN_CHECK_ID.exec(id)?.[1];
  if (position === undefined || url === undefined) return undefined;
  if (position !== "1")
    return status === "skipped"
      ? `${url}, listed after the relay a run allocates on: not contacted.`
      : undefined;
  if (transport === undefined) return undefined;
  const heading = `${url} over ${TRANSPORT_LABEL[transport]}, the relay a run allocates on`;
  if (status === "ok")
    return `${heading}: reached; the relay gave a relay address.`;
  if (status === "fail")
    return (
      `${heading}: ${NO_RELAY_CANDIDATE_GATHERED} within ` +
      `${boundSeconds(boundMs)}.`
    );
  return undefined;
}
