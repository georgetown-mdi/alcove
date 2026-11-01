import { InternalConsistencyError } from "../../src/errors";
import { indexInSorted, sortedDistinct } from "../../src/psi/int32Groups";
import type * as RoundResolution from "../../src/psi/roundResolution";
import type {
  ResolvedRound,
  RoundAcceptance,
} from "../../src/psi/roundResolution";
import {
  PACED_STRETCH_RECORDS,
  runUnpaced,
  type PaceableSteps,
} from "../../src/utils/eventLoop";

/**
 * The greedy sweep the one-to-one resolution is measured against, kept as a
 * test reference only: the round's distinct pairs in ascending (sender rank,
 * receiver rank), each accepted unless a side held to one pair already has its
 * record accepted. It takes the arguments and returns the result of the
 * shipped sweep, so a test can run the protocol under either rule.
 */
export function* greedyRoundSweep(
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

interface SortedPairs {
  sender(k: number): number;
  receiver(k: number): number;
}

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

/** Which rule the module {@link withGreedySwitch} builds answers from. */
export const greedySwitch = { greedy: false };

/**
 * The round-resolution module with both entry points answering from
 * {@link greedyRoundSweep} while `greedySwitch.greedy` is set and from the
 * shipped rule otherwise: a `vi.mock` factory's result, so one test file runs
 * the whole protocol under either rule.
 */
export function withGreedySwitch(
  original: typeof RoundResolution,
): typeof RoundResolution {
  const sweep: typeof original.roundCandidatePairSweep = (...args) =>
    greedySwitch.greedy
      ? greedyRoundSweep(...args)
      : original.roundCandidatePairSweep(...args);
  return {
    ...original,
    roundCandidatePairSweep: sweep,
    resolveRoundCandidatePairs: (...args) => runUnpaced(sweep(...args)),
  };
}
