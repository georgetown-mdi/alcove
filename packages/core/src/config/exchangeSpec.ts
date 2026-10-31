import { z } from "zod";
import { maxCodeUnits } from "../utils/maxCodeUnits.js";
import {
  camelizeKey,
  camelizeKeys,
  KeyFoldCollisionError,
  type WidthBounds,
} from "../utils/camelizeKeys.js";
import {
  FIRST_FORMAT_VERSION_POLICY,
  FormatInfoBlockSchema,
  formatVersionBelowNeededIssues,
  formatVersionNeeded,
  newerFormatVersionMessage,
  withoutOldDefaults,
  type FormatVersionPolicy,
} from "./formatVersion.js";
import { safeParseCamelized } from "./safeParseCamelized.js";
import {
  droppedSettingIssues,
  keyFoldCollisionIssue,
  unrecognizedKeysAsWritten,
} from "./unreadKeys.js";
import {
  LinkageTermsSchema,
  MAX_PARAMS_ENTRIES,
  MAX_TEXT_LENGTH,
} from "./linkageTermsSchema.js";
import {
  csvDelimiterRefusal,
  isCsvDelimiterChoice,
  normalizeCsvDelimiter,
} from "../csvDelimiter.js";
import { AuthenticationSchema, ConnectionConfigSchema } from "./connection.js";
import { StandardizationSchema } from "./standardizationSchema.js";
import { MetadataSchema, OwnColumnSelectionSchema } from "./metadata.js";
import {
  MATCHING_KEY_CONFIG_REFUSALS,
  matchingKeyUnavailableReason,
} from "./matchingKeyAvailability.js";
import { SigningConfigSchema } from "./signing.js";

// --- Exchange spec -----------------------------------------------------------

/**
 * A complete alcove exchange specification. Consumed by both the web
 * application and the CLI application: the web app provides an interactive
 * editor, the CLI accepts it as a configuration file.
 *
 * Any string value beginning with `@` is read from the file at that path
 * rather than used literally; apply `readAtSignFile` (or equivalent) to
 * credential fields before parsing.
 *
 * `strictObject`: `expectedPartnerDeduplicate` is an enforcement record whose
 * ABSENCE is a valid state, so a misspelled key that `strip` discards would
 * silently disable the control it names. The
 * nested blocks still strip, `authentication` and the connection union's
 * webrtc member excepted, which are strict for the same reason as the top
 * level -- see EXCHANGE_FILE.md ("Versioning and compatibility policy").
 *
 * The refinements below are the cross-field rules: `includeOwnColumns` names
 * columns of a result file a count-only exchange never writes, and
 * `includeMatchingKey` names a key round that only a party writing a
 * `cascade` result counts, so each is refused beside terms it cannot act on
 * where the config is read rather than at the run that would have nothing to
 * apply it to.
 */
