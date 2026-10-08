import Papa from "papaparse";

import type { LocalFile } from "papaparse";

import { CSV_DELIMITER_DETECT, DEFAULT_CSV_DELIMITER } from "./csvDelimiter.js";
import { decodedCSVTextSource } from "./csvTextSource.js";
import { InternalConsistencyError, UsageError } from "./errors.js";
import { stripNameControlChars } from "./utils/nameControls.js";

/**
 * Per-logical-line byte ceiling for the streamed CSV reads ({@link loadCSVFile}
 * and {@link loadCSVColumnSample}). PapaParse buffers a whole logical line
 * before yielding a chunk, so a no-newline file, an enormous field or a huge
 * header fails fast instead. Lines are counted by LF and CR alone, whatever
 * the delimiter. Operator-local robustness, not a partner-reachable bound
 * (docs/spec/CHANNEL_SECURITY.md#csv-read-single-line-byte-ceiling).
 */
export const CSV_LINE_BYTE_CEILING = 8 * 1024 * 1024;

/**
 * The error a {@link CSV_LINE_BYTE_CEILING} trip raises, so a caller can tell it
 * from a parse fault by `instanceof`. The message names only the ceiling, never
 * file content or a path.
 */
export class CsvLineByteCeilingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvLineByteCeilingError";
  }
}

/** The one message every {@link CSV_LINE_BYTE_CEILING} trip raises. */
function singleLineCeilingError(byteCeiling: number): CsvLineByteCeilingError {
  return new CsvLineByteCeilingError(
    `CSV input exceeded the ${byteCeiling}-byte single-line limit before a ` +
      "line terminator; the file may be malformed (no newline) or hold an " +
      "oversized header or field",
  );
}

/**
 * The error a row-level parse fault raises: at least one row PapaParse produced
 * differs from the file's own. A {@link UsageError}, so the CLI reports bad
 * input (exit 64). The message gives PapaParse's fault description and the row
 * number, never a cell value or a path.
 */
export class CsvRowParseError extends UsageError {
  constructor(message: string) {
    super(message);
    this.name = "CsvRowParseError";
  }
}

/**
 * The PapaParse error codes that are not a row-level fault, as an allowlist, so
 * a code a later PapaParse adds fails closed. `UndetectableDelimiter` is emitted
 * for a single-column CSV and an empty input, and changes no row.
 */
const BENIGN_CSV_PARSE_ERROR_CODES: ReadonlySet<string> = new Set([
  "UndetectableDelimiter",
]);

/**
 * The refusal for one row-level parse fault. `error.row` is PapaParse's 0-based
 * data-row index counted from the start of the file, so it is reported 1-based;
 * a fault with no row is named without a position.
 */
function rowParseFaultError(error: Papa.ParseError): CsvRowParseError {
  const position =
    typeof error.row === "number" ? `data row ${error.row + 1}` : "a data row";
  return new CsvRowParseError(
    `CSV parse failed at ${position}: ${error.message} (${error.code}). The ` +
      "rows this file yields would differ from the rows it contains, so the " +
      "read refuses rather than return them; correct the input file -- an " +
      "unterminated quote, or a row whose field count differs from the " +
      "header, is the usual cause.",
  );
}

/**
 * Reject if the leading line of a browser `File` exceeds `byteCeiling`: a File
 * has no `data` events for {@link guardStreamLineByteCeiling} to scan. Reads up
 * to the first LF or CR, skipped when the file is within the ceiling. A giant
 * field in a later row is bounded by the web intake cap
 * (`MAX_CSV_FILE_BYTES`). Inert for a Node stream or a string.
 *
 * @internal exported for the unit tests.
 */
