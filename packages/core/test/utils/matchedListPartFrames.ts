// Builders and readers for the frames a matched-record list is sent in, so a
// test that hand-crafts or rewrites one of those lists works on the plain
// value it means rather than on the part header and the body's words
// (docs/spec/PROTOCOL.md, "A list of matched records is sent in parts"). A
// word list reads as JSON would: an index list or run lengths as an array of
// numbers, owner lists as an array of arrays, an omitted grouping as `null`, a
// mapped-element list as `{theirIndex, iteration}` entries whose one position
// is a bare number, the returned list as `{theirIndex}` entries, and the
// single-pass resolved table as its two halves, and a payload part as a
// payload message `{hasData, columns, rowIndices, rows}`. The words are written
// here with DataView rather than by the module under test, and a value a word
// cannot hold is written as `setUint32` truncates it.

import { MATCHED_LIST_PART_HEADER_BYTES } from "../../src/psi/matchedListParts";
import {
  receiveRoundGrouping,
  receiveRoundIndexList,
  sendRoundGrouping,
  sendRoundIndexList,
} from "../../src/psi/roundTableParts";
import {
  INDEX_LIST_LAYOUT,
  MAPPED_ELEMENT_LAYOUT,
  OMITTED_GROUPING_LAYOUT,
  OWNER_LISTS_LAYOUT,
  RESOLVED_TABLE_LAYOUT,
  RETURNED_ELEMENT_LAYOUT,
  RUN_LENGTHS_LAYOUT,
  type WordListLayout,
} from "../../src/psi/uint32ListParts";

import type { MessageConnection } from "../../src/connection/messageConnection";

/** One part's header fields. */
export interface PartHeader {
  readonly index: number;
  readonly count: number;
  readonly entries: number;
}

const LAYOUTS = [
  INDEX_LIST_LAYOUT,
  OMITTED_GROUPING_LAYOUT,
  RUN_LENGTHS_LAYOUT,
  OWNER_LISTS_LAYOUT,
  MAPPED_ELEMENT_LAYOUT,
  RETURNED_ELEMENT_LAYOUT,
  RESOLVED_TABLE_LAYOUT,
];

interface Entry {
  theirIndex: number | Array<number>;
  iteration: number;
}

// The layout a plain value is written in where a test names none.
function layoutOf(body: unknown): WordListLayout | undefined {
  if (body === null) return OMITTED_GROUPING_LAYOUT;
  if (!Array.isArray(body)) return undefined;
  if (body.some((entry) => Array.isArray(entry))) return OWNER_LISTS_LAYOUT;
  if (body.some((entry) => typeof entry === "object"))
    return MAPPED_ELEMENT_LAYOUT;
  return INDEX_LIST_LAYOUT;
}

/** The body of a word-list part holding `body` in `layout`. */
export function wordListBody(
  body: unknown,
  layout: WordListLayout,
): Uint8Array {
  const entries = Array.isArray(body) ? (body as Array<unknown>) : [];
  if (layout === RESOLVED_TABLE_LAYOUT) {
    const [senderRows, receiverRows] = entries as [
      Array<number>,
      Array<number>,
    ];
    return words([
      layout.tag,
      senderRows.length,
      ...senderRows,
      ...receiverRows,
    ]);
  }
  const listWords: Array<number> = [layout.tag, entries.length];
  const asEntry = (entry: unknown): Entry => entry as Entry;
  const positionsOf = (entry: unknown): Array<number> => {
    const theirIndex = asEntry(entry).theirIndex;
    return Array.isArray(theirIndex) ? theirIndex : [theirIndex];
  };
  if (layout === MAPPED_ELEMENT_LAYOUT) {
    for (const entry of entries) listWords.push(asEntry(entry).iteration);
    for (const entry of entries) listWords.push(positionsOf(entry).length);
    for (const entry of entries) listWords.push(...positionsOf(entry));
  } else if (layout === RETURNED_ELEMENT_LAYOUT) {
    for (const entry of entries)
      listWords.push(asEntry(entry).theirIndex as number);
  } else if (layout === OWNER_LISTS_LAYOUT) {
    for (const entry of entries)
      listWords.push((entry as Array<number>).length);
    for (const entry of entries) listWords.push(...(entry as Array<number>));
  } else {
    for (const entry of entries) listWords.push(entry as number);
  }
  return words(listWords);
}

function words(values: ReadonlyArray<number>): Uint8Array {
  const bytes = new Uint8Array(4 * values.length);
  const view = new DataView(bytes.buffer);
  values.forEach((value, k) => view.setUint32(4 * k, value, true));
  return bytes;
}

