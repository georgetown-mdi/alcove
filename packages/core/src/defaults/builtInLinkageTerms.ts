import { referencedLinkageFieldNames } from "../config/linkageTermsSchema";
import type {
  LinkageRuleSetReference,
  LinkageSetIdentity,
  LinkageTerms,
  LinkageField,
  LinkageKey,
  LinkageKeyElement,
} from "../config/linkageTermsSchema";
import type { Metadata } from "../config/metadata";
import { canonicalString } from "../utils/canonical";
import {
  fieldSourceColumnTypes,
  fieldTypesSuppliedByDefault,
} from "../standardization";
import type {
  Standardization,
  StandardizationTransformation,
} from "../config/standardizationSchema";
import type { SemanticType } from "../types";

/**
 * Neutral, stable identifier of the built-in linkage field set: the PII
 * substrate ({@link DEFAULT_LINKAGE_FIELDS}) that
 * {@link getDefaultLinkageTerms} emits when a party does not author its
 * own. It names which PII elements the built-in rules work from and how
 * each is cleaned and bounded -- not which combinations constitute a
 * match, which is what the key set ({@link DEFAULT_LINKAGE_KEY_SET_NAME})
 * names. The two are separate artifacts because the substrate is generic
 * where the keys are specific: every built-in key is built from these
 * fields, but the same fields support key sets settled for other uses.
 *
 * Naming it lets "which rules did this linkage match on" be answered by a
 * name rather than by "the defaults", and lets the set be cited in a
 * data-sharing agreement or a governance review without quoting the field
 * list.
 *
 * By design, it says nothing about who validated anything: these fields
 * hold no validation lineage of their own -- what was validated, against
 * what, and the criticisms on record all attach to the key set, recorded
 * in `docs/notes/default-linkage-rule-set.md` rather than in either
 * identifier.
 */
export const DEFAULT_LINKAGE_FIELD_SET_NAME = "baseline-pii";

/**
 * Version of the field set named by {@link DEFAULT_LINKAGE_FIELD_SET_NAME}.
 *
 * Distinct from `LinkageTerms.version`, which versions the terms schema and
 * is cross-checked between the parties at exchange time. This one versions
 * the content of the built-in field set -- which fields it declares and
 * which constraints they hold -- and is not on the wire. Neither it nor
 * {@link DEFAULT_LINKAGE_KEY_SET_VERSION} may ever be assigned to a terms
 * document's `version`.
 *
 * Bump it in the same change that edits {@link DEFAULT_LINKAGE_FIELDS}: a
 * field added or dropped, or a constraint loosened or tightened. The two
 * sets version independently, so an edit to the keys bumps
 * {@link DEFAULT_LINKAGE_KEY_SET_VERSION} and leaves this one alone.
 */
export const DEFAULT_LINKAGE_FIELD_SET_VERSION = "1.1.0";

/**
 * The linkage fields of the {@link DEFAULT_LINKAGE_FIELD_SET_NAME} field set:
 * the standardized form of each PII element the built-in keys are built from,
 * with the constraints each field commits both parties to.
 */
const DEFAULT_LINKAGE_FIELDS: ReadonlyArray<LinkageField> = [
  {
    name: "ssn",
    type: "ssn",
    constraints: {
      exclude: ["111111111", "123456789"],
      validOnly: true,
    },
  },
  {
    name: "ssn4",
    type: "ssn4",
    constraints: { validOnly: true },
  },
  {
    name: "first_name",
    type: "first_name",
    constraints: { affixesAllowed: false, allowedCharacters: "A-Z " },
  },
  {
    name: "last_name",
    type: "last_name",
    constraints: { affixesAllowed: false, allowedCharacters: "A-Z " },
  },
  { name: "date_of_birth", type: "date_of_birth" },
  { name: "phone_number", type: "phone_number" },
  { name: "email_address", type: "email_address" },
  { name: "zip_code", type: "zip_code" },
];

/**
 * Neutral, stable identifier of the built-in linkage KEY set: the catalog of
 * rules in `docs/notes/linkage-rule-catalog.md`, as the key combinations
 * ({@link DEFAULT_LINKAGE_KEYS}) a precision floor selects from. Every key is
 * built from the fields of {@link DEFAULT_LINKAGE_FIELD_SET_NAME}, so a
 * citation of this set is a citation of that one too; what this name adds is
 * which combinations of that substrate count as a match, and in what cascade
 * order.
 */
export const DEFAULT_LINKAGE_KEY_SET_NAME = "precision-ranked-rules";

/**
 * Version of the key set named by {@link DEFAULT_LINKAGE_KEY_SET_NAME}.
 *
 * Distinct from `LinkageTerms.version`, which versions the terms schema and
 * is cross-checked between the parties at exchange time. This one versions
 * the content of the built-in key set -- which key combinations it declares,
 * in what order, and each one's precision band and coverage condition -- and
 * is not on the wire. Neither it nor {@link DEFAULT_LINKAGE_FIELD_SET_VERSION}
 * may ever be assigned to a terms document's `version`.
 *
 * Bump it in the same change that edits {@link DEFAULT_LINKAGE_KEYS} or
 * {@link DEFAULT_LINKAGE_RULE_BANDS}: a key added or removed, an element or
 * transform changed, the keys reordered, or a band or coverage condition
 * moved. The recorded evidence attaches to the name and version together, so
 * an edited set holding the old version makes that record describe rules
 * nobody ran.
 */
export const DEFAULT_LINKAGE_KEY_SET_VERSION = "2.0.0";

/** A precision band of the catalog: the share, in percent, of the pairs a rule
 * accepts at its position in the order that are the same person, at least. */
export type PrecisionBand = 99 | 95;

/**
 * Which pairs of files a rule's band holds for: `any`, or only files that both
 * draw their members from one state or one metropolitan area.
 */
export type RuleCoverage = "any" | "one_state_or_metro_area";

/** One rule of the catalog: its band, its coverage condition, and, for a rule
 * Alcove cannot build yet, the element it needs. */
