import { ConnectionError } from "../../src/errors";
import { readFileSync } from "node:fs";

import { expect, test } from "vitest";

import { createMessagePipe } from "../../src/connection/messageConnection";
import {
  mappedElementEntryBytes,
  mappedElementSource,
  resolvedTableSource,
  returnedElementSource,
} from "../../src/psi/link";
import {
  MATCHED_LIST_PART_HEADER_BYTES,
  matchedListParts,
  receiveListParts,
  type BinaryListSource,
} from "../../src/psi/matchedListParts";
import { joinPayloadParts } from "../../src/payloadExchange";
import {
  payloadRowsSource,
  readPayloadPartBody,
} from "../../src/psi/payloadRowParts";
import { plainPayload } from "../utils/plainPayload";
import {
  INDEX_LIST_LAYOUT,
  MAPPED_ELEMENT_LAYOUT,
  OMITTED_GROUPING_LAYOUT,
  OWNER_LISTS_LAYOUT,
  receiveWordList,
  RESOLVED_TABLE_LAYOUT,
  RETURNED_ELEMENT_LAYOUT,
  RUN_LENGTHS_LAYOUT,
  wordListEntryBytes,
  wordListSource,
} from "../../src/psi/uint32ListParts";

type MappedElementEntry = Parameters<typeof mappedElementSource>[0][number];

// Replays matched-list-part-vectors.json
// (generate-matched-list-part-vectors.mjs): the parts a list of matched
// records is cut into, byte for byte, in every word-list layout and as payload
// rows, and the part sequences a receiver refuses, with the refusal's whole
// message.

interface LayoutVector {
  name: string;
  tag: number;
  entries: number;
  columns: Array<Array<number>>;
  lists: Array<Array<number>>;
  partPayloadBytes: number;
  partsHex: Array<string>;
}

interface ListPartVectors {
  headerBytes: number;
  lists: Array<{
    name: string;
    entries: Array<MappedElementEntry>;
    partPayloadBytes: number;
    partsHex: Array<string>;
  }>;
  layouts: Array<LayoutVector>;
  refusals: Array<{
    name: string;
    partsHex: Array<string>;
    maxEntries: number;
    refusal: string;
  }>;
  payloads: Array<{
    name: string;
    columns: Array<string>;
    rowIndices: Array<number>;
    rows: Array<Array<string | null>>;
    partPayloadBytes: number;
    partsHex: Array<string>;
  }>;
  payloadRefusals: Array<{
    name: string;
    partsHex: Array<string>;
    refusal: string;
  }>;
}

const vectors = JSON.parse(
  readFileSync(
    new URL("../vectors/matched-list-part-vectors.json", import.meta.url),
    "utf8",
  ),
) as ListPartVectors;

