/**
 * The web application's check of an exchange's relays: each relay a run of
 * the exchange lists, asked to carry one message between two connections of
 * this page under the exchange's own credential, with the run's enrollment
 * made first, as the run makes it. Contract: docs/spec/PROTOCOL.md, The web
 * application's relay check.
 */

import { RELAY_CHECK_BOUND_MS, deriveRelayKey } from "@alcove/core";

import { relayPlanForRun, runRelayHosts } from "./runRelayPlan";
import { parkWebSocketRelayConnection } from "./websocketRelayConnection";
import { turnIceServer } from "./turnIceServer";

import type {
  ParkedWebSocketRelayConnection,
  WebSocketRelayConnectionOptions,
} from "./websocketRelayConnection";
import type {
  RunRelayHosts,
  RunRelayPlan,
  RunRelayPlanDependencies,
} from "./runRelayPlan";
import type { DefaultRelayRefusal } from "./defaultRelayRefusal";
import type { MessageConnection } from "@alcove/core";
import type { RelayUrls } from "./ownRelaySetting";

/** The message the check passes through a relay. */
const CHECK_MESSAGE = "alcove relay check";

/** The STUN error codes a TURN relay refuses a credential with (RFC 8656). */
const CREDENTIAL_REFUSED_CODES: ReadonlySet<number> = new Set([401, 441]);

/** What the check found at a TURN relay; `not_started` where its request
 * threw, and `credential_not_made` where the credential it presents could
 * not be made. */
export type TurnRelayCheckResult =
  | "works"
  | "not_reached"
  | "credential_refused"
  | "no_relayed_path"
  | "not_started"
  | "credential_not_made";

/** What the check found at a WebSocket relay. */
export type WebSocketRelayCheckResult =
  | { kind: "works" }
  /** One socket was paired and the other refused as role taken: another
   * party of the exchange was waiting, so no message was sent. */
  | { kind: "admitted" }
  | { kind: "refused"; closeCode: number; proofRemadeOnRelayClock: boolean }
  | { kind: "unexpected_message" }
  | { kind: "not_reached" }
  | { kind: "no_relayed_path" }
  /** The request threw. */
  | { kind: "not_started" };

/** One relay the check reports on, in the order the run lists it. */
export type ExchangeRelayCheckLine =
  | { relay: "turn"; url: string; result: TurnRelayCheckResult }
  | { relay: "websocket"; url: string; result: WebSocketRelayCheckResult }
  /** A default relay url the run lists only once enrolled, whose enrollment
   * failed: the run, and so the check, does not contact it. */
  | {
      relay: "turn" | "websocket";
      url: string;
      notEnrolled: DefaultRelayRefusal;
    };

/** Builds a peer connection; tests inject a fake. */
export type PeerConnectionFactory = (
  configuration: RTCConfiguration,
) => RTCPeerConnection;

/** Parks a socket at a WebSocket relay; tests inject a fake. */
export type WebSocketRelayParking = (
  options: WebSocketRelayConnectionOptions,
) => ParkedWebSocketRelayConnection;

/** What a check reads from the exchange: injectable for tests. */
export interface ExchangeRelayCheckDependencies {
  createPeerConnection?: PeerConnectionFactory;
  parkWebSocketRelay?: WebSocketRelayParking;
  /** The one bound on the requests; {@link RELAY_CHECK_BOUND_MS} when unset. */
  boundMs?: number;
  now?: () => Date;
}

/** The exchange a check is of. */
export interface ExchangeRelayCheckSubject {
  /** The exchange's current shared secret. */
  sharedSecret: string;
  /** The hosts the check may contact, shown before it starts. */
  hosts: RunRelayHosts;
  /**
   * The run's relay plan, enrolling where a run enrolls: `relayPlanForRun`
   * for the exchange, given where to report the default relay's enrollment.
   */
  plan: (
    onDefaultRelayEnrollment: (
      refusal: DefaultRelayRefusal | undefined,
    ) => void,
  ) => Promise<RunRelayPlan>;
}