export interface LinkageRuleBand {
  /** The rule's key name, or its catalog notation where it has no key. */
  rule: string;
  /** The band the catalog places the rule in. */
  band: PrecisionBand;
  /** The files the band holds for. */
  coverage: RuleCoverage;
  /** The element the rule needs that no field supplies yet; such a rule has
   * no key and is never selected. */
  needs?: string;
}

// The elements the catalog's keys are built from, in the catalog's notation.
const SSN: LinkageKeyElement = { field: "ssn" };
const SSN4: LinkageKeyElement = { field: "ssn4" };
const LN: LinkageKeyElement = { field: "last_name" };
const FN: LinkageKeyElement = { field: "first_name" };
const DOB: LinkageKeyElement = { field: "date_of_birth" };
const PHONE: LinkageKeyElement = { field: "phone_number" };
const EMAIL: LinkageKeyElement = { field: "email_address" };
const ZIP5: LinkageKeyElement = { field: "zip_code" };
const LN3: LinkageKeyElement = {
  field: "last_name",
  transform: [{ function: "substring", params: { start: 1, length: 3 } }],
};
const LN4: LinkageKeyElement = {
  field: "last_name",
  transform: [{ function: "substring", params: { start: 1, length: 4 } }],
};
const FN1: LinkageKeyElement = {
  field: "first_name",
  transform: [{ function: "substring", params: { start: 1, length: 1 } }],
};
const FN3: LinkageKeyElement = {
  field: "first_name",
  transform: [{ function: "substring", params: { start: 1, length: 3 } }],
};
const YOB_MOB: LinkageKeyElement = {
  field: "date_of_birth",
  transform: [{ function: "substring", params: { start: 1, length: 6 } }],
};
const SDX_LN: LinkageKeyElement = {
  field: "last_name",
  transform: [{ function: "phonetic", params: { algorithm: "soundex" } }],
};
const SDX_FN: LinkageKeyElement = {
  field: "first_name",
  transform: [{ function: "phonetic", params: { algorithm: "soundex" } }],
};
// The whole last name and each space-separated part of it: the name cleaning
// turns a hyphen into a space.
const SPLIT_LN: LinkageKeyElement = {
  field: "last_name",
  transform: [
    { function: "split_on", params: { delimiter: " ", includeOriginal: true } },
  ],
};
const DOB_ONE_YEAR: LinkageKeyElement = {
  field: "date_of_birth",
  generateFuzzyComparisons: "adjacent_years",
};
const DOB_ONE_DAY: LinkageKeyElement = {
  field: "date_of_birth",
  generateFuzzyComparisons: "adjacent_days",
};
const DOB_DAY_MONTH: LinkageKeyElement = {
  field: "date_of_birth",
  generateFuzzyComparisons: "day_month_swaps",
};

/**
 * The linkage key combinations of the {@link DEFAULT_LINKAGE_KEY_SET_NAME}
 * key set, in the catalog's cascade order: an earlier key claims a record
 * first, and a record it claims is withheld from every later round. The order
 * is the catalog's precision order, the 99% band before the 95% band
 * ({@link DEFAULT_LINKAGE_RULE_BANDS}).
 *
 * {@link linkageTermsFromRuleSet} emits a subset of these: the keys a
 * precision floor selects, less any key whose elements the input's columns
 * cannot satisfy.
 */
const DEFAULT_LINKAGE_KEYS: ReadonlyArray<LinkageKey> = [
  { name: "SSN + LN + DOB", elements: [SSN, LN, DOB] },
  { name: "SSN + LN4 + DOB", elements: [SSN, LN4, DOB] },
  { name: "SSN + LN3 + DOB", elements: [SSN, LN3, DOB] },
  { name: "SSN + DOB + FN", elements: [SSN, DOB, FN] },
  { name: "SSN + FN3 + DOB", elements: [SSN, FN3, DOB] },
  { name: "SSN + DOB", elements: [SSN, DOB] },
  { name: "SSN + FN + LN", elements: [SSN, FN, LN] },
  {
    name: "SSN + soundex(FN) + soundex(LN)",
    elements: [SSN, SDX_FN, SDX_LN],
  },
  { name: "SSN + LN + FN1", elements: [SSN, LN, FN1] },
  { name: "SSN + LN3 + FN1", elements: [SSN, LN3, FN1] },
  { name: "SSN + FN + YOB + MOB", elements: [SSN, FN, YOB_MOB] },
  { name: "SSN + FN3 + YOB + MOB", elements: [SSN, FN3, YOB_MOB] },
  { name: "SSN + LN4 + YOB + MOB", elements: [SSN, LN4, YOB_MOB] },
  { name: "SSN4 + LN + DOB", elements: [SSN4, LN, DOB] },
  { name: "SSN4 + split(LN) + FN + DOB", elements: [SSN4, SPLIT_LN, FN, DOB] },
  { name: "SSN4 + FN + DOB", elements: [SSN4, FN, DOB] },
  {
    name: "SSN4 + LN + FN + DOB +/-1 year",
    elements: [SSN4, LN, FN, DOB_ONE_YEAR],
  },
  {
    name: "SSN4 + LN + FN + DOB +/-1 day",
    elements: [SSN4, LN, FN, DOB_ONE_DAY],
  },
  {
    name: "SSN4 + LN + FN + DOB day/month exchanged",
    elements: [SSN4, LN, FN, DOB_DAY_MONTH],
  },
  {
    name: "SSN4 + swap(LN, FN) + DOB",
    elements: [SSN4, LN, FN, DOB],
    swap: ["last_name", "first_name"],
  },
  { name: "LN + FN + DOB + ZIP5", elements: [LN, FN, DOB, ZIP5] },
  { name: "LN + FN + DOB + PHONE", elements: [LN, FN, DOB, PHONE] },
  { name: "FN + DOB + PHONE", elements: [FN, DOB, PHONE] },
  { name: "SSN + FN", elements: [SSN, FN] },
  { name: "SSN4 + LN4 + YOB + MOB", elements: [SSN4, LN4, YOB_MOB] },
  { name: "ZIP5 + soundex(LN) + FN + DOB", elements: [ZIP5, SDX_LN, FN, DOB] },
  {
    name: "ZIP5 + LN + FN + DOB +/-1 year",
    elements: [ZIP5, LN, FN, DOB_ONE_YEAR],
  },
  { name: "LN + FN + DOB", elements: [LN, FN, DOB] },
  {
    name: "swap(LN, FN) + DOB",
    elements: [LN, FN, DOB],
    swap: ["last_name", "first_name"],
  },
  { name: "split(LN) + FN + DOB", elements: [SPLIT_LN, FN, DOB] },
  { name: "LN + FN + YOB + MOB + ZIP5", elements: [LN, FN, YOB_MOB, ZIP5] },
  { name: "FN + DOB + EMAIL", elements: [FN, DOB, EMAIL] },
];

