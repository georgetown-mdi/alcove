// "Does a cleaned value meet a field's declared constraints?" -- the value-level
// companion to validateStandardizationAgainstTerms (which checks only NAMES: that
// standardization outputs map to declared fields, and that step function names are
// known). The web's constraint badges and the CLI's prepare-path warnings run
// ONE implementation.
//
// Advisory throughout, matching the LinkageField constraint contract ("the
// application warns if violated but does not enforce them",
// config/linkageTermsSchema.ts): nothing here throws or rejects a value; each
// surface decides how to present the result (a web badge, a CLI warning line).
//
// Coverage is authoritative: every constraint with a CLEAN value-level test is
// checked, and one that has none is left UNFLAGGED rather than guessed at, so
// a warning never fires on a value the check cannot actually judge.
//
//   - exclude (all field types), allowedCharacters (name fields), date_of_birth
//     validOnly, ssn validOnly: checked.
//   - ssn4 validOnly: checked for the ONE SSA structural rule a bare last-four
//     can be judged against -- the serial is not 0000. The last four digits ARE
//     the serial; the area/group rules and the 9-digit-only checks have no
//     last-four analogue (see isStructurallyValidSsn4).
//   - affixesAllowed (name fields): NOT checked, by design. Whether affixes
//     were removed is a pipeline choice, not a defect of the value: a residual-
//     honorific test would collide with legitimate name values ("Judge" and
//     "Miss" are real surnames), so there is no clean value-level property to
//     flag. This would need revisiting only if affix membership became an
//     exact, collision-free set.

import { compileLinearRegex } from "./utils/linearRegex.js";
import type { CompiledLinearRegex } from "./utils/linearRegex.js";
import { MAX_LINKAGE_ENTRIES } from "./config/linkageTermsBounds.js";
import {
  allowedCharactersPattern,
  patternRefusal,
} from "./config/transformRegexDialect.js";
import { referencedLinkageFieldNames } from "./config/linkageTermsSchema.js";
import type {
  LinkageField,
  LinkageTerms,
} from "./config/linkageTermsSchema.js";
import { isCalendarDateValid } from "./utils/calendarDate.js";
import { DistinctValues, SCAN_UP_TO_VALUES } from "./utils/distinctValues.js";
import type { StandardizedDataset } from "./standardization.js";

/**
 * The kind of value-level constraint a cleaned value violated. A stable,
 * partner-independent discriminant a surface can branch on; the fixed
 * {@link ConstraintViolation.label} / `detail` copy is keyed off it.
 *
 * - `excluded` -- the value is on the field's agreed `exclude` denylist (any
 *   field type).
 * - `disallowedCharacters` -- a name value includes a character outside the
 *   field's `allowedCharacters` class.
 * - `invalidDate` -- a `date_of_birth` value in canonical YYYYMMDD form names no
 *   real calendar day (under `validOnly`).
 * - `invalidSsn` -- a 9-digit `ssn` value breaks an SSA structural rule (under
 *   `validOnly`).
 * - `invalidSsn4` -- a 4-digit `ssn4` value is the all-zero serial 0000, the one
 *   SSA structural rule a bare last-four can be judged against (under `validOnly`).
 */
type ConstraintViolationKind =
  | "excluded"
  | "disallowedCharacters"
  | "invalidDate"
  | "invalidSsn"
  | "invalidSsn4";

/**
 * A single value-level constraint violation: an advisory signal that a
 * cleaned value does not meet one of a field's declared constraints. The `kind`
 * is a stable discriminant; `label` and `detail` are FIXED copy keyed off it --
 * never a partner-controlled value -- so a surface may render them verbatim (the
 * web workbench badge) or print them (the CLI), or switch on `kind` for its own
 * wording. An empty result from {@link checkValueConstraints} means the value
 * conforms to every constraint that has a clean value-level test.
 */
interface ConstraintViolation {
  /** Stable, partner-independent discriminant; see {@link ConstraintViolationKind}. */
  kind: ConstraintViolationKind;
  /** Short fixed badge caption (e.g. "excluded value"). */
  label: string;
  /** One-line fixed plain-language explanation of the violation. */
  detail: string;
}

