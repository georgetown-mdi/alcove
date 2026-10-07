import type { OperatorSuppliedText } from "./operatorSuppliedText";
import { operatorSuppliedValue } from "./operatorSuppliedText";

declare const displayableBrand: unique symbol;

/**
 * A string that has passed through the display boundary: what
 * {@link sanitizeForDisplay} and {@link renderOperatorSuppliedText} return and
 * {@link displayText} composes. A display field typed `Displayable` makes a
 * missing sanitize call a compile error; the brand is type-only and obtainable
 * only from this module's producers or an `as` cast. It claims safety as text
 * only: `<`, `>`, `&` and quotes pass through, so it is safe as a JSX text child
 * and nothing more, and a comparison, storage or hashing site takes the raw string.
 */
export type Displayable = string & { readonly [displayableBrand]: true };

/**
 * Marker appended by {@link sanitizeForDisplay} when a value is truncated; plain
 * ASCII so it cannot reintroduce a character the escape removes.
 */
export const DISPLAY_TRUNCATION_MARKER = "...[truncated]";

/**
 * Default cap on the output characters {@link sanitizeForDisplay} emits before
 * truncating, excluding the marker. A display bound sized for one value, not a
 * wire bound.
 */
export const DEFAULT_MAX_DISPLAY_LENGTH = 256;

/**
 * Cap on the output characters {@link sanitizeErrorForDisplay} emits for one
 * link of an error chain. A link composes first-party text with raw fragments,
 * so the per-value default would cut the sentence the operator acts on. A site
 * holding another party's bytes still gives them a link of their own, since the
 * budget bounds a link, not who spends it (docs/spec/CHANNEL_SECURITY.md,
 * Display sanitization escape format).
 */
export const COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH = 1024;

/**
 * Cap on the output characters a boundary emits for a whole composed warning,
 * so the per-value default does not cut the warning's own instruction. Every
 * boundary holding a whole warning (the CLI stderr log, the fd-3 warning event,
 * the console relay and the console screen) takes this cap, so none shows less
 * than another. Its size is held by the checks rendering the host-key divergence
 * warning with all four fragments flooded.
 */
export const WARNING_MESSAGE_MAX_DISPLAY_LENGTH = 4096;

/** Options for {@link sanitizeForDisplay}. */
export interface SanitizeForDisplayOptions {
  /**
   * Maximum output characters before truncating and appending
   * {@link DISPLAY_TRUNCATION_MARKER}. Bounds the escaped output, not the input:
   * one code point can escape to ten characters. Defaults to
   * {@link DEFAULT_MAX_DISPLAY_LENGTH}.
   */
  maxLength?: number;
}

/**
 * Escape a string another party controls for operator-facing output. Every code
 * point outside printable ASCII becomes a `\xHH` / `\uHHHH` / `\u{HHHHH}` escape
 * and a literal backslash is doubled, which neutralizes controls, ANSI, line
 * breaks, bidi overrides, zero-width and confusable characters at the cost of
 * showing non-ASCII as escapes. Lossy: apply at the display boundary only, never
 * to a value compared, stored or hashed (docs/spec/CHANNEL_SECURITY.md, Display
 * sanitization escape format).
 */
export function sanitizeForDisplay(
  value: string,
  options?: SanitizeForDisplayOptions,
): Displayable {
  const maxLength = options?.maxLength ?? DEFAULT_MAX_DISPLAY_LENGTH;

  // By code point, so an astral character escapes whole and a lone surrogate is
  // escaped rather than split. A code point is appended only if its whole escape
  // fits, and a cut inside a marker backs off to before it.
  let out = "";
  let truncated = false;
  for (const ch of value) {
    let piece: string;
    if (ch === "\\") {
      piece = "\\\\";
    } else {
      const cp = ch.codePointAt(0)!;
      if (cp >= 0x20 && cp <= 0x7e) {
        piece = ch;
      } else if (cp <= 0xff) {
        piece = "\\x" + cp.toString(16).padStart(2, "0");
      } else if (cp <= 0xffff) {
        piece = "\\u" + cp.toString(16).padStart(4, "0");
      } else {
        piece = "\\u{" + cp.toString(16) + "}";
      }
    }
    if (out.length + piece.length > maxLength) {
      truncated = true;
      break;
    }
    out += piece;
  }

  return (
    truncated
      ? trimPartialControlCharacterMarker(out) + DISPLAY_TRUNCATION_MARKER
      : out
  ) as Displayable;
}

