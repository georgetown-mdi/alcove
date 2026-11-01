import { InternalConsistencyError } from "../errors";
import { Int32Builder, indexInSorted, sortedDistinct } from "./int32Groups";
import {
  PACED_STRETCH_RECORDS,
  runUnpaced,
  type PaceableSteps,
} from "../utils/eventLoop";

/**
 * Which of a round's two sides may stand in more than one accepted pair.
 *
 * Both flags are `true` under `one-to-one`, whose round accepts the first
 * largest pairing. A deduplicating cardinality
 * relaxes the clause on the "one" side alone -- a pair is accepted when the
 * record on the MANY side has not already been accepted in this round,
 * whether or not the record on the "one" side has -- and `many-to-many`
 * relaxes both, accepting every candidate pair (docs/spec/PROTOCOL.md, The
 * per-side rules).
 */
export interface RoundAcceptance {
  readonly senderAcceptsOnce: boolean;
  readonly receiverAcceptsOnce: boolean;
}

/** What one round's sweep produces. */
export interface ResolvedRound {
  /** The accepted pairs' sender ranks, in canonical order. */
  readonly acceptedSenderRanks: Array<number>;
  /** The accepted pairs' receiver ranks, positionally paired with the above. */
  readonly acceptedReceiverRanks: Array<number>;
  /**
   * Every sender rank standing in ANY of the round's candidate pairs,
   * accepted or discarded, ascending and without repeats: the round's
   * removal set for that party (docs/spec/PROTOCOL.md, Removal on a
   * potential match).
   */
  readonly touchedSenderRanks: Array<number>;
  /** The receiver's half of the same removal set. */
  readonly touchedReceiverRanks: Array<number>;
}

/**
 * The record-level resolution both linkage strategies run, over the same
 * candidate-pair input: the deterministic sweep of docs/spec/PROTOCOL.md,
 * Record-level resolution: canonical order and tiebreak, which accepts the
 * first largest pairing under `one-to-one` and the greedy relaxed clause under
 * a deduplicating cardinality (The per-side rules).
 *
 * The two parties reach a cascade round's association table by different
 * routes -- each resolving its own round from the two groupings the round's
 * frames hold -- where single-pass has one resolver. Writing the sweep once
 * and calling it from both is what makes the strategies' identical table a
 * property of the structure rather than of the tests
 * (docs/spec/PROTOCOL.md, One sweep, called by both strategies).
 *
 * A **rank** is a record's place, from zero, among the records its own party
 * stands in the round with, taken in ascending own-row order. Sweeping in
 * ascending (sender rank, receiver rank) is therefore the canonical (sender
 * row, receiver row) order the resolution fixes, and neither party has to
 * learn a row of the other to reproduce it. Single-pass passes row indices
 * directly, which are their own ranks: it holds both parties' rows.
 *
 * Pairs may arrive in any order and may repeat -- several equal value pairs
 * between the same two records are one candidate pair. Every rank is a whole
 * number.
 *
 * @param senderRanks - One entry per candidate pair.
 * @param receiverRanks - The other half of each pair, positionally aligned.
 * @param acceptance - Which side is held to one accepted pair per round.
 */
export function resolveRoundCandidatePairs(
  senderRanks: ArrayLike<number>,
  receiverRanks: ArrayLike<number>,
  acceptance: RoundAcceptance,
): ResolvedRound {
  return runUnpaced(
    roundCandidatePairSweep(senderRanks, receiverRanks, acceptance),
  );
}

/**
 * The sweep {@link resolveRoundCandidatePairs} runs, as steps a caller holding
 * an open connection paces.
 */
