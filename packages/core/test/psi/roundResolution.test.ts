import { expect, test } from "vitest";

import { resolveRoundCandidatePairs } from "../../src/psi/roundResolution";
import { InternalConsistencyError } from "../../src/errors";
import { runUnpaced } from "../../src/utils/eventLoop";
import { greedyRoundSweep } from "../utils/greedyRoundSweep";
import {
  canonicalOrder,
  firstLargestPairing,
  isPairingOf,
  largestPairingSize,
  type Pair,
} from "../utils/largestPairingOracle";

// The record-level resolution both strategies call, exercised on the exact
// input it governs: a round's candidate pairs as each party's own record
// ranks. Everything above it -- the cascade's two groupings, single-pass's
// index tables -- reduces to this, which is why writing it once is what makes
// the two strategies' tables identical by construction
// (docs/spec/PROTOCOL.md, One sweep, called by both strategies).

const ONE_TO_ONE = { senderAcceptsOnce: true, receiverAcceptsOnce: true };

function pairs(
  sender: Array<number>,
  receiver: Array<number>,
  acceptance = ONE_TO_ONE,
) {
  return resolveRoundCandidatePairs(sender, receiver, acceptance);
}

test("the sweep accepts in ascending (sender rank, receiver rank)", () => {
  // The normative double-match case in rank terms: sender 0 is a candidate for
  // receivers 0 and 1, sender 1 for receiver 1. The sweep accepts (0, 0),
  // discards (0, 1) because sender 0 is accepted already, and accepts (1, 1).
  const resolved = pairs([0, 0, 1], [0, 1, 1]);
  expect(resolved.acceptedSenderRanks).toStrictEqual([0, 1]);
  expect(resolved.acceptedReceiverRanks).toStrictEqual([0, 1]);
});

test("a first pair in no largest pairing is discarded", () => {
  // The second normative one-to-one case in rank terms: the pairs (0, 0),
  // (0, 1) and (1, 0). No pairing holding (0, 0) has two pairs, so the sweep
  // discards it and accepts (0, 1) and (1, 0). With the roles exchanged the
  // case has the same three pairs in rank terms.
  const resolved = pairs([0, 0, 1], [0, 1, 0]);
  expect(resolved.acceptedSenderRanks).toStrictEqual([0, 1]);
  expect(resolved.acceptedReceiverRanks).toStrictEqual([1, 0]);
  expect(resolved.touchedSenderRanks).toStrictEqual([0, 1]);
  expect(resolved.touchedReceiverRanks).toStrictEqual([0, 1]);
});

test("a pair is discarded only for the pairs on its own component", () => {
  // Two components interleaved in rank order: senders 0 and 2 with receivers
  // 0 and 2 form the second normative case, and sender 1 with receiver 1 is a
  // component of one pair.
  const resolved = pairs([0, 0, 1, 2], [0, 2, 1, 0]);
  expect(resolved.acceptedSenderRanks).toStrictEqual([0, 1, 2]);
  expect(resolved.acceptedReceiverRanks).toStrictEqual([2, 1, 0]);
});

test("a long alternating path is searched to its end", () => {
  // Sender i is a candidate for receivers i and i + 1, and sender n for
  // receiver 0 alone. Keeping (0, 0) would leave sender n unpaired, which only
  // a search along the whole path finds.
  const n = 3000;
  const sender: Array<number> = [];
  const receiver: Array<number> = [];
  for (let i = 0; i < n; ++i) {
    sender.push(i, i);
    receiver.push(i, i + 1);
  }
  sender.push(n);
  receiver.push(0);
  const resolved = pairs(sender, receiver);
  expect(resolved.acceptedSenderRanks).toStrictEqual(
    Array.from({ length: n + 1 }, (_, i) => i),
  );
  expect(resolved.acceptedReceiverRanks).toStrictEqual([
    ...Array.from({ length: n }, (_, i) => i + 1),
    0,
  ]);
});

