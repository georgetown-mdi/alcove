// The body of each part of a payload's rows: unsigned 32-bit integers,
// little-endian, and UTF-8 text, each text value after its byte length. A body
// opens with the layout tag, the part's row count and the column count, then
// holds each column's name, each row's row index, and each row's values in
// column order, a null value written as the length 2^32 - 1 with no bytes. A
// body is read only once every length it states lies within its bytes and
// every value is well-formed UTF-8, so nothing is allocated for rows the part
// does not hold. The rows read are kept as their bytes and the offset each row
// starts at, and a value becomes a string only when a row is read
// (docs/spec/PROTOCOL.md, "The payload part body").
import {
  MAX_NAME_LENGTH,
  MAX_PAYLOAD_ENTRIES,
} from "../config/linkageTermsSchema";
import { InternalConsistencyError } from "../errors";
import { loneSurrogateIndex } from "../utils/wellFormedString";
import {
  utf8Length,
  type BinaryListSource,
  type ListPartContext,
} from "./matchedListParts";

/** The first word of every payload part's body. */
export const PAYLOAD_ROWS_TAG = 8;

/** Bytes a payload part's body holds before its column names. */
export const PAYLOAD_BODY_PREFIX_BYTES = 12;

/** The length word that marks a null value. */
export const NULL_VALUE_LENGTH = 0xffff_ffff;

/** The refusal of a body whose bytes are not the ones its lengths state. */
export const PAYLOAD_LENGTH_REFUSAL =
  "is not the length its value lengths state";

const MAX_WORD = 0xffff_ffff;

// A column name of MAX_NAME_LENGTH UTF-16 code units takes at most 3 bytes per
// unit in UTF-8.
const MAX_COLUMN_NAME_BYTES = 3 * MAX_NAME_LENGTH;

const columnNameRefusal = `names a column outside 1 to ${MAX_NAME_LENGTH} characters`;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The rows of one payload to send, positional against its columns. */
export interface PayloadRowsToSend {
  readonly columns: ReadonlyArray<string>;
  /** The sender's row index for each row, one per row. */
  readonly rowIndices: ReadonlyArray<number>;
  readonly rows: ReadonlyArray<ReadonlyArray<string | null>>;
}

// The UTF-8 bytes of `text`, which must be well-formed so that the partner
// decodes the string this party commits to.
function textBytes(text: string): number {
  if (loneSurrogateIndex(text) >= 0)
    throw new InternalConsistencyError(
      "a payload value holds an unpaired UTF-16 surrogate, which has no " +
        "UTF-8 encoding",
    );
  return utf8Length(text);
}

/**
 * `payload` as a {@link BinaryListSource}, one entry per row. A row whose width
 * is not the column count, a row index that is not an unsigned 32-bit whole
 * number, a value that is not well-formed text, and more than
 * {@link MAX_PAYLOAD_ENTRIES} columns are refused before the first part is
 * built.
 */
export function payloadRowsSource(
  payload: PayloadRowsToSend,
): BinaryListSource {
  const { columns, rowIndices, rows } = payload;
  if (columns.length > MAX_PAYLOAD_ENTRIES)
    throw new InternalConsistencyError(
      `a payload of ${columns.length} columns is over the ` +
        `${MAX_PAYLOAD_ENTRIES} a payload sends`,
    );
  if (rowIndices.length !== rows.length)
    throw new InternalConsistencyError(
      "a payload does not have one row index per row",
    );
  let prefixBytes = PAYLOAD_BODY_PREFIX_BYTES;
  for (const name of columns) prefixBytes += 4 + textBytes(name);
  return {
    entries: rows.length,
    prefixBytes,
    // The sender measures every row before it builds the first part, so each
    // value is checked here and a payload holding a bad one sends nothing.
    entryBytes(index) {
      const rowIndex = rowIndices[index];
      if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex > MAX_WORD)
        throw new InternalConsistencyError(
          `a payload row index of ${rowIndex} is not an unsigned 32-bit ` +
            "whole number",
        );
      const row = rows[index];
      if (row.length !== columns.length)
        throw new InternalConsistencyError(
          "a payload row does not have one value per column",
        );
      let bytes = 4;
      for (const value of row)
        bytes += 4 + (value === null ? 0 : textBytes(value));
      return bytes;
    },
    writeBody(start, end, body) {
      const bytes = new Uint8Array(
        body.buffer,
        body.byteOffset,
        body.byteLength,
      );
      let at = 0;
      const put = (word: number): void => {
        body.setUint32(at, word, true);
        at += 4;
      };
      const putText = (text: string | null): void => {
        if (text === null) return put(NULL_VALUE_LENGTH);
        const length = utf8Length(text);
        put(length);
        const { written } = encoder.encodeInto(
          text,
          bytes.subarray(at, at + length),
        );
        if (written !== length)
          throw new InternalConsistencyError(
            `a payload value encoded to ${written} bytes, not ${length}`,
          );
        at += length;
      };
      put(PAYLOAD_ROWS_TAG);
      put(end - start);
      put(columns.length);
      for (const name of columns) putText(name);
      for (let index = start; index < end; index++) put(rowIndices[index]);
      for (let index = start; index < end; index++)
        for (const value of rows[index]) putText(value);
      if (at !== body.byteLength)
        throw new InternalConsistencyError(
          `a payload part body was written to ${at} of its ` +
            `${body.byteLength} bytes`,
        );
    },
  };
}

