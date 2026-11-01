import {
  deriveRelayExchangeId,
  turnUrlIsAllowed,
  webSocketRelayUrlIsAllowed,
} from "@alcove/core";

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
import type {
  DefaultRelayDependencies,
  DefaultRelayForRun,
} from "./defaultRelay";
import type { OwnRelayRead, RelayUrls } from "./ownRelaySetting";
import type { RelayLocator } from "./rendezvous";

/** One WebSocket relay a browser run lists, and the exchange id its proof to
 * that relay is made under. */
export interface WebSocketRelayForRun {
  /** The relay's `wss://` url. */
  url: string;
  /** The id the relay holds the exchange's relay key under. */
  exchangeId: string;
  /** The id and the proof's key are derived from the run's previous secret
   * rather than its current one. */
  underPreviousSecret?: true;
}

/** The relay a browser run dials with. */
export interface RunRelayPlan {
  /** The relay its peer connection gathers against; none when absent. */
  relay?: RelayLocator;
  /** The TURN urls and then the WebSocket relay urls the allowed relays left
   * out, named by a failed open. */
  relaysLeftOut: ReadonlyArray<string>;
  /**
   * The WebSocket relays it lists: this browser's own, then the
   * invitation's, then the build's default relay's once the run's
   * enrollment there confirmed, each once, less every one the allowed
   * relays leave out.
   */
  websocketRelays: ReadonlyArray<WebSocketRelayForRun>;
  /** Present where the build offers its default relay switched off, the run
   * does not list it, and `allowedRelays` keep its TURN url or its WebSocket
   * relay url, so a failed open points at the switch. */
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
 * same relay names it too; `setting` replaces that choice. Every TURN and
 * WebSocket relay url it would list, this browser's own, the invitation's and
 * that default relay's, is kept or left out by `allowedRelays`
 * (`turnUrlIsAllowed` and `webSocketRelayUrlIsAllowed` in core; unset keeps
 * every url). Where it is set, the urls kept and left out are shown through
 * `onRunNotice`. The default relay is then enrolled at and added as
 * {@link relayWithDefaultForRun} does, if it is kept. Each WebSocket relay it
 * lists names the exchange id its proof is made under, decided by the url:
 * the invitation's url takes the invitation's `websocketExchangeId`, this
 * browser's own url `ownRelayExchangeId`, and any other, or one with none
 * named, the id derived from the secret, the one the default relay's
 * enrollment uses.
 *
 * With `previousSharedSecret`, each WebSocket relay listed under the derived
 * id is listed again under the id that secret derives
 * (`underPreviousSecret`), the default relay's only where its enrollment
 * under that secret confirmed. A relay under an id the invitation or the
 * registrar names is listed once, under the current secret.
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
  const { forRun, site } = defaultRelayListed(
    invitationRelay,
    own,
    dependencies,
  );
  const { turn: listed, websocket: listedWebSocket } = relayUrlsListed(
    own,
    invitationRelay,
    site,
  );
  const kept = [
    ...listed.filter((url) => turnUrlIsAllowed(url, allowedRelays)),
    ...listedWebSocket.filter((url) =>
      webSocketRelayUrlIsAllowed(url, allowedRelays),
    ),
  ];
  const relaysLeftOut = [
    ...listed.filter((url) => !turnUrlIsAllowed(url, allowedRelays)),
    ...listedWebSocket.filter(
      (url) => !webSocketRelayUrlIsAllowed(url, allowedRelays),
    ),
  ];
  if (allowedRelays !== undefined && kept.length + relaysLeftOut.length > 0)
    defaultRelay.onRunNotice?.(allowedRelaysRunNotice(kept, relaysLeftOut));
  const { relay, defaultWebSocketRelay, defaultWebSocketRelayUnderPrevious } =
    await relayWithDefaultForRun(
      sharedSecret,
      relayForRun(invitationRelay, allowedRelays, () => own),
      allowedRelays,
      { ...defaultRelay, setting: () => site },
    );
  const sources = {
    invitationRelay,
    allowedRelays,
    own,
    ownRelayExchangeId,
    site,
  };
  const websocketRelays = [
    ...(await webSocketRelaysWithExchangeIds(sharedSecret, {
      ...sources,
      defaultWebSocketRelay,
    })),
    ...(defaultRelay.previousSharedSecret === undefined
      ? []
      : await webSocketRelaysUnderPreviousSecret(
          defaultRelay.previousSharedSecret,
          {
            ...sources,
            defaultWebSocketRelay: defaultWebSocketRelayUnderPrevious,
          },
        )),
  ];
  return {
    ...(relay !== undefined && { relay }),
    relaysLeftOut,
    websocketRelays,
    ...(forRun?.kind === "off" &&
      (turnUrlIsAllowed(forRun.relay.turnUrl, allowedRelays) ||
        (forRun.relay.websocketUrl !== undefined &&
          webSocketRelayUrlIsAllowed(
            forRun.relay.websocketUrl,
            allowedRelays,
          ))) && {
        defaultRelayOff: true as const,
      }),
  };
}

