/**
 * An exchange's own relay: the TURN and STUN urls and the WebSocket relay url
 * a party sets for their side of a WebRTC exchange, in that exchange's
 * Connection settings. The urls follow core's `connection.turn` /
 * `connection.stun` / `connection.websocket_relay` grammar. No credential is
 * kept: each run mints its own from the exchange's shared secret
 * (`buildIceServers` in `./rendezvous.ts`).
 */

import { z } from "zod";

import {
  StunUrlSchema,
  TurnUrlSchema,
  maxCodeUnits,
  turnUrlIsAllowed,
  webSocketRelayUrlIsAllowed,
  webSocketRelayUrlSchema,
} from "@alcove/core";

import type { RelayLocator } from "./rendezvous";

/** How many urls each list holds at most. */
export const MAX_RELAY_URLS = 8;

/** How long one url may be, in UTF-16 code units. */
export const MAX_RELAY_URL_LENGTH = 1024;

const TurnListSchema = z
  .array(TurnUrlSchema.check(maxCodeUnits(MAX_RELAY_URL_LENGTH)))
  .max(MAX_RELAY_URLS);
const StunListSchema = z
  .array(StunUrlSchema.check(maxCodeUnits(MAX_RELAY_URL_LENGTH)))
  .max(MAX_RELAY_URLS);

const WebSocketUrlSchema = webSocketRelayUrlSchema("the WebSocket relay url");

const ownRelayFields = {
  turn: TurnListSchema,
  stun: StunListSchema,
  websocket: WebSocketUrlSchema.optional(),
};

function namesAUrl(value: {
  turn: ReadonlyArray<string>;
  stun: ReadonlyArray<string>;
  websocket?: string;
}): boolean {
  return (
    value.turn.length + value.stun.length > 0 || value.websocket !== undefined
  );
}

/** A relay of one's own: its TURN and STUN urls and its WebSocket relay. */
export interface OwnRelay extends RelayLocator {
  /** The `wss://` url of a WebSocket relay; absent when none is set. */
  websocket?: string;
}

/**
 * The validator of an {@link OwnRelay} an exchange keeps: the url grammar
 * and list bounds of its Connection settings, and at least one url.
 */
export const OwnRelaySchema: z.ZodType<OwnRelay> = z
  .strictObject(ownRelayFields)
  .refine(namesAUrl, { message: "a relay names no url" });

/** An exchange's own relay as a run reads it. */
export type OwnRelayRead = { kind: "none" } | { kind: "set"; relay: OwnRelay };

/** No relay of the exchange's own. */
export const NO_OWN_RELAY: OwnRelayRead = { kind: "none" };

/** `relay` as a run reads it: none where it is absent. */
export function ownRelayRead(relay: OwnRelay | undefined): OwnRelayRead {
  return relay !== undefined ? { kind: "set", relay } : NO_OWN_RELAY;
}

/** What {@link parseWebSocketRelayUrl} made of the entered text. */
export type WebSocketRelayUrlEntry =
  /** `url` absent where the text is blank: no WebSocket relay. */
  { ok: true; url?: string } | { ok: false; message: string };

/**
 * Read the WebSocket relay url from `text` under core's
 * `connection.websocket_relay` grammar, with core's own message for a
 * refusal. Blank text names none.
 */
export function parseWebSocketRelayUrl(text: string): WebSocketRelayUrlEntry {
  if (text.trim() === "") return { ok: true };
  const result = WebSocketUrlSchema.safeParse(text);
  return result.success
    ? { ok: true, url: result.data }
    : {
        ok: false,
        message: result.error.issues[0]?.message ?? "not a valid url",
      };
}

/** A refusal of the entered text: why, and the 1-based line it is about when
 * it is about one line. */
export interface RelayUrlProblem {
  line?: number;
  message: string;
}

/** What {@link parseRelayUrlLines} made of one list's text. */
export type RelayUrlLines =
  | { ok: true; urls: Array<string> }
  | { ok: false; problems: Array<RelayUrlProblem> };

/**
 * Read one url per line from `text` under the `turn` or `stun` grammar,
 * skipping blank lines. Every refused line is reported, with core's own
 * message for it.
 */
export function parseRelayUrlLines(
  text: string,
  kind: "turn" | "stun",
): RelayUrlLines {
  const schema = (kind === "turn" ? TurnUrlSchema : StunUrlSchema).check(
    maxCodeUnits(MAX_RELAY_URL_LENGTH),
  );
  const urls: Array<string> = [];
  const problems: Array<RelayUrlProblem> = [];
  text.split(/\r?\n/).forEach((entry, index) => {
    if (entry.trim() === "") return;
    const result = schema.safeParse(entry);
    if (result.success) urls.push(result.data);
    else
      problems.push({
        line: index + 1,
        message: result.error.issues[0]?.message ?? "not a valid url",
      });
  });
  if (problems.length > 0) return { ok: false, problems };
  if (urls.length > MAX_RELAY_URLS)
    return {
      ok: false,
      problems: [{ message: `enter at most ${MAX_RELAY_URLS} urls` }],
    };
  return { ok: true, urls };
}

