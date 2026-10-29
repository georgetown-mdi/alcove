/**
 * The failure a browser initiator reports in place of its partner's abort
 * stating that the partner could not save the next shared secret, once this
 * side has stored it: the two parties then hold different secrets, and only a
 * fresh invitation reconnects them (docs/spec/PROTOCOL.md, "The rotation at
 * the terms exchange"). The one-shot exchange and a managed run both raise it,
 * so each surface reads one class.
 */

import { isPartnerNextSecretStoreFailure } from "@alcove/core";

import type { HandshakeRole } from "@alcove/core";

/**
 * The partner could not save the next shared secret this side stored. Its
 * message is this application's own; the abort it replaces is its `cause`,
 * and the partner's text is never read, only matched against core's fixed
 * reason.
 */
export class PartnerSecretNotSavedError extends Error {
  constructor(options: { cause: unknown }) {
    super(
      "the partner could not save the next shared secret this side saved",
      options,
    );
    this.name = "PartnerSecretNotSavedError";
  }
}

/**
 * `error` as a {@link PartnerSecretNotSavedError} where it is the partner's
 * store-failure abort ({@link isPartnerNextSecretStoreFailure}) and this side,
 * the initiator, stored the next secret this run; `error` itself otherwise, so
 * any other failure reports as it does without this.
 */
export function withPartnerSecretNotSaved(
  error: unknown,
  role: HandshakeRole,
  storedNextSecret: boolean,
): unknown {
  return role === "initiator" &&
    storedNextSecret &&
    isPartnerNextSecretStoreFailure(error)
    ? new PartnerSecretNotSavedError({ cause: error })
    : error;
}
