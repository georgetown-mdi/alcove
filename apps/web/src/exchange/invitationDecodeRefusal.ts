import {
  INVITATION_NEWER_REMEDY,
  InvitationDecodeError,
  KeyFoldCollisionError,
  NestingDepthExceededError,
  NodeCountExceededError,
  describeDecodeError,
  isNewerInvitationVersionError,
} from "@alcove/core";
import { ZodError } from "zod";

import type { Displayable } from "@alcove/core";

/**
 * Why the accept route could not open the invitation in its link, shaped by the
 * remedy the acceptor has:
 *
 * - `noToken` -- the link held no invitation; paste one on the start page.
 * - `damaged` -- the string was cut or changed in transit (too short, not
 *   base64url, a checksum mismatch); copy the whole link again or ask for it
 *   again.
 * - `newer` -- a newer version of Alcove made the invitation; updating this
 *   one opens it ({@link NEWER_INVITATION_BODY}).
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
  | { kind: "newer"; detail: Displayable }
  | { kind: "unreadable"; detail: Displayable }
  | { kind: "refused"; message: Displayable };

/** The body of the `newer` refusal: what happened, then the update remedy. */
export const NEWER_INVITATION_BODY =
  "This invitation was made by a newer version of Alcove than this one. " +
  INVITATION_NEWER_REMEDY;

const DAMAGED_FAILURES: ReadonlySet<InvitationDecodeError["failure"]> = new Set(
  ["tooShort", "notBase64Url", "checksumMismatch"],
);

/** Classify an error the accept route's decode threw. */
export function invitationDecodeRefusal(
  error: unknown,
): InvitationDecodeRefusal {
  if (error instanceof InvitationDecodeError)
    return DAMAGED_FAILURES.has(error.failure)
      ? { kind: "damaged", detail: describeDecodeError(error) }
      : { kind: "unreadable", detail: describeDecodeError(error) };
  if (isNewerInvitationVersionError(error))
    return { kind: "newer", detail: describeDecodeError(error) };
  if (
    error instanceof ZodError ||
    error instanceof KeyFoldCollisionError ||
    error instanceof NestingDepthExceededError ||
    error instanceof NodeCountExceededError
  )
    return { kind: "unreadable", detail: describeDecodeError(error) };
  return { kind: "refused", message: describeDecodeError(error) };
}