/** A payload message as a test writes one: the rows of one part. */
export interface PayloadMessage {
  readonly hasData: boolean;
  readonly columns?: ReadonlyArray<string>;
  readonly rowIndices?: ReadonlyArray<number>;
  readonly rows?: ReadonlyArray<ReadonlyArray<string | null>>;
}

function isPayloadMessage(body: unknown): body is PayloadMessage {
  return typeof body === "object" && body !== null && "hasData" in body;
}

/**
 * The body of a payload part holding `message`: the tag 8, the row count and
 * the column count, then each column name, each row index, and each row's
 * values, every text value after its UTF-8 byte length and a null value as
 * the length 2^32 - 1.
 */
export function payloadBody(message: PayloadMessage): Uint8Array {
  const columns = message.columns ?? [];
  const rowIndices = message.rowIndices ?? [];
  const rows = message.rows ?? [];
  const pieces: Array<Uint8Array> = [words([8, rows.length, columns.length])];
  const text = (value: string | null): void => {
    if (value === null) {
      pieces.push(words([0xffff_ffff]));
      return;
    }
    const bytes = new TextEncoder().encode(value);
    pieces.push(words([bytes.length]), bytes);
  };
  columns.forEach(text);
  pieces.push(words(rowIndices));
  for (const row of rows) row.forEach(text);
  const body = new Uint8Array(
    pieces.reduce((sum, piece) => sum + piece.length, 0),
  );
  let at = 0;
  for (const piece of pieces) {
    body.set(piece, at);
    at += piece.length;
  }
  return body;
}

/**
 * A part frame holding `body` under the stated header, in `layout` or, where
 * none is given, the word-list layout `body`'s shape names, the payload
 * layout for a payload message, or JSON for anything else; the header
 * defaults to the only part of a list of `entriesOf(body)` entries.
 */
export function partFrame(
  body: unknown,
  header: Partial<PartHeader> = {},
  layout: WordListLayout | undefined = layoutOf(body),
): Uint8Array {
  if (layout === undefined && isPayloadMessage(body))
    return frameOf(payloadBody(body), {
      ...header,
      entries: header.entries ?? entriesOf(body),
    });
  if (layout === undefined) return jsonPartFrame(body, header);
  return frameOf(wordListBody(body, layout), {
    ...header,
    entries:
      header.entries ??
      (layout === RESOLVED_TABLE_LAYOUT
        ? (body as [Array<number>])[0].length
        : entriesOf(body)),
  });
}

/**
 * A part frame holding `body` as JSON, whatever its shape, which no list's
 * part holds; the header defaults as {@link partFrame}'s does.
 */
export function jsonPartFrame(
  body: unknown,
  header: Partial<PartHeader> = {},
): Uint8Array {
  return frameOf(new TextEncoder().encode(JSON.stringify(body)), {
    ...header,
    entries: header.entries ?? entriesOf(body),
  });
}

function frameOf(
  bodyBytes: Uint8Array,
  header: Partial<PartHeader> & { entries: number },
): Uint8Array {
  const frame = new Uint8Array(
    MATCHED_LIST_PART_HEADER_BYTES + bodyBytes.length,
  );
  const view = new DataView(frame.buffer);
  view.setUint32(0, header.index ?? 0);
  view.setUint32(4, header.count ?? 1);
  view.setBigUint64(8, BigInt(header.entries));
  frame.set(bodyBytes, MATCHED_LIST_PART_HEADER_BYTES);
  return frame;
}

/**
 * The entries a list body holds as a part counts them: an array's elements,
 * or a payload message's rows.
 */
