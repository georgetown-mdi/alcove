import { ConnectionError, deriveRelayKey, getLogger } from "@alcove/core";

import { parkWebSocketRelayConnection } from "./websocketRelayConnection";

import type {
  ParkedWebSocketRelayConnection,
  WebSocketRelayConnectionOptions,
} from "./websocketRelayConnection";
import type { PeerCloseOutcome } from "./waitForPeerClose";
import type { RendezvousRole } from "@alcove/core";
import type { RunConnection } from "./runConnection";
import type { WebSocketRelayForRun } from "./runRelayPlan";

/**
 * The fallback from WebRTC to the WebSocket relay
 * (docs/spec/WEBRTC_TRANSPORT.md, Falling back to the WebSocket relay): the
 * relays a run lists are dialed and parked as the rendezvous starts, and this
 * side's start goes to them only once the WebRTC path has failed or the
 * partner has started there. The first path to open carries the exchange. The
 * command-line application races the same way on the same wire
 * (apps/cli/src/connection/webrtc/relayFallback.ts).
 */

const log = getLogger("relayFallback");

/**
 * A failure of the path to the partner that a fallback starts on:
 * - `channel-not-opened`: the channel-open budget expired;
 * - `connection-failed`: the channel failed before it opened, as when the
 *   peer connection reports ICE failure;
 * - `signaling-unreachable`: a registration with the coordination server
 *   failed with no refusal from it, or its socket dropped once registered.
 */
export type WebRtcPathFailure =
  "channel-not-opened" | "connection-failed" | "signaling-unreachable";

/** What a run's WebRTC open is handed. */
export interface WebRtcPathHooks {
  /** Aborts the open when the run is interrupted or the race abandons it. */
  signal: AbortSignal;
  /**
   * Report a failure of the path to the partner, the open going on as it
   * would without the call. Absent where the run lists no relay.
   */
  onPathFailed?: (failure: WebRtcPathFailure) => void;
}

/** Which path carries a run's exchange. */
export type ExchangePath =
  { kind: "webrtc" } | { kind: "websocket-relay"; url: string };

/** The open connection a fallback race resolves with, and the path under it. */
export interface RelayFallbackOutcome {
  runConnection: RunConnection;
  path: ExchangePath;
}

/** What {@link raceWebRtcAgainstRelays} races. */
export interface RelayFallbackRace {
  /** This side's rendezvous role, which decides where its start is sent. */
  role: RendezvousRole;
  /** The run's relays, parked, in the order the run lists them. */
  relays: ReadonlyArray<ParkedWebSocketRelayConnection>;
  /** Open the WebRTC path. */
  openWebRtc: (hooks: Required<WebRtcPathHooks>) => Promise<RunConnection>;
  /** The run's interrupt. */
  signal?: AbortSignal;
}

/**
 * Race the WebRTC path against the parked relays, and resolve with the first
 * to open, closing every other.
 *
 * This side sends its start on the first WebRTC path failure or on the
 * partner's start on any relay, which also abandons WebRTC. An inviter sends
 * it on one paired relay, the first the partner's start arrived on or else
 * the first paired in list order, and moves it to the next by that rule when
 * that relay fails, or when its pairing has ended and the partner's start
 * waits on another relay, closing that relay first; an acceptor sends it on
 * every relay that is or becomes paired.
 *
 * @throws the WebRTC failure when it is not a path failure or is of kind
 *   `security`, or when every relay has failed too; a relay's failure when
 *   WebRTC was abandoned and every relay failed; a `closed`
 *   {@link ConnectionError} on the run's interrupt.
 */
export function raceWebRtcAgainstRelays(
  race: RelayFallbackRace,
): Promise<RelayFallbackOutcome> {
  return new FallbackRace(race).outcome;
}

/** Close a connection no path will carry, and free its transport. */
function closeUnused(runConnection: RunConnection): void {
  void runConnection.connection.close().catch(() => {});
  try {
    runConnection.release();
  } catch (err) {
    log.error("releasing an unused connection failed:", err);
  }
}

function relayOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "its address";
  }
}

class FallbackRace {
  readonly outcome: Promise<RelayFallbackOutcome>;

