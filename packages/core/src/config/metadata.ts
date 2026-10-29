import { z } from "zod";
import { maxCodeUnits } from "../utils/maxCodeUnits.js";
import {
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
  sanitizeForDisplay,
} from "../utils/sanitizeForDisplay.js";
import {
  redactAndSanitizeForDisplay,
  redactPrivateKeyMaterial,
} from "../utils/sanitizeErrorForDisplay.js";

import { OperatorConfigError, UsageError } from "../errors.js";
import { SEMANTIC_TYPES } from "../types";
import { COUNT_ONLY_SHAPE_REFUSALS } from "../linkageTermsPolicy.js";
import { MAX_NAME_LENGTH, NAME_SHAPE_PATTERN } from "./linkageTermsSchema.js";
import { safeParseCamelized } from "./safeParseCamelized.js";
import { droppedSettingIssues } from "./unreadKeys.js";

import type { Algorithm, SemanticType } from "../types";

// --- Metadata ----------------------------------------------------------------
/**
 * The role a declared input column plays in an exchange:
 *
 * - `linkage` -- participates in PSI matching via its semantic type.
 * - `identifier` -- indexes this party's matched records in the output.
 * - `payload` -- transmitted to the partner for matched members.
 * - `ignored` -- never linked, never an identifier, never transmitted as
 *   payload, regardless of `isPayload`. {@link inferMetadata} assigns it only
 *   under the `direct` mode, to an identifier-typed column after the first;
 *   {@link inferMetadataForEveryColumn} assigns it to that column in both
 *   modes, and to each column that inference does not recognize outside the
 *   `direct` mode.
 *
 * Two independent axes, each checked explicitly rather than inferred from
 * `type` alone:
 * - MATCHING requires `role: linkage` (enforced at
 *   {@link resolveFieldColumns}).
 * - TRANSMISSION requires `isPayload && role !== "ignored"`
 *   ({@link isDisclosedToPartner}, the source `preparePayload` uses).
 *
 * A column can do both: `role: linkage` with `isPayload: true` matches and
 * is transmitted.
 */
const ColumnRoleSchema = z.enum([
  "linkage",
  "identifier",
  "payload",
  "ignored",
]);
type ColumnRole = z.infer<typeof ColumnRoleSchema>;

/**
 * Information about a specific input column used to determine its possible
 * roles in linkage.
 */
export interface ColumnMetadata {
  name: string;
  type: SemanticType;
  role: ColumnRole;
  isPayload: boolean;
  description?: string;
}

/**
 * Refusal message for a metadata column name holding a character
 * {@link NAME_SHAPE_PATTERN} refuses, in the form the linkage-terms names use
 * and naming the block it fires on. A fixed literal echoing no submitted
 * value, like the length and uniqueness messages beside it.
 *
 * It names a remedy where the linkage-terms message names none, because the
 * configuration that reaches this refusal has one: it declares a column as the
 * header was typed, and the CSV read removes these characters from a header,
 * so the declared name matches no column of the file.
 */
export const METADATA_NAME_SHAPE_MESSAGE =
  "a metadata column name must not contain a control or text-direction " +
  "character; the CSV read removes these characters from a header, so " +
  "re-run alcove init over the input file, or delete the character from " +
  "the name, to make the declared name match the header that is read";

const ColumnMetadataSchema: z.ZodType<ColumnMetadata> = z.object({
  // Floored at one code unit, capped at MAX_NAME_LENGTH of them, and held to
  // NAME_SHAPE_PATTERN, matching the linkage-terms schema's `name` fields and
  // rejecting an empty or ill-shaped name at config parse rather than as a
  // later downstream failure. A declared name is not a data value: this block names the
  // columns matched on, and each disclosed one reaches the partner in the
  // invitation's payload column list and both parties' exchange records. Like
  // the uniqueness refine below, the messages are static and do not echo the
  // operator-authored name.
  name: z
    .string()
    .min(1)
    .check(maxCodeUnits(MAX_NAME_LENGTH))
    .regex(NAME_SHAPE_PATTERN, METADATA_NAME_SHAPE_MESSAGE),
  type: z.enum(SEMANTIC_TYPES),
  role: ColumnRoleSchema,
  isPayload: z.boolean(),
  description: z.string().optional(),
});

export type Metadata = Array<ColumnMetadata>;

/**
 * Whether a column's standardized values are transmitted to the exchange
 * partner. The single source of truth for "what is disclosed":
 * {@link preparePayload} gathers exactly the columns this returns true
 * for -- a disclosure summary must derive from this predicate, not
 * `role === "payload"` (a `role: identifier` column with `isPayload: true`
 * is still transmitted; `ignored` never is regardless of `isPayload`).
 */
