import { afterEach, describe, expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import {
  createMessagePipe,
  type MessageConnection,
} from "../../src/connection/messageConnection";
import { countDeclaredPsiElements } from "../../src/connection/psiElementScan";
import {
  InternalConsistencyError,
  PartnerProtocolRefusalError,
} from "../../src/errors";
import {
  assertIndexTableNamesEachPseudonym,
  decodeIndexTable,
  drawBlockOrders,
  encodeIndexTable,
  PermutedCountReplay,
} from "../../src/psi/countOnlyPermutation";
import type {
  CountOnlyDeclaredCounts,
  CountOnlyRoundWidths,
} from "../../src/psi/countOnlyRounds";
import { PSIParticipant } from "../../src/psi/participant";
import { serializeResponse } from "../../src/psi/psiChunks";
import {
  InProcessPsiEngine,
  type PsiEngine,
  type PsiEngineMode,
} from "../../src/psi/psiEngine";
import {
  servePsiWorker,
  WorkerPsiEngine,
  type PsiWorkerHandle,
  type PsiWorkerResponse,
} from "../../src/psi/psiWorkerEngine";
import { maximumMatchingSize } from "../../src/psi/roundResolution";
import {
  ShardedPsiEngine,
  shardHelperMode,
} from "../../src/psi/shardedPsiEngine";
import { seededDraw } from "../utils/countOnlyEveryKey";
import { fixedKeyPsiLibrary, psiTestKey } from "../utils/fixedKeyPsiLibrary";
import { loadNativeAddonOrSkip } from "../utils/nativeAddon";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";

// Count-only rounds over blocks of the declared widths (docs/spec/PROTOCOL.md,
// Candidate sets under count-only): the sender's setup of `n_S * w_S`
// elements and its index table naming each pseudonym `w_S` times, the
// receiver's request of `n_R * w_R` elements answered slot by slot under `pi`
// and a within-slot order, and the replay adding each round's maximum
// matching. A fixture's round sets are built here as that subsection builds
// them; the run path that builds them is not under test.

const wasm = await PSI();
const native: PSILibrary | undefined = await loadNativeAddonOrSkip();
const backends: Array<[string, PSILibrary]> = [
  ["wasm", wasm],
  ...(native === undefined ? [] : [["native", native] as [string, PSILibrary]]),
];

const SERVER_KEY = psiTestKey(3);
const CLIENT_KEY = psiTestKey(5);

afterEach(() => vi.restoreAllMocks());

type Role = "starter" | "joiner";

// One round of one party: each record's candidates for the round's key.
type RoundCandidates = ReadonlyArray<ReadonlyArray<string>>;

interface RoundSpec {
  readonly sender: RoundCandidates;
  readonly receiver: RoundCandidates;
  readonly widths: CountOnlyRoundWidths;
}

function dummy(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

// A record's candidates held by no other record of its party, so its block
// keeps them, as round values of round `round`.
function realCandidates(
  records: RoundCandidates,
  round: number,
): Array<Array<string>> {
  const holders = new Map<string, number>();
  for (const candidates of records)
    for (const value of new Set(candidates))
      holders.set(value, (holders.get(value) ?? 0) + 1);
  return records.map((candidates) =>
    [...new Set(candidates)]
      .filter((value) => holders.get(value) === 1)
      .map((value) => `${String(round)}:${value}`),
  );
}

// The round's set: each record's block of `width` elements, its real
// candidates and a fresh dummy for each element left over, the block's
// elements in the order `order` gives (identity when left out).
function blockSet(
  records: RoundCandidates,
  round: number,
  width: number,
  order?: (block: Array<string>) => Array<string>,
): Array<string> {
  return realCandidates(records, round).flatMap((real) => {
    if (real.length > width)
      throw new Error("a fixture record has more candidates than its width");
    const block = [
      ...real,
      ...Array.from({ length: width - real.length }, dummy),
    ];
    return order === undefined ? block : order(block);
  });
}

// A maximum matching's size by exhaustive search, the reference the shared
// matcher and the replay are held to.
function bruteForceMatching(pairs: ReadonlyArray<readonly [number, number]>) {
  const distinct = [
    ...new Map(pairs.map((pair) => [`${pair[0]},${pair[1]}`, pair])).values(),
  ];
  const best = (
    from: number,
    left: Set<number>,
    right: Set<number>,
  ): number => {
    if (from === distinct.length) return 0;
    const [a, b] = distinct[from]!;
    const without = best(from + 1, left, right);
    if (left.has(a) || right.has(b)) return without;
    left.add(a);
    right.add(b);
    const withPair = 1 + best(from + 1, left, right);
    left.delete(a);
    right.delete(b);
    return Math.max(without, withPair);
  };
  return best(0, new Set(), new Set());
}

// The count as Candidate sets under count-only states it, over records: each
// round's graph is its candidate pairs of records both still in candidacy;
// the round adds a maximum matching's size, and every record in the graph
// leaves candidacy.
function referenceCount(rounds: ReadonlyArray<RoundSpec>): number {
  const leftSender = new Set<number>();
  const leftReceiver = new Set<number>();
  let count = 0;
  rounds.forEach((round, k) => {
    const sender = realCandidates(round.sender, k);
    const receiver = realCandidates(round.receiver, k);
    const graph: Array<[number, number]> = [];
    sender.forEach((senderValues, s) =>
      receiver.forEach((receiverValues, r) => {
        if (leftSender.has(s) || leftReceiver.has(r)) return;
        if (senderValues.some((value) => receiverValues.includes(value)))
          graph.push([s, r]);
      }),
    );
    count += bruteForceMatching(graph);
    for (const [s, r] of graph) {
      leftSender.add(s);
      leftReceiver.add(r);
    }
  });
  return count;
}

function keyed(library: PSILibrary, serverKey = SERVER_KEY): PSILibrary {
  return fixedKeyPsiLibrary(library, serverKey, CLIENT_KEY);
}

function engine(
  library: PSILibrary,
  role: Role,
  mode: PsiEngineMode = "count-only-permuted",
  serverKey = SERVER_KEY,
): InProcessPsiEngine {
  return new InProcessPsiEngine(keyed(library, serverKey), role, role, mode);
}

function workerEngine(
  library: PSILibrary,
  role: Role,
  mode: PsiEngineMode,
): WorkerPsiEngine {
  let deliver: (response: PsiWorkerResponse) => void = () => {};
  const dispatch = servePsiWorker(
    keyed(library),
    { role, id: role, mode },
    (response) => deliver(structuredClone(response)),
  );
  const handle: PsiWorkerHandle = {
    postMessage: (request) => dispatch(structuredClone(request)),
    setHandlers: ({ onMessage }) => {
      deliver = onMessage;
    },
    terminate: () => {},
  };
  return new WorkerPsiEngine(handle);
}

type EngineFactory = (library: PSILibrary, role: Role) => PsiEngine;

const inProcess: EngineFactory = (library, role) => engine(library, role);
const workerBacked: EngineFactory = (library, role) =>
  workerEngine(library, role, "count-only-permuted");
// A floor of 8 splits every request of the fixtures below across the three
// engines, at boundaries that need not fall between blocks.
const sharded: EngineFactory = (library, role) =>
  new ShardedPsiEngine(
    library,
    role,
    "count-only-permuted",
    engine(library, role),
    [1, 2].map(() =>
      workerEngine(library, role, shardHelperMode("count-only-permuted")),
    ),
    { minShardElements: 8 },
  );

const engineKinds = [
  ["in-process", inProcess],
  ["worker-backed", workerBacked],
  ["sharded", sharded],
] as const;

interface RoundFrames {
  readonly setup: Uint8Array;
  readonly indexTable: Int32Array;
  readonly request: Uint8Array;
  readonly response: Uint8Array;
}

// Every round of `rounds` between two engines in the frame order of The
// frames of one round, and the receiver's count.
async function runBlocks(
  sender: PsiEngine,
  receiver: PsiEngine,
  rounds: ReadonlyArray<RoundSpec>,
  order?: (block: Array<string>) => Array<string>,
): Promise<{ count: number; frames: Array<RoundFrames> }> {
  const frames: Array<RoundFrames> = [];
  for (const [k, round] of rounds.entries()) {
    const { receiverWidth, senderWidth } = round.widths;
    const { setup, indexTable } = await sender.createPermutedSetup(
      blockSet(round.sender, k, senderWidth, order),
      senderWidth,
    );
    await receiver.receiveServerSetup(setup);
    await receiver.receiveIndexTable(indexTable, senderWidth);
    const request = await receiver.createClientRequest(
      blockSet(round.receiver, k, receiverWidth, order),
      receiverWidth,
    );
    const response = await sender.processClientRequest(
      request,
      round.receiver.length,
      receiverWidth,
    );
    await receiver.matchPermutedRound(response);
    frames.push({ setup, indexTable, request, response });
  }
  return { count: await receiver.finishPermutedCount(), frames };
}

async function countWith(
  create: EngineFactory,
  rounds: ReadonlyArray<RoundSpec>,
  library: PSILibrary = wasm,
  order?: (block: Array<string>) => Array<string>,
): Promise<number> {
  const sender = create(library, "starter");
  const receiver = create(library, "joiner");
  try {
    return (await runBlocks(sender, receiver, rounds, order)).count;
  } finally {
    sender.dispose();
    receiver.dispose();
  }
}

// Random rounds: each record holds up to its width of candidates drawn from a
// small range, so pairs collide, a record matches several, and some values
// repeat within a party and drop out.
function randomRounds(
  seed: number,
  senderRecords: number,
  receiverRecords: number,
  widths: ReadonlyArray<CountOnlyRoundWidths>,
): Array<RoundSpec> {
  const next = seededDraw(seed);
  const party = (records: number, width: number, values: number) =>
    Array.from({ length: records }, () =>
      Array.from({ length: next(width + 1) }, () => `v${String(next(values))}`),
    );
  return widths.map((roundWidths) => ({
    widths: roundWidths,
    sender: party(senderRecords, roundWidths.senderWidth, 3 * senderRecords),
    receiver: party(
      receiverRecords,
      roundWidths.receiverWidth,
      3 * senderRecords,
    ),
  }));
}

const MIXED_WIDTHS: ReadonlyArray<CountOnlyRoundWidths> = [
  { receiverWidth: 3, senderWidth: 2 },
  { receiverWidth: 1, senderWidth: 1 },
  { receiverWidth: 4, senderWidth: 1 },
  { receiverWidth: 2, senderWidth: 3 },
];

describe("the shared maximum-matching routine", () => {
  test("is the size of a maximum matching, against exhaustive search", () => {
    const next = seededDraw(11);
    for (let trial = 0; trial < 400; trial += 1) {
      const pairs = Array.from(
        { length: next(14) },
        () => [next(6), next(6)] as const,
      );
      expect(
        maximumMatchingSize(
          pairs.map(([a]) => a),
          pairs.map(([, b]) => b),
        ),
      ).toBe(bruteForceMatching(pairs));
    }
  });
});

describe("the count-only replay over candidate pairs", () => {
  const replay = (rounds: ReadonlyArray<ReadonlyArray<[number, number]>>) => {
    const held = new PermutedCountReplay(6, 6);
    for (const pairs of rounds)
      held.acceptRound(
        "joiner",
        pairs.map(([slot]) => slot),
        pairs.map(([, pseudonym]) => pseudonym),
        true,
      );
    return held.count;
  };

  test("adds each round's maximum matching, in the two normative cases", () => {
    expect(
      replay([
        [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      ]),
    ).toBe(2);
    expect(
      replay([
        [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
      ]),
    ).toBe(2);
  });

  test("removes every slot and pseudonym of the round's graph, and only those", () => {
    // Pseudonym 1 leaves with slot 0 though no matching needs it.
    expect(
      replay([
        [
          [0, 0],
          [0, 1],
        ],
        [[1, 1]],
      ]),
    ).toBe(1);
    // A pair whose slot has left is not in the graph, so its pseudonym stays.
    expect(replay([[[0, 0]], [[0, 1]], [[1, 1]]])).toBe(2);
    // Two candidate pairs naming one slot and pseudonym are one pair.
    expect(
      replay([
        [
          [2, 3],
          [2, 3],
          [2, 3],
        ],
      ]),
    ).toBe(1);
  });

  test("is the reference count over random rounds", () => {
    const next = seededDraw(23);
    for (let trial = 0; trial < 300; trial += 1) {
      const rounds = Array.from({ length: 1 + next(3) }, () =>
        Array.from(
          { length: next(10) },
          () => [next(6), next(6)] as [number, number],
        ),
      );
      const left = { slots: new Set<number>(), pseudonyms: new Set<number>() };
      let expected = 0;
      for (const pairs of rounds) {
        const graph = pairs.filter(
          ([slot, pseudonym]) =>
            !left.slots.has(slot) && !left.pseudonyms.has(pseudonym),
        );
        expected += bruteForceMatching(graph);
        for (const [slot, pseudonym] of graph) {
          left.slots.add(slot);
          left.pseudonyms.add(pseudonym);
        }
      }
      expect(replay(rounds)).toBe(expected);
    }
  });

  test("still refuses repeated pairs where a round's widths are both 1", () => {
    expect(() =>
      new PermutedCountReplay(3, 3).acceptRound("joiner", [0, 0], [0, 1]),
    ).toThrow(InternalConsistencyError);
    expect(() =>
      new PermutedCountReplay(3, 3).acceptRound("joiner", [0, 0], [0, 1], true),
    ).not.toThrow();
  });
});

describe("count-only engines over blocks", () => {
  const rounds = randomRounds(5, 12, 14, MIXED_WIDTHS);

  test.for(
    backends.flatMap(([backend, library]) =>
      engineKinds.map(
        ([kind, create]) => [kind, backend, create, library] as const,
      ),
    ),
  )(
    "count the reference count, %s engines on %s",
    async ([, , create, library]) => {
      const expected = referenceCount(rounds);
      expect(expected).toBeGreaterThan(0);
      expect(await countWith(create, rounds, library)).toBe(expected);
    },
  );

  test.for([7, 8, 9, 10, 12])(
    "count the reference count over random rounds, seed %i",
    async (seed) => {
      const random = randomRounds(seed, 10, 9, MIXED_WIDTHS);
      expect(await countWith(inProcess, random)).toBe(referenceCount(random));
    },
  );

  test("count a round whose greedy sweep is not a largest pairing as its maximum matching", async () => {
    // Sender 0 matches receivers 0 and 1, sender 1 only receiver 0: a sweep
    // meeting (S0, R0) first accepts one pair, the largest pairing two.
    const doubleMatch: Array<RoundSpec> = [
      {
        widths: { receiverWidth: 2, senderWidth: 2 },
        sender: [["a", "b"], ["c"], ["s2"], ["s3"]],
        receiver: [["a", "c"], ["b"], ["r2"], ["r3"], ["r4"]],
      },
    ];
    expect(referenceCount(doubleMatch)).toBe(2);
    for (let run = 0; run < 8; run += 1)
      expect(await countWith(inProcess, doubleMatch)).toBe(2);
  });

  test("does not change when either party's rows or a block's elements are reordered", async () => {
    const random = randomRounds(31, 10, 11, MIXED_WIDTHS);
    const expected = await countWith(inProcess, random);
    const next = seededDraw(41);
    const shuffled = <T>(items: ReadonlyArray<T>): Array<T> => {
      const copy = [...items];
      for (let last = copy.length - 1; last > 0; last -= 1) {
        const pick = next(last + 1);
        [copy[last], copy[pick]] = [copy[pick]!, copy[last]!];
      }
      return copy;
    };
    const senderOrder = shuffled(random[0]!.sender.map((_, row) => row));
    const receiverOrder = shuffled(random[0]!.receiver.map((_, row) => row));
    const rows = (
      records: RoundCandidates,
      order: ReadonlyArray<number> | undefined,
    ): RoundCandidates =>
      order === undefined ? records : order.map((row) => records[row]!);
    const reorder = (
      senders: ReadonlyArray<number> | undefined,
      receivers: ReadonlyArray<number> | undefined,
    ): Array<RoundSpec> =>
      random.map((spec) => ({
        widths: spec.widths,
        sender: rows(spec.sender, senders),
        receiver: rows(spec.receiver, receivers),
      }));
    const variants = [
      reorder(senderOrder, undefined),
      reorder(undefined, receiverOrder),
      reorder(senderOrder, receiverOrder),
    ];
    for (const variant of variants)
      expect(await countWith(inProcess, variant)).toBe(expected);
    expect(
      await countWith(inProcess, random, wasm, (block) => shuffled(block)),
    ).toBe(expected);
  });

  test("put each pseudonym in the index table its width's times, a block's elements in one sender record", async () => {
    const sender = inProcess(wasm, "starter");
    try {
      const values = Array.from({ length: 12 }, (_, i) => `x${String(i)}`);
      const revealing = engine(wasm, "starter", "identifier-revealing");
      const { setup, indexTable } = await sender.createPermutedSetup(values, 3);
      const { setup: same, permutation } =
        await revealing.createServerSetup(values);
      revealing.dispose();
      expect(setup).toStrictEqual(same);
      expect(indexTable).toHaveLength(12);
      const pseudonymOf = new Map<number, number>();
      permutation.forEach((input, position) => {
        const record = Math.floor(input / 3);
        const pseudonym = indexTable[position]!;
        expect(pseudonymOf.get(record) ?? pseudonym).toBe(pseudonym);
        pseudonymOf.set(record, pseudonym);
      });
      expect([...pseudonymOf.values()].sort()).toStrictEqual([0, 1, 2, 3]);
    } finally {
      sender.dispose();
    }
  });

  test("answer a request block by block under pi, each slot reordered within itself each round", async () => {
    const sender = inProcess(wasm, "starter");
    const receiver = inProcess(wasm, "joiner");
    const revealing = engine(wasm, "starter", "identifier-revealing");
    try {
      const width = 4;
      const records = 30;
      const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
      const elementsOf = (response: Uint8Array) =>
        wasm.response
          .deserializeBinary(response)
          .getEncryptedElementsList_asU8()
          .map(hexOf);
      const withinOrders: Array<Array<number>> = [];
      let pi: Array<number> | undefined;
      for (let round = 0; round < 2; round += 1) {
        const values = Array.from(
          { length: records * width },
          (_, i) => `${String(round)}:${String(i)}`,
        );
        const request = await receiver.createClientRequest(values, width);
        const permuted = elementsOf(
          await sender.processClientRequest(request, records, width),
        );
        const inOrder = elementsOf(
          await revealing.processClientRequest(request),
        );
        const positions = permuted.map((element) => inOrder.indexOf(element));
        const blocks = Array.from({ length: records }, (_, slot) =>
          positions.slice(slot * width, (slot + 1) * width),
        );
        const roundPi = blocks.map((block) => Math.floor(block[0]! / width));
        for (const [slot, block] of blocks.entries())
          expect(
            block.map((position) => position - roundPi[slot]! * width).sort(),
          ).toStrictEqual([0, 1, 2, 3]);
        pi ??= roundPi;
        expect(roundPi).toStrictEqual(pi);
        withinOrders.push(
          blocks.flatMap((block, slot) =>
            block.map((position) => position - roundPi[slot]! * width),
          ),
        );
      }
      expect(new Set(pi).size).toBe(records);
      expect(withinOrders[1]).not.toStrictEqual(withinOrders[0]);
      const identity = Array.from({ length: records }, () => [0, 1, 2, 3]);
      expect(withinOrders[0]).not.toStrictEqual(identity.flat());
    } finally {
      sender.dispose();
      receiver.dispose();
      revealing.dispose();
    }
  });
});

describe("the frame checks at each width", () => {
  const RECORDS_S = 6;
  const RECORDS_R = 7;
  const declared: CountOnlyDeclaredCounts = {
    receiverRecords: RECORDS_R,
    senderRecords: RECORDS_S,
  };
  const set = (records: number, width: number, tag: string) =>
    Array.from({ length: records * width }, (_, i) => `${tag}-${String(i)}`);

  test.for([1, 2, 4])(
    "an index table of the wrong length or multiplicity at width %i",
    async (width) => {
      const sender = inProcess(wasm, "starter");
      try {
        const { setup, indexTable } = await sender.createPermutedSetup(
          set(RECORDS_S, width, "s"),
          width,
        );
        const entries = RECORDS_S * width;
        const overused = Int32Array.from(indexTable);
        overused[overused.indexOf(1)] = 0;
        const bad: Array<[Int32Array, RegExp]> = [
          [
            indexTable.subarray(1),
            new RegExp(
              `has ${String(entries - 1)} entries for a setup of ${String(entries)} elements`,
            ),
          ],
          [
            Int32Array.of(...indexTable.subarray(1), RECORDS_S),
            /not a permutation|does not name each/,
          ],
          [overused, /not a permutation|does not name each/],
        ];
        for (const [table, refusal] of bad) {
          const receiver = inProcess(wasm, "joiner");
          try {
            await receiver.receiveServerSetup(setup);
            const refused = receiver.receiveIndexTable(table, width);
            await expect(refused).rejects.toBeInstanceOf(
              PartnerProtocolRefusalError,
            );
            await expect(refused).rejects.toThrow(refusal);
          } finally {
            receiver.dispose();
          }
        }
        const frame = encodeIndexTable(indexTable);
        expect(
          decodeIndexTable("joiner", frame, RECORDS_S, width),
        ).toStrictEqual(indexTable);
        expect(() =>
          decodeIndexTable("joiner", frame.subarray(4), RECORDS_S, width),
        ).toThrow(PartnerProtocolRefusalError);
        if (width > 1)
          expect(() =>
            decodeIndexTable("joiner", frame, RECORDS_S, width + 1),
          ).toThrow(/at width/);
      } finally {
        sender.dispose();
      }
    },
  );

  test("an index table whose pseudonyms differ in number from an earlier round's", async () => {
    const sender = inProcess(wasm, "starter");
    const shorter = inProcess(wasm, "starter");
    const receiver = inProcess(wasm, "joiner");
    try {
      const first = await sender.createPermutedSetup(set(RECORDS_S, 1, "a"), 1);
      await receiver.receiveServerSetup(first.setup);
      await receiver.receiveIndexTable(first.indexTable, 1);
      await receiver.matchPermutedRound(
        await sender.processClientRequest(
          await receiver.createClientRequest(set(RECORDS_R, 1, "b"), 1),
          RECORDS_R,
          1,
        ),
      );
      // Six records at width 1 in the first round, three blocks of two in
      // the second.
      const second = await shorter.createPermutedSetup(
        set(RECORDS_S / 2, 2, "c"),
        2,
      );
      await receiver.receiveServerSetup(second.setup);
      await expect(
        receiver.receiveIndexTable(second.indexTable, 2),
      ).rejects.toThrow(
        /has 3 blocks of 2 entries where the exchange's first had 6/,
      );
    } finally {
      sender.dispose();
      shorter.dispose();
      receiver.dispose();
    }
  });

  test("the pseudonym check, on a table it is handed", () => {
    expect(() =>
      assertIndexTableNamesEachPseudonym("joiner", [1, 0, 0, 1], 2),
    ).not.toThrow();
    for (const [table, width] of [
      [[1, 0, 0, 0], 2],
      [[0, 0, 1], 2],
      [[0, 1, 2, 2], 2],
      [[0.5, 0.5], 2],
    ] as const)
      expect(() =>
        assertIndexTableNamesEachPseudonym("joiner", table, width),
      ).toThrow(PartnerProtocolRefusalError);
    expect(() => assertIndexTableNamesEachPseudonym("joiner", [0], 0)).toThrow(
      InternalConsistencyError,
    );
  });

  test.for([1, 2, 4])(
    "a request or a response of the wrong size at width %i",
    async (width) => {
      const sender = inProcess(wasm, "starter");
      const receiver = inProcess(wasm, "joiner");
      const other = inProcess(wasm, "joiner");
      try {
        const { setup, indexTable } = await sender.createPermutedSetup(
          set(RECORDS_S, 1, "s"),
          1,
        );
        const short = await other.createClientRequest(
          set(RECORDS_R * width - 1, 1, "r"),
        );
        const refused = Promise.resolve().then(() =>
          sender.processClientRequest(short, RECORDS_R, width),
        );
        await expect(refused).rejects.toBeInstanceOf(
          PartnerProtocolRefusalError,
        );
        await expect(refused).rejects.toThrow(
          new RegExp(
            `request has ${String(RECORDS_R * width - 1)} elements for its ${String(RECORDS_R)} declared records`,
          ),
        );

        await receiver.receiveServerSetup(setup);
        await receiver.receiveIndexTable(indexTable, 1);
        const request = await receiver.createClientRequest(
          set(RECORDS_R, width, "r"),
          width,
        );
        const response = await sender.processClientRequest(
          request,
          RECORDS_R,
          width,
        );
        const elements = wasm.response
          .deserializeBinary(response)
          .getEncryptedElementsList_asU8();
        const shortResponse = receiver.matchPermutedRound(
          serializeResponse(wasm, elements.slice(1)),
        );
        await expect(shortResponse).rejects.toBeInstanceOf(
          PartnerProtocolRefusalError,
        );
        await expect(shortResponse).rejects.toThrow(
          new RegExp(
            `response has ${String(RECORDS_R * width - 1)} elements for a request of ${String(RECORDS_R * width)}`,
          ),
        );
      } finally {
        sender.dispose();
        receiver.dispose();
        other.dispose();
      }
    },
  );

  test("a set that does not divide into its blocks, or a width that is not a whole number", async () => {
    const sender = inProcess(wasm, "starter");
    const receiver = inProcess(wasm, "joiner");
    const revealing = engine(wasm, "joiner", "identifier-revealing");
    try {
      await expect(
        sender.createPermutedSetup(set(1, 5, "s"), 2),
      ).rejects.toThrow(InternalConsistencyError);
      expect(() => receiver.createClientRequest(set(1, 5, "r"), 2)).toThrow(
        InternalConsistencyError,
      );
      for (const width of [0, 1.5, Number.NaN])
        await expect(
          sender.createPermutedSetup(set(2, 1, "s"), width),
        ).rejects.toThrow(InternalConsistencyError);
      expect(() => revealing.createClientRequest(["a", "b"], 2)).toThrow(
        /in the identifier-revealing mode/,
      );
    } finally {
      sender.dispose();
      receiver.dispose();
      revealing.dispose();
    }
  });

  test("a match before this round's request", async () => {
    const sender = inProcess(wasm, "starter");
    const receiver = inProcess(wasm, "joiner");
    try {
      const round = async (tag: string) => {
        const { setup, indexTable } = await sender.createPermutedSetup(
          set(RECORDS_S, 2, tag),
          2,
        );
        await receiver.receiveServerSetup(setup);
        await receiver.receiveIndexTable(indexTable, 2);
      };
      await round("a");
      const response = await sender.processClientRequest(
        await receiver.createClientRequest(set(RECORDS_R, 3, "r"), 3),
        RECORDS_R,
        3,
      );
      await receiver.matchPermutedRound(response);
      await round("b");
      await expect(receiver.matchPermutedRound(response)).rejects.toThrow(
        /before the round's index table and request/,
      );
    } finally {
      sender.dispose();
      receiver.dispose();
    }
  });

  // Two participants over a pipe, the sender's and the receiver's view of
  // the widths given separately.
  async function participantRound(
    senderWidths: CountOnlyRoundWidths,
    receiverWidths: CountOnlyRoundWidths,
    receiverConn: (conn: MessageConnection) => MessageConnection = (c) => c,
  ) {
    const [senderEnd, receiverEnd] = createMessagePipe();
    const sender = new PSIParticipant(
      "server",
      wasm,
      { role: "starter", verbose: -1 },
      UNBOUNDED_PSI_ELEMENTS,
      inProcess(wasm, "starter"),
    );
    const receiver = new PSIParticipant(
      "client",
      wasm,
      { role: "joiner", verbose: -1 },
      UNBOUNDED_PSI_ELEMENTS,
      inProcess(wasm, "joiner"),
    );
    const settle = (conn: MessageConnection, run: Promise<void>) =>
      run.catch((error: unknown) => {
        conn.close();
        throw error;
      });
    const wrapped = receiverConn(receiverEnd);
    try {
      return await Promise.allSettled([
        settle(
          senderEnd,
          sender.countPermutedRound(
            senderEnd,
            set(RECORDS_S, senderWidths.senderWidth, "s"),
            declared,
            senderWidths,
          ),
        ),
        settle(
          wrapped,
          receiver.countPermutedRound(
            wrapped,
            set(RECORDS_R, receiverWidths.receiverWidth, "r"),
            declared,
            receiverWidths,
          ),
        ),
      ]);
    } finally {
      sender.dispose();
      receiver.dispose();
    }
  }

  test.for([1, 2, 4])(
    "a setup or a request at another width than the round's, width %i",
    async (width) => {
      const agreed = { receiverWidth: width, senderWidth: width };
      const [senderOk, receiverOk] = await participantRound(agreed, agreed);
      expect(senderOk.status).toBe("fulfilled");
      expect(receiverOk.status).toBe("fulfilled");

      const [, wideSetup] = await participantRound(
        { receiverWidth: width, senderWidth: width + 1 },
        agreed,
      );
      expect(wideSetup).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringMatching(
            new RegExp(
              `PSI setup has ${String(RECORDS_S * (width + 1))} elements for its ${String(RECORDS_S)} declared records`,
            ),
          ),
        }),
      });
      expect((wideSetup as PromiseRejectedResult).reason).toBeInstanceOf(
        PartnerProtocolRefusalError,
      );

      const [wideRequest] = await participantRound(agreed, {
        receiverWidth: width + 1,
        senderWidth: width,
      });
      expect(wideRequest).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringMatching(
            new RegExp(
              `PSI request has ${String(RECORDS_R * (width + 1))} elements for its ${String(RECORDS_R)} declared records`,
            ),
          ),
        }),
      });

      // The index table, the second frame the receiver reads after the
      // setup's parts, cut by one entry.
      let received = 0;
      const [, shortTable] = await participantRound(agreed, agreed, (conn) => ({
        send: (data) => conn.send(data),
        receive: async (timeoutMs?: number) => {
          const frame = await conn.receive(timeoutMs);
          received += 1;
          return frame instanceof Uint8Array &&
            frame.byteLength === 4 * RECORDS_S * width &&
            received > 1
            ? frame.subarray(4)
            : frame;
        },
        close: () => conn.close(),
      }));
      expect(shortTable).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringMatching(/the partner's index table is/),
        }),
      });
    },
  );
});

