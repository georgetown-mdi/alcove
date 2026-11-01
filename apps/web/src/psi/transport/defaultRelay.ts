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
 * each of the two urls only where the invitation it accepted, or this
 * browser's own relay setting, names that url, and enrolls only where one of
 * them names the TURN url.
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
import type { RelayLocator } from "./rendezvous";
import type { RelayUrls } from "./ownRelaySetting";

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

// The part of `defaultRelay` that `relay`, an invitation's or this browser's
// own, names, service by service: none where it does not name the TURN url,
// since the TURN url is what a run enrolls for, and the WebSocket relay url
// only where it names that url too.
function defaultRelayNamedBy(
  relay: RelayUrls | undefined,
  defaultRelay: DefaultRelaySetting,
): DefaultRelaySetting | undefined {
  if (!(relay?.turn ?? []).includes(defaultRelay.turnUrl)) return undefined;
  const { websocketUrl, ...turnAndRegistrar } = defaultRelay;
  return websocketUrl !== undefined && relay?.websocket === websocketUrl
    ? defaultRelay
    : turnAndRegistrar;
}

/**
 * The default relay a run uses. `in-use`: {@link defaultRelayInUse} names
 * it. `invited`: the build offers it switched off, this browser has not
 * turned it on, and the invitation the run accepted names its TURN url, so
 * the run uses that url as one in use; `relay` names the WebSocket relay url
 * only where the invitation names that url too. `own`: as `invited`, but
 * where the invitation does not name its TURN url and this browser's own
 * relay setting does; `relay` names the WebSocket relay url only where that
 * setting names that url too. `off`: the build offers it switched off
 * and the run does not use its TURN url, including where the invitation or
 * the own setting names only its WebSocket relay url, which the run lists as
 * it lists any other WebSocket relay; `relay` is the one left out. `none`:
 * the build names none.
 */
export type DefaultRelayForRun =
  | { kind: "in-use" | "invited" | "own" | "off"; relay: DefaultRelaySetting }
  | { kind: "none" };

/** The {@link DefaultRelayForRun} of a run whose accepted invitation names
 * `invitationRelay`, which an inviter's own run passes as `undefined`, and
 * whose browser's own relay setting is `ownRelay`. */
export function defaultRelayForRun(
  invitationRelay: RelayUrls | undefined,
  build: () => DefaultRelayBuild = defaultRelayBuild,
  switchedOn: () => boolean = readDefaultRelaySwitch,
  ownRelay?: RelayUrls,
): DefaultRelayForRun {
  const offer = build();
  if (offer.kind === "none") return { kind: "none" };
  const inUse = defaultRelayInUse(() => offer, switchedOn);
  if (inUse !== undefined) return { kind: "in-use", relay: inUse };
  const invited = defaultRelayNamedBy(invitationRelay, offer.relay);
  if (invited !== undefined) return { kind: "invited", relay: invited };
  const own = defaultRelayNamedBy(ownRelay, offer.relay);
  return own !== undefined
    ? { kind: "own", relay: own }
    : { kind: "off", relay: offer.relay };
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
   * fails, and {@link DEFAULT_RELAY_PREVIOUS_NOT_ENROLLED_NOTICE} when the
   * enrollment under `previousSharedSecret` does. */
  onRunNotice?: (message: string) => void;
  /** A managed acceptor's previous secret, which the run also waits for its
   * partner under: the key and exchange id it derives are enrolled too, at
   * the same time. */
  previousSharedSecret?: string;
}

/**
 * The relay an invitation names: `ownRelay`, followed by the TURN url of
 * `defaultRelay`, the one in use ({@link defaultRelayInUse}), when it is set
 * and `allowedRelays` keeps it, once, and only where the locator has room for
 * it under {@link MAX_RELAY_LOCATOR_URLS}. Where `ownRelay` names no WebSocket
 * relay, the result names the default relay's when it names one and
 * `allowedRelays` keeps it. Where the result names either default url, it
 * also names the default relay's registrar, where a command-line party enrolls
 * without a token. A new invitation and a managed re-invite both name it this
 * way; with none in use, the result is `ownRelay`.
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
  const registrar = { registrar: defaultRelay.registrarUrl };
  const withoutTurn =
    defaultRelay.websocketUrl !== undefined &&
    relay?.websocket === defaultRelay.websocketUrl
      ? { ...relay, ...registrar }
      : relay;
  if (!turnUrlIsAllowed(defaultRelay.turnUrl, allowedRelays))
    return withoutTurn;
  const turn = relay?.turn ?? [];
  if (turn.includes(defaultRelay.turnUrl)) return { ...relay, ...registrar };
  if (turn.length >= MAX_RELAY_LOCATOR_URLS) return withoutTurn;
  return { ...relay, turn: [...turn, defaultRelay.turnUrl], ...registrar };
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

/**
 * The run notice a run shows when its enrollment at the default relay under
 * its previous secret fails, while the one under its current secret may not.
 */
