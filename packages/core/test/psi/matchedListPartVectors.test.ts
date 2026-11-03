import { ConnectionError } from "../../src/errors";
import { readFileSync } from "node:fs";

import { expect, test } from "vitest";

import { createMessagePipe } from "../../src/connection/messageConnection";
import {
  mappedElementEntryBytes,
  mappedElementSource,
} from "../../src/psi/link";
import {
  MATCHED_LIST_PART_HEADER_BYTES,
  matchedListParts,
} from "../../src/psi/matchedListParts";
import {
  MAPPED_ELEMENT_LAYOUT,
  receiveWordList,
} from "../../src/psi/uint32ListParts";

type MappedElementEntry = Parameters<typeof mappedElementSource>[0][number];

// Replays matched-list-part-vectors.json
// (generate-matched-list-part-vectors.mjs): the parts a cascade cuts a
// mapped-element list into, byte for byte, and the part sequences a receiver
// refuses, with the refusal's whole message.

interface ListPartVectors {
  headerBytes: number;
  lists: Array<{
    name: string;
    entries: Array<MappedElementEntry>;
    partPayloadBytes: number;
    partsHex: Array<string>;
  }>;
  refusals: Array<{
    name: string;
    partsHex: Array<string>;
    maxEntries: number;
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