  private settled = false;
  private startSent = false;
  private pathFailed = false;
  private webRtcEnded = false;
  private webRtcError: unknown;
  private abandoned = false;
  private chosen: ParkedWebSocketRelayConnection | undefined;
  private readonly started = new Set<ParkedWebSocketRelayConnection>();
  private readonly dropped = new Set<ParkedWebSocketRelayConnection>();
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
        (runConnection) => this.onWebRtcOpen(runConnection),
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
    const live = this.race.relays.filter((relay) => this.isLive(relay));
    if (this.race.role === "acceptor") {
      for (const relay of live)
        if (relay.paired && !this.started.has(relay)) this.startOn(relay);
      return;
    }
    const chosen = this.chosen;
    if (chosen !== undefined && this.isLive(chosen)) {
      if (chosen.paired) return;
      const partnerStart = live.find(
        (relay) => relay !== chosen && relay.partnerStarted,
      );
      if (partnerStart === undefined) return;
      // A start sent into a pairing that has ended reaches nobody, and the
      // chosen relay would send it again on re-pairing: close it first, so
      // one live relay at a time holds the inviter's start.
      this.dropped.add(chosen);
      chosen.close();
      log.debug(
        `the exchange partner left the WebSocket relay at ` +
          `${relayOrigin(chosen.url)} and started on the one at ` +
          `${relayOrigin(partnerStart.url)}, so this side starts there`,
      );
    }
    const pick =
      live.find((relay) => relay.partnerStarted) ??
      live.find((relay) => relay.paired);
    if (pick === undefined) return;
    this.chosen = pick;
    this.startOn(pick);
  }

  /** Whether a relay can still carry the exchange: not failed, and not closed by this race. */
  private isLive(relay: ParkedWebSocketRelayConnection): boolean {
    return relay.failure === undefined && !this.dropped.has(relay);
  }

  private startOn(relay: ParkedWebSocketRelayConnection): void {
    this.started.add(relay);
    relay.start().then(
      (connection) =>
        this.onRelayOpen(relay, { connection, release: () => {} }),
      () => this.onRelayChange(relay),
    );
  }

  private onRelayChange(relay: ParkedWebSocketRelayConnection): void {
    if (this.settled || this.dropped.has(relay)) return;
    if (relay.partnerStarted && relay.failure === undefined) {
      this.abandonWebRtc();
      this.sendStart();
    }
    this.advance();
    if (relay.failure !== undefined) {
      log.debug(
        `the WebSocket relay at ${relayOrigin(relay.url)} ended before the ` +
          "exchange started on it",
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
    relay: ParkedWebSocketRelayConnection,
    runConnection: RunConnection,
  ): void {
    if (this.settled) {
      closeUnused(runConnection);
      return;
    }
    this.abandonWebRtc();
    this.finish({
      runConnection,
      path: { kind: "websocket-relay", url: relay.url },
    });
  }

  private onWebRtcOpen(runConnection: RunConnection): void {
    this.webRtcEnded = true;
    if (this.settled) {
      closeUnused(runConnection);
      return;
    }
    this.finish({ runConnection, path: { kind: "webrtc" } });
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
      (err instanceof ConnectionError && err.kind === "security") ||
      this.race.signal?.aborted === true
    ) {
      this.fail(err);
      return;
    }
    this.webRtcError = err;
    log.debug(
      "the WebRTC connection did not open; the exchange can still start on " +
        "the WebSocket relay",
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
    if (this.race.relays.some((relay) => this.isLive(relay))) return;
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
      if (refusal !== primary) log.warn(refusal.message);
    this.fail(primary);
  }

  private finish(outcome: RelayFallbackOutcome): void {
    this.end();
    log.info(
      outcome.path.kind === "webrtc"
        ? "the exchange runs over the WebRTC connection"
        : `the exchange runs over the WebSocket relay at ${relayOrigin(outcome.path.url)}`,
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

/** The run notice stating which path carries the exchange. */
function exchangePathNotice(path: ExchangePath): string {
  return path.kind === "webrtc"
    ? "This exchange runs over the WebRTC connection."
    : `This exchange runs over the WebSocket relay at ${relayOrigin(path.url)}.`;
}

/** What {@link openRunConnectionWithRelayFallback} takes. */
export interface RunConnectionWithRelayFallbackOptions {
  /** This side's rendezvous role. */
  role: RendezvousRole;
  /** The run's current shared secret, which the relay key derives from. */
  sharedSecret: string;
  /** The WebSocket relays the run lists, in its order. */
  relays: ReadonlyArray<WebSocketRelayForRun>;
  /** The run's interrupt, which also cuts a relay connection's clean close
   * short. */
  signal: AbortSignal;
  /** Reports how a relay connection's flushing close ended. */
  onCloseOutcome: (outcome: PeerCloseOutcome) => void;
  /** Takes the notice stating which path carries the exchange. */
  onRunNotice?: (message: string) => void;
  /** Open the WebRTC path. */
  openWebRtc: (hooks: WebRtcPathHooks) => Promise<RunConnection>;
}

/**
 * Open the run's connection to its partner: over WebRTC alone when the run
 * lists no WebSocket relay, which dials nothing else and hands the WebRTC open
 * the run's own signal, and otherwise raced against those relays by
 * {@link raceWebRtcAgainstRelays}, each proven to under the relay key the
 * shared secret derives. A raced run states the path that carries it through
 * `onRunNotice`.
 *
 * @param relayOptions Tests only.
 */
export async function openRunConnectionWithRelayFallback(
  options: RunConnectionWithRelayFallbackOptions,
  relayOptions: Partial<WebSocketRelayConnectionOptions> = {},
): Promise<RunConnection> {
  const { role, relays, signal } = options;
  if (relays.length === 0) return options.openWebRtc({ signal });
  const relayKey = await deriveRelayKey(options.sharedSecret);
  const relaysInterrupt = new AbortController();
  const parked = relays.map((relay) =>
    parkWebSocketRelayConnection({
      url: relay.url,
      exchangeId: relay.exchangeId,
      role,
      relayKey,
      signal: relaysInterrupt.signal,
      onCloseOutcome: options.onCloseOutcome,
      ...relayOptions,
    }),
  );
  const outcome = raceWebRtcAgainstRelays({
    role,
    relays: parked,
    signal,
    openWebRtc: options.openWebRtc,
  });
  // Behind the race's own listener: an interrupt while it runs closes each
  // relay as unused, and one after it cuts the carrying relay's close short.
  const followInterrupt = (): void => relaysInterrupt.abort();
  if (signal.aborted) followInterrupt();
  else signal.addEventListener("abort", followInterrupt, { once: true });
  const { runConnection, path } = await outcome;
  options.onRunNotice?.(exchangePathNotice(path));
  return runConnection;
}