/**
 * Render a fragment the operator supplied: the characters
 * {@link replaceUnrenderableForOperatorDisplay} names become printable markers,
 * every other code point stays as typed (so `C:\data\in.csv` is not doubled),
 * and the result is truncated to `maxLength`. Takes the operator-supplied mark,
 * so an unmarked value is a compile error; one that arrives unmarked anyway is
 * escaped by {@link sanitizeForDisplay}. Bidi overrides and confusables are
 * shown as themselves, since the operator chose them.
 */
export function renderOperatorSuppliedText(
  value: OperatorSuppliedText,
  options?: SanitizeForDisplayOptions,
): Displayable {
  const text = operatorSuppliedValue(value);
  return text === undefined
    ? sanitizeForDisplay(String(value), options)
    : renderOperatorSuppliedSpanText(text, options);
}

/**
 * {@link renderOperatorSuppliedText} over one span of a message partitioned by
 * {@link ./operatorSuppliedText.messageWithOperatorText}, whose origin the
 * caller has already established from the mark.
 */
export function renderOperatorSuppliedSpanText(
  text: string,
  options?: SanitizeForDisplayOptions,
): Displayable {
  const maxLength = options?.maxLength ?? DEFAULT_MAX_DISPLAY_LENGTH;
  let out = "";
  let truncated = false;
  // By code point, so an astral character is never cut between its surrogates.
  for (const ch of replaceUnrenderableForOperatorDisplay(text)) {
    if (out.length + ch.length > maxLength) {
      truncated = true;
      break;
    }
    out += ch;
  }
  return (
    truncated
      ? trimPartialOperatorDisplayMarker(out) + DISPLAY_TRUNCATION_MARKER
      : out
  ) as Displayable;
}

/**
 * How {@link replaceControlCharactersForDisplay} renders one control character:
 * `<HH>`, with no backslash, so a value's own bytes cannot spell the escape's
 * `\xHH` and a control character a composition placed itself stays
 * distinguishable. A value can still spell the marker. Refuses a code point
 * outside the control class, since {@link PARTIAL_CONTROL_CHARACTER_MARKERS}
 * covers that class only.
 */
export function controlCharacterMarker(codePoint: number): string {
  if (!CONTROL_CHARACTER.test(String.fromCodePoint(codePoint)))
    throw new RangeError(
      `control-character marker is defined over the control class only, not U+${codePoint.toString(16)}`,
    );
  return `<${codePoint.toString(16).padStart(2, "0")}>`;
}

/** Every control character (Unicode `Cc`: U+0000-U+001F and U+007F-U+009F). */
const CONTROL_CHARACTERS = /\p{Cc}/gu;

/**
 * The same class as a one-character test, built from the pattern above so the
 * two cannot drift; separate because the global regex holds `lastIndex` state.
 */
const CONTROL_CHARACTER = new RegExp(`^${CONTROL_CHARACTERS.source}$`, "u");

/**
 * Replace every control character in a value another party chose with
 * {@link controlCharacterMarker}, where it is interpolated into a composition
 * whose own structure uses control characters (a `\n`-separated block), so only
 * the composition can produce the escaped `\xHH`. The output holds no backslash
 * or non-ASCII, so the sink's escape has nothing to double. Apply before any
 * fit; for display only.
 */