/**
 * The check of a browser run's relays for these arguments, which a run of
 * the exchange passes to {@link relayPlanForRun}: the hosts it lists, and the
 * plan with its enrollment, made only when the check starts.
 */
export function exchangeRelayCheckSubject(
  sharedSecret: string,
  invitationRelay: RelayUrls | undefined,
  allowedRelays: ReadonlyArray<string> | undefined,
  dependencies: Pick<
    RunRelayPlanDependencies,
    "build" | "switchedOn" | "readOwn" | "ownRelayExchangeId" | "enroll"
  > = {},
): ExchangeRelayCheckSubject {
  return {
    sharedSecret,
    hosts: runRelayHosts(invitationRelay, allowedRelays, dependencies),
    plan: (onDefaultRelayEnrollment) =>
      relayPlanForRun(sharedSecret, invitationRelay, allowedRelays, {
        ...dependencies,
        onDefaultRelayEnrollment,
      }),
  };
}

function delay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Ask the TURN relay of `iceServer` to carry one message between two
 * relay-only peer connections of this page, each presenting the server's
 * credential. Ends on the message's return, on both gatherings ending with
 * no relay candidate on a side, or when `signal` aborts. Every peer
 * connection it built is closed before it settles, a throw included.
 */
export async function checkTurnRelay(
  iceServer: RTCIceServer,
  signal: AbortSignal,
  createPeerConnection: PeerConnectionFactory = (configuration) =>
    new RTCPeerConnection(configuration),
): Promise<TurnRelayCheckResult> {
  const configuration: RTCConfiguration = {
    iceServers: [iceServer],
    iceTransportPolicy: "relay",
  };
  const built: Array<RTCPeerConnection> = [];
  const build = (): RTCPeerConnection => {
    const connection = createPeerConnection(configuration);
    built.push(connection);
    return connection;
  };
  try {
    const offerer = build();
    const answerer = build();
    const relayCandidates = new Map<RTCPeerConnection, number>([
      [offerer, 0],
      [answerer, 0],
    ]);
    const seen = { refused: false, works: false };
    const ended = new AbortController();
    const stop = AbortSignal.any([signal, ended.signal]);
    const gatheringEnded = (): boolean =>
      offerer.iceGatheringState === "complete" &&
      answerer.iceGatheringState === "complete";
    const endIfNoPath = (): void => {
      if (gatheringEnded() && [...relayCandidates.values()].includes(0))
        ended.abort();
    };
    for (const [connection, other] of [
      [offerer, answerer],
      [answerer, offerer],
    ] as const) {
      connection.addEventListener("icecandidate", (event) => {
        const candidate = event.candidate;
        if (candidate === null) return;
        if (candidate.type === "relay")
          relayCandidates.set(
            connection,
            (relayCandidates.get(connection) ?? 0) + 1,
          );
        other.addIceCandidate(candidate).catch(() => undefined);
      });
      connection.addEventListener("icecandidateerror", (event) => {
        if (CREDENTIAL_REFUSED_CODES.has(event.errorCode)) seen.refused = true;
      });
      connection.addEventListener("icegatheringstatechange", endIfNoPath);
    }
    answerer.addEventListener("datachannel", (event) => {
      const echo = event.channel;
      echo.addEventListener("message", (message) => echo.send(message.data));
    });
    const channel = offerer.createDataChannel("alcove-relay-check");
    channel.addEventListener("open", () => channel.send(CHECK_MESSAGE));
    channel.addEventListener("message", (message) => {
      if (message.data !== CHECK_MESSAGE) return;
      seen.works = true;
      ended.abort();
    });
    const offer = await offerer.createOffer();
    await offerer.setLocalDescription(offer);
    await answerer.setRemoteDescription(offer);
    const answer = await answerer.createAnswer();
    await answerer.setLocalDescription(answer);
    await offerer.setRemoteDescription(answer);
    await delay(stop);
    if (seen.works) return "works";
    if (seen.refused) return "credential_refused";
    return [...relayCandidates.values()].includes(0)
      ? "not_reached"
      : "no_relayed_path";
  } finally {
    for (const connection of built) connection.close();
  }
}

