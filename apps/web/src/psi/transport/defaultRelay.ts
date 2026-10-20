/**
 * The default relay a build names (`VITE_DEFAULT_RELAY_TURN_URL`,
 * `VITE_DEFAULT_RELAY_REGISTRAR_URL` and, optionally,
 * `VITE_DEFAULT_RELAY_WEBSOCKET_URL`). An invitation this build creates names
 * it, its registrar and its WebSocket relay, and every browser run lists its
 * TURN url and its WebSocket relay url beside any relay the invitation or this
 * browser's own setting names, once the run has enrolled its relay key at the
 * relay's registrar without a token (`enrollRelayKeyWithinWait` in core),
 * right before it connects. The key and the exchange id it is enrolled under
 * both derive from the run's current shared secret.
 */

import {
  MAX_RELAY_LOCATOR_URLS,
  enrollRelayKeyWithinWait,
  getLogger,
  turnUrlIsAllowed,
  webSocketRelayUrlIsAllowed,
} from "@alcove/core";

import { defaultRelaySetting } from "@utils/clientConfig";

import type { DefaultRelaySetting } from "@utils/clientConfig";
import type { RelayLocator } from "./rendezvous";
import type { RelayUrls } from "./ownRelaySetting";

const log = getLogger("defaultRelay");

/**
 * How long a dial waits for its enrollment at the default relay's registrar
 * before it connects without the relay. An arbitrary working value, raised on
 * request: a registrar that is up answers with one HTTPS request, a few
 * network round trips, which fits well inside it even on a slow link, and a
 * registrar that is down or slow costs a dial no more than this.
 */
export const DEFAULT_RELAY_DIAL_WAIT_MS = 3_000;

/** What the default relay's enrollment reads from its surroundings, and where
 * it reports a failure: injectable for tests. */
export interface DefaultRelayDependencies {
  /** The build's default relay; {@link defaultRelaySetting} when unset. */
  setting?: () => DefaultRelaySetting | undefined;
  /** The bounded enrollment; core's {@link enrollRelayKeyWithinWait}. */
  enroll?: typeof enrollRelayKeyWithinWait;
  /** Cancels the enrollment and the wait for it. */
  signal?: AbortSignal;
  /** How long a dial waits; {@link DEFAULT_RELAY_DIAL_WAIT_MS} when unset. */
  dialWaitMs?: number;
  /** Receives {@link DEFAULT_RELAY_NOT_ENROLLED_NOTICE} when the enrollment
   * fails. */
  onRunNotice?: (message: string) => void;
}

/**
 * The relay an invitation names: `ownRelay`, followed by the default relay's
 * TURN url when the build names one and `allowedRelays` keeps it, once, and
 * only where the locator has room for it under {@link MAX_RELAY_LOCATOR_URLS}.
 * Where `ownRelay` names no WebSocket relay, the result names the default
 * relay's when the build names one and `allowedRelays` keeps it. Where the
 * result names the default relay's TURN url or its WebSocket relay url, it
 * also names the default relay's registrar, where a command-line party enrolls
 * without a token. A new invitation and a managed re-invite both name it this
 * way.
 */
export function invitationRelayWithDefault(
  ownRelay: RelayUrls | undefined,
  defaultRelay: DefaultRelaySetting | undefined,
  allowedRelays: ReadonlyArray<string> | undefined,
): RelayUrls | undefined {
  if (defaultRelay === undefined) return ownRelay;
  const relay = withDefaultWebSocketRelay(
    ownRelay,
    defaultRelay,
    allowedRelays,
  );
  const withRegistrar = (named: RelayUrls | undefined): RelayUrls => ({
    ...named,
    registrar: defaultRelay.registrarUrl,
  });
  const namesDefaultWebSocketRelay =
    defaultRelay.websocketUrl !== undefined &&
    relay?.websocket === defaultRelay.websocketUrl;
  const turn = relay?.turn ?? [];
  if (
    !turnUrlIsAllowed(defaultRelay.turnUrl, allowedRelays) ||
    (!turn.includes(defaultRelay.turnUrl) &&
      turn.length >= MAX_RELAY_LOCATOR_URLS)
  )
    return namesDefaultWebSocketRelay ? withRegistrar(relay) : relay;
  if (turn.includes(defaultRelay.turnUrl)) return withRegistrar(relay);
  return withRegistrar({ ...relay, turn: [...turn, defaultRelay.turnUrl] });
}

