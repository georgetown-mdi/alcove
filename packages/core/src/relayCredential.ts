import {
  enc,
  fromBase64Url,
  hkdfDerive,
  hmacSha1,
  toHex,
} from "./utils/crypto.js";
import {
  SHARED_SECRET_REGEX,
  turnUrlIsAllowed,
  webSocketRelayUrlIsAllowed,
} from "./config/connection.js";
import type { WebRTCConnectionConfig } from "./config/connection.js";
import { InternalConsistencyError } from "./errors.js";

/**
 * HKDF info label for the per-exchange relay key. A single fixed label in the
 * domain-separation label space (docs/spec/PROTOCOL.md, "The domain-separation
 * label space").
 */
const RELAY_KEY_INFO = "alcove-relay-key-v2";

const RELAY_KEY_BYTES = 32;

/**
 * HKDF info label for the exchange id a relay key is enrolled under without a
 * token, a single fixed label in the same label space as {@link RELAY_KEY_INFO}.
 */
const RELAY_EXCHANGE_ID_INFO = "alcove-relay-exchange-id-v2";

const RELAY_EXCHANGE_ID_BYTES = 16;

/**
 * The longest lifetime, in seconds, {@link mintRelayCredential} gives a relay
 * credential: one hour, the default of the relay's own `mint-credential.sh`.
 */
export const RELAY_CREDENTIAL_MAX_TTL_SECONDS = 3600;

/** A time-limited TURN credential, in the relay server's REST-API format. */
export interface RelayCredential {
  /** `<unix-expiry-seconds>:<label>`. */
  username: string;
  /** Base64 HMAC-SHA-1 of `username` under the relay key. */
  credential: string;
  /** When the relay stops accepting the credential. */
  expiresAt: Date;
}

/**
 * Derive the per-exchange relay key from the exchange's current shared secret.
 * Both parties compute the same key; it is the secret the relay checks
 * credentials against and the key {@link mintRelayCredential} signs with. The
 * construction: docs/spec/PROTOCOL.md, "Relay credential derivation".
 *
 * @param sharedSecret  The exchange's current base64url-encoded 32-byte shared
 *                      secret, matching {@link SHARED_SECRET_REGEX}.
 * @returns The 32-byte key as lowercase hex, the string the relay stores.
 * @throws {Error} if `sharedSecret` is not a base64url-encoded 32-byte value.
 */
export async function deriveRelayKey(sharedSecret: string): Promise<string> {
  return deriveHexFromSecret(
    "deriveRelayKey",
    sharedSecret,
    RELAY_KEY_INFO,
    RELAY_KEY_BYTES,
  );
}

/**
 * Derive the exchange id a party enrolls the exchange's relay key under at a
 * registrar that takes an enrollment without a token. Both parties compute the
 * same id from the exchange's current shared secret, and nobody without the
 * secret can predict it, so nobody else can enroll the id first. The
 * construction: docs/spec/PROTOCOL.md, "Relay credential derivation".
 *
 * @param sharedSecret  The exchange's current base64url-encoded 32-byte shared
 *                      secret, matching {@link SHARED_SECRET_REGEX}.
 * @returns The 16-byte id as 32 lowercase hex characters.
 * @throws {Error} if `sharedSecret` is not a base64url-encoded 32-byte value.
 */
export async function deriveRelayExchangeId(
  sharedSecret: string,
): Promise<string> {
  return deriveHexFromSecret(
    "deriveRelayExchangeId",
    sharedSecret,
    RELAY_EXCHANGE_ID_INFO,
    RELAY_EXCHANGE_ID_BYTES,
  );
}

async function deriveHexFromSecret(
  caller: string,
  sharedSecret: string,
  info: string,
  lengthBytes: number,
): Promise<string> {
  if (!SHARED_SECRET_REGEX.test(sharedSecret)) {
    throw new InternalConsistencyError(
      `${caller}: sharedSecret must be a base64url-encoded 32-byte value ` +
        "matching SHARED_SECRET_REGEX",
    );
  }
  return toHex(
    await hkdfDerive(fromBase64Url(sharedSecret), info, lengthBytes),
  );
}

