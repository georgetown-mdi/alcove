import {
  decodeInvitation,
  isInvitationExpired,
  rawDecodeErrorDescription,
  stripInvitationWhitespace,
  UsageError,
} from "@alcove/core";
import type { InvitationToken } from "@alcove/core";

import { resolveAtSignRefs } from "./util/atSignRefs";

/**
 * Resolve an `@path` reference, strip whitespace a hard-wrapped paste or a
 * wrapped `@`-file leaves inside the token, take the fragment of a web app
 * accept link (see {@link invitationFromAcceptLink}), decode the invitation
 * (verifying the 4-byte checksum and the Zod schema), and reject an expired
 * token by name. All failures raise {@link UsageError} (CLI exit 64).
 *
 * Shared by `accept`'s pre-prompt gate and `exchange --invitation`'s
 * key-file provisioning, so both decode a partner-supplied invitation through
 * one implementation rather than separate copies of a security-sensitive
 * decode path.
 */
export async function decodeAndValidateInvitation(
  rawArg: string,
): Promise<InvitationToken> {
  let encoded: unknown;
  try {
    encoded = resolveAtSignRefs(rawArg);
  } catch (err) {
    throw new UsageError(
      `could not read invitation from ${rawArg}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (typeof encoded !== "string")
    throw new UsageError("invitation must be a string");

  let token: InvitationToken;
  try {
    token = await decodeInvitation(
      invitationFromAcceptLink(stripInvitationWhitespace(encoded)),
    );
  } catch (err) {
    throw new UsageError(
      "invalid invitation: " + rawDecodeErrorDescription(err),
    );
  }

  if (isInvitationExpired(token.expires))
    throw new UsageError(
      `invitation expired at ${token.expires}; ask your partner for a new ` +
        "invitation",
    );

  return token;
}

/**
 * The invitation in a web app accept link, `<origin>/accept#<invitation>`: an
 * http(s) URL yields its fragment, which may be empty and is then refused by
 * the decode like any malformed invitation. Nothing else of the URL is used.
 * Any other value is returned unchanged.
 *
 * @internal exported for testing
 */
export function invitationFromAcceptLink(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return value;
  return url.hash.slice(1);
}