/**
 * Every rule of the catalog in its order, each with its band and coverage
 * condition ({@link LinkageRuleBand}), including the rules that need an
 * element Alcove does not build yet. Bands do not travel: a terms document
 * holds the keys a floor selected, never the floor or a band.
 */
const DEFAULT_LINKAGE_RULE_BANDS: ReadonlyArray<LinkageRuleBand> = [
  { rule: "SSN + LN + DOB", band: 99, coverage: "any" },
  { rule: "SSN + LN4 + DOB", band: 99, coverage: "any" },
  { rule: "SSN + LN3 + DOB", band: 99, coverage: "any" },
  { rule: "SSN + DOB + FN", band: 99, coverage: "any" },
  { rule: "SSN + FN3 + DOB", band: 99, coverage: "any" },
  { rule: "SSN + DOB", band: 99, coverage: "any" },
  { rule: "SSN + FN + LN", band: 99, coverage: "any" },
  { rule: "SSN + soundex(FN) + soundex(LN)", band: 99, coverage: "any" },
  { rule: "SSN + LN + FN1", band: 99, coverage: "any" },
  { rule: "SSN + LN3 + FN1", band: 99, coverage: "any" },
  { rule: "SSN + FN + YOB + MOB", band: 99, coverage: "any" },
  { rule: "SSN + FN3 + YOB + MOB", band: 99, coverage: "any" },
  { rule: "SSN + LN4 + YOB + MOB", band: 99, coverage: "any" },
  { rule: "SSN4 + LN + DOB", band: 99, coverage: "any" },
  { rule: "SSN4 + split(LN) + FN + DOB", band: 99, coverage: "any" },
  { rule: "SSN4 + FN + DOB", band: 99, coverage: "any" },
  { rule: "SSN4 + LN + FN + DOB +/-1 year", band: 99, coverage: "any" },
  { rule: "SSN4 + LN + FN + DOB +/-1 day", band: 99, coverage: "any" },
  {
    rule: "SSN4 + LN + FN + DOB day/month exchanged",
    band: 99,
    coverage: "any",
  },
  { rule: "SSN4 + swap(LN, FN) + DOB", band: 99, coverage: "any" },
  {
    rule: "LN + FN + DOB + street number + ZIP5",
    band: 99,
    coverage: "any",
    needs: "street number",
  },
  { rule: "LN + FN + DOB + ZIP5", band: 99, coverage: "any" },
  { rule: "LN + FN + DOB + PHONE", band: 99, coverage: "any" },
  { rule: "FN + DOB + PHONE", band: 99, coverage: "any" },
  { rule: "SSN + FN", band: 95, coverage: "any" },
  { rule: "SSN4 + LN4 + YOB + MOB", band: 95, coverage: "any" },
  {
    rule: "LN + FN + DOB + ZIP3",
    band: 95,
    coverage: "any",
    needs: "three-digit ZIP",
  },
  { rule: "ZIP5 + soundex(LN) + FN + DOB", band: 95, coverage: "any" },
  { rule: "ZIP5 + LN + FN + DOB +/-1 year", band: 95, coverage: "any" },
  {
    rule: "LN + FN + DOB + STATE or COUNTY",
    band: 95,
    coverage: "any",
    needs: "state or county",
  },
  { rule: "LN + FN + DOB", band: 95, coverage: "one_state_or_metro_area" },
  { rule: "swap(LN, FN) + DOB", band: 95, coverage: "one_state_or_metro_area" },
  {
    rule: "split(LN) + FN + DOB",
    band: 95,
    coverage: "one_state_or_metro_area",
  },
  { rule: "LN + FN + YOB + MOB + ZIP5", band: 95, coverage: "any" },
  {
    rule: "LN + FN + SFX + PHONE",
    band: 95,
    coverage: "any",
    needs: "name suffix",
  },
  {
    rule: "PHONE + soundex(LN) + FN + SFX",
    band: 95,
    coverage: "any",
    needs: "name suffix",
  },
  {
    rule: "FN + SFX + PHONE",
    band: 95,
    coverage: "any",
    needs: "name suffix and the shared-contact screen",
  },
  { rule: "FN + DOB + EMAIL", band: 95, coverage: "any" },
  {
    rule: "LN + FN + SFX + EMAIL",
    band: 95,
    coverage: "any",
    needs: "name suffix",
  },
  {
    rule: "EMAIL + soundex(LN) + FN + SFX",
    band: 95,
    coverage: "any",
    needs: "name suffix",
  },
];

/**
 * A named, versioned collection of linkage fields and keys terms can be drawn
 * from: the field set and the key set that
 * {@link LinkageRuleSetReference} cites, together with the content each names.
 *
 * The reference is what travels -- in a terms document, an invitation, and each
 * party's exchange record -- while the content is what a terms document is built
 * from. Keeping both on one object is what makes a set a selectable thing rather
 * than a pair of loose declarations: a caller selects a set and gets rules and
 * citation together, so the two cannot come apart.
 */