export async function assertLeadingLineWithinByteCeiling(
  file: LocalFile,
  byteCeiling: number,
): Promise<void> {
  const source = file as Partial<{
    size: number;
    slice: (
      start: number,
      end: number,
    ) => {
      arrayBuffer: () => Promise<ArrayBuffer>;
    };
  }>;
  if (typeof source.size !== "number" || typeof source.slice !== "function")
    return;
  if (source.size <= byteCeiling) return;

  // Read a first window, then at most one more read to the ceiling.
  const limit = byteCeiling + 1;
  const window = 256 * 1024;
  // Ignores RFC 4180 quoting: a quoted newline counts as a terminator, so a
  // valid file is never rejected, and a quoted field full of newlines is left
  // to MAX_CSV_FILE_BYTES. 0x0a/0x0d never occur inside a UTF-8 sequence.
  const hasTerminator = (bytes: Uint8Array): boolean =>
    bytes.indexOf(0x0a) !== -1 || bytes.indexOf(0x0d) !== -1;
  const head = new Uint8Array(
    await source.slice(0, Math.min(window, limit)).arrayBuffer(),
  );
  if (hasTerminator(head)) return;
  if (limit > window) {
    const tail = new Uint8Array(
      await source.slice(window, limit).arrayBuffer(),
    );
    if (hasTerminator(tail)) return;
  }
  throw singleLineCeilingError(byteCeiling);
}

/**
 * The Node-stream members the ceiling guard and cleanup use, duck-typed so core
 * imports no `node:stream` into the web bundle.
 */
type StreamSource = {
  on?: (event: "data", listener: (chunk: Buffer | string) => void) => void;
  removeListener?: (
    event: "data",
    listener: (chunk: Buffer | string) => void,
  ) => void;
  destroy?: (error?: Error) => void;
};

/**
 * Bound a single logical line on a Node stream: count bytes since the last LF
 * or CR across `data` events, and destroy the source with
 * {@link singleLineCeilingError} past `byteCeiling`, which PapaParse reports
 * through its `error` callback. Returns a detach function. Inert for a source
 * without `on`.
 *
 * Ignores RFC 4180 quoting, so a valid file is never rejected; a quoted field
 * holding embedded newlines is not bounded here
 * (docs/spec/CHANNEL_SECURITY.md#csv-read-single-line-byte-ceiling).
 *
 * @internal exported for the unit tests.
 */
export function guardStreamLineByteCeiling(
  source: StreamSource,
  byteCeiling: number,
): () => void {
  if (typeof source.on !== "function") return () => undefined;
  let run = 0;
  let tripped = false;
  const onData = (chunk: Buffer | string): void => {
    if (tripped) return;
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    // Check the run at each terminator and at the unterminated tail, so an
    // overflow before a later terminator in the same chunk still trips.
    let from = 0;
    let lf = -2;
    let cr = -2;
    while (from < buf.length) {
      if (lf !== -1 && lf < from) lf = buf.indexOf(0x0a, from);
      if (cr !== -1 && cr < from) cr = buf.indexOf(0x0d, from);
      const term = lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr);
      if (term === -1) {
        run += buf.length - from;
        break;
      }
      run += term - from;
      if (run > byteCeiling) break;
      run = 0;
      from = term + 1;
    }
    if (run > byteCeiling) {
      tripped = true;
      source.destroy?.(singleLineCeilingError(byteCeiling));
    }
  };
  source.on("data", onData);
  return () => source.removeListener?.("data", onData);
}

/**
 * Open `file` for one PapaParse read: attach the line-ceiling guard and decode
 * its bytes as UTF-8 ({@link decodedCSVTextSource}). `release` detaches the
 * guard, stops the decoded read, and destroys a Node source, which PapaParse's
 * teardown does not close.
 */
function openCSVSource(
  file: LocalFile,
  byteCeiling: number,
): { input: LocalFile; release: () => void } {
  const source = file as StreamSource;
  const detachGuard = guardStreamLineByteCeiling(source, byteCeiling);
  const text = decodedCSVTextSource(file);
  return {
    // PapaParse picks its stream reader by the source's shape, not its type.
    input: text === undefined ? file : (text as unknown as LocalFile),
    release: () => {
      detachGuard();
      text?.release();
      source.destroy?.();
    },
  };
}

/**
 * A parsed CSV row keyed by column name. A present column is a `string` and a
 * missing one `undefined`: {@link normalizeCSVRow} drops PapaParse's
 * non-string `__parsed_extra`, and a short row omits its trailing columns.
 */
