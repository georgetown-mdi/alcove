import { describe, expect, test } from "vitest";

import { createMessagePipe } from "../../src/connection/messageConnection";
import { ConnectionError, InternalConsistencyError } from "../../src/errors";
import {
  matchedListParts,
  sendMatchedList,
  MATCHED_LIST_PART_HEADER_BYTES,
  type ListPartContext,
} from "../../src/psi/matchedListParts";
import {
  INDEX_LIST_LAYOUT,
  MAPPED_ELEMENT_LAYOUT,
  OMITTED_GROUPING_LAYOUT,
  OWNER_LISTS_LAYOUT,
  readWordListBody,
  receiveWordList,
  RESOLVED_TABLE_LAYOUT,
  RETURNED_ELEMENT_LAYOUT,
  RUN_LENGTHS_LAYOUT,
  WORD_LIST_LENGTH_REFUSAL,
  wordListEntryBytes,
  wordListSource,
  type WordListEntries,
  type WordListLayout,
} from "../../src/psi/uint32ListParts";

// The 32-bit word body of a matched-record list's part: its exact bytes, and
// every body a receiver refuses before it allocates anything
// (docs/spec/PROTOCOL.md, "The part body").

const LAYOUTS: ReadonlyArray<WordListLayout> = [
  INDEX_LIST_LAYOUT,
  OMITTED_GROUPING_LAYOUT,
  RUN_LENGTHS_LAYOUT,
  OWNER_LISTS_LAYOUT,
  MAPPED_ELEMENT_LAYOUT,
  RETURNED_ELEMENT_LAYOUT,
  RESOLVED_TABLE_LAYOUT,
];

// Little-endian bytes of `words`.
function bytesOf(words: ReadonlyArray<number>): Uint8Array {
  const bytes = new Uint8Array(4 * words.length);
  const view = new DataView(bytes.buffer);
  words.forEach((value, k) => view.setUint32(4 * k, value, true));
  return bytes;
}

// The body words of the one part `list` is sent in.
function sentWords(layout: WordListLayout, list: WordListEntries): number[] {
  const [part] = [...matchedListParts(wordListSource(layout, list), 1 << 20)];
  const body = part.subarray(MATCHED_LIST_PART_HEADER_BYTES);
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  return Array.from({ length: body.byteLength / 4 }, (_, k) =>
    view.getUint32(4 * k, true),
  );
}

function context(remainingEntries: number): ListPartContext {
  return {
    remainingEntries,
    refuse: (detail) => new ConnectionError(detail, "protocol"),
  };
}

// What `run` returns or throws, and the length of every Uint32Array it
// constructs.
function uint32ArrayLengths(run: () => unknown): {
  outcome: unknown;
  lengths: Array<number>;
} {
  const lengths: Array<number> = [];
  const real = globalThis.Uint32Array;
  globalThis.Uint32Array = new Proxy(real, {
    construct(target, args: Array<unknown>) {
      lengths.push(typeof args[0] === "number" ? args[0] : -1);
      return Reflect.construct(target, args) as object;
    },
  }) as Uint32ArrayConstructor;
  try {
    return { outcome: run(), lengths };
  } catch (err: unknown) {
    return { outcome: err, lengths };
  } finally {
    globalThis.Uint32Array = real;
  }
}

