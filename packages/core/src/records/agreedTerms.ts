import { z } from "zod";

import { carriedLinkageTermsSchema } from "./signedReceipt.js";

import type { LinkageTerms } from "../config/linkageTermsSchema.js";

// The agreed-terms file: both parties' linkage terms as this party's run held
// them when it computed the record's agreed-terms hash, kept beside the record
// so a holder re-derives that hash with no file from the partner. Format and
// placement: docs/spec/EXCHANGE_RECORD.md ("Agreed-terms file").

/** The one recognized format version for an {@link AgreedTerms} file. */
export const AGREED_TERMS_VERSION = "alcove-agreed-terms-file/v1";

/**
 * The two linkage-terms documents an exchange record's `termsHash` is
 * computed over, exactly as the run passed them to `computeTermsHash`.
 * Unsigned and self-attested like the record: a verifier re-hashes them and
 * compares, so terms that do not belong to the record report a mismatch.
 */
export interface AgreedTerms {
  version: typeof AGREED_TERMS_VERSION;
  /** The terms this party stated at the terms exchange. */
  localTerms: LinkageTerms;
  /** The terms the partner stated at the terms exchange. */
  partnerTerms: LinkageTerms;
}

// Both halves are read through the bounded schema a receipt's carried copy
// takes: the file sits beside a record that may have come from anyone.
const AgreedTermsSchema: z.ZodType<AgreedTerms> = z.object({
  version: z.literal(AGREED_TERMS_VERSION),
  localTerms: carriedLinkageTermsSchema,
  partnerTerms: carriedLinkageTermsSchema,
});

/** Serialize {@link AgreedTerms} to its on-disk form: pretty JSON with a
 * trailing newline, as the record itself is written. */
export function serializeAgreedTerms(terms: AgreedTerms): string {
  return JSON.stringify(terms, null, 2) + "\n";
}

/**
 * Parse and validate {@link AgreedTerms} from a raw value. Rejects an
 * unrecognized `version` rather than migrating it.
 *
 * @throws {z.ZodError} if validation fails.
 */
export function parseAgreedTerms(raw: unknown): AgreedTerms {
  return AgreedTermsSchema.parse(raw);
}