export type CSVRow = Record<string, string | undefined>;

/**
 * PapaParse's {@link Papa.ParseMeta} plus the 1-based positions of the header
 * columns whose name lost a control character ({@link sanitizingHeaderTransform}).
 * Kept on `meta` so it travels wherever the header does, the web parse worker
 * included.
 */
export interface CSVParseMeta extends Papa.ParseMeta {
  sanitizedColumnPositions: Array<number>;
}

/**
 * Read one column from a {@link CSVRow} by name, or `undefined` when the row
 * omits it. An own-property check, so a column named after an
 * `Object.prototype` member (`toString`, `constructor`, ...) never reads the
 * inherited function. Every by-name row read goes through here.
 *
 * @internal not a supported public entry point.
 */
export function readRowColumn(row: CSVRow, column: string): string | undefined {
  return Object.hasOwn(row, column) ? row[column] : undefined;
}

/**
 * Normalize a raw PapaParse row to a {@link CSVRow}, dropping any non-string
 * cell (`__parsed_extra`). An all-string row is returned by reference. The
 * fault gate refuses an over-long row upstream; this keeps the type sound.
 */
function normalizeCSVRow(row: unknown): CSVRow {
  const source = row as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.every((key) => typeof source[key] === "string"))
    return source as CSVRow;
  const cleaned: CSVRow = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") cleaned[key] = value;
  }
  return cleaned;
}

/**
 * The PapaParse configuration every CSV read shares, so {@link loadCSVFile} and
 * {@link streamCSVRows} parse identically.
 *
 * Inline, never `worker: true`: PapaParse's own worker broke the header parse
 * in the production web bundle once, and no test drives it in that bundle. The
 * non-string header check in {@link runSharedCSVParse} is the safety check.
 */
const SHARED_CSV_PARSE_CONFIG = {
  worker: false,
  header: true,
  skipEmptyLines: true,
} as const;

/**
 * The `delimiter` handed to PapaParse: {@link DEFAULT_CSV_DELIMITER} when none
 * was chosen, and `""` (PapaParse's detect value) only for
 * {@link CSV_DELIMITER_DETECT}. A named character is used alone, so a read
 * never disagrees with the write.
 */
function papaParseDelimiter(delimiter: string | undefined): string {
  if (delimiter === CSV_DELIMITER_DETECT) return "";
  return delimiter ?? DEFAULT_CSV_DELIMITER;
}

/**
 * The header transform every read applies: each name goes through
 * {@link stripNameControlChars}, and the 1-based position of a changed name is
 * appended to `strippedPositions`. At the parse boundary, so rows are keyed by
 * the cleaned name and every reader sends the partner the same string
 * (docs/spec/CHANNEL_SECURITY.md#csv-header-sanitation-at-ingestion). A name
 * stripped to empty or onto another name meets the existing refusals.
 */
function sanitizingHeaderTransform(
  strippedPositions: Array<number>,
): (header: string, index: number) => string {
  return (header, index) => {
    const stripped = stripNameControlChars(header);
    if (stripped !== header) strippedPositions.push(index + 1);
    return stripped;
  };
}

/**
 * Drive a PapaParse read of `file` under {@link SHARED_CSV_PARSE_CONFIG} and the
 * single-line byte ceiling, handing each chunk's normalized rows to
 * `consumeChunk`. The one runner behind {@link loadCSVFile} and
 * {@link streamCSVRows}. The ceiling is enforced by
 * {@link guardStreamLineByteCeiling} on a Node stream and by
 * {@link assertLeadingLineWithinByteCeiling} on a browser `File`.
 *
 * Rows are read in the `chunk` callback: `complete` sees only the final chunk
 * or nothing. Of `meta`, only `fields` and `sanitizedColumnPositions` are
 * whole-file; the rest is the final chunk's.
 */
