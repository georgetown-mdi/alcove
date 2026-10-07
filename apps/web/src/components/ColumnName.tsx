import { DISPLAY_TRUNCATION_MARKER, MAX_NAME_LENGTH } from "@alcove/core";

/**
 * How the confirm-columns and consent screens show the operator's own column
 * names: verbatim, cut, inside a bidi isolate. Every such sink on those screens
 * goes through this module. A name the invitation declares is partner text and
 * takes the escape instead. Why, and what isolation leaves open:
 * docs/notes/column-name-display.md.
 */

/**
 * A column name cut to {@link MAX_NAME_LENGTH} code points plus
 * {@link DISPLAY_TRUNCATION_MARKER}, so an unbounded header cannot paint over the
 * screen that holds the launch gate. It counts code points, never splitting a
 * surrogate pair, while the wire counts UTF-16 units: a missing mark is no verdict
 * on what the wire accepts.
 */
function boundedName(name: string): string {
  const codePoints = [...name];
  if (codePoints.length <= MAX_NAME_LENGTH) return name;
  return (
    codePoints.slice(0, MAX_NAME_LENGTH).join("") + DISPLAY_TRUNCATION_MARKER
  );
}

/**
 * FIRST STRONG ISOLATE and POP DIRECTIONAL ISOLATE (UAX #9): the isolate is one
 * neutral character to the text around it, and PDI ends any embedding or override
 * left open. A name with an unmatched isolate character escapes the wrapper in
 * both forms; the browser tests measure which sinks contain that
 * (docs/notes/column-name-display.md, The isolate's residual).
 */
const FIRST_STRONG_ISOLATE = "\u2068";
const POP_DIRECTIONAL_ISOLATE = "\u2069";

/**
 * One column name for a string sink -- an `aria-label`, a native `<option>`
 * label, a live-region sentence -- where no element can hold the isolation.
 * Prefer {@link ColumnName} where the sink takes JSX, which keeps the isolation
 * out of the text the operator copies. Applied to every name unconditionally.
 */
export function isolatedColumnName(name: string): string {
  return FIRST_STRONG_ISOLATE + boundedName(name) + POP_DIRECTIONAL_ISOLATE;
}

/**
 * One column name as rendered text, inside a `<bdi>`: the markup form of
 * {@link isolatedColumnName}, so a copied name is the operator's header alone.
 */
export function ColumnName({ name }: { name: string }) {
  return <bdi>{boundedName(name)}</bdi>;
}
