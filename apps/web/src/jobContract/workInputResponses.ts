/**
 * The closed set of reasons a profile pass fails other than not-found. Sent to
 * the browser as a bare code so the operator gets a meaningful reason without any
 * file content, path, or raw error object riding the wire:
 * - `too_large`: a header, field, or unterminated line exceeded the CSV single-line
 *   byte ceiling, so the file cannot be profiled in bounded memory.
 * - `not_a_csv`: the parse produced no columns -- an empty file or one with no header.
 * - `parse_failed`: any other read or parse fault (a mid-read I/O error, a malformed
 *   structure the parser rejected).
 */
export type JobInputProfileErrorCode =
  "too_large" | "not_a_csv" | "parse_failed";

/** One file in the listing response: an admissible name and its size/mtime. */
export interface JobInputFileEntry {
  name: string;
  sizeBytes: number;
  modifiedAt: number;
}

/** The `GET /api/jobs/inputs` response shape. */
export interface JobInputListing {
  /** False when neither `JOB_INPUT_DIR` nor the `JOB_DATA_ROOT`
   * fallback resolves a directory -- the feature-off state -- with an empty list. */
  configured: boolean;
  /** False when the configured directory could not be enumerated (a mis-mount or a
   * permission fault), so the operator is told the mount is unreadable rather than to
   * place a file in a directory that already holds one. True in every other case,
   * including the unconfigured state (nothing failed to read). The errno and the
   * absolute path are NOT held -- only this boolean. */
  readable: boolean;
  files: Array<JobInputFileEntry>;
}

/** One column's preview samples on the wire: the column name paired with its first
 * `PREVIEW_SAMPLE_SIZE` (`@psi/columnSamples`) non-empty values. Held as an
 * array element -- never an object key -- so a column named an `Object.prototype` member (`__proto__`,
 * `constructor`, `prototype`) is ordinary data rather than a prototype-setter hazard. */
export interface ColumnSample {
  column: string;
  values: Array<string>;
}

/** One column's inferred date input format on the wire, held as an array element
 * for the reason {@link ColumnSample} is. */
export interface ColumnDateInputFormat {
  column: string;
  format: string;
}

/** The `GET /api/jobs/inputs/profile` response shape. `columnSamples` and
 * `dateInputFormats` are ordered arrays of per-column pairs, so a prototype-member
 * column name rides the wire as plain data; the client validates them into keyed
 * maps. */
export interface JobInputProfile {
  name: string;
  sizeBytes: number;
  modifiedAt: number;
  rowCount: number;
  columns: Array<string>;
  /** The 1-based positions of the columns whose name lost control
   * characters at the parse (core's `CSVParseMeta.sanitizedColumnPositions`). The
   * console's intake seats read the file through this profile rather than
   * parsing it themselves, so the positions ride the wire for the notice they
   * show; `columns` already holds the stripped names. */
  sanitizedColumnPositions: Array<number>;
  /** The date input format inferred for each column core's date-format
   * inference infers one for, in column order: the console holds no rows, so
   * whichever column the operator binds as the date of birth takes its format
   * from here. */
  dateInputFormats: Array<ColumnDateInputFormat>;
  columnSamples: Array<ColumnSample>;
}
