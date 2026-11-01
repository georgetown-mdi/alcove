import {
  ConnectionError,
  InternalConsistencyError,
  deriveRelayKey,
  getLogger,
  raceWebRtcAgainstRelays,
} from "@alcove/core";

import { parkWebSocketRelayConnection } from "./websocketRelayConnection";

import type {
  ExchangePath,
  RelayFallbackAdapter,
  RendezvousRole,
  WebRtcPathFailure,
} from "@alcove/core";
import type { PeerCloseOutcome } from "./waitForPeerClose";
import type { RunConnection } from "./runConnection";
import type { WebSocketRelayConnectionOptions } from "./websocketRelayConnection";
import type { WebSocketRelayForRun } from "./runRelayPlan";

export type { WebRtcPathFailure } from "@alcove/core";

/**
 * The fallback from WebRTC to the WebSocket relay
 * (docs/spec/WEBRTC_TRANSPORT.md, Falling back to the WebSocket relay), run by
 * core's {@link raceWebRtcAgainstRelays} over this application's transports.
 */

const log = getLogger("relayFallback");

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

/**
 * The web application's side of the race: a relay connection holds nothing
 * beside its socket, a failure of kind `security` stays fatal after a path
 * failure, and a relay is named by its origin.
 *
 * @internal
 */
export const WEB_RELAY_FALLBACK: RelayFallbackAdapter<RunConnection> = {
  log,
  fromRelay: (connection) => ({ connection, release: () => {} }),
  closeUnused,
  isFatal: (error) =>
    error instanceof ConnectionError && error.kind === "security",
  displayUrl: relayOrigin,
  describeWebRtcFailure: () => "the WebRTC connection did not open",
  displayRefusal: (refusal) => refusal.message,
};

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
  /** The run's previous secret, which the key of each relay listed
   * `underPreviousSecret` derives from. */
  previousSharedSecret?: string;
  /** The WebSocket relays the run lists, in its order. */
  relays: ReadonlyArray<WebSocketRelayForRun>;
  /** Each relay connection's
   * {@link WebSocketRelayConnectionOptions.afterCutRotation}. */
  afterCutRotation?: boolean;
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
 * shared secret derives, or the previous secret for a relay listed under it.
 * A raced run states the path that carries it through `onRunNotice`.
 *
 * @param relayOptions Tests only.
 * @throws {InternalConsistencyError} if a relay is listed under a previous
 *   secret the options do not name.
 */
export async function openRunConnectionWithRelayFallback(
  options: RunConnectionWithRelayFallbackOptions,
  relayOptions: Partial<WebSocketRelayConnectionOptions> = {},
): Promise<RunConnection> {
  const { role, relays, signal, previousSharedSecret } = options;
  if (relays.length === 0) return options.openWebRtc({ signal });
  const underPrevious = relays.some((relay) => relay.underPreviousSecret);
  if (underPrevious && previousSharedSecret === undefined)
    throw new InternalConsistencyError(
      "a WebSocket relay is listed under a previous secret the run does not hold",
    );
  const relayKey = await deriveRelayKey(options.sharedSecret);
  const previousRelayKey =
    underPrevious && previousSharedSecret !== undefined
      ? await deriveRelayKey(previousSharedSecret)
      : relayKey;
  const relaysInterrupt = new AbortController();
  const parked = relays.map((relay) =>
    parkWebSocketRelayConnection({
      url: relay.url,
      exchangeId: relay.exchangeId,
      role,
      relayKey:
        relay.underPreviousSecret === true ? previousRelayKey : relayKey,
      signal: relaysInterrupt.signal,
      onCloseOutcome: options.onCloseOutcome,
      ...(options.afterCutRotation === true && { afterCutRotation: true }),
      ...relayOptions,
    }),
  );
  const outcome = raceWebRtcAgainstRelays(
    { role, relays: parked, signal, openWebRtc: options.openWebRtc },
    WEB_RELAY_FALLBACK,
  );
  // Behind the race's own listener: an interrupt while it runs closes each
  // relay as unused, and one after it cuts the carrying relay's close short.
  const followInterrupt = (): void => relaysInterrupt.abort();
  if (signal.aborted) followInterrupt();
  else signal.addEventListener("abort", followInterrupt, { once: true });
  const { connection, path } = await outcome;
  options.onRunNotice?.(exchangePathNotice(path));
  return connection;
}