export const DEFAULT_RELAY_PREVIOUS_NOT_ENROLLED_NOTICE =
  "The site's relay server could not be set up for the secret from before " +
  "the run that stopped partway. This run looks for your partner there " +
  "under the current secret only.";

/** What {@link relayWithDefaultForRun} lists once the default relay is added. */
export interface RelayWithDefault {
  /** The relay the run's peer connection gathers against; none when absent. */
  relay?: RelayLocator;
  /** The default relay's WebSocket relay url, where the build names one, the
   * allowed relays keep it and the run's enrollment there confirmed. */
  defaultWebSocketRelay?: string;
  /** The same url, where the run's enrollment there under its previous
   * secret confirmed. */
  defaultWebSocketRelayUnderPrevious?: string;
}

/**
 * The relay a browser run dials with: `relay`, this browser's own and the
 * invitation's (`relayForRun`), then the build's default relay once one
 * attempt to enroll the run's key at its registrar confirms, within
 * {@link DEFAULT_RELAY_DIAL_WAIT_MS}: its TURN url, and its WebSocket relay
 * url as `defaultWebSocketRelay`, each where the run uses it and
 * `allowedRelays` keeps it. A same-key repeat confirms. Otherwise the
 * default relay's TURN url is left out, even where the invitation names it,
 * and the run dials with the rest. A refused, unreachable or unanswered
 * enrollment shows {@link DEFAULT_RELAY_NOT_ENROLLED_NOTICE} through
 * `onRunNotice`, once, before this returns; a cancelled one shows nothing.
 * A default relay neither of whose urls the run uses and `allowedRelays`
 * keeps is not enrolled at (docs/spec/PROTOCOL.md, "Enrolling at a default
 * relay"); unset keeps both.
 *
 * With `previousSharedSecret`, that secret's key and exchange id are enrolled
 * in a second request sent at the same time, and its failure shows
 * {@link DEFAULT_RELAY_PREVIOUS_NOT_ENROLLED_NOTICE}. Its confirmation lists
 * the WebSocket relay url under that secret; the TURN url is listed by the
 * current secret's enrollment alone, since the run's relay credential is
 * minted from that secret.
 */
export async function relayWithDefaultForRun(
  sharedSecret: string,
  relay: RelayLocator | undefined,
  allowedRelays: ReadonlyArray<string> | undefined,
  dependencies: DefaultRelayDependencies = {},
): Promise<RelayWithDefault> {
  const unchanged = relay !== undefined ? { relay } : {};
  const setting = (dependencies.setting ?? defaultRelayInUse)();
  if (setting === undefined) return unchanged;
  const { turnUrl, websocketUrl } = setting;
  const turnKept = turnUrlIsAllowed(turnUrl, allowedRelays);
  const websocketKept =
    websocketUrl !== undefined &&
    webSocketRelayUrlIsAllowed(websocketUrl, allowedRelays);
  if (!turnKept && !websocketKept) return unchanged;
  const enroll = dependencies.enroll ?? enrollRelayKeyWithinWait;
  const enrollUnder = (secret: string) =>
    enroll(
      { registrarUrl: setting.registrarUrl, sharedSecret: secret },
      {
        waitMs: dependencies.dialWaitMs ?? DEFAULT_RELAY_DIAL_WAIT_MS,
        ...(dependencies.signal !== undefined && {
          signal: dependencies.signal,
        }),
      },
    );
  const previousSecret = dependencies.previousSharedSecret;
  const [enrollment, previousEnrollment] = await Promise.all([
    enrollUnder(sharedSecret),
    previousSecret === undefined ? undefined : enrollUnder(previousSecret),
  ]);
  if (enrollment.kind === "failed") {
    log.warn(
      `the default relay's registrar did not enroll this exchange ` +
        `(${enrollment.detail}), so this run connects without it`,
    );
    dependencies.onRunNotice?.(DEFAULT_RELAY_NOT_ENROLLED_NOTICE);
  }
  if (previousEnrollment?.kind === "failed") {
    log.warn(
      `the default relay's registrar did not enroll this exchange under ` +
        `the previous secret (${previousEnrollment.detail})`,
    );
    dependencies.onRunNotice?.(DEFAULT_RELAY_PREVIOUS_NOT_ENROLLED_NOTICE);
  }
  const enrolled = enrollment.kind === "enrolled";
  const others = (relay?.turn ?? []).filter((url) => url !== turnUrl);
  const turn = enrolled && turnKept ? [...others, turnUrl] : others;
  const stun = [...(relay?.stun ?? [])];
  return {
    ...(turn.length + stun.length > 0 && { relay: { turn, stun } }),
    ...(enrolled &&
      websocketKept && {
        defaultWebSocketRelay: websocketUrl,
      }),
    ...(previousEnrollment?.kind === "enrolled" &&
      websocketKept && {
        defaultWebSocketRelayUnderPrevious: websocketUrl,
      }),
  };
}
