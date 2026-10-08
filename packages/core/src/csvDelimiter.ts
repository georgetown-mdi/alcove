/** The delimiter a CSV write or read uses when the party named none. */
export const DEFAULT_CSV_DELIMITER = ",";

/**
 * The reserved value that has a read take the delimiter from the file. Stored as
 * this word, so naming detection differs from naming nothing; no single-character
 * delimiter can collide with it. A result file under this choice is written with
 * {@link DEFAULT_CSV_DELIMITER} ({@link resultCsvDelimiter}).
 */
export const CSV_DELIMITER_DETECT = "detect";

/** The spellings of a tab delimiter, matched case-insensitively after trimming. */
const TAB_SPELLINGS: ReadonlySet<string> = new Set(["tab", "\\t"]);

/**
 * Resolve `tab`, `\t` and {@link CSV_DELIMITER_DETECT}, case-insensitively after
 * trimming. Any other value is returned untrimmed, since a space is itself a valid
 * delimiter. Applied at the CLI flag and the configuration schema, before
 * {@link isCsvDelimiterChoice}.
 */
export function normalizeCsvDelimiter(value: string): string {
  const word = value.trim().toLowerCase();
  if (TAB_SPELLINGS.has(word)) return "\t";
  if (word === CSV_DELIMITER_DETECT) return CSV_DELIMITER_DETECT;
  return value;
}

/**
 * Whether `value` is a delimiter Alcove reads and writes a CSV with: one tab or
 * printable ASCII character other than the double quote, so a parse and a write
 * agree on where a field ends. PapaParse ignores a `"` delimiter and splits on a
 * comma; CR and LF end a row and the line byte ceilings scan for them; non-ASCII
 * is escaped by code unit but counted by byte; PapaParse accepts a
 * multi-character delimiter that nothing escapes against. The two PapaParse
 * behaviors are pinned in csvDelimiter.test.ts. Grades a normalized value.
 */
export function isCsvDelimiter(value: string): boolean {
  if (value.length !== 1) return false;
  if (value === '"') return false;
  const code = value.charCodeAt(0);
  return code === 0x09 || (code >= 0x20 && code <= 0x7e);
}

/**
 * Whether `value` is a delimiter choice a party may author: a character
 * {@link isCsvDelimiter} accepts, or {@link CSV_DELIMITER_DETECT}. Grades a
 * normalized value.
 */
export function isCsvDelimiterChoice(value: string): boolean {
  return value === CSV_DELIMITER_DETECT || isCsvDelimiter(value);
}

/**
 * The delimiter a result file is written with: the character the party named,
 * else {@link DEFAULT_CSV_DELIMITER}, including under detection. Every write site
 * resolves through this, so the escape character and the join character agree.
 */
export function resultCsvDelimiter(choice: string | undefined): string {
  if (choice === undefined || choice === CSV_DELIMITER_DETECT)
    return DEFAULT_CSV_DELIMITER;
  return choice;
}

/**
 * The clause a column refusal adds when the header read as one column, which is
 * how a file read by the wrong delimiter fails; empty for any other count.
 * Names no flag, key or control, so the CLI linkage pre-flight and
 * `assertLinkageTermsSatisfiable` can both use it.
 */
export function singleColumnDelimiterClause(columnCount: number): string {
  if (columnCount !== 1) return "";
  return (
    "This input read as a single column with the delimiter in effect, so its " +
    "fields may be separated by a different character: name your file's " +
    "separator as the CSV delimiter, or name " +
    `\`${CSV_DELIMITER_DETECT}\` to take it from the file, and run again. `
  );
}

/**
 * Describe `value`'s shape without repeating it, so no unprintable byte the party
 * typed is written back.
 */
function csvDelimiterShape(value: string): string {
  const resolved = normalizeCsvDelimiter(value);
  if (resolved.length === 0) return "an empty value";
  if (resolved.length > 1) return `a ${resolved.length}-character value`;
  if (resolved === '"') return "the double quote";
  if (resolved === "\n" || resolved === "\r") return "a line terminator";
  const code = resolved.charCodeAt(0);
  // DEL (0x7f) is a control character, so the bound is one above it.
  if (code > 0x7f) return "a non-ASCII character";
  return `a control character (code point ${code})`;
}

/**
 * The refusal for a delimiter outside the accepted set, shared by the CLI flag
 * and the configuration schema. Names the tab as `tab`, never `\t`: every sink
 * escapes a backslash, which would show a spelling that is refused when typed.
 */
export function csvDelimiterRefusal(value: string): string {
  return (
    `a CSV field delimiter must be a single character -- a tab (write it ` +
    `\`tab\`), or a printable ASCII character other than the double quote -- ` +
    `or \`${CSV_DELIMITER_DETECT}\` to take the delimiter from the file ` +
    `itself, and this is ${csvDelimiterShape(value)}`
  );
}
