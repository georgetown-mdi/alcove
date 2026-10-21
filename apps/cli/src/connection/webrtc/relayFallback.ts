import {
  AuthenticationError,
  ConnectionError,
  getLogger,
  redactAndSanitizeForDisplay,
  sanitizeErrorForDisplay,
} from "@alcove/core";

import { openWebRtcMessageConnection } from "./webrtcMessageConnection";
import { parkWebSocketRelay } from "./websocketRelayConnection";

import type { WebRtcMessageConnectionOptions } from "./webrtcMessageConnection";
import type {
  ParkedWebSocketRelay,
  WebSocketRelayConnectionOptions,
  WebSocketRelayDial,
} from "./websocketRelayConnection";
import type { WebRtcPathFailure, WebRtcPeerOptions } from "./weriftPeer";
import type { MessageConnection, RendezvousRole } from "@alcove/core";

/**
 * The fallback from WebRTC to the WebSocket relay
 * (docs/spec/WEBRTC_TRANSPORT.md, Falling back to the WebSocket relay): the
 * relays a run lists are dialed and parked as the rendezvous starts, and this
 * side's start goes to them only once the WebRTC path has failed or the
 * partner has started there. The first path to open carries the exchange.
 */

const log = getLogger("webrtc");

/** Which path carries a run's exchange. */
export type ExchangePath =
  { kind: "webrtc" } | { kind: "websocket-relay"; url: string };

/** The open connection a fallback race resolves with, and the path under it. */
export interface RelayFallbackOutcome {
  connection: MessageConnection;
  path: ExchangePath;
}

/** What {@link raceWebRtcAgainstRelays} races. */
export interface RelayFallbackRace {
  /** This side's rendezvous role, which decides where its start is sent. */
  role: RendezvousRole;
  /** The run's relays, parked, in the order the run lists them. */
  relays: ReadonlyArray<ParkedWebSocketRelay>;
  /**
   * Open the WebRTC path. `signal` aborts it when the run is interrupted or
   * the race abandons it, and `onPathFailed` is the WebRTC transport's
   * {@link WebRtcPeerOptions.onPathFailed}.
   */
  openWebRtc: (hooks: {
    signal: AbortSignal;
    onPathFailed: (failure: WebRtcPathFailure) => void;
  }) => Promise<MessageConnection>;
  /** The run's interrupt. */
  signal?: AbortSignal;
}

/**
 * Race the WebRTC path against the parked relays, and resolve with the first
 * to open, closing every other.
 *
 * This side sends its start on the first WebRTC path failure or on the
 * partner's start on any relay, which also abandons WebRTC. An inviter sends it on one paired relay, the first the
 * partner's start arrived on or else the first paired in list order; an
 * acceptor sends it on every relay that is or becomes paired.
 *
 * @throws the WebRTC failure when it is not a path failure or is a
 *   certificate that did not verify, or when every relay has failed too; a
 *   relay's failure when WebRTC was abandoned and every relay failed; a
 *   `closed` {@link ConnectionError} on the run's interrupt.
 */
export function raceWebRtcAgainstRelays(
  race: RelayFallbackRace,
): Promise<RelayFallbackOutcome> {
  return new FallbackRace(race).outcome;
}

class FallbackRace {
  readonly outcome: Promise<RelayFallbackOutcome>;

  private settled = false;
  private startSent = false;
  private pathFailed = false;
  private webRtcEnded = false;
  private webRtcError: unknown;
  private abandoned = false;
  private chosen: ParkedWebSocketRelay | undefined;
  private readonly started = new Set<ParkedWebSocketRelay>();
  private readonly abandon = new AbortController();
  private readonly removeListeners: Array<() => void> = [];
  private resolve!: (outcome: RelayFallbackOutcome) => void;
  private reject!: (error: unknown) => void;
  private readonly onAbort = (): void =>
    this.fail(
      new ConnectionError("the WebRTC rendezvous was cancelled", "closed"),
    );

  constructor(private readonly race: RelayFallbackRace) {
    this.outcome = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    const { signal } = race;
    if (signal?.aborted) {
      this.onAbort();
      return;
    }
    signal?.addEventListener("abort", this.onAbort, { once: true });
    for (const relay of race.relays)
      this.removeListeners.push(
        relay.onChange(() => this.onRelayChange(relay)),
      );
    race
      .openWebRtc({
        signal:
          signal === undefined
            ? this.abandon.signal
            : AbortSignal.any([signal, this.abandon.signal]),
        onPathFailed: (failure) => this.onPathFailed(failure),
      })
      .then(
        (connection) => this.onWebRtcOpen(connection),
        (err: unknown) => this.onWebRtcFailed(err),
      );
    for (const relay of race.relays) this.onRelayChange(relay);
  }

  private onPathFailed(failure: WebRtcPathFailure): void {
    this.pathFailed = true;
    log.debug(`the WebRTC path reported a failure (${failure})`);
    this.sendStart();
  }

  private sendStart(): void {
    if (this.settled || this.startSent) return;
    this.startSent = true;
    log.info(
      this.abandoned
        ? "the exchange partner started the exchange on the WebSocket relay, " +
            "so this side starts it there and stops trying WebRTC"
        : "no WebRTC connection has opened yet, so this side also offers " +
            "the exchange on the WebSocket relay",
    );
    this.advance();
  }