/** Arguments to {@link mintRelayCredential}. */
export interface MintRelayCredentialOptions {
  /** The relay key, used as the HMAC key by its UTF-8 bytes. */
  key: string;
  /** The name after the expiry in the username; must not contain `:`. */
  label: string;
  /** Lifetime in whole seconds, from 1 to {@link RELAY_CREDENTIAL_MAX_TTL_SECONDS}. */
  ttlSeconds: number;
  /** The time the lifetime counts from. */
  now: Date;
}

/**
 * Mint a time-limited TURN credential under `key` without contacting the relay:
 * the relay recomputes the same HMAC when the credential is presented. The
 * format: docs/spec/PROTOCOL.md, "Relay credential derivation".
 *
 * @throws {Error} if `key` or `label` is empty, `label` contains `:`,
 *                 `ttlSeconds` is not a whole number of seconds from 1 to
 *                 {@link RELAY_CREDENTIAL_MAX_TTL_SECONDS}, or `now` is not a
 *                 valid date.
 */
export async function mintRelayCredential({
  key,
  label,
  ttlSeconds,
  now,
}: MintRelayCredentialOptions): Promise<RelayCredential> {
  if (key.length === 0) {
    throw new InternalConsistencyError("mintRelayCredential: key is empty");
  }
  if (label.length === 0 || label.includes(":")) {
    throw new InternalConsistencyError(
      `mintRelayCredential: label ${JSON.stringify(label)} must be non-empty ` +
        "and must not contain ':', which separates it from the expiry",
    );
  }
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > RELAY_CREDENTIAL_MAX_TTL_SECONDS
  ) {
    throw new InternalConsistencyError(
      `mintRelayCredential: ttlSeconds must be whole seconds from 1 to ` +
        `${RELAY_CREDENTIAL_MAX_TTL_SECONDS}; got ${ttlSeconds}`,
    );
  }
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new InternalConsistencyError(
      "mintRelayCredential: now is not a valid date",
    );
  }
  const expirySeconds = Math.floor(nowMs / 1000) + ttlSeconds;
  const username = `${expirySeconds}:${label}`;
  const mac = await hmacSha1(enc.encode(key), enc.encode(username));
  return {
    username,
    credential: btoa(String.fromCharCode(...mac)),
    expiresAt: new Date(expirySeconds * 1000),
  };
}

/**
 * The label {@link mintRunRelayCredential} puts in a relay credential's
 * username. The relay operator reads it in its logs, so it names the software
 * and nothing about the exchange or the party.
 */
export const RUN_RELAY_CREDENTIAL_LABEL = "alcove";

/**
 * One TURN server a webrtc run lists. An entry with no `credential` is
 * presented the credential the run mints from the shared secret
 * ({@link mintRunRelayCredential}); one with a `credential` is an own `turn`
 * entry's static pair, presented as written.
 */
export interface RunTurnServer {
  /** Whether the url is the connection's own `turn` entry or the invitation's. */
  source: "own" | "invitation";
  url: string;
  username?: string;
  credential?: string;
}

/**
 * The relay servers a webrtc run gathers candidates from: every relay it may
 * use, the connection's own followed by the invitation's.
 */
export interface RunRelaySelection {
  /**
   * The connection's own `stun` urls followed by the invitation's, an
   * invitation url already listed left out; absent when neither side names a
   * list.
   */
  stun?: string[];
  /**
   * The connection's own `turn` entries followed by the invitation's TURN
   * urls, an invitation url an own entry already names left out, and then
   * every url the connection's `allowedRelays` does not name left out;
   * absent when neither side names any.
   */
  turn?: RunTurnServer[];
  /**
   * The TURN urls `allowedRelays` left out of {@link turn}, in the order
   * they would have been listed; absent when it left out none.
   */
  turnLeftOut?: RunTurnServer[];
  /**
   * The connection's own `websocketRelay` followed by the invitation's
   * WebSocket relay url, an invitation url the connection already names left
   * out, and then every url `allowedRelays` does not name left out; absent
   * when neither side names one.
   */
  websocket?: RunWebSocketRelay[];
  /**
   * The WebSocket relay urls `allowedRelays` left out of {@link websocket},
   * in the order they would have been listed; absent when it left out none.
   */
  websocketLeftOut?: RunWebSocketRelay[];
}

