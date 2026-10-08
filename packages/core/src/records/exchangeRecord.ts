import { z } from "zod";
import { maxCodeUnits } from "../utils/maxCodeUnits.js";

import {
  canonicalBytes,
  canonicalString,
  safeIntegerSchema,
} from "../utils/canonical.js";
import { canonicalHmacSha256 } from "../utils/canonicalHmac.js";
import {
  bytesEqual,
  fromBase64Url,
  randomBytes,
  sha256,
  toBase64Url,
} from "../utils/crypto.js";
import { AlgorithmSchema } from "../types.js";
import {
  MAX_LINKAGE_ENTRIES,
  MAX_NAME_LENGTH,
  MAX_PAYLOAD_ENTRIES,
  MAX_TEXT_LENGTH,
} from "../config/linkageTermsSchema.js";
import { checkLinkageRuleSetCitation } from "../defaults/builtInLinkageTerms.js";
import { chainDetailCauses } from "../errors.js";
import { termsResolvingPayloadReceive } from "../config/recurringTerms.js";
import { boundedArray } from "../utils/boundedArray.js";
import { redactPrivateKeyMaterial } from "../utils/sanitizeErrorForDisplay.js";
import {
  LINKAGE_CARDINALITIES,
  resolvedMatchingFromTerms,
} from "../linkageTermsPolicy.js";

import { AGREED_TERMS_VERSION } from "./agreedTerms.js";

import type { AgreedTerms } from "./agreedTerms.js";
import type { CanonicalValue } from "../utils/canonical.js";
import type { LinkageTerms } from "../config/linkageTermsSchema.js";
import type { ResolvedMatching } from "../linkageTermsPolicy.js";
import type { Algorithm, AssociationTable } from "../types.js";

// The exchange record: a self-attested, unsigned disclosure-log entry each
// party writes once the exchange has disclosed. It contains governance metadata
// and commitments only, never a payload, linkage-field, or matched-identifier
// value. Format: docs/spec/EXCHANGE_RECORD.md; encoding:
// docs/spec/CANONICAL_ENCODING.md.

// --- Versions ----------------------------------------------------------------

/**
 * The one recognized format version for an {@link ExchangeRecord}; a reader
 * rejects any other. It moves with the field set and with the bytes a field
 * is computed over. See docs/spec/EXCHANGE_RECORD.md#record-fields.
 */
export const EXCHANGE_RECORD_VERSION = "alcove-exchange-record/v10";

/** The one recognized format version for v2 {@link VerificationKeys}. */
export const EXCHANGE_KEYS_VERSION = "alcove-exchange-keys/v2";

// --- Commitment scheme -------------------------------------------------------

/** Byte length of every commitment salt and of the binding nonce. */
export const SALT_BYTES = 32;

/** The data sets a record commits to, each the key its commitment and salt
 * are stored under. */
export type CommitmentName =
  "associationTable" | "localPayloadSent" | "partnerPayloadReceived";

// Folded into the committed message, so a commitment of one kind never
// verifies as another under the same salt and data. See
// docs/spec/EXCHANGE_RECORD.md#commitment-scheme.
const COMMITMENT_DOMAINS: Record<CommitmentName, string> = {
  associationTable: "alcove-commit-association-table/v2",
  localPayloadSent: "alcove-commit-payload-sent/v2",
  partnerPayloadReceived: "alcove-commit-payload-received/v2",
};

const AGREED_TERMS_DOMAIN = "alcove-agreed-terms/v3";

// computeCommitment, verifyCommitmentOpening and computeTermsHash stay
// exported: an independent implementation reproducing a record
// (test/vectors/exchange-record-vectors.json) recomputes them directly.

/**
 * The commitment to `data` of the given kind under `salt`. `data` is in the
 * canonical value domain, binary already base64url-encoded. See
 * docs/spec/EXCHANGE_RECORD.md#commitment-scheme.
 */
export async function computeCommitment(
  name: CommitmentName,
  salt: Uint8Array<ArrayBuffer>,
  data: CanonicalValue,
): Promise<Uint8Array<ArrayBuffer>> {
  return canonicalHmacSha256(salt, { domain: COMMITMENT_DOMAINS[name], data });
}