describe("what a count-only exchange over blocks discloses", () => {
  // Each party's frames, every one's byte length, from a round over
  // participants on a pipe.
  async function frameLengths(rounds: ReadonlyArray<RoundSpec>) {
    const [senderEnd, receiverEnd] = createMessagePipe();
    const lengths = {
      sender: [] as Array<number>,
      receiver: [] as Array<number>,
    };
    const recording = (
      conn: MessageConnection,
      into: Array<number>,
    ): MessageConnection => ({
      send: (data) => {
        into.push(data instanceof Uint8Array ? data.byteLength : -1);
        return conn.send(data);
      },
      receive: (timeoutMs?: number) => conn.receive(timeoutMs),
      close: () => conn.close(),
    });
    const senderConn = recording(senderEnd, lengths.sender);
    const receiverConn = recording(receiverEnd, lengths.receiver);
    const sender = new PSIParticipant(
      "server",
      wasm,
      { role: "starter", verbose: -1 },
      UNBOUNDED_PSI_ELEMENTS,
      inProcess(wasm, "starter"),
    );
    const receiver = new PSIParticipant(
      "client",
      wasm,
      { role: "joiner", verbose: -1 },
      UNBOUNDED_PSI_ELEMENTS,
      inProcess(wasm, "joiner"),
    );
    const declared = {
      receiverRecords: rounds[0]!.receiver.length,
      senderRecords: rounds[0]!.sender.length,
    };
    try {
      for (const [k, round] of rounds.entries())
        await Promise.all([
          sender.countPermutedRound(
            senderConn,
            blockSet(round.sender, k, round.widths.senderWidth),
            declared,
            round.widths,
          ),
          receiver.countPermutedRound(
            receiverConn,
            blockSet(round.receiver, k, round.widths.receiverWidth),
            declared,
            round.widths,
          ),
        ]);
      return {
        lengths,
        count: await receiver.finishPermutedCount(rounds.length),
      };
    } finally {
      sender.dispose();
      receiver.dispose();
    }
  }

  test("each frame's size depends on the record counts and widths alone, not on how many real candidates a record has", async () => {
    const senderRecords = 9;
    const receiverRecords = 11;
    const widths: ReadonlyArray<CountOnlyRoundWidths> = [
      { receiverWidth: 4, senderWidth: 2 },
      { receiverWidth: 3, senderWidth: 3 },
    ];
    const filled = (records: number, width: number, tag: string, k: number) =>
      Array.from({ length: records }, (_, record) =>
        Array.from(
          { length: width },
          (_, place) => `${tag}${String(k)}-${String(record)}-${String(place)}`,
        ),
      );
    const datasets: Array<Array<RoundSpec>> = [
      // No real candidate at all.
      widths.map((roundWidths) => ({
        widths: roundWidths,
        sender: Array.from({ length: senderRecords }, () => []),
        receiver: Array.from({ length: receiverRecords }, () => []),
      })),
      // Every element real, every sender record matched.
      widths.map((roundWidths, k) => {
        const sender = filled(senderRecords, roundWidths.senderWidth, "m", k);
        const receiver = filled(
          receiverRecords,
          roundWidths.receiverWidth,
          "r",
          k,
        );
        sender.forEach((candidates, record) => {
          receiver[record]![0] = candidates[0]!;
        });
        return { widths: roundWidths, sender, receiver };
      }),
      // Every count of real candidates from none to the width.
      ...[3, 4].map((seed) =>
        randomRounds(seed, senderRecords, receiverRecords, widths),
      ),
    ];
    const outcomes = [];
    for (const dataset of datasets) outcomes.push(await frameLengths(dataset));
    expect(
      new Set(outcomes.map((outcome) => outcome.count)).size,
    ).toBeGreaterThan(1);
    for (const outcome of outcomes.slice(1))
      expect(outcome.lengths).toStrictEqual(outcomes[0]!.lengths);
    // Each round's index table is 4 * n_S * w_S bytes.
    expect(outcomes[0]!.lengths.sender).toEqual(
      expect.arrayContaining(
        widths.map((round) => 4 * senderRecords * round.senderWidth),
      ),
    );
  });

  test("each set has its record count times its width elements, whatever its records hold", async () => {
    const shapes = [
      randomRounds(13, 8, 10, MIXED_WIDTHS),
      MIXED_WIDTHS.map((roundWidths) => ({
        widths: roundWidths,
        sender: Array.from({ length: 8 }, () => []),
        receiver: Array.from({ length: 10 }, () => []),
      })),
    ];
    for (const rounds of shapes) {
      const sender = inProcess(wasm, "starter");
      const receiver = inProcess(wasm, "joiner");
      try {
        const { frames } = await runBlocks(sender, receiver, rounds);
        frames.forEach((round, k) => {
          const { senderWidth, receiverWidth } = MIXED_WIDTHS[k]!;
          const elements = (
            bytes: Uint8Array,
            kind: "serverSetup" | "request" | "response",
          ) => countDeclaredPsiElements(bytes, kind, Number.MAX_SAFE_INTEGER);
          expect(elements(round.setup, "serverSetup")).toBe(8 * senderWidth);
          expect(round.indexTable).toHaveLength(8 * senderWidth);
          expect(elements(round.request, "request")).toBe(10 * receiverWidth);
          expect(elements(round.response, "response")).toBe(10 * receiverWidth);
        });
      } finally {
        sender.dispose();
        receiver.dispose();
      }
    }
  });

  test("the receiver's engine returns only the count, and reports elements processed whatever matched", async () => {
    const ticksOf = async (rounds: ReadonlyArray<RoundSpec>) => {
      const sender = new InProcessPsiEngine(
        keyed(wasm),
        "starter",
        "s",
        "count-only-permuted",
        {
          chunkElements: 10,
        },
      );
      const receiver = new InProcessPsiEngine(
        keyed(wasm),
        "joiner",
        "r",
        "count-only-permuted",
        {
          chunkElements: 10,
        },
      );
      const ticks: Array<number> = [];
      receiver.observeProcessedElements((processed) => ticks.push(processed));
      try {
        const { count } = await runBlocks(sender, receiver, rounds);
        return { ticks, count };
      } finally {
        sender.dispose();
        receiver.dispose();
      }
    };
    const matching = randomRounds(17, 8, 10, MIXED_WIDTHS);
    const unmatched = matching.map((round) => ({
      ...round,
      receiver: round.receiver.map((candidates) =>
        candidates.map((value) => `u-${value}`),
      ),
    }));
    const withMatches = await ticksOf(matching);
    const withNone = await ticksOf(unmatched);
    expect(withMatches.count).toBeGreaterThan(0);
    expect(withNone.count).toBe(0);
    expect(withNone.ticks).toStrictEqual(withMatches.ticks);
  });

  // The receiver's software learns each round's candidate pairs and each
  // pair's multiplicity (What each party learns: a key with a candidate
  // set). The two orders within a block keep from it which of a record's
  // candidates matched. A statistical check over fresh draws, best-effort.
  test("where a matched element lands within its slot does not depend on which of the receiver's candidates it is", async () => {
    const width = 4;
    const runs = 160;
    // One exchange of `runs` rounds: `pi` is the exchange's, and each slot's
    // order is drawn anew each round.
    const placesFor = async (matchedPlace: number) => {
      const seen = new Array<number>(width).fill(0);
      const sender = inProcess(wasm, "starter");
      const receiver = engine(wasm, "joiner", "identifier-revealing");
      try {
        const receiverBlocks = Array.from({ length: 5 }, (_, record) =>
          Array.from(
            { length: width },
            (_, place) => `0:r-${String(record)}-${String(place)}`,
          ),
        );
        receiverBlocks[0]![matchedPlace] = "0:shared";
        const request = await receiver.createClientRequest(
          receiverBlocks.flat(),
        );
        const { setup } = await sender.createPermutedSetup(
          ["0:shared", "0:s1", "0:s2"],
          1,
        );
        for (let run = 0; run < runs; run += 1) {
          const response = await sender.processClientRequest(request, 5, width);
          await receiver.receiveServerSetup(setup);
          const [responsePositions] =
            await receiver.computeAssociationTable(response);
          expect(responsePositions).toHaveLength(1);
          seen[responsePositions[0]! % width] += 1;
        }
      } finally {
        sender.dispose();
        receiver.dispose();
      }
      return seen;
    };
    // About 5.5 hits is one standard deviation of each place's 40; 28 is
    // over five. A fixed place would put all 160 in one.
    for (const matchedPlace of [0, 3])
      for (const hits of await placesFor(matchedPlace))
        expect(Math.abs(hits - runs / width)).toBeLessThan(28);
  }, 60_000);

  test("which of a pseudonym's setup positions matched does not depend on which of the sender's candidates it is", async () => {
    const width = 3;
    const runs = 90;
    const receiver = engine(wasm, "joiner", "identifier-revealing");
    try {
      const request = await receiver.createClientRequest(["0:shared", "0:r1"]);
      for (const [placement, matchedPlace] of [0, 2].entries()) {
        const ranks = new Array<number>(width).fill(0);
        const block = ["0:a0", "0:a1", "0:a2"];
        block[matchedPlace] = "0:shared";
        for (let run = 0; run < runs; run += 1) {
          // A fresh sender key each run, as each exchange draws its own.
          const sender = engine(
            wasm,
            "starter",
            "count-only-permuted",
            psiTestKey(10 + placement * runs + run),
          );
          try {
            const { setup, indexTable } = await sender.createPermutedSetup(
              [...block, "0:b0", "0:b1", "0:b2"],
              width,
            );
            const response = await sender.processClientRequest(request, 2, 1);
            await receiver.receiveServerSetup(setup);
            const [, setupPositions] =
              await receiver.computeAssociationTable(response);
            expect(setupPositions).toHaveLength(1);
            const matched = setupPositions[0]!;
            const pseudonym = indexTable[matched]!;
            const positions = Array.from(indexTable.entries())
              .filter(([, entry]) => entry === pseudonym)
              .map(([position]) => position);
            expect(positions).toHaveLength(width);
            ranks[positions.indexOf(matched)] += 1;
          } finally {
            sender.dispose();
          }
        }
        // About 4.5 hits is one standard deviation of each rank's 30; 22 is
        // nearly five. A fixed rank would put all 90 in one.
        for (const hits of ranks)
          expect(Math.abs(hits - runs / width)).toBeLessThan(22);
      }
    } finally {
      receiver.dispose();
    }
  }, 60_000);

  test("the within-slot orders are uniform and drawn anew for each block", () => {
    const seen = new Map<string, number>();
    const draws = 3000;
    const orders = drawBlockOrders(draws, 3);
    for (let block = 0; block < draws; block += 1) {
      const order = Array.from(orders.subarray(3 * block, 3 * block + 3)).join(
        "",
      );
      seen.set(order, (seen.get(order) ?? 0) + 1);
    }
    expect([...seen.keys()].sort()).toStrictEqual([
      "012",
      "021",
      "102",
      "120",
      "201",
      "210",
    ]);
    // About 20 draws is one standard deviation of each order's 500.
    for (const hits of seen.values())
      expect(Math.abs(hits - 500)).toBeLessThan(120);
    const draw = vi.spyOn(crypto, "getRandomValues");
    expect(Array.from(drawBlockOrders(5, 1))).toStrictEqual([0, 0, 0, 0, 0]);
    expect(draw).not.toHaveBeenCalled();
  });
});
