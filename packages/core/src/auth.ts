import { hkdfDerive, toBase64Url, fromBase64Url } from "./utils/crypto.js";
import { runKex } from "./kex.js";

import type { HandshakeRole } from "./types.js";
import type { MessageConnection } from "./connection/messageConnection.js";
import { SHARED_SECRET_REGEX } from "./config/connection.js";
import type { Authentication } from "./config/connection.js";
import {
  InternalConsistencyError,
  markStatesItsOwnNextStep,
} from "./errors.js";

/** The remedy sentence every refusal of an unusable shared secret ends with. */
export const NEW_INVITATION_REMEDY =
  "Ask your partner for a new invitation, or create one with 'alcove " +
  "invite' and have your partner accept it.";

/**
 * Result returned by {@link authenticateConnection} after a successful P-256
 * key exchange.
 */
export interface AuthResult {
  /**
   * 32-byte session key from the P-256 key exchange, the same for both parties.
   * A caller that needs application-layer encryption passes it to
   * {@link deriveAeadKey}; one relying on transport security (WebRTC with
   * DTLS) may ignore it.
   */
  sessionKey: Uint8Array<ArrayBuffer>;
  /**
   * Rotated shared secret, a base64url 32-byte HKDF output both parties derive
   * from `sessionKey`, with no expiration. The caller persists it to
   * `.alcove.key` for the next exchange.
   */
  rotatedSecret: string;
  /**
   * Whether to wrap the connection in an application-encryption layer
   * ({@link KexResult.applyEncryption}): the transcript-bound OR of both
   * parties' requests. When `true` the caller applies {@link deriveAeadKey}
   * and an `EncryptedMessageConnection` wrap.
   */
  applyEncryption: boolean;
}

/**
 * The AEAD direction-context labels {@link deriveAeadKey} accepts, one per
 * direction (docs/spec/CHANNEL_SECURITY.md, "Application-layer AEAD"). Add a
 * label only as a reviewed change. Frozen so a plain-JS caller cannot widen
 * the set the runtime guard checks.
 */
export const AEAD_CONTEXTS = Object.freeze([
  "initiator-to-responder",
  "responder-to-initiator",
] as const);

/** An AEAD direction-context label, one of {@link AEAD_CONTEXTS}. */
export type AeadContext = (typeof AEAD_CONTEXTS)[number];

/**
 * Derive a 32-byte AES-256-GCM key for one direction of the application-layer
 * encrypted stream from the session key using HKDF.
 *
 * @param sessionKey  The `sessionKey` field from {@link AuthResult}.
 * @param context     The direction label. The runtime check catches a caller
 *                    that bypasses the {@link AeadContext} type.
 * @throws {Error} if `context` is not one of {@link AEAD_CONTEXTS}.
 */
export async function deriveAeadKey(
  sessionKey: Uint8Array<ArrayBuffer>,
  context: AeadContext,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!(AEAD_CONTEXTS as readonly string[]).includes(context)) {
    throw new InternalConsistencyError(
      `deriveAeadKey: unknown AEAD context ${JSON.stringify(context)}; ` +
        `expected one of ${AEAD_CONTEXTS.map((l) => JSON.stringify(l)).join(", ")}`,
    );
  }
  return hkdfDerive(sessionKey, `alcove-aead-v2:${context}`, 32);
}

/**
 * The two abort-token roles, frozen as {@link AEAD_CONTEXTS} is. The writer's
 * own role names the token it writes, the peer's the token it verifies.
 */
export const ABORT_TOKEN_ROLES = Object.freeze([
  "initiator",
  "responder",
] as const);

/** An abort-token role. One of the fixed {@link ABORT_TOKEN_ROLES}. */
type AbortTokenRole = (typeof ABORT_TOKEN_ROLES)[number];

/**
 * Derive a 32-byte per-direction abort token from the session key using HKDF,
 * authenticating the cross-party abort marker (`<writerId>-abort.json`;
 * docs/spec/CHANNEL_SECURITY.md, "Authenticated abort marker").
 *
 * @throws {Error} if `role` is not one of {@link ABORT_TOKEN_ROLES}.
 */
export async function deriveAbortToken(
  sessionKey: Uint8Array<ArrayBuffer>,
  role: AbortTokenRole,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!(ABORT_TOKEN_ROLES as readonly string[]).includes(role)) {
    throw new InternalConsistencyError(
      `deriveAbortToken: unknown abort-token role ${JSON.stringify(role)}; ` +
        `expected one of ${ABORT_TOKEN_ROLES.map((r) => JSON.stringify(r)).join(", ")}`,
    );
  }
  return hkdfDerive(sessionKey, `alcove-abort-token-v2:${role}`, 32);
}