describe("the body's words", () => {
  test("open with the tag and entry count, then each column, counts and values", () => {
    expect(
      sentWords(MAPPED_ELEMENT_LAYOUT, {
        entries: 3,
        column: (_column, index) => [1, 0, 2][index],
        ragged: (index) => [[3, 4], [5], []][index],
      }),
    ).toStrictEqual([5, 3, 1, 0, 2, 2, 1, 0, 3, 4, 5]);
    expect(
      sentWords(RESOLVED_TABLE_LAYOUT, {
        entries: 2,
        column: (column, index) =>
          [
            [7, 8],
            [0, 1],
          ][column][index],
      }),
    ).toStrictEqual([7, 2, 7, 8, 0, 1]);
    expect(
      sentWords(OMITTED_GROUPING_LAYOUT, { entries: 0, column: () => 0 }),
    ).toStrictEqual([2, 0]);
  });

  test("are little-endian", () => {
    const [part] = [
      ...matchedListParts(
        wordListSource(INDEX_LIST_LAYOUT, {
          entries: 1,
          column: () => 0x0102_0304,
        }),
        64,
      ),
    ];
    expect([...part.subarray(MATCHED_LIST_PART_HEADER_BYTES)]).toStrictEqual([
      1, 0, 0, 0, 1, 0, 0, 0, 4, 3, 2, 1,
    ]);
  });

  test("an entry's bytes are its columns' words and, for a ragged layout, its count and values", () => {
    expect(wordListEntryBytes(INDEX_LIST_LAYOUT)).toBe(4);
    expect(wordListEntryBytes(RETURNED_ELEMENT_LAYOUT)).toBe(4);
    expect(wordListEntryBytes(RESOLVED_TABLE_LAYOUT)).toBe(8);
    expect(wordListEntryBytes(OWNER_LISTS_LAYOUT, 3)).toBe(16);
    expect(wordListEntryBytes(MAPPED_ELEMENT_LAYOUT, 1)).toBe(12);
  });

  test.each([-1, 1.5, 2 ** 32, Number.NaN])(
    "a value of %s is refused as the part is built",
    (value) => {
      const parts = () => [
        ...matchedListParts(
          wordListSource(INDEX_LIST_LAYOUT, {
            entries: 1,
            column: () => value,
          }),
          64,
        ),
      ];
      expect(parts).toThrow(InternalConsistencyError);
      expect(parts).toThrow("is not an unsigned 32-bit whole number");
    },
  );

  test.each([
    ["a fixed column", -1],
    ["a fixed column", 2 ** 32],
    ["a list per entry", 1.5],
    ["a list per entry", Number.NaN],
  ] as const)(
    "a list whose last value, in %s, is %s sends no part",
    async (where, value) => {
      // Ten parts of one entry each, the bad value in the last.
      const entries = 10;
      const last = (index: number, good: number) =>
        index === entries - 1 ? value : good;
      const sent: Array<unknown> = [];
      const [a] = createMessagePipe();
      const conn = {
        send: (data: unknown) => {
          sent.push(data);
          return a.send(data);
        },
        receive: (timeoutMs?: number) => a.receive(timeoutMs),
        close: () => a.close(),
      };
      const source = wordListSource(MAPPED_ELEMENT_LAYOUT, {
        entries,
        column: (_column, index) =>
          where === "a fixed column" ? last(index, 0) : 0,
        ragged: (index) => [where === "a list per entry" ? last(index, 1) : 1],
      });
      const outcome = await (async () => {
        for (const part of matchedListParts(source, 8 + 12))
          await conn.send(part);
      })().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(outcome).toBeInstanceOf(InternalConsistencyError);
      expect(sent).toStrictEqual([]);
      await expect(
        sendMatchedList(conn, source).then(() => undefined),
      ).rejects.toThrow(InternalConsistencyError);
      expect(sent).toStrictEqual([]);
    },
  );

  test("the largest word goes and comes back whole", async () => {
    const [a, b] = createMessagePipe();
    for (const part of matchedListParts(
      wordListSource(INDEX_LIST_LAYOUT, {
        entries: 2,
        column: (_column, index) => [0, 0xffff_ffff][index],
      }),
      64,
    ))
      await a.send(part);
    const list = await receiveWordList(
      b,
      "",
      "list",
      { entries: 2, entryBytes: 4 },
      [INDEX_LIST_LAYOUT],
    );
    expect([...list.columns[0]]).toStrictEqual([0, 0xffff_ffff]);
  });
});

describe("a list in several parts", () => {
  test.each(
    LAYOUTS.filter((layout) => layout.columns + Number(layout.ragged)).map(
      (layout) => [layout.tag, layout] as const,
    ),
  )("of the layout tagged %i joins back in order", async (_tag, layout) => {
    const entries = 50;
    const list: WordListEntries = {
      entries,
      column: (column, index) => index * 10 + column,
      ragged: (index) => Array.from({ length: index % 4 }, (_, k) => index + k),
    };
    const [a, b] = createMessagePipe();
    const parts = [...matchedListParts(wordListSource(layout, list), 64)];
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) await a.send(part);
    const received = await receiveWordList(
      b,
      "",
      "list",
      { entries, entryBytes: wordListEntryBytes(layout, 3) },
      [layout],
    );
    expect(received.layout).toBe(layout);
    expect(received.entries).toBe(entries);
    for (let column = 0; column < layout.columns; column++)
      expect([...received.columns[column]]).toStrictEqual(
        Array.from({ length: entries }, (_, index) =>
          list.column(column, index),
        ),
      );
    const lists = Array.from({ length: entries }, (_, index) =>
      Array.from(layout.ragged ? list.ragged!(index) : []),
    );
    expect([...received.counts]).toStrictEqual(
      layout.ragged ? lists.map((values) => values.length) : [],
    );
    expect([...received.values]).toStrictEqual(lists.flat());
  });
});