/**
 * Whether `bytes[start, end)` is well-formed UTF-8: no overlong form, no
 * surrogate code point, nothing past U+10FFFF, and no sequence cut short.
 *
 * @internal
 */
export function isWellFormedUtf8(
  bytes: Uint8Array,
  start: number,
  end: number,
): boolean {
  let at = start;
  while (at < end) {
    const lead = bytes[at];
    if (lead < 0x80) {
      at += 1;
      continue;
    }
    let width: number;
    let low = 0x80;
    let high = 0xbf;
    if (lead >= 0xc2 && lead <= 0xdf) width = 2;
    else if (lead >= 0xe0 && lead <= 0xef) {
      width = 3;
      if (lead === 0xe0) low = 0xa0;
      else if (lead === 0xed) high = 0x9f;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      width = 4;
      if (lead === 0xf0) low = 0x90;
      else if (lead === 0xf4) high = 0x8f;
    } else return false;
    if (at + width > end) return false;
    const second = bytes[at + 1];
    if (second < low || second > high) return false;
    for (let offset = 2; offset < width; offset++)
      if ((bytes[at + offset] & 0xc0) !== 0x80) return false;
    at += width;
  }
  return true;
}

// One part's rows: the bytes holding their values, the offset in them each row
// starts at, and the index of the part's first row among all the rows.
interface RowSegment {
  readonly values: Uint8Array;
  readonly rowStarts: Uint32Array;
  readonly firstRow: number;
}

/**
 * Received payload rows: every row's values as the body states them, length
 * words included, in one byte array per part, and the offset each row starts
 * at. A value becomes a string only when its row is read.
 */
export class ReceivedPayloadRows {
  /** How many rows there are. */
  readonly length: number;

  private constructor(
    /** How many values each row holds. */
    readonly width: number,
    private readonly segments: ReadonlyArray<RowSegment>,
  ) {
    const last = segments[segments.length - 1];
    this.length =
      last === undefined ? 0 : last.firstRow + last.rowStarts.length;
  }

  /**
   * The rows of one part, as {@link readPayloadPartBody} reads them: `values`
   * holds every row's values in turn, and row `i` starts at `rowStarts[i]`.
   */
  static ofPart(
    width: number,
    values: Uint8Array,
    rowStarts: Uint32Array,
  ): ReceivedPayloadRows {
    return new ReceivedPayloadRows(width, [{ values, rowStarts, firstRow: 0 }]);
  }

  /** The rows of `parts` in order, each part's rows of one width. */
  static join(
    width: number,
    parts: ReadonlyArray<ReceivedPayloadRows>,
  ): ReceivedPayloadRows {
    if (parts.length === 1) return parts[0];
    const segments: Array<RowSegment> = [];
    let firstRow = 0;
    for (const part of parts) {
      if (part.width !== width)
        throw new InternalConsistencyError(
          "payload parts of different widths cannot be joined",
        );
      for (const segment of part.segments) {
        segments.push({ ...segment, firstRow });
        firstRow += segment.rowStarts.length;
      }
    }
    return new ReceivedPayloadRows(width, segments);
  }

  /** The values of row `index`, a string for each text value. */
  row(index: number): Array<string | null> {
    if (!Number.isInteger(index) || index < 0 || index >= this.length)
      throw new InternalConsistencyError(
        `payload row ${index} is outside the ${this.length} rows received`,
      );
    let low = 0;
    let high = this.segments.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >>> 1;
      if (this.segments[middle].firstRow <= index) low = middle;
      else high = middle - 1;
    }
    const { values, rowStarts, firstRow } = this.segments[low];
    const view = new DataView(
      values.buffer,
      values.byteOffset,
      values.byteLength,
    );
    let at = rowStarts[index - firstRow];
    const row: Array<string | null> = [];
    for (let column = 0; column < this.width; column++) {
      const length = view.getUint32(at, true);
      at += 4;
      if (length === NULL_VALUE_LENGTH) row.push(null);
      else {
        row.push(decoder.decode(values.subarray(at, at + length)));
        at += length;
      }
    }
    return row;
  }
}