export function replaceControlCharactersForDisplay(value: string): string {
  return value.replace(CONTROL_CHARACTERS, (character) =>
    controlCharacterMarker(character.codePointAt(0)!),
  );
}

/**
 * What an operator-supplied render replaces beyond the control class: U+2028 and
 * U+2029, which log readers break a line on, and an unpaired surrogate (under
 * `u`, a surrogate pair does not match).
 */
const OPERATOR_DISPLAY_REPLACED_CHARACTERS = /[\u2028\u2029\uD800-\uDFFF]/gu;

/** The same class as a one-character test, as {@link CONTROL_CHARACTER} is. */
const OPERATOR_DISPLAY_REPLACED_CHARACTER = new RegExp(
  `^${OPERATOR_DISPLAY_REPLACED_CHARACTERS.source}$`,
  "u",
);

/**
 * How {@link replaceUnrenderableForOperatorDisplay} renders a code point outside
 * the control class: `<HHHH>`, bracketed like {@link controlCharacterMarker}
 * because the operator render keeps literal backslashes. Refuses a code point
 * outside its class, so {@link PARTIAL_OPERATOR_DISPLAY_MARKERS} covers it.
 */
export function operatorDisplayMarker(codePoint: number): string {
  if (
    !OPERATOR_DISPLAY_REPLACED_CHARACTER.test(String.fromCodePoint(codePoint))
  )
    throw new RangeError(
      `operator-display marker is defined over the line-separator and lone-surrogate classes only, not U+${codePoint.toString(16)}`,
    );
  return `<${codePoint.toString(16).padStart(4, "0")}>`;
}

/**
 * Replace everything {@link renderOperatorSuppliedText} does not show as typed:
 * the control class and the class {@link operatorDisplayMarker} names. Neither
 * replacement emits a character of the other's class, so order does not matter.
 */
export function replaceUnrenderableForOperatorDisplay(value: string): string {
  return replaceControlCharactersForDisplay(value).replace(
    OPERATOR_DISPLAY_REPLACED_CHARACTERS,
    (character) => operatorDisplayMarker(character.codePointAt(0)!),
  );
}

/**
 * Every proper, non-empty prefix of a control-character marker, what a cut inside
 * one leaves. Derived by running the treatment so it follows the marker's shape.
 */
const PARTIAL_CONTROL_CHARACTER_MARKERS: ReadonlySet<string> = new Set(
  Array.from({ length: 0xa0 }, (_unused, codePoint) =>
    String.fromCodePoint(codePoint),
  ).flatMap((character) => {
    const treated = replaceControlCharactersForDisplay(character);
    if (treated === character) return [];
    return Array.from({ length: treated.length - 1 }, (_unused, index) =>
      treated.slice(0, index + 1),
    );
  }),
);

const LONGEST_PARTIAL_CONTROL_CHARACTER_MARKER = Math.max(
  ...Array.from(PARTIAL_CONTROL_CHARACTER_MARKERS, (partial) => partial.length),
);

/** The code points {@link operatorDisplayMarker} is defined over. */
const OPERATOR_DISPLAY_REPLACED_CODE_POINTS: readonly number[] = [
  0x2028,
  0x2029,
  ...Array.from(
    { length: 0xe000 - 0xd800 },
    (_unused, index) => 0xd800 + index,
  ),
];

/**
 * Every proper, non-empty prefix of a marker an operator-supplied render can
 * emit, both classes, derived from the markers.
 */
const PARTIAL_OPERATOR_DISPLAY_MARKERS: ReadonlySet<string> = new Set([
  ...PARTIAL_CONTROL_CHARACTER_MARKERS,
  ...OPERATOR_DISPLAY_REPLACED_CODE_POINTS.flatMap((codePoint) => {
    const marker = operatorDisplayMarker(codePoint);
    return Array.from({ length: marker.length - 1 }, (_unused, index) =>
      marker.slice(0, index + 1),
    );
  }),
]);