export interface BuiltInLinkageRuleSet {
  /** The name and version of each half, as a terms document cites them. */
  reference: LinkageRuleSetReference;
  /** The set's linkage fields, in declaration order. */
  linkageFields: ReadonlyArray<LinkageField>;
  /** The set's linkage keys, in the cascade order the set declares. */
  linkageKeys: ReadonlyArray<LinkageKey>;
  /** Each rule's precision band and coverage condition, for a set a
   * precision floor selects from; absent on a set with no bands. */
  ruleBands?: ReadonlyArray<LinkageRuleBand>;
}

/**
 * `value` frozen, and every array and object it holds frozen with it, returned at
 * its own type. `Object.freeze` alone reaches one level, which on an array of
 * declarations leaves each declaration writable.
 */
function frozenThroughContents<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const held of Object.values(value)) frozenThroughContents(held);
  return Object.freeze(value);
}

/**
 * The built-in catalog: the {@link DEFAULT_LINKAGE_KEY_SET_NAME} keys and
 * their bands over the {@link DEFAULT_LINKAGE_FIELD_SET_NAME} fields, at the
 * version each declares. It is the set every path that authors nothing
 * selects from, at {@link DEFAULT_PRECISION_FLOOR_SELECTION}, so a zero-setup
 * exchange, the `alcove init` template, and the web invite editors' starting
 * point all cite the same rules.
 *
 * Composed from the declarations above rather than replacing them: the
 * built-in sets' drift and zero-setup checks read those declarations out
 * of this file by name and require each to be a literal
 * (`scripts/lib/builtInRuleSets.mjs`).
 *
 * Frozen through every level, and this object with it. The reference, the
 * fields, and the keys are all aliased into every terms document derived
 * from the set ({@link linkageTermsFromRuleSet}) and from there into each
 * party's exchange record, so a single in-place edit of a name, a version,
 * a constraint, or a key element would rewrite the built-in set in every
 * document the process later derives, and in every record written from
 * one -- without touching the declarations above that the drift checks
 * pin. The rules hold the same weight the citation does: they are what
 * {@link checkLinkageRuleSetCitation} compares a cited document against,
 * so an edited set decides later verdicts too. Freezing makes such an
 * edit throw instead, at this composition, because those declarations
 * must stay plain literals for the checks named above to read them.
 */
export const DEFAULT_LINKAGE_RULE_SET: BuiltInLinkageRuleSet = Object.freeze({
  reference: Object.freeze({
    fieldSet: Object.freeze({
      name: DEFAULT_LINKAGE_FIELD_SET_NAME,
      version: DEFAULT_LINKAGE_FIELD_SET_VERSION,
    }),
    keySet: Object.freeze({
      name: DEFAULT_LINKAGE_KEY_SET_NAME,
      version: DEFAULT_LINKAGE_KEY_SET_VERSION,
    }),
  }),
  linkageFields: frozenThroughContents(DEFAULT_LINKAGE_FIELDS),
  linkageKeys: frozenThroughContents(DEFAULT_LINKAGE_KEYS),
  ruleBands: frozenThroughContents(DEFAULT_LINKAGE_RULE_BANDS),
});

/** A precision floor: the lowest band whose rules are selected. */
export type PrecisionFloor = PrecisionBand;

/**
 * What an author chooses the catalog's rules by: the floor, and the answer to
 * whether both files draw their members from one state or one metropolitan
 * area, which admits the rules with that coverage condition.
 */
export interface PrecisionFloorSelection {
  floor: PrecisionFloor;
  oneStateOrMetroArea: boolean;
}

/** The selection every path that authors nothing runs: the 95% floor, with
 * the coverage question answered yes. */
export const DEFAULT_PRECISION_FLOOR_SELECTION: PrecisionFloorSelection =
  Object.freeze({ floor: 95, oneStateOrMetroArea: true });

/**
 * The rules `selection` picks for a file, as every screen that names a quick
 * exchange's selection words it: the console's confirm step and the CLI's
 * display before the run. Starts lowercase, for use after a label.
 */
export function precisionFloorSelectionStatement(
  selection: PrecisionFloorSelection,
): string {
  const coverage = selection.oneStateOrMetroArea
    ? "for two files that both draw their members from one state or one " +
      "metropolitan area"
    : "leaving out the rules that need both files to draw their members " +
      "from one state or one metropolitan area";
  return (
    `the built-in rules at ${String(selection.floor)}% precision and above ` +
    `that your file supplies, ${coverage}`
  );
}

/**
 * The keys of `ruleSet` that `selection` selects, in the set's cascade order:
 * each key whose band is at or above the floor, less a key with the
 * `one_state_or_metro_area` coverage condition where the answer is no. A set
 * with no bands has nothing to select by, and answers all of its keys.
 */
export function linkageKeysAtPrecisionFloor(
  ruleSet: BuiltInLinkageRuleSet,
  selection: PrecisionFloorSelection,
): Array<LinkageKey> {
  if (ruleSet.ruleBands === undefined) return [...ruleSet.linkageKeys];
  const bandByRule = new Map(ruleSet.ruleBands.map((b) => [b.rule, b]));
  return ruleSet.linkageKeys.filter((key) => {
    const band = bandByRule.get(key.name);
    return (
      band !== undefined &&
      band.band >= selection.floor &&
      (band.coverage === "any" || selection.oneStateOrMetroArea)
    );
  });
}

/**
 * Every rule set this build ships, in the order a citation is resolved
 * against them: the sets a document may cite and this build can check a
 * citation against, and the sets a derivation may draw its rules from. A
 * set outside this list is one nothing here resolves -- held and
 * caveated rather than guessed at.
 *
 * The order decides which set a document drawn from more than one is
 * cited to ({@link linkageRuleSetReferenceFor}), so it is the list's own
 * declaration order rather than a property of the sets.
 *
 * Frozen, as each set it holds is: the sets are aliased into every terms
 * document derived from one and into every verdict reached against one,
 * so a replaced entry would decide later derivations and verdicts alike.
 */
