import { ConnectionError } from "../errors";

import type logLibrary from "loglevel";
import type { MessageConnection } from "./messageConnection";
import type { RendezvousRole } from "../rendezvousRoles";

/**
 * The fallback from WebRTC to the WebSocket relay
 * (docs/spec/WEBRTC_TRANSPORT.md, Falling back to the WebSocket relay): the
 * relays a run lists are dialed and parked as the rendezvous starts, and this
 * side's start goes to them only once the WebRTC path has failed or the
 * partner has started there. The first path to open carries the exchange.
 * Both applications race through this one implementation, so a CLI party and
 * a browser party follow one set of rules on the wire; each supplies its own
 * transports and display through a {@link RelayFallbackAdapter}
 * (apps/cli/src/connection/webrtc/relayFallback.ts,
 * apps/web/src/psi/transport/relayFallback.ts).
 */

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

/** Which path carries a run's exchange. */
export type ExchangePath =
  { kind: "webrtc" } | { kind: "websocket-relay"; url: string };

/** The open connection a fallback race resolves with, and the path under it. */
export interface RelayFallbackOutcome<Connection> {
  connection: Connection;
  path: ExchangePath;
}

/** A WebSocket relay the run dialed and holds this side's start on. */
export interface ParkedRelay {
  /** The relay's address. */
  readonly url: string;
  /** Whether the relay has paired this side with its partner on the socket held now. */
  readonly paired: boolean;
  /** Whether the partner's start has reached this side on that pairing. */
  readonly partnerStarted: boolean;
  /** Why the relay ended before the exchange started on it, once it has. */
  readonly failure: ConnectionError | undefined;
  /**
   * Call `listener` after each change of `paired`, `partnerStarted` or
   * `failure`, until {@link close}. Returns the call that removes it.
   */
  onChange(listener: () => void): () => void;
  /**
   * Send this side's start, and resolve with the connection once the
   * partner's start has arrived. Each call returns the same promise.
   */
  start(): Promise<MessageConnection>;
  /** Stop dialing and close the socket, unless {@link start} has resolved. */
  close(): void;
}

/** What {@link raceWebRtcAgainstRelays} races. */
export interface RelayFallbackRace<Connection> {
  /** This side's rendezvous role, which decides where its start is sent. */
  role: RendezvousRole;
  /** The run's relays, parked, in the order the run lists them. */
  relays: ReadonlyArray<ParkedRelay>;
  /**
   * Open the WebRTC path. `signal` aborts it when the run is interrupted or
   * the race abandons it, and `onPathFailed` takes each failure of the path
   * to the partner while the open goes on.
   */
  openWebRtc: (hooks: {
    signal: AbortSignal;
    onPathFailed: (failure: WebRtcPathFailure) => void;
  }) => Promise<Connection>;
  /** The run's interrupt. */
  signal?: AbortSignal;
}

/** What an application supplies to race its own transports. */
export interface RelayFallbackAdapter<Connection> {
  /** Where the race's lines are logged. */
  log: Pick<logLibrary.Logger, "debug" | "info" | "warn">;
  /** The connection the race resolves with for a relay that opened. */
  fromRelay: (connection: MessageConnection) => Connection;
  /** Close a connection that opened after another path carried the exchange. */
  closeUnused: (connection: Connection) => void;
  /** Whether a WebRTC failure fails the run even after a path failure. */
  isFatal: (error: unknown) => boolean;
  /** A relay's address as a logged line shows it. */
  displayUrl: (url: string) => string;
  /** The WebRTC failure the relays can still recover from, as logged. */
  describeWebRtcFailure: (error: unknown) => string;
  /** A relay's refusal as the warning logged for it shows it. */
  displayRefusal: (refusal: ConnectionError) => string;
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
 * @throws the WebRTC failure when it is not a path failure or the adapter
 *   takes it as fatal, or when every relay has failed too; a relay's failure
 *   when WebRTC was abandoned and every relay failed; a `closed`
 *   {@link ConnectionError} on the run's interrupt.
 */
export function raceWebRtcAgainstRelays<Connection>(
  race: RelayFallbackRace<Connection>,
  adapter: RelayFallbackAdapter<Connection>,
): Promise<RelayFallbackOutcome<Connection>> {
  return new FallbackRace(race, adapter).outcome;
}

class FallbackRace<Connection> {
  readonly outcome: Promise<RelayFallbackOutcome<Connection>>;