/** Whether `value` contains only characters in the field's `allowedCharacters`
 * class. `allowedCharacters` is partner-controlled (it arrives in the invitation
 * token), and the linkage-terms schema's regex walk ({@link
 * findNameClassRefusal}) checks that the pattern this check compiles ({@link
 * allowedCharactersPattern}) compiles within the transform patterns'
 * weighted-size cap -- not that the class cannot break out of its brackets. A
 * crafted value can close the class and inject regex structure (e.g.
 * `x](a+)+b[y`).
 *
 * Two hazards, both guarded here:
 *
 * (1) ReDoS: the class is compiled under the linear-time engine the
 * transform-regex paths use ({@link compileLinearRegex}, re2js), so no partner
 * pattern reaches the backtracking native engine. A pattern {@link
 * patternRefusal} refuses is treated as uncheckable (no violation,
 * fail-open). The schema refuses the same pattern at parse, but a caller may
 * pass terms that never went through the parse, so each class's verdict,
 * refused or compiled, is cached by {@link allowedCharactersMatcher}: a class
 * is checked and compiled once however many values the check sees.
 *
 * (2) Warning suppression, three sub-cases:
 *   - A breakout that injects a multi-character span or an empty-matchable
 *     alternation branch (`a]|.*[b`, `(a+)+`) is closed by testing each value
 *     one code point at a time as a FULL, anchored match (re2js `matches()`),
 *     not an unanchored find.
 *   - A leading `^`, which re2js treats as class negation, is closed by
 *     escaping it (and a following `-`) to a literal; a class that no longer
 *     compiles once escaped is refused at parse.
 *   - A class or branch that genuinely admits the single code point (a
 *     shorthand or Unicode property class, or an effective allow-all reached
 *     via breakout) is accepted as a limit rather than closed: it is
 *     indistinguishable from a legitimate permissive class, and since this
 *     check only warns rather than blocking, the consequence is a suppressed
 *     advisory badge, never a data-filtering or match-correctness effect.
 *
 * Every sub-case is pinned by tests in valueConstraints.test.ts. For a
 * legitimate class the per-code-point test is exactly `^[allowed]*$` (every
 * character must be in the class). The empty string trivially conforms.
 */
function withinAllowedCharacters(value: string, allowed: string): boolean {
  const oneOf = allowedCharactersMatcher(allowed);
  if (oneOf === null) return true;
  for (const character of value) if (!oneOf.matches(character)) return false;
  return true;
}

/** Upper bound on distinct classes held in {@link allowedCharactersMatchers};
 * on overflow the oldest entry is evicted. One terms set declares at most
 * {@link MAX_LINKAGE_ENTRIES} fields, so every class of one terms set fits. */
const ALLOWED_CHARACTERS_CACHE_MAX = MAX_LINKAGE_ENTRIES;

/** Each `allowedCharacters` class's compiled matcher, or `null` for a class
 * {@link patternRefusal} refuses, keyed by the class text. */
const allowedCharactersMatchers = new Map<string, CompiledLinearRegex | null>();

/** The compiled matcher for an `allowedCharacters` class, or `null` when its
 * pattern is refused. The refusal check and the compile run once per class;
 * a refused class is cached as `null`, so it is never compiled again. */
function allowedCharactersMatcher(allowed: string): CompiledLinearRegex | null {
  const cached = allowedCharactersMatchers.get(allowed);
  if (cached !== undefined) return cached;
  const pattern = allowedCharactersPattern(allowed);
  const matcher =
    patternRefusal(pattern) === undefined ? compileLinearRegex(pattern) : null;
  if (allowedCharactersMatchers.size >= ALLOWED_CHARACTERS_CACHE_MAX) {
    const oldest = allowedCharactersMatchers.keys().next().value;
    if (oldest !== undefined) allowedCharactersMatchers.delete(oldest);
  }
  allowedCharactersMatchers.set(allowed, matcher);
  return matcher;
}

/** Whether a standardized value is a valid calendar date in canonical YYYYMMDD
 * form -- the output the default `date_of_birth` pipeline produces. A value not in
 * that form is not flagged (the operator may target a different output format, and
 * a false "invalid date" badge would mislead); only an 8-digit value that names no
 * real calendar day is. */
function isValidStandardizedDate(value: string): boolean {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (match === null) return true;
  const [, year, month, day] = match;
  return isCalendarDateValid(year, month, day);
}

/** Whether a 9-digit value satisfies the SSA structural rules: area not 000 or
 * 666 and below 900, group not 00, serial not 0000. A value that is not exactly 9
 * digits is left to the format-shaping pipeline and not flagged here. */
function isStructurallyValidSsn(value: string): boolean {
  if (!/^\d{9}$/.test(value)) return true;
  const area = Number(value.slice(0, 3));
  const group = Number(value.slice(3, 5));
  const serial = Number(value.slice(5, 9));
  return (
    area !== 0 && area !== 666 && area < 900 && group !== 0 && serial !== 0
  );
}

