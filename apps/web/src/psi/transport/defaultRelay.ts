/**
 * The default relay a build names (`VITE_DEFAULT_RELAY_TURN_URL`,
 * `VITE_DEFAULT_RELAY_REGISTRAR_URL` and, optionally,
 * `VITE_DEFAULT_RELAY_WEBSOCKET_URL`), in use where the build turns it on
 * (`VITE_DEFAULT_RELAY_MODE=on`) or this browser's user did
 * (./defaultRelaySwitch.ts). In use, an invitation this browser creates names
 * it, its registrar and its WebSocket relay, and every browser run lists its
 * TURN url and its WebSocket relay url beside any relay the invitation or this
 * browser's own setting names, once the run has enrolled its relay key at the
 * relay's registrar without a token (`enrollRelayKeyWithinWait` in core),
 * right before it connects. The key and the exchange id it is enrolled under
 * both derive from the run's current shared secret. Switched off, a run lists
 * it only where the invitation it accepted names it.
 */

import {
  MAX_RELAY_LOCATOR_URLS,
  enrollRelayKeyWithinWait,
  getLogger,
  turnUrlIsAllowed,
  webSocketRelayUrlIsAllowed,
} from "@alcove/core";

import { defaultRelayBuild } from "@utils/clientConfig";

import { readDefaultRelaySwitch } from "./defaultRelaySwitch";

import type {
  DefaultRelayBuild,
  DefaultRelaySetting,
} from "@utils/clientConfig";
import type { RelayUrls } from "./ownRelaySetting";
import type { RunRelay } from "./rendezvous";

const log = getLogger("defaultRelay");

/**
 * The default relay this browser's exchanges use: the build's where the build
 * turns it on, or offers it switched off and this browser's user turned it
 * on; none otherwise.
 */
export function defaultRelayInUse(
  build: () => DefaultRelayBuild = defaultRelayBuild,
  switchedOn: () => boolean = readDefaultRelaySwitch,
): DefaultRelaySetting | undefined {
  const offer = build();
  if (offer.kind === "none") return undefined;
  return offer.kind === "on" || switchedOn() ? offer.relay : undefined;
}

/**
 * Whether `relay`, an invitation's, names the default relay: its TURN url or
 * its WebSocket relay url.
 */
export function namesDefaultRelay(
  relay: RelayUrls | undefined,
  defaultRelay: DefaultRelaySetting,
): boolean {
  return (
    (relay?.turn ?? []).includes(defaultRelay.turnUrl) ||
    (defaultRelay.websocketUrl !== undefined &&
      relay?.websocket === defaultRelay.websocketUrl)
  );
}

/**
 * The default relay a run uses. `in-use`: {@link defaultRelayInUse} names
 * it. `invited`: the build offers it switched off, this browser has not
 * turned it on, and the invitation the run accepted names it, so the run uses
 * it as one in use. `off`: the build offers it switched off and the run does
 * not use it; `relay` is the one left out. `none`: the build names none.
 */
export type DefaultRelayForRun =
  | { kind: "in-use" | "invited" | "off"; relay: DefaultRelaySetting }
  | { kind: "none" };

/** The {@link DefaultRelayForRun} of a run whose accepted invitation names
 * `invitationRelay`, which an inviter's own run passes as `undefined`. */
export function defaultRelayForRun(
  invitationRelay: RelayUrls | undefined,
  build: () => DefaultRelayBuild = defaultRelayBuild,
  switchedOn: () => boolean = readDefaultRelaySwitch,
): DefaultRelayForRun {
  const offer = build();
  if (offer.kind === "none") return { kind: "none" };
  const inUse = defaultRelayInUse(() => offer, switchedOn);
  if (inUse !== undefined) return { kind: "in-use", relay: inUse };
  return {
    kind: namesDefaultRelay(invitationRelay, offer.relay) ? "invited" : "off",
    relay: offer.relay,
  };
}

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
  /** The default relay in use; {@link defaultRelayInUse} when unset. */
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
 * The relay an invitation names: `ownRelay`, followed by the TURN url of
 * `defaultRelay`, the one in use ({@link defaultRelayInUse}), when it is set
 * and `allowedRelays` keeps it, once, and only where the locator has room for
 * it under {@link MAX_RELAY_LOCATOR_URLS}. Where the result names that url, it
 * also names the default relay's registrar, where a command-line party enrolls
 * without a token. Where `ownRelay` names no WebSocket relay, the result names
 * the default relay's when it names one and `allowedRelays` keeps it. A new
 * invitation and a managed re-invite both name it this way; with none in use,
 * the result is `ownRelay`.
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
  if (!turnUrlIsAllowed(defaultRelay.turnUrl, allowedRelays)) return relay;
  const turn = relay?.turn ?? [];
  if (turn.includes(defaultRelay.turnUrl))
    return { ...relay, registrar: defaultRelay.registrarUrl };
  if (turn.length >= MAX_RELAY_LOCATOR_URLS) return relay;
  return {
    ...relay,
    turn: [...turn, defaultRelay.turnUrl],
    registrar: defaultRelay.registrarUrl,
  };
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
  relay?: RunRelay;
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
 * A default relay whose TURN url `allowedRelays` leaves out is not enrolled
 * at, and neither of its urls is listed, even where `allowedRelays` keeps its
 * WebSocket relay url (docs/spec/PROTOCOL.md, "Enrolling at a default
 * relay"). That url is listed only where `allowedRelays` keeps it too; unset
 * keeps both.
 */
export async function relayWithDefaultForRun(
  sharedSecret: string,
  relay: RunRelay | undefined,
  allowedRelays: ReadonlyArray<string> | undefined,
  dependencies: DefaultRelayDependencies = {},
): Promise<RelayWithDefault> {
  const unchanged = relay !== undefined ? { relay } : {};
  const setting = (dependencies.setting ?? defaultRelayInUse)();
  if (setting === undefined) return unchanged;
  if (!turnUrlIsAllowed(setting.turnUrl, allowedRelays)) return unchanged;
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
  const others = (relay?.turn ?? []).filter((url) => url !== setting.turnUrl);
  const turn = enrolled ? [...others, setting.turnUrl] : others;
  const stun = [...(relay?.stun ?? [])];
  const websocketUrl = setting.websocketUrl;
  return {
    ...(turn.length + stun.length > 0 && {
      relay: {
        turn,
        stun,
        ...(relay?.stunReplacesDefault === true && {
          stunReplacesDefault: true as const,
        }),
      },
    }),
    ...(enrolled &&
      websocketUrl !== undefined &&
      webSocketRelayUrlIsAllowed(websocketUrl, allowedRelays) && {
        defaultWebSocketRelay: websocketUrl,
      }),
  };
}