/**
 * Whether `salt` and the re-supplied `data` open `expectedValue`, compared in
 * constant time. The caller must reproduce the exact canonical bytes the
 * commitment was computed over. Never throws: malformed base64url or
 * non-canonical `data` is `false`, so it is safe on an untrusted record.
 */
export async function verifyCommitmentOpening(
  name: CommitmentName,
  salt: string,
  data: CanonicalValue,
  expectedValue: string,
): Promise<boolean> {
  try {
    const expected = fromBase64Url(expectedValue);
    const saltBytes = fromBase64Url(salt);
    const actual = await computeCommitment(name, saltBytes, data);
    return bytesEqual(actual, expected);
  } catch {
    return false;
  }
}

// --- Agreed-terms hash -------------------------------------------------------

/**
 * Both parties' terms in one order, by UTF-16 code unit comparison of their
 * canonical encodings, so either side derives the same value.
 */
function agreedTermsValue(a: LinkageTerms, b: LinkageTerms): CanonicalValue {
  // canonicalString throws CanonicalEncodingError on a value outside the
  // canonical domain; the cast only bridges the static type.
  const ca = canonicalString(a as unknown as CanonicalValue);
  const cb = canonicalString(b as unknown as CanonicalValue);
  const ordered = ca <= cb ? [a, b] : [b, a];
  return {
    domain: AGREED_TERMS_DOMAIN,
    terms: ordered as unknown as CanonicalValue,
  };
}

/**
 * The agreed-terms hash: base64url SHA-256 over both parties' terms in
 * canonical order, each side's unset `payload.receive` first resolved to the
 * other's send set ({@link termsResolvingPayloadReceive}).
 * See docs/spec/EXCHANGE_RECORD.md#the-agreed-terms-hash.
 */
export async function computeTermsHash(
  localTerms: LinkageTerms,
  partnerTerms: LinkageTerms,
): Promise<string> {
  const digest = await sha256(
    canonicalBytes(
      agreedTermsValue(
        termsResolvingPayloadReceive(localTerms, partnerTerms),
        termsResolvingPayloadReceive(partnerTerms, localTerms),
      ),
    ),
  );
  return toBase64Url(digest);
}

// --- Record and verification-keys types --------------------------------------

/** Base64url commitments by {@link CommitmentName}; `associationTable` only
 * when this party has the table. */
interface ExchangeRecordCommitments {
  localPayloadSent: string;
  partnerPayloadReceived: string;
  associationTable?: string;
}

/** One payload column as a disclosure category: name and description, never
 * values. The record format's own type, so a config change cannot move it. */
interface RecordPayloadColumn {
  name: string;
  /** Data-dictionary description; not cross-party validated, so the two
   * records may differ here. */
  description?: string;
}

/** The governing data-sharing agreement, copied from the agreed terms, where
 * both parties' values must match. */
interface RecordLegalAgreement {
  /** Human-readable agreement identifier (e.g. "MOU-2025-0042"). */
  reference: string;
  /** The purpose of the disclosure under the agreement. */
  purpose: string;
  /** Last date the agreement authorizes an exchange (`YYYY-MM-DD`). */
  expirationDate: string;
}

/** One linkage field in the matching basis: standardized name and semantic
 * type, both validated identical across parties. */
interface RecordLinkageField {
  /** Standardized linkage-field name (not the raw source column). */
  name: string;
  /** Semantic PII type (e.g. "last_name", "date_of_birth", "ssn4"). */
  type: string;
}

/** The named rule set the agreed terms cited, copied from them: a citation,
 * not an account of the keys that ran. See
 * docs/spec/EXCHANGE_RECORD.md#the-rule-set-citation. */
export interface RecordLinkageRuleSet {
  /** Name and content version of the set the linkage fields were cited to. */
  fieldSet: { name: string; version: string };
  /** Name and content version of the set the linkage keys were cited to. */
  keySet: { name: string; version: string };
}

/**
 * The writing party's own verdict, per half, on whether the declared fields
 * and keys are drawn from the cited sets. Build-relative and not compared
 * across parties; the citation is kept verbatim whatever it says. See
 * docs/spec/EXCHANGE_RECORD.md#the-writing-partys-verdict.
 */