/** Whether a 4-digit `ssn4` (last-four / serial) value satisfies the one SSA
 * structural rule a bare last-four can be judged against: the serial is not 0000.
 * The last four digits of an SSN are the serial, and the SSA never issues serial
 * 0000; the area/group rules and the 9-digit-only checks have no last-four
 * analogue, so 0000 is the whole judgeable surface. A value that is not exactly 4
 * digits is left to the format-shaping pipeline and not flagged, mirroring the
 * 9-digit scoping of {@link isStructurallyValidSsn}. */
function isStructurallyValidSsn4(value: string): boolean {
  if (!/^\d{4}$/.test(value)) return true;
  return value !== "0000";
}

// Memoized `exclude` denylists, keyed by the constraint's `exclude` ARRAY
// identity, so the membership test is an O(1) indexed lookup rather than an O(n)
// `Array.includes` scan. The dataset sweep (summarizeDatasetConstraintViolations)
// calls checkValueConstraints once per produced value per row against the SAME
// field -- hence the same `exclude` array reference -- so without this a
// hostile-but-schema-valid denylist (partner-controlled, count-bounded only at the
// generous MAX_EXCLUDE_ENTRIES) would re-scan up to that bound on every row, a
// per-row cost unbounded by row count over a large dataset. This is the
// exclude-denylist sibling of {@link compiledElementTransforms}' per-row recompile
// guard. A WeakMap keyed on the array releases the index with the terms, and the
// parsed terms reuse the array reference across rows, so a legitimate sweep builds
// each index once; its membership is `===`, as Array.includes is for strings.
const excludeDenylistValues = new WeakMap<readonly string[], DistinctValues>();

function isExcludedValue(
  exclude: readonly string[] | undefined,
  value: string,
): boolean {
  if (exclude === undefined) return false;
  let excludedValues = excludeDenylistValues.get(exclude);
  if (excludedValues === undefined) {
    excludedValues = new DistinctValues({ scanUpTo: SCAN_UP_TO_VALUES });
    for (const excluded of exclude) excludedValues.add(excluded);
    excludeDenylistValues.set(exclude, excludedValues);
  }
  return excludedValues.indexOf(value) !== -1;
}

/**
 * Report which of a linkage `field`'s declared constraints a single cleaned
 * `value` violates -- the value-level constraint check the web workbench renders
 * as badges and the CLI reports as warnings. Returns the violations as advisory
 * signals; an empty array means the value conforms to every constraint that has
 * a clean value-level test. Warn, never block (see the section note above): a
 * violation is reported, never thrown.
 *
 * A constraint with no clean value-level test is intentionally NOT flagged, so a
 * warning never fires on a value the check cannot actually judge: `affixesAllowed`
 * is omitted by design, and `date_of_birth` / `ssn` / `ssn4` `validOnly` only
 * judge a value of the constraint's canonical width (see each helper). The copy
 * returned is fixed and keyed off the violated constraint --
 * never a partner-controlled value -- so it is safe to render or print verbatim.
 */
export function checkValueConstraints(
  field: LinkageField,
  value: string,
): ConstraintViolation[] {
  const constraints = field.constraints;
  if (constraints === undefined) return [];
  const violations: ConstraintViolation[] = [];

  // `exclude` is shared by every constraint shape: the cleaned value must not be
  // one of the listed values. Membership is memoized per denylist (see
  // {@link isExcludedValue}) so a per-row sweep does not re-scan it each row.
  if (isExcludedValue(constraints.exclude, value))
    violations.push({
      kind: "excluded",
      label: "excluded value",
      detail: "This cleaned value is on the agreed excluded-values list.",
    });

  switch (field.type) {
    case "first_name":
    case "last_name": {
      // `affixesAllowed` is intentionally not checked here -- it has no clean
      // value-level test (see the section note).
      const allowed = field.constraints?.allowedCharacters;
      if (allowed !== undefined && !withinAllowedCharacters(value, allowed))
        violations.push({
          kind: "disallowedCharacters",
          label: "disallowed characters",
          detail:
            "This cleaned value contains characters outside the field's allowed set.",
        });
      break;
    }
    case "date_of_birth":
      if (
        field.constraints?.validOnly === true &&
        !isValidStandardizedDate(value)
      )
        violations.push({
          kind: "invalidDate",
          label: "invalid date",
          detail: "This cleaned value is not a valid calendar date.",
        });
      break;
    case "ssn":
      if (
        field.constraints?.validOnly === true &&
        !isStructurallyValidSsn(value)
      )
        violations.push({
          kind: "invalidSsn",
          label: "invalid SSN",
          detail:
            "This cleaned value does not meet the Social Security Administration's structural rules.",
        });
      break;
    case "ssn4":
      if (
        field.constraints?.validOnly === true &&
        !isStructurallyValidSsn4(value)
      )
        violations.push({
          kind: "invalidSsn4",
          label: "invalid SSN (last 4)",
          detail:
            "This cleaned value is the all-zero serial 0000, which the Social Security Administration never issues.",
        });
      break;
    case "phone_number":
    case "email_address":
    case "street_number":
    case "street_name":
    case "unit":
    case "city":
    case "zip_code":
    case "state":
    case "county":
      // Only `exclude` (handled above) has a clean value-level test for these
      // types; nothing further to check.
      break;
  }

  return violations;
}

