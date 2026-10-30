import { describe, expect, test } from "vitest";

import PSI from "@openmined/psi.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { createMessagePipe } from "../../src/connection/messageConnection";
import { linkViaCountOnlyPSI } from "../../src/psi/link";
import { PSIParticipant } from "../../src/psi/participant";
import { InProcessPsiEngine } from "../../src/psi/psiEngine";
import {
  FIXTURE_COUNT,
  RECEIVER,
  SENDER,
  referenceCount,
  roundsOf,
  seededDraw,
  type Records,
} from "../utils/countOnlyEveryKey";
import { loadNativeAddonOrSkip } from "../utils/nativeAddon";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";
import { runCascade, tablesOf } from "../utils/support";

// The count-only construction over every agreed key against a one-to-one
// `psi` cascade over the same keys and data, two in-memory parties each
// (docs/spec/PROTOCOL.md, PSI-C, Computing the count, "Comparability with
// `psi`"): equal where no key value repeats within either party's dataset,
// and different only through a repeated value an earlier key leaves unique
// among the unmatched records, where the count is the reference replay's.

const wasm = await PSI();
const native: PSILibrary | undefined = await loadNativeAddonOrSkip();
const backends: Array<[string, PSILibrary]> = [
  ["wasm", wasm],
  ...(native === undefined ? [] : [["native", native] as [string, PSILibrary]]),
];

