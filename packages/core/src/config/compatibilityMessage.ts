// The only way a linkage-terms value enters a cross-party compatibility
// diagnostic: redacted, control characters replaced, and delimited so it cannot
// pass for one of Alcove's own clauses. The brand makes a raw value there a
// compile error. See
// docs/spec/CHANNEL_SECURITY.md#compatibility-diagnostic-value-delimiting.

import { redactPrivateKeyMaterial } from "../utils/sanitizeErrorForDisplay.js";
import { replaceControlCharactersForDisplay } from "../utils/sanitizeForDisplay.js";

declare const compatibilityMessageBrand: unique symbol;

/**
 * First-party text from {@link compatibilityMessage}'s fixed spans, or a terms
 * value passed through {@link quoteTermsValue} or {@link bareTermsValue}. The
 * compile-time brand claims delimiting and redaction, not escaping, which stays
 * with the display sink.
 */
export type CompatibilityMessageFragment = string & {
  readonly [compatibilityMessageBrand]: true;
};

/**
 * The delimiter {@link quoteTermsValue} wraps a value in and doubles inside it;
 * doubling needs no escape character for the display escape to rewrite.
 */
export const TERMS_VALUE_DELIMITER = '"';

/**
 * Longest value {@link bareTermsValue} renders undelimited, so an enormous
 * delimiter-free value (a 250-digit semver major) is visibly one value.
 */
export const MAX_BARE_TERMS_VALUE_LENGTH = 64;

/**
 * What {@link bareTermsValue} renders undelimited. The required digit keeps a
 * bare value from spelling one of the templates' digit-free words.
 */
export const BARE_TERMS_VALUE_PATTERN = /^[A-Za-z0-9._-]*[0-9][A-Za-z0-9._-]*$/;

/**
 * Render a terms value as one delimited run that no value can end early. The
 * display cap can still cut a run before `DISPLAY_TRUNCATION_MARKER`. For
 * display only: comparisons use raw values.
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
 * since `validateCompatibility`'s inputs need not be schema-parsed; any other
 * value takes {@link quoteTermsValue}.
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
 * Render payload column names quoted per element, so a column named `a,b`
 * stays distinct from columns `a` and `b`.
 */
export function quoteTermsValueList(
  values: readonly string[],
): CompatibilityMessageFragment {
  return values
    .map((value) => quoteTermsValue(value))
    .join(",") as CompatibilityMessageFragment;
}

/**
 * Tagged template composing fixed copy with fragments, keeping the brand that
 * concatenation would drop. It stops accidental omission only: an `as`
 * assertion or a hand-built `TemplateStringsArray` bypasses it.
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
 * A rule-set citation as every screen and log shows it: the name quoted, the
 * version bare. A caller's own treatment (escaping, redaction) comes first.
 */
export function ruleSetCitation(
  name: string,
  version: string,
): CompatibilityMessageFragment {
  return compatibilityMessage`${quoteTermsValue(name)} ${bareTermsValue(version)}`;
}