export function entriesOf(body: unknown): number {
  if (Array.isArray(body)) return body.length;
  const rows = (body as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows.length : 0;
}

// The plain value a word-list body holds, or undefined for a body that is not
// one.
function readWordListBody(
  body: Uint8Array,
): { value: unknown; layout: WordListLayout } | undefined {
  if (body.byteLength < 8 || body.byteLength % 4 !== 0) return undefined;
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const words = Array.from({ length: body.byteLength / 4 }, (_, k) =>
    view.getUint32(4 * k, true),
  );
  const layout = LAYOUTS.find((candidate) => candidate.tag === words[0]);
  if (layout === undefined) return undefined;
  const n = words[1];
  const column = (c: number): Array<number> =>
    words.slice(2 + c * n, 2 + (c + 1) * n);
  const ragged = (): Array<Array<number>> => {
    const counts = column(layout.columns);
    let at = 2 + (layout.columns + 1) * n;
    return counts.map((count) => words.slice(at, (at += count)));
  };
  if (layout === OMITTED_GROUPING_LAYOUT) return { value: null, layout };
  if (layout === OWNER_LISTS_LAYOUT) return { value: ragged(), layout };
  if (layout === MAPPED_ELEMENT_LAYOUT) {
    const rounds = column(0);
    return {
      value: ragged().map((positions, i) => ({
        theirIndex: positions.length === 1 ? positions[0] : positions,
        iteration: rounds[i],
      })),
      layout,
    };
  }
  if (layout === RESOLVED_TABLE_LAYOUT)
    return { value: [column(0), column(1)], layout };
  if (layout === RETURNED_ELEMENT_LAYOUT)
    return {
      value: column(0).map((theirIndex) => ({ theirIndex })),
      layout,
    };
  return { value: column(0), layout };
}

// The payload message a payload part's body holds, `{hasData: false}` for one
// naming no column and holding no row, or undefined for a body that is not a
// payload part's whole.
function readPayloadBody(body: Uint8Array): PayloadMessage | undefined {
  if (body.byteLength < 12) return undefined;
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  if (view.getUint32(0, true) !== 8) return undefined;
  const rowCount = view.getUint32(4, true);
  const width = view.getUint32(8, true);
  let at = 12;
  const word = (): number => {
    if (at + 4 > body.byteLength) throw new RangeError("past the body");
    const value = view.getUint32(at, true);
    at += 4;
    return value;
  };
  const text = (): string | null => {
    const length = word();
    if (length === 0xffff_ffff) return null;
    if (at + length > body.byteLength) throw new RangeError("past the body");
    const value = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(body.subarray(at, at + length));
    at += length;
    return value;
  };
  try {
    const columns = Array.from({ length: width }, () => text() as string);
    const rowIndices = Array.from({ length: rowCount }, word);
    const rows = Array.from({ length: rowCount }, () =>
      Array.from({ length: width }, text),
    );
    if (at !== body.byteLength) return undefined;
    if (width === 0 && rowCount === 0) return { hasData: false };
    return { hasData: true, columns, rowIndices, rows };
  } catch {
    return undefined;
  }
}

/**
 * The header and plain body of a part frame, and the word-list layout its body
 * is in (undefined for a payload or JSON body), or undefined for a frame that
 * is not one: not binary, or a body that is none of these (a PSI set part).
 */
export function readPartFrame(
  frame: unknown,
): { header: PartHeader; body: unknown; layout?: WordListLayout } | undefined {
  if (
    !(frame instanceof Uint8Array) ||
    frame.byteLength <= MATCHED_LIST_PART_HEADER_BYTES
  )
    return undefined;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const header = {
    index: view.getUint32(0),
    count: view.getUint32(4),
    entries: Number(view.getBigUint64(8)),
  };
  const bodyBytes = frame.subarray(MATCHED_LIST_PART_HEADER_BYTES);
  const payload = readPayloadBody(bodyBytes);
  if (payload !== undefined) return { header, body: payload };
  const words = readWordListBody(bodyBytes);
  if (words !== undefined)
    return { header, body: words.value, layout: words.layout };
  try {
    return {
      header,
      body: JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes),
      ),
    };
  } catch {
    return undefined;
  }
}

/**
 * Passes a frame through `deviate` as a deviation written against plain
 * values reads it: a single-part list frame's body is handed over and the
 * result sent, in the same layout, as the only part of a list of its own
 * entries, and any other frame is handed over as it arrived.
 */
export function deviateListBody(
  frame: unknown,
  deviate: (frame: unknown) => unknown,
): unknown {
  const read = readPartFrame(frame);
  if (read === undefined || read.header.count !== 1) return deviate(frame);
  const deviated = deviate(read.body);
  return partFrame(
    deviated,
    {},
    read.layout === OMITTED_GROUPING_LAYOUT ? layoutOf(deviated) : read.layout,
  );
}

/**
 * `conn` with every inbound frame passed through `deviate` as
 * {@link deviateListBody} does, except that a cascade round's position-naming
 * lists -- the one-part lists arriving right after a PSI set part -- are read
 * together and handed over as the one frame they make up: the association
 * table `[partnerHalf, localHalf]` on the starter and the original-index list
 * on the joiner, each with the sender's grouping beside it where one is
 * present. What `deviate` returns is split back into the lists in the same
 * reading.
 *
 * @param party - The role receiving: the starter reads the association table,
 *   the joiner the original-index list.
 * @param grouped - Whether the round sends a grouping list after its index
 *   lists.
 */
