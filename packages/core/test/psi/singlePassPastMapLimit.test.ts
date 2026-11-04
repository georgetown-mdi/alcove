import { describe, expect, test } from "vitest";

import {
  decodeRaggedIndexTable,
  encodeSinglePassReply,
  getDistinctValuesAndIndices,
  MatchedValues,
  replaySinglePassCascade,
  type KeyCells,
} from "../../src/psi/link";
import {
  MAX_PSI_DECODE_ELEMENTS,
  MAX_SINGLE_PASS_SET_ELEMENTS,
  MAX_UINT32,
} from "../../src/connection/frameSize";
import {
  PSI_ENCODED_ELEMENT_BYTES,
  PSI_SET_MAX_FRAMING_BYTES,
} from "../../src/connection/webrtcOutboundBound";
import { MAX_MAP_SHARD_ENTRIES } from "../../src/psi/shardedMap";
import { InternalConsistencyError, RoundSetLimitError } from "../../src/errors";

// The single-pass structures past the 2^24 entries one V8 Map holds, and the
// fixed widths of the reply that bound a set over file-sync instead
// (docs/spec/PROTOCOL.md, The limits over file-sync). The string-keyed and
// per-round maps at full size are in the stress tier
// (test/stress/singlePassPastMapLimit.stress.test.ts); here they are held
// across several shards of a lowered size.

// The largest JS Array this runtime holds, measured 2026-11-04 on Node 26.13
// (Linux arm64): `new Array(n).fill(0)` and `push` both stop at 2^27.
const MAX_JS_ARRAY_LENGTH = 2 ** 27;

describe("the single-pass set maximum over file-sync", () => {
  test("is the most elements whose setup length a uint32 holds", () => {
    const setupBytes = (elements: number) =>
      PSI_ENCODED_ELEMENT_BYTES * elements + PSI_SET_MAX_FRAMING_BYTES;
    expect(MAX_SINGLE_PASS_SET_ELEMENTS).toBe(122_713_351);
    expect(setupBytes(MAX_SINGLE_PASS_SET_ELEMENTS)).toBeLessThanOrEqual(
      MAX_UINT32,
    );
    expect(setupBytes(MAX_SINGLE_PASS_SET_ELEMENTS + 1)).toBeGreaterThan(
      MAX_UINT32,
    );
    // A response has no framing of its own, so at the same count it is the
    // shorter; the request it answers is not stated in the reply.
    expect(
      PSI_ENCODED_ELEMENT_BYTES * MAX_SINGLE_PASS_SET_ELEMENTS,
    ).toBeLessThan(setupBytes(MAX_SINGLE_PASS_SET_ELEMENTS));
  });

  test("lies above the protocol's per-set maximum and under every structure a set's values pass through", () => {
    expect(MAX_SINGLE_PASS_SET_ELEMENTS).toBeGreaterThan(
      MAX_PSI_DECODE_ELEMENTS,
    );
    expect(MAX_SINGLE_PASS_SET_ELEMENTS).toBeGreaterThan(MAX_MAP_SHARD_ENTRIES);
    // A value index is an Int32 word of the index table.
    expect(MAX_SINGLE_PASS_SET_ELEMENTS).toBeLessThan(2 ** 31);
    // The distinct values, the setup's permutation and the matched ids are
    // JS Arrays of one entry a value.
    expect(MAX_SINGLE_PASS_SET_ELEMENTS).toBeLessThan(MAX_JS_ARRAY_LENGTH);
  });
});