export function* roundCandidatePairSweep(
  senderRanks: ArrayLike<number>,
  receiverRanks: ArrayLike<number>,
  acceptance: RoundAcceptance,
): PaceableSteps<ResolvedRound> {
  if (senderRanks.length !== receiverRanks.length)
    throw new InternalConsistencyError(
      "a round's candidate pairs need one receiver rank per sender rank, " +
        `given ${senderRanks.length} and ${receiverRanks.length}`,
    );
  const count = senderRanks.length;
  for (let i = 0; i < count; ++i)
    if (!isRank(senderRanks[i]) || !isRank(receiverRanks[i]))
      throw new InternalConsistencyError(
        "a round's candidate pairs name a rank that is not a whole number",
      );
  // The receivers, and each pair's receiver as its place among them: what the
  // removal set and the once-only rule are kept against.
  const receivers = sortedDistinct(receiverRanks);
  const receiverOf = new Int32Array(count);
  for (let i = 0; i < count; ++i) {
    if ((i + 1) % PACED_STRETCH_RECORDS === 0) yield;
    receiverOf[i] = indexInSorted(receivers, receiverRanks[i]);
  }
  const pairs = canonicalPairs(senderRanks, receiverOf, receivers.length);

  // The distinct pairs in canonical order, each sender read as its place among
  // the touched senders.
  const touchedSenderRanks: Array<number> = [];
  const pairSender = new Int32Builder(count);
  const pairReceiver = new Int32Builder(count);
  // Sentinels below every rank, so the first pair opens a sender run rather
  // than continuing one.
  let previousSender = -1;
  let previousReceiver = -1;
  for (let k = 0; k < count; ++k) {
    if ((k + 1) % PACED_STRETCH_RECORDS === 0) yield;
    const sender = pairs.sender(k);
    const receiver = pairs.receiver(k);
    if (sender === previousSender && receiver === previousReceiver) continue;
    if (sender !== previousSender) touchedSenderRanks.push(sender);
    previousSender = sender;
    previousReceiver = receiver;
    pairSender.push(touchedSenderRanks.length - 1);
    pairReceiver.push(receiver);
  }
  const distinct: DistinctPairs = {
    sender: pairSender.finish(),
    receiver: pairReceiver.finish(),
    senderCount: touchedSenderRanks.length,
    receiverCount: receivers.length,
  };

  const accepted =
    acceptance.senderAcceptsOnce && acceptance.receiverAcceptsOnce
      ? yield* firstLargestPairing(distinct)
      : yield* relaxedSweep(distinct, acceptance);

  const acceptedSenderRanks: Array<number> = [];
  const acceptedReceiverRanks: Array<number> = [];
  for (let k = 0; k < accepted.length; ++k) {
    if ((k + 1) % PACED_STRETCH_RECORDS === 0) yield;
    if (accepted[k] === 0) continue;
    acceptedSenderRanks.push(touchedSenderRanks[distinct.sender[k]]);
    acceptedReceiverRanks.push(receivers[distinct.receiver[k]]);
  }

  return {
    acceptedSenderRanks,
    acceptedReceiverRanks,
    touchedSenderRanks,
    touchedReceiverRanks: Array.from(receivers),
  };
}

// A round's distinct candidate pairs in canonical order: pair `k` joins sender
// `sender[k]` and receiver `receiver[k]`, each its place among its side's
// touched records.
interface DistinctPairs {
  readonly sender: Int32Array;
  readonly receiver: Int32Array;
  readonly senderCount: number;
  readonly receiverCount: number;
}

// The greedy sweep in canonical order under a clause one side relaxes: a pair
// is accepted unless a side held to one pair already has its record accepted.
function* relaxedSweep(
  pairs: DistinctPairs,
  acceptance: RoundAcceptance,
): PaceableSteps<Uint8Array> {
  const count = pairs.sender.length;
  const accepted = new Uint8Array(count);
  const senderTaken = new Uint8Array(pairs.senderCount);
  const receiverTaken = new Uint8Array(pairs.receiverCount);
  for (let k = 0; k < count; ++k) {
    if ((k + 1) % PACED_STRETCH_RECORDS === 0) yield;
    const sender = pairs.sender[k];
    const receiver = pairs.receiver[k];
    if (acceptance.senderAcceptsOnce && senderTaken[sender] === 1) continue;
    if (acceptance.receiverAcceptsOnce && receiverTaken[receiver] === 1)
      continue;
    accepted[k] = 1;
    senderTaken[sender] = 1;
    receiverTaken[receiver] = 1;
  }
  return accepted;
}

/**
 * The one-to-one resolution: the lexicographically first maximum matching of
 * the round's pairs in canonical order (docs/spec/PROTOCOL.md, Record-level
 * resolution: canonical order and tiebreak). It holds a largest pairing
 * containing every pair accepted so far, and accepts the next pair when the
 * pairing can be rebuilt around it at the same size, which one augmenting-path
 * search decides. A search reaches only the connected component of the pair it
 * starts from, so each component is resolved on its own, in work quadratic in
 * its pairs: one search per pair, and one per sender for the first pairing.
 */
