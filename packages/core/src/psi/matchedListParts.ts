// A list naming matched records -- each party's mapped-element list, the list
// returned with the partner's rows, and the payload rows -- is sent as one or
// more parts, each a binary frame within the partner's per-frame receive bound
// and each holding a JSON body that parses on its own. Every part begins with
// the header a PSI set part begins with, its third field counting the list's
// entries rather than bytes, so a missing, repeated, or inconsistent part, and
// a list declaring more entries than the receiver admits, is refused from the
// header of the part that draws it. Each part's body is parsed as the part
// arrives, so the receiver holds one unparsed part at a time
// (docs/spec/PROTOCOL.md, "A list of matched records is sent in parts").
import { ConnectionError } from "../errors";
import {
  MAX_JSON_ARRAY_ELEMENTS,
  parseBoundedJson,
} from "../utils/boundedJson";
import { receiveBinaryFrame } from "./psiBinaryFrame";
import {
  PSI_SET_PART_HEADER_BYTES,
  psiSetPartPayloadBytes,
} from "./psiSetParts";

import type { MessageConnection } from "../connection/messageConnection";

/**
 * Bytes of the header every part of a matched-record list begins with: the
 * part's index and the list's part count, each an unsigned 32-bit integer,
 * then the list's entry count, an unsigned 64-bit integer, all big-endian.
 */
export const MATCHED_LIST_PART_HEADER_BYTES = PSI_SET_PART_HEADER_BYTES;

/**
 * The most entries one part holds: a part's body is parsed as one JSON
 * message, whose arrays the receiver holds to this many elements.
 */
export const MAX_MATCHED_LIST_PART_ENTRIES = MAX_JSON_ARRAY_ELEMENTS;

const MAX_PART_COUNT = 0xffff_ffff;

/** A list to send in parts, read one entry at a time. */
export interface MatchedListSource {
  /** How many entries the list holds. */
  readonly entries: number;
  /**
   * The most UTF-8 bytes entry `index` adds to a part's body, its separators
   * included.
   */
  entryBytes(index: number): number;
  /** The JSON value a part holding entries `start` to `end` (exclusive) sends. */
  body(start: number, end: number): unknown;
}

/** The UTF-8 length of `text`, as `TextEncoder` encodes it. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 &&
      text.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** A plain JSON array as a {@link MatchedListSource}, one entry per element. */
export function arraySource(list: ReadonlyArray<unknown>): MatchedListSource {
  return {
    entries: list.length,
    entryBytes: (index) => utf8Length(JSON.stringify(list[index])) + 1,
    body: (start, end) => list.slice(start, end),
  };
}

// The entry index each part after the first starts at, cut so each part's body
// fits `payloadBytes` and holds at most `maxPartEntries` entries.
function partStarts(
  source: MatchedListSource,
  payloadBytes: number,
  maxPartEntries: number,
): number[] {
  const fixedBytes = utf8Length(JSON.stringify(source.body(0, 0)));
  const room = payloadBytes - fixedBytes;
  const starts: number[] = [];
  let used = 0;
  let inPart = 0;
  for (let index = 0; index < source.entries; index++) {
    const bytes = source.entryBytes(index);
    if (bytes > room)
      throw new Error(
        `a matched-record list entry of ${bytes} bytes does not fit one ` +
          `part, which holds ${room} bytes of entries`,
      );
    if (inPart > 0 && (used + bytes > room || inPart === maxPartEntries)) {
      starts.push(index);
      used = 0;
      inPart = 0;
    }
    used += bytes;
    inPart++;
  }
  return starts;
}

/**
 * The frames that send `source` in parts whose bodies hold at most
 * `payloadBytes` bytes each, in order, built one at a time. An empty list is
 * one part holding no entries.
 *
 * @param maxPartEntries - The most entries one part holds,
 *   {@link MAX_MATCHED_LIST_PART_ENTRIES} unless a test lowers it.
 */
export function* matchedListParts(
  source: MatchedListSource,
  payloadBytes: number,
  maxPartEntries: number = MAX_MATCHED_LIST_PART_ENTRIES,
): Generator<Uint8Array> {
  const starts = partStarts(source, payloadBytes, maxPartEntries);
  const count = starts.length + 1;
  if (count > MAX_PART_COUNT)
    throw new Error(
      `a matched-record list of ${source.entries} entries needs ${count} parts`,
    );
  const encoder = new TextEncoder();
  for (let index = 0; index < count; index++) {
    const start = index === 0 ? 0 : starts[index - 1];
    const end = index === count - 1 ? source.entries : starts[index];
    const json = JSON.stringify(source.body(start, end));
    const bodyBytes = utf8Length(json);
    if (bodyBytes > payloadBytes)
      throw new Error(
        `a matched-record list part of ${bodyBytes} bytes is over the ` +
          `${payloadBytes} bytes its entries were measured to fit`,
      );
    const part = new Uint8Array(MATCHED_LIST_PART_HEADER_BYTES + bodyBytes);
    const header = new DataView(part.buffer);
    header.setUint32(0, index);
    header.setUint32(4, count);
    header.setBigUint64(8, BigInt(source.entries));
    encoder.encodeInto(json, part.subarray(MATCHED_LIST_PART_HEADER_BYTES));
    yield part;
  }
}

/**
 * Sends `source` on `conn` in parts sized by {@link psiSetPartPayloadBytes},
 * the bound one part of a PSI set is sized to. `onPartSent` runs after each
 * part's send resolves.
 */