const LONGEST_PARTIAL_OPERATOR_DISPLAY_MARKER = Math.max(
  ...Array.from(PARTIAL_OPERATOR_DISPLAY_MARKERS, (partial) => partial.length),
);

/**
 * Every proper, non-empty suffix of a control-character marker, what a cut that
 * keeps the end of a value leaves in front.
 */
const PARTIAL_CONTROL_CHARACTER_MARKER_SUFFIXES: ReadonlySet<string> = new Set(
  Array.from({ length: 0xa0 }, (_unused, codePoint) =>
    String.fromCodePoint(codePoint),
  ).flatMap((character) => {
    const treated = replaceControlCharactersForDisplay(character);
    if (treated === character) return [];
    return Array.from({ length: treated.length - 1 }, (_unused, index) =>
      treated.slice(index + 1),
    );
  }),
);

const LONGEST_PARTIAL_CONTROL_CHARACTER_MARKER_SUFFIX = Math.max(
  ...Array.from(
    PARTIAL_CONTROL_CHARACTER_MARKER_SUFFIXES,
    (partial) => partial.length,
  ),
);

/**
 * `text` with one trailing fragment of a control-character marker removed, so a
 * cut hands on whole markers or none; undershoots the budget by up to three
 * characters. A single back-off, not a loop: a whole marker ends in `>`, which no
 * proper prefix holds, so repeating would only delete marker-shaped bytes the
 * value spelled itself. Kept text may still end in such bytes.
 */
export function trimPartialControlCharacterMarker(text: string): string {
  return trimLongestTrailingPartial(
    text,
    PARTIAL_CONTROL_CHARACTER_MARKERS,
    LONGEST_PARTIAL_CONTROL_CHARACTER_MARKER,
  );
}

/**
 * {@link trimPartialControlCharacterMarker} over the operator-supplied render's
 * markers; a six-character marker undershoots the budget by up to five.
 */
function trimPartialOperatorDisplayMarker(text: string): string {
  return trimLongestTrailingPartial(
    text,
    PARTIAL_OPERATOR_DISPLAY_MARKERS,
    LONGEST_PARTIAL_OPERATOR_DISPLAY_MARKER,
  );
}

/** `text` with its longest tail found in `partials` removed. */
function trimLongestTrailingPartial(
  text: string,
  partials: ReadonlySet<string>,
  longest: number,
): string {
  for (let length = Math.min(longest, text.length); length > 0; length -= 1)
    if (partials.has(text.slice(-length)))
      return text.slice(0, text.length - length);
  return text;
}

/**
 * `text` with one leading fragment of a control-character marker removed, the
 * mirror of {@link trimPartialControlCharacterMarker} for a cut that kept the
 * end ({@link clipToRenderedCostKeepingEnd}). No proper suffix holds the opening
 * `<`, so one back-off suffices.
 */
export function trimPartialControlCharacterMarkerAtStart(text: string): string {
  for (
    let length = Math.min(
      LONGEST_PARTIAL_CONTROL_CHARACTER_MARKER_SUFFIX,
      text.length,
    );
    length > 0;
    length -= 1
  )
    if (PARTIAL_CONTROL_CHARACTER_MARKER_SUFFIXES.has(text.slice(0, length)))
      return text.slice(length);
  return text;
}

/**
 * What a raw fragment costs once {@link sanitizeForDisplay} escapes it, for a
 * composition site fitting raw fragments to a budget. Materializes the escaped
 * form (up to ten times the input), so bound the fragment first
 * ({@link boundRawFragmentForFit}).
 */
export function renderedDisplayCost(fragment: string): number {
  return sanitizeForDisplay(fragment, { maxLength: Infinity }).length;
}

/**
 * UTF-16 code units {@link boundRawFragmentForFit} keeps per budget character.
 * Two, not one: a printable-ASCII fragment cut to exactly the budget would
 * render whole and unmarked, where the longer original would have been clipped
 * and marked. At twice the budget the clip always runs and keeps the same prefix.
 */
