import { deriveRelayExchangeId, turnUrlIsAllowed } from "@alcove/core";

import { defaultRelayForRun, relayWithDefaultForRun } from "./defaultRelay";
import {
  readOwnRelaySetting,
  relayForRun,
  webSocketRelaysForRun,
} from "./ownRelaySetting";
import { allowedRelaysRunNotice } from "./relayRestriction";

import type {
  DefaultRelayBuild,
  DefaultRelaySetting,
} from "@utils/clientConfig";
import type { OwnRelayRead, RelayUrls } from "./ownRelaySetting";
import type { DefaultRelayDependencies } from "./defaultRelay";
import type { RunRelay } from "./rendezvous";

/** One WebSocket relay a browser run lists, and the exchange id its proof to
 * that relay is made under. */
export interface WebSocketRelayForRun {
  /** The relay's `wss://` url. */
  url: string;
  /** The id the relay holds the exchange's relay key under. */
  exchangeId: string;
}

/** The relay a browser run dials with. */
export interface RunRelayPlan {
  /** The relay its peer connection gathers against; none when absent. */
  relay?: RunRelay;
  /** The TURN urls the allowed relays left out, named by a failed open. */
  relaysLeftOut: ReadonlyArray<string>;
  /**
   * The WebSocket relays it lists: this browser's own, then the
   * invitation's, then the build's default relay's once the run's
   * enrollment there confirmed, each once, less every one the allowed
   * relays leave out.
   */
  websocketRelays: ReadonlyArray<WebSocketRelayForRun>;
  /** Present where the build offers its default relay switched off, the run
   * does not list it, and `allowedRelays` keep its TURN url, so a failed open
   * points at the switch. */
  defaultRelayOff?: true;
}

/** What {@link relayPlanForRun} reads: injectable for tests. */
export interface RunRelayPlanDependencies extends DefaultRelayDependencies {
  /** The build's default relay and its mode, read where `setting` is unset;
   * the build's own when unset. */
  build?: () => DefaultRelayBuild;
  /** This browser's default relay switch, read where `setting` is unset; the
   * stored one when unset. */
  switchedOn?: () => boolean;
  /** This browser's own relay; the stored setting when unset. */
  readOwn?: () => OwnRelayRead;
  /**
   * The exchange id this browser's own WebSocket relay holds the exchange's
   * relay key under: a saved exchange's registrar's (`relayRegistrar`). The
   * id derived from the shared secret when unset.
   */
  ownRelayExchangeId?: string;
}

/**
 * The relay a browser run dials with. Its default relay is the one
 * `defaultRelayForRun` names: the one in use, or, where the build offers it
 * switched off, the build's only where `invitationRelay` or this browser's
 * own relay names its TURN url, with its WebSocket relay url only where that
 * same relay names it too; `setting` replaces that choice. Every TURN url it
 * would list, this browser's own, the invitation's and that default relay's,
 * is kept or left out by `allowedRelays` (`turnUrlIsAllowed` in core; unset
 * keeps every url).
 * Where it is set, the urls kept and left out are shown through
 * `onRunNotice`. The default relay is then enrolled at and added as
 * {@link relayWithDefaultForRun} does, if it is kept. Each WebSocket relay it
 * lists names the exchange id its proof is made under, decided by the url:
 * the invitation's url takes the invitation's `websocketExchangeId`, this
 * browser's own url `ownRelayExchangeId`, and any other, or one with none
 * named, the id derived from the secret, the one the default relay's
 * enrollment uses.
 */
export async function relayPlanForRun(
  sharedSecret: string,
  invitationRelay: RelayUrls | undefined,
  allowedRelays: ReadonlyArray<string> | undefined,
  dependencies: RunRelayPlanDependencies = {},
): Promise<RunRelayPlan> {
  const {
    readOwn = readOwnRelaySetting,
    ownRelayExchangeId,
    build,
    switchedOn,
    ...defaultRelay
  } = dependencies;
  const own = readOwn();
  const forRun =
    defaultRelay.setting === undefined
      ? defaultRelayForRun(
          invitationRelay,
          build,
          switchedOn,
          own.kind === "set" ? own.relay : undefined,
        )
      : undefined;
  const site =
    forRun === undefined
      ? defaultRelay.setting?.()
      : forRun.kind === "in-use" ||
          forRun.kind === "invited" ||
          forRun.kind === "own"
        ? forRun.relay
        : undefined;
  const listed = [
    ...new Set([
      ...(own.kind === "set" ? own.relay.turn : []),
      ...(invitationRelay?.turn ?? []),
      ...(site !== undefined ? [site.turnUrl] : []),
    ]),
  ];
  const kept = listed.filter((url) => turnUrlIsAllowed(url, allowedRelays));
  const relaysLeftOut = listed.filter(
    (url) => !turnUrlIsAllowed(url, allowedRelays),
  );
  if (allowedRelays !== undefined && listed.length > 0)
    defaultRelay.onRunNotice?.(allowedRelaysRunNotice(kept, relaysLeftOut));
  const { relay, defaultWebSocketRelay } = await relayWithDefaultForRun(
    sharedSecret,
    relayForRun(invitationRelay, allowedRelays, () => own),
    allowedRelays,
    { ...defaultRelay, setting: () => site },
  );
  const websocketRelays = await webSocketRelaysWithExchangeIds(sharedSecret, {
    invitationRelay,
    allowedRelays,
    own,
    ownRelayExchangeId,
    site,
    defaultWebSocketRelay,
  });
  return {
    ...(relay !== undefined && { relay }),
    relaysLeftOut,
    websocketRelays,
    ...(forRun?.kind === "off" &&
      turnUrlIsAllowed(forRun.relay.turnUrl, allowedRelays) && {
        defaultRelayOff: true as const,
      }),
  };
}

// The WebSocket relays a run lists. Where the run uses the default relay's
// WebSocket relay url, that url is left out unless the run's enrollment there
// confirmed, even where another source names it, as its TURN url is.
async function webSocketRelaysWithExchangeIds(
  sharedSecret: string,
  sources: {
    invitationRelay: RelayUrls | undefined;
    allowedRelays: ReadonlyArray<string> | undefined;
    own: OwnRelayRead;
    ownRelayExchangeId: string | undefined;
    site: DefaultRelaySetting | undefined;
    defaultWebSocketRelay: string | undefined;
  },
): Promise<Array<WebSocketRelayForRun>> {
  const { invitationRelay, own, site, defaultWebSocketRelay } = sources;
  const urls = [
    ...new Set([
      ...webSocketRelaysForRun(
        invitationRelay,
        sources.allowedRelays,
        () => own,
      ),
      ...(defaultWebSocketRelay !== undefined ? [defaultWebSocketRelay] : []),
    ]),
  ].filter(
    (url) => url !== site?.websocketUrl || defaultWebSocketRelay !== undefined,
  );
  if (urls.length === 0) return [];
  const derived = await deriveRelayExchangeId(sharedSecret);
  const ownUrl = own.kind === "set" ? own.relay.websocket : undefined;
  return urls.map((url) => ({
    url,
    exchangeId:
      url === invitationRelay?.websocket
        ? (invitationRelay.websocketExchangeId ?? derived)
        : url === ownUrl
          ? (sources.ownRelayExchangeId ?? derived)
          : derived,
  }));
}
