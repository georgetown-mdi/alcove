import {
  ConnectionError,
  EncryptedMessageConnection,
  authenticateConnection,
  causeChainSome,
  errorMessage,
  isPartnerProtocolRefusal,
  markStatesItsOwnNextStep,
  statesItsOwnNextStep,
} from "@alcove/core";

import type {
  AuthResult,
  ConnectionErrorKind,
  HandshakeRole,
  MessageConnection,
  RotationHistoryEntry,
} from "@alcove/core";

// ConnectionError kinds that are not a peer-trust problem and pass through
// unchanged; every other handshake failure is re-tagged `security`.
const NON_TRUST_KINDS: ReadonlySet<ConnectionErrorKind> = new Set([
  "transport",
  "closed",
  "usage",
]);

/** What {@link authenticateExchange} hands its caller: the handshake's result
 * and the connection the exchange runs on. */
export interface AuthenticatedExchange extends AuthResult {
  /** The message connection wrapped in core's
   * {@link EncryptedMessageConnection}, so every frame after the key exchange
   * crosses as an AEAD envelope. The caller runs the exchange on it and closes
   * it, never the bare connection beneath it. */
  connection: MessageConnection;
}

/**
 * Run core's P-256 (NNpsk0) authenticated key exchange
 * ({@link authenticateConnection}, shared with the CLI) over the data channel
 * before any PSI frame, requesting application-layer encryption, and wrap the
 * connection in core's {@link EncryptedMessageConnection} keyed from the
 * session key (docs/spec/CHANNEL_SECURITY.md, "Which channels request it"). It
 * neither derives nor stores the next secret: core's terms exchange does both,
 * from the returned `nextSecretInputs`.
 *
 * A trust failure -- a wrong secret, a malformed or expired credential, or a
 * `protocol` error from the peer -- is re-tagged as a `security`
 * {@link ConnectionError}, so the caller shows the authentication-failure
 * alert; a {@link NON_TRUST_KINDS} failure, and the refusal when the two hellos
 * share no version, are re-thrown unchanged. A failure
 * of the wrap itself during the exchange -- a bad tag, a replay, a gap, a
 * malformed envelope -- is a `security` ConnectionError from the returned
 * connection.
 *
 * @param mc            The open message connection.
 * @param exchangeRole  This party's role, the same one passed to `runExchange`.
 * @param sharedSecret  The invitation's base64url shared secret.
 * @param expires       The invitation's `expires` (ISO 8601); core checks it
 *                      before the handshake and again at the terms
 *                      exchange, before each store. Omit when unbounded.
 * @param rotationHistory The verifiers of the secrets this side retired,
 *                      newest first: a managed record's history, empty for a
 *                      one-shot exchange.
 * @returns The {@link AuthenticatedExchange}; both peers derive the same
 *          `sessionKey`.
 * @throws {ConnectionError} of kind `"security"` on a trust failure; of kind
 *         `"usage"` if the handshake returns without the encryption this side
 *         requested; otherwise the original non-trust connection failure or
 *         `PartnerProtocolRefusalError`, unchanged.
 */
export async function authenticateExchange(
  mc: MessageConnection,
  exchangeRole: HandshakeRole,
  sharedSecret: string,
  expires?: string,
  rotationHistory: ReadonlyArray<RotationHistoryEntry> = [],
): Promise<AuthenticatedExchange> {
  let result: AuthResult;
  try {
    // The browser record keeps no previous secret, so none is offered.
    result = await authenticateConnection(
      mc,
      { sharedSecret, expires },
      exchangeRole,
      true,
      { history: rotationHistory },
    );
  } catch (error) {
    // An unrecognized failure is treated as a trust failure: fail closed.
    // The hellos sharing no version is not one: it names the side to update.
    if (hasNonTrustConnectionError(error) || isPartnerProtocolRefusal(error))
      throw error;
    const wrapped = new ConnectionError(errorMessage(error), "security", {
      cause: error,
    });
    // Keep a credential error's own recovery guidance, so no handler adds a
    // second, generic advisory.
    if (hasRecoveryHint(error)) markStatesItsOwnNextStep(wrapped);
    throw wrapped;
  }

  // The decision is the OR of both requests and this side requested, so it is
  // true on every completed handshake; refuse to run the exchange bare if it
  // is not.
  if (!result.applyEncryption)
    throw new ConnectionError(
      "the key exchange completed without the application-layer encryption " +
        "this side requested",
      "usage",
    );
  const connection = await EncryptedMessageConnection.create(
    mc,
    result.sessionKey,
    exchangeRole,
    result.negotiated.envelope,
  );
  return { ...result, connection };
}

/**
 * Whether a {@link NON_TRUST_KINDS} {@link ConnectionError} is anywhere in the
 * `cause` chain; the kex timeout wraps a `transport` error as its cause.
 */
function hasNonTrustConnectionError(error: unknown): boolean {
  return causeChainSome(
    error,
    (link) => link instanceof ConnectionError && NON_TRUST_KINDS.has(link.kind),
  );
}

/** Whether `error` itself states its own next step (core's
 * `statesItsOwnNextStep`), as the credential and expiry errors do: a display
 * layer may show it (sanitized) in place of fixed copy, with no second
 * advisory. */
export function hasRecoveryHint(error: unknown): boolean {
  return statesItsOwnNextStep(error, { ownOnly: true });
}