interface RecordLinkageRuleSetVerdict {
  /** Verdict on the set the linkage fields were cited to. */
  fieldSet: "consistent" | "contradicted" | "unchecked";
  /** Verdict on the set the linkage keys were cited to. */
  keySet: "consistent" | "contradicted" | "unchecked";
}

/**
 * Readable governance metadata: names, categories, descriptions, and
 * references, never a value. Both parties' blocks agree except for payload
 * descriptions and {@link matching}, which each writes from its own side.
 * See docs/spec/EXCHANGE_RECORD.md#governance-metadata.
 */
interface ExchangeRecordGovernance {
  /** `psi` revealed matched identifiers, `psi-c` only a count. */
  algorithm: Algorithm;
  /** Omitted when the terms named no agreement. */
  legalAgreement?: RecordLegalAgreement;
  /** The fields the linkage keys reference, once each, sorted by `name` in
   * UTF-16 code units. */
  matchingBasis: RecordLinkageField[];
  /** Omitted when the terms cited no set. */
  linkageRuleSet?: RecordLinkageRuleSet;
  /** Present exactly when {@link linkageRuleSet} is. */
  linkageRuleSetVerdict?: RecordLinkageRuleSetVerdict;
  /** The columns this party committed as sent; `[]` when none. */
  payloadSent: RecordPayloadColumn[];
  /** The columns this party committed as received; `[]` when none. */
  payloadReceived: RecordPayloadColumn[];
  /** Both parties' `deduplicate` values and the cardinality they give this
   * party. See docs/spec/EXCHANGE_RECORD.md#the-resolved-matching. */
  matching: ResolvedMatching;
}

/**
 * How far the run a record attests got, stated on every record. `completed`:
 * the run finished. `receipt-swap-terminated`: this party handed its payload
 * to the transport and the run ended without this party holding a receipt.
 * See docs/spec/EXCHANGE_RECORD.md#when-a-record-is-owed.
 */
export type ExchangeRecordOutcome = "completed" | "receipt-swap-terminated";

/** Every {@link ExchangeRecordOutcome}, as the schema's accepted value set. */
export const EXCHANGE_RECORD_OUTCOMES = [
  "completed",
  "receipt-swap-terminated",
] as const satisfies readonly ExchangeRecordOutcome[];

/**
 * A self-attested, unsigned disclosure-log entry for one exchange. It names
 * both parties in cleartext, so retention and access control are the
 * holder's. See docs/spec/EXCHANGE_RECORD.md#record-fields.
 *
 * Partner-supplied text is stored byte-exact. Every sink that renders a
 * record to a person MUST escape each such field (`sanitizeForDisplay`) where
 * it is shown, without mutating the stored value.
 */
export interface ExchangeRecord {
  version: typeof EXCHANGE_RECORD_VERSION;
  /** When the record was produced, an ISO 8601 UTC datetime. */
  createdAt: string;
  outcome: ExchangeRecordOutcome;
  /** Whether the run observed that the partner's certificate is not the
   * pinned identity. Always present; `false` on a completed record. See
   * docs/spec/EXCHANGE_RECORD.md#when-a-record-is-owed. */
  certificateMismatchObserved: boolean;
  /** See {@link computeTermsHash}. */
  termsHash: string;
  /** This party's self-asserted identity; absent when it supplied none. */
  localIdentity?: string;
  /** The partner's self-asserted identity; absent when it sent none. */
  partnerIdentity?: string;
  governance: ExchangeRecordGovernance;
  /** This party's own input row count, every contributed record. */
  recordsExposed: number;
  /** Intersection size, present only when the agreed terms give both
   * parties output. See
   * docs/spec/EXCHANGE_RECORD.md#result-size-and-per-direction-disclosure. */
  resultSize?: number;
  /** Where this party filed its copy of the result, from its local config;
   * never exchanged or hashed. See
   * docs/spec/EXCHANGE_RECORD.md#retention-and-disposition-pointer. */
  retentionDisposition?: string;
  /** Per-record CSPRNG nonce, distinct for each party; it distinguishes runs
   * in one holder's log and pairs nothing across artifacts. */
  bindingNonce: string;
  /** The signed receipt's per-run binder, present exactly when the run
   * derived one, so its absence states no receipt can belong to this record.
   * See docs/spec/EXCHANGE_RECORD.md#pairing-a-receipt-to-one-run. */
  receiptBinder?: string;
  commitments: ExchangeRecordCommitments;
}

