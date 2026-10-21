/**
 * This browser's own relay: the TURN and STUN urls and the WebSocket relay url
 * an operator sets for their side of a WebRTC exchange, kept in localStorage
 * and so held per origin -- the hosted app and a console each keep their own.
 * The urls follow core's `connection.turn` / `connection.stun` /
 * `connection.websocket_relay` grammar. No credential is stored: each run
 * mints its own from the exchange's shared secret (`buildIceServers` in
 * `./rendezvous.ts`).
 */

import { z } from "zod";

import {
  StunUrlSchema,
  TurnUrlSchema,
  getLogger,
  maxCodeUnits,
  parseBoundedJson,
  turnUrlIsAllowed,
  webSocketRelayUrlIsAllowed,
  webSocketRelayUrlSchema,
} from "@alcove/core";

import type { RelayLocator, RunRelay } from "./rendezvous";

const log = getLogger("ownRelaySetting");

/** The localStorage key the setting is written under. */
const STORAGE_KEY = "alcove-own-relay";

/** The stored value's schema version; a value under any other is refused. */
const SETTING_VERSION = 1;

/** How many urls each list holds at most. */
export const MAX_RELAY_URLS = 8;

/** How long one url may be, in UTF-16 code units. */
const MAX_RELAY_URL_LENGTH = 1024;

const TurnListSchema = z
  .array(TurnUrlSchema.check(maxCodeUnits(MAX_RELAY_URL_LENGTH)))
  .max(MAX_RELAY_URLS);
const StunListSchema = z
  .array(StunUrlSchema.check(maxCodeUnits(MAX_RELAY_URL_LENGTH)))
  .max(MAX_RELAY_URLS);

const WebSocketUrlSchema = webSocketRelayUrlSchema("the WebSocket relay url");

// `websocket` is written only when set, so a value naming none stays
// readable by a build that predates the key.
const StoredOwnRelaySchema = z
  .strictObject({
    version: z.literal(SETTING_VERSION),
    turn: TurnListSchema,
    stun: StunListSchema,
    websocket: WebSocketUrlSchema.optional(),
  })
  .refine(
    (value) =>
      value.turn.length + value.stun.length > 0 ||
      value.websocket !== undefined,
    { message: "a stored relay names no url" },
  );

/** This browser's own relay: its TURN and STUN urls and its WebSocket relay. */
export interface OwnRelay extends RelayLocator {
  /** The `wss://` url of a WebSocket relay; absent when none is set. */
  websocket?: string;
}

/** How reading the stored setting turned out. */
export type OwnRelayRead =
  /** Nothing is stored, or storage is unreachable: no relay. */
  | { kind: "none" }
  | { kind: "set"; relay: OwnRelay }
  /** A value is stored that this build refuses; no relay is used. */
  | { kind: "unreadable" };

/** This context's localStorage, or `undefined` where it has none or refuses
 * access (server rendering, storage disabled). */
function storage(): Storage | undefined {
  try {
    const store: Storage | undefined = globalThis.localStorage;
    return store;
  } catch {
    return undefined;
  }
}

/** Read the stored own relay. */
export function readOwnRelaySetting(): OwnRelayRead {
  let raw: string | null | undefined;
  try {
    raw = storage()?.getItem(STORAGE_KEY);
  } catch {
    return { kind: "none" };
  }
  if (raw === null || raw === undefined) return { kind: "none" };
  try {
    const parsed = StoredOwnRelaySchema.parse(parseBoundedJson(raw));
    return {
      kind: "set",
      relay: {
        turn: parsed.turn,
        stun: parsed.stun,
        ...(parsed.websocket !== undefined && { websocket: parsed.websocket }),
      },
    };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * Store `relay` as this browser's own relay, or remove the setting when it
 * names no url.
 *
 * @throws if `relay` fails the url grammar or the list bounds, or storage
 *   refuses the write.
 */
export function writeOwnRelaySetting(relay: OwnRelay): void {
  const store = storage();
  if (store === undefined)
    throw new Error("this browser's storage is not available");
  if (
    relay.turn.length + relay.stun.length === 0 &&
    relay.websocket === undefined
  ) {
    store.removeItem(STORAGE_KEY);
    return;
  }
  const value = StoredOwnRelaySchema.parse({
    version: SETTING_VERSION,
    turn: [...relay.turn],
    stun: [...relay.stun],
    ...(relay.websocket !== undefined && { websocket: relay.websocket }),
  });
  store.setItem(STORAGE_KEY, JSON.stringify(value));
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
 * this browser's own and the invitation's. Its TURN urls are this browser's
 * own followed by the invitation's, each listed once, less every one
 * `allowedRelays` leaves out, and its STUN urls likewise, none left out.
 * Where this browser's own setting names STUN urls they replace the default
 * STUN server (`stunReplacesDefault`); an invitation's do not. With neither
 * it is none. A stored setting this build cannot read adds nothing, and is
 * logged. The command line lists the urls the same way (`selectRunRelay` in
 * core).
 */
export function relayForRun(
  invitationRelay: RelayUrls | undefined,
  allowedRelays: ReadonlyArray<string> | undefined,
  readOwn: () => OwnRelayRead = readOwnRelaySetting,
): RunRelay | undefined {
  const own = readOwn();
  if (own.kind === "unreadable")
    log.warn(
      "the stored relay setting could not be read, so this run uses no relay " +
        "of its own; set it again in Relay settings",
    );
  const ownRelay = own.kind === "set" ? own.relay : undefined;
  const turn = [
    ...new Set([...(ownRelay?.turn ?? []), ...(invitationRelay?.turn ?? [])]),
  ].filter((url) => turnUrlIsAllowed(url, allowedRelays));
  const stun = [
    ...new Set([...(ownRelay?.stun ?? []), ...(invitationRelay?.stun ?? [])]),
  ];
  if (turn.length + stun.length === 0) return undefined;
  return {
    turn,
    stun,
    ...(ownRelay !== undefined &&
      ownRelay.stun.length > 0 && { stunReplacesDefault: true as const }),
  };
}

/**
 * This browser's WebSocket relay url followed by the invitation's, each
 * listed once, less every one `allowedRelays` leaves out. A stored setting
 * this build cannot read adds nothing.
 */
export function webSocketRelaysForRun(
  invitationRelay: RelayUrls | undefined,
  allowedRelays: ReadonlyArray<string> | undefined,
  readOwn: () => OwnRelayRead = readOwnRelaySetting,
): Array<string> {
  const own = readOwn();
  const listed = [
    ...(own.kind === "set" && own.relay.websocket !== undefined
      ? [own.relay.websocket]
      : []),
    ...(invitationRelay?.websocket !== undefined
      ? [invitationRelay.websocket]
      : []),
  ];
  return [...new Set(listed)].filter((url) =>
    webSocketRelayUrlIsAllowed(url, allowedRelays),
  );
}

/**
 * The relay an invitation this browser creates names of its own: the TURN
 * and STUN urls {@link relayForRun} lists with no invitation, and this
 * browser's WebSocket relay where `allowedRelays` keeps it.
 */
export function ownRelayForInvitation(
  allowedRelays: ReadonlyArray<string> | undefined,
  readOwn: () => OwnRelayRead = readOwnRelaySetting,
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