function countOnlyParticipant(
  library: PSILibrary,
  role: "starter" | "joiner",
): PSIParticipant {
  const id = role === "starter" ? "server" : "client";
  return new PSIParticipant(
    id,
    library,
    { role, verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
    new InProcessPsiEngine(library, role, id, "count-only-permuted"),
  );
}

// The count both parties hold after a count-only run, `sender`
// the PSI sender; the receiver reports it to the sender.
async function countOnlyCount(
  library: PSILibrary,
  sender: Records,
  receiver: Records,
): Promise<number> {
  const [senderConn, receiverConn] = createMessagePipe();
  const declared = {
    receiverRecords: receiver.length,
    senderRecords: sender.length,
  };
  const maxCount = Math.min(sender.length, receiver.length);
  const senderParty = countOnlyParticipant(library, "starter");
  const receiverParty = countOnlyParticipant(library, "joiner");
  try {
    const [senderCount, receiverCount] = await Promise.all(
      (
        [
          [senderParty, senderConn, sender],
          [receiverParty, receiverConn, receiver],
        ] as const
      ).map(([party, conn, records]) =>
        linkViaCountOnlyPSI(
          party,
          conn,
          roundsOf(records),
          true,
          maxCount,
          declared,
        ).catch((error: unknown) => {
          conn.close();
          throw error;
        }),
      ),
    );
    expect(senderCount).toBe(receiverCount);
    return receiverCount!;
  } finally {
    senderParty.dispose();
    receiverParty.dispose();
  }
}

// The size of the association table a one-to-one `psi` cascade over the same
// keys produces, `starter` the PSI sender; both parties hold the same size.
async function psiTableSize(
  library: PSILibrary,
  starter: Records,
  joiner: Records,
): Promise<number> {
  const tables = tablesOf(
    await runCascade({
      library,
      starterKeys: roundsOf(starter),
      joinerKeys: roundsOf(joiner),
    }),
  );
  expect(tables.joiner[0]).toHaveLength(tables.starter[0].length);
  return tables.starter[0].length;
}

// The four runs over one pair of datasets: each algorithm with either party
// as the PSI sender.
async function bothAlgorithmsBothRoles(
  library: PSILibrary,
  first: Records,
  second: Records,
) {
  return {
    countOnly: [
      await countOnlyCount(library, first, second),
      await countOnlyCount(library, second, first),
    ],
    psi: [
      await psiTableSize(library, first, second),
      await psiTableSize(library, second, first),
    ],
  };
}

// Whether any key value is held by two records of one dataset.
function repeatsAValue(records: Records): boolean {
  return records[0]!.some((_, key) => {
    const values = records
      .map((record) => record[key]!)
      .filter((value) => value !== "");
    return new Set(values).size !== values.length;
  });
}

// Three keys over a value range wider than the dataset, each value held by
// at most one record per key, with gaps: records match on several keys and
// across keys, but no value repeats within the dataset.
function distinctRecords(seed: number, count: number): Records {
  const next = seededDraw(seed);
  const range = Math.ceil(count * 1.5);
  const columns = [0, 1, 2].map((key) => {
    const pool = Array.from({ length: range }, (_, i) => i);
    for (let i = range - 1; i > 0; i -= 1) {
      const j = next(i + 1);
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    return pool
      .slice(0, count)
      .map((v) => (next(6) === 0 ? "" : `k${String(key)}v${String(v)}`));
  });
  return Array.from({ length: count }, (_, row) =>
    columns.map((column) => column[row]!),
  );
}

// A record pair matched on every key, and one on the last two keys only.
const MULTI_KEY_FIRST: Records = [
  ["a1", "b1", "c1"],
  ["a2", "b2", "c2"],
  ["a3", "", "c3"],
  ["a4", "b4", ""],
];
const MULTI_KEY_SECOND: Records = [
  ["a1", "b1", "c1"],
  ["x2", "b2", "c2"],
  ["x3", "y3", "z3"],
];

// Cross-key conflicts on both sides: first record 0 matches second record 0
// on the first key and second record 1 on the second, and second record 2
// matches first record 2 on the first key and first record 3 on the third.
const CONFLICT_FIRST: Records = [
  ["a0", "b0", ""],
  ["", "", "c1"],
  ["a2", "", ""],
  ["", "", "c3"],
];
const CONFLICT_SECOND: Records = [
  ["a0", "", ""],
  ["", "b0", "c1"],
  ["a2", "", "c3"],
];

// A value one dataset holds twice for the second key, one of whose holders
// the first key matches. The psi cascade tests uniqueness over the unmatched
// records, so the other holder takes part and matches; psi-c gives both a
// dummy (PROTOCOL.md, Uniqueness over every record the round is built for).
const REPEAT_FIRST: Records = [
  ["a0", "p"],
  ["a1", "p"],
  ["a2", "q"],
];
const REPEAT_SECOND: Records = [
  ["a0", ""],
  ["z1", "p"],
  ["z2", "q"],
];

describe.each(backends)("on the %s backend", (_name, library) => {
  test.each([
    [3, 40, 30],
    [17, 25, 60],
    [41, 50, 50],
  ])(
    "no value repeats within either dataset (seed %i): the count is the psi table's size, whichever party sends",
    async (seed, firstCount, secondCount) => {
      const first = distinctRecords(seed, firstCount);
      const second = distinctRecords(seed + 1, secondCount);
      expect(repeatsAValue(first)).toBe(false);
      expect(repeatsAValue(second)).toBe(false);

      const { countOnly, psi } = await bothAlgorithmsBothRoles(
        library,
        first,
        second,
      );
      const expected = referenceCount(first, second);
      expect(expected).toBeGreaterThan(0);
      expect(countOnly).toEqual([expected, expected]);
      expect(psi).toEqual([expected, expected]);
    },
  );

  test("records matched on several keys are counted once", async () => {
    expect(repeatsAValue(MULTI_KEY_FIRST)).toBe(false);
    expect(repeatsAValue(MULTI_KEY_SECOND)).toBe(false);
    const { countOnly, psi } = await bothAlgorithmsBothRoles(
      library,
      MULTI_KEY_FIRST,
      MULTI_KEY_SECOND,
    );
    expect(countOnly).toEqual([2, 2]);
    expect(psi).toEqual([2, 2]);
  });

  test("a cross-key conflict accepts the earlier key's pair, as the psi cascade does", async () => {
    expect(repeatsAValue(CONFLICT_FIRST)).toBe(false);
    expect(repeatsAValue(CONFLICT_SECOND)).toBe(false);
    const { countOnly, psi } = await bothAlgorithmsBothRoles(
      library,
      CONFLICT_FIRST,
      CONFLICT_SECOND,
    );
    // 0-0 and 2-2 on the first key, 1-1 on the third.
    expect(countOnly).toEqual([3, 3]);
    expect(psi).toEqual([3, 3]);
  });

  test("the replay fixture's cross-key conflict, beside a repeat no earlier key resolves, gives the psi table's size", async () => {
    expect(repeatsAValue(RECEIVER)).toBe(true);
    const { countOnly, psi } = await bothAlgorithmsBothRoles(
      library,
      SENDER,
      RECEIVER,
    );
    expect(countOnly).toEqual([FIXTURE_COUNT, FIXTURE_COUNT]);
    expect(psi).toEqual([FIXTURE_COUNT, FIXTURE_COUNT]);
  });

  test("a repeated value an earlier key leaves unique among the unmatched records: the counts differ, and psi-c's is the replay's", async () => {
    const { countOnly, psi } = await bothAlgorithmsBothRoles(
      library,
      REPEAT_FIRST,
      REPEAT_SECOND,
    );
    // psi-c: 0-0 on the first key, and 2-2 on q; p is a dummy for both
    // holders. psi: 1-1 on p as well, its other holder matched already.
    expect(referenceCount(REPEAT_FIRST, REPEAT_SECOND)).toBe(2);
    expect(referenceCount(REPEAT_SECOND, REPEAT_FIRST)).toBe(2);
    expect(countOnly).toEqual([2, 2]);
    expect(psi).toEqual([3, 3]);
  });
});