  private settled = false;
  private startSent = false;
  private pathFailed = false;
  private webRtcEnded = false;
  private webRtcError: unknown;
  private abandoned = false;
  private chosen: ParkedRelay | undefined;
  private readonly started = new Set<ParkedRelay>();
  private readonly dropped = new Set<ParkedRelay>();
  private readonly abandon = new AbortController();
  private readonly removeListeners: Array<() => void> = [];
  private resolve!: (outcome: RelayFallbackOutcome<Connection>) => void;
  private reject!: (error: unknown) => void;
  private readonly onAbort = (): void =>
    this.fail(
      new ConnectionError("the WebRTC rendezvous was cancelled", "closed"),
    );

  constructor(
    private readonly race: RelayFallbackRace<Connection>,
    private readonly adapter: RelayFallbackAdapter<Connection>,
  ) {
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
    this.adapter.log.debug(`the WebRTC path reported a failure (${failure})`);
    this.sendStart();
  }

  private sendStart(): void {
    if (this.settled || this.startSent) return;
    this.startSent = true;
    this.adapter.log.info(
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
      this.adapter.log.debug(
        "the exchange partner left the WebSocket relay at " +
          `${this.adapter.displayUrl(chosen.url)} and started on the one at ` +
          `${this.adapter.displayUrl(partnerStart.url)}, so this side starts ` +
          "there",
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
  private isLive(relay: ParkedRelay): boolean {
    return relay.failure === undefined && !this.dropped.has(relay);
  }

  private startOn(relay: ParkedRelay): void {
    this.started.add(relay);
    relay.start().then(
      (connection) =>
        this.onRelayOpen(relay, this.adapter.fromRelay(connection)),
      () => this.onRelayChange(relay),
    );
  }

  private onRelayChange(relay: ParkedRelay): void {
    if (this.settled || this.dropped.has(relay)) return;
    if (relay.partnerStarted && relay.failure === undefined) {
      this.abandonWebRtc();
      this.sendStart();
    }
    this.advance();
    if (relay.failure !== undefined) {
      this.adapter.log.debug(
        `the WebSocket relay at ${this.adapter.displayUrl(relay.url)} ended ` +
          "before the exchange started on it",
      );
      this.endIfExhausted();
    }
  }

  private abandonWebRtc(): void {
    if (this.abandoned || this.webRtcEnded) return;
    this.abandoned = true;
    this.abandon.abort();
  }

  private onRelayOpen(relay: ParkedRelay, connection: Connection): void {
    if (this.settled) {
      this.adapter.closeUnused(connection);
      return;
    }
    this.abandonWebRtc();
    this.finish({
      connection,
      path: { kind: "websocket-relay", url: relay.url },
    });
  }

  private onWebRtcOpen(connection: Connection): void {
    this.webRtcEnded = true;
    if (this.settled) {
      this.adapter.closeUnused(connection);
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
      this.adapter.isFatal(err) ||
      this.race.signal?.aborted === true
    ) {
      this.fail(err);
      return;
    }
    this.webRtcError = err;
    this.adapter.log.debug(
      `${this.adapter.describeWebRtcFailure(err)}; the exchange can still ` +
        "start on the WebSocket relay",
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
      if (refusal !== primary)
        this.adapter.log.warn(this.adapter.displayRefusal(refusal));
    this.fail(primary);
  }

  private finish(outcome: RelayFallbackOutcome<Connection>): void {
    this.end();
    this.adapter.log.info(
      outcome.path.kind === "webrtc"
        ? "the exchange runs over the WebRTC connection"
        : "the exchange runs over the WebSocket relay at " +
            this.adapter.displayUrl(outcome.path.url),
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