/** Per-commitment salts, the secret HMAC keys, mirroring the commitments. */
interface CommitmentSalts {
  localPayloadSent: string;
  partnerPayloadReceived: string;
  associationTable?: string;
}

/**
 * The private verification keys for an {@link ExchangeRecord}: the salts and
 * nothing else, so no copy of the matched data. Private, since a salt plus
 * the record can brute-force a low-entropy committed value. See
 * docs/spec/EXCHANGE_RECORD.md#no-data-snapshot-in-the-keys-data-minimization.
 */
export interface VerificationKeys {
  version: typeof EXCHANGE_KEYS_VERSION;
  salts: CommitmentSalts;
}

// --- Schemas -----------------------------------------------------------------

// The caps below bound an untrusted record file at parse, at the limits the
// linkage-terms producers imply, so a record this module writes always parses
// back. The name shape is not applied: the record is a frozen log. See
// docs/spec/EXCHANGE_RECORD.md#record-fields.

// Every legitimate value is 43 characters; the cap refuses a hostile string
// without pinning the width.
const MAX_BASE64URL_LENGTH = 256;

const base64UrlSchema = z
  .string()
  .check(maxCodeUnits(MAX_BASE64URL_LENGTH))
  .regex(/^[A-Za-z0-9_-]+$/, "must be an unpadded base64url string");

const nonNegativeCountSchema = (label: string) =>
  safeIntegerSchema.refine((n) => n >= 0, {
    message: `${label} must be non-negative`,
  });
const resultSizeSchema = nonNegativeCountSchema("result size");
const recordsExposedSchema = nonNegativeCountSchema("records exposed");

// An absent pointer is the omitted key, never "".
const retentionDispositionSchema = z
  .string()
  .min(1)
  .check(maxCodeUnits(MAX_TEXT_LENGTH));

// UTC only: `z.iso.datetime()` rejects offsets.
const createdAtSchema = z.iso.datetime();

const identitySchema = z.string().min(1).check(maxCodeUnits(MAX_TEXT_LENGTH));

const base64UrlCommitmentTripleSchema = z.object({
  localPayloadSent: base64UrlSchema,
  partnerPayloadReceived: base64UrlSchema,
  associationTable: base64UrlSchema.optional(),
});

const ExchangeRecordCommitmentsSchema: z.ZodType<ExchangeRecordCommitments> =
  base64UrlCommitmentTripleSchema;

const RecordPayloadColumnSchema: z.ZodType<RecordPayloadColumn> = z.object({
  // The on-disk safety check for the payload wire bound (payloadExchange.ts).
  name: z.string().min(1).check(maxCodeUnits(MAX_NAME_LENGTH)),
  description: z.string().check(maxCodeUnits(MAX_TEXT_LENGTH)).optional(),
});

const RecordLegalAgreementSchema: z.ZodType<RecordLegalAgreement> = z.object({
  reference: z.string().min(1).check(maxCodeUnits(MAX_NAME_LENGTH)),
  purpose: z.string().min(1).check(maxCodeUnits(MAX_TEXT_LENGTH)),
  expirationDate: z.iso.date(),
});

const RecordLinkageFieldSchema: z.ZodType<RecordLinkageField> = z.object({
  name: z.string().min(1).check(maxCodeUnits(MAX_NAME_LENGTH)),
  // Open, not the current type enum: a frozen-log reader accepts what a newer
  // writer recorded.
  type: z.string().min(1).check(maxCodeUnits(MAX_NAME_LENGTH)),
});

// `version` is open, not a semver pattern, for the reason `type` is above.
const RecordLinkageSetIdentitySchema = z.object({
  name: z.string().min(1).check(maxCodeUnits(MAX_NAME_LENGTH)),
  version: z.string().min(1).check(maxCodeUnits(MAX_NAME_LENGTH)),
});

const RecordLinkageRuleSetSchema: z.ZodType<RecordLinkageRuleSet> = z.object({
  fieldSet: RecordLinkageSetIdentitySchema,
  keySet: RecordLinkageSetIdentitySchema,
});