export function isDisclosedToPartner(column: ColumnMetadata): boolean {
  return column.isPayload && column.role !== "ignored";
}

/**
 * The names of the columns disclosed to the partner, in metadata order -- exactly
 * the set {@link preparePayload} transmits. The boundary a disclosure summary or
 * launch confirmation reads so it cannot drift from what is actually sent.
 */
export function disclosedColumnNames(metadata: Metadata): Array<string> {
  return metadata.filter(isDisclosedToPartner).map((column) => column.name);
}

/**
 * Which column a run on inferred metadata indexes its records by, as both
 * quick exchange displays word it: the CLI's display before the run and the
 * console's confirm step. Reads the `role: identifier` column the result's
 * first column takes its value from ({@link buildOutputTable}); inference gives
 * that role to the first identifier-typed column in header order, passing over
 * a record number while an id named otherwise follows ({@link inferMetadata}).
 * With none, the result heads its first column `row_id` and writes each
 * record's 0-based row index there.
 *
 * The column name is redacted and escaped here. Starts lowercase, for use
 * after a label.
 */
export function inferredRecordIdentifierStatement(metadata: Metadata): string {
  const identifierIndex = metadata.findIndex(
    (column) => column.role === "identifier",
  );
  if (identifierIndex === -1)
    return (
      "none found; the result's row_id column identifies your rows by " +
      "their position in the file, counting from 0"
    );
  const passedOver = metadata
    .slice(0, identifierIndex)
    .some((column) => column.type === "identifier");
  return (
    `${redactAndSanitizeForDisplay(metadata[identifierIndex].name)}, ` +
    (passedOver
      ? "the first id column in your file that is not a record number"
      : "the first id column in your file")
  );
}

/**
 * The date-of-birth column the `date_of_birth` input format is inferred from:
 * the first `role: linkage` column of that type, the column the default
 * standardization binds the field to. Every caller inferring the format selects
 * through this, so the format is read from the column the run parses.
 */
export function linkageDateOfBirthColumn(
  metadata: ReadonlyArray<ColumnMetadata>,
): ColumnMetadata | undefined {
  return metadata.find(
    (column) => column.type === "date_of_birth" && column.role === "linkage",
  );
}

/**
 * Which of this party's own input columns its result file holds beside the
 * partner's values, as the local `include_own_columns` config key selects
 * them: `disclosed` for the columns transmitted to the partner
 * ({@link isDisclosedToPartner}), `all` for every column the metadata
 * declares, or every column of the input file when the metadata is inferred.
 * The key's absence selects nothing and is not a value here.
 */
export const OwnColumnSelectionSchema = z.enum(["disclosed", "all"]);

/** See {@link OwnColumnSelectionSchema}. */
export type OwnColumnSelection = z.infer<typeof OwnColumnSelectionSchema>;

/**
 * The names of this party's own input columns to write into its result
 * file under `selection`: the selected metadata columns in metadata order,
 * then, under `all`, `undeclaredColumns` in input order: the input columns
 * inferred metadata does not name, and none for an authored metadata block
 * (`undeclaredColumnsForOwnResult`).
 *
 * The identifier column is left out of both selections: the result's first
 * column already holds its value for every row ({@link buildOutputTable}),
 * so writing it again would head one input column twice. Only the FIRST
 * `role: identifier` column is left out, since that is the one the result's
 * first column holds.
 */
export function ownResultColumnNames(
  metadata: Metadata,
  selection: OwnColumnSelection,
  undeclaredColumns: ReadonlyArray<string>,
): Array<string> {
  const identifierIndex = metadata.findIndex(
    (column) => column.role === "identifier",
  );
  const selected = metadata
    .filter(
      (column, index) =>
        index !== identifierIndex &&
        (selection === "all" || isDisclosedToPartner(column)),
    )
    .map((column) => column.name);
  return selection === "all" ? [...selected, ...undeclaredColumns] : selected;
}

/**
 * Whether this party's input metadata would transmit a column under a
 * count-only (`psi-c`) algorithm -- the fifth count-only shape rule
 * (docs/spec/PROTOCOL.md, PSI-C), the one no linkage-terms document
 * has, so it lives here beside {@link isDisclosedToPartner}.
 *
 * False for every `psi` exchange and for an absent metadata block. The
 * terms-held rules are `countOnlyShapeViolation` in
 * `config/linkageTermsSchema.ts`.
 */
export function countOnlyTransmitsColumn(
  algorithm: Algorithm,
  metadata: Metadata | undefined,
): boolean {
  if (algorithm !== "psi-c" || metadata === undefined) return false;
  return metadata.some(isDisclosedToPartner);
}

