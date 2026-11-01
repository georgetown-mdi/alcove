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
   * hold different secrets, and its record keeps the partner's as its
   * previous secret for the next run to meet them under. A
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
 * store-failure abort ({@link isPartnerNextSecretStoreFailure}) and this side,
 * the initiator, stored the next secret this run (`storedNextSecret`),
 * recording `keptNextSecret`; `error` itself otherwise, so a side that stored
 * nothing reads that reason as any partner abort.
 */
export function withPartnerSecretNotSaved(
  error: unknown,
  role: HandshakeRole,
  storedNextSecret: boolean,
  keptNextSecret: boolean,
): unknown {
  return role === "initiator" &&
    storedNextSecret &&
    isPartnerNextSecretStoreFailure(error)
    ? new PartnerSecretNotSavedError({ cause: error, keptNextSecret })
    : error;
}
