// The rounds of the count-only construction over every agreed linkage key
// (docs/spec/PSI_C.md, PSI-C, The count-only rounds, and Candidate sets
// under count-only): each round's widths and set, one block per record, and
// the receiver's request order, drawn once for the exchange.
import {
  connectionEndReader,
  type MessageConnection,
} from "../connection/messageConnection";
import { InternalConsistencyError } from "../errors";
import { declaredFanOutFunction, declaredKeyWidth } from "../fanOutFunctions";
import {
  expandsOnReceiverOnly,
  fuzzyCandidateCeiling,
} from "../fuzzyComparisons";
import { elementValueWidthBound } from "../keyElementWidth";
import { linkageRounds } from "../linkageKeyCondition";
import {
  fanOutReachedMatchingRefusal,
  type KeyCandidates,
} from "../standardization";
import { DistinctValues } from "../utils/distinctValues";
import { EventLoopPacer, PACED_STRETCH_RECORDS } from "../utils/eventLoop";
import { drawBlockOrders, HeldPermutation } from "./countOnlyPermutation";
import { MAX_MAP_SHARD_ENTRIES } from "./shardedMap";

import type { LinkageKey, LinkageTerms } from "../config/linkageTermsSchema";
import type { PSIParticipant } from "./participant";

const DUMMY_BYTES = 32;
// The platform generator fills at most 65,536 bytes a call.
const DUMMY_DRAW_BYTES = 65_536;
const HEX_OF_BYTE = Array.from({ length: 256 }, (_, byte) =>
  byte.toString(16).padStart(2, "0"),
);

/**
 * Draws count-only dummies: 32 bytes each from the platform's
 * cryptographically secure random generator, written as 64 lowercase
 * hexadecimal characters, none reused.
 *
 * @internal
 */
export class CountOnlyDummies {
  private readonly bytes = new Uint8Array(DUMMY_DRAW_BYTES);
  private next = DUMMY_DRAW_BYTES;

  /** The next dummy. */
  draw(): string {
    if (this.next === DUMMY_DRAW_BYTES) {
      crypto.getRandomValues(this.bytes);
      this.next = 0;
    }
    let hex = "";
    for (let offset = 0; offset < DUMMY_BYTES; offset += 1)
      hex += HEX_OF_BYTE[this.bytes[this.next + offset]!]!;
    this.next += DUMMY_BYTES;
    return hex;
  }
}

const NO_VALUE = -1;

/**
 * A record's candidates for a count-only round, refusing more than `width` of
 * them, the most its block holds: an expansion the declared widths do not
 * account for, such as a transform that expands one value without being a
 * declared fan-out function.
 *
 * @internal
 */
export function candidatesWithinWidth(
  candidates: KeyCandidates,
  width: number,
): ReadonlyArray<string> {
  if (candidates === undefined) return [];
  if (typeof candidates === "string") return [candidates];
  if (candidates.size > width) throw fanOutReachedMatchingRefusal();
  return [...candidates];
}

/**
 * One count-only round's set, `source` being this party's records in record
 * order and `round` the round's 0-based position: one block of `width`
 * elements per record, in record order. A block holds the round value
 * `round:value` of each of the record's candidates that no other record has
 * among its candidates, then a fresh dummy for each element left over. A
 * record the round is not built for, on the side a missing-field condition
 * filters, comes with no value (`roundKeyIterable`), so its block is all
 * dummies and repeats no value. A record holding more candidates than `width`
 * is refused ({@link candidatesWithinWidth}).
 * `records` is this party's declared record count; a source holding another
 * number of records is an internal fault.
 *
 * @internal
 */
export async function countOnlyRoundElements(
  source: Iterable<KeyCandidates>,
  round: number,
  records: number,
  width = 1,
  pacer: EventLoopPacer = new EventLoopPacer(),
  dummies: CountOnlyDummies = new CountOnlyDummies(),
  shardEntries: number = MAX_MAP_SHARD_ENTRIES,
): Promise<Array<string>> {
  const distinct = new DistinctValues({ shardEntries });
  const heldBySeveral: Array<boolean> = [];
  const positionOfElement = new Int32Array(records * width).fill(NO_VALUE);
  let record = 0;
  for (const candidates of source) {
    if (record === records)
      throw new InternalConsistencyError(
        `a count-only round's input holds more than the ${String(records)} declared records`,
      );
    let element = record * width;
    for (const candidate of candidatesWithinWidth(candidates, width)) {
      const size = distinct.size;
      const position = distinct.add(candidate);
      if (position === size) heldBySeveral.push(false);
      else heldBySeveral[position] = true;
      positionOfElement[element++] = position;
    }
    if (++record % PACED_STRETCH_RECORDS === 0) await pacer.yieldWhenDue();
  }
  if (record !== records)
    throw new InternalConsistencyError(
      `a count-only round's input holds ${String(record)} of the ${String(records)} declared records`,
    );
  const prefix = `${String(round)}:`;
  const elements = new Array<string>(records * width);
  for (let index = 0; index < elements.length; index += 1) {
    const position = positionOfElement[index]!;
    elements[index] =
      position === NO_VALUE || heldBySeveral[position]
        ? dummies.draw()
        : prefix + distinct.values[position]!;
    if ((index + 1) % PACED_STRETCH_RECORDS === 0) await pacer.yieldWhenDue();
  }
  positionOfElement.fill(0);
  return elements;
}

/**
 * The record counts the terms exchange stated, which every count-only round's
 * sets are held to: `n_R`, the receiver's, and `n_S`, the sender's.
 */
