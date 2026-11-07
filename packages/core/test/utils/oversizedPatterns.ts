// Short patterns that compile far over the weighted-size cap, shared by the
// tests that hold a parse to that cap and a refused pattern out of the
// compile cache.

const COUNTED_REPEAT = "(b?){999}";

/** A 251-character `allowedCharacters` whose built pattern compiles over the
 * weighted-size cap. */
export const CLOSED_CLASS_COUNTED_REPEATS = `A-Z]|${COUNTED_REPEAT.repeat(27)}|[c`;

/** An `allowedCharacters` with a leading caret whose built pattern, the caret
 * escaped, compiles over the weighted-size cap. */
export const ESCAPED_CARET_COUNTED_REPEATS = `^]${COUNTED_REPEAT.repeat(28)}`;

/** A 900-character transform pattern of counted repeats, `prefix` making each
 * document's pattern distinct. */
export function oversizedTransformPattern(prefix = ""): string {
  return `${prefix}${COUNTED_REPEAT.repeat(100)}`;
}