describe("a body refused before anything is allocated", () => {
  test.each([
    ["shorter than its tag and count", [1], 1, WORD_LIST_LENGTH_REFUSAL],
    [
      "of a tag not awaited",
      [6, 1, 0, 0],
      1,
      "is not a list of the kind awaited",
    ],
    ["of a tag no layout has", [99, 0], 1, "is not a list of the kind awaited"],
    [
      "of more entries than the list has still to send",
      [1, 3, 0, 0, 0],
      2,
      "runs past the list's declared entries",
    ],
    [
      "stating more entries than its words hold",
      [1, 3, 0, 0],
      10,
      WORD_LIST_LENGTH_REFUSAL,
    ],
    [
      "holding more words than its entries state",
      [1, 1, 0, 0],
      10,
      WORD_LIST_LENGTH_REFUSAL,
    ],
    [
      "stating the most entries a count can hold",
      [1, 0xffff_ffff, 0],
      0xffff_ffff,
      WORD_LIST_LENGTH_REFUSAL,
    ],
    [
      "stating owner counts past the values it holds",
      [4, 2, 1, 0xffff_ffff, 0],
      10,
      WORD_LIST_LENGTH_REFUSAL,
    ],
    [
      "stating owner counts short of the values it holds",
      [4, 1, 1, 0, 0],
      10,
      WORD_LIST_LENGTH_REFUSAL,
    ],
    [
      "of an omitted grouping stating entries",
      [2, 1],
      10,
      WORD_LIST_LENGTH_REFUSAL,
    ],
  ] as Array<[string, Array<number>, number, string]>)(
    "%s",
    (_name, words, remaining, detail) => {
      const { outcome, lengths } = uint32ArrayLengths(() =>
        readWordListBody(
          bytesOf(words),
          LAYOUTS.slice(0, 5),
          context(remaining),
        ),
      );
      expect(outcome).toBeInstanceOf(ConnectionError);
      expect((outcome as Error).message).toBe(detail);
      expect(lengths).toStrictEqual([]);
    },
  );

  test("a body cut inside a word is refused", () => {
    const body = bytesOf([1, 1, 7]).subarray(0, 10);
    const { outcome, lengths } = uint32ArrayLengths(() =>
      readWordListBody(body, [INDEX_LIST_LAYOUT], context(1)),
    );
    expect((outcome as Error).message).toBe(WORD_LIST_LENGTH_REFUSAL);
    expect(lengths).toStrictEqual([]);
  });

  test("a body whose counts match its words allocates only what it holds", () => {
    const { outcome, lengths } = uint32ArrayLengths(() =>
      readWordListBody(
        bytesOf([5, 2, 1, 0, 2, 1, 3, 4, 5]),
        [MAPPED_ELEMENT_LAYOUT],
        context(2),
      ),
    );
    expect(outcome).not.toBeInstanceOf(Error);
    expect(lengths).toStrictEqual([2, 2, 3]);
  });
});

test("a refused body names the part and the list, as the receive refuses it", async () => {
  const [a, b] = createMessagePipe();
  const frame = new Uint8Array(MATCHED_LIST_PART_HEADER_BYTES + 12);
  const view = new DataView(frame.buffer);
  view.setUint32(4, 1);
  view.setBigUint64(8, 2n);
  frame.set(bytesOf([1, 2, 0]), MATCHED_LIST_PART_HEADER_BYTES);
  await a.send(frame);
  const outcome = await receiveWordList(
    b,
    "joiner",
    "round original-index list",
    { entries: 10, entryBytes: 4 },
    [INDEX_LIST_LAYOUT],
  ).catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(ConnectionError);
  expect((outcome as ConnectionError).kind).toBe("protocol");
  expect((outcome as Error).message).toBe(
    "joiner protocol error: inbound round original-index list part 0 " +
      "is not the length its entry counts state",
  );
});