export interface CountOnlyDeclaredCounts {
  readonly receiverRecords: number;
  readonly senderRecords: number;
}

/**
 * A count-only round's widths (docs/spec/PSI_C.md, Candidate sets under
 * count-only): `w_R`, the elements in each block of the receiver's request,
 * and `w_S`, in each block of the sender's setup. Each is 1 in a round whose
 * key declares no candidate set.
 */
export interface CountOnlyRoundWidths {
  readonly receiverWidth: number;
  readonly senderWidth: number;
}

/** The widths of a round whose key declares no candidate set. */
export const ONE_ELEMENT_PER_RECORD: CountOnlyRoundWidths = {
  receiverWidth: 1,
  senderWidth: 1,
};

/**
 * The widths of a count-only round of `key` (docs/spec/PSI_C.md, Candidate
 * sets under count-only): `w_R` is the width the agreed terms declare for the
 * key ({@link declaredKeyWidth}). `w_S` is the same product with the factor of
 * each expansion only the receiver executes taken as 1 -- a fuzzy kind
 * {@link expandsOnReceiverOnly} names -- except on a key with a
 * fan-out, where it is `w_R`, since a fan-out's own factor does not bound how
 * many values it realizes. Both are functions of the agreed terms alone, so
 * both parties derive them.
 *
 * @throws {UsageError} as {@link declaredKeyWidth} does.
 */
export function countOnlyRoundWidths(
  key: LinkageKey,
  keyIndex?: number,
): CountOnlyRoundWidths {
  const receiverWidth = declaredKeyWidth(key, keyIndex);
  if (
    key.elements.some(
      (element) => declaredFanOutFunction(element.transform) !== undefined,
    )
  )
    return { receiverWidth, senderWidth: receiverWidth };
  let senderWidth = 1;
  for (const element of key.elements) {
    const kind = element.generateFuzzyComparisons;
    if (kind !== undefined && !expandsOnReceiverOnly(kind))
      senderWidth *= fuzzyCandidateCeiling(
        kind,
        elementValueWidthBound(element.transform),
      );
  }
  return { receiverWidth, senderWidth };
}

/**
 * The widths of every count-only round of `terms`, in the round order
 * (`linkageRounds`).
 */
export function countOnlyWidthsOfRounds(
  terms: Pick<LinkageTerms, "linkageKeys">,
): Array<CountOnlyRoundWidths> {
  return linkageRounds(terms.linkageKeys).map((round) =>
    countOnlyRoundWidths(round.key, round.keyIndex),
  );
}

// The receiver's request for a round: its blocks in its request order, the
// elements of each block under an order drawn for that block in this round.
async function inRequestOrder(
  elements: ReadonlyArray<string>,
  requestOrder: HeldPermutation,
  records: number,
  width: number,
  pacer: EventLoopPacer,
): Promise<Array<string>> {
  const withinBlock = drawBlockOrders(records, width);
  try {
    const request = new Array<string>(records * width);
    for (let position = 0; position < records; position += 1) {
      const block = requestOrder.at(position) * width;
      const start = position * width;
      for (let place = 0; place < width; place += 1)
        request[start + place] = elements[block + withinBlock[start + place]!]!;
      if ((position + 1) % PACED_STRETCH_RECORDS === 0)
        await pacer.yieldWhenDue();
    }
    return request;
  } finally {
    withinBlock.fill(0);
  }
}

/**
 * Runs every count-only round of `data`, one entry per round in the round
 * order, and returns the count on the receiver, `undefined` on the sender.
 * `widths` has one entry per round, each round's set holding one block of
 * this party's width per record. The receiver draws its request order once
 * and discards it when the rounds end, whether they complete or fail, and
 * orders the elements within each block under an order drawn for that block
 * in each round; no count is taken unless every round completed.
 */
export async function runCountOnlyRounds(
  participant: PSIParticipant,
  conn: MessageConnection,
  data: ReadonlyArray<Iterable<KeyCandidates>>,
  declared: CountOnlyDeclaredCounts,
  setStage: (id: string) => void,
  widths: ReadonlyArray<CountOnlyRoundWidths> = data.map(
    () => ONE_ELEMENT_PER_RECORD,
  ),
): Promise<number | undefined> {
  if (widths.length !== data.length)
    throw new InternalConsistencyError(
      `a count-only run was given widths for ${String(widths.length)} of its ${String(data.length)} rounds`,
    );
  const isReceiver = participant.config.role === "joiner";
  const ownRecords = isReceiver
    ? declared.receiverRecords
    : declared.senderRecords;
  const pacer = new EventLoopPacer(connectionEndReader(conn));
  const dummies = new CountOnlyDummies();
  const requestOrder = isReceiver
    ? HeldPermutation.draw(declared.receiverRecords)
    : undefined;
  try {
    for (let round = 0; round < data.length; round += 1) {
      setStage(`stage ${String(round + 1)} / ${String(data.length)}`);
      const roundWidths = widths[round]!;
      const width = isReceiver
        ? roundWidths.receiverWidth
        : roundWidths.senderWidth;
      const elements = await countOnlyRoundElements(
        data[round]!,
        round,
        ownRecords,
        width,
        pacer,
        dummies,
      );
      const set =
        requestOrder === undefined
          ? elements
          : await inRequestOrder(
              elements,
              requestOrder,
              ownRecords,
              width,
              pacer,
            );
      await participant.countPermutedRound(conn, set, declared, roundWidths);
    }
    return isReceiver
      ? await participant.finishPermutedCount(data.length)
      : undefined;
  } finally {
    requestOrder?.discard();
  }
}