export const RAW_FIT_CODE_UNITS_PER_BUDGET_CHARACTER = 2;

/**
 * `value` cut to the most code units a fit to `budget` can read, so measuring a
 * fragment nothing upstream bounded (a wire-frame record key) costs time and
 * memory linear in the budget. Cut before redaction: a cut inside a private-key
 * block leaves a dangling `BEGIN` that redaction removes with all after it. A
 * complete key block followed by text can make the fit show less trailing text
 * than the uncut fragment would, unmarked; no key material survives either way.
 */
export function boundRawFragmentForFit(value: string, budget: number): string {
  return value.slice(0, RAW_FIT_CODE_UNITS_PER_BUDGET_CHARACTER * budget);
}

/**
 * Longest prefix of raw `value` whose {@link renderedDisplayCost} fits `budget`,
 * with {@link DISPLAY_TRUNCATION_MARKER} appended inside the budget when anything
 * was dropped, so the sink's single escape renders within `budget`. A clip
 * inside a marker backs off, so `budget` is an upper bound. Redact before
 * clipping, never after: a planted `BEGIN` in the kept prefix would consume the
 * marker. Bounds the rendered size, not the cost of measuring
 * ({@link boundRawFragmentForFit}).
 */
export function clipToRenderedCost(value: string, budget: number): string {
  if (renderedDisplayCost(value) <= budget) return value;
  const room = budget - DISPLAY_TRUNCATION_MARKER.length;
  let kept = "";
  let cost = 0;
  for (const ch of value) {
    const next = cost + renderedDisplayCost(ch);
    if (next > room) break;
    kept += ch;
    cost = next;
  }
  return `${trimPartialControlCharacterMarker(kept)}${DISPLAY_TRUNCATION_MARKER}`;
}

/**
 * The mirror of {@link clipToRenderedCost}: the longest suffix that fits, the
 * marker in front, for a fragment whose last bytes matter (a failing run writes
 * its diagnosis last). The same constraints apply, with the back-off at the start
 * ({@link trimPartialControlCharacterMarkerAtStart}).
 */
export function clipToRenderedCostKeepingEnd(
  value: string,
  budget: number,
): string {
  if (renderedDisplayCost(value) <= budget) return value;
  const room = budget - DISPLAY_TRUNCATION_MARKER.length;
  const points = Array.from(value);
  let kept = "";
  let cost = 0;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const next = cost + renderedDisplayCost(points[index]!);
    if (next > room) break;
    kept = `${points[index]!}${kept}`;
    cost = next;
  }
  return `${DISPLAY_TRUNCATION_MARKER}${trimPartialControlCharacterMarkerAtStart(kept)}`;
}

/**
 * Mark first-party copy as a {@link Displayable} so the sink does not cut it to
 * the per-value cap; any fragment inside was escaped where interpolated. A note
 * holding any code point outside printable ASCII is not such copy, so it is
 * escaped and capped instead, which also excludes a fragment rendered by
 * {@link renderOperatorSuppliedText}. Prefer {@link displayText} where the copy
 * fits a tagged template.
 */
export function firstPartyNote(text: string): Displayable {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp > 0x7e) return sanitizeForDisplay(text);
  }
  return text as Displayable;
}

/**
 * Compose fixed first-party copy with already-sanitized values into a
 * {@link Displayable}, as a tagged template: ``displayText`${fieldLabel} (${marker})` ``.
 * Adds no bytes. Only the compiler produces the fixed spans, and every value is
 * a {@link Displayable} or a `number`, so an unsanitized string cannot reach the
 * output, short of a hand-built `TemplateStringsArray` or an `as` cast.
 */
export function displayText(
  fixedSpans: TemplateStringsArray,
  ...values: Array<Displayable | number>
): Displayable {
  let composed = fixedSpans[0];
  for (let index = 0; index < values.length; index += 1)
    composed += String(values[index]) + fixedSpans[index + 1];
  return composed as Displayable;
}