// Closed, like `algorithm`: an unknown verdict is a claim this reader cannot
// interpret.
const RecordLinkageRuleSetVerdictValueSchema = z.enum([
  "consistent",
  "contradicted",
  "unchecked",
]);

const RecordLinkageRuleSetVerdictSchema: z.ZodType<RecordLinkageRuleSetVerdict> =
  z.object({
    fieldSet: RecordLinkageRuleSetVerdictValueSchema,
    keySet: RecordLinkageRuleSetVerdictValueSchema,
  });

// Closed, like `algorithm`.
const ResolvedMatchingSchema: z.ZodType<ResolvedMatching> = z.object({
  localDeduplicate: z.boolean(),
  partnerDeduplicate: z.boolean(),
  cardinality: z.enum(LINKAGE_CARDINALITIES),
});

const ExchangeRecordGovernanceSchema: z.ZodType<ExchangeRecordGovernance> = z
  .object({
    // Closed, unlike `type`: an unknown algorithm changes what the record
    // discloses.
    algorithm: AlgorithmSchema,
    legalAgreement: RecordLegalAgreementSchema.optional(),
    matchingBasis: boundedArray(
      RecordLinkageFieldSchema,
      MAX_LINKAGE_ENTRIES,
      `matchingBasis must not exceed ${MAX_LINKAGE_ENTRIES} entries`,
    ),
    linkageRuleSet: RecordLinkageRuleSetSchema.optional(),
    linkageRuleSetVerdict: RecordLinkageRuleSetVerdictSchema.optional(),
    payloadSent: boundedArray(
      RecordPayloadColumnSchema,
      MAX_PAYLOAD_ENTRIES,
      `payloadSent must not exceed ${MAX_PAYLOAD_ENTRIES} entries`,
    ),
    payloadReceived: boundedArray(
      RecordPayloadColumnSchema,
      MAX_PAYLOAD_ENTRIES,
      `payloadReceived must not exceed ${MAX_PAYLOAD_ENTRIES} entries`,
    ),
    matching: ResolvedMatchingSchema,
  })
  .refine(
    (governance) =>
      (governance.linkageRuleSet === undefined) ===
      (governance.linkageRuleSetVerdict === undefined),
    {
      message:
        "linkageRuleSetVerdict must be present exactly when linkageRuleSet is",
      path: ["linkageRuleSetVerdict"],
    },
  );

const outcomeSchema = z.enum(EXCHANGE_RECORD_OUTCOMES);

// Required, not defaulted: a missing marker is not read as `false`.
const certificateMismatchObservedSchema = z.boolean();

const ExchangeRecordSchema: z.ZodType<ExchangeRecord> = z.object({
  version: z.literal(EXCHANGE_RECORD_VERSION),
  createdAt: createdAtSchema,
  outcome: outcomeSchema,
  certificateMismatchObserved: certificateMismatchObservedSchema,
  termsHash: base64UrlSchema,
  localIdentity: identitySchema.optional(),
  partnerIdentity: identitySchema.optional(),
  governance: ExchangeRecordGovernanceSchema,
  recordsExposed: recordsExposedSchema,
  resultSize: resultSizeSchema.optional(),
  retentionDisposition: retentionDispositionSchema.optional(),
  bindingNonce: base64UrlSchema,
  receiptBinder: base64UrlSchema.optional(),
  commitments: ExchangeRecordCommitmentsSchema,
});

const CommitmentSaltsSchema: z.ZodType<CommitmentSalts> =
  base64UrlCommitmentTripleSchema;

const VerificationKeysSchema: z.ZodType<VerificationKeys> = z.object({
  version: z.literal(EXCHANGE_KEYS_VERSION),
  salts: CommitmentSaltsSchema,
});

// --- Build -------------------------------------------------------------------

/**
 * The form a payload is committed in: column names and row values in
 * matched-row order, never row indices. Both the sent and the received
 * payload map into it, so the two parties commit over identical data. A
 * `type`, not an `interface`, so it is assignable to {@link CanonicalValue}.
 * See docs/spec/EXCHANGE_RECORD.md#commitment-scheme.
 */