const fromHex = (hex: string): Uint8Array =>
  new Uint8Array(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

// The vectors' entries hold at most two positions.
const MAX_POSITIONS = 2;

async function received(
  partsHex: Array<string>,
  maxEntries: number,
): Promise<Array<MappedElementEntry>> {
  const [a, b] = createMessagePipe();
  for (const part of partsHex) await a.send(fromHex(part));
  const list = await receiveWordList(
    b,
    "client",
    "list",
    { entries: maxEntries, entryBytes: mappedElementEntryBytes(MAX_POSITIONS) },
    [MAPPED_ELEMENT_LAYOUT],
  );
  let at = 0;
  return Array.from(list.columns[0], (iteration, index) => {
    const positions = Array.from(
      list.values.subarray(at, (at += list.counts[index])),
    );
    return {
      theirIndex: positions.length === 1 ? positions[0] : positions,
      iteration,
    };
  });
}

test("the header length is the one the vectors state", () => {
  expect(MATCHED_LIST_PART_HEADER_BYTES).toBe(vectors.headerBytes);
});

test.each(vectors.lists.map((v) => [v.name, v] as const))(
  "%s",
  async (_name, vector) => {
    expect(
      [
        ...matchedListParts(
          mappedElementSource(vector.entries),
          vector.partPayloadBytes,
        ),
      ].map(toHex),
    ).toEqual(vector.partsHex);
    expect(await received(vector.partsHex, vector.entries.length)).toEqual(
      vector.entries,
    );
  },
);

const LAYOUT_OF_TAG = new Map(
  [
    INDEX_LIST_LAYOUT,
    OMITTED_GROUPING_LAYOUT,
    RUN_LENGTHS_LAYOUT,
    OWNER_LISTS_LAYOUT,
    RETURNED_ELEMENT_LAYOUT,
    RESOLVED_TABLE_LAYOUT,
  ].map((layout) => [layout.tag, layout]),
);

// The source a build sends a layout's list from: the returned list's and the
// resolved table's own, and the plain columns for the round lists, which
// roundTableParts.ts writes through wordListSource the same way.
function layoutSource(vector: LayoutVector): BinaryListSource {
  const layout = LAYOUT_OF_TAG.get(vector.tag)!;
  const { columns, lists } = vector;
  if (layout === RETURNED_ELEMENT_LAYOUT)
    return returnedElementSource(
      columns[0].map((theirIndex) => ({ theirIndex, iteration: 0 })),
    );
  if (layout === RESOLVED_TABLE_LAYOUT)
    return resolvedTableSource([columns[0], columns[1]]);
  return wordListSource(layout, {
    entries: vector.entries,
    column: (column, index) => columns[column][index],
    ragged: (index) => lists[index],
  });
}

test.each(vectors.layouts.map((v) => [v.name, v] as const))(
  "%s",
  async (_name, vector) => {
    const layout = LAYOUT_OF_TAG.get(vector.tag)!;
    expect(
      [...matchedListParts(layoutSource(vector), vector.partPayloadBytes)].map(
        toHex,
      ),
    ).toEqual(vector.partsHex);
    const [a, b] = createMessagePipe();
    for (const part of vector.partsHex) await a.send(fromHex(part));
    const list = await receiveWordList(
      b,
      "client",
      "list",
      { entries: vector.entries, entryBytes: wordListEntryBytes(layout, 2) },
      [layout],
    );
    expect(list.columns.map((column) => [...column])).toEqual(vector.columns);
    expect([...list.counts]).toEqual(vector.lists.map((v) => v.length));
    expect([...list.values]).toEqual(vector.lists.flat());
  },
);

async function receivedPayload(partsHex: Array<string>) {
  const [a, b] = createMessagePipe();
  for (const part of partsHex) await a.send(fromHex(part));
  const parts = await receiveListParts(
    b,
    "client",
    "payload",
    { entries: 16 },
    (body, part) => {
      const read = readPayloadPartBody(body, part);
      return { part: read, entries: read.rows.length };
    },
  );
  return plainPayload(joinPayloadParts(parts));
}

test.each(vectors.payloads.map((v) => [v.name, v] as const))(
  "%s",
  async (_name, vector) => {
    const { columns, rowIndices, rows } = vector;
    expect(
      [
        ...matchedListParts(
          payloadRowsSource({ columns, rowIndices, rows }),
          vector.partPayloadBytes,
        ),
      ].map(toHex),
    ).toEqual(vector.partsHex);
    expect(await receivedPayload(vector.partsHex)).toEqual({
      columns,
      rowIndices,
      rows,
    });
  },
);

test.each(vectors.payloadRefusals.map((v) => [v.name, v] as const))(
  "%s is refused",
  async (_name, vector) => {
    await expect(receivedPayload(vector.partsHex)).rejects.toThrow(
      new ConnectionError(
        `client protocol error: inbound payload ${vector.refusal}`,
        "protocol",
      ),
    );
  },
);

test.each(vectors.refusals.map((v) => [v.name, v] as const))(
  "%s is refused",
  async (_name, vector) => {
    await expect(received(vector.partsHex, vector.maxEntries)).rejects.toThrow(
      new ConnectionError(
        `client protocol error: inbound list ${vector.refusal}`,
        "protocol",
      ),
    );
  },
);