export const BUILT_IN_LINKAGE_RULE_SETS: ReadonlyArray<BuiltInLinkageRuleSet> =
  Object.freeze([DEFAULT_LINKAGE_RULE_SET]);

/**
 * Whether `rules` were drawn from `ruleSet`: every key byte-identical to a
 * key the set declares, in the set's own cascade order, and every field
 * byte-identical to a distinct field it declares. A narrowed emission
 * passes -- what an input file cannot supply is left out -- while an
 * added, edited, or repeated key or field, and a reordered cascade, do
 * not.
 *
 * Order is part of the answer for the keys and not for the fields, for
 * the same reason each set versions its own content: key order is cascade
 * order, so moving one changes which key claims a record more than one
 * would match, whereas the field array's order is not significant.
 *
 * This is what keeps a citation accurate where rules are edited after
 * being seeded from a set -- the web invite editors' path. A received
 * document's citation is judged by {@link checkLinkageRuleSetCitation}
 * instead, which annotates it with a verdict rather than rewriting or
 * dropping it: the reference stays that party's own statement about its
 * own rules.
 *
 * Compared through the canonical encoding, the same equality the two
 * parties' terms are compared under, so property order does not enter
 * it. A value outside the canonical domain (a transform param beyond the
 * safe integer range) cannot be compared and answers `false` rather than
 * throwing: such rules are not the built-in set, which holds no such
 * value.
 */
export function isDrawnFromLinkageRuleSet(
  ruleSet: BuiltInLinkageRuleSet,
  rules: Pick<LinkageTerms, "linkageFields" | "linkageKeys">,
): boolean {
  return (
    fieldsDrawnFromSet(ruleSet.linkageFields, rules.linkageFields) &&
    keysDrawnFromSet(ruleSet.linkageKeys, rules.linkageKeys)
  );
}

/**
 * `value` in the canonical encoding, the equality the two parties' terms
 * are compared under, or `null` when it holds a value outside the
 * canonical domain (a transform param beyond the safe integer range) and
 * so cannot be compared. Every comparison here reads `null` as no match
 * rather than throwing, the answer {@link isDrawnFromLinkageRuleSet} gives
 * such rules: the built-in sets hold no such value, so nothing incomparable
 * is one of them.
 *
 * @internal exported for the web editor's key reconciliation, which
 * matches a draft key to an offer under this same equality.
 */
export function encodeForComparison(value: unknown): string | null {
  try {
    return canonicalString(value);
  } catch {
    return null;
  }
}

/** The field half of {@link isDrawnFromLinkageRuleSet}: every candidate field
 * byte-identical to a distinct declared field, order not significant. */
function fieldsDrawnFromSet(
  declaredFieldList: ReadonlyArray<LinkageField>,
  fields: ReadonlyArray<LinkageField>,
): boolean {
  // Each declaration is consumed on match, so a field the candidate repeats meets
  // no declaration the second time -- the same answer the key cursor gives a
  // repeated key, rather than a lookup that would accept the repeat.
  const declaredFields = new Map(
    declaredFieldList.map(
      (field) => [field.name, encodeForComparison(field)] as const,
    ),
  );
  for (const field of fields) {
    const declared = declaredFields.get(field.name);
    if (declared === undefined || declared === null) return false;
    if (encodeForComparison(field) !== declared) return false;
    declaredFields.delete(field.name);
  }
  return true;
}

/** The key half of {@link isDrawnFromLinkageRuleSet}: every candidate key
 * byte-identical to a declared key, in the set's own cascade order. */
function keysDrawnFromSet(
  declaredKeyList: ReadonlyArray<LinkageKey>,
  keys: ReadonlyArray<LinkageKey>,
): boolean {
  // Walk the set's keys and the candidate's together: each candidate key must
  // meet the next set key that matches it, so a key the set does not declare, a
  // repeated key, and a pair in the wrong cascade order all run the cursor off
  // the end.
  const declaredKeys = declaredKeyList.map(encodeForComparison);
  let cursor = 0;
  for (const key of keys) {
    const encoded = encodeForComparison(key);
    if (encoded === null) return false;
    let matched = false;
    while (cursor < declaredKeys.length && !matched) {
      matched = declaredKeys[cursor] === encoded;
      cursor += 1;
    }
    if (!matched) return false;
  }
  return true;
}

/**
 * One party's verdict on one half of a rule-set citation, reached by this build
 * against the sets it ships.
 *
 * - `consistent` -- the cited half names a set this build ships, and the rules
 *   the same document declares for that half are drawn from it.
 * - `contradicted` -- the cited half names a set this build ships, and the
 *   declared rules are not drawn from it: the citation states a provenance the
 *   rules beside it do not have.
 * - `unchecked` -- the cited half names a set this build does not ship, so
 *   nothing here resolves the name and no comparison was made.
 *
 * Three states rather than two because the absence of `contradicted` must
 * never be treated as verification: a build that cannot resolve a name has
 * checked nothing, which is a different statement from having checked and
 * found the rules to match.
 */
export type LinkageRuleSetCitationVerdict =
  "consistent" | "contradicted" | "unchecked";

/**
 * A verdict per citation half. The two halves are decided independently, for the
 * reason they are named and versioned independently: a document can truthfully
 * cite the built-in field set while its keys are not the built-in key set.
 */
interface LinkageRuleSetCitationVerdicts {
  /** The verdict on the set the declared linkage fields are cited to. */
  fieldSet: LinkageRuleSetCitationVerdict;
  /** The verdict on the set the declared linkage keys are cited to. */
  keySet: LinkageRuleSetCitationVerdict;
}

/** Whether two set identities name the same set: both the name and the content
 * version, since a name without its version identifies no fixed content. */
function namesSameSet(
  cited: LinkageSetIdentity,
  shipped: LinkageSetIdentity,
): boolean {
  return cited.name === shipped.name && cited.version === shipped.version;
}

