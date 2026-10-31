import { hkdfDerive, fromBase64Url } from "./utils/crypto.js";
import { runKex, supportedVersions } from "./kex.js";
import type { NegotiatedVersions, SupportedVersions } from "./versionHello.js";

import type { HandshakeRole } from "./types.js";
import type { NextSecretInputs } from "./nextSecret.js";
import {
  ROTATION_HISTORY_MAX_ENTRIES,
  type RotationHistoryEntry,
} from "./rotationHistory.js";
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
   * The caller passes it to {@link deriveAeadKey} for the application-layer
   * encryption the handshake negotiated.
   */
  sessionKey: Uint8Array<ArrayBuffer>;
  /**
   * What the terms exchange derives the next shared secret from. The caller
   * passes it to `runExchange` as `rotation.inputs`, beside the write that
   * stores the next secret, which the terms exchange awaits at this side's
   * point in the store order (docs/spec/PROTOCOL.md, "Shared-secret
   * rotation").
   */
  nextSecretInputs: NextSecretInputs;
  /**
   * Whether to wrap the connection in an application-encryption layer
   * ({@link KexResult.applyEncryption}): the transcript-bound OR of both
   * parties' requests. When `true` the caller applies {@link deriveAeadKey}
   * and an `EncryptedMessageConnection` wrap.
   */
  applyEncryption: boolean;
  /**
   * Which of its secrets each side completed the handshake under. A side that
   * completed under its previous secret, or whose partner did, is in a heal
   * run, which both sides report (docs/spec/PROTOCOL.md, "Which secret a
   * handshake uses").
   */
  secretUsed: {
    local: HandshakeSecretKind;
    partner: HandshakeSecretKind;
  };
  /**
   * The version both hellos selected in each layer. The caller passes this
   * result to `EncryptedMessageConnection.create`, which keys the channel at
   * `envelope`; `nextSecretInputs` holds `protocol`, which the terms exchange
   * reads from the run's rotation (docs/spec/PROTOCOL.md, "The version hello").
   */
  negotiated: NegotiatedVersions;
}

/** The secret a side completed a handshake under. */
export type HandshakeSecretKind = "current" | "previous";

/**
 * What a side holds besides its current secret: the previous secret it keeps
 * until the partner confirms the next one, and its rotation history
 * (docs/spec/PROTOCOL.md, "Which secret a handshake uses" and "The rotation
 * history").
 */
