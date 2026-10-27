import { afterEach, describe, expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import {
  InternalConsistencyError,
  PartnerProtocolRefusalError,
} from "../../src/errors";
import {
  assertIndexTableIsPermutation,
  drawUniformPermutation,
  HeldPermutation,
  PermutedCountReplay,
} from "../../src/psi/countOnlyPermutation";
import { serializeResponse } from "../../src/psi/psiChunks";
import {
  InProcessPsiEngine,
  type InProcessPsiEngineOptions,
  type PsiEngine,
  type PsiEngineMode,
} from "../../src/psi/psiEngine";
import {
  WorkerPsiEngine,
  servePsiWorker,
  type PsiWorkerHandle,
  type PsiWorkerResponse,
} from "../../src/psi/psiWorkerEngine";
import { ShardedPsiEngine } from "../../src/psi/shardedPsiEngine";
import { fixedKeyPsiLibrary, psiTestKey } from "../utils/fixedKeyPsiLibrary";
import { loadNativeAddonOrSkip } from "../utils/nativeAddon";

// The count-only-permuted engine mode at the PsiEngine boundary
// (docs/spec/PROTOCOL.md, PSI-C: the sender's permutation, the index table,
// and the receiver's engine returning only the count). No hook reads the
// sender's `pi` or `sigma`: a test recovers them from the wire, by comparing
// the permuted frames with those an identifier-revealing engine built from
// the same key produces, which only a holder of the key can do.

const wasm = await PSI();
const native: PSILibrary | undefined = await loadNativeAddonOrSkip();

const SERVER_KEY = psiTestKey(3);
const CLIENT_KEY = psiTestKey(5);

afterEach(() => vi.restoreAllMocks());

// One record per row, one field per key, in the agreed key order; an empty
// field has no value for the key.
type Records = ReadonlyArray<ReadonlyArray<string>>;

function dummy(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

// A round's set as PROTOCOL.md, The count-only rounds, builds it: one element
// per record in record order, the round value `k:value` where the record has
// a value no other record has, a fresh dummy otherwise.
function roundSet(records: Records, round: number): Array<string> {
  const holders = new Map<string, number>();
  for (const record of records) {
    const value = record[round]!;
    if (value !== "") holders.set(value, (holders.get(value) ?? 0) + 1);
  }
  return records.map((record) => {
    const value = record[round]!;
    return value !== "" && holders.get(value) === 1
      ? `${String(round)}:${value}`
      : dummy();
  });
}

function filler(prefix: string, count: number): Array<Array<string>> {
  return Array.from({ length: count }, (_, index) => [
    `${prefix}-a-${String(index)}`,
    `${prefix}-b-${String(index)}`,
  ]);
}

// Two keys. Receiver 0 matches sender 0 on both; receiver 1 matches sender 1
// on the first; receiver 2 matches sender 1 on the second, a cross-key
// conflict the one-to-one replay does not accept. The union of matched slots
// is 3, the replay's count 2. Fillers make `pi` and `sigma` large enough that
// no assertion below holds by chance.
const SENDER: Records = [
  ["111", "ann"],
  ["222", "bob"],
  ["333", "cat"],
  ["444", "dan"],
  ...filler("s", 44),
];
const RECEIVER: Records = [
  ["111", "ann"],
  ["222", "zed"],
  ["999", "bob"],
  ["555", ""],
  ["", "fay"],
  ["555", "gus"],
  ...filler("r", 58),
];
const ROUNDS = 2;
const EXPECTED_COUNT = 2;
const EXPECTED_SLOT_UNION = 3;

type Library = PSILibrary;

function engine(
  library: Library,
  role: "starter" | "joiner",
  mode: PsiEngineMode,
  options: InProcessPsiEngineOptions = {},
): InProcessPsiEngine {
  return new InProcessPsiEngine(
    fixedKeyPsiLibrary(library, SERVER_KEY, CLIENT_KEY),
    role,
    role,
    mode,
    options,
  );
}

type EngineFactory = (
  library: Library,
  role: "starter" | "joiner",
  options?: InProcessPsiEngineOptions,
) => PsiEngine;

const inProcess: EngineFactory = (library, role, options) =>
  engine(library, role, "count-only-permuted", options);

// structuredClone stands in for a worker's postMessage, so an index table or
// a count that could not cross a worker boundary fails here.
const workerBacked: EngineFactory = (library, role, options) => {
  let deliver: (response: PsiWorkerResponse) => void = () => {};
  const dispatch = servePsiWorker(
    fixedKeyPsiLibrary(library, SERVER_KEY, CLIENT_KEY),
    { role, id: role, mode: "count-only-permuted" },
    (response) => deliver(structuredClone(response)),
    options,
  );
  const handle: PsiWorkerHandle = {
    postMessage: (request) => dispatch(structuredClone(request)),
    setHandlers: ({ onMessage }) => {
      deliver = onMessage;
    },
    terminate: () => {},
  };
  return new WorkerPsiEngine(handle);
};

interface RoundFrames {
  readonly senderValues: Array<string>;
  readonly receiverValues: Array<string>;
  readonly setup: Uint8Array;
  readonly indexTable: Int32Array;
  readonly request: Uint8Array;
  readonly response: Uint8Array;
}

// One round in the frame order PROTOCOL.md gives: setup, index table,
// request, response; the receiver's engine keeps what the match finds.
async function runRound(
  sender: PsiEngine,
  receiver: PsiEngine,
  round: number,
): Promise<RoundFrames> {
  const senderValues = roundSet(SENDER, round);
  const receiverValues = roundSet(RECEIVER, round);
  const { setup, indexTable } = await sender.createPermutedSetup(senderValues);
  await receiver.receiveServerSetup(setup);
  await receiver.receiveIndexTable(indexTable);
  const request = await receiver.createClientRequest(receiverValues);
  const response = await sender.processClientRequest(request);
  await receiver.matchPermutedRound(response);
  return { senderValues, receiverValues, setup, indexTable, request, response };
}

async function runExchange(
  sender: PsiEngine,
  receiver: PsiEngine,
): Promise<{ count: number; rounds: Array<RoundFrames> }> {
  const rounds: Array<RoundFrames> = [];
  for (let round = 0; round < ROUNDS; round += 1)
    rounds.push(await runRound(sender, receiver, round));
  return { count: await receiver.finishPermutedCount(), rounds };
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

function responseElements(library: Library, response: Uint8Array) {
  return library.response
    .deserializeBinary(response)
    .getEncryptedElementsList_asU8();
}

// The sender's `pi` as the wire shows it to a holder of the sender's key:
// slot `s` of the permuted response is the in-order response's element at
// `pi(s)`.
async function piFromWire(
  library: Library,
  frames: RoundFrames,
): Promise<Array<number>> {
  const revealing = engine(library, "starter", "identifier-revealing");
  try {
    const inOrder = responseElements(
      library,
      await revealing.processClientRequest(frames.request),
    ).map(hex);
    return responseElements(library, frames.response).map((element) =>
      inOrder.indexOf(hex(element)),
    );
  } finally {
    revealing.dispose();
  }
}

// The sender's `sigma` as the wire shows it to a holder of the sender's key:
// entry `p` of the index table is `sigma` of the record the same-key setup's
// sorting permutation puts at `p`.
async function sigmaFromWire(
  library: Library,
  frames: RoundFrames,
): Promise<Array<number>> {
  const revealing = engine(library, "starter", "identifier-revealing");
  try {
    const { setup, permutation } = await revealing.createServerSetup(
      frames.senderValues,
    );
    expect(setup).toStrictEqual(frames.setup);
    const sigma = new Array<number>(permutation.length);
    permutation.forEach((record, position) => {
      sigma[record] = frames.indexTable[position]!;
    });
    return sigma;
  } finally {
    revealing.dispose();
  }
}

// The (slot, setup position) pairs a revealing match finds in a permuted
// response, under the receiver's key: what the receiver's engine holds and
// never returns.
async function slotsFromWire(
  library: Library,
  frames: RoundFrames,
): Promise<{ slots: Array<number>; positions: Array<number> }> {
  const revealing = engine(library, "joiner", "identifier-revealing");
  try {
    await revealing.receiveServerSetup(frames.setup);
    const [slots, positions] = await revealing.computeAssociationTable(
      frames.response,
    );
    return { slots, positions };
  } finally {
    revealing.dispose();
  }
}

const isPermutation = (order: ArrayLike<number>): boolean =>
  [...Array.from(order)].sort((a, b) => a - b).every((v, i) => v === i);

describe.each([
  { name: "in-process", create: inProcess },
  { name: "worker-backed", create: workerBacked },
])("the count-only-permuted $name engines", ({ create }) => {
  test("the count is the one-to-one replay, not the union of slots", async () => {
    const sender = create(wasm, "starter");
    const receiver = create(wasm, "joiner");
    try {
      const { count, rounds } = await runExchange(sender, receiver);
      expect(count).toBe(EXPECTED_COUNT);
      const union = new Set<number>();
      for (const frames of rounds)
        for (const slot of (await slotsFromWire(wasm, frames)).slots)
          union.add(slot);
      expect(union.size).toBe(EXPECTED_SLOT_UNION);
    } finally {
      sender.dispose();
      receiver.dispose();
    }
  });

  test("slots map to receiver records only through the sender's pi, the same in every round", async () => {
    const sender = create(wasm, "starter");
    const receiver = create(wasm, "joiner");
    try {
      const { rounds } = await runExchange(sender, receiver);
      const pis = await Promise.all(
        rounds.map((frames) => piFromWire(wasm, frames)),
      );
      const pi = pis[0]!;
      expect(isPermutation(pi)).toBe(true);
      expect(pis[1]).toStrictEqual(pi);
      expect(pi).not.toStrictEqual(pi.map((_, index) => index));

      const sigmas = await Promise.all(
        rounds.map((frames) => sigmaFromWire(wasm, frames)),
      );
      expect(isPermutation(sigmas[0]!)).toBe(true);
      expect(sigmas[1]).toStrictEqual(sigmas[0]);

      // Round 0 pairs receivers 0 and 1 with senders 0 and 1; round 1 pairs
      // receiver 0 with sender 0 again and receiver 2 with sender 1.
      const expectedPairs = [
        [
          [0, 0],
          [1, 1],
        ],
        [
          [0, 0],
          [2, 1],
        ],
      ];
      const slotOf = (record: number): number => pi.indexOf(record);
      for (const [round, frames] of rounds.entries()) {
        const { slots, positions } = await slotsFromWire(wasm, frames);
        const pseudonyms = positions.map(
          (position) => frames.indexTable[position]!,
        );
        const pairs = slots
          .map((slot, pair) => [slot, pseudonyms[pair]!] as const)
          .sort((a, b) => a[0] - b[0]);
        const expected = expectedPairs[round]!.map(
          ([receiverRecord, senderRecord]) =>
            [slotOf(receiverRecord!), sigmas[0]![senderRecord!]!] as const,
        ).sort((a, b) => a[0] - b[0]);
        expect(pairs).toStrictEqual(expected);
      }
      // What a match finds is a slot, not the receiver's request position,
      // which the receiver would know as its own record: pi leaves all three
      // matched records in place with odds of 1 in 249,984.
      expect([0, 1, 2].map(slotOf)).not.toStrictEqual([0, 1, 2]);
      // A record matched on two keys lights one slot and one pseudonym.
      const [first, second] = await Promise.all(
        rounds.map((frames) => slotsFromWire(wasm, frames)),
      );
      expect(first!.slots).toContain(slotOf(0));
      expect(second!.slots).toContain(slotOf(0));
    } finally {
      sender.dispose();
      receiver.dispose();
    }
  });

  test("each sender engine draws its own permutations", async () => {
    const drawn: Array<{ pi: Array<number>; sigma: Array<number> }> = [];
    for (let run = 0; run < 2; run += 1) {
      const sender = create(wasm, "starter");
      const receiver = create(wasm, "joiner");
      try {
        const frames = await runRound(sender, receiver, 0);
        drawn.push({
          pi: await piFromWire(wasm, frames),
          sigma: await sigmaFromWire(wasm, frames),
        });
      } finally {
        sender.dispose();
        receiver.dispose();
      }
    }
    expect(drawn[1]!.pi).not.toStrictEqual(drawn[0]!.pi);
    expect(drawn[1]!.sigma).not.toStrictEqual(drawn[0]!.sigma);
  });
});

describe("the count-only-permuted engine refuses", () => {
  test("every operation that would name a match or a per-round result", async () => {
    const sender = inProcess(wasm, "starter");
    const receiver = inProcess(wasm, "joiner");
    try {
      const frames = await runRound(sender, receiver, 0);
      await expect(
        Promise.resolve().then(() =>
          sender.createServerSetup(frames.senderValues),
        ),
      ).rejects.toThrow(
        /createServerSetup needs a PSI engine that is identifier-revealing or count-only; this one is count-only-permuted/,
      );
      await receiver.receiveServerSetup(frames.setup);
      await expect(
        receiver.computeAssociationTable(frames.response),
      ).rejects.toThrow(
        /computeAssociationTable needs a PSI engine that is identifier-revealing; this one is count-only-permuted/,
      );
      await expect(
        receiver.computeIntersectionCardinality(frames.response),
      ).rejects.toThrow(
        /computeIntersectionCardinality needs a PSI engine that is count-only; this one is count-only-permuted/,
      );
      // A round's match returns nothing: no pair and no per-round count.
      await receiver.receiveIndexTable(frames.indexTable);
      await expect(
        receiver.matchPermutedRound(frames.response),
      ).resolves.toBeUndefined();
    } finally {
      sender.dispose();
      receiver.dispose();
    }
  });

  test.for(["identifier-revealing", "count-only"] as const)(
    "its operations on a %s engine",
    async (mode) => {
      const sender = engine(wasm, "starter", mode);
      const receiver = engine(wasm, "joiner", mode);
      try {
        const refused = new RegExp(
          `needs a PSI engine that is count-only-permuted; this one is ${mode}`,
        );
        await expect(sender.createPermutedSetup(["a"])).rejects.toThrow(
          refused,
        );
        await expect(
          receiver.receiveIndexTable(Int32Array.of(0)),
        ).rejects.toThrow(refused);
        await expect(
          receiver.matchPermutedRound(new Uint8Array()),
        ).rejects.toThrow(refused);
        await expect(receiver.finishPermutedCount()).rejects.toThrow(refused);
      } finally {
        sender.dispose();
        receiver.dispose();
      }
    },
  );

  test("a request in the cardinality mode", async () => {
    const sender = inProcess(wasm, "starter");
    const cardinalityReceiver = engine(wasm, "joiner", "count-only");
    try {
      await sender.createPermutedSetup(roundSet(SENDER, 0));
      const request = await cardinalityReceiver.createClientRequest(["a", "b"]);
      await expect(
        Promise.resolve().then(() => sender.processClientRequest(request)),
      ).rejects.toThrow(
        /the partner's PSI request ran the count-only mode, where this exchange runs count-only-permuted/,
      );
    } finally {
      sender.dispose();
      cardinalityReceiver.dispose();
    }
  });

  test("an index table of the wrong length, or that is not a permutation", async () => {
    const sender = inProcess(wasm, "starter");
    try {
      const { setup, indexTable } = await sender.createPermutedSetup(
        roundSet(SENDER, 0),
      );
      const n = indexTable.length;
      const bad: Array<[Int32Array, RegExp]> = [
        [indexTable.subarray(1), /has 47 entries for a setup of 48 elements/],
        [Int32Array.of(...indexTable, n), /has 49 entries for a setup of 48/],
        [Int32Array.of(n, ...indexTable.subarray(1)), /not a permutation/],
        [Int32Array.of(-1, ...indexTable.subarray(1)), /not a permutation/],
        [
          Int32Array.of(indexTable[1]!, ...indexTable.subarray(1)),
          /not a permutation/,
        ],
      ];
      for (const [table, refusal] of bad) {
        const receiver = inProcess(wasm, "joiner");
        try {
          await receiver.receiveServerSetup(setup);
          const refused = receiver.receiveIndexTable(table);
          await expect(refused).rejects.toBeInstanceOf(
            PartnerProtocolRefusalError,
          );
          await expect(refused).rejects.toThrow(refusal);
        } finally {
          receiver.dispose();
        }
      }
    } finally {
      sender.dispose();
    }
  });

  test("an index table whose length differs from an earlier round's", async () => {
    const sender = inProcess(wasm, "starter");
    const receiver = inProcess(wasm, "joiner");
    const shorterSender = inProcess(wasm, "starter");
    try {
      await runRound(sender, receiver, 0);
      const { setup, indexTable } = await shorterSender.createPermutedSetup(
        roundSet(SENDER.slice(1), 1),
      );
      await receiver.receiveServerSetup(setup);
      await expect(receiver.receiveIndexTable(indexTable)).rejects.toThrow(
        /has 47 entries where the exchange's first had 48/,
      );
    } finally {
      sender.dispose();
      receiver.dispose();
      shorterSender.dispose();
    }
  });

  test("a response repeating a matched element, or of the wrong size", async () => {
    const sender = inProcess(wasm, "starter");
    const probe = inProcess(wasm, "joiner");
    try {
      const frames = await runRound(sender, probe, 0);
      const { slots } = await slotsFromWire(wasm, frames);
      const elements = responseElements(wasm, frames.response);
      const unmatched = elements.findIndex((_, slot) => !slots.includes(slot));
      const repeating = [...elements];
      repeating[unmatched] = elements[slots[0]!]!;
      const cases: Array<[Uint8Array, RegExp]> = [
        [serializeResponse(wasm, repeating), /repeats an element/],
        [
          serializeResponse(wasm, elements.slice(1)),
          /response has 63 elements for a request of 64/,
        ],
      ];
      for (const [response, refusal] of cases) {
        const receiver = inProcess(wasm, "joiner");
        try {
          await receiver.receiveServerSetup(frames.setup);
          await receiver.receiveIndexTable(frames.indexTable);
          await receiver.createClientRequest(frames.receiverValues);
          const refused = receiver.matchPermutedRound(response);
          await expect(refused).rejects.toBeInstanceOf(
            PartnerProtocolRefusalError,
          );
          await expect(refused).rejects.toThrow(refusal);
        } finally {
          receiver.dispose();
        }
      }
    } finally {
      sender.dispose();
      probe.dispose();
    }
  });

  test("a count, or a later round, after a refused round", async () => {
    const sender = inProcess(wasm, "starter");
    const probe = inProcess(wasm, "joiner");
    // Replays a round's frames, with `response` for its response, on a
    // receiver holding the same client key.
    const replayRound = async (
      receiver: PsiEngine,
      frames: RoundFrames,
      response: Uint8Array,
    ) => {
      await receiver.receiveServerSetup(frames.setup);
      await receiver.receiveIndexTable(frames.indexTable);
      await receiver.createClientRequest(frames.receiverValues);
      await receiver.matchPermutedRound(response);
    };
    const repeatingResponse = async (frames: RoundFrames) => {
      const { slots } = await slotsFromWire(wasm, frames);
      const elements = responseElements(wasm, frames.response);
      const unmatched = elements.findIndex((_, slot) => !slots.includes(slot));
      const repeating = [...elements];
      repeating[unmatched] = elements[slots[0]!]!;
      return serializeResponse(wasm, repeating);
    };
    const afterRefusal = /after the partner's input was refused/;
    try {
      const first = await runRound(sender, probe, 0);
      const second = await runRound(sender, probe, 1);

      const refusedFirst = inProcess(wasm, "joiner");
      try {
        await expect(
          replayRound(refusedFirst, first, await repeatingResponse(first)),
        ).rejects.toThrow(/repeats an element/);
        const count = refusedFirst.finishPermutedCount();
        await expect(count).rejects.toBeInstanceOf(PartnerProtocolRefusalError);
        await expect(count).rejects.toThrow(afterRefusal);
        await expect(
          refusedFirst.receiveServerSetup(second.setup),
        ).rejects.toThrow(afterRefusal);
      } finally {
        refusedFirst.dispose();
      }

      const refusedSecond = inProcess(wasm, "joiner");
      try {
        await replayRound(refusedSecond, first, first.response);
        await expect(
          replayRound(refusedSecond, second, await repeatingResponse(second)),
        ).rejects.toThrow(/repeats an element/);
        const count = refusedSecond.finishPermutedCount();
        await expect(count).rejects.toBeInstanceOf(PartnerProtocolRefusalError);
        await expect(count).rejects.toThrow(afterRefusal);
      } finally {
        refusedSecond.dispose();
      }
    } finally {
      sender.dispose();
      probe.dispose();
    }
  });

  test("an index table entry that is not an integer, whatever the array type", () => {
    expect(() => assertIndexTableIsPermutation("joiner", [0, 1])).not.toThrow();
    for (const table of [[0.5, 0.5], Float64Array.of(NaN, NaN)])
      expect(() => assertIndexTableIsPermutation("joiner", table)).toThrow(
        PartnerProtocolRefusalError,
      );
  });

  test("a request whose size differs from the exchange's first", async () => {
    const sender = inProcess(wasm, "starter");
    const receiver = inProcess(wasm, "joiner");
    const shorterReceiver = inProcess(wasm, "joiner");
    try {
      await runRound(sender, receiver, 0);
      const request = await shorterReceiver.createClientRequest(
        roundSet(RECEIVER.slice(1), 1),
      );
      const refused = Promise.resolve().then(() =>
        sender.processClientRequest(request),
      );
      await expect(refused).rejects.toBeInstanceOf(PartnerProtocolRefusalError);
      await expect(refused).rejects.toThrow(
        /has 63 elements where the exchange's first had 64/,
      );
    } finally {
      sender.dispose();
      receiver.dispose();
      shorterReceiver.dispose();
    }
  });

  test("a set that repeats a value, or changes size between rounds", async () => {
    const sender = inProcess(wasm, "starter");
    const receiver = inProcess(wasm, "joiner");
    try {
      await expect(sender.createPermutedSetup(["a", "b", "a"])).rejects.toThrow(
        InternalConsistencyError,
      );
      await expect(
        Promise.resolve().then(() =>
          receiver.createClientRequest(["a", "b", "a"]),
        ),
      ).rejects.toThrow(InternalConsistencyError);
      await sender.createPermutedSetup(["a", "b"]);
      await expect(sender.createPermutedSetup(["a"])).rejects.toThrow(
        /has 1 values where the exchange's first had 2/,
      );
      await receiver.createClientRequest(["a", "b"]);
      await expect(
        Promise.resolve().then(() => receiver.createClientRequest(["a"])),
      ).rejects.toThrow(/has 1 values where the exchange's first had 2/);
    } finally {
      sender.dispose();
      receiver.dispose();
    }
  });

  test("a count before any round, a second count, or a round after the count", async () => {
    const sender = inProcess(wasm, "starter");
    const receiver = inProcess(wasm, "joiner");
    try {
      await expect(receiver.finishPermutedCount()).rejects.toThrow(
        /with no round matched, or a second time/,
      );
      const frames = await runRound(sender, receiver, 0);
      await expect(receiver.finishPermutedCount()).resolves.toBe(2);
      await expect(receiver.finishPermutedCount()).rejects.toThrow(
        /with no round matched, or a second time/,
      );
      await receiver.receiveServerSetup(frames.setup);
      await receiver.receiveIndexTable(frames.indexTable);
      await expect(
        receiver.matchPermutedRound(frames.response),
      ).rejects.toThrow(/after the count was taken/);
    } finally {
      sender.dispose();
      receiver.dispose();
    }
  });

  test("a sharded engine in this mode", () => {
    const primary = inProcess(wasm, "starter");
    try {
      expect(
        () =>
          new ShardedPsiEngine(
            wasm,
            "starter",
            "count-only-permuted",
            primary,
            [],
          ),
      ).toThrow(/does not run the count-only-permuted mode/);
    } finally {
      primary.dispose();
    }
  });
});

describe("what the count-only-permuted engine reports and keeps", () => {
  test("progress reports elements processed, never a match count", async () => {
    const runTicks = async (receiverRecords: Records) => {
      const sender = inProcess(wasm, "starter", { chunkElements: 10 });
      const receiver = inProcess(wasm, "joiner", { chunkElements: 10 });
      const ticks: Array<number> = [];
      receiver.observeProcessedElements!((processed) => ticks.push(processed));
      try {
        const { setup, indexTable } = await sender.createPermutedSetup(
          roundSet(SENDER, 0),
        );
        await receiver.receiveServerSetup(setup);
        await receiver.receiveIndexTable(indexTable);
        const request = await receiver.createClientRequest(
          roundSet(receiverRecords, 0),
        );
        ticks.length = 0;
        await receiver.matchPermutedRound(
          await sender.processClientRequest(request),
        );
        return { ticks, count: await receiver.finishPermutedCount() };
      } finally {
        sender.dispose();
        receiver.dispose();
      }
    };
    const matching = await runTicks(RECEIVER);
    const unmatched = await runTicks(filler("u", RECEIVER.length));
    expect(matching.count).toBe(2);
    expect(unmatched.count).toBe(0);
    // The chunk boundaries of the 64-element response, whatever matched.
    expect(matching.ticks).toStrictEqual([9, 18, 27, 36, 45, 54]);
    expect(unmatched.ticks).toStrictEqual(matching.ticks);
  });

  test("the chunked operations give the same count as single calls", async () => {
    const sender = inProcess(wasm, "starter", { chunkElements: 7 });
    const receiver = inProcess(wasm, "joiner", { chunkElements: 7 });
    try {
      const { count, rounds } = await runExchange(sender, receiver);
      expect(count).toBe(EXPECTED_COUNT);
      const pis = await Promise.all(
        rounds.map((frames) => piFromWire(wasm, frames)),
      );
      expect(isPermutation(pis[0]!)).toBe(true);
      expect(pis[1]).toStrictEqual(pis[0]);
      await sigmaFromWire(wasm, rounds[0]!);
    } finally {
      sender.dispose();
      receiver.dispose();
    }
  });

  test("dispose discards pi, sigma and the receiver's replay", async () => {
    const permutationDiscard = vi.spyOn(HeldPermutation.prototype, "discard");
    const replayDiscard = vi.spyOn(PermutedCountReplay.prototype, "discard");
    const sender = inProcess(wasm, "starter");
    const receiver = inProcess(wasm, "joiner");
    await runRound(sender, receiver, 0);
    expect(permutationDiscard).not.toHaveBeenCalled();
    sender.dispose();
    expect(permutationDiscard).toHaveBeenCalledTimes(2);
    receiver.dispose();
    expect(replayDiscard).toHaveBeenCalledTimes(1);
  });

  test("a disposed sender refuses a setup or a request and draws no permutation", async () => {
    const draw = vi.spyOn(HeldPermutation, "draw");
    const sender = inProcess(wasm, "starter");
    const receiver = inProcess(wasm, "joiner");
    try {
      const request = await receiver.createClientRequest(roundSet(RECEIVER, 0));
      sender.dispose();
      await expect(
        sender.createPermutedSetup(roundSet(SENDER, 0)),
      ).rejects.toThrow(/called on a disposed PSI engine/);
      await expect(
        Promise.resolve().then(() => sender.processClientRequest(request)),
      ).rejects.toThrow(/called on a disposed PSI engine/);
      expect(draw).not.toHaveBeenCalled();
    } finally {
      receiver.dispose();
    }
  });

  test("no property of an engine, and no package export, reaches pi, sigma or the replay", async () => {
    const sender = inProcess(wasm, "starter");
    const receiver = inProcess(wasm, "joiner");
    try {
      await runRound(sender, receiver, 0);
      for (const held of [sender, receiver])
        for (const key of Reflect.ownKeys(held)) {
          const value: unknown = Reflect.get(held, key);
          expect(value).not.toBeInstanceOf(HeldPermutation);
          expect(value).not.toBeInstanceOf(PermutedCountReplay);
          expect(value).not.toBeInstanceOf(Int32Array);
        }
    } finally {
      sender.dispose();
      receiver.dispose();
    }
    const entryPoints = [
      await import("../../src/main"),
      await import("../../src/testing"),
    ];
    for (const entry of entryPoints)
      for (const name of [
        "HeldPermutation",
        "PermutedCountReplay",
        "drawUniformPermutation",
      ])
        expect(Object.keys(entry)).not.toContain(name);
  });

  test("a discarded permutation is zeroed and refuses use", () => {
    const order = Int32Array.of(2, 0, 1);
    const held = new HeldPermutation(order);
    expect(held.at(0)).toBe(2);
    held.discard();
    expect(Array.from(order)).toStrictEqual([0, 0, 0]);
    expect(() => held.at(0)).toThrow(/after it was discarded/);
  });

  test("a drawn permutation is uniform over every order", () => {
    const draws = 6000;
    const seen = new Map<string, number>();
    for (let draw = 0; draw < draws; draw += 1) {
      const order = Array.from(drawUniformPermutation(3)).join("");
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
    // About 29 draws is one standard deviation; 200 is about seven.
    for (const hits of seen.values())
      expect(Math.abs(hits - 1000)).toBeLessThan(200);
    expect(Array.from(drawUniformPermutation(0))).toStrictEqual([]);
    expect(isPermutation(drawUniformPermutation(1000))).toBe(true);
  });
});

describe.skipIf(native === undefined)("backend parity", () => {
  const backends: Array<[string, Library]> = [
    ["wasm", wasm],
    ["native", native!],
  ];
  test.for(
    backends.flatMap(([senderName, senderLibrary]) =>
      backends.map(
        ([receiverName, receiverLibrary]) =>
          [senderName, receiverName, senderLibrary, receiverLibrary] as const,
      ),
    ),
  )(
    "a %s sender and a %s receiver give the same count",
    async ([, , senderLibrary, receiverLibrary]) => {
      const sender = inProcess(senderLibrary, "starter");
      const receiver = inProcess(receiverLibrary, "joiner");
      try {
        const { count, rounds } = await runExchange(sender, receiver);
        expect(count).toBe(EXPECTED_COUNT);
        const pi = await piFromWire(senderLibrary, rounds[0]!);
        expect(await piFromWire(senderLibrary, rounds[1]!)).toStrictEqual(pi);
      } finally {
        sender.dispose();
        receiver.dispose();
      }
    },
  );
});