export const ExchangeSpecSchema = z
  .strictObject({
    // The file's format version, distinct from linkageTerms.version. Absent
    // is read as 1; the parse functions below refuse one this build does not
    // read and one below what the file's fields need.
    formatVersion: z.int().min(1).optional(),
    // Notes about the file that no reader acts on; held, never read.
    about: FormatInfoBlockSchema.optional(),
    connection: ConnectionConfigSchema,
    linkageTerms: LinkageTermsSchema,
    metadata: MetadataSchema.optional(),
    standardization: StandardizationSchema.optional(),
    // Optional top-level authentication block: the partner shared-secret
    // trust mechanism, channel-agnostic across sftp/filedrop/webrtc. A
    // sibling of `signing`, kept separate since the two have opposed
    // lifetimes and trust models (see SECURITY_DESIGN.md). Mixes
    // runtime-injected secret state (from .alcove.key, never written to
    // YAML) with operator-settable policy fields. See connection.ts and
    // EXCHANGE_REFERENCE.md.
    authentication: AuthenticationSchema.optional(),
    // Optional signing block (receipt signing mode, this party's signing identity
    // file path, and the pinned partner fingerprint). Absent in exchanges that
    // do not sign receipts; see signing.ts and EXCHANGE_REFERENCE.md.
    signing: SigningConfigSchema.optional(),
    // Optional self-facing retention/disposition note for the self-attested
    // exchange record: free text describing where this party files its copy
    // and under what retention schedule. Per-party and local -- written into
    // THIS party's record only, never swapped, cross-validated, or folded
    // into the agreed-terms hash. Metadata only: must carry no protected,
    // linkage-field, or payload value. Length-capped to the record schema's
    // bound (MAX_TEXT_LENGTH) so an over-long note fails here rather than at
    // record build. See EXCHANGE_REFERENCE.md and EXCHANGE_RECORD.md.
    retentionDisposition: z
      .string()
      .min(1)
      .check(maxCodeUnits(MAX_TEXT_LENGTH))
      .optional(),
    // Optional local TERMS-side enforcement record: the `deduplicate` the accepted
    // INVITATION declared for the INVITING party's own side, which a later
    // `alcove exchange` holds the partner's presented value to
    // (assertPresentedDeduplicateMatchesInvitation), refusing a
    // contradiction before any key or payload moves. Per-party and local,
    // distinct from linkageTerms.deduplicate (THIS party's own side).
    // Written by every acceptance that persists a config. ABSENT means no
    // invitation binding -- an exchange authored from two parties' own
    // config files, where a differing pair is legitimate and runs
    // unaffected.
    expectedPartnerDeduplicate: z.boolean().optional(),
    // Optional local output-composition setting: which of THIS party's own
    // input columns its result file holds beside the partner's values
    // (config/metadata.ts, ownResultColumnNames). Per-party and local like
    // retentionDisposition -- never exchanged, cross-validated, or folded
    // into the agreed-terms hash, and not a linkage term: it changes only
    // the file this party writes for itself, never what either party sends,
    // sees, or receives. Absent writes the result the partner's values
    // alone compose.
    includeOwnColumns: OwnColumnSelectionSchema.optional(),
    // Optional local output-composition setting: whether THIS party's result
    // file ends with a `matched_on_key` column naming the linkage key each
    // pair matched on. Local like includeOwnColumns: each party counts its
    // own cascade rounds, so nothing is sent for it and the agreed-terms hash
    // does not change. Absent or false writes no such column.
    includeMatchingKey: z.boolean().optional(),
    // Optional local file-format setting: the field delimiter this party's CSV
    // input is read by and its result file is written with. Per-party and
    // local like the fields above -- never exchanged, cross-validated, or
    // folded into the agreed-terms hash, and not a linkage term: the two
    // parties' files need not agree on it, and neither reads the other's.
    // Written as the character itself, `tab` / `\t` for a tab, or `detect` to
    // take the delimiter from the file itself, and resolved before the
    // accepted-set rule grades it, so a configuration and a command line take
    // the same spellings. Absent reads and writes commas.
    csvDelimiter: z
      .string()
      .transform(normalizeCsvDelimiter)
      .superRefine((value, ctx) => {
        if (isCsvDelimiterChoice(value)) return;
        ctx.addIssue({ code: "custom", message: csvDelimiterRefusal(value) });
      })
      .optional(),
  })
  .refine(
    (spec) =>
      spec.includeOwnColumns === undefined ||
      spec.linkageTerms.algorithm !== "psi-c",
    {
      path: ["includeOwnColumns"],
      message:
        'include_own_columns is set on a count-only ("psi-c") exchange, which ' +
        "writes no result file: it reports the size of the intersection and " +
        "hands neither party a table of matched records, so there is nothing " +
        "for your own columns to be written into. Remove include_own_columns, " +
        'or set the algorithm to "psi".',
    },
  )
  .superRefine((spec, ctx) => {
    if (spec.includeMatchingKey !== true) return;
    const reason = matchingKeyUnavailableReason(spec.linkageTerms);
    if (reason === undefined) return;
    ctx.addIssue({
      code: "custom",
      path: ["includeMatchingKey"],
      message: MATCHING_KEY_CONFIG_REFUSALS[reason],
    });
  });