/** One payload part as read. */
export interface PayloadPart {
  readonly columns: ReadonlyArray<string>;
  readonly rowIndices: Uint32Array;
  readonly rows: ReceivedPayloadRows;
}

/**
 * Reads one payload part's body. Its row count is checked against the entries
 * the list has still to send, its column count against
 * {@link MAX_PAYLOAD_ENTRIES}, and every length it states against its bytes,
 * with every text value checked as UTF-8 and every column name against the
 * name bounds, before anything is allocated. The rows are kept as a copy of
 * the bytes that hold their values, so the part's frame is not kept with them.
 */
export function readPayloadPartBody(
  body: Uint8Array,
  part: ListPartContext,
): PayloadPart {
  const end = body.byteLength;
  if (end < PAYLOAD_BODY_PREFIX_BYTES)
    throw part.refuse(PAYLOAD_LENGTH_REFUSAL);
  const view = new DataView(body.buffer, body.byteOffset, end);
  if (view.getUint32(0, true) !== PAYLOAD_ROWS_TAG)
    throw part.refuse("is not a list of the kind awaited");
  const rowCount = view.getUint32(4, true);
  if (rowCount > part.remainingEntries)
    throw part.refuse("runs past the list's declared entries");
  const width = view.getUint32(8, true);
  if (width > MAX_PAYLOAD_ENTRIES)
    throw part.refuse(`names more than ${MAX_PAYLOAD_ENTRIES} columns`);
  if (width === 0 && rowCount > 0) throw part.refuse("names no column");

  let at = PAYLOAD_BODY_PREFIX_BYTES;
  // Steps past one length-prefixed value, refusing a length past the body's
  // end or bytes that are not UTF-8; returns the value's byte length, or -1
  // for a null.
  const skipValue = (): number => {
    if (at + 4 > end) throw part.refuse(PAYLOAD_LENGTH_REFUSAL);
    const length = view.getUint32(at, true);
    at += 4;
    if (length === NULL_VALUE_LENGTH) return -1;
    if (length > end - at) throw part.refuse(PAYLOAD_LENGTH_REFUSAL);
    if (!isWellFormedUtf8(body, at, at + length))
      throw part.refuse("holds a value that is not UTF-8 text");
    at += length;
    return length;
  };
  for (let column = 0; column < width; column++) {
    const length = skipValue();
    if (length < 1 || length > MAX_COLUMN_NAME_BYTES)
      throw part.refuse(columnNameRefusal);
  }
  const rowIndicesAt = at;
  if (4 * rowCount > end - at) throw part.refuse(PAYLOAD_LENGTH_REFUSAL);
  at += 4 * rowCount;
  const valuesAt = at;
  for (let index = 0; index < rowCount; index++)
    for (let column = 0; column < width; column++) skipValue();
  if (at !== end) throw part.refuse(PAYLOAD_LENGTH_REFUSAL);

  const columns: Array<string> = [];
  for (let nameAt = PAYLOAD_BODY_PREFIX_BYTES; nameAt < rowIndicesAt;) {
    const length = view.getUint32(nameAt, true);
    const name = decoder.decode(body.subarray(nameAt + 4, nameAt + 4 + length));
    if (name.length > MAX_NAME_LENGTH) throw part.refuse(columnNameRefusal);
    columns.push(name);
    nameAt += 4 + length;
  }
  const rowIndices = new Uint32Array(rowCount);
  for (let index = 0; index < rowCount; index++)
    rowIndices[index] = view.getUint32(rowIndicesAt + 4 * index, true);
  const values = body.slice(valuesAt);
  const valuesView = new DataView(values.buffer);
  const rowStarts = new Uint32Array(rowCount);
  let offset = 0;
  for (let index = 0; index < rowCount; index++) {
    rowStarts[index] = offset;
    for (let column = 0; column < width; column++) {
      const length = valuesView.getUint32(offset, true);
      offset += 4 + (length === NULL_VALUE_LENGTH ? 0 : length);
    }
  }
  return {
    columns,
    rowIndices,
    rows: ReceivedPayloadRows.ofPart(width, values, rowStarts),
  };
}
