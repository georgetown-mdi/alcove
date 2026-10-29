/**
 * The failure a browser initiator reports in place of its partner's abort
 * stating that the partner could not save the next shared secret
 * (docs/spec/PROTOCOL.md, "The rotation at the terms exchange"). The one-shot
 * exchange and a managed run both raise it, so each surface reads one class,
 * and it records whether this side kept the next secret, which decides what
 * the failure left behind.
 */

import { isPartnerNextSecretStoreFailure } from "@alcove/core";

import type { HandshakeRole } from "@alcove/core";

/**
 * The partner could not save the next shared secret. Its message is this
 * application's own; the abort it replaces is its `cause`, and the partner's
 * text is never read, only matched against core's fixed reason.
 */
export class PartnerSecretNotSavedError extends Error {
  /** Whether this side saved the next secret where a later run reads it. A
   * managed run saves it before the partner's abort can arrive, so the two now
   * hold different secrets and only a fresh invitation reconnects them. A
   * one-shot exchange keeps nothing past the run, so both still hold the
   * invitation's secret. */
  readonly keptNextSecret: boolean;

  constructor(options: { cause: unknown; keptNextSecret: boolean }) {
    super(
      options.keptNextSecret
        ? "the partner could not save the next shared secret this side saved"
        : "the partner could not save the next shared secret",
      { cause: options.cause },
    );
    this.name = "PartnerSecretNotSavedError";
    this.keptNextSecret = options.keptNextSecret;
  }
}

/**
 * `error` as a {@link PartnerSecretNotSavedError} where it is the partner's
 * store-failure abort ({@link isPartnerNextSecretStoreFailure}) read by this
 * side as the initiator, recording `keptNextSecret`; `error` itself otherwise,
 * so any other failure reports as it does without this.
 */
export function withPartnerSecretNotSaved(
  error: unknown,
  role: HandshakeRole,
  keptNextSecret: boolean,
): unknown {
  return role === "initiator" && isPartnerNextSecretStoreFailure(error)
    ? new PartnerSecretNotSavedError({ cause: error, keptNextSecret })
    : error;
}