/**
 * A relay's TURN and STUN urls with each list optional, its WebSocket relay
 * url with the exchange id that relay holds the key under, and the registrar
 * a command-line party enrolls at: the shape of core's `RelayLocator`, which
 * an invitation endpoint and a stored connection's `invitationRelay` hold, and
 * of the relay an inviter names.
 */
export interface RelayUrls {
  turn?: ReadonlyArray<string>;
  stun?: ReadonlyArray<string>;
  websocket?: string;
  /** Present only beside {@link websocket}. */
  websocketExchangeId?: string;
  registrar?: string;
}

/**
 * The relay a run's peer connection gathers against: every relay it may use,
 * the exchange's own and the invitation's. Its TURN urls are the exchange's
 * own followed by the invitation's, each listed once, less every one
 * `allowedRelays` leaves out, and its STUN urls likewise, none left out;
 * any STUN url listed replaces the default STUN server
 * (`buildIceServers`). With neither it is none. The command line lists the
 * urls the same way (`selectRunRelay` in core).
 */
export function relayForRun(
  invitationRelay: RelayUrls | undefined,
  allowedRelays: ReadonlyArray<string> | undefined,
  readOwn: () => OwnRelayRead = () => NO_OWN_RELAY,
): RelayLocator | undefined {
  const own = readOwn();
  const turn = orderedRelayUrls(own, invitationRelay).turn.filter((url) =>
    turnUrlIsAllowed(url, allowedRelays),
  );
  const stun = [
    ...new Set([
      ...(own.kind === "set" ? own.relay.stun : []),
      ...(invitationRelay?.stun ?? []),
    ]),
  ];
  if (turn.length + stun.length === 0) return undefined;
  return { turn, stun };
}

/**
 * The exchange's own WebSocket relay url followed by the invitation's, each
 * listed once, less every one `allowedRelays` leaves out.
 */
export function webSocketRelaysForRun(
  invitationRelay: RelayUrls | undefined,
  allowedRelays: ReadonlyArray<string> | undefined,
  readOwn: () => OwnRelayRead = () => NO_OWN_RELAY,
): Array<string> {
  return orderedRelayUrls(readOwn(), invitationRelay).websocket.filter((url) =>
    webSocketRelayUrlIsAllowed(url, allowedRelays),
  );
}

/** A default relay's urls, as {@link orderedRelayUrls} lists them last. */
export interface DefaultRelayUrls {
  turnUrl: string;
  websocketUrl?: string;
}

/**
 * The TURN and the WebSocket relay urls a run lists before its allowed
 * relays apply: the exchange's own, then the invitation's, then
 * `defaultRelay`'s, each listed once. Every caller filters each list by the
 * allowed relays itself.
 */
export function orderedRelayUrls(
  own: OwnRelayRead,
  invitationRelay: RelayUrls | undefined,
  defaultRelay?: DefaultRelayUrls,
): { turn: Array<string>; websocket: Array<string> } {
  const ownRelay = own.kind === "set" ? own.relay : undefined;
  return {
    turn: [
      ...new Set([
        ...(ownRelay?.turn ?? []),
        ...(invitationRelay?.turn ?? []),
        ...(defaultRelay !== undefined ? [defaultRelay.turnUrl] : []),
      ]),
    ],
    websocket: [
      ...new Set(
        [
          ownRelay?.websocket,
          invitationRelay?.websocket,
          defaultRelay?.websocketUrl,
        ].filter((url) => url !== undefined),
      ),
    ],
  };
}

/**
 * The relay an invitation names of the exchange's own: the TURN and STUN
 * urls {@link relayForRun} lists with no invitation, and the exchange's
 * WebSocket relay where `allowedRelays` keeps it.
 */
export function ownRelayForInvitation(
  allowedRelays: ReadonlyArray<string> | undefined,
  readOwn: () => OwnRelayRead = () => NO_OWN_RELAY,
): RelayUrls | undefined {
  const own = readOwn();
  const run = relayForRun(undefined, allowedRelays, () => own);
  const urls =
    run !== undefined ? { turn: run.turn, stun: run.stun } : undefined;
  const websocket = webSocketRelaysForRun(
    undefined,
    allowedRelays,
    () => own,
  ).at(0);
  if (websocket === undefined) return urls;
  return { ...(urls ?? {}), websocket };
}