/**
 * The built-in rules a citation's two halves name, each half either
 * resolved to the rules a shipped set declares for it or left
 * unresolved.
 */
export interface ResolvedLinkageRuleSetCitation {
  /** The linkage fields of the set the cited field set names, or
   * `undefined` where no shipped set declares that field set. */
  linkageFields: ReadonlyArray<LinkageField> | undefined;
  /** The linkage keys of the set the cited key set names, or `undefined`
   * where no shipped set declares that key set. */
  linkageKeys: ReadonlyArray<LinkageKey> | undefined;
}

/**
 * What `citation` names among `ruleSets`, one half at a time: the linkage
 * fields of the set declaring the cited field set, and the linkage keys of
 * the set declaring the cited key set. The single place a cited name is
 * turned into rules, so every reader of a citation resolves it alike.
 *
 * Each half is matched on its name AND version, since a name without its
 * content version identifies no fixed content, and each half is resolved
 * on its own: a document can cite a shipped field set while its key set is
 * one this build does not ship, and the halves may resolve to different
 * sets. An unresolved half is `undefined` rather than a fallback set --
 * nothing here guesses at a name it does not ship, and a caller decides
 * what an unresolvable half means for it.
 *
 * Returns rules rather than the sets holding them, so a caller cannot read
 * one half's rules off the set the other half resolved to.
 *
 * @param ruleSets the sets to resolve against, this build's own
 * ({@link BUILT_IN_LINKAGE_RULE_SETS}) by default.
 */
export function resolveLinkageRuleSetCitation(
  citation: LinkageRuleSetReference,
  ruleSets: ReadonlyArray<BuiltInLinkageRuleSet> = BUILT_IN_LINKAGE_RULE_SETS,
): ResolvedLinkageRuleSetCitation {
  return {
    linkageFields: ruleSets.find((ruleSet) =>
      namesSameSet(citation.fieldSet, ruleSet.reference.fieldSet),
    )?.linkageFields,
    linkageKeys: ruleSets.find((ruleSet) =>
      namesSameSet(citation.keySet, ruleSet.reference.keySet),
    )?.linkageKeys,
  };
}

/**
 * The set among `ruleSets` that `reference` names whole: the one whose field
 * set and key set identities are both the named ones, and `undefined` where no
 * single set declares both. This is how an authoring path chooses which
 * built-in rules it derives terms from, where
 * {@link linkageTermsFromRuleSet} then builds the document.
 *
 * Both halves against one set, where {@link resolveLinkageRuleSetCitation}
 * resolves each half on its own: a citation records where a document's rules
 * came from and may name two sets, while a choice selects rules to derive and
 * takes one set's fields, keys, and reference together.
 *
 * Matched on name AND version per half, since a name without its content
 * version identifies no fixed content. A reference naming no shipped set
 * answers `undefined` rather than the default set: nothing here guesses at a
 * name it does not ship, and what an unknown name means is the caller's
 * decision.
 *
 * @param ruleSets the sets the reference is looked up in, this build's own
 * ({@link BUILT_IN_LINKAGE_RULE_SETS}) by default.
 */
export function findBuiltInLinkageRuleSet(
  reference: LinkageRuleSetReference,
  ruleSets: ReadonlyArray<BuiltInLinkageRuleSet> = BUILT_IN_LINKAGE_RULE_SETS,
): BuiltInLinkageRuleSet | undefined {
  return ruleSets.find(
    (ruleSet) =>
      namesSameSet(reference.fieldSet, ruleSet.reference.fieldSet) &&
      namesSameSet(reference.keySet, ruleSet.reference.keySet),
  );
}

/**
 * This build's verdict on `citation`, the rule set `rules` are cited to,
 * one half at a time.
 *
 * Total over a citation that exists: a caller renders or records a verdict
 * exactly where it has a citation to be about, so the absence of one is
 * the caller's own branch rather than a fourth state here.
 *
 * The verdict is the checking build's own check, made at the moment it is
 * asked for and against the sets that build ships. It is not a property
 * of the terms and not a cross-party agreement: two parties on different
 * builds may reach different verdicts on one document, since a set one of
 * them ships is a set the other may not.
 *
 * Resolution is {@link resolveLinkageRuleSetCitation}'s, per half and
 * against every set in `ruleSets`: a half naming one of them is compared
 * against that set's own rules, and a half naming none is `unchecked`.
 * Nothing here resolves a partner's set name to content -- an
 * unresolvable name stays unresolvable, held and caveated rather than
 * guessed at.
 *
 * What "drawn from" means is exactly {@link isDrawnFromLinkageRuleSet}'s
 * answer for that half, so this widens and narrows nothing: a narrowed
 * emission is `consistent`, while an added, edited, or repeated rule, or
 * a reordered cascade, is `contradicted`.
 *
 * @param ruleSets the sets the citation is resolved and compared against,
 * this build's own ({@link BUILT_IN_LINKAGE_RULE_SETS}) by default.
 */
export function checkLinkageRuleSetCitation(
  citation: LinkageRuleSetReference,
  rules: Pick<LinkageTerms, "linkageFields" | "linkageKeys">,
  ruleSets: ReadonlyArray<BuiltInLinkageRuleSet> = BUILT_IN_LINKAGE_RULE_SETS,
): LinkageRuleSetCitationVerdicts {
  const shipped = resolveLinkageRuleSetCitation(citation, ruleSets);
  return {
    fieldSet:
      shipped.linkageFields === undefined
        ? "unchecked"
        : fieldsDrawnFromSet(shipped.linkageFields, rules.linkageFields)
          ? "consistent"
          : "contradicted",
    keySet:
      shipped.linkageKeys === undefined
        ? "unchecked"
        : keysDrawnFromSet(shipped.linkageKeys, rules.linkageKeys)
          ? "consistent"
          : "contradicted",
  };
}

