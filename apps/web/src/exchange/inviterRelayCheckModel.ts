import { RELAY_CHECK_BOUND_MS, sanitizeForDisplay } from "@alcove/core";

import { REFUSALS_ENDING_THE_CHECK } from "@psi/transport/exchangeRelayCheck";

import {
  exchangeRelayCheckLineShown,
  exchangeRelayCheckVerdict,
} from "./exchangeRelayCheckModel";

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
  "Check whether this exchange's relays accept it, using the connections " +
  "this page holds open for your partner. Nothing else is contacted.";

/** A WebSocket relay holding the run's socket after its hello. */
export const INVITER_RELAY_WAITING_SUMMARY =
  "the relay accepted this exchange's proof, and this page is waiting " +
  "there for your partner.";

/** A TURN relay, which the run first uses when the partner connects. */
export const TURN_RELAY_NOT_CHECKED_SUMMARY =
  "this page first uses this relay when your partner connects.";

/**
 * How long a socket stays open after its hello before the check takes the
 * relay to have accepted it: the relay sends nothing on accepting a hello and
 * refuses one as it arrives (docs/spec/WEBSOCKET_RELAY.md, The hello). An
 * arbitrary working value.
 */
export const HELLO_ANSWER_WAIT_MS = 2000;

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
 * has answered, or at the bound, a relay still silent then not reached.
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
    const line = turnLine(url, hosts, snapshot.enrollment, boundPassed);
    if (line === undefined) return state;
    lines.push(line);
  }
  for (const url of hosts.websocket) {
    const line = webSocketLine(url, hosts, snapshot, now, boundPassed);
    if (line === undefined) return state;
    lines.push(line);
  }
  return { step: "done", verdict: exchangeRelayCheckVerdict(lines), lines };
}

function notEnrolled(
  relay: "turn" | "websocket",
  url: string,
  hosts: RunRelayHosts,
  enrollment: WatchedEnrollment,
): ExchangeRelayCheckLineShown | undefined {
  if (!hosts.listedOnceEnrolled.includes(url) || enrollment.kind !== "refused")
    return undefined;
  return exchangeRelayCheckLineShown(
    { relay, url, notEnrolled: enrollment.refusal },
    { hosts },
  );
}

function turnLine(
  url: string,
  hosts: RunRelayHosts,
  enrollment: WatchedEnrollment,
  boundPassed: boolean,
): ExchangeRelayCheckLineShown | undefined {
  if (
    hosts.listedOnceEnrolled.includes(url) &&
    enrollment.kind === "pending" &&
    !boundPassed
  )
    return undefined;
  return (
    notEnrolled("turn", url, hosts, enrollment) ?? {
      url: sanitizeForDisplay(url),
      works: false,
      notChecked: true,
      summary: TURN_RELAY_NOT_CHECKED_SUMMARY,
    }
  );
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
      summary: INVITER_RELAY_WAITING_SUMMARY,
    };
  return exchangeRelayCheckLineShown(
    { relay: "websocket", url, result },
    { hosts },
  );
}

// The relay's answer to the run's socket so far, or undefined while it has
// not answered. A refusal is read from the last close, so a relay that
// refused once and then accepted a later socket's hello is waiting.
function webSocketAnswer(
  watched: WatchedWebSocketRelay,
  now: number,
  boundPassed: boolean,
): WebSocketRelayCheckResult | "waiting" | undefined {
  const { failure, closes } = watched;
  if (failure?.kind === "protocol") return { kind: "unexpected_message" };
  if (watched.paired) return "waiting";
  if (watched.helloSentAt !== undefined)
    return now - watched.helloSentAt >= HELLO_ANSWER_WAIT_MS
      ? "waiting"
      : undefined;
  const last = closes.at(-1);
  if (last !== undefined && REFUSALS_ENDING_THE_CHECK.has(last))
    return { kind: "refused", closeCode: last, proofRemadeOnRelayClock: false };
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
