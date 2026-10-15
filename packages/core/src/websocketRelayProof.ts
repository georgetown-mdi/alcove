import {
  bytesEqual,
  decFatal,
  enc,
  hkdfDerive,
  hmacSha256,
} from "./utils/crypto.js";
import { InternalConsistencyError } from "./errors.js";
import { relayKeyBytes } from "./relayRegistrarProof.js";
import { RENDEZVOUS_ROLES } from "./rendezvous.js";
import type { RendezvousRole } from "./rendezvous.js";

const PROOF_KEY_INFO = "alcove-relay-websocket-v2:proof-key";
const PROOF_MESSAGE_LABEL = "alcove-relay-websocket-v2:hello";
const PROOF_KEY_BYTES = 32;
const PROOF_TAG_BYTES = 32;

// Longer than any well-formed message (the label, the longer role, a
// safe-integer expiry and two separators), so a parse decodes nothing larger.
const MAX_PROOF_MESSAGE_BYTES = 128;

const PROOF_MESSAGE_PATTERN = new RegExp(
  `^${PROOF_MESSAGE_LABEL}\\n(${RENDEZVOUS_ROLES.join("|")})\\n(0|[1-9][0-9]*)$`,
);

/**
 * The longest lifetime, in seconds, {@link buildWebSocketRelayProof} gives a
 * WebSocket relay proof: the registrar's 300-second freshness window.
 */
export const WEBSOCKET_RELAY_PROOF_MAX_TTL_SECONDS = 300;

/**
 * Why a WebSocket relay proof was refused: its bytes do not parse, it names
 * another role than the one checked, its expiry has passed, or its tag is not
 * the one the proof key makes.
 */
export type WebSocketRelayProofRefusal =
  "malformed" | "role-mismatch" | "expired" | "tag-mismatch";

/**
 * The refusal of a presented WebSocket relay proof, the one error
 * {@link parseWebSocketRelayProof} and {@link checkWebSocketRelayProof} throw
 * for anything a party presents.
 */
export class WebSocketRelayProofRefusedError extends Error {
  /** Which of the checks refused the proof. */
  readonly reason: WebSocketRelayProofRefusal;

  constructor(reason: WebSocketRelayProofRefusal, message: string) {
    super(message);
    this.name = "WebSocketRelayProofRefusedError";
    this.reason = reason;
  }
}

/**
 * A party's proof to the WebSocket relay that it holds the exchange's relay
 * key. The format: docs/spec/PROTOCOL.md, "The WebSocket relay proof".
 */
export interface WebSocketRelayProof {
  role: RendezvousRole;
  /** The Unix second the relay stops accepting the proof at. */
  expiresAtSeconds: number;
  /** The signed message's bytes, as the relay is presented them. */
  message: Uint8Array<ArrayBuffer>;
  /** HMAC-SHA-256 of `message` under the proof key. */
  tag: Uint8Array<ArrayBuffer>;
}

/**
 * Derive the key a WebSocket relay proof is signed under from the relay key's
 * 32 decoded bytes. The relay derives it from each key it holds; a party
 * derives it inside {@link buildWebSocketRelayProof}.
 *
 * @param relayKey  The exchange's relay key as 64 lowercase hex characters.
 * @throws {Error} if `relayKey` is not 64 lowercase hex characters.
 */
export async function deriveWebSocketRelayProofKey(
  relayKey: string,
): Promise<Uint8Array<ArrayBuffer>> {
  return hkdfDerive(
    relayKeyBytes("deriveWebSocketRelayProofKey", relayKey),
    PROOF_KEY_INFO,
    PROOF_KEY_BYTES,
  );
}

function proofMessage(
  role: RendezvousRole,
  expiresAtSeconds: number,
): Uint8Array<ArrayBuffer> {
  return enc.encode(
    [PROOF_MESSAGE_LABEL, role, String(expiresAtSeconds)].join("\n"),
  );
}

/** Arguments to {@link buildWebSocketRelayProof}. */
export interface BuildWebSocketRelayProofOptions {
  /** The exchange's relay key as 64 lowercase hex characters. */
  relayKey: string;
  role: RendezvousRole;
  /** Lifetime in whole seconds, from 1 to {@link WEBSOCKET_RELAY_PROOF_MAX_TTL_SECONDS}. */
  ttlSeconds: number;
  /** The time the lifetime counts from. */
  now: Date;
}

/**
 * Build the proof a party presents to the WebSocket relay for `role`, expiring
 * `ttlSeconds` after `now`. The format: docs/spec/PROTOCOL.md, "The WebSocket
 * relay proof".
 *
 * @throws {Error} if `relayKey` is not 64 lowercase hex characters, `role` is
 *   not a rendezvous role, `ttlSeconds` is not a whole number of seconds from 1
 *   to {@link WEBSOCKET_RELAY_PROOF_MAX_TTL_SECONDS}, or `now` is not a valid
 *   date at or after the Unix epoch.
 */