export type ExchangeSpec = z.infer<typeof ExchangeSpecSchema>;

// --- Parse -------------------------------------------------------------------

/**
 * The width bounds the camelize pre-pass applies to an exchange file: the
 * linkage terms at the root `linkage_terms` are folded exactly as
 * `parseLinkageTerms` folds them, an over-{@link MAX_PARAMS_ENTRIES} `params`
 * object left verbatim for the schema's count refusal, while a `params` object
 * elsewhere in the file (a standardization step's, or one under a
 * `linkage_terms` key nested inside it) is folded as any other object.
 */
const EXCHANGE_FILE_WIDTH_BOUNDS: WidthBounds = new Map([
  ["linkageTerms", new Map([["params", MAX_PARAMS_ENTRIES]])],
]);

/**
 * Parse and validate a raw value as an {@link ExchangeSpec}.
 * Snake_case keys are converted to camelCase before validation, so JSON/YAML
 * from disk can be passed directly.
 *
 * A key the schema would have dropped instead of read is refused here rather
 * than stripped, wherever in the document it sits: a consumer writes the parse
 * result back out, so a dropped key is a setting the operator wrote and the next
 * file does not hold ({@link droppedSettingIssues}; docs/spec/EXCHANGE_FILE.md,
 * "What a consumer does with a setting it cannot honor"). One key written in
 * both spellings is refused by the case conversion above
 * ({@link keyFoldCollisionIssue}). Every refusal names its keys as the raw
 * document spells them ({@link unrecognizedKeysAsWritten}), the schema's own
 * included.
 *
 * The file's `format_version` is checked against `policy`: one above the
 * newest this build reads is refused before anything else, and one below what
 * the file's fields need is refused naming the field and the version.
 *
 * @param policy the format's version table; this build's by default.
 * @throws {ZodError} if validation fails, if the document holds a key the
 *   schema does not read, if it writes one key in two spellings, or if its
 *   format version is one this build does not read or its fields do not fit.
 */
export function parseExchangeSpec(
  raw: unknown,
  policy: FormatVersionPolicy = EXCHANGE_FILE_VERSION_POLICY,
): ExchangeSpec {
  const newer = newerExchangeFileIssue(raw, policy);
  if (newer !== undefined) throw new z.ZodError([newer]);
  let camelized: unknown;
  try {
    camelized = camelizeKeys(raw, EXCHANGE_FILE_WIDTH_BOUNDS);
  } catch (err) {
    if (err instanceof KeyFoldCollisionError)
      throw new z.ZodError([keyFoldCollisionIssue(err)]);
    throw err;
  }
  const result = ExchangeSpecSchema.safeParse(camelized);
  if (!result.success)
    throw new z.ZodError(
      withNewerFileHint(unrecognizedKeysAsWritten(raw, result.error.issues)),
    );
  const refused = [
    ...withNewerFileHint(droppedSettingIssues(raw, camelized, result.data)),
    ...exchangeFileVersionIssues(result.data, policy),
  ];
  if (refused.length > 0) throw new z.ZodError(refused);
  return result.data;
}

/**
 * Non-throwing version of {@link parseExchangeSpec}, holding the same rules for
 * a setting neither the case conversion nor the schema keeps and for the
 * format version. Honors the "safe" contract for the {@link camelizeKeys}
 * bounds too -- see {@link safeParseCamelized}.
 */
