import { RELAY_CHECK_BOUND_MS, sanitizeForDisplay } from "@alcove/core";

import { REFUSALS_ENDING_THE_CHECK } from "@psi/transport/exchangeRelayCheck";

import { exchangeRelayCheckLineShown } from "./exchangeRelayCheckModel";

import type {
  RunRelayWatchSnapshot,
  WatchedEnrollment,
  WatchedWebSocketRelay,
} from "@psi/transport/runRelayWatch";
import type { RunRelayHosts } from "@psi/transport/runRelayPlan";
import type { WebSocketRelayCheckResult } from "@psi/transport/exchangeRelayCheck";

import type { ExchangeRelayCheckLineShown } from "./exchangeRelayCheckModel";

/** What the share screen's check does, beside its start control. */
export const INVITER_RELAY_CHECK_INTRO =
  "Check whether the WebSocket relays accept this exchange. This uses " +
  "connections this page already has open and contacts nothing new.";

/** The status of a WebSocket relay holding the run's socket after its hello. */
export const INVITER_RELAY_WAITING_STATUS = "Waiting for your partner";

/** The verdict where at least one relay holds the run's socket. */
export const INVITER_RELAY_CHECK_WAITING_VERDICT = "Waiting for your partner.";

/** The verdict where no relay accepts the exchange. */
export const INVITER_RELAY_CHECK_FAILS_VERDICT =
  "No WebSocket relay accepts this exchange from this page. Follow the steps below.";

/**
 * The share screen's remedies. Create fixes the Connection settings, so a
 * fix that changes them goes through Replace this invitation, and a remedy
 * says to check again only while the run's relay client still dials.
 */
export const INVITER_RELAY_ACTIONS = {
  remove:
    "Choose Replace this invitation, then remove this relay under " +
    "Connection settings.",
  removeOrTurnOnDefault:
    "Choose Replace this invitation, then under Connection settings remove " +
    "this relay or turn on this site's relay server.",
  correct:
    "Choose Replace this invitation, then correct this url under " +
    "Connection settings.",
  replace: "Choose Replace this invitation to try again.",
  replaceLater: "Later, choose Replace this invitation to try again.",
  notEnrolled:
    "If your partner cannot connect, choose Replace this invitation to try " +
    "again.",
  keepsTrying: "This page keeps trying, so check again shortly.",
  clock: "Correct this computer's clock, then choose Replace this invitation.",
  slowPath:
    "Check the network path to the relay, including any proxy, then choose " +
    "Replace this invitation.",
  operator:
    "Ask whoever runs the relay to check it, then choose Replace this " +
    "invitation.",
  notReachedTrying:
    "Check that this computer can reach the relay. This page keeps trying, " +
    "so check again afterwards.",
  notReachedTryingOwn:
    "Check that this computer can reach the relay. This page keeps trying, " +
    "so check again afterwards. If the url is wrong, choose Replace this " +
    "invitation and correct it under Connection settings.",
  notReachedEnded:
    "Check that this computer can reach the relay, then choose Replace this " +
    "invitation.",
  notReachedEndedOwn:
    "Check that this computer can reach the relay, then choose Replace this " +
    "invitation and correct this url under Connection settings if it is " +
    "wrong.",
} as const;

/**
 * How long a socket stays open after its hello before the check takes the
 * relay to have accepted it: the relay sends nothing on accepting a hello and
 * refuses one as it arrives (docs/spec/WEBSOCKET_RELAY.md, The hello). An
 * arbitrary working value.
 */
export const HELLO_ANSWER_WAIT_MS = 2000;

// The relay checks a hello's proof before its role, so a socket refused as
// role taken had its proof accepted (docs/spec/WEBSOCKET_RELAY.md, The hello).
const ROLE_TAKEN = 4006;

/** Where the share screen's check stands. */
export type InviterRelayCheckState =
  | { step: "not_started" }
  | { step: "running"; startedAt: number }
  | {
      step: "done";
      verdict: string;
      lines: ReadonlyArray<ExchangeRelayCheckLineShown>;
    };

/**
 * Whether the share screen shows the check: while the run waits for the
 * partner (`share`) with no failure, once it has reached its relays, where it
 * dials a WebSocket relay.
 */
export function inviterRelayCheckShown(run: {
  phase: "share" | "running" | "done";
  failed: boolean;
  hosts: RunRelayHosts | undefined;
}): boolean {
  return (
    run.phase === "share" &&
    !run.failed &&
    run.hosts !== undefined &&
    run.hosts.websocket.length > 0
  );
}

/**
 * The check after `now`: a running check ends once each relay the run lists
 * has answered, or at the bound, a relay still silent then not reached. A
 * TURN relay is listed only where the default relay did not enroll the
 * exchange, since the run first uses it when the partner connects.
 */
export function inviterRelayCheckAt(
  state: InviterRelayCheckState,
  hosts: RunRelayHosts,
  snapshot: RunRelayWatchSnapshot,
  now: number,
  boundMs: number = RELAY_CHECK_BOUND_MS,
): InviterRelayCheckState {
  if (state.step !== "running") return state;
  const boundPassed = now - state.startedAt >= boundMs;
  const lines: Array<ExchangeRelayCheckLineShown> = [];
  for (const url of hosts.turn) {
    if (!hosts.listedOnceEnrolled.includes(url)) continue;
    if (snapshot.enrollment.kind === "pending" && !boundPassed) return state;
    const refused = notEnrolled("turn", url, hosts, snapshot.enrollment);
    if (refused !== undefined) lines.push(refused);
  }
  for (const url of hosts.websocket) {
    const line = webSocketLine(url, hosts, snapshot, now, boundPassed);
    if (line === undefined) return state;
    lines.push(line);
  }
  return { step: "done", verdict: inviterRelayCheckVerdict(lines), lines };
}

