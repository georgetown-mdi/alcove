// The one boundary through which a linkage-terms value, often partner-chosen,
// enters a cross-party compatibility diagnostic. It redacts private-key material,
// replaces control characters, and delimits the value so it cannot read as one of
// Alcove's own clauses; it emits only printable ASCII the display escape leaves
// unchanged. The brand makes a raw value in a diagnostic a compile error
// (docs/spec/CHANNEL_SECURITY.md, Compatibility diagnostic value delimiting).

import { redactPrivateKeyMaterial } from "../utils/sanitizeErrorForDisplay.js";
import { replaceControlCharactersForDisplay } from "../utils/sanitizeForDisplay.js";

declare const compatibilityMessageBrand: unique symbol;

/**
 * First-party text from {@link compatibilityMessage}'s fixed spans, or a terms
 * value passed through {@link quoteTermsValue} or {@link bareTermsValue}. A plain
 * `string` is not assignable to it; it is still a `string`. The phantom brand
 * exists only at compile time and claims delimiting, control-character treatment
 * and redaction, not escaping: confusables and non-ASCII stay for the display sink.
 */
export type CompatibilityMessageFragment = string & {
  readonly [compatibilityMessageBrand]: true;
};

/**
 * The delimiter {@link quoteTermsValue} wraps a terms value in, and the
 * character it doubles inside one. Doubling needs no escape character, so the
 * display escape rewrites nothing this module emits.
 */
export const TERMS_VALUE_DELIMITER = '"';

/**
 * Longest value {@link bareTermsValue} renders undelimited, so an enormous
 * delimiter-free value (a 250-digit semver major) is visibly one value.
 */
export const MAX_BARE_TERMS_VALUE_LENGTH = 64;

/**
 * The charset {@link bareTermsValue} renders undelimited: letters, digits, `.`,
 * `_` and `-`, with at least one digit. It excludes the delimiter and the payload
 * list's punctuation, and the digit keeps a bare value from spelling a
 * connective, since the templates' own words are digit-free (executed in
 * compatibilityMessage.test.ts). The length bound is checked beside it.
 */
export const BARE_TERMS_VALUE_PATTERN = /^[A-Za-z0-9._-]*[0-9][A-Za-z0-9._-]*$/;

/**
 * Render a terms value as one delimited run: private-key material redacted,
 * control characters replaced, wrapped in {@link TERMS_VALUE_DELIMITER} with
 * every delimiter inside doubled, so no value can end its run early. The display
 * cap can still cut a run, leaving it unterminated before
 * `DISPLAY_TRUNCATION_MARKER`. For display only: comparisons use raw values.
 */
export function quoteTermsValue(value: string): CompatibilityMessageFragment {
  const doubled = replaceControlCharactersForDisplay(
    redactPrivateKeyMaterial(value),
  ).replaceAll(
    TERMS_VALUE_DELIMITER,
    TERMS_VALUE_DELIMITER + TERMS_VALUE_DELIMITER,
  );
  return `${TERMS_VALUE_DELIMITER}${doubled}${TERMS_VALUE_DELIMITER}` as CompatibilityMessageFragment;
}

/**
 * Render a semver string or ISO date without delimiters, re-checking the shape
 * on the redacted value, since `validateCompatibility`'s inputs need not be
 * schema-parsed; any other value, a redacted one included, takes
 * {@link quoteTermsValue}.
 */
export function bareTermsValue(value: string): CompatibilityMessageFragment {
  const redacted = redactPrivateKeyMaterial(value);
  if (
    redacted.length <= MAX_BARE_TERMS_VALUE_LENGTH &&
    BARE_TERMS_VALUE_PATTERN.test(redacted)
  )
    return redacted as CompatibilityMessageFragment;
  return quoteTermsValue(redacted);
}

/**
 * Render the payload column names as comma-separated runs, quoted per element so
 * a column named `a,b` stays distinct from columns `a` and `b`, matching the
 * element-wise comparison that found the mismatch.
 */
export function quoteTermsValueList(
  values: readonly string[],
): CompatibilityMessageFragment {
  return values
    .map((value) => quoteTermsValue(value))
    .join(",") as CompatibilityMessageFragment;
}

/**
 * Tagged template composing fixed first-party copy with fragments, keeping the
 * brand that concatenation would drop:
 * ``compatibilityMessage`version mismatch: yours is ${bareTermsValue(v)}` ``.
 * It stops accidental omission only; a hand-built `TemplateStringsArray` or an
 * `as` assertion bypasses it.
 */
export function compatibilityMessage(
  fixedSpans: TemplateStringsArray,
  ...values: readonly CompatibilityMessageFragment[]
): CompatibilityMessageFragment {
  let composed = fixedSpans[0];
  for (let index = 0; index < values.length; index += 1)
    composed += values[index] + fixedSpans[index + 1];
  return composed as CompatibilityMessageFragment;
}

/**
 * Render one half of a rule-set citation, the set name quoted and the version in
 * the checked bare form, shared by every surface that shows a citation so no
 * surface can delimit it differently. Takes the two values so a caller's own
 * treatment (escaping for `log.warn`, redaction) comes before this last pass.
 */
export function ruleSetCitation(
  name: string,
  version: string,
): CompatibilityMessageFragment {
  return compatibilityMessage`${quoteTermsValue(name)} ${bareTermsValue(version)}`;
}