export async function buildWebSocketRelayProof({
  relayKey,
  role,
  ttlSeconds,
  now,
}: BuildWebSocketRelayProofOptions): Promise<WebSocketRelayProof> {
  if (!(RENDEZVOUS_ROLES as readonly string[]).includes(role)) {
    throw new InternalConsistencyError(
      `buildWebSocketRelayProof: role ${JSON.stringify(role)} must be one of ` +
        RENDEZVOUS_ROLES.map((r) => JSON.stringify(r)).join(", "),
    );
  }
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > WEBSOCKET_RELAY_PROOF_MAX_TTL_SECONDS
  ) {
    throw new InternalConsistencyError(
      "buildWebSocketRelayProof: ttlSeconds must be whole seconds from 1 to " +
        `${WEBSOCKET_RELAY_PROOF_MAX_TTL_SECONDS}; got ${ttlSeconds}`,
    );
  }
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new InternalConsistencyError(
      "buildWebSocketRelayProof: now is not a valid date at or after the Unix epoch",
    );
  }
  const expiresAtSeconds = Math.floor(nowMs / 1000) + ttlSeconds;
  const key = await deriveWebSocketRelayProofKey(relayKey);
  const message = proofMessage(role, expiresAtSeconds);
  return {
    role,
    expiresAtSeconds,
    message,
    tag: await hmacSha256(key, message),
  };
}

function malformed(detail: string): WebSocketRelayProofRefusedError {
  return new WebSocketRelayProofRefusedError(
    "malformed",
    `The relay proof is malformed: ${detail}.`,
  );
}

/**
 * Read a presented message and tag as a WebSocket relay proof, without
 * checking it. Each argument is copied, so the result shares no buffer with
 * the caller.
 *
 * @throws {WebSocketRelayProofRefusedError} with reason `malformed` if
 *   `message` is not a `Uint8Array` in exactly the message layout, or
 *   `tag` is not a `Uint8Array` of 32 bytes. It throws nothing else.
 */
export function parseWebSocketRelayProof(
  message: unknown,
  tag: unknown,
): WebSocketRelayProof {
  if (!(message instanceof Uint8Array)) {
    throw malformed("the message is not bytes");
  }
  if (!(tag instanceof Uint8Array)) {
    throw malformed("the tag is not bytes");
  }
  if (tag.length !== PROOF_TAG_BYTES) {
    throw malformed(`the tag is not ${PROOF_TAG_BYTES} bytes`);
  }
  if (message.length > MAX_PROOF_MESSAGE_BYTES) {
    throw malformed(`the message is over ${MAX_PROOF_MESSAGE_BYTES} bytes`);
  }
  let text: string;
  try {
    text = decFatal.decode(message);
  } catch {
    throw malformed("the message is not UTF-8");
  }
  const match = PROOF_MESSAGE_PATTERN.exec(text);
  if (match === null) {
    throw malformed("the message does not have the proof's layout");
  }
  const expiresAtSeconds = Number(match[2]);
  if (!Number.isSafeInteger(expiresAtSeconds)) {
    throw malformed("the expiry is out of range");
  }
  return {
    role: match[1] as RendezvousRole,
    expiresAtSeconds,
    message: new Uint8Array(message),
    tag: new Uint8Array(tag),
  };
}

/** Arguments to {@link checkWebSocketRelayProof}. */
export interface CheckWebSocketRelayProofOptions {
  /** The key from {@link deriveWebSocketRelayProofKey}. */
  proofKey: Uint8Array<ArrayBuffer>;
  /** A proof from {@link parseWebSocketRelayProof}. */
  proof: WebSocketRelayProof;
  /** The role the presenting party claims. */
  role: RendezvousRole;
  /** The relay's current time. */
  now: Date;
}

/**
 * Check a presented WebSocket relay proof under `proofKey`: the proof names
 * `role`, its expiry is after `now`, and its tag is the one `proofKey` makes
 * over its role and expiry, compared in constant time. Resolves when every
 * check passes.
 *
 * @throws {WebSocketRelayProofRefusedError} with reason `role-mismatch`,
 *   `expired` or `tag-mismatch` for a proof that fails a check.
 * @throws {Error} if `proofKey` is not 32 bytes or `now` is not a valid date.
 */
export async function checkWebSocketRelayProof({
  proofKey,
  proof,
  role,
  now,
}: CheckWebSocketRelayProofOptions): Promise<void> {
  if (proofKey.length !== PROOF_KEY_BYTES) {
    throw new InternalConsistencyError(
      `checkWebSocketRelayProof: proofKey must be ${PROOF_KEY_BYTES} bytes`,
    );
  }
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new InternalConsistencyError(
      "checkWebSocketRelayProof: now is not a valid date",
    );
  }
  if (proof.role !== role) {
    throw new WebSocketRelayProofRefusedError(
      "role-mismatch",
      "The relay proof was made for the other role.",
    );
  }
  if (proof.expiresAtSeconds <= Math.floor(nowMs / 1000)) {
    throw new WebSocketRelayProofRefusedError(
      "expired",
      "The relay proof has expired.",
    );
  }
  const expected = await hmacSha256(
    proofKey,
    proofMessage(role, proof.expiresAtSeconds),
  );
  if (!bytesEqual(expected, proof.tag)) {
    throw new WebSocketRelayProofRefusedError(
      "tag-mismatch",
      "The relay proof does not verify under the exchange's relay key.",
    );
  }
}