  /** Send this side's start wherever its role sends it now. */
  private advance(): void {
    if (this.settled || !this.startSent) return;
    const live = this.race.relays.filter(
      (relay) => relay.failure === undefined,
    );
    if (this.race.role === "acceptor") {
      for (const relay of live)
        if (relay.paired && !this.started.has(relay)) this.startOn(relay);
      return;
    }
    if (this.chosen !== undefined && this.chosen.failure === undefined) return;
    const pick =
      live.find((relay) => relay.partnerStarted) ??
      live.find((relay) => relay.paired);
    if (pick === undefined) return;
    this.chosen = pick;
    this.startOn(pick);
  }

  private startOn(relay: ParkedWebSocketRelay): void {
    this.started.add(relay);
    relay.start().then(
      (connection) => this.onRelayOpen(relay, connection),
      () => this.onRelayChange(relay),
    );
  }

  private onRelayChange(relay: ParkedWebSocketRelay): void {
    if (this.settled) return;
    if (relay.partnerStarted && relay.failure === undefined) {
      this.abandonWebRtc();
      this.sendStart();
    }
    this.advance();
    if (relay.failure !== undefined) {
      log.debug(
        `the WebSocket relay at ${redactAndSanitizeForDisplay(relay.url)} ` +
          "ended before the exchange started on it",
      );
      this.endIfExhausted();
    }
  }

  private abandonWebRtc(): void {
    if (this.abandoned || this.webRtcEnded) return;
    this.abandoned = true;
    this.abandon.abort();
  }

  private onRelayOpen(
    relay: ParkedWebSocketRelay,
    connection: MessageConnection,
  ): void {
    if (this.settled) {
      void connection.close().catch(() => {});
      return;
    }
    this.abandonWebRtc();
    this.finish({
      connection,
      path: { kind: "websocket-relay", url: relay.url },
    });
  }

  private onWebRtcOpen(connection: MessageConnection): void {
    this.webRtcEnded = true;
    if (this.settled) {
      void connection.close().catch(() => {});
      return;
    }
    this.finish({ connection, path: { kind: "webrtc" } });
  }

  private onWebRtcFailed(err: unknown): void {
    this.webRtcEnded = true;
    if (this.settled) return;
    if (this.abandoned) {
      this.endIfExhausted();
      return;
    }
    if (
      !this.pathFailed ||
      err instanceof AuthenticationError ||
      this.race.signal?.aborted === true
    ) {
      this.fail(err);
      return;
    }
    this.webRtcError = err;
    log.debug(
      `${sanitizeErrorForDisplay(err)}; the exchange can still start on the ` +
        "WebSocket relay",
    );
    this.sendStart();
    this.endIfExhausted();
  }

  /**
   * Fail once neither path can open: WebRTC has ended and every relay has
   * failed. Each relay's refusal is logged, and the run fails with the
   * WebRTC failure, or, where WebRTC was abandoned, with the first relay
   * this side started on.
   */
  private endIfExhausted(): void {
    if (this.settled || !this.webRtcEnded) return;
    if (this.race.relays.some((relay) => relay.failure === undefined)) return;
    const refusals = this.race.relays.flatMap((relay) =>
      relay.failure === undefined ? [] : [relay.failure],
    );
    const relayFailure =
      [...this.started].find((relay) => relay.failure !== undefined)?.failure ??
      refusals[0];
    const primary = this.abandoned
      ? relayFailure
      : (this.webRtcError ?? relayFailure);
    for (const refusal of refusals)
      if (refusal !== primary) log.warn(sanitizeErrorForDisplay(refusal));
    this.fail(primary);
  }

  private finish(outcome: RelayFallbackOutcome): void {
    this.end();
    log.info(
      outcome.path.kind === "webrtc"
        ? "the exchange runs over the WebRTC connection"
        : "the exchange runs over the WebSocket relay at " +
            redactAndSanitizeForDisplay(outcome.path.url),
    );
    this.resolve(outcome);
  }

  private fail(error: unknown): void {
    if (this.settled) return;
    this.end();
    this.reject(error);
  }

  private end(): void {
    this.settled = true;
    this.race.signal?.removeEventListener("abort", this.onAbort);
    for (const remove of this.removeListeners.splice(0)) remove();
    for (const relay of this.race.relays) relay.close();
    if (!this.webRtcEnded) this.abandon.abort();
  }
}

/**
 * Open the run's connection to its partner: over WebRTC alone when the run
 * lists no WebSocket relay, which dials nothing else, and otherwise raced
 * against those relays by {@link raceWebRtcAgainstRelays}.
 *
 * @param relayOptions Tests only.
 */
export async function openWebRtcWithRelayFallback(
  options: WebRtcPeerOptions & WebRtcMessageConnectionOptions,
  relays: ReadonlyArray<WebSocketRelayDial>,
  relayOptions: WebSocketRelayConnectionOptions = {},
): Promise<MessageConnection> {
  if (relays.length === 0) return openWebRtcMessageConnection(options);
  const parked = relays.map((dial) =>
    parkWebSocketRelay(dial, {
      rendezvousTimeoutMs: options.rendezvousTimeoutMs,
      channelOpenTimeoutMs: options.channelOpenTimeoutMs,
      inactivityTimeoutMs: options.inactivityTimeoutMs,
      closeFlushTimeoutMs: options.closeFlushTimeoutMs,
      ...relayOptions,
    }),
  );
  const { connection } = await raceWebRtcAgainstRelays({
    role: options.role,
    relays: parked,
    signal: options.signal,
    openWebRtc: ({ signal, onPathFailed }) =>
      openWebRtcMessageConnection({ ...options, signal, onPathFailed }),
  });
  return connection;
}
