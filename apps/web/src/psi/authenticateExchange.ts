import {
  ConnectionError,
  authenticateConnection,
  causeChainSome,
  errorMessage,
  markStatesItsOwnNextStep,
  statesItsOwnNextStep,
} from "@alcove/core";

import type {
  AuthResult,
  ConnectionErrorKind,
  HandshakeRole,
  MessageConnection,
} from "@alcove/core";

// ConnectionError kinds that are not a peer-trust problem and pass through
// unchanged; every other handshake failure is re-tagged `security`.
const NON_TRUST_KINDS: ReadonlySet<ConnectionErrorKind> = new Set([
  "transport",
  "closed",
  "usage",
]);

/**
 * Run core's P-256 (NNpsk0) authenticated key exchange
 * ({@link authenticateConnection}, shared with the CLI) over the data channel
 * before any PSI frame. It requests no application-layer encryption, since
 * DTLS already covers the channel (docs/SECURITY_DESIGN.md, "Channel
 * security"). It neither persists nor rotates the returned secret.
 *
 * A trust failure -- a wrong secret, a malformed or expired credential, or a
 * `protocol` error from the peer -- is re-tagged as a `security`
 * {@link ConnectionError}, so the caller shows the authentication-failure
 * alert; a {@link NON_TRUST_KINDS} failure is re-thrown unchanged.
 *
 * @param mc            The open message connection.
 * @param exchangeRole  This party's role, the same one passed to `runExchange`.
 * @param sharedSecret  The invitation's base64url shared secret.
 * @param expires       The invitation's `expires` (ISO 8601); core checks it
 *                      before and after the handshake. Omit when unbounded.
 * @returns The {@link AuthResult}; both peers derive the same `sessionKey`.
 * @throws {ConnectionError} of kind `"security"` on a trust failure; of kind
 *         `"usage"` if the peer negotiates encryption the web path does not yet
 *         apply; otherwise the original non-trust connection failure, unchanged.
 */
export async function authenticateExchange(
  mc: MessageConnection,
  exchangeRole: HandshakeRole,
  sharedSecret: string,
  expires?: string,
): Promise<AuthResult> {
  let result: AuthResult;
  try {
    result = await authenticateConnection(
      mc,
      { sharedSecret, expires },
      exchangeRole,
      false,
    );
  } catch (error) {
    // An unrecognized failure is treated as a trust failure: fail closed.
    if (hasNonTrustConnectionError(error)) throw error;
    const wrapped = new ConnectionError(errorMessage(error), "security", {
      cause: error,
    });
    // Keep a credential error's own recovery guidance, so no handler adds a
    // second, generic advisory.
    if (hasRecoveryHint(error)) markStatesItsOwnNextStep(wrapped);
    throw wrapped;
  }

  // The web path does not apply the application AEAD, so a peer requesting it
  // would diverge from this cleartext run. Only a peer that completed the
  // handshake can set this, so it never fires for an unauthenticated peer;
  // `usage` routes to the generic alert, as a capability mismatch.
  if (result.applyEncryption)
    throw new ConnectionError(
      "the peer requested application-layer encryption, which the web " +
        "exchange does not yet apply",
      "usage",
    );
  return result;
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