describe("a party's distinct values across map shards", () => {
  const keys = [
    ["a", "b", "a", "c", undefined, "d"],
    ["b", "e", "e", "f", "a", undefined],
  ];

  test("take the ids and indices they take in one shard", () => {
    const oneShard = getDistinctValuesAndIndices(
      keys,
      false,
      [1, 1],
      MAX_SINGLE_PASS_SET_ELEMENTS,
    );
    for (const shardEntries of [1, 2, 3])
      expect(
        getDistinctValuesAndIndices(
          keys,
          false,
          [1, 1],
          MAX_SINGLE_PASS_SET_ELEMENTS,
          shardEntries,
        ),
      ).toStrictEqual(oneShard);
    expect(oneShard.distinctValues).toStrictEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
  });

  test("are refused before masking one past the set maximum, whatever the shards", () => {
    for (const shardEntries of [1, 2, MAX_MAP_SHARD_ENTRIES]) {
      expect(
        getDistinctValuesAndIndices(keys, false, [1, 1], 6, shardEntries)
          .distinctValues,
      ).toHaveLength(6);
      let refusal: unknown;
      try {
        getDistinctValuesAndIndices(keys, false, [1, 1], 5, shardEntries);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(RoundSetLimitError);
      expect((refusal as RoundSetLimitError).reason).toBe("over-set-maximum");
    }
  });
});

type Cells = Array<Array<number>>;

function cellsView(cells: Cells): KeyCells {
  return {
    count: (row) => cells[row].length,
    valueAt: (row, k) => cells[row][k],
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCells(
  rand: () => number,
  rows: number,
  alphabet: number,
): Cells {
  return Array.from({ length: rows }, () => {
    const chosen = new Set<number>();
    const width = Math.floor(rand() * 3);
    for (let k = 0; k < width; ++k) chosen.add(Math.floor(rand() * alphabet));
    return [...chosen].sort((a, b) => a - b);
  });
}

const SIDES = [
  { localKeepsDuplicates: false, partnerKeepsDuplicates: false },
  { localKeepsDuplicates: true, partnerKeepsDuplicates: false },
  { localKeepsDuplicates: false, partnerKeepsDuplicates: true },
  { localKeepsDuplicates: true, partnerKeepsDuplicates: true },
];

describe("the single-pass replay across map shards", () => {
  test("resolves every run as it does in one shard", () => {
    const rand = mulberry32(0x2a24);
    let pairs = 0;
    for (let run = 0; run < 400; ++run) {
      const keyCount = 1 + Math.floor(rand() * 3);
      const receiverRows = 1 + Math.floor(rand() * 8);
      const senderRows = 1 + Math.floor(rand() * 8);
      const alphabet = 1 + Math.floor(rand() * 6);
      const receiverCells = Array.from({ length: keyCount }, () =>
        randomCells(rand, receiverRows, alphabet),
      );
      const senderCells = Array.from({ length: keyCount }, () =>
        randomCells(rand, senderRows, alphabet),
      );
      // A matched value pairs sender id v with receiver id alphabet - 1 - v.
      const matchedSenderIds: Array<number> = [];
      for (let value = 0; value < alphabet; ++value)
        if (rand() < 0.7) matchedSenderIds.push(value);
      const matched = MatchedValues.of(
        matchedSenderIds,
        matchedSenderIds.map((value) => alphabet - 1 - value),
      );
      const receiverOf = (cells: Cells) =>
        cells.map((cell) => cell.map((value) => alphabet - 1 - value));
      for (const sides of SIDES) {
        const replay = (shardEntries?: number) =>
          replaySinglePassCascade(
            receiverCells.map((cells) => cellsView(receiverOf(cells))),
            senderCells.map(cellsView),
            matched,
            receiverRows,
            senderRows,
            sides,
            shardEntries,
          );
        const oneShard = replay();
        pairs += oneShard.table[0].length;
        for (const shardEntries of [1, 2, 3])
          expect(replay(shardEntries)).toStrictEqual(oneShard);
      }
    }
    // The corpus reaches the sweep, so the agreement above is not vacuous.
    expect(pairs).toBeGreaterThan(2000);
  });
});

describe("the receiver's matched-value lookup", () => {
  test("holds more values than one V8 Map", () => {
    const count = MAX_MAP_SHARD_ENTRIES + 1;
    const senderIds = new Int32Array(count);
    const receiverIds = new Int32Array(count);
    for (let k = 0; k < count; ++k) {
      senderIds[k] = k;
      receiverIds[k] = count - 1 - k;
    }
    const matched = MatchedValues.of(senderIds, receiverIds);
    let wrong = 0;
    for (let k = 0; k < count; ++k)
      if (matched.get(k) !== count - 1 - k) wrong += 1;
    expect(wrong).toBe(0);
    expect(matched.get(MAX_MAP_SHARD_ENTRIES)).toBe(0);
  });

  test("reads an id it holds no slot for, or a value that matched none, as no match", () => {
    const matched = MatchedValues.of([3, 1], [0, 7]);
    expect(matched.get(3)).toBe(0);
    expect(matched.get(1)).toBe(7);
    expect(matched.get(0)).toBeUndefined();
    expect(matched.get(2)).toBeUndefined();
    expect(matched.get(4)).toBeUndefined();
    expect(matched.get(2 ** 31 - 1)).toBeUndefined();
    expect(MatchedValues.of([], []).get(0)).toBeUndefined();
  });
});

describe("the ragged index table's cell offsets", () => {
  // Two keys of two rows, each key's cells at most two values wide.
  const words = Int32Array.from([2, 0, 1, 1, 2, 0, 2, 1, 3]);
  const read = (cells: Array<KeyCells>) =>
    cells.map((key) =>
      [0, 1].map((row) =>
        Array.from({ length: key.count(row) }, (_unused, k) =>
          key.valueAt(row, k),
        ),
      ),
    );

  test("read the same cells once they pass an Int32 slot", () => {
    const int32 = decodeRaggedIndexTable("client", words, [2, 2], 2, 8);
    // Five index words, over a lowered Int32 limit of four.
    const widened = decodeRaggedIndexTable("client", words, [2, 2], 2, 8, 4);
    expect(read(widened)).toStrictEqual([
      [[0, 1], [2]],
      [[], [1, 3]],
    ]);
    expect(read(widened)).toStrictEqual(read(int32));
  });
});

describe("the single-pass reply's fixed widths", () => {
  const empty = new Uint8Array(0);
  const pastUint32 = { byteLength: MAX_UINT32 + 1 } as Uint8Array;

  test("refuse a setup or a response whose length a uint32 cannot state", () => {
    expect(() => encodeSinglePassReply(pastUint32, empty, 0, [])).toThrow(
      InternalConsistencyError,
    );
    expect(() => encodeSinglePassReply(pastUint32, empty, 0, [])).toThrow(
      /setup length of 4294967296 does not fit its uint32 field/,
    );
    expect(() => encodeSinglePassReply(empty, pastUint32, 0, [])).toThrow(
      /response length of 4294967296 does not fit its uint32 field/,
    );
  });

  test("refuse a record count a uint32 cannot state", () => {
    expect(() =>
      encodeSinglePassReply(empty, empty, MAX_UINT32 + 1, []),
    ).toThrow(/record count of 4294967296 does not fit its uint32 field/);
    expect(encodeSinglePassReply(empty, empty, MAX_UINT32, []).byteLength).toBe(
      12,
    );
  });

  test("refuse an index-table word an Int32 cannot hold", () => {
    expect(() => encodeSinglePassReply(empty, empty, 1, [2 ** 31])).toThrow(
      /an index-table word of 2147483648 is not a signed 32-bit/,
    );
    expect(() => encodeSinglePassReply(empty, empty, 1, [0.5])).toThrow(
      InternalConsistencyError,
    );
    expect(
      encodeSinglePassReply(empty, empty, 1, [-1, 2 ** 31 - 1]).byteLength,
    ).toBe(20);
  });
});
