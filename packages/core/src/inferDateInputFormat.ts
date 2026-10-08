import type { LocalFile } from "papaparse";

import { CSV_LINE_BYTE_CEILING, loadCSVColumnSample } from "./file.js";
import { inferMetadata, linkageDateOfBirthColumn } from "./config/metadata.js";
import { INFER_DATE_SCAN_CAP, inferDateFormat } from "./utils/date.js";

/**
 * The header's date-of-birth column as {@link linkageDateOfBirthColumn}
 * resolves it, or `undefined` when there is none.
 *
 * An empty name is dropped, not refused: this runs inside the read, which has
 * no sanitized positions, so the refusal that names the removal is left to the
 * caller (`CSVParseMeta.sanitizedColumnPositions`).
 */
export function inferDateOfBirthColumn(
  columns: Array<string>,
): string | undefined {
  const named = columns.filter((name) => name.length > 0);
  return linkageDateOfBirthColumn(inferMetadata(named, []))?.name;
}

/** What {@link inferDateInputFormatFromSource} resolves from a source. */
interface InferredDateInputFormat {
  /** The CSV header field names. */
  columns: Array<string>;
  /** 1-based positions of names the read stripped control characters from. */
  sanitizedColumnPositions: Array<number>;
  /** Absent when the header has no date-of-birth column. */
  dobColumn?: string;
  /** The `parse_date` input format for {@link dobColumn}, absent when its
   * sample yields no format. */
  dateInputFormat?: string;
}

/**
 * Read a CSV source's header and infer its date-of-birth column's
 * `parse_date` input format in one streaming pass. The sample cap is
 * {@link inferDateFormat}'s own scan cap, so the format equals a full-column
 * read's at bounded memory. See
 * docs/spec/DEFAULT_STANDARDIZATION.md#date-format-inference.
 *
 * Omit `delimiter` to detect one. Rejects as {@link loadCSVColumnSample} does.
 */
export async function inferDateInputFormatFromSource(
  file: LocalFile,
  byteCeiling: number = CSV_LINE_BYTE_CEILING,
  delimiter?: string,
): Promise<InferredDateInputFormat> {
  const { columns, sanitizedColumnPositions, sampledColumn, sample } =
    await loadCSVColumnSample(
      file,
      inferDateOfBirthColumn,
      INFER_DATE_SCAN_CAP,
      byteCeiling,
      delimiter,
    );
  const dateInputFormat =
    sampledColumn !== undefined ? inferDateFormat(sample) : undefined;
  return {
    columns,
    sanitizedColumnPositions,
    ...(sampledColumn !== undefined ? { dobColumn: sampledColumn } : {}),
    ...(dateInputFormat !== undefined ? { dateInputFormat } : {}),
  };
}