/**
 * One WebSocket relay a webrtc run lists, and the exchange id its proof to
 * that relay is made under. The id is decided by the url, not the `source`:
 * the url the invitation names takes the invitation's `websocketExchangeId`,
 * since the inviter proves to it under that id, and the connection's own url
 * otherwise takes `relayRegistrar`'s exchange id.
 */
export interface RunWebSocketRelay {
  /** Whether the url is the connection's own `websocketRelay` or the invitation's. */
  source: "own" | "invitation";
  url: string;
  /**
   * The exchange id the relay holds the exchange's relay key under, where
   * the connection or the invitation names one; absent, the id derived from
   * the shared secret ({@link deriveRelayExchangeId}).
   */
  exchangeId?: string;
}

/** The connection fields that decide a run's relay servers. */
export type RunRelayConnection = Pick<
  WebRTCConnectionConfig,
  | "stun"
  | "turn"
  | "invitationRelay"
  | "allowedRelays"
  | "websocketRelay"
  | "relayRegistrar"
>;

/**
 * Choose the relay servers a webrtc run uses (see {@link RunRelaySelection}).
 * A connection with no `invitationRelay` selects exactly its own `stun` and
 * `turn`, so a run from an invitation that named no relay is unchanged.
 */
export function selectRunRelay(
  connection: RunRelayConnection,
): RunRelaySelection {
  const invitation = connection.invitationRelay;
  const selection: RunRelaySelection = {};
  if (connection.stun !== undefined || invitation?.stun !== undefined) {
    const stun = [...(connection.stun ?? [])];
    const listed = new Set(stun);
    for (const url of invitation?.stun ?? []) {
      if (listed.has(url)) continue;
      listed.add(url);
      stun.push(url);
    }
    selection.stun = stun;
  }
  if (connection.turn !== undefined || invitation?.turn !== undefined) {
    const turn: RunTurnServer[] = (connection.turn ?? []).map((server) => ({
      source: "own",
      url: server.url,
      ...(server.username !== undefined && { username: server.username }),
      ...(server.credential !== undefined && {
        credential: server.credential,
      }),
    }));
    const listed = new Set(turn.map((server) => server.url));
    for (const url of invitation?.turn ?? []) {
      if (listed.has(url)) continue;
      listed.add(url);
      turn.push({ source: "invitation", url });
    }
    selection.turn = turn.filter((server) =>
      turnUrlIsAllowed(server.url, connection.allowedRelays),
    );
    const leftOut = turn.filter(
      (server) => !turnUrlIsAllowed(server.url, connection.allowedRelays),
    );
    if (leftOut.length > 0) selection.turnLeftOut = leftOut;
  }
  const websocket: RunWebSocketRelay[] = [];
  const invitationExchangeId = invitation?.websocketExchangeId;
  if (connection.websocketRelay !== undefined) {
    const exchangeId =
      connection.websocketRelay === invitation?.websocket
        ? invitationExchangeId
        : connection.relayRegistrar?.exchangeId;
    websocket.push({
      source: "own",
      url: connection.websocketRelay,
      ...(exchangeId !== undefined && { exchangeId }),
    });
  }
  if (
    invitation?.websocket !== undefined &&
    invitation.websocket !== connection.websocketRelay
  )
    websocket.push({
      source: "invitation",
      url: invitation.websocket,
      ...(invitationExchangeId !== undefined && {
        exchangeId: invitationExchangeId,
      }),
    });
  if (websocket.length > 0) {
    selection.websocket = websocket.filter((relay) =>
      webSocketRelayUrlIsAllowed(relay.url, connection.allowedRelays),
    );
    const leftOut = websocket.filter(
      (relay) =>
        !webSocketRelayUrlIsAllowed(relay.url, connection.allowedRelays),
    );
    if (leftOut.length > 0) selection.websocketLeftOut = leftOut;
  }
  return selection;
}

/**
 * Whether `allowedRelays` left out every TURN url and the WebSocket relay url
 * the invitation names that a run would otherwise list, so a run contacts
 * neither that relay nor its registrar for that reason alone.
 */