export type CommittedPayload = {
  columns: string[];
  rows: Array<Array<string | null>>;
};

/** The inputs to {@link buildExchangeRecord}, gathered once the exchange has
 * disclosed. */
export interface ExchangeRecordInputs {
  localTerms: LinkageTerms;
  partnerTerms: LinkageTerms;
  /** The standardized linkage fields this party's input bound a column to.
   * A matching basis naming a field not listed here is refused. */
  contributedLinkageFields: readonly string[];
  /** This party's own input row count. */
  recordsExposed: number;
  /** Intersection size; supply only in the both-output case. */
  resultSize?: number;
  /** From this party's local config; omit when absent. */
  retentionDisposition?: string;
  /** The association table; supply only when this party received output. */
  associationTable?: AssociationTable;
  /** The payload this party sent, in the record's canonical committed form. */
  localPayloadSent: CommittedPayload;
  /** The payload this party received, in the committed form. */
  partnerPayloadReceived: CommittedPayload;
  /** ISO 8601 UTC; supplied so the build is deterministic. */
  createdAt: string;
  /** Required: a default would claim completion by omission. */
  outcome: ExchangeRecordOutcome;
  /** Required, for the reason `outcome` is. Derived from the terminating
   * error's condition (`observedPartnerCertificateMismatch`), never its
   * message text. */
  certificateMismatchObserved: boolean;
  /** The binder the caller also signs into the receipt; supply it whenever
   * it was derived, including for a terminated swap, and omit it otherwise. */
  receiptBinder?: string;
}

/** Random material for {@link buildExchangeRecord}, injected by tests;
 * generated from a CSPRNG when omitted. */
export interface ExchangeRecordRandomness {
  bindingNonce: Uint8Array<ArrayBuffer>;
  salts: Partial<Record<CommitmentName, Uint8Array<ArrayBuffer>>>;
}

/** The record, its private keys, and the agreed terms `termsHash` covers. */
export interface BuiltExchangeRecord {
  record: ExchangeRecord;
  keys: VerificationKeys;
  agreedTerms: AgreedTerms;
}

/**
 * The record's governance metadata. The algorithm, agreement, citation, and
 * matching basis come from this party's agreed terms, the verdict from this
 * build's rule sets, the matching from both terms, and the payload column
 * sets from the committed payloads, which are what flowed (the dictionary
 * adds descriptions only). A basis naming a field the run contributed none
 * of is refused, not narrowed. See
 * docs/spec/EXCHANGE_RECORD.md#the-matching-basis-against-what-the-run-contributed.
 */
function governanceFromTerms(
  terms: LinkageTerms,
  partnerTerms: LinkageTerms,
  localPayloadSent: CommittedPayload,
  partnerPayloadReceived: CommittedPayload,
  contributedLinkageFields: readonly string[],
): ExchangeRecordGovernance {
  // An absent description is an omitted key, not `undefined`.
  const describeCommitted = (
    committedColumns: readonly string[],
    declared: ReadonlyArray<{ name: string; description?: string }> | undefined,
  ): RecordPayloadColumn[] => {
    const descriptionByName = new Map(
      (declared ?? []).map((c) => [c.name, c.description] as const),
    );
    return committedColumns.map((name) => {
      const description = descriptionByName.get(name);
      return description !== undefined ? { name, description } : { name };
    });
  };

  const fieldByName = new Map(terms.linkageFields.map((f) => [f.name, f]));
  const seen = new Set<string>();
  const matchingBasis: RecordLinkageField[] = [];
  for (const key of terms.linkageKeys) {
    for (const element of key.elements) {
      if (seen.has(element.field)) continue;
      seen.add(element.field);
      const field = fieldByName.get(element.field);
      if (field === undefined) continue;
      matchingBasis.push({ name: field.name, type: field.type });
    }
  }
  matchingBasis.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );

  // Partner-authored names go in a cause link of their own, after the count,
  // each redacted so a planted marker cannot take the names after it.
  const contributed = new Set(contributedLinkageFields);
  const uncontributed = matchingBasis
    .filter((field) => !contributed.has(field.name))
    .map((field) => redactPrivateKeyMaterial(field.name));
  if (uncontributed.length > 0)
    throw new Error(
      "the self-attested record would name linkage fields this run " +
        `contributed no values for (${uncontributed.length}). It is refused ` +
        "rather than written. Run the exchange with an input that supplies " +
        "every linkage field the agreed linkage keys reference.",
      {
        cause: chainDetailCauses([
          "linkage fields the run contributed no values for " +
            `(${uncontributed.length}): ${uncontributed.join(", ")}`,
        ]),
      },
    );

  const citation = terms.linkageRuleSet;
  const citedRuleSet: Pick<
    ExchangeRecordGovernance,
    "linkageRuleSet" | "linkageRuleSetVerdict"
  > =
    citation === undefined
      ? {}
      : {
          linkageRuleSet: {
            fieldSet: {
              name: citation.fieldSet.name,
              version: citation.fieldSet.version,
            },
            keySet: {
              name: citation.keySet.name,
              version: citation.keySet.version,
            },
          },
          linkageRuleSetVerdict: checkLinkageRuleSetCitation(citation, terms),
        };

  return {
    algorithm: terms.algorithm,
    ...(terms.legalAgreement !== undefined
      ? {
          legalAgreement: {
            reference: terms.legalAgreement.reference,
            purpose: terms.legalAgreement.purpose,
            expirationDate: terms.legalAgreement.expirationDate,
          },
        }
      : {}),
    matchingBasis,
    ...citedRuleSet,
    payloadSent: describeCommitted(
      localPayloadSent.columns,
      terms.payload?.send,
    ),
    payloadReceived: describeCommitted(
      partnerPayloadReceived.columns,
      terms.payload?.receive,
    ),
    matching: resolvedMatchingFromTerms(terms, partnerTerms),
  };
}