export function roundFramesInbound(
  conn: MessageConnection,
  party: "starter" | "joiner",
  grouped: boolean,
  deviate: (frame: unknown) => unknown,
): MessageConnection {
  const queued: Array<unknown> = [];
  let afterPsiSetPart = false;
  const indexLists = party === "starter" ? 2 : 1;
  let groupingLayout: WordListLayout | undefined;
  const readOnePartBody = (frame: unknown): unknown => {
    const read = readPartFrame(frame);
    if (read === undefined || read.header.count !== 1)
      throw new Error("roundFramesInbound reads one-part lists only");
    if (read.layout !== INDEX_LIST_LAYOUT) groupingLayout = read.layout;
    return read.body;
  };
  // A grouping's form follows its value, and an empty one keeps the form it
  // arrived in.
  const groupingLayoutOf = (body: unknown): WordListLayout => {
    if (body === null) return OMITTED_GROUPING_LAYOUT;
    const entries = body as Array<unknown>;
    if (entries.some((entry) => Array.isArray(entry)))
      return OWNER_LISTS_LAYOUT;
    if (entries.length > 0 || groupingLayout !== OWNER_LISTS_LAYOUT)
      return RUN_LENGTHS_LAYOUT;
    return OWNER_LISTS_LAYOUT;
  };
  const receive = async (timeoutMs?: number): Promise<unknown> => {
    if (queued.length > 0) return queued.shift();
    const frame = await conn.receive(timeoutMs);
    const read = readPartFrame(frame);
    if (frame instanceof Uint8Array && read === undefined) {
      afterPsiSetPart = true;
      return deviate(frame);
    }
    if (read === undefined || !afterPsiSetPart)
      return deviateListBody(frame, deviate);
    afterPsiSetPart = false;
    const lists = [readOnePartBody(frame)];
    for (let i = 1; i < indexLists + (grouped ? 1 : 0); i++)
      lists.push(readOnePartBody(await conn.receive(timeoutMs)));
    const grouping = grouped ? lists[indexLists] : null;
    const indices = lists.slice(0, indexLists);
    const whole =
      party === "starter"
        ? grouping === null
          ? indices
          : [...indices, grouping]
        : grouping === null
          ? indices[0]
          : [indices[0], grouping];
    const deviated = deviate(whole);
    let bodies: Array<unknown>;
    if (party === "starter") {
      const table = deviated as Array<unknown>;
      bodies = [table[0], table[1]];
      if (grouped) bodies.push(table.length > 2 ? table[2] : null);
    } else {
      const twoPart =
        Array.isArray(deviated) &&
        deviated.length === 2 &&
        Array.isArray(deviated[0]);
      bodies = [twoPart ? deviated[0] : deviated];
      if (grouped) bodies.push(twoPart ? deviated[1] : null);
    }
    bodies.forEach((body, i) =>
      queued.push(
        partFrame(
          body,
          {},
          i < indexLists ? INDEX_LIST_LAYOUT : groupingLayoutOf(body),
        ),
      ),
    );
    return queued.shift();
  };
  return {
    send: (data) => conn.send(data),
    receive,
    close: () => conn.close(),
    setInboundFrameCap: conn.setInboundFrameCap?.bind(conn),
  };
}

/**
 * A cascade round's association table as a hand-played starter receives it,
 * `[joinerPositions, starterSlots]`, its grouping list read and dropped.
 */
export async function receiveHandPlayedRoundTable(
  conn: MessageConnection,
): Promise<[Array<number>, Array<number>]> {
  const read = () =>
    receiveRoundIndexList(
      conn,
      "",
      "association table",
      Number.MAX_SAFE_INTEGER,
    );
  const joinerPositions = await read();
  const starterSlots = await read();
  await receiveRoundGrouping(conn, "", "grouping", Number.MAX_SAFE_INTEGER, {
    maxPositionsPerRecord: 2 ** 31,
    partnerRecordCount: 2 ** 31,
    ownerLists: true,
  });
  return [joinerPositions, starterSlots];
}

/**
 * Sends a cascade round's original-index list as a hand-played starter does,
 * its grouping omitted.
 */
export async function sendHandPlayedOriginalIndexList(
  conn: MessageConnection,
  list: ReadonlyArray<number>,
): Promise<void> {
  await sendRoundIndexList(conn, list);
  await sendRoundGrouping(conn, "", undefined);
}

/**
 * The payload message a part frame holds, or undefined for any other frame:
 * the body of a part whose JSON is an object stating `hasData`.
 */
export function payloadPartBody(
  frame: unknown,
): { hasData: boolean; rows?: Array<Array<string | null>> } | undefined {
  const body = readPartFrame(frame)?.body;
  return typeof body === "object" && body !== null && "hasData" in body
    ? (body as { hasData: boolean })
    : undefined;
}