export interface RotationState {
  /** The previous secret and its own `expires`; omitted when none is held. */
  previous?: { sharedSecret: string; expires?: string };
  /** The verifiers of the secrets this side retired, newest first. */
  history: ReadonlyArray<RotationHistoryEntry>;
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
 * The byte length of every abort token {@link deriveAbortToken} returns, which
 * fixes the byte count an abort marker's name states.
 */
export const ABORT_TOKEN_BYTES = 32;

/**
 * Derive a 32-byte per-direction abort token from the session key using HKDF,
 * authenticating the cross-party abort marker (`<writerId>-abort-<n>.json`;
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
  return hkdfDerive(
    sessionKey,
    `alcove-abort-token-v2:${role}`,
    ABORT_TOKEN_BYTES,
  );
}

/**
 * Whether an ISO 8601 `expires` is at or before `now`. An unparseable value,
 * from a caller that bypassed key-file validation, counts as expired.
 */
export function isExpired(expires: string, now: number): boolean {
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
 * The secret is checked before any network activity; its expiry is checked
 * again in the terms exchange, before each side's store
 * (docs/spec/PROTOCOL.md, "Enforcement sites"). Those errors are marked
 * {@link markStatesItsOwnNextStep}; a key-exchange failure is not, its
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
 * @param rotationState   The previous secret, if this side holds one, and its
 *                        rotation history. A previous secret whose `expires`
 *                        has passed, or equal to the current one, is not
 *                        offered; a history entry whose `expires` has passed
 *                        is not checked, and only the
 *                        {@link ROTATION_HISTORY_MAX_ENTRIES} newest are.
 * @param supported       The versions this side's hello offers. The FIPS
 *                        variant passes `supportedVersions({
 *                        approvedKexSuitesOnly: true })`.
 *
 * @throws {PartnerProtocolRefusalError} before the key exchange completes,
 *                 when the two hellos share no version in some layer.
 * @throws {Error} if `authentication.sharedSecret` is absent or not a
 *                 base64url-encoded 32-byte value, or if
 *                 `authentication.expires` has passed.
 * @throws {InternalConsistencyError} if the previous secret or a history
 *                 verifier is not a base64url-encoded 32-byte value.
 * @throws {AuthenticationError} (a `"security"`-kind ConnectionError,
 *                 propagated unwrapped from `runKex`) on a wrong shared secret
 *                 or tampered messages. Consumers classify on the class; the
 *                 message stays generic, except for the two subclasses that
 *                 name an older copy: {@link PartnerCopyBehindError} and
 *                 {@link LocalCopyBehindError}.
 */
export async function authenticateConnection(
  conn: MessageConnection,
  authentication: Authentication,
  handshakeRole: HandshakeRole,
  requestEncryption: boolean,
  rotationState: RotationState,
  supported: SupportedVersions = supportedVersions(),
): Promise<AuthResult> {
  assertSharedSecretReadyForHandshake(authentication);
  const { sharedSecret, expires } = authentication;
  const now = Date.now();

  const offeredPrevious = offerablePrevious(
    rotationState.previous,
    sharedSecret,
    now,
  );
  // An expired entry keeps its place, so each later position still counts
  // rotations.
  const history = rotationState.history
    .slice(0, ROTATION_HISTORY_MAX_ENTRIES)
    .map((entry) => {
      if (!SHARED_SECRET_REGEX.test(entry.verifier))
        throw new InternalConsistencyError(
          "authenticateConnection: a rotation history verifier is not a " +
            "base64url-encoded 32-byte value",
        );
      return entry.expires !== undefined && isExpired(entry.expires, now)
        ? undefined
        : fromBase64Url(entry.verifier);
    });

  // SHARED_SECRET_REGEX guarantees each secret decodes to exactly 32 bytes.
  const {
    sessionKey,
    applyEncryption,
    keyAgreementOutput,
    initiatorValue,
    localUsedPrevious,
    partnerUsedPrevious,
    negotiated,
  } = await runKex(
    conn,
    handshakeRole,
    fromBase64Url(sharedSecret),
    requestEncryption,
    {
      ...(offeredPrevious !== undefined && {
        previous: fromBase64Url(offeredPrevious.sharedSecret),
      }),
      history,
    },
    supported,
  );

  return {
    sessionKey,
    applyEncryption,
    negotiated,
    nextSecretInputs: {
      negotiatedProtocolVersion: negotiated.protocol,
      sessionKey,
      keyAgreementOutput,
      initiatorValue,
      expires: localUsedPrevious ? offeredPrevious?.expires : expires,
    },
    secretUsed: {
      local: localUsedPrevious ? "previous" : "current",
      partner: partnerUsedPrevious ? "previous" : "current",
    },
  };
}

// The previous secret the handshake offers: none when it has expired or is the
// current secret itself.
function offerablePrevious(
  previous: RotationState["previous"],
  currentSecret: string,
  now: number,
): RotationState["previous"] {
  if (previous === undefined) return undefined;
  if (!SHARED_SECRET_REGEX.test(previous.sharedSecret))
    throw new InternalConsistencyError(
      "authenticateConnection: the previous shared secret is not a " +
        "base64url-encoded 32-byte value",
    );
  if (previous.sharedSecret === currentSecret) return undefined;
  if (previous.expires !== undefined && isExpired(previous.expires, now))
    return undefined;
  return previous;
}