/**
 * Build the {@link ExchangeRecord} and its {@link VerificationKeys}: fresh
 * nonce and salts unless `randomness` injects them, one commitment per data
 * set, and the agreed-terms hash. The keys contain only salts.
 */
export async function buildExchangeRecord(
  inputs: ExchangeRecordInputs,
  randomness?: ExchangeRecordRandomness,
): Promise<BuiltExchangeRecord> {
  const datasets: Array<{ name: CommitmentName; data: CanonicalValue }> = [
    { name: "localPayloadSent", data: inputs.localPayloadSent },
    { name: "partnerPayloadReceived", data: inputs.partnerPayloadReceived },
  ];
  if (inputs.associationTable !== undefined)
    datasets.push({
      name: "associationTable",
      data: inputs.associationTable,
    });

  const recordCommitments: Partial<Record<CommitmentName, string>> = {};
  const commitmentSalts: Partial<Record<CommitmentName, string>> = {};
  for (const { name, data } of datasets) {
    const salt = randomness?.salts[name] ?? randomBytes(SALT_BYTES);
    const value = await computeCommitment(name, salt, data);
    recordCommitments[name] = toBase64Url(value);
    commitmentSalts[name] = toBase64Url(salt);
  }

  const bindingNonce = randomness?.bindingNonce ?? randomBytes(SALT_BYTES);
  const termsHash = await computeTermsHash(
    inputs.localTerms,
    inputs.partnerTerms,
  );

  const record: ExchangeRecord = {
    version: EXCHANGE_RECORD_VERSION,
    // Each field below is validated with the parser's own schema, so a bad
    // input throws here rather than writing a record the parser rejects; an
    // omitted optional field is an absent key.
    createdAt: createdAtSchema.parse(inputs.createdAt),
    outcome: outcomeSchema.parse(inputs.outcome),
    certificateMismatchObserved: certificateMismatchObservedSchema.parse(
      inputs.certificateMismatchObserved,
    ),
    termsHash,
    ...(inputs.localTerms.identity !== undefined && {
      localIdentity: identitySchema.parse(inputs.localTerms.identity),
    }),
    ...(inputs.partnerTerms.identity !== undefined && {
      partnerIdentity: identitySchema.parse(inputs.partnerTerms.identity),
    }),
    // Partner payload column names are only string-checked on the wire, so
    // an empty one throws here.
    governance: ExchangeRecordGovernanceSchema.parse(
      governanceFromTerms(
        inputs.localTerms,
        inputs.partnerTerms,
        inputs.localPayloadSent,
        inputs.partnerPayloadReceived,
        inputs.contributedLinkageFields,
      ),
    ),
    recordsExposed: recordsExposedSchema.parse(inputs.recordsExposed),
    ...(inputs.resultSize !== undefined
      ? { resultSize: resultSizeSchema.parse(inputs.resultSize) }
      : {}),
    ...(inputs.retentionDisposition !== undefined
      ? {
          retentionDisposition: retentionDispositionSchema.parse(
            inputs.retentionDisposition,
          ),
        }
      : {}),
    bindingNonce: toBase64Url(bindingNonce),
    ...(inputs.receiptBinder !== undefined
      ? { receiptBinder: base64UrlSchema.parse(inputs.receiptBinder) }
      : {}),
    commitments: recordCommitments as ExchangeRecordCommitments,
  };
  const keys: VerificationKeys = {
    version: EXCHANGE_KEYS_VERSION,
    salts: commitmentSalts as CommitmentSalts,
  };
  const agreedTerms: AgreedTerms = {
    version: AGREED_TERMS_VERSION,
    localTerms: inputs.localTerms,
    partnerTerms: inputs.partnerTerms,
  };
  return { record, keys, agreedTerms };
}