// `relay` naming the default WebSocket relay where it names none of its own,
// the build names one and `allowedRelays` keeps it.
function withDefaultWebSocketRelay(
  relay: RelayUrls | undefined,
  defaultRelay: DefaultRelaySetting,
  allowedRelays: ReadonlyArray<string> | undefined,
): RelayUrls | undefined {
  const websocket = defaultRelay.websocketUrl;
  if (
    relay?.websocket !== undefined ||
    websocket === undefined ||
    !webSocketRelayUrlIsAllowed(websocket, allowedRelays)
  )
    return relay;
  return { ...relay, websocket };
}

/**
 * The run notice a run shows, as it connects, when its enrollment at the
 * default relay fails.
 */
export const DEFAULT_RELAY_NOT_ENROLLED_NOTICE =
  "The site's relay server could not be set up for this exchange. " +
  "Connecting without it.";

/** What {@link relayWithDefaultForRun} lists once the default relay is added. */
export interface RelayWithDefault {
  /** The relay the run's peer connection gathers against; none when absent. */
  relay?: RelayLocator;
  /** The default relay's WebSocket relay url, where the build names one, the
   * allowed relays keep it and the run's enrollment there confirmed. */
  defaultWebSocketRelay?: string;
}

/**
 * The relay a browser run dials with: `relay`, this browser's own and the
 * invitation's (`relayForRun`), then the build's default relay once one
 * attempt to enroll the run's key at its registrar confirms, within
 * {@link DEFAULT_RELAY_DIAL_WAIT_MS}: its TURN url, and its WebSocket relay
 * url as `defaultWebSocketRelay`. A same-key repeat confirms. Otherwise the
 * default relay's TURN url is left out, even where the invitation names it,
 * and the run dials with the rest. A refused, unreachable or unanswered
 * enrollment shows {@link DEFAULT_RELAY_NOT_ENROLLED_NOTICE} through
 * `onRunNotice`, once, before this returns; a cancelled one shows nothing.
 * Each of the default relay's urls `allowedRelays` leaves out is not listed,
 * and a default relay whose every url it leaves out is not enrolled at;
 * unset keeps them.
 */
export async function relayWithDefaultForRun(
  sharedSecret: string,
  relay: RelayLocator | undefined,
  allowedRelays: ReadonlyArray<string> | undefined,
  dependencies: DefaultRelayDependencies = {},
): Promise<RelayWithDefault> {
  const unchanged = relay !== undefined ? { relay } : {};
  const setting = (dependencies.setting ?? defaultRelaySetting)();
  if (setting === undefined) return unchanged;
  const keepsTurn = turnUrlIsAllowed(setting.turnUrl, allowedRelays);
  const websocketUrl =
    setting.websocketUrl !== undefined &&
    webSocketRelayUrlIsAllowed(setting.websocketUrl, allowedRelays)
      ? setting.websocketUrl
      : undefined;
  if (!keepsTurn && websocketUrl === undefined) return unchanged;
  const enroll = dependencies.enroll ?? enrollRelayKeyWithinWait;
  const enrollment = await enroll(
    { registrarUrl: setting.registrarUrl, sharedSecret },
    {
      waitMs: dependencies.dialWaitMs ?? DEFAULT_RELAY_DIAL_WAIT_MS,
      ...(dependencies.signal !== undefined && {
        signal: dependencies.signal,
      }),
    },
  );
  if (enrollment.kind === "failed") {
    log.warn(
      `the default relay's registrar did not enroll this exchange ` +
        `(${enrollment.detail}), so this run connects without it`,
    );
    dependencies.onRunNotice?.(DEFAULT_RELAY_NOT_ENROLLED_NOTICE);
  }
  const enrolled = enrollment.kind === "enrolled";
  const listsWebSocketRelay =
    enrolled && websocketUrl !== undefined
      ? { defaultWebSocketRelay: websocketUrl }
      : {};
  if (!keepsTurn) return { ...unchanged, ...listsWebSocketRelay };
  const others = (relay?.turn ?? []).filter((url) => url !== setting.turnUrl);
  const turn = enrolled ? [...others, setting.turnUrl] : others;
  const stun = [...(relay?.stun ?? [])];
  return {
    ...(turn.length + stun.length > 0 && { relay: { turn, stun } }),
    ...listsWebSocketRelay,
  };
}
