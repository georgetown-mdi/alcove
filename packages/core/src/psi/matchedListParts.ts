// A list naming matched records -- a round's index lists and groupings, each
// party's mapped-element list, the list returned with the partner's rows, the
// single-pass resolved table, and the payload rows -- is sent as one or more
// parts, each a binary frame within the partner's per-frame receive bound and
// each holding a body that reads on its own: 32-bit words
// (uint32ListParts.ts), or JSON for the payload rows. Every part begins with
// the header a PSI set part begins with, its third field counting the list's
// entries rather than bytes, so a missing, repeated, or inconsistent part, and
// a list declaring more entries than the receiver admits, is refused from the
// header of the part that draws it, and a part longer than its remaining
// entries can be is refused before its body is read. Each part's body is read
// as the part arrives, so the receiver holds one unread part at a time
// (docs/spec/PROTOCOL.md, "A list of matched records is sent in parts").
import { ConnectionError, chainDetailCauses } from "../errors";
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
 * The most entries one part of a JSON list holds: its body is parsed as one
 * JSON message, whose arrays the receiver holds to this many elements.
 */
export const MAX_MATCHED_LIST_PART_ENTRIES = MAX_JSON_ARRAY_ELEMENTS;

/**
 * Bytes a word-list part's body holds before its entries: the layout tag and
 * the part's entry count (uint32ListParts.ts).
 */
export const WORD_LIST_BODY_PREFIX_BYTES = 8;

const MAX_PART_COUNT = 0xffff_ffff;

// The most entries one part of a word list holds: its entry count is a uint32.
const MAX_WORD_LIST_PART_ENTRIES = 0xffff_ffff;

/**
 * What a receiver admits of one list, derived from the agreed terms and this
 * party's own result.
 */
export interface MatchedListBound {
  /** The most entries the list may declare, checked at its first part. */
  readonly entries: number;
  /**
   * The most bytes one entry adds to a part's body, for a list whose parts
   * hold words: each part is then held to {@link matchedListPartByteBound}
   * over the entries the list has still to send. Absent where no byte bound
   * derives from the terms, as for a payload's rows.
   */
  readonly entryBytes?: number;
  /**
   * The most bytes all the list's parts hold together, every part counted
   * whole with its header, given the part count the list declares at its
   * first part: each part is then held to what the earlier parts left of
   * this. For a list whose entries have no useful single longest length.
   */
  readonly listBytes?: (declaredParts: number) => number;
}

// The most bytes the part expected next may hold, or undefined where the
// bound states no byte limit.
function partByteBound(
  bound: MatchedListBound,
  listBytes: number | undefined,
  remainingEntries: number,
  heldPartBytes: number,
): number | undefined {
  let maxPartBytes: number | undefined;
  if (bound.entryBytes !== undefined)
    maxPartBytes = matchedListPartByteBound(remainingEntries, bound.entryBytes);
  if (listBytes !== undefined) {
    const left = Math.max(0, listBytes - heldPartBytes);
    maxPartBytes =
      maxPartBytes === undefined ? left : Math.min(maxPartBytes, left);
  }
  return maxPartBytes;
}

/**
 * The most bytes a part of a word list holds, its header included, when it
 * holds at most `entries` entries of at most `entryBytes` bytes each.
 */
export function matchedListPartByteBound(
  entries: number,
  entryBytes: number,
): number {
  return (
    MATCHED_LIST_PART_HEADER_BYTES +
    WORD_LIST_BODY_PREFIX_BYTES +
    entries * entryBytes
  );
}

/** A list to send in parts whose bodies are 32-bit words, one entry at a time. */
export interface WordListSource {
  /** How many entries the list holds. */
  readonly entries: number;
  /** The bytes entry `index` adds to a part's body. */
  entryBytes(index: number): number;
  /**
   * Writes the body of a part holding entries `start` to `end` (exclusive)
   * into `body`, which is exactly as long as those entries and the body's
   * prefix take.
   */
  writeBody(start: number, end: number, body: DataView): void;
}

/** A list to send in parts whose bodies are JSON, one entry at a time. */
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

function isWordListSource(
  source: MatchedListSource | WordListSource,
): source is WordListSource {
  return "writeBody" in source;
}

