// Small readers of source text shared across the checks.

/** The 1-based line a character index of `text` falls on. */
export const lineOf = (text, index) => text.slice(0, index).split("\n").length;