function* firstLargestPairing(pairs: DistinctPairs): PaceableSteps<Uint8Array> {
  const count = pairs.sender.length;
  const { senderCount, receiverCount } = pairs;
  let work = 0;

  // Pairs are in sender order, so a sender's pairs are one run; a receiver's
  // are gathered by counting.
  const senderStart = new Int32Array(senderCount + 1);
  const receiverStart = new Int32Array(receiverCount + 1);
  for (let k = 0; k < count; ++k) {
    if ((k + 1) % PACED_STRETCH_RECORDS === 0) yield;
    ++senderStart[pairs.sender[k] + 1];
    ++receiverStart[pairs.receiver[k] + 1];
  }
  for (let s = 0; s < senderCount; ++s) senderStart[s + 1] += senderStart[s];
  for (let r = 0; r < receiverCount; ++r)
    receiverStart[r + 1] += receiverStart[r];
  const receiverPairs = new Int32Array(count);
  const receiverFill = receiverStart.slice(0, receiverCount);
  for (let k = 0; k < count; ++k) {
    if ((k + 1) % PACED_STRETCH_RECORDS === 0) yield;
    receiverPairs[receiverFill[pairs.receiver[k]]++] = k;
  }

  // The pair each record is matched by, or -1; and whether it is in an
  // accepted pair, which no later search may move.
  const senderMatch = new Int32Array(senderCount).fill(-1);
  const receiverMatch = new Int32Array(receiverCount).fill(-1);
  const senderFixed = new Uint8Array(senderCount);
  const receiverFixed = new Uint8Array(receiverCount);
  const senderSeen = new Float64Array(senderCount);
  const receiverSeen = new Float64Array(receiverCount);
  const senderReachedBy = new Int32Array(senderCount);
  const receiverReachedBy = new Int32Array(receiverCount);
  const senderQueue = new Int32Array(senderCount);
  const receiverQueue = new Int32Array(receiverCount);
  let search = 0;

  // An alternating path from the free sender `start` to a free receiver over
  // records not fixed, applied when found.
  function* augmentFromSender(start: number): PaceableSteps<boolean> {
    ++search;
    let head = 0;
    let tail = 0;
    senderQueue[tail++] = start;
    senderSeen[start] = search;
    while (head < tail) {
      const sender = senderQueue[head++];
      for (let k = senderStart[sender]; k < senderStart[sender + 1]; ++k) {
        if (++work === PACED_STRETCH_RECORDS) {
          work = 0;
          yield;
        }
        const receiver = pairs.receiver[k];
        if (receiverFixed[receiver] === 1 || receiverSeen[receiver] === search)
          continue;
        receiverSeen[receiver] = search;
        receiverReachedBy[receiver] = k;
        const matched = receiverMatch[receiver];
        if (matched < 0) {
          let pair = k;
          for (;;) {
            const along = pairs.sender[pair];
            const previous = senderMatch[along];
            senderMatch[along] = pair;
            receiverMatch[pairs.receiver[pair]] = pair;
            if (previous < 0) return true;
            pair = receiverReachedBy[pairs.receiver[previous]];
          }
        }
        const next = pairs.sender[matched];
        if (senderSeen[next] === search) continue;
        senderSeen[next] = search;
        senderQueue[tail++] = next;
      }
    }
    return false;
  }

  // The same search from the free receiver `start` to a free sender.
  function* augmentFromReceiver(start: number): PaceableSteps<boolean> {
    ++search;
    let head = 0;
    let tail = 0;
    receiverQueue[tail++] = start;
    receiverSeen[start] = search;
    while (head < tail) {
      const receiver = receiverQueue[head++];
      for (
        let i = receiverStart[receiver];
        i < receiverStart[receiver + 1];
        ++i
      ) {
        if (++work === PACED_STRETCH_RECORDS) {
          work = 0;
          yield;
        }
        const k = receiverPairs[i];
        const sender = pairs.sender[k];
        if (senderFixed[sender] === 1 || senderSeen[sender] === search)
          continue;
        senderSeen[sender] = search;
        senderReachedBy[sender] = k;
        const matched = senderMatch[sender];
        if (matched < 0) {
          let pair = k;
          for (;;) {
            const along = pairs.receiver[pair];
            const previous = receiverMatch[along];
            receiverMatch[along] = pair;
            senderMatch[pairs.sender[pair]] = pair;
            if (previous < 0) return true;
            pair = senderReachedBy[pairs.sender[previous]];
          }
        }
        const next = pairs.receiver[matched];
        if (receiverSeen[next] === search) continue;
        receiverSeen[next] = search;
        receiverQueue[tail++] = next;
      }
    }
    return false;
  }

  // A largest pairing: the greedy sweep's pairs, then one search from each
  // sender left free.
  for (let k = 0; k < count; ++k) {
    if ((k + 1) % PACED_STRETCH_RECORDS === 0) yield;
    const sender = pairs.sender[k];
    const receiver = pairs.receiver[k];
    if (senderMatch[sender] >= 0 || receiverMatch[receiver] >= 0) continue;
    senderMatch[sender] = k;
    receiverMatch[receiver] = k;
  }
  for (let sender = 0; sender < senderCount; ++sender)
    if (senderMatch[sender] < 0) yield* augmentFromSender(sender);

  const accepted = new Uint8Array(count);
  for (let k = 0; k < count; ++k) {
    if ((k + 1) % PACED_STRETCH_RECORDS === 0) yield;
    const sender = pairs.sender[k];
    const receiver = pairs.receiver[k];
    if (senderFixed[sender] === 1 || receiverFixed[receiver] === 1) continue;
    const senderPair = senderMatch[sender];
    const receiverPair = receiverMatch[receiver];
    if (senderPair < 0 && receiverPair < 0)
      throw new InternalConsistencyError(
        "a round's pairing left both records of a candidate pair unmatched, " +
          "so it was not a largest pairing",
      );
    senderFixed[sender] = 1;
    receiverFixed[receiver] = 1;
    accepted[k] = 1;
    if (senderPair === k) continue;
    senderMatch[sender] = k;
    receiverMatch[receiver] = k;
    // With one record free, swapping the pair in keeps the pairing's size.
    if (senderPair < 0) {
      senderMatch[pairs.sender[receiverPair]] = -1;
      continue;
    }
    if (receiverPair < 0) {
      receiverMatch[pairs.receiver[senderPair]] = -1;
      continue;
    }
    // With both matched elsewhere, forcing the pair in frees two records and
    // loses one pair; any path that wins it back ends at one of them.
    const freedSender = pairs.sender[receiverPair];
    const freedReceiver = pairs.receiver[senderPair];
    senderMatch[freedSender] = -1;
    receiverMatch[freedReceiver] = -1;
    if (yield* augmentFromSender(freedSender)) continue;
    if (yield* augmentFromReceiver(freedReceiver)) continue;
    senderFixed[sender] = 0;
    receiverFixed[receiver] = 0;
    accepted[k] = 0;
    senderMatch[sender] = senderPair;
    receiverMatch[receiver] = receiverPair;
    senderMatch[freedSender] = receiverPair;
    receiverMatch[freedReceiver] = senderPair;
  }
  return accepted;
}