/** The line that heads the share screen's result. */
export function inviterRelayCheckVerdict(
  lines: ReadonlyArray<ExchangeRelayCheckLineShown>,
): string {
  return lines.some((line) => line.works)
    ? INVITER_RELAY_CHECK_WAITING_VERDICT
    : INVITER_RELAY_CHECK_FAILS_VERDICT;
}

function notEnrolled(
  relay: "turn" | "websocket",
  url: string,
  hosts: RunRelayHosts,
  enrollment: WatchedEnrollment,
): ExchangeRelayCheckLineShown | undefined {
  if (!hosts.listedOnceEnrolled.includes(url) || enrollment.kind !== "refused")
    return undefined;
  return {
    ...exchangeRelayCheckLineShown(
      { relay, url, notEnrolled: enrollment.refusal },
      { hosts },
    ),
    action: INVITER_RELAY_ACTIONS.notEnrolled,
  };
}

function webSocketLine(
  url: string,
  hosts: RunRelayHosts,
  snapshot: RunRelayWatchSnapshot,
  now: number,
  boundPassed: boolean,
): ExchangeRelayCheckLineShown | undefined {
  const refused = notEnrolled("websocket", url, hosts, snapshot.enrollment);
  if (refused !== undefined) return refused;
  const watched = snapshot.websocket.get(url);
  const result =
    watched === undefined
      ? boundPassed
        ? { kind: "not_reached" as const }
        : undefined
      : webSocketAnswer(watched, now, boundPassed);
  if (result === undefined) return undefined;
  if (result === "waiting")
    return {
      url: sanitizeForDisplay(url),
      works: true,
      status: INVITER_RELAY_WAITING_STATUS,
    };
  return {
    ...exchangeRelayCheckLineShown(
      { relay: "websocket", url, result },
      { hosts },
    ),
    action: webSocketAction(result, {
      own: !hosts.listedOnceEnrolled.includes(url),
      dialing: watched?.failure === undefined,
      defaultRelayOff: hosts.defaultRelayOff === true,
    }),
  };
}

type WebSocketAnswer = Extract<
  WebSocketRelayCheckResult,
  { kind: "refused" | "unexpected_message" | "not_reached" | "not_started" }
>;

// What the share screen says to do about a relay that does not work: `own`
// where the relay is the exchange's own rather than this site's, and
// `dialing` while the run's relay client there has not failed.
function webSocketAction(
  result: WebSocketAnswer,
  relay: { own: boolean; dialing: boolean; defaultRelayOff: boolean },
): string {
  const actions = INVITER_RELAY_ACTIONS;
  const remove = relay.defaultRelayOff
    ? actions.removeOrTurnOnDefault
    : actions.remove;
  switch (result.kind) {
    case "refused":
      switch (result.closeCode) {
        case 4003:
          if (relay.own) return remove;
          return relay.dialing ? actions.keepsTrying : actions.replace;
        case 4004:
          return relay.own ? remove : actions.replace;
        case 4005:
          if (!result.proofRemadeOnRelayClock) return actions.clock;
          return relay.own ? remove : actions.replace;
        case 4007:
          return actions.slowPath;
        case 4008:
        case 1001:
          return actions.replaceLater;
        case 1011:
          return actions.operator;
        default:
          return relay.own ? actions.correct : actions.replace;
      }
    case "unexpected_message":
    case "not_started":
      return relay.own ? actions.correct : actions.replace;
    case "not_reached":
      if (relay.dialing)
        return relay.own
          ? actions.notReachedTryingOwn
          : actions.notReachedTrying;
      return relay.own ? actions.notReachedEndedOwn : actions.notReachedEnded;
  }
}

// The relay's answer to the run's socket so far, or undefined while it has
// not answered. A refusal is read from the last close, so a relay that
// refused once and then accepted a later socket's hello is waiting.
function webSocketAnswer(
  watched: WatchedWebSocketRelay,
  now: number,
  boundPassed: boolean,
): WebSocketAnswer | "waiting" | undefined {
  const { failure, closes } = watched;
  if (failure?.kind === "protocol") return { kind: "unexpected_message" };
  if (watched.paired) return "waiting";
  if (watched.helloSentAt !== undefined && failure === undefined)
    return now - watched.helloSentAt >= HELLO_ANSWER_WAIT_MS
      ? "waiting"
      : undefined;
  const last = closes.at(-1);
  if (last !== undefined && REFUSALS_ENDING_THE_CHECK.has(last))
    return { kind: "refused", closeCode: last, proofRemadeOnRelayClock: false };
  if (last === ROLE_TAKEN && failure === undefined) return "waiting";
  if (failure !== undefined) {
    const expired = closes.filter((code) => code === 4005).length;
    if (expired > 0)
      return {
        kind: "refused",
        closeCode: 4005,
        proofRemadeOnRelayClock: expired > 1,
      };
    return failure.kind === "usage"
      ? { kind: "not_started" }
      : { kind: "not_reached" };
  }
  return boundPassed ? { kind: "not_reached" } : undefined;
}