export function allowedRelaysLeaveOutInvitationRelay(
  connection: RunRelayConnection,
): boolean {
  const { turn, turnLeftOut, websocket, websocketLeftOut } =
    selectRunRelay(connection);
  const invitationWebSocket = connection.invitationRelay?.websocket;
  const leftOut =
    (turnLeftOut ?? []).some((server) => server.source === "invitation") ||
    (websocketLeftOut ?? []).some((relay) => relay.url === invitationWebSocket);
  const kept =
    (turn ?? []).some((server) => server.source === "invitation") ||
    (websocket ?? []).some((relay) => relay.url === invitationWebSocket);
  return leftOut && !kept;
}

/**
 * Whether a webrtc run enrolls at the registrar its connection's
 * `invitationRelay` names: when the TURN server it allocates on, the first
 * {@link selectRunRelay} lists, has a url the invitation names and is
 * presented the minted credential, or when it dials the invitation's
 * WebSocket relay under the exchange id derived from the secret, the one an
 * enrollment without a token uses. Each is decided by the url, not the
 * entry's `source`, so an own entry naming the invitation's url enrolls too
 * (docs/spec/PROTOCOL.md, "Enrolling at a default relay").
 */
export function runEnrollsAtInvitationRegistrar(
  connection: RunRelayConnection,
): boolean {
  const invitation = connection.invitationRelay;
  if (invitation?.registrar === undefined) return false;
  const { turn, websocket } = selectRunRelay(connection);
  const allocating = turn?.[0];
  const allocatesThere =
    allocating !== undefined &&
    (invitation.turn ?? []).includes(allocating.url) &&
    allocating.username === undefined &&
    allocating.credential === undefined;
  const dialsThere = (websocket ?? []).some((relay) =>
    webSocketRelayEnrollsAtInvitationRegistrar(relay, connection),
  );
  return allocatesThere || dialsThere;
}

/**
 * Whether a run dialing `relay` enrolls at the registrar its connection's
 * `invitationRelay` names on that relay's account: the invitation names a
 * registrar, `relay` has the url of the invitation's WebSocket relay, and the
 * run dials it under the exchange id derived from the secret. Decided by the
 * url, not the entry's `source`, as {@link runEnrollsAtInvitationRegistrar}.
 */
export function webSocketRelayEnrollsAtInvitationRegistrar(
  relay: RunWebSocketRelay,
  connection: Pick<RunRelayConnection, "invitationRelay">,
): boolean {
  const invitation = connection.invitationRelay;
  return (
    invitation?.registrar !== undefined &&
    relay.url === invitation.websocket &&
    relay.exchangeId === undefined
  );
}

/**
 * Whether a run dialing `relay` dials the invitation's WebSocket relay under
 * the exchange id the invitation names, so the partner enrolled that id at
 * their own registrar with a relay-owner token this side does not hold.
 * Decided by the url, not the entry's `source`, as
 * {@link runEnrollsAtInvitationRegistrar}.
 */
export function webSocketRelayIsPartnersUnderInvitationExchangeId(
  relay: RunWebSocketRelay,
  connection: Pick<RunRelayConnection, "invitationRelay">,
): boolean {
  const invitation = connection.invitationRelay;
  return (
    invitation?.websocket !== undefined &&
    relay.url === invitation.websocket &&
    relay.exchangeId !== undefined
  );
}

/**
 * Mint the credential a run presents to every TURN url it lists that sets no
 * static credential, the invitation's urls and its own minted entries alike:
 * signed under the relay key derived from the run's stored current shared
 * secret, for {@link RELAY_CREDENTIAL_MAX_TTL_SECONDS}, labelled
 * {@link RUN_RELAY_CREDENTIAL_LABEL}. A caller passes that secret even where
 * the handshake may complete under a previous one, since the relay key the
 * party's registrar holds is the current secret's (docs/spec/PROTOCOL.md,
 * "Relay credential derivation"). Nothing is stored; the next run mints again
 * from the secret it then holds.
 *
 * @throws {Error} if `sharedSecret` is not a base64url-encoded 32-byte value
 *   or `now` is not a valid date.
 */
export async function mintRunRelayCredential(
  sharedSecret: string,
  now: Date,
): Promise<RelayCredential> {
  return mintRelayCredential({
    key: await deriveRelayKey(sharedSecret),
    label: RUN_RELAY_CREDENTIAL_LABEL,
    ttlSeconds: RELAY_CREDENTIAL_MAX_TTL_SECONDS,
    now,
  });
}