/**
 * The closes the WebSocket relay refuses a hello with that end the check at
 * once. A first 4005 does not: the relay client makes the proof again on the
 * relay's clock, and its failure ends the check where it gives up.
 */
export const REFUSALS_ENDING_THE_CHECK: ReadonlySet<number> = new Set([
  1001, 1009, 1011, 4001, 4002, 4003, 4004, 4007, 4008,
]);
const PROOF_EXPIRED = 4005;
const ROLE_TAKEN = 4006;

type ParkedPair = readonly [
  ParkedWebSocketRelayConnection,
  ParkedWebSocketRelayConnection,
];

/**
 * Park a socket in each role at the WebSocket relay of `relay`, under the
 * exchange id the run's proof is made under and the exchange's relay key;
 * once the relay has paired the two, start both and pass one message from
 * one to the other. Ends at the first refusal, at the message's arrival, or
 * when `signal` aborts. A socket is closed with no start sent unless both
 * are paired, so a partner already waiting at the relay is sent nothing.
 * Every socket it parked is closed before it settles, a throw included.
 */
export async function checkWebSocketRelay(
  relay: { url: string; exchangeId: string },
  relayKey: string,
  signal: AbortSignal,
  park: WebSocketRelayParking = parkWebSocketRelayConnection,
): Promise<WebSocketRelayCheckResult> {
  const closes: Array<number> = [];
  let wake = (): void => undefined;
  const sockets: Array<ParkedWebSocketRelayConnection> = [];
  const removers: Array<() => void> = [];
  const parkInRole = (role: "inviter" | "acceptor") => {
    const socket = park({
      url: relay.url,
      exchangeId: relay.exchangeId,
      role,
      relayKey,
      signal,
      onSetupClose: (code) => {
        closes.push(code);
        wake();
      },
    });
    sockets.push(socket);
    removers.push(socket.onChange(() => wake()));
    return socket;
  };
  const connections: Array<MessageConnection> = [];
  try {
    const parked: ParkedPair = [parkInRole("inviter"), parkInRole("acceptor")];
    for (;;) {
      const outcome = setupOutcome(parked, closes);
      if (outcome !== undefined) return outcome;
      if (parked[0].paired && parked[1].paired) break;
      if (signal.aborted) return { kind: "not_reached" };
      const woken = new AbortController();
      wake = () => woken.abort();
      await delay(AbortSignal.any([signal, woken.signal]));
    }
    try {
      const started = await Promise.race([
        Promise.all([parked[0].start(), parked[1].start()]),
        delay(signal).then(() => undefined),
      ]);
      if (started === undefined) return { kind: "no_relayed_path" };
      connections.push(...started);
      const [sending, receiving] = started;
      await sending.send(CHECK_MESSAGE);
      const received = await Promise.race([
        receiving.receive(),
        delay(signal).then(() => undefined),
      ]);
      return received === CHECK_MESSAGE
        ? { kind: "works" }
        : { kind: "no_relayed_path" };
    } catch {
      return { kind: "no_relayed_path" };
    }
  } finally {
    for (const remove of removers) remove();
    for (const socket of sockets) socket.close();
    for (const connection of connections)
      connection.close().catch(() => undefined);
  }
}

// What the relay has answered so far, or undefined while the check waits.
function setupOutcome(
  parked: ParkedPair,
  closes: ReadonlyArray<number>,
): WebSocketRelayCheckResult | undefined {
  const refusal = closes.find((code) => REFUSALS_ENDING_THE_CHECK.has(code));
  if (refusal !== undefined)
    return {
      kind: "refused",
      closeCode: refusal,
      proofRemadeOnRelayClock: false,
    };
  const failure = parked.find(
    (socket) => socket.failure !== undefined,
  )?.failure;
  const proofExpired = closes.filter((code) => code === PROOF_EXPIRED).length;
  if (proofExpired > 0 && failure !== undefined)
    return {
      kind: "refused",
      closeCode: PROOF_EXPIRED,
      proofRemadeOnRelayClock: proofExpired > 1,
    };
  if (closes.includes(ROLE_TAKEN) && parked.some((socket) => socket.paired))
    return { kind: "admitted" };
  if (failure !== undefined)
    return failure.kind === "protocol"
      ? { kind: "unexpected_message" }
      : { kind: "not_reached" };
  return undefined;
}