async function runSharedCSVParse(
  file: LocalFile,
  byteCeiling: number,
  delimiter: string | undefined,
  consumeChunk: (
    rows: Array<CSVRow>,
    errors: Array<Papa.ParseError>,
    meta: Papa.ParseMeta,
  ) => void,
): Promise<CSVParseMeta> {
  await assertLeadingLineWithinByteCeiling(file, byteCeiling);
  return new Promise((resolve, reject) => {
    let meta: Papa.ParseMeta | undefined;
    let faulted = false;
    const sanitizedColumnPositions: Array<number> = [];

    const { input, release } = openCSVSource(file, byteCeiling);

    Papa.parse(input, {
      ...SHARED_CSV_PARSE_CONFIG,
      delimiter: papaParseDelimiter(delimiter),
      transformHeader: sanitizingHeaderTransform(sanitizedColumnPositions),
      chunk: (results, parser) => {
        // Refuse the whole read on the first row-level fault, before the chunk
        // reaches the consumer: PapaParse parses on past a fault with values
        // dropped or shifted.
        const fault = results.errors.find(
          (error) => !BENIGN_CSV_PARSE_ERROR_CODES.has(error.code),
        );
        if (fault !== undefined) {
          faulted = true;
          parser.abort();
          release();
          reject(rowParseFaultError(fault));
          return;
        }
        // A loop, not a spread-push, which can overflow the stack on a large
        // chunk.
        const rows: Array<CSVRow> = [];
        for (const row of results.data) rows.push(normalizeCSVRow(row));
        consumeChunk(rows, results.errors, results.meta);
        // Each chunk's meta includes the header fields; keep the latest.
        meta = results.meta;
      },
      complete: () => {
        release();
        // The abort above already settled the promise, possibly before any chunk.
        if (faulted) return;
        // PapaParse yields at least one chunk for any input, even an empty file.
        if (meta === undefined) {
          reject(
            new InternalConsistencyError(
              "CSV parse completed without producing a chunk",
            ),
          );
          return;
        }
        // A non-string header field means the parse malfunctioned.
        if (meta.fields?.some((field) => typeof field !== "string")) {
          reject(
            new InternalConsistencyError(
              "CSV header parsed to a non-string column; the file could not be " +
                "read correctly",
            ),
          );
          return;
        }
        resolve(Object.assign(meta, { sanitizedColumnPositions }));
      },
      error: (error) => {
        // A ceiling trip arrives here as a read error.
        release();
        reject(error);
      },
    });
  });
}

/**
 * Parse a CSV file to its complete row set, accumulated across every chunk.
 * Rejects on a read error, a ceiling trip, or a row-level fault
 * ({@link CsvRowParseError}), so the resolved `errors` are benign codes only.
 * The streaming counterpart that retains nothing is {@link streamCSVRows}.
 *
 * `delimiter` defaults to a comma; {@link CSV_DELIMITER_DETECT} detects one.
 * Of `meta`, only `fields` and `sanitizedColumnPositions` are whole-file.
 */
export async function loadCSVFile(
  file: LocalFile,
  byteCeiling: number = CSV_LINE_BYTE_CEILING,
  delimiter?: string,
): Promise<Omit<Papa.ParseResult<CSVRow>, "meta"> & { meta: CSVParseMeta }> {
  const data: Array<CSVRow> = [];
  const errors: Array<Papa.ParseError> = [];
  const meta = await runSharedCSVParse(
    file,
    byteCeiling,
    delimiter,
    (rows, chunkErrors) => {
      for (const row of rows) data.push(row);
      for (const error of chunkErrors) errors.push(error);
    },
  );
  return { data, errors, meta };
}

/**
 * Stream a CSV file to `consumeChunk`, retaining nothing, so peak memory is one
 * chunk; for server passes over CLI-scale inputs. `consumeChunk` also receives
 * the header columns. Parses and rejects exactly as {@link loadCSVFile}. The
 * faulting chunk never reaches `consumeChunk`, but earlier chunks have, so a
 * consumer with side effects discards its state on a rejection.
 */