export function safeParseExchangeSpec(
  raw: unknown,
  policy: FormatVersionPolicy = EXCHANGE_FILE_VERSION_POLICY,
): z.ZodSafeParseResult<ExchangeSpec> {
  // A synthesized failure holds no `data`, so the cast's output type is never
  // read (as in safeParseCamelized).
  const failure = (
    issues: Array<z.core.$ZodIssue>,
  ): z.ZodSafeParseResult<ExchangeSpec> => ({
    success: false,
    error: new z.ZodError(issues) as z.ZodError<ExchangeSpec>,
  });
  const newer = newerExchangeFileIssue(raw, policy);
  if (newer !== undefined) return failure([newer]);
  const result = safeParseCamelized(
    ExchangeSpecSchema,
    raw,
    EXCHANGE_FILE_WIDTH_BOUNDS,
    (camelized, parsed) => [
      ...droppedSettingIssues(raw, camelized, parsed),
      ...exchangeFileVersionIssues(parsed, policy),
    ],
  );
  if (result.success) return result;
  return failure(withNewerFileHint(result.error.issues));
}

/** The format version table of the exchange file. */
export const EXCHANGE_FILE_VERSION_POLICY: FormatVersionPolicy =
  FIRST_FORMAT_VERSION_POLICY;

/**
 * `spec` as every writer of an exchange file writes it: stating, first, the
 * lowest format version its content needs, whatever it declared, with each
 * field holding the value an older reader assumes for its absence left out.
 * The caller's spec is not mutated. Validates nothing.
 *
 * @param policy the exchange file's version table; this build's by default.
 */
export function atLowestExchangeFileVersion(
  spec: ExchangeSpec,
  policy: FormatVersionPolicy = EXCHANGE_FILE_VERSION_POLICY,
): ExchangeSpec {
  const { formatVersion: _declared, ...fields } = withoutOldDefaults(
    spec,
    policy,
  );
  return {
    formatVersion: formatVersionNeeded(fields, policy).version,
    ...fields,
  };
}

/** A parsed spec's fields that need a version above the one it declares. */
function exchangeFileVersionIssues(
  parsed: ExchangeSpec,
  policy: FormatVersionPolicy,
): Array<z.core.$ZodIssue> {
  return formatVersionBelowNeededIssues(
    "The exchange file",
    "format_version",
    parsed,
    parsed.formatVersion ?? 1,
    policy,
  );
}

/**
 * The refusal of a document declaring a `format_version` above the policy's,
 * read from the raw document so it leads every other refusal.
 */
function newerExchangeFileIssue(
  raw: unknown,
  policy: FormatVersionPolicy,
): z.core.$ZodIssue | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return undefined;
  const key = Object.keys(raw).find(
    (name) => camelizeKey(name) === "formatVersion",
  );
  if (key === undefined) return undefined;
  const declared = (raw as Record<string, unknown>)[key];
  if (!Number.isSafeInteger(declared) || (declared as number) <= policy.current)
    return undefined;
  return {
    code: "custom",
    path: [key],
    message: newerFormatVersionMessage(
      "The exchange file",
      declared as number,
      policy.current,
      "Use the version of Alcove that made the file, or a newer one.",
    ),
  };
}

/**
 * What {@link parseExchangeSpec} appends to a schema-worded unknown-key
 * refusal.
 *
 * @internal exported for testing
 */
export const NEWER_EXCHANGE_FILE_HINT =
  ". If the spelling is intended, the file was made by a newer version of " +
  "Alcove than this one; use that version or a newer one";

/**
 * Each schema-worded unknown-key refusal with the hint that a newer Alcove
 * may have made the file; a block's own guidance is left as it is.
 */
function withNewerFileHint(
  issues: ReadonlyArray<z.core.$ZodIssue>,
): Array<z.core.$ZodIssue> {
  return issues.map((issue) =>
    issue.code === "unrecognized_keys" &&
    issue.message.startsWith("Unrecognized key")
      ? { ...issue, message: issue.message + NEWER_EXCHANGE_FILE_HINT }
      : issue,
  );
}