/**
 * The citation `rules` are entitled to: the reference of the first set in
 * `ruleSets` the rules were drawn from, and `undefined` where they were
 * drawn from none of them -- edited, reordered, authored from scratch, or
 * declaring no key. The single place a builder that lets an operator edit
 * seeded rules decides whether the result may still cite the set it
 * started from.
 *
 * One set's whole reference, never a pair of halves from two sets: a
 * citation names where the rules came from, and rules drawn from no one
 * set came from no set the list holds. Where several sets would each
 * answer -- a narrowed emission both declare -- the list's order decides,
 * so the citation is stable across runs rather than a property of the
 * rules alone.
 *
 * A citation asserts that the keys came from the named set, so rules
 * declaring none hold no provenance to claim: they are drawn from every
 * set vacuously, and the predicate alone would hand them the first set's
 * citation over whatever field declarations outlived their keys. A
 * builder reaches that state as an intermediate (disabling every key in
 * the web editor), so the keyless case is excluded here rather than left
 * to the downstream rejection.
 *
 * @param ruleSets the sets the rules may be cited to, this build's own
 * ({@link BUILT_IN_LINKAGE_RULE_SETS}) by default.
 */
export function linkageRuleSetReferenceFor(
  rules: Pick<LinkageTerms, "linkageFields" | "linkageKeys">,
  ruleSets: ReadonlyArray<BuiltInLinkageRuleSet> = BUILT_IN_LINKAGE_RULE_SETS,
): LinkageRuleSetReference | undefined {
  if (rules.linkageKeys.length === 0) return undefined;
  return ruleSets.find((ruleSet) => isDrawnFromLinkageRuleSet(ruleSet, rules))
    ?.reference;
}

/**
 * Returns a {@link LinkageTerms} drawn from `ruleSet`, citing it: the terms
 * a party runs when it authors none of its own.
 *
 * The keys are those `selection` selects ({@link linkageKeysAtPrecisionFloor}).
 * When metadata are provided, only those whose elements can be satisfied by
 * the present columns are included; metadata declaring no column satisfies
 * none. Either way the
 * emitted keys are a subset of the set, never an addition to it: what the
 * input supports narrows the set, and nothing widens it -- which is what
 * makes the emitted citation accurate, an upper bound on what was tried
 * rather than a claim that every key ran.
 *
 * Narrowed all the way to no key, the citation goes with the keys: it
 * asserts where the keys came from, so a derivation emitting none has no
 * provenance to claim -- the same exclusion
 * {@link linkageRuleSetReferenceFor} makes.
 */
export function linkageTermsFromRuleSet(
  ruleSet: BuiltInLinkageRuleSet,
  identity: string | undefined,
  metadata?: Metadata,
  selection: PrecisionFloorSelection = DEFAULT_PRECISION_FLOOR_SELECTION,
): LinkageTerms {
  let linkageKeys = linkageKeysAtPrecisionFloor(ruleSet, selection);
  if (metadata !== undefined) {
    // The types resolveFieldColumns binds with no authored standardization: a
    // key resting on any other type would bind nothing at exchange time, so it
    // is dropped here instead of built unusable.
    const availableTypes = fieldTypesSuppliedByDefault(metadata);
    linkageKeys = linkageKeys.filter((key) =>
      key.elements.every((el) => availableTypes.has(el.field as SemanticType)),
    );
  }

  const referencedFields = referencedLinkageFieldNames(linkageKeys);
  const linkageFields = ruleSet.linkageFields.filter((f) =>
    referencedFields.has(f.name),
  );

  return {
    version: "1.0.0",
    // Omitted rather than emptied when the caller has no label: `identity` is
    // optional in the terms, and a party that supplied none sends none.
    ...(identity !== undefined && { identity }),
    date: new Date().toISOString().substring(0, 10),
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: {
      expectsOutput: true,
      shareWithPartner: true,
    },
    deduplicate: false,
    linkageFields,
    linkageKeys,
    ...(linkageKeys.length > 0 && { linkageRuleSet: ruleSet.reference }),
  };
}

/**
 * Returns a default {@link LinkageTerms} suitable for quick exchanges when no
 * linkage terms are specified explicitly: {@link linkageTermsFromRuleSet} over
 * {@link DEFAULT_LINKAGE_RULE_SET} at {@link DEFAULT_PRECISION_FLOOR_SELECTION},
 * what every path that authors nothing runs.
 */
export function getDefaultLinkageTerms(
  identity: string | undefined,
  metadata?: Metadata,
): LinkageTerms {
  return linkageTermsFromRuleSet(DEFAULT_LINKAGE_RULE_SET, identity, metadata);
}

/**
 * The contact and location types, phone, email and ZIP, whose values many
 * people can share (a shelter's phone, a site's ZIP code). The catalog matches
 * on each only beside a name and a date, so a file can hold one of these
 * columns while the terms derived from it declare no field for it.
 */
export const CONTACT_AND_LOCATION_FIELD_TYPES = [
  "phone_number",
  "email_address",
  "zip_code",
] as const satisfies ReadonlyArray<LinkageField["type"]>;

/**
 * Whether a semantic type can be a linkage field's type. `identifier` and `other`
 * are the non-matchable types -- a {@link LinkageField} is never one of them -- so
 * they are excluded. Written as the negation of those two literals (rather than an
 * allowlist) so that adding a non-matchable semantic type without excluding it here
 * fails to narrow to `LinkageField["type"]` and breaks the build, rather than
 * silently declaring an invalid field.
 */
function isLinkageFieldType(type: SemanticType): type is LinkageField["type"] {
  return type !== "identifier" && type !== "other";
}

// The type of the field an explicit transformation declares: its input
// column's, unless the output names a default field derived from a column of
// that type (`ssn4` from an `ssn` column), whose type the field keeps.
function explicitFieldType(
  transformation: StandardizationTransformation,
  columnType: LinkageField["type"],
): LinkageField["type"] {
  const derived = DEFAULT_LINKAGE_FIELDS.find(
    (def) =>
      def.name === transformation.output &&
      def.type !== columnType &&
      fieldSourceColumnTypes(def.type).includes(columnType),
  );
  return derived?.type ?? columnType;
}