export async function streamCSVRows(
  file: LocalFile,
  consumeChunk: (rows: Array<CSVRow>, columns: Array<string>) => void,
  byteCeiling: number = CSV_LINE_BYTE_CEILING,
  delimiter?: string,
): Promise<{
  columns: Array<string>;
  sanitizedColumnPositions: Array<number>;
}> {
  const meta = await runSharedCSVParse(
    file,
    byteCeiling,
    delimiter,
    (rows, _errors, chunkMeta) => consumeChunk(rows, chunkMeta.fields ?? []),
  );
  return {
    columns: meta.fields ?? [],
    sanitizedColumnPositions: meta.sanitizedColumnPositions,
  };
}

/**
 * Read a CSV's header plus a bounded sample of one column's non-empty values,
 * stopping as soon as `sampleLimit` values are collected or `selectColumn`
 * (called once the full header lands) returns `undefined`. Resolving the column
 * in the same pass lets it read a non-rewindable stdin. Bounded by
 * `sampleLimit` and the single-line `byteCeiling`.
 *
 * With `sampleLimit` set to {@link inferDateFormat}'s scan cap, the sample is the
 * exact prefix a full-column scan sees (inferDateInputFormat.test.ts). Rejects
 * as {@link loadCSVFile} does.
 */
export function loadCSVColumnSample(
  file: LocalFile,
  selectColumn: (columns: Array<string>) => string | undefined,
  sampleLimit: number,
  byteCeiling: number = CSV_LINE_BYTE_CEILING,
  delimiter?: string,
): Promise<CSVColumnSample> {
  const read = (): Promise<CSVColumnSample> =>
    readCSVColumnSample(
      file,
      selectColumn,
      sampleLimit,
      byteCeiling,
      delimiter,
    );
  // A Node stream is opened synchronously so the parse's listeners attach
  // before the stream can emit an error; a File's leading line is bounded first.
  if (typeof (file as StreamSource).on === "function") return read();
  return assertLeadingLineWithinByteCeiling(file, byteCeiling).then(read);
}

type CSVColumnSample = {
  columns: Array<string>;
  sanitizedColumnPositions: Array<number>;
  sampledColumn: string | undefined;
  sample: Array<string>;
};

function readCSVColumnSample(
  file: LocalFile,
  selectColumn: (columns: Array<string>) => string | undefined,
  sampleLimit: number,
  byteCeiling: number,
  delimiter: string | undefined,
): Promise<CSVColumnSample> {
  return new Promise((resolve, reject) => {
    let columns: Array<string> | undefined;
    let target: string | undefined;
    const sanitizedColumnPositions: Array<number> = [];
    const sample: Array<string> = [];

    const { input, release } = openCSVSource(file, byteCeiling);

    Papa.parse(input, {
      // Inline, never a Web Worker: see SHARED_CSV_PARSE_CONFIG.
      worker: false,
      header: true,
      skipEmptyLines: true,
      delimiter: papaParseDelimiter(delimiter),
      // The shared runner's header transform, so authored names match the
      // exchange's own read.
      transformHeader: sanitizingHeaderTransform(sanitizedColumnPositions),
      chunk: (results, parser) => {
        if (target === undefined) {
          // Wait for a non-empty header: a long one spans several chunks.
          columns = results.meta.fields ?? [];
          if (columns.length === 0) return;
          target = selectColumn(columns);
          if (target === undefined) {
            // Nothing to sample.
            parser.abort();
            return;
          }
        }
        // Narrows the outer `let` for TypeScript.
        if (target === undefined) return;
        for (const row of results.data as Array<Record<string, unknown>>) {
          const value = readRowColumn(row as CSVRow, target);
          if (typeof value === "string" && value.trim() !== "") {
            sample.push(value);
            if (sample.length >= sampleLimit) {
              parser.abort();
              return;
            }
          }
        }
      },
      complete: () => {
        release();
        // PapaParse yields at least one chunk for any input.
        if (columns === undefined) {
          reject(
            new InternalConsistencyError(
              "CSV parse completed without producing a chunk",
            ),
          );
          return;
        }
        resolve({
          columns,
          sanitizedColumnPositions,
          sampledColumn: target,
          sample,
        });
      },
      error: (error) => {
        // A ceiling trip arrives here as a read error.
        release();
        reject(error);
      },
    });
  });
}