// The bytes a part's body holds before its entries.
function fixedBodyBytes(source: MatchedListSource | WordListSource): number {
  return isWordListSource(source)
    ? WORD_LIST_BODY_PREFIX_BYTES
    : utf8Length(JSON.stringify(source.body(0, 0)));
}

// The entry index each part after the first starts at, cut so each part's body
// fits `payloadBytes` and holds at most `maxPartEntries` entries.
function partStarts(
  source: MatchedListSource | WordListSource,
  payloadBytes: number,
  maxPartEntries: number,
): number[] {
  const room = payloadBytes - fixedBodyBytes(source);
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
 * @param maxPartEntries - The most entries one part holds: for a JSON list
 *   {@link MAX_MATCHED_LIST_PART_ENTRIES} unless a test lowers it, and for a
 *   word list the most its uint32 entry count states.
 */
export function* matchedListParts(
  source: MatchedListSource | WordListSource,
  payloadBytes: number,
  maxPartEntries: number = isWordListSource(source)
    ? MAX_WORD_LIST_PART_ENTRIES
    : MAX_MATCHED_LIST_PART_ENTRIES,
): Generator<Uint8Array> {
  const starts = partStarts(source, payloadBytes, maxPartEntries);
  const count = starts.length + 1;
  if (count > MAX_PART_COUNT)
    throw new Error(
      `a matched-record list of ${source.entries} entries needs ${count} parts`,
    );
  for (let index = 0; index < count; index++) {
    const start = index === 0 ? 0 : starts[index - 1];
    const end = index === count - 1 ? source.entries : starts[index];
    const part = isWordListSource(source)
      ? wordListPart(source, start, end)
      : jsonListPart(source, start, end);
    const bodyBytes = part.byteLength - MATCHED_LIST_PART_HEADER_BYTES;
    if (bodyBytes > payloadBytes)
      throw new Error(
        `a matched-record list part of ${bodyBytes} bytes is over the ` +
          `${payloadBytes} bytes its entries were measured to fit`,
      );
    const header = new DataView(part.buffer);
    header.setUint32(0, index);
    header.setUint32(4, count);
    header.setBigUint64(8, BigInt(source.entries));
    yield part;
  }
}

// A part holding entries `start` to `end` of a JSON list, its header unset.
function jsonListPart(
  source: MatchedListSource,
  start: number,
  end: number,
): Uint8Array {
  const json = JSON.stringify(source.body(start, end));
  const part = new Uint8Array(
    MATCHED_LIST_PART_HEADER_BYTES + utf8Length(json),
  );
  new TextEncoder().encodeInto(
    json,
    part.subarray(MATCHED_LIST_PART_HEADER_BYTES),
  );
  return part;
}

// A part holding entries `start` to `end` of a word list, its header unset.
function wordListPart(
  source: WordListSource,
  start: number,
  end: number,
): Uint8Array {
  let bodyBytes = WORD_LIST_BODY_PREFIX_BYTES;
  for (let index = start; index < end; index++)
    bodyBytes += source.entryBytes(index);
  const part = new Uint8Array(MATCHED_LIST_PART_HEADER_BYTES + bodyBytes);
  source.writeBody(
    start,
    end,
    new DataView(part.buffer, MATCHED_LIST_PART_HEADER_BYTES, bodyBytes),
  );
  return part;
}

/**
 * Sends `source` on `conn` in parts sized by {@link psiSetPartPayloadBytes},
 * the bound one part of a PSI set is sized to. `onPartSent` runs after each
 * part's send resolves.
 */
export async function sendMatchedList(
  conn: MessageConnection,
  source: MatchedListSource | WordListSource,
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
  partnerValue?: string,
): ConnectionError {
  const prefix = participantId === "" ? "" : `${participantId} `;
  return new ConnectionError(
    `${prefix}protocol error: inbound ${what} ${detail}`,
    "protocol",
    partnerValue === undefined
      ? undefined
      : { cause: chainDetailCauses([partnerValue]) },
  );
}

/** What a part's body reader is handed beside the body. */
export interface ListPartContext {
  /** The entries the list has still to send, the part's own included. */
  readonly remainingEntries: number;
  /** The refusal naming this part, `detail` stating what is wrong with it. */
  refuse(detail: string): ConnectionError;
}

/**
 * Receives the parts of one list sent by {@link sendMatchedList}, reading
 * each as it arrives, and returns the read parts in order once their entries
 * add up to the declared count.
 *
 * Each part's header is checked first: the list's declared entry count
 * against `bound.entries` at the first part, and each part's index and
 * declared count and entries against the part expected next and against the
 * first part's; a part with no body bytes, or shorter than its header, is
 * refused. Where `bound.entryBytes` is given, a part longer than
 * {@link matchedListPartByteBound} over the entries the list has still to send
 * is refused next, and where `bound.listBytes` is given, a part longer than
 * what the earlier parts, headers included, left of it at the part count the
 * first part declares. Its body is then read by `readPart`, which validates it
 * and states how many entries it holds, before the next part is read. A part
 * holding no entries in a list that is not empty, a part running past the
 * declared count, and parts ending short of it are refused. Every refusal is
 * a `protocol` {@link ConnectionError}, raised at the part that draws it. An
 * abort frame in place of any part ends the receive as a peer abort.
 *
 * @param participantId - This party's participant id, prefixed on every
 *   refusal, or "" for none.
 * @param what - The list awaited, named in every refusal.
 * @param bound - What this party admits of the list.
 * @param readPart - Reads one part's body and returns it with its entry
 *   count; it throws on a body of the wrong shape.
 */
export async function receiveListParts<T>(
  conn: MessageConnection,
  participantId: string,
  what: string,
  bound: MatchedListBound,
  readPart: (
    body: Uint8Array,
    context: ListPartContext,
  ) => { readonly part: T; readonly entries: number },
): Promise<Array<T>> {
  const refuse = (detail: string, partnerValue?: string): ConnectionError =>
    refusal(participantId, what, detail, partnerValue);
  const { entries: maxEntries } = bound;
  const parts: Array<T> = [];
  let count = 1;
  let entries = 0;
  let filled = 0;
  let heldPartBytes = 0;
  let listBytes: number | undefined;
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
      listBytes = bound.listBytes?.(count);
    } else if (declaredCount !== count || declaredEntries !== BigInt(entries)) {
      throw refuse(`part ${index} declares a different list than part 0`);
    }
    const maxPartBytes = partByteBound(
      bound,
      listBytes,
      entries - filled,
      heldPartBytes,
    );
    if (maxPartBytes !== undefined && part.byteLength > maxPartBytes)
      throw refuse(
        `part ${index} is over the ${maxPartBytes} bytes this party admits ` +
          "for it",
        `size of the part the partner sent: ${part.byteLength} bytes`,
      );
    const body = part.subarray(MATCHED_LIST_PART_HEADER_BYTES);
    if (body.byteLength === 0) throw refuse(`part ${index} has no body`);
    const parsed = readPart(body, {
      remainingEntries: entries - filled,
      refuse: (detail) => refuse(`part ${index} ${detail}`),
    });
    if (parsed.entries === 0 && entries > 0)
      throw refuse(`part ${index} holds no entries`);
    if (parsed.entries > entries - filled)
      throw refuse(`part ${index} runs past the list's declared entries`);
    filled += parsed.entries;
    heldPartBytes += part.byteLength;
    parts.push(parsed.part);
  }
  if (filled !== entries)
    throw refuse("ends short of the list's declared entries");
  return parts;
}

/**
 * {@link receiveListParts} for a list whose parts are JSON: each body is
 * parsed through {@link parseBoundedJson}, a body that is not JSON refused,
 * and then validated by `parsePart`.
 */
export async function receiveMatchedListParts<T>(
  conn: MessageConnection,
  participantId: string,
  what: string,
  bound: MatchedListBound,
  parsePart: (value: unknown) => { readonly part: T; readonly entries: number },
): Promise<Array<T>> {
  return receiveListParts(conn, participantId, what, bound, (body, part) => {
    let value: unknown;
    try {
      value = parseBoundedJson(body);
    } catch {
      throw part.refuse("is not a JSON message");
    }
    return parsePart(value);
  });
}