// Every pair set on `senders` x `receivers`, as the pairs of each subset of the
// grid.
function everyPairSet(senders: number, receivers: number): Array<Array<Pair>> {
  const grid: Array<Pair> = [];
  for (let s = 0; s < senders; ++s)
    for (let r = 0; r < receivers; ++r) grid.push([s, r]);
  const sets: Array<Array<Pair>> = [];
  for (let mask = 0; mask < 1 << grid.length; ++mask)
    sets.push(grid.filter((_, i) => (mask & (1 << i)) !== 0));
  return sets;
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

// Random pair sets on up to five records a side, the pairs drawn in an
// arbitrary order and some of them repeated, as a round's value pairs arrive.
function randomPairSets(count: number): Array<Array<Pair>> {
  const rand = mulberry32(0x1a2e5);
  const sets: Array<Array<Pair>> = [];
  for (let n = 0; n < count; ++n) {
    const senders = 1 + Math.floor(rand() * 5);
    const receivers = 1 + Math.floor(rand() * 5);
    const density = rand();
    const set: Array<Pair> = [];
    for (let s = 0; s < senders; ++s)
      for (let r = 0; r < receivers; ++r)
        if (rand() < density) {
          set.push([s * 3, r * 2]);
          if (rand() < 0.2) set.push([s * 3, r * 2]);
        }
    for (let i = set.length - 1; i > 0; --i) {
      const j = Math.floor(rand() * (i + 1));
      [set[i], set[j]] = [set[j], set[i]];
    }
    sets.push(set);
  }
  return sets;
}

function acceptedPairs(round: Array<Pair>): Array<Pair> {
  const resolved = pairs(
    round.map(([s]) => s),
    round.map(([, r]) => r),
  );
  return resolved.acceptedSenderRanks.map((s, i): Pair => [
    s,
    resolved.acceptedReceiverRanks[i],
  ]);
}

function greedyPairs(round: Array<Pair>): Array<Pair> {
  const resolved = runUnpaced(
    greedyRoundSweep(
      round.map(([s]) => s),
      round.map(([, r]) => r),
      ONE_TO_ONE,
    ),
  );
  return resolved.acceptedSenderRanks.map((s, i): Pair => [
    s,
    resolved.acceptedReceiverRanks[i],
  ]);
}

test("the sweep accepts the brute-force first largest pairing", () => {
  const rounds = [
    ...everyPairSet(3, 4),
    ...everyPairSet(4, 3),
    ...randomPairSets(400),
  ];
  let greedyFellShort = 0;
  for (const round of rounds) {
    const accepted = acceptedPairs(round);
    expect(accepted, JSON.stringify(round)).toStrictEqual(
      firstLargestPairing(round),
    );
    expect(isPairingOf(accepted, round)).toBe(true);
    expect(accepted).toStrictEqual(canonicalOrder(accepted));
    const greedy = greedyPairs(round);
    if (greedy.length === largestPairingSize(round))
      expect(accepted, JSON.stringify(round)).toStrictEqual(greedy);
    else ++greedyFellShort;
  }
  // The rounds reach the shapes where the two rules part.
  expect(greedyFellShort).toBeGreaterThan(0);
});

test("the order is the ranks', not the order the pairs arrive in", () => {
  // The same round with its pairs shuffled reaches the same table: nothing in
  // the rule reads the order a candidate entered the round.
  const canonical = pairs([0, 0, 1], [0, 1, 1]);
  const shuffled = pairs([1, 0, 0], [1, 1, 0]);
  expect(shuffled.acceptedSenderRanks).toStrictEqual(
    canonical.acceptedSenderRanks,
  );
  expect(shuffled.acceptedReceiverRanks).toStrictEqual(
    canonical.acceptedReceiverRanks,
  );
});

test("several equal value pairs between two records are one candidate pair", () => {
  const resolved = pairs([0, 0, 0], [3, 3, 3]);
  expect(resolved.acceptedSenderRanks).toStrictEqual([0]);
  expect(resolved.acceptedReceiverRanks).toStrictEqual([3]);
  expect(resolved.touchedReceiverRanks).toStrictEqual([3]);
});

test("every rank in any candidate pair leaves candidacy, accepted or not", () => {
  // Removal on a potential match: the discarded (0, 1) still takes receiver 1
  // out, and it is taken out again as an accepted pair's own record.
  const resolved = pairs([0, 0, 1], [0, 1, 1]);
  expect(resolved.touchedSenderRanks).toStrictEqual([0, 1]);
  expect(resolved.touchedReceiverRanks).toStrictEqual([0, 1]);
});

test("a sender left unpaired by the sweep still leaves candidacy", () => {
  // Sender 1's only candidate is receiver 0, which sender 0 took first. It
  // ends the round unmatched and out of candidacy: contradicted evidence does
  // not continue.
  const resolved = pairs([0, 1], [0, 0]);
  expect(resolved.acceptedSenderRanks).toStrictEqual([0]);
  expect(resolved.touchedSenderRanks).toStrictEqual([0, 1]);
});

test("the many side's clause relaxes the other side alone", () => {
  // Under a deduplicating cardinality a pair is accepted when the record on
  // the MANY side has not been accepted this round, whatever the "one" side
  // has done. With the receiver the many side, sender 0 pairs with both of
  // its receivers.
  const resolved = pairs([0, 0], [0, 1], {
    senderAcceptsOnce: false,
    receiverAcceptsOnce: true,
  });
  expect(resolved.acceptedSenderRanks).toStrictEqual([0, 0]);
  expect(resolved.acceptedReceiverRanks).toStrictEqual([0, 1]);
});

test("the one side keeps its own clause under the same cardinality", () => {
  // Receiver 0 is the many side's record and takes one pair; sender 1's
  // candidate is spent, so it leaves the round unpaired.
  const resolved = pairs([0, 1], [0, 0], {
    senderAcceptsOnce: false,
    receiverAcceptsOnce: true,
  });
  expect(resolved.acceptedSenderRanks).toStrictEqual([0]);
  expect(resolved.acceptedReceiverRanks).toStrictEqual([0]);
  expect(resolved.touchedSenderRanks).toStrictEqual([0, 1]);
});

test("a both-sided multiplicity accepts every candidate pair", () => {
  const resolved = pairs([0, 0, 1, 1], [0, 1, 0, 1], {
    senderAcceptsOnce: false,
    receiverAcceptsOnce: false,
  });
  expect(resolved.acceptedSenderRanks).toStrictEqual([0, 0, 1, 1]);
  expect(resolved.acceptedReceiverRanks).toStrictEqual([0, 1, 0, 1]);
});

test("misaligned halves are a caller fault, not a silent truncation", () => {
  expect(() => pairs([0, 1], [0])).toThrow(InternalConsistencyError);
});

test("an empty round resolves to nothing", () => {
  const resolved = pairs([], []);
  expect(resolved.acceptedSenderRanks).toStrictEqual([]);
  expect(resolved.touchedSenderRanks).toStrictEqual([]);
  expect(resolved.touchedReceiverRanks).toStrictEqual([]);
});
