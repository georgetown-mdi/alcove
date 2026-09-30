import { z } from "zod";
import { maxCodeUnits } from "../utils/maxCodeUnits.js";
import {
  camelizeKey,
  camelizeKeys,
  KeyFoldCollisionError,
  type WidthBounds,
} from "../utils/camelizeKeys.js";
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
 * The refine below is the one cross-field rule: `includeOwnColumns` names
 * columns of a result file a count-only exchange never writes, so the two
 * together are refused where the config is read rather than at the run that
 * would have nothing to apply them to.
 */
export const ExchangeSpecSchema = z
  .strictObject({
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
    // file path, the pinned partner fingerprint, and the receipt output
    // location). Absent in exchanges that do not sign receipts; see signing.ts and
    // EXCHANGE_REFERENCE.md.
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
  );

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
 * Top-level settings this build refuses by name rather than as unknown keys,
 * so the refusal tells the operator to delete them. The agreed terms'
 * `payload.send` and `payload.receive` state the payload sets they named.
 */
const RETIRED_TOP_LEVEL_SETTINGS: ReadonlySet<string> = new Set([
  "disclosedPayloadColumns",
  "expectedPayloadColumns",
  "outboundPayloadConsent",
]);

/**
 * The refusal of a raw exchange file holding a retired top-level setting,
 * naming each such key as the file writes it and stating the remedy, or
 * `undefined` when it holds none. The whole-file parses apply it before any
 * other check, and so does a CLI reader of only some of the file's blocks, so
 * each refuses such a file with the same message.
 */
export function retiredSettingIssue(
  raw: unknown,
): z.core.$ZodIssue | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return undefined;
  const retired = Object.keys(raw).filter((key) =>
    RETIRED_TOP_LEVEL_SETTINGS.has(camelizeKey(key)),
  );
  if (retired.length === 0) return undefined;
  const named = retired.map((key) => `"${key}"`).join(" and ");
  return {
    code: "custom",
    path: [],
    message:
      retired.length === 1
        ? `the setting ${named} is retired; delete it from the file`
        : `the settings ${named} are retired; delete them from the file`,
  };
}

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
 * included. A retired top-level setting is refused first, by name
 * ({@link retiredSettingIssue}).
 *
 * @throws {ZodError} if validation fails, if the document holds a key the
 *   schema does not read, or if it writes one key in two spellings.
 */
export function parseExchangeSpec(raw: unknown): ExchangeSpec {
  const retired = retiredSettingIssue(raw);
  if (retired !== undefined) throw new z.ZodError([retired]);
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
    throw new z.ZodError(unrecognizedKeysAsWritten(raw, result.error.issues));
  const dropped = droppedSettingIssues(raw, camelized, result.data);
  if (dropped.length > 0) throw new z.ZodError(dropped);
  return result.data;
}

/**
 * Non-throwing version of {@link parseExchangeSpec}, holding the same rules for
 * a setting neither the case conversion nor the schema keeps. Honors the "safe"
 * contract for the {@link camelizeKeys} bounds too -- see
 * {@link safeParseCamelized}.
 */
export function safeParseExchangeSpec(
  raw: unknown,
): z.ZodSafeParseResult<ExchangeSpec> {
  const retired = retiredSettingIssue(raw);
  if (retired !== undefined)
    return {
      success: false,
      error: new z.ZodError([retired]) as z.ZodError<ExchangeSpec>,
    };
  return safeParseCamelized(
    ExchangeSpecSchema,
    raw,
    EXCHANGE_FILE_WIDTH_BOUNDS,
    (camelized, parsed) => droppedSettingIssues(raw, camelized, parsed),
  );
}