/**
 * Refuse a count-only exchange whose input metadata would transmit a
 * column, at the boundaries that hold this party's own metadata beside the
 * agreed algorithm: where an invitation is minted, and where one is
 * accepted.
 *
 * Fail-closed like its terms-held siblings
 * ({@link assertCountOnlyTermsShape}): marked columns are never quietly
 * dropped to fit the count-only shape. A no-op on `psi` and on an
 * unresolved metadata block. Plain {@link UsageError}; the message names
 * no column.
 */
export function assertCountOnlyTransmitsNoColumn(
  algorithm: Algorithm,
  metadata: Metadata | undefined,
): void {
  if (!countOnlyTransmitsColumn(algorithm, metadata)) return;
  throw new UsageError(COUNT_ONLY_SHAPE_REFUSALS.transmittedColumns);
}

/**
 * The 1-based metadata positions of the DISCLOSED columns whose name is
 * longer than {@link MAX_NAME_LENGTH}, in metadata order -- empty when
 * every disclosed name fits. The single predicate behind every gate on
 * that ceiling, shared by a front end that refuses before transmit and the
 * {@link assertDisclosedNamesCarriable} safety check at prepare time.
 *
 * Scoped to {@link isDisclosedToPartner}: an oversized name on a column
 * that is never sent costs nothing and is often a vendor export the
 * operator cannot rewrite.
 *
 * Counted in UTF-16 code units (`name.length`), the unit every
 * transmitted-name schema bound counts through {@link maxCodeUnits}; a
 * code-point count would pass a name of astral characters those bounds
 * refuse.
 *
 * Positions, not names -- an offending name is by construction too long
 * to include in a message. The position is the entry's place in the
 * METADATA; inferred metadata preserves header order, while a
 * hand-authored block is matched by name and may list entries in any
 * order, so there the position locates the entry in the block itself.
 */
export function overlongDisclosedColumnPositions(
  metadata: Metadata,
): Array<number> {
  return metadata
    .map((column, index) =>
      isDisclosedToPartner(column) && column.name.length > MAX_NAME_LENGTH
        ? index + 1
        : 0,
    )
    .filter((position) => position > 0);
}

// Column names must be unique. Every consumer treats metadata as keyed by
// name (`metadata.find((c) => c.name === ...)`), so a duplicate name makes
// "the metadata for column X" position-dependent -- a `role: ignored` and
// a `role: payload` entry for the same name could resolve differently,
// silently defeating the ignored exclusion. Rejected at the schema; the
// message is static and does not echo the user-controlled name (it can
// hold control/ANSI/bidi bytes).
export const MetadataSchema = z.array(ColumnMetadataSchema).refine(
  (cols) => {
    const names = cols.map((c) => c.name);
    return names.length === new Set(names).size;
  },
  { message: "metadata column names must be unique" },
);

/**
 * Non-throwing parse of a raw value as {@link Metadata}. Snake_case keys
 * (e.g. `is_payload`) are converted to camelCase before validation, so a
 * `metadata` block read straight from YAML/JSON can be passed directly --
 * mirroring {@link safeParseLinkageTerms} and
 * {@link safeParseExchangeSpec}. Honors the "safe" contract for the
 * camelize bounds too: a depth- or node-count-tripping input yields
 * `{ success: false }` rather than throwing (see {@link safeParseCamelized}).
 */
export function safeParseMetadata(raw: unknown) {
  return safeParseCamelized(MetadataSchema, raw);
}

/**
 * {@link safeParseMetadata} for the `metadata` block of a document the reading
 * party WROTE -- an operator's own configuration file. Identical in what it
 * admits, with one addition: a key this schema would drop rather than read is
 * refused ({@link droppedSettingIssues}), as the whole-file read of the same
 * block refuses it, so a command that writes the file back out cannot write it
 * short of a setting the operator stated.
 */
export function safeParseMetadataTheReaderWrote(raw: unknown) {
  return safeParseCamelized(
    MetadataSchema,
    raw,
    undefined,
    (camelized, parsed) => droppedSettingIssues(raw, camelized, parsed),
  );
}

// --- Metadata Inference ------------------------------------------------------
/** @internal */
export interface TypeMeta {
  type: SemanticType;
  aliases: Array<string>;
  role: ColumnRole;
  isPayload: boolean;
}

type TypeMetaMapped = Omit<TypeMeta, "aliases">;

