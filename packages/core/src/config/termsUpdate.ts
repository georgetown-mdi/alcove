import { z } from "zod";

import { UsageError } from "../errors.js";
import {
  JsonStructureBoundError,
  parseBoundedJson,
} from "../utils/boundedJson.js";
import {
  bytesEqual,
  enc,
  fromBase64Url,
  hkdfDerive,
  hmacSha256,
  toBase64Url,
} from "../utils/crypto.js";
import { SHARED_SECRET_REGEX } from "./connection.js";
import {
  InvitationLinkageTermsSchema,
  MAX_ENCODED_INVITATION_LENGTH,
} from "./invitation.js";
import type { LinkageTerms } from "./linkageTermsSchema.js";
import type { Metadata } from "./metadata.js";
import { termsStatingDeclaredPayloadSend } from "../payloadExchange.js";

// --- Terms update ------------------------------------------------------------

/**
 * A change to an established partnership's linkage terms, sent by the party
 * that made it to the party that applies it. It holds the sending party's
 * linkage terms and nothing else: no shared secret, no
 * credential, no connection endpoint, and no expiry. It is authenticated under
 * the shared secret both parties already hold (docs/spec/EXCHANGE_FILE.md,
 * "Terms update").
 */
export interface TermsUpdate {
  /**
   * The sending party's own linkage terms, in the form an invitation states
   * them: the applying party derives its own side with
   * `deriveAcceptedLinkageTerms`, as an acceptance does.
   */
  linkageTerms: LinkageTerms;
}

/**
 * The {@link TermsUpdate} a party's configuration makes: its linkage terms
 * with `payload.send` stated from `metadata` as the terms exchange states it
 * (`termsStatingDeclaredPayloadSend`). Without metadata the terms are taken as
 * written.
 */
export function termsUpdateFor(
  linkageTerms: LinkageTerms,
  metadata: Metadata | undefined,
): TermsUpdate {
  if (metadata === undefined) return { linkageTerms };
  return {
    linkageTerms: termsStatingDeclaredPayloadSend(linkageTerms, metadata),
  };
}

/** The `kind` a terms update's body states. */
const TERMS_UPDATE_KIND = "terms-update";

/** The format `version` a terms update's body states. */
const TERMS_UPDATE_VERSION = "1";

/**
 * The HKDF info strings a terms update derives from the shared secret, one
 * per use; a family in the domain-separation label space
 * (docs/spec/PROTOCOL.md). Frozen so the label set cannot widen at run time.
 */
export const TERMS_UPDATE_DERIVATIONS = Object.freeze([
  "partnership",
  "mac",
] as const);

type TermsUpdateDerivation = (typeof TERMS_UPDATE_DERIVATIONS)[number];

const TERMS_UPDATE_LABEL_PREFIX = "alcove-terms-update-v2:";

/** Bytes of the partnership identifier, before base64url encoding. */
const PARTNERSHIP_ID_BYTES = 16;

/** Bytes of the MAC: a whole HMAC-SHA-256 tag. */
const MAC_BYTES = 32;

/**
 * Bound on an encoded terms update, checked before any decoding work. A
 * terms update holds an invitation's terms, less the secret and endpoint, so
 * the invitation's bound covers it.
 */
export const MAX_ENCODED_TERMS_UPDATE_LENGTH = MAX_ENCODED_INVITATION_LENGTH;

const TermsUpdateBodySchema = z.strictObject({
  kind: z.literal(TERMS_UPDATE_KIND),
  version: z.literal(TERMS_UPDATE_VERSION),
  partnership: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  linkageTerms: InvitationLinkageTermsSchema,
});

/**
 * Which check refused a terms update:
 *
 * - `format`: the text is not a well-formed terms update.
 * - `partnership`: it was made under a different shared secret than the one
 *   given -- another partnership, or a secret one party has since replaced.
 * - `authentication`: it names this partnership, but its MAC does not verify,
 *   so it was altered after it was made.
 */
export type TermsUpdateCheck = "format" | "partnership" | "authentication";

/**
 * A terms update refused at decode. {@link check} names which check refused
 * it; the message states the reason in terms a caller may show as they are.
 */
export class TermsUpdateRefusedError extends UsageError {
  /** The check that refused the update. */
  readonly check: TermsUpdateCheck;

  constructor(check: TermsUpdateCheck, message: string) {
    super(message);
    this.name = "TermsUpdateRefusedError";
    this.check = check;
  }
}

async function deriveFromSecret(
  sharedSecret: string,
  derivation: TermsUpdateDerivation,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!SHARED_SECRET_REGEX.test(sharedSecret))
    throw new UsageError(
      "the shared secret is not a base64url-encoded 32-byte value",
    );
  return hkdfDerive(
    fromBase64Url(sharedSecret),
    `${TERMS_UPDATE_LABEL_PREFIX}${derivation}`,
    length,
  );
}

/**
 * The partnership identifier a terms update states: a one-way derivation of
 * the shared secret, so both parties compute it from the key file they hold
 * and it reveals nothing about the secret. It follows the secret, so a
 * rotation gives the partnership a new identifier.
 *
 * @throws {UsageError} if `sharedSecret` is not a valid shared secret.
 */
export async function termsUpdatePartnership(
  sharedSecret: string,
): Promise<string> {
  return toBase64Url(
    await deriveFromSecret(sharedSecret, "partnership", PARTNERSHIP_ID_BYTES),
  );
}

async function termsUpdateMac(
  sharedSecret: string,
  body: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return hmacSha256(
    await deriveFromSecret(sharedSecret, "mac", MAC_BYTES),
    body,
  );
}

