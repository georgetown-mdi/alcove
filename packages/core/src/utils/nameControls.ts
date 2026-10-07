/**
 * The characters no name may contain: the C0 controls, DEL, the C1 controls, and
 * {@link BIDI_CONTROL_PATTERN}. Header sanitation (`file.ts`) removes exactly this
 * class and `NAME_SHAPE_PATTERN` refuses it, held equal by
 * packages/core/test/config/nameShapeParity.test.ts (docs/spec/CHANNEL_SECURITY.md,
 * CSV header sanitation at ingestion). Written as escapes, never raw bytes.
 */
export const NAME_CONTROL_CHAR_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

/**
 * The nine Unicode bidirectional formatting characters that open a layout scope
 * outliving themselves (UAX #9 embeddings, overrides and isolates), the half of
 * {@link NAME_CONTROL_CHAR_PATTERN} `replaceControlCharactersForDisplay` does not
 * reach. The implicit marks LRM, RLM and ALM open no scope and stay outside.
 */
export const BIDI_CONTROL_PATTERN = /[\u202a-\u202e\u2066-\u2069]/u;

/**
 * `value` with every {@link NAME_CONTROL_CHAR_PATTERN} character removed, and
 * `value` itself (by reference) when it holds none, so a caller can compare
 * identity to learn whether anything was removed. Split-and-join, so no second
 * `/g` literal has to match the pattern.
 */
export function stripNameControlChars(value: string): string {
  if (!NAME_CONTROL_CHAR_PATTERN.test(value)) return value;
  return value.split(NAME_CONTROL_CHAR_PATTERN).join("");
}
