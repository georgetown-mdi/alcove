import {
  InvitationDecodeError,
  NestingDepthExceededError,
  NodeCountExceededError,
  describeDecodeError,
} from "@alcove/core";

import type { Displayable } from "@alcove/core";

/**
 * Why the accept route could not open the invitation in its link, shaped by the
 * remedy the acceptor has:
 *
 * - `noToken` -- the link held no invitation; paste one on the start page.
 * - `damaged` -- the string was cut or changed in transit (too short, not
 *   base64url, a checksum mismatch); copy the whole link again or ask for it
 *   again.
 * - `unreadable` -- the string arrived intact but is not an invitation this
 *   build reads; only a new one from the partner helps.
 * - `refused` -- a readable invitation this page will not run (expired, an
 *   endpoint it cannot drive, terms it refuses), whose message already states
 *   what to do.
 *
 * `detail` is the decoder's own description, shown behind a disclosure.
 */
export type InvitationDecodeRefusal =
  | { kind: "noToken" }
  | { kind: "damaged"; detail: Displayable }
  | { kind: "unreadable"; detail: Displayable }
  | { kind: "refused"; message: Displayable };

const DAMAGED_FAILURES: ReadonlySet<InvitationDecodeError["failure"]> = new Set(
  ["tooShort", "notBase64Url", "checksumMismatch"],
);

function isSchemaFailure(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "issues" in error &&
    Array.isArray(error.issues)
  );
}

/** Classify an error the accept route's decode threw. */
export function invitationDecodeRefusal(
  error: unknown,
): InvitationDecodeRefusal {
  if (error instanceof InvitationDecodeError)
    return DAMAGED_FAILURES.has(error.failure)
      ? { kind: "damaged", detail: describeDecodeError(error) }
      : { kind: "unreadable", detail: describeDecodeError(error) };
  if (
    isSchemaFailure(error) ||
    error instanceof NestingDepthExceededError ||
    error instanceof NodeCountExceededError
  )
    return { kind: "unreadable", detail: describeDecodeError(error) };
  return { kind: "refused", message: describeDecodeError(error) };
}