/**
 * A per-field aggregate of value-level constraint violations across a whole
 * standardized dataset: how many produced values of one linkage field tripped one
 * constraint kind. The CLI's exchange/prepare path reports these (one line per
 * entry) where the web workbench shows per-value badges, so it reports a COUNT --
 * not the offending values, which are the operator's own data and are never echoed
 * into a log.
 */
interface ConstraintViolationSummary {
  /** The linkage field name whose values violated. Partner-controlled on the
   * accept path (adopted from the inviter's terms via
   * {@link deriveAcceptedLinkageTerms}), so a display surface must sanitize it. */
  field: string;
  /** The constraint kind violated; see {@link ConstraintViolationKind}. */
  kind: ConstraintViolationKind;
  /** The fixed badge caption shared with {@link ConstraintViolation.label}, so a
   * caller need not re-derive copy from the kind. */
  label: string;
  /** How many produced values across the dataset tripped this kind. */
  count: number;
}

/**
 * Sweep a {@link StandardizedDataset} and aggregate the value-level constraint
 * violations its produced values trip, per (field, kind), for the linkage fields a
 * linkage key actually references. Runs the same per-value
 * {@link checkValueConstraints} the web workbench renders badges from -- one
 * implementation, so the two surfaces never disagree on whether a given value
 * violates a constraint (they differ in WHICH fields they cover: the web badges
 * the field being edited, this sweep scopes to key-referenced fields, below).
 * Advisory: it only counts; it never throws or rejects a value, and the caller
 * decides how to report the result (the CLI logs a warning per entry and
 * proceeds). An empty result means every produced value conforms.
 *
 * The sweep is scoped to key-referenced fields because the exchange standardizes
 * and consumes only those (via {@link StandardizedKeyIterable}): a constraint
 * violation on a declared field that no linkage key references cannot affect
 * matching, so warning about it would be noise and running its standardization
 * pipeline would be wasted work. A constrained field that no linkage key
 * references therefore contributes nothing and is never standardized by the sweep;
 * so does a referenced field that resolved to no column and is absent from the
 * dataset. Each row's produced value set is checked element-wise, so a fan-out
 * value (e.g. from `split_on`) is judged per candidate. The dataset caches each
 * row's values, so this pre-pass warms the same cache the key-building exchange
 * reuses rather than computing them twice.
 */
export function summarizeDatasetConstraintViolations(
  terms: LinkageTerms,
  dataset: StandardizedDataset,
  rowCount: number,
): ConstraintViolationSummary[] {
  // Scope to the fields a linkage key references -- the only fields the exchange
  // standardizes and consumes; see referencedLinkageFieldNames.
  const referencedFields = referencedLinkageFieldNames(terms.linkageKeys);
  const summaries: ConstraintViolationSummary[] = [];
  for (const field of terms.linkageFields) {
    if (field.constraints === undefined) continue;
    if (!referencedFields.has(field.name)) continue;
    const standardized = dataset.getField(field.name);
    if (standardized === undefined) continue;
    // Tally this field's violations keyed only by the closed `kind` enum, so no
    // partner-controlled field name ever enters a map key. A field is a single
    // iteration of this loop (names are unique across linkageFields), so its
    // counts cannot be misattributed to or from another field's regardless of
    // what bytes its name holds.
    const byKind = new Map<
      ConstraintViolationKind,
      ConstraintViolationSummary
    >();
    for (let index = 0; index < rowCount; index++) {
      for (const value of standardized.get(index)) {
        for (const violation of checkValueConstraints(field, value)) {
          const existing = byKind.get(violation.kind);
          if (existing === undefined)
            byKind.set(violation.kind, {
              field: field.name,
              kind: violation.kind,
              label: violation.label,
              count: 1,
            });
          else existing.count += 1;
        }
      }
    }
    summaries.push(...byKind.values());
  }
  return summaries;
}