/**
 * Encode a {@link TermsUpdate} under `sharedSecret`: the base64url JSON body,
 * a `.`, and the base64url HMAC-SHA-256 of the body bytes under a key derived
 * from the secret. The body is validated against the same schema
 * {@link decodeTermsUpdate} applies, so nothing is encoded that a decoder
 * would refuse.
 *
 * @throws {UsageError} if `sharedSecret` is not a valid shared secret or the
 *   encoded update exceeds {@link MAX_ENCODED_TERMS_UPDATE_LENGTH}.
 * @throws {ZodError} if the update fails the schema.
 */
export async function encodeTermsUpdate(
  update: TermsUpdate,
  sharedSecret: string,
): Promise<string> {
  const body = TermsUpdateBodySchema.parse({
    kind: TERMS_UPDATE_KIND,
    version: TERMS_UPDATE_VERSION,
    partnership: await termsUpdatePartnership(sharedSecret),
    linkageTerms: update.linkageTerms,
  });
  const bytes = enc.encode(JSON.stringify(body));
  const encoded = `${toBase64Url(bytes)}.${toBase64Url(
    await termsUpdateMac(sharedSecret, bytes),
  )}`;
  if (encoded.length > MAX_ENCODED_TERMS_UPDATE_LENGTH)
    throw new UsageError(
      "the terms update is longer than the " +
        `${MAX_ENCODED_TERMS_UPDATE_LENGTH} characters a terms update may be`,
    );
  return encoded;
}

function refusedFormat(reason: string): TermsUpdateRefusedError {
  return new TermsUpdateRefusedError(
    "format",
    `this is not an Alcove terms update: ${reason}`,
  );
}

/**
 * The partnership identifier an unauthenticated body states, or `undefined`
 * where it states none that could be read. Used only to choose which refusal
 * names a body whose MAC failed.
 */
function statedPartnership(body: Uint8Array<ArrayBuffer>): string | undefined {
  try {
    const parsed = parseBoundedJson(body);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const stated = (parsed as Record<string, unknown>)["partnership"];
    return typeof stated === "string" ? stated : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether an authenticated body states the terms update `kind` under a
 * format `version` above the one this build reads. Called only after the MAC
 * verifies, so only a holder of the shared secret can have made the claim.
 */
function statesNewerVersion(json: unknown): boolean {
  if (typeof json !== "object" || json === null) return false;
  const { kind, version } = json as Record<string, unknown>;
  return (
    kind === TERMS_UPDATE_KIND &&
    typeof version === "string" &&
    /^[1-9][0-9]{0,8}$/.test(version) &&
    Number(version) > Number(TERMS_UPDATE_VERSION)
  );
}

/**
 * Decode and verify a terms update against the shared secret this party
 * holds. The MAC is verified over the body bytes before the body is
 * validated or returned; a body whose MAC fails is read only far enough to
 * tell a different partnership from an altered update.
 *
 * `encoded` is taken as given; strip a hard-wrapped paste's whitespace first
 * (`stripInvitationWhitespace`).
 *
 * @throws {TermsUpdateRefusedError} naming the check that refused it.
 * @throws {UsageError} if `sharedSecret` is not a valid shared secret.
 */
export async function decodeTermsUpdate(
  encoded: string,
  sharedSecret: string,
): Promise<TermsUpdate> {
  if (encoded.length > MAX_ENCODED_TERMS_UPDATE_LENGTH)
    throw refusedFormat(
      `it is longer than the ${MAX_ENCODED_TERMS_UPDATE_LENGTH} characters ` +
        "a terms update may be",
    );
  const parts = encoded.split(".");
  if (parts.length !== 2)
    throw refusedFormat("it does not have the form BODY.MAC");
  if (encoded.includes("="))
    throw refusedFormat(
      'it holds "=" padding, which a terms update never has; paste the ' +
        "update exactly as your partner sent it",
    );
  let body: Uint8Array<ArrayBuffer>;
  let mac: Uint8Array<ArrayBuffer>;
  try {
    body = fromBase64Url(parts[0] as string);
    mac = fromBase64Url(parts[1] as string);
  } catch {
    throw refusedFormat("it is not valid base64url");
  }
  if (mac.length !== MAC_BYTES)
    throw refusedFormat(`its MAC is not ${MAC_BYTES} bytes`);

  const partnership = await termsUpdatePartnership(sharedSecret);
  if (!bytesEqual(mac, await termsUpdateMac(sharedSecret, body))) {
    const stated = statedPartnership(body);
    if (stated !== undefined && stated !== partnership)
      throw new TermsUpdateRefusedError(
        "partnership",
        "this terms update was made for a different partnership: it was " +
          "made under a shared secret other than the one in your key file",
      );
    throw new TermsUpdateRefusedError(
      "authentication",
      "this terms update's MAC does not verify: its content was changed " +
        "after it was made",
    );
  }

  let json: unknown;
  try {
    json = parseBoundedJson(body);
  } catch (err) {
    if (
      err instanceof SyntaxError ||
      err instanceof TypeError ||
      err instanceof JsonStructureBoundError
    )
      throw refusedFormat("its content is not valid JSON");
    throw err;
  }
  let parsed: z.infer<typeof TermsUpdateBodySchema>;
  try {
    parsed = TermsUpdateBodySchema.parse(json);
  } catch (err) {
    if (!(err instanceof z.ZodError)) throw err;
    if (statesNewerVersion(json))
      throw new TermsUpdateRefusedError(
        "format",
        "this terms update was made by a newer version of Alcove than this " +
          "one; update Alcove, then try the terms update again",
      );
    throw refusedFormat("its content does not match the terms update format");
  }
  if (parsed.partnership !== partnership)
    throw new TermsUpdateRefusedError(
      "partnership",
      "this terms update names a different partnership than the shared " +
        "secret it was authenticated under",
    );
  return { linkageTerms: parsed.linkageTerms };
}