/**
 * The linkage fields a `(metadata, standardization)` pair declares: the
 * single source the web invite editors derive both their pickable field
 * list and the emitted `linkageFields` from, replacing the
 * `getDefaultLinkageTerms(metadata).linkageFields` derivation. That
 * derivation collapses to one field per semantic type, so it cannot
 * express two fields of the same type -- e.g. a maiden and a current name
 * -- bound to different columns; this can.
 *
 * Per present semantic type -- that of a `role: linkage` column in
 * `metadata`, one an explicit transformation declares, and, with no
 * `standardization`, one {@link fieldTypesSuppliedByDefault} derives:
 *
 * - When `standardization` holds one or more transformations declaring
 *   that type, one field is emitted per transformation: `name` is the
 *   transformation's `output`, `type` is the input column's type -- or the
 *   default field's, for an output naming a default field derived from a
 *   column of that type (`ssn4` from an `ssn` column) -- and `constraints`
 *   are that type's default constraints (a same-typed field is bounded like
 *   the default one). The
 *   distinct `output` names -- the standardization schema forbids a
 *   duplicate `output` -- are what let two same-typed fields coexist, and
 *   the explicit `input` each transformation holds is what binds them to
 *   different columns at exchange time (see {@link resolveFieldColumns}).
 * - Otherwise a single field is emitted for the type: the type's default
 *   field ({@link DEFAULT_LINKAGE_FIELDS}) when it has one, else a
 *   synthetic default named for the type (`name` and `type` both the
 *   semantic type, no constraints). The synthetic case is what lets a
 *   column of a matchable type the built-in fields do not declare be
 *   referenced as a linkage field
 *   with no authored cleaning -- it resolves to that column by type at
 *   exchange time. A metadata-only pair (no `standardization`) thus
 *   yields exactly one field per present matchable type, and for the
 *   default types alone is byte-identical to the default per-type field
 *   set, so the guided path is unchanged.
 *
 * A transformation whose `input` is a non-`linkage`
 * (identifier/payload/ignored) or absent column declares no field:
 * matching participation requires `role: linkage`, which wins over an
 * explicit binding in {@link resolveFieldColumns}, so the field would
 * resolve to no column anyway.
 *
 * Field order follows {@link DEFAULT_LINKAGE_FIELDS}, with a default
 * type's explicit fields emitted in `standardization` order at that
 * type's position; any explicit-only type (one with no default field)
 * follows in `standardization` order, then any
 * present matchable type with no field yet (the synthetic case) in
 * metadata order. The returned set is the candidate fields keys may
 * reference; a caller that emits final terms filters it to the fields
 * its enabled keys reference (as `buildAdvancedTerms` does). Pure.
 */
export function authoredLinkageFields(
  metadata: Metadata,
  standardization?: Standardization,
): LinkageField[] {
  const columnByName = new Map(metadata.map((column) => [column.name, column]));
  // Explicit transformations grouped by their input column's semantic type. A
  // transformation is skipped when its input column is absent, not `role: linkage`
  // (only a linkage column participates in matching -- the role wins over an
  // explicit binding, see resolveFieldColumns), or of a type that cannot be a
  // linkage field (`identifier` / `other` are not matchable), so none of these
  // declares a field.
  const explicitByType = new Map<
    LinkageField["type"],
    StandardizationTransformation[]
  >();
  for (const transformation of standardization ?? []) {
    const column = columnByName.get(transformation.input);
    if (column === undefined || column.role !== "linkage") continue;
    if (!isLinkageFieldType(column.type)) continue;
    const fieldType = explicitFieldType(transformation, column.type);
    const forType = explicitByType.get(fieldType) ?? [];
    forType.push(transformation);
    explicitByType.set(fieldType, forType);
  }

  const presentTypes = new Set<SemanticType>([
    ...(standardization === undefined
      ? fieldTypesSuppliedByDefault(metadata)
      : metadata.filter((c) => c.role === "linkage").map((c) => c.type)),
    ...explicitByType.keys(),
  ]);

  const fields: LinkageField[] = [];
  const emittedTypes = new Set<SemanticType>();
  // Default-typed fields first, in DEFAULT_LINKAGE_FIELDS order, so a
  // no-standardization pair yields exactly the default per-type set.
  for (const def of DEFAULT_LINKAGE_FIELDS) {
    if (!presentTypes.has(def.type)) continue;
    emittedTypes.add(def.type);
    const explicit = explicitByType.get(def.type);
    if (explicit === undefined) {
      fields.push(def);
      continue;
    }
    for (const transformation of explicit)
      fields.push({
        name: transformation.output,
        type: def.type,
        ...(def.constraints !== undefined && { constraints: def.constraints }),
      });
  }
  // Explicit fields for a present type with no default field: there are no
  // default constraints to inherit.
  for (const [type, transformations] of explicitByType) {
    if (emittedTypes.has(type)) continue;
    emittedTypes.add(type);
    for (const transformation of transformations)
      fields.push({ name: transformation.output, type });
  }
  // A present matchable type with neither a default field nor any authored
  // transformation still declares one field: a synthetic default named for the
  // type, in metadata order. Without this a column of a matchable type
  // DEFAULT_LINKAGE_FIELDS does not declare, roled `linkage`, would be invisible
  // to the key editor and unmatchable -- even though resolveFieldColumns binds such
  // a field to that column (identity transform) at exchange time. One field per type
  // (deduped via emittedTypes); a second column of the type is matched by authoring a
  // distinct transformation, the same way two same-typed default fields are split.
  for (const column of metadata) {
    if (column.role !== "linkage") continue;
    if (!isLinkageFieldType(column.type)) continue;
    if (emittedTypes.has(column.type)) continue;
    emittedTypes.add(column.type);
    fields.push({ name: column.type, type: column.type });
  }
  return fields;
}
