import { deriveRelayExchangeId, turnUrlIsAllowed } from "@alcove/core";

import { defaultRelaySetting } from "@utils/clientConfig";

import {
  readOwnRelaySetting,
  relayForRun,
  webSocketRelaysForRun,
} from "./ownRelaySetting";
import { allowedRelaysRunNotice } from "./relayRestriction";
import { relayWithDefaultForRun } from "./defaultRelay";

import type { OwnRelayRead, RelayUrls } from "./ownRelaySetting";
import type { DefaultRelayDependencies } from "./defaultRelay";
import type { DefaultRelaySetting } from "@utils/clientConfig";
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
}

/** What {@link relayPlanForRun} reads: injectable for tests. */
export interface RunRelayPlanDependencies extends DefaultRelayDependencies {
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
 * The relay a browser run dials with. Every TURN url it would list, this
 * browser's own, the invitation's and the build's default relay's, is kept or
 * left out by `allowedRelays` (`turnUrlIsAllowed` in core; unset keeps every
 * url). Where it is set, the urls kept and left out are shown through
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
    ...defaultRelay
  } = dependencies;
  const own = readOwn();
  const site = (defaultRelay.setting ?? defaultRelaySetting)();
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
    defaultRelay,
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
  };
}

// The WebSocket relays a run lists, the default relay's url left out unless
// the run's enrollment there confirmed, even where another source names it,
// as the default relay's TURN url is.
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