function isRank(rank: number): boolean {
  return Number.isSafeInteger(rank) && rank >= 0;
}

// The pairs in ascending (sender rank, receiver) order, the receiver read as
// its place among the receivers.
interface SortedPairs {
  sender(k: number): number;
  receiver(k: number): number;
}

// Where a pair fits one double exactly the pairs sort as numbers, without a
// comparator; past that they sort by index.
function canonicalPairs(
  senderRanks: ArrayLike<number>,
  receiverOf: Int32Array,
  receiverCount: number,
): SortedPairs {
  const count = senderRanks.length;
  let highestSender = 0;
  for (let i = 0; i < count; ++i)
    if (senderRanks[i] > highestSender) highestSender = senderRanks[i];
  if ((highestSender + 1) * receiverCount > Number.MAX_SAFE_INTEGER) {
    const order = Array.from({ length: count }, (_, i) => i).sort(
      (a, b) =>
        senderRanks[a] - senderRanks[b] || receiverOf[a] - receiverOf[b],
    );
    return {
      sender: (k) => senderRanks[order[k]],
      receiver: (k) => receiverOf[order[k]],
    };
  }
  const keys = new Float64Array(count);
  for (let i = 0; i < count; ++i)
    keys[i] = senderRanks[i] * receiverCount + receiverOf[i];
  keys.sort();
  return {
    sender: (k) => (keys[k] - (keys[k] % receiverCount)) / receiverCount,
    receiver: (k) => keys[k] % receiverCount,
  };
}