/**
 * Check every relay a run of `subject` lists: enroll as the run does, then
 * ask each TURN url and each WebSocket relay the run lists, at once and under
 * one bound started once the enrollment has ended. A default relay url the
 * run leaves out because its enrollment failed is reported as not enrolled
 * and is not contacted. A relay whose request throws is reported not
 * started, a TURN relay whose credential could not be made is reported so,
 * and the others keep their results.
 *
 * @throws {DOMException} `signal`'s reason where it aborts, once every
 *   request it started has closed its peer connections and sockets.
 */
export async function runExchangeRelayCheck(
  subject: ExchangeRelayCheckSubject,
  signal: AbortSignal,
  dependencies: ExchangeRelayCheckDependencies = {},
): Promise<Array<ExchangeRelayCheckLine>> {
  let enrollmentRefusal: DefaultRelayRefusal | undefined;
  const plan = await subject.plan((refusal) => {
    enrollmentRefusal = refusal;
  });
  const now = (dependencies.now ?? (() => new Date()))();
  const turn = plan.relay?.turn ?? [];
  const websocket = plan.websocketRelays.filter(
    (relay) => relay.underPreviousSecret !== true,
  );
  const [relayKey, iceServers] = await Promise.all([
    websocket.length > 0 ? deriveRelayKey(subject.sharedSecret) : "",
    Promise.all(
      turn.map((url) =>
        turnIceServer([url], subject.sharedSecret, now).catch(() => undefined),
      ),
    ),
  ]);
  signal.throwIfAborted();
  const bound = new AbortController();
  const timer = setTimeout(
    () => bound.abort(),
    dependencies.boundMs ?? RELAY_CHECK_BOUND_MS,
  );
  const stop = AbortSignal.any([signal, bound.signal]);
  try {
    const [turnResults, websocketResults] = await Promise.all([
      Promise.all(
        iceServers.map(async (iceServer): Promise<TurnRelayCheckResult> => {
          if (iceServer === undefined) return "credential_not_made";
          try {
            return await checkTurnRelay(
              iceServer,
              stop,
              dependencies.createPeerConnection,
            );
          } catch {
            return "not_started";
          }
        }),
      ),
      Promise.all(
        websocket.map(async (relay): Promise<WebSocketRelayCheckResult> => {
          try {
            return await checkWebSocketRelay(
              relay,
              relayKey,
              stop,
              dependencies.parkWebSocketRelay,
            );
          } catch {
            return { kind: "not_started" };
          }
        }),
      ),
    ]);
    signal.throwIfAborted();
    const lineOf = (
      relay: "turn" | "websocket",
      url: string,
    ): ExchangeRelayCheckLine | undefined => {
      if (relay === "turn") {
        const index = turn.indexOf(url);
        return index === -1
          ? undefined
          : { relay, url, result: turnResults[index] };
      }
      const index = websocket.findIndex((listed) => listed.url === url);
      return index === -1
        ? undefined
        : { relay, url, result: websocketResults[index] };
    };
    const reported = (
      relay: "turn" | "websocket",
      url: string,
    ): ExchangeRelayCheckLine | undefined =>
      lineOf(relay, url) ??
      (subject.hosts.listedOnceEnrolled.includes(url) &&
      enrollmentRefusal !== undefined
        ? { relay, url, notEnrolled: enrollmentRefusal }
        : undefined);
    return [
      ...subject.hosts.turn.map((url) => reported("turn", url)),
      ...subject.hosts.websocket.map((url) => reported("websocket", url)),
    ].filter((line) => line !== undefined);
  } finally {
    clearTimeout(timer);
    bound.abort();
  }
}