/**
 * Whether an ISO 8601 `expires` is at or before `now`. An unparseable value,
 * from a caller that bypassed key-file validation, counts as expired.
 */
function isExpired(expires: string, now: number): boolean {
  const expiresMs = new Date(expires).getTime();
  return Number.isNaN(expiresMs) || expiresMs <= now;
}

/**
 * Assert the pre-handshake check on a shared secret (docs/spec/PROTOCOL.md,
 * "Enforcement sites"): present, matching {@link SHARED_SECRET_REGEX}, and not
 * expired. It reads local state only, so {@link runProtocol} runs it before
 * opening a connection; {@link authenticateConnection} runs it too.
 *
 * @throws {Error} (marked {@link markStatesItsOwnNextStep}, as each message
 *                 states its own remedy) if `sharedSecret` is absent or not a
 *                 base64url-encoded 32-byte value, or if `expires` is past.
 */
export function assertSharedSecretReadyForHandshake(
  authentication: Authentication,
): asserts authentication is Authentication & { sharedSecret: string } {
  const { sharedSecret, expires } = authentication;

  if (!sharedSecret || !SHARED_SECRET_REGEX.test(sharedSecret)) {
    throw markStatesItsOwnNextStep(
      new Error(
        "the key file's sharedSecret must be a base64url-encoded 32-byte " +
          "value (43 base64url characters; the final character must be in " +
          `[AEIMQUYcgkosw048]). ${NEW_INVITATION_REMEDY}`,
      ),
    );
  }

  if (expires !== undefined && isExpired(expires, Date.now())) {
    throw markStatesItsOwnNextStep(
      new Error(
        `the shared secret expired at ${expires}. ${NEW_INVITATION_REMEDY}`,
      ),
    );
  }
}

/**
 * Run a P-256 (NNpsk0) authenticated key exchange over an already-open
 * connection, before `runExchange`. Both parties must call it with the same
 * `sharedSecret`, or key confirmation fails and this throws.
 *
 * The secret is checked before any network activity, and expiry again after
 * the handshake (docs/spec/PROTOCOL.md, "Enforcement sites"). Those errors are
 * marked {@link markStatesItsOwnNextStep}; a key-exchange failure is not, its
 * message generic by design.
 *
 * @param conn            An open, ready-to-use connection.
 * @param authentication  The authentication block from the connection
 *                        config. `sharedSecret` must be present.
 * @param handshakeRole   This party's role, matching the role passed to
 *                        subsequent protocol calls.
 * @param requestEncryption  Whether this party requests an application-
 *                        encryption layer, OR'd with the peer's request into
 *                        {@link AuthResult.applyEncryption}
 *                        (docs/spec/CHANNEL_SECURITY.md, "Which channels
 *                        request it").
 *
 * @throws {Error} if `authentication.sharedSecret` is absent or not a
 *                 base64url-encoded 32-byte value, or if
 *                 `authentication.expires` passes before or during the
 *                 handshake.
 * @throws {AuthenticationError} (a `"security"`-kind ConnectionError,
 *                 propagated unwrapped from `runKex`) on a wrong shared secret
 *                 or tampered messages. Consumers classify on the class; the
 *                 message stays generic.
 */
export async function authenticateConnection(
  conn: MessageConnection,
  authentication: Authentication,
  handshakeRole: HandshakeRole,
  requestEncryption: boolean,
): Promise<AuthResult> {
  assertSharedSecretReadyForHandshake(authentication);
  const { sharedSecret, expires } = authentication;

  // SHARED_SECRET_REGEX guarantees `sharedSecret` decodes to exactly 32 bytes.
  const { sessionKey, applyEncryption } = await runKex(
    conn,
    handshakeRole,
    fromBase64Url(sharedSecret),
    requestEncryption,
  );

  // A secret that expired during the key-exchange round-trip.
  if (expires !== undefined && isExpired(expires, Date.now())) {
    throw markStatesItsOwnNextStep(
      new Error(
        `the shared secret expired at ${expires}, during the key exchange. ` +
          NEW_INVITATION_REMEDY,
      ),
    );
  }

  const rotatedSecretBytes = await hkdfDerive(
    sessionKey,
    "alcove-shared-secret-rotation-v2",
    32,
  );
  const rotatedSecret = toBase64Url(rotatedSecretBytes);

  return { sessionKey, rotatedSecret, applyEncryption };
}