export async function sendMatchedList(
  conn: MessageConnection,
  source: MatchedListSource,
  onPartSent?: () => void,
): Promise<void> {
  for (const part of matchedListParts(source, psiSetPartPayloadBytes(conn))) {
    await conn.send(part);
    onPartSent?.();
  }
}

function entryCount(count: number | bigint): string {
  return `${count} ${count === 1 || count === 1n ? "entry" : "entries"}`;
}

function refusal(
  participantId: string,
  what: string,
  detail: string,
): ConnectionError {
  const prefix = participantId === "" ? "" : `${participantId} `;
  return new ConnectionError(
    `${prefix}protocol error: inbound ${what} ${detail}`,
    "protocol",
  );
}

/**
 * Receives the parts of one list sent by {@link sendMatchedList}, parsing each
 * as it arrives, and returns the parsed parts in order once their entries add
 * up to the declared count.
 *
 * Each part's header is checked first: the list's declared entry count
 * against `maxEntries` at the first part, and each part's index and declared
 * count and entries against the part expected next and against the first
 * part's; a part with no body bytes, or shorter than its header, is refused.
 * Its body is then parsed through {@link parseBoundedJson} and `parsePart`,
 * which validates it and states how many entries it holds, before the next
 * part is read. A body that is not JSON, a part holding no entries in a list
 * that is not empty, a part running past the declared count, and parts ending
 * short of it are refused. Every refusal is a `protocol`
 * {@link ConnectionError}, raised at the part that draws it. An abort frame in
 * place of any part ends the receive as a peer abort.
 *
 * @param participantId - This party's participant id, prefixed on every
 *   refusal, or "" for none.
 * @param what - The list awaited, named in every refusal.
 * @param maxEntries - The most entries the list may hold, derived from the
 *   agreed terms and this party's own result.
 * @param parsePart - Validates one part's parsed body and returns it with its
 *   entry count; it throws on a body of the wrong shape.
 */
export async function receiveMatchedListParts<T>(
  conn: MessageConnection,
  participantId: string,
  what: string,
  maxEntries: number,
  parsePart: (value: unknown) => { readonly part: T; readonly entries: number },
): Promise<Array<T>> {
  const refuse = (detail: string): ConnectionError =>
    refusal(participantId, what, detail);
  const parts: Array<T> = [];
  let count = 1;
  let entries = 0;
  let filled = 0;
  for (let expected = 0; expected < count; expected++) {
    const part = await receiveBinaryFrame(conn, participantId, what);
    if (part.byteLength < MATCHED_LIST_PART_HEADER_BYTES)
      throw refuse(`part ${expected} is shorter than its header`);
    const header = new DataView(
      part.buffer,
      part.byteOffset,
      MATCHED_LIST_PART_HEADER_BYTES,
    );
    const index = header.getUint32(0);
    const declaredCount = header.getUint32(4);
    const declaredEntries = header.getBigUint64(8);
    if (index < expected) throw refuse(`repeats part ${index}`);
    if (index > expected) throw refuse(`is missing part ${expected}`);
    if (expected === 0) {
      if (declaredEntries > BigInt(maxEntries))
        throw refuse(
          `declares ${entryCount(declaredEntries)}, over the ${maxEntries} this ` +
            "party admits",
        );
      entries = Number(declaredEntries);
      count = declaredCount;
      if (count < 1 || count > Math.max(1, entries))
        throw refuse(
          `declares ${count} parts for a list of ${entryCount(entries)}`,
        );
    } else if (declaredCount !== count || declaredEntries !== BigInt(entries)) {
      throw refuse(`part ${index} declares a different list than part 0`);
    }
    const body = part.subarray(MATCHED_LIST_PART_HEADER_BYTES);
    if (body.byteLength === 0) throw refuse(`part ${index} has no body`);
    let value: unknown;
    try {
      value = parseBoundedJson(body);
    } catch {
      throw refuse(`part ${index} is not a JSON message`);
    }
    const parsed = parsePart(value);
    if (parsed.entries === 0 && entries > 0)
      throw refuse(`part ${index} holds no entries`);
    if (parsed.entries > entries - filled)
      throw refuse(`part ${index} runs past the list's declared entries`);
    filled += parsed.entries;
    parts.push(parsed.part);
  }
  if (filled !== entries)
    throw refuse("ends short of the list's declared entries");
  return parts;
}

/**
 * `parsePart` as the part parse {@link receiveMatchedListParts} takes, for a
 * list whose parts are plain JSON arrays.
 */
export function arrayPart<T>(
  parsePart: (value: unknown) => Array<T>,
): (value: unknown) => { readonly part: Array<T>; readonly entries: number } {
  return (value) => {
    const part = parsePart(value);
    return { part, entries: part.length };
  };
}

/**
 * Receives a list sent as a plain JSON array by {@link sendMatchedList} over
 * {@link arraySource}: {@link receiveMatchedListParts}, each part validated by
 * `parsePart`, the parts joined in order.
 */
export async function receiveMatchedArray<T>(
  conn: MessageConnection,
  participantId: string,
  what: string,
  maxEntries: number,
  parsePart: (value: unknown) => Array<T>,
): Promise<Array<T>> {
  return joinMatchedArrayParts(
    await receiveMatchedListParts(
      conn,
      participantId,
      what,
      maxEntries,
      arrayPart(parsePart),
    ),
  );
}

/** Joins a plain JSON array's parsed parts, in order. */
export function joinMatchedArrayParts<T>(
  parts: ReadonlyArray<Array<T>>,
): Array<T> {
  if (parts.length === 1) return parts[0];
  const joined: Array<T> = [];
  for (const part of parts) for (const entry of part) joined.push(entry);
  return joined;
}
