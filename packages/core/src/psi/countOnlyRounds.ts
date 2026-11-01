// The rounds of the count-only construction over every agreed linkage key
// (docs/spec/PROTOCOL.md, PSI-C, The count-only rounds): each round's set,
// one element per record, and the receiver's request order, drawn once for
// the exchange.
import {
  connectionEndReader,
  type MessageConnection,
} from "../connection/messageConnection";
import { InternalConsistencyError } from "../errors";
import {
  fanOutReachedMatchingRefusal,
  type KeyCandidates,
} from "../standardization";
import { DistinctValues } from "../utils/distinctValues";
import { EventLoopPacer, PACED_STRETCH_RECORDS } from "../utils/eventLoop";
import { HeldPermutation } from "./countOnlyPermutation";
import { MAX_MAP_SHARD_ENTRIES } from "./shardedMap";

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
 * One count-only round's set, `source` being this party's records in record
 * order and `round` the round's 0-based position: one element per record, the
 * round value `round:value` where the record has a value for the key that no
 * other record has, and a fresh dummy otherwise. A record the round is not
 * built for, on the side a missing-field condition filters, comes with no
 * value (`roundKeyIterable`), so it has a dummy and repeats no value. A
 * record holding a candidate set is refused, as every round matching one value
 * per record refuses it.
 * `records` is this party's declared record count; a source holding another
 * number of records is an internal fault.
 *
 * @internal
 */
export async function countOnlyRoundElements(
  source: Iterable<KeyCandidates>,
  round: number,
  records: number,
  pacer: EventLoopPacer = new EventLoopPacer(),
  dummies: CountOnlyDummies = new CountOnlyDummies(),
  shardEntries: number = MAX_MAP_SHARD_ENTRIES,
): Promise<Array<string>> {
  const distinct = new DistinctValues({ shardEntries });
  const heldBySeveral: Array<boolean> = [];
  const positionOfRecord = new Int32Array(records);
  let record = 0;
  for (const candidates of source) {
    if (record === records)
      throw new InternalConsistencyError(
        `a count-only round's input holds more than the ${String(records)} declared records`,
      );
    if (candidates !== undefined && typeof candidates !== "string")
      throw fanOutReachedMatchingRefusal();
    if (candidates === undefined) positionOfRecord[record] = NO_VALUE;
    else {
      const size = distinct.size;
      const position = distinct.add(candidates);
      if (position === size) heldBySeveral.push(false);
      else heldBySeveral[position] = true;
      positionOfRecord[record] = position;
    }
    if (++record % PACED_STRETCH_RECORDS === 0) await pacer.yieldWhenDue();
  }
  if (record !== records)
    throw new InternalConsistencyError(
      `a count-only round's input holds ${String(record)} of the ${String(records)} declared records`,
    );
  const prefix = `${String(round)}:`;
  const elements = new Array<string>(records);
  for (let index = 0; index < records; index += 1) {
    const position = positionOfRecord[index]!;
    elements[index] =
      position === NO_VALUE || heldBySeveral[position]
        ? dummies.draw()
        : prefix + distinct.values[position]!;
    if ((index + 1) % PACED_STRETCH_RECORDS === 0) await pacer.yieldWhenDue();
  }
  positionOfRecord.fill(0);
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
 * A count-only round's widths (docs/spec/PROTOCOL.md, Candidate sets under
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
 * Runs every count-only round of `data`, one entry per round in the round
 * order, and returns the count on the receiver, `undefined` on the sender.
 * The receiver draws its request order once and discards it when the rounds
 * end, whether they complete or fail; no count is taken unless every round
 * completed.
 */
export async function runCountOnlyRounds(
  participant: PSIParticipant,
  conn: MessageConnection,
  data: ReadonlyArray<Iterable<KeyCandidates>>,
  declared: CountOnlyDeclaredCounts,
  setStage: (id: string) => void,
): Promise<number | undefined> {
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
      const elements = await countOnlyRoundElements(
        data[round]!,
        round,
        ownRecords,
        pacer,
        dummies,
      );
      const set =
        requestOrder === undefined
          ? elements
          : Array.from(
              { length: ownRecords },
              (_, position) => elements[requestOrder.at(position)]!,
            );
      await participant.countPermutedRound(conn, set, declared);
    }
    return isReceiver
      ? await participant.finishPermutedCount(data.length)
      : undefined;
  } finally {
    requestOrder?.discard();
  }
}