/**
 * The key a column name is looked up by in {@link ALIAS_TYPE_META_MAP}: the
 * name lowercased, each `#` read as the word `number`, each run of
 * whitespace, `_`, `-` and `.` collapsed to one `_`, and any punctuation left
 * at either end dropped, so `First Name`, ` first_name.` and `FIRST-NAME` share
 * the key `first_name`, and `SSN #` has the key `ssn_number`. A lookup key
 * only: a column keeps its raw header as its name.
 */
export function columnNameLookupKey(name: string): string {
  return name
    .toLowerCase()
    .replaceAll("#", "_number_")
    .replace(/[\s_.-]+/g, "_")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * Lookup keys of identifier names that do not end in `_id` but infer as a
 * name that does. `personalid` is the client column of the HMIS CSV export,
 * and `mrn` a medical record number.
 *
 * @internal
 */
export const NAMED_IDENTIFIER_LOOKUP_KEYS: ReadonlySet<string> = new Set([
  "clientid",
  "personid",
  "personalid",
  "patientid",
  "recordid",
  "memberid",
  "mrn",
]);

/**
 * Lookup keys that end in a record-number suffix but name no record number,
 * so they infer as any other name absent from the table: a yes/no answer.
 *
 * @internal
 */
export const NOT_RECORD_NUMBER_LOOKUP_KEYS: ReadonlySet<string> = new Set([
  "yes_no",
  "yesno",
]);

/**
 * The part of a lookup key before a `_number`, `_no` or `number` suffix, or
 * `undefined` when it has none.
 */
function numberSuffixPrefix(lookupName: string): string | undefined {
  return (/^(.+?)_?number$/.exec(lookupName) ??
    /^(.+)_no$/.exec(lookupName))?.[1];
}

/**
 * Whether a column name ends in a record-number suffix: its lookup key ends in
 * `_number`, `_no` or `number` after a character other than `_`, or the raw
 * `name`, less the punctuation at its end, ends in `No` written in camel case
 * (`RecordNo`), which keeps a word that ends in `no`, such as `Casino`, out.
 */
function hasRecordNumberSuffix(name: string, lookupName: string): boolean {
  const prefix = numberSuffixPrefix(lookupName);
  if (prefix !== undefined) return /[^_]/.test(prefix);
  return /[a-z]No[^\p{L}\p{N}]*$/u.test(name);
}

/**
 * Whether a column absent from {@link ALIAS_TYPE_META_MAP} infers
 * `type: identifier` by name: its lookup key ends in `_id` or is one of
 * {@link NAMED_IDENTIFIER_LOOKUP_KEYS}.
 */
function isNamedIdentifierLookupKey(lookupName: string): boolean {
  return (
    lookupName.endsWith("_id") || NAMED_IDENTIFIER_LOOKUP_KEYS.has(lookupName)
  );
}

/**
 * Whether a column absent from {@link ALIAS_TYPE_META_MAP} infers
 * `type: identifier` as a record number: its name has a record-number suffix
 * ({@link hasRecordNumberSuffix}) and its lookup key is not one of
 * {@link NOT_RECORD_NUMBER_LOOKUP_KEYS}.
 */
function isRecordNumberColumn(name: string, lookupName: string): boolean {
  return (
    !NOT_RECORD_NUMBER_LOOKUP_KEYS.has(lookupName) &&
    hasRecordNumberSuffix(name, lookupName)
  );
}

/**
 * Whether a column absent from {@link ALIAS_TYPE_META_MAP} infers
 * `type: identifier`: by name ({@link isNamedIdentifierLookupKey}) or as a
 * record number ({@link isRecordNumberColumn}).
 */
function isUnlistedIdentifierColumn(name: string, lookupName: string): boolean {
  return (
    isNamedIdentifierLookupKey(lookupName) ||
    isRecordNumberColumn(name, lookupName)
  );
}

/** The endings the table's number spellings take ({@link numberSpellings}). */
const NUMBER_ENDINGS: ReadonlyArray<string> = ["number", "no", "num", "nbr"];

/**
 * The lookup keys of each of `words` followed by each of
 * {@link NUMBER_ENDINGS}, separated by `_` and run together: `home_phone`
 * gives `home_phone_no` and `homephoneno`.
 */
function numberSpellings(words: ReadonlyArray<string>): Array<string> {
  return words.flatMap((word) =>
    NUMBER_ENDINGS.flatMap((ending) => [
      `${word}_${ending}`,
      `${word.replaceAll("_", "")}${ending}`,
    ]),
  );
}

/** Each of `words` as written and with `_` removed. */
function wordSpellings(words: ReadonlyArray<string>): Array<string> {
  return words.flatMap((word) => [word, word.replaceAll("_", "")]);
}

/**
 * The aliases of `type` among `spellings`, each once: every spelling but the
 * type name, which the table lists as a name of its own.
 */
function aliasesOf(type: string, spellings: ReadonlyArray<string>): string[] {
  return [...new Set(spellings)].filter((spelling) => spelling !== type);
}

/** Words whose number spellings the `ssn` row lists. */
const SSN_WORDS: ReadonlyArray<string> = [
  "ssn",
  "ss",
  "social",
  "social_security",
  "soc_sec",
];

/**
 * Names of a phone column the `phone_number` row lists, each also with its
 * number spellings.
 */
const PHONE_WORDS: ReadonlyArray<string> = [
  "phone",
  "telephone",
  "tel",
  "cell",
  "cell_phone",
  "mobile",
  "mobile_phone",
  "home_phone",
  "work_phone",
  "business_phone",
  "office_phone",
  "day_phone",
  "evening_phone",
  "primary_phone",
  "alt_phone",
  "alternate_phone",
  "contact_phone",
];

// The lookup key joins words with `_`, so a no-separator spelling such as
// `firstname` is a key of its own and is listed as an alias.
const DEFAULT_COLUMN_TYPES_AND_ALIASES: Array<TypeMeta> = [
  {
    type: "ssn",
    aliases: aliasesOf("ssn", [
      ...wordSpellings(["social", "social_security", "soc_sec"]),
      ...numberSpellings(SSN_WORDS),
    ]),
    role: "linkage",
    isPayload: false,
  },
  { type: "ssn4", aliases: [], role: "linkage", isPayload: false },
  {
    type: "first_name",
    aliases: ["firstname", "fname"],
    role: "linkage",
    isPayload: false,
  },
  {
    type: "last_name",
    aliases: ["lastname", "lname"],
    role: "linkage",
    isPayload: false,
  },
  {
    type: "date_of_birth",
    aliases: ["dateofbirth", "dob"],
    role: "linkage",
    isPayload: false,
  },
  /**
   * Identifier columns are also inferred from the names
   * {@link isUnlistedIdentifierColumn} accepts, which take this row's role
   * and payload default. See {@link inferMetadata}.
   */
  { type: "identifier", aliases: ["id"], role: "identifier", isPayload: false },
  {
    type: "phone_number",
    aliases: aliasesOf("phone_number", [
      ...wordSpellings(PHONE_WORDS),
      ...numberSpellings(PHONE_WORDS),
    ]),
    role: "linkage",
    isPayload: false,
  },
  {
    type: "email_address",
    aliases: ["emailaddress", "email"],
    role: "linkage",
    isPayload: false,
  },
  // Number-named columns only: an address-line column (`address`,
  // `street_address`) is typed `street_number` explicitly by the operator.
  {
    type: "street_number",
    aliases: aliasesOf(
      "street_number",
      numberSpellings(["street", "house", "address"]),
    ),
    role: "linkage",
    isPayload: false,
  },
  // Not `street`, which often contains the whole address line.
  {
    type: "street_name",
    aliases: ["streetname"],
    role: "linkage",
    isPayload: false,
  },
  // Not an address-line column (`address2`), which can contain a care-of name
  // or a PO box instead of a unit.
  {
    type: "unit",
    aliases: aliasesOf("unit", [
      "apartment",
      "apt",
      ...numberSpellings(["unit", "apartment", "apt"]),
    ]),
    role: "linkage",
    isPayload: false,
  },
  {
    type: "city",
    aliases: ["city_name", "cityname"],
    role: "linkage",
    isPayload: false,
  },
  {
    type: "zip_code",
    aliases: ["zipcode", "zip", "zip5", "zip_5"],
    role: "linkage",
    isPayload: false,
  },
  {
    type: "state",
    aliases: ["state_code", "statecode", "state_name", "statename"],
    role: "linkage",
    isPayload: false,
  },
  {
    type: "county",
    aliases: ["county_name", "countyname"],
    role: "linkage",
    isPayload: false,
  },
];

/**
 * The lookup table of `types`, keyed by the {@link columnNameLookupKey} of each
 * type name and alias. Throws when two of them share a key, even within one
 * type, so no spelling is listed twice or silently decided by list order.
 *
 * @internal
 */
export function buildAliasTypeMetaMap(
  types: ReadonlyArray<TypeMeta>,
): Record<string, TypeMetaMapped> {
  const map: Record<string, TypeMetaMapped> = {};
  for (const { type, aliases, role, isPayload } of types)
    for (const spelling of [type, ...aliases]) {
      const key = columnNameLookupKey(spelling);
      if (Object.hasOwn(map, key))
        throw new Error(
          `column name "${spelling}" (type ${type}) has the lookup key ` +
            `"${key}", which type ${map[key].type} already uses`,
        );
      map[key] = { type, role, isPayload };
    }
  return map;
}

/**
 * Each recognized column name's semantic type, role and payload default, keyed
 * by {@link columnNameLookupKey}.
 */
export const ALIAS_TYPE_META_MAP = buildAliasTypeMetaMap(
  DEFAULT_COLUMN_TYPES_AND_ALIASES,
);

/**
 * Refuse a header holding an empty (zero-length) column name, naming the cause
 * that produced it.
 *
 * `sanitizedPositions` are the 1-based positions the parse removed control
 * characters from (`CSVParseMeta.sanitizedColumnPositions`, `packages/core/src/file.ts`).
 * An empty position among them held nothing but those characters, so the
 * header-row cause is wrong for it and the removal is stated instead; an
 * empty list gives the header-row cause for every position.
 */
function assertColumnNamesNonEmpty(
  columnNames: ReadonlyArray<string>,
  sanitizedPositions: ReadonlyArray<number>,
): void {
  const emptyPositions = columnNames
    .map((name, index) => (name.length === 0 ? index + 1 : 0))
    .filter((position) => position > 0);
  if (emptyPositions.length === 0) return;

  const sanitized = new Set(sanitizedPositions);
  const strippedEmpty = emptyPositions.filter((position) =>
    sanitized.has(position),
  );
  const plural = emptyPositions.length > 1;
  const strippedPlural = strippedEmpty.length > 1;
  const cause =
    strippedEmpty.length === 0
      ? `a trailing delimiter, a blank cell, or a leading delimiter in the ` +
        `CSV header row produces an unnamed column. Name the ` +
        `column${plural ? "s" : ""}, or remove the empty header ` +
        `field${plural ? "s" : ""}.`
      : strippedEmpty.length === emptyPositions.length
        ? `${plural ? "those names" : "that name"} held nothing but invisible ` +
          `control characters, which this read removes. Give the ` +
          `column${plural ? "s" : ""} ${plural ? "names" : "a name"} made of ` +
          `ordinary characters, and run again.`
        : `column${strippedPlural ? "s" : ""} ${strippedEmpty.join(", ")} ` +
          `held nothing but invisible control characters, which this ` +
          `read removes, and a trailing delimiter, a blank cell, or a ` +
          `leading delimiter in the CSV header row produces the rest. Name ` +
          `every column with ordinary characters, and run again.`;
  throw new UsageError(
    `input column${plural ? "s" : ""} ${emptyPositions.join(", ")} ` +
      `${plural ? "have" : "has"} an empty name. A column used for linkage, ` +
      `identification, or payload must be named; ${cause}`,
  );
}

/**
 * Which default inference gives the columns it does not recognize by name,
 * and the identifier-typed columns after the first:
 *
 * - `declaredOnly` -- an invited or recurring exchange, and the default:
 *   such a column is left out, so it is not declared and never sent, and an
 *   identifier-typed column that is not the record identifier is left out
 *   too. Inference sends no column.
 * - `direct` -- a run on an input file with no invitation or configuration:
 *   such a column is declared `role: payload` and sent, and an
 *   identifier-typed column that is not the record identifier is declared
 *   `role: ignored`, so every column is declared and none is undeclared.
 *
 * Under both, no identifier-typed column (`id`, `identifier`, or a name
 * {@link isUnlistedIdentifierColumn} accepts) is sent, and a linkage-key alias
 * is never sent and is matched on only where a linkage key reads it.
 */
export type MetadataInferenceMode = "declaredOnly" | "direct";

/** Options for {@link inferMetadata} and {@link inferMetadataForEveryColumn}. */
export interface InferMetadataOptions {
  /** Defaults to `declaredOnly`. */
  mode?: MetadataInferenceMode;
}

/**
 * Assigns default roles to the columns inference recognizes by name: a name
 * whose {@link columnNameLookupKey} is a key of {@link ALIAS_TYPE_META_MAP},
 * or a name {@link isUnlistedIdentifierColumn} accepts, which may become
 * this party's identifier. Each column keeps its raw header as its
 * name. Under the default `declaredOnly` mode every other column is left
 * out, so it is not declared and never sent
 * ({@link undeclaredColumnNames} lists them); under `direct` it is declared
 * as payload and sent ({@link MetadataInferenceMode}).
 *
 * The first identifier-typed column in header order that is not only a record
 * number ({@link isRecordNumberColumn}) gets `role: identifier`, used to index
 * observations, and is not sent; with none, the first record number does. A
 * record number is often not unique to one record, so it never outranks a
 * column recognized as an id by name. Every other identifier-typed column is
 * left out under `declaredOnly` and declared `role: ignored` under `direct`.
 *
 * `sanitizedPositions` are the 1-based positions the CSV parse removed
 * control characters from, so the empty-name refusal below can name the removal
 * as the cause. Required rather than defaulted: an omitted list means "blame the
 * trailing comma", and a read that forgot to thread its own positions would
 * state that wrong cause silently. A caller holding a column list rather than a
 * read of its own passes an empty list, saying so at the call site.
 *
 * @throws {UsageError} when any column name is empty. Downstream name
 *   fields (metadata, payload, wire, exchange-record schemas) all floor at
 *   `.min(1)`, so an inferred empty name would otherwise appear only
 *   later, disclosed and sent before a non-fatal guard silently drops the
 *   audit record at record build. Rejected here instead, at the intake
 *   chokepoint where raw CSV columns become metadata. A {@link UsageError}
 *   so the CLI classifies it as a configuration error (exit 64); the
 *   message names the offending positions only, never the (empty) names.
 */
export function inferMetadata(
  columnNames: Array<string>,
  sanitizedPositions: ReadonlyArray<number>,
  options: InferMetadataOptions = {},
): Metadata {
  const everyColumn = inferMetadataForEveryColumn(
    columnNames,
    sanitizedPositions,
    options,
  );
  if (options.mode === "direct") return everyColumn;
  return everyColumn.filter((column) => column.role !== "ignored");
}

/**
 * {@link inferMetadata} with an entry for every column, in header order: a
 * column that inference does not recognize gets `type: other`, `role:
 * ignored` and `isPayload: false` under the default `declaredOnly` mode, and
 * an identifier-typed column that is not the record identifier gets `role:
 * ignored` and `isPayload: false` under both. For an editor that lists every
 * input column so the operator can declare one; a run resolves its metadata
 * through {@link inferMetadata}.
 *
 * @throws {UsageError} as {@link inferMetadata} does.
 */
export function inferMetadataForEveryColumn(
  columnNames: Array<string>,
  sanitizedPositions: ReadonlyArray<number>,
  options: InferMetadataOptions = {},
): Metadata {
  assertColumnNamesNonEmpty(columnNames, sanitizedPositions);
  const direct = (options.mode ?? "declaredOnly") === "direct";

  const result: Metadata = columnNames.map((name) => {
    const typeMeta = recognizedTypeMeta(name);
    if (typeMeta === undefined)
      return direct
        ? { name, type: "other", role: "payload", isPayload: true }
        : { name, type: "other", role: "ignored", isPayload: false };
    const { type, role, isPayload } = typeMeta;
    return { name, type, role, isPayload };
  });

  const namedIdentifierIndex = result.findIndex(
    (column) =>
      column.type === "identifier" && !isRecordNumberOnly(column.name),
  );
  const identifierIndex =
    namedIdentifierIndex !== -1
      ? namedIdentifierIndex
      : result.findIndex((column) => column.type === "identifier");
  return result.map((column, index): ColumnMetadata => {
    if (column.type !== "identifier" || index === identifierIndex)
      return column;
    return { ...column, role: "ignored", isPayload: false };
  });
}

/**
 * Whether a column infers `type: identifier` only as a record number
 * ({@link isRecordNumberColumn}), not by an identifier name.
 */
function isRecordNumberOnly(name: string): boolean {
  const lookupName = columnNameLookupKey(name);
  return (
    !Object.hasOwn(ALIAS_TYPE_META_MAP, lookupName) &&
    !isNamedIdentifierLookupKey(lookupName) &&
    isRecordNumberColumn(name, lookupName)
  );
}

/**
 * The type, role and payload default inference gives a column name, or
 * `undefined` for a name it does not recognize. An identifier name outside
 * {@link ALIAS_TYPE_META_MAP} takes the `identifier` row's.
 */
function recognizedTypeMeta(name: string): TypeMetaMapped | undefined {
  const lookupName = columnNameLookupKey(name);
  // An own-property test: `in` also matches inherited names such as
  // `constructor` and `__proto__`, which have no entry.
  if (Object.hasOwn(ALIAS_TYPE_META_MAP, lookupName))
    return ALIAS_TYPE_META_MAP[lookupName];
  return isUnlistedIdentifierColumn(name, lookupName)
    ? ALIAS_TYPE_META_MAP.identifier
    : undefined;
}

/**
 * The input columns `metadata` does not name, in header order: the columns a
 * run neither indexes by nor sends, and matches on only when a standardization
 * transform names one as its input. Shown to the operator before the run
 * connects, so a column can be declared on purpose.
 */
export function undeclaredColumnNames(
  columnNames: ReadonlyArray<string>,
  metadata: Metadata,
): Array<string> {
  const declared = new Set(metadata.map((column) => column.name));
  return columnNames.filter((name) => !declared.has(name));
}

/**
 * The names among `columnNames`, in order, that infer `type: identifier`
 * (`id`, `identifier`, or a name {@link isUnlistedIdentifierColumn}
 * accepts). An empty name is skipped: inference refuses it, and a run's
 * intake has refused it already.
 */
export function identifierTypedColumnNames(
  columnNames: ReadonlyArray<string>,
): Array<string> {
  return inferMetadataForEveryColumn(
    columnNames.filter((name) => name.length > 0),
    [],
  )
    .filter((column) => column.type === "identifier")
    .map((column) => column.name);
}

/** The most undeclared column names one notice lists; an arbitrary working value. */
export const UNDECLARED_COLUMNS_LISTED_MAX = 20;

/**
 * The most times any sink route escapes a warning before showing it: a
 * console-run CLI warning is escaped by the CLI's event, by the console's
 * event relay, and by the seat's warning sink.
 */
const RELAY_ESCAPE_PASSES = 3;

/**
 * The notice naming a run's undeclared input columns
 * ({@link undeclaredColumnNames}) and ending with `remedy`, the fix the front
 * end's own settings take, or `undefined` when there are none. The names are
 * the operator's own header, composed raw for the display sink to escape,
 * each passed through {@link redactPrivateKeyMaterial} first so a key marker
 * in one name costs only that name, not the text composed after it.
 *
 * Lists at most {@link UNDECLARED_COLUMNS_LISTED_MAX} names and counts the
 * rest, and lists fewer when their escaped form would push the message past
 * {@link WARNING_MESSAGE_MAX_DISPLAY_LENGTH}, the cap every warning sink
 * applies after the deepest route's {@link RELAY_ESCAPE_PASSES} escapes, so no
 * sink truncates `remedy` away.
 */
export function describeUndeclaredColumns(
  undeclared: ReadonlyArray<string>,
  remedy: string,
): string | undefined {
  if (undeclared.length === 0) return undefined;
  const plural = undeclared.length > 1;
  const compose = (listed: number): string => {
    const remaining = undeclared.length - listed;
    const names =
      listed === 0
        ? ""
        : `: ${undeclared.slice(0, listed).map(redactPrivateKeyMaterial).join(", ")}` +
          (remaining > 0 ? `, and ${remaining} more` : "");
    return (
      `${undeclared.length} input column${plural ? "s are" : " is"} not sent ` +
      `to your partner because the exchange's column settings do not declare ` +
      `${plural ? "them" : "it"}${names}. ${remedy}`
    );
  };
  // The escaped form is never shorter than its input, so testing each pass
  // before the next keeps an overlong header from being escaped whole just to
  // measure it.
  const fitsEverySink = (message: string): boolean => {
    let text = message;
    for (let pass = 0; pass < RELAY_ESCAPE_PASSES; pass += 1) {
      if (text.length > WARNING_MESSAGE_MAX_DISPLAY_LENGTH) return false;
      text = sanitizeForDisplay(text, { maxLength: Number.POSITIVE_INFINITY });
    }
    return text.length <= WARNING_MESSAGE_MAX_DISPLAY_LENGTH;
  };
  let listed = 0;
  while (
    listed < Math.min(undeclared.length, UNDECLARED_COLUMNS_LISTED_MAX) &&
    fitsEverySink(compose(listed + 1))
  )
    listed += 1;
  return compose(listed);
}

/**
 * Refuse metadata that declares a column as sent ({@link isDisclosedToPartner})
 * when the input does not hold it, naming each such column, before the run
 * connects. Stands on the metadata and the input header alone.
 *
 * @throws {OperatorConfigError} naming the missing columns, which are this
 *   party's own metadata names.
 */
export function assertDeclaredPayloadColumnsPresent(
  metadata: Metadata,
  columnNames: ReadonlyArray<string>,
): void {
  const present = new Set(columnNames);
  const missing = disclosedColumnNames(metadata).filter(
    (name) => !present.has(name),
  );
  if (missing.length === 0) return;
  const plural = missing.length > 1;
  throw new OperatorConfigError(
    `the metadata declares ${plural ? "columns" : "a column"} as sent to ` +
      `the partner that the input file does not hold: ${missing.join(", ")}. ` +
      `Add ${plural ? "them" : "it"} to the input file, or set ` +
      `is_payload: false on ${plural ? "their metadata entries" : "its metadata entry"}.`,
  );
}