/**
 * Whether a browser run whose accepted invitation names `invitationRelay`,
 * which an inviter's own run passes as `undefined`, lists any TURN or
 * WebSocket relay url for its allowed relays to keep or leave out: this
 * browser's own, the invitation's, or the default relay's where the run uses
 * it, the urls {@link relayPlanForRun} lists before the allowed relays apply.
 */
export function runListsRelay(
  invitationRelay: RelayUrls | undefined,
  dependencies: Pick<
    RunRelayPlanDependencies,
    "build" | "switchedOn" | "readOwn" | "setting"
  > = {},
): boolean {
  const own = (dependencies.readOwn ?? readOwnRelaySetting)();
  const { site } = defaultRelayListed(invitationRelay, own, dependencies);
  const { turn, websocket } = relayUrlsListed(own, invitationRelay, site);
  return turn.length + websocket.length > 0;
}

// The default relay a run lists, `site`: the one `defaultRelayForRun` finds
// in use, invited, or named by this browser's own relay, or `setting`'s where
// it is given, which replaces that choice and leaves `forRun` absent.
function defaultRelayListed(
  invitationRelay: RelayUrls | undefined,
  own: OwnRelayRead,
  dependencies: Pick<
    RunRelayPlanDependencies,
    "build" | "switchedOn" | "setting"
  >,
): { forRun?: DefaultRelayForRun; site?: DefaultRelaySetting } {
  if (dependencies.setting !== undefined) {
    const site = dependencies.setting();
    return site !== undefined ? { site } : {};
  }
  const forRun = defaultRelayForRun(
    invitationRelay,
    dependencies.build,
    dependencies.switchedOn,
    own.kind === "set" ? own.relay : undefined,
  );
  return forRun.kind === "in-use" ||
    forRun.kind === "invited" ||
    forRun.kind === "own"
    ? { forRun, site: forRun.relay }
    : { forRun };
}

// The TURN and the WebSocket relay urls a run lists before its allowed relays
// apply: this browser's own, then the invitation's, then `site`'s, each once.
function relayUrlsListed(
  own: OwnRelayRead,
  invitationRelay: RelayUrls | undefined,
  site: DefaultRelaySetting | undefined,
): { turn: Array<string>; websocket: Array<string> } {
  return {
    turn: [
      ...new Set([
        ...(own.kind === "set" ? own.relay.turn : []),
        ...(invitationRelay?.turn ?? []),
        ...(site !== undefined ? [site.turnUrl] : []),
      ]),
    ],
    websocket: [
      ...new Set([
        ...(own.kind === "set" && own.relay.websocket !== undefined
          ? [own.relay.websocket]
          : []),
        ...(invitationRelay?.websocket !== undefined
          ? [invitationRelay.websocket]
          : []),
        ...(site?.websocketUrl !== undefined ? [site.websocketUrl] : []),
      ]),
    ],
  };
}

/** Where a run's WebSocket relay urls and their exchange ids come from. */
interface WebSocketRelaySources {
  invitationRelay: RelayUrls | undefined;
  allowedRelays: ReadonlyArray<string> | undefined;
  own: OwnRelayRead;
  ownRelayExchangeId: string | undefined;
  site: DefaultRelaySetting | undefined;
  /** The default relay's WebSocket relay url, where the enrollment for the
   * secret being listed confirmed. */
  defaultWebSocketRelay: string | undefined;
}

// The WebSocket relay urls a run lists. Where the run uses the default relay's
// WebSocket relay url, that url is left out unless the run's enrollment there
// confirmed, even where another source names it, as its TURN url is.
function webSocketRelayUrls(sources: WebSocketRelaySources): Array<string> {
  const { invitationRelay, own, site, defaultWebSocketRelay } = sources;
  return [
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
}

// The exchange id the invitation or this browser's registrar names for `url`,
// or `undefined` where the proof is made under the id the secret derives.
function namedExchangeId(
  url: string,
  sources: WebSocketRelaySources,
): string | undefined {
  const { invitationRelay, own } = sources;
  if (url === invitationRelay?.websocket)
    return invitationRelay.websocketExchangeId;
  const ownUrl = own.kind === "set" ? own.relay.websocket : undefined;
  return url === ownUrl ? sources.ownRelayExchangeId : undefined;
}

// The WebSocket relays a run lists under its current secret.
async function webSocketRelaysWithExchangeIds(
  sharedSecret: string,
  sources: WebSocketRelaySources,
): Promise<Array<WebSocketRelayForRun>> {
  const urls = webSocketRelayUrls(sources);
  if (urls.length === 0) return [];
  const derived = await deriveRelayExchangeId(sharedSecret);
  return urls.map((url) => ({
    url,
    exchangeId: namedExchangeId(url, sources) ?? derived,
  }));
}

// The WebSocket relays a run also lists under its previous secret: those it
// dials under the derived id.
async function webSocketRelaysUnderPreviousSecret(
  previousSharedSecret: string,
  sources: WebSocketRelaySources,
): Promise<Array<WebSocketRelayForRun>> {
  const urls = webSocketRelayUrls(sources).filter(
    (url) => namedExchangeId(url, sources) === undefined,
  );
  if (urls.length === 0) return [];
  const derived = await deriveRelayExchangeId(previousSharedSecret);
  return urls.map((url) => ({
    url,
    exchangeId: derived,
    underPreviousSecret: true as const,
  }));
}
