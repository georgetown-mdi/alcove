import { InternalConsistencyError } from "../errors";
import { indexInSorted, sortedDistinct } from "./int32Groups";
import {
  PACED_STRETCH_RECORDS,
  runUnpaced,
  type PaceableSteps,
} from "../utils/eventLoop";

/**
 * Which of a round's two sides may stand in more than one accepted pair.
 *
 * Both flags are `true` under `one-to-one`. A deduplicating cardinality
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
  /** The accepted pairs' sender ranks, in the sweep's own order. */
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
 * candidate-pair input: the deterministic greedy sweep of
 * docs/spec/PROTOCOL.md, Record-level resolution: canonical order and
 * tiebreak.
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

  const acceptedSenderRanks: Array<number> = [];
  const acceptedReceiverRanks: Array<number> = [];
  const touchedSenderRanks: Array<number> = [];
  const acceptedReceiver = acceptance.receiverAcceptsOnce
    ? new Uint8Array(receivers.length)
    : undefined;
  // Sentinels below every rank, so the first pair opens a sender run rather
  // than continuing one.
  let previousSender = -1;
  let previousReceiver = -1;
  let senderAccepted = false;

  for (let k = 0; k < count; ++k) {
    if ((k + 1) % PACED_STRETCH_RECORDS === 0) yield;
    const sender = pairs.sender(k);
    const receiver = pairs.receiver(k);
    if (sender === previousSender && receiver === previousReceiver) continue;
    if (sender !== previousSender) {
      touchedSenderRanks.push(sender);
      senderAccepted = false;
    }
    previousSender = sender;
    previousReceiver = receiver;
    if (acceptance.senderAcceptsOnce && senderAccepted) continue;
    if (acceptedReceiver !== undefined) {
      if (acceptedReceiver[receiver] === 1) continue;
      acceptedReceiver[receiver] = 1;
    }
    acceptedSenderRanks.push(sender);
    acceptedReceiverRanks.push(receivers[receiver]);
    senderAccepted = true;
  }

  return {
    acceptedSenderRanks,
    acceptedReceiverRanks,
    touchedSenderRanks,
    touchedReceiverRanks: Array.from(receivers),
  };
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