// --- Serialize / parse -------------------------------------------------------

// Pretty JSON for the file on disk, not the canonical encoding; shared so the
// CLI and the web app write identical files.
function serialize(value: ExchangeRecord | VerificationKeys): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/** Serialize an {@link ExchangeRecord} to its on-disk/download string form. */
export function serializeExchangeRecord(record: ExchangeRecord): string {
  return serialize(record);
}

/** Serialize {@link VerificationKeys} to its on-disk/download string form. */
export function serializeVerificationKeys(keys: VerificationKeys): string {
  return serialize(keys);
}

/**
 * Parse and validate an {@link ExchangeRecord} from a raw value (e.g. the result
 * of `JSON.parse`). Rejects an unrecognized `version` rather than migrating it.
 *
 * @throws {z.ZodError} if validation fails.
 */
export function parseExchangeRecord(raw: unknown): ExchangeRecord {
  return ExchangeRecordSchema.parse(raw);
}

/**
 * Parse and validate {@link VerificationKeys} from a raw value.
 *
 * @throws {z.ZodError} if validation fails.
 */
export function parseVerificationKeys(raw: unknown): VerificationKeys {
  return VerificationKeysSchema.parse(raw);
}

// --- Verify ------------------------------------------------------------------

/** Per-commitment verdicts from {@link verifyRecordCommitments}. */
type RecordCommitmentVerdicts = Partial<Record<CommitmentName, boolean>>;

/**
 * Verify every commitment in `record` against its salt in `keys` and the
 * re-supplied canonical `data`. A missing commitment, salt, or data entry is
 * a mismatch, as is a missing mandatory commitment. The agreed-terms hash is
 * not checked here.
 */
export async function verifyRecordCommitments(
  record: ExchangeRecord,
  keys: VerificationKeys,
  data: Partial<Record<CommitmentName, CanonicalValue>>,
): Promise<{ verdicts: RecordCommitmentVerdicts; allValid: boolean }> {
  const names: CommitmentName[] = [
    "localPayloadSent",
    "partnerPayloadReceived",
    "associationTable",
  ];
  // A record built without parseExchangeRecord could omit a mandatory
  // commitment, which would otherwise report allValid with no verdicts.
  const mandatory: ReadonlySet<CommitmentName> = new Set([
    "localPayloadSent",
    "partnerPayloadReceived",
  ]);
  const verdicts: RecordCommitmentVerdicts = {};
  let allValid = true;
  for (const name of names) {
    const value = record.commitments[name];
    const salt = keys.salts[name];
    const supplied = data[name];
    if (value === undefined && salt === undefined) {
      if (mandatory.has(name)) {
        verdicts[name] = false;
        allValid = false;
      }
      continue;
    }
    if (value === undefined || salt === undefined || supplied === undefined) {
      verdicts[name] = false;
      allValid = false;
      continue;
    }
    const ok = await verifyCommitmentOpening(name, salt, supplied, value);
    verdicts[name] = ok;
    if (!ok) allValid = false;
  }
  return { verdicts, allValid };
}
