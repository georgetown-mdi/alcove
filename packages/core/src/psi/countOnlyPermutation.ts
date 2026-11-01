import { PSI_ENCODED_ELEMENT_BYTES } from "../connection/webrtcOutboundBound";
import {
  InternalConsistencyError,
  PartnerProtocolRefusalError,
} from "../errors";
import { maximumMatchingSize } from "./roundResolution";

// The secret state of a count-only exchange under the sender's permutation
// (docs/spec/PROTOCOL.md, PSI-C): the sender's `pi` and `sigma`, and the
// receiver's replay over each round's (slot, pseudonym) pairs. Both stay
// inside the PSI engine that holds them and are discarded with it.

// Random words drawn per call to the platform generator, which fills at most
// 65,536 bytes at once.
const RANDOM_WORDS_PER_DRAW = 4096;
const UINT32_RANGE = 2 ** 32;

/**
 * A uniformly random permutation of `0` to `size - 1`, by a Fisher-Yates
 * shuffle over the platform's cryptographically secure random generator. Each
 * index is drawn by rejection sampling, so no index is favored by the modulo.
 *
 * @internal
 */
export function drawUniformPermutation(size: number): Int32Array {
  return drawBlockOrders(1, size);
}

const MAX_PERMUTATION_POSITIONS = 2 ** 31 - 1;

/**
 * For each of `blocks` blocks of `width` positions, a uniformly random
 * permutation of `0` to `width - 1`, drawn as {@link drawUniformPermutation}
 * draws one: entry `b * width + j` is the place the permutation of block `b`
 * gives position `j`. A width of 1 draws nothing from the generator.
 *
 * @internal
 */
export function drawBlockOrders(blocks: number, width: number): Int32Array {
  const size = blocks * width;
  if (
    !Number.isSafeInteger(blocks) ||
    !Number.isSafeInteger(width) ||
    blocks < 0 ||
    width < 0 ||
    size > MAX_PERMUTATION_POSITIONS
  )
    throw new InternalConsistencyError(
      `a permutation cannot have ${String(blocks)} blocks of ${String(width)} positions`,
    );
  const order = new Int32Array(size);
  const words = new Uint32Array(RANDOM_WORDS_PER_DRAW);
  let next = words.length;
  const randomWord = (): number => {
    if (next === words.length) {
      crypto.getRandomValues(words);
      next = 0;
    }
    return words[next++]!;
  };
  for (let block = 0; block < blocks; block += 1) {
    const start = block * width;
    for (let index = 0; index < width; index += 1) order[start + index] = index;
    for (let last = width - 1; last > 0; last -= 1) {
      const choices = last + 1;
      const limit = UINT32_RANGE - (UINT32_RANGE % choices);
      let word = randomWord();
      while (word >= limit) word = randomWord();
      const pick = start + (word % choices);
      const held = order[start + last]!;
      order[start + last] = order[pick]!;
      order[pick] = held;
    }
  }
  words.fill(0);
  return order;
}

/**
 * A secret permutation an engine holds for one exchange: never returned to a
 * caller, and zeroed by {@link discard}, after which it refuses every use.
 *
 * @internal
 */
export class HeldPermutation {
  #order: Int32Array | undefined;
  readonly size: number;

  constructor(order: Int32Array) {
    this.#order = order;
    this.size = order.length;
  }

  /** A permutation of `size` positions drawn by {@link drawUniformPermutation}. */
  static draw(size: number): HeldPermutation {
    return new HeldPermutation(drawUniformPermutation(size));
  }

  /** The position `index` maps to. */
  at(index: number): number {
    const order = this.#order;
    if (order === undefined)
      throw new InternalConsistencyError(
        "a count-only permutation was used after it was discarded",
      );
    return order[index]!;
  }

  /** Zeroes the permutation and drops it. */
  discard(): void {
    this.#order?.fill(0);
    this.#order = undefined;
  }
}

/**
 * Refuses, as a protocol error naming `engineId`, an index table in which a
 * pseudonym from `0` to its length over `width`, minus one, does not occur
 * exactly `width` times (docs/spec/PROTOCOL.md, Candidate sets under
 * count-only): at `width` 1, a table that is not a permutation of `0` to its
 * length minus one. An entry that is not an integer is refused whatever the
 * array type.
 *
 * @internal
 */
export function assertIndexTableNamesEachPseudonym(
  engineId: string,
  indexTable: ArrayLike<number>,
  width: number,
): void {
  const entries = indexTable.length;
  const pseudonyms = entries / width;
  const refusal = () =>
    new PartnerProtocolRefusalError(
      width === 1
        ? `${engineId} protocol error: the partner's index table is not a permutation of its ${String(entries)} positions`
        : `${engineId} protocol error: the partner's index table does not name each of its ${String(pseudonyms)} pseudonyms exactly ${String(width)} times`,
    );
  if (!Number.isSafeInteger(width) || width < 1)
    throw new InternalConsistencyError(
      `${engineId}: an index table cannot be read at width ${String(width)}`,
    );
  if (!Number.isInteger(pseudonyms)) throw refusal();
  // `entries` is `pseudonyms * width`, so no pseudonym exceeding `width`
  // means every one occurs exactly `width` times.
  const seen = new Int32Array(pseudonyms);
  for (let position = 0; position < entries; position += 1) {
    const entry = indexTable[position]!;
    if (
      !Number.isInteger(entry) ||
      entry < 0 ||
      entry >= pseudonyms ||
      seen[entry] === width
    )
      throw refusal();
    seen[entry] += 1;
  }
}

const INDEX_TABLE_ENTRY_BYTES = 4;

/**
 * The phrase a refusal names a count-only round's width with: none at width
 * 1, the width of every round whose key declares no candidate set.
 *
 * @internal
 */
export function atWidth(width: number): string {
  return width === 1 ? "" : ` at width ${String(width)}`;
}

/**
 * A count-only round's index table as its frame sends it: one little-endian
 * `Int32` per setup position (docs/spec/PROTOCOL.md, PSI-C).
 *
 * @internal
 */
export function encodeIndexTable(indexTable: Int32Array): Uint8Array {
  const bytes = new Uint8Array(indexTable.length * INDEX_TABLE_ENTRY_BYTES);
  const view = new DataView(bytes.buffer);
  for (let position = 0; position < indexTable.length; position += 1)
    view.setInt32(
      position * INDEX_TABLE_ENTRY_BYTES,
      indexTable[position]!,
      true,
    );
  return bytes;
}

/**
 * Decodes a partner's index-table frame, refusing as a protocol error naming
 * `engineId` a frame that is not one little-endian `Int32` value for each of
 * the `width` elements of each of its `records` declared records. Whether each
 * pseudonym occurs `width` times is the engine's check.
 *
 * @internal
 */
export function decodeIndexTable(
  engineId: string,
  frame: Uint8Array,
  records: number,
  width: number = 1,
): Int32Array {
  const entries = records * width;
  if (frame.byteLength !== entries * INDEX_TABLE_ENTRY_BYTES)
    throw new PartnerProtocolRefusalError(
      `${engineId} protocol error: the partner's index table is ${String(frame.byteLength)} bytes where its ${String(records)} declared records${atWidth(width)} take ${String(entries * INDEX_TABLE_ENTRY_BYTES)}`,
    );
  const indexTable = new Int32Array(entries);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  for (let position = 0; position < entries; position += 1)
    indexTable[position] = view.getInt32(
      position * INDEX_TABLE_ENTRY_BYTES,
      true,
    );
  return indexTable;
}

// A response element's protobuf field header: field 1, length-delimited, and
// the length of a compressed curve point.
const RESPONSE_ELEMENT_TAG = 0x0a;
const ELEMENT_BYTES = PSI_ENCODED_ELEMENT_BYTES - 2;
const LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;

/**
 * Refuses, as a protocol error naming `engineId`, a serialized PSI response
 * that is not a list of 33-byte elements or that holds one element twice. A
 * conforming response is such a list, every element distinct. Only the
 * framing is read: a 33-byte element that is not a valid point, one whose
 * x-coordinate is not reduced below the field prime included, passes, and
 * the library refuses it during the match.
 *
 * @internal
 */
export function assertResponseElementsDistinct(
  engineId: string,
  response: Uint8Array,
): void {
  const refusal = (what: string) =>
    new PartnerProtocolRefusalError(
      `${engineId} protocol error: the partner's response ${what}`,
    );
  if (response.byteLength % PSI_ENCODED_ELEMENT_BYTES !== 0)
    throw refusal(`is not a list of ${String(ELEMENT_BYTES)}-byte elements`);
  const count = response.byteLength / PSI_ENCODED_ELEMENT_BYTES;
  // Each element's index beside four bytes of its x-coordinate, in the high
  // half, so a native sort of the 64-bit keys puts elements whose four bytes
  // agree next to each other; only those are compared in full.
  const keys = new BigUint64Array(count);
  const words = new Uint32Array(keys.buffer);
  const high = LITTLE_ENDIAN ? 1 : 0;
  const low = 1 - high;
  try {
    for (let index = 0; index < count; index += 1) {
      const header = index * PSI_ENCODED_ELEMENT_BYTES;
      if (
        response[header] !== RESPONSE_ELEMENT_TAG ||
        response[header + 1] !== ELEMENT_BYTES
      )
        throw refusal(
          `is not a list of ${String(ELEMENT_BYTES)}-byte elements`,
        );
      const x = header + 3;
      words[2 * index + high] =
        ((response[x]! << 24) |
          (response[x + 1]! << 16) |
          (response[x + 2]! << 8) |
          response[x + 3]!) >>>
        0;
      words[2 * index + low] = index;
    }
    keys.sort();
    let groupStart = 0;
    for (let next = 1; next <= count; next += 1) {
      if (
        next < count &&
        words[2 * next + high] === words[2 * groupStart + high]
      )
        continue;
      if (next - groupStart > 1) {
        const starts = new Int32Array(next - groupStart);
        for (let member = 0; member < starts.length; member += 1)
          starts[member] =
            words[2 * (groupStart + member) + low]! *
              PSI_ENCODED_ELEMENT_BYTES +
            2;
        starts.sort((a, b) => compareElementsAt(response, a, b));
        for (let member = 1; member < starts.length; member += 1)
          if (
            compareElementsAt(
              response,
              starts[member - 1]!,
              starts[member]!,
            ) === 0
          )
            throw refusal("repeats an element");
      }
      groupStart = next;
    }
  } finally {
    words.fill(0);
  }
}

function compareElementsAt(bytes: Uint8Array, a: number, b: number): number {
  for (let offset = 0; offset < ELEMENT_BYTES; offset += 1) {
    const difference = bytes[a + offset]! - bytes[b + offset]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The receiver's replay of the one-to-one cascade in the permuted space
 * (docs/spec/PROTOCOL.md, Computing the count, and Candidate sets under
 * count-only): round by round, the round's graph is its pairs whose slot and
 * pseudonym are both still in candidacy; the round adds the size of a maximum
 * matching of that graph, and every slot and pseudonym in it leaves
 * candidacy. Where a round's pairs are disjoint every pair of the graph
 * counts. It holds which slots and pseudonyms have left candidacy and reports
 * nothing but the count.
 *
 * @internal
 */
export class PermutedCountReplay {
  #leftSlots: Uint8Array | undefined;
  #leftPseudonyms: Uint8Array | undefined;
  // The 1-based round that last paired each slot and pseudonym, to refuse a
  // round whose pairs repeat one where they cannot.
  #slotRound: Int32Array | undefined;
  #pseudonymRound: Int32Array | undefined;
  private rounds = 0;
  private counted = 0;

  constructor(
    readonly slots: number,
    readonly pseudonyms: number,
  ) {
    this.#leftSlots = new Uint8Array(slots);
    this.#leftPseudonyms = new Uint8Array(pseudonyms);
    this.#slotRound = new Int32Array(slots);
    this.#pseudonymRound = new Int32Array(pseudonyms);
  }

  /**
   * Replays one round's pairs, `slots[i]` paired with `pseudonyms[i]`. Unless
   * `pairsMayRepeat`, as in a round whose widths are both 1, a round pairing a
   * slot or a pseudonym twice is refused as an internal fault naming
   * `engineId`, before any of its pairs counts: the engine refuses a response
   * that repeats an element before matching it.
   */
  acceptRound(
    engineId: string,
    slots: ArrayLike<number>,
    pseudonyms: ArrayLike<number>,
    pairsMayRepeat = false,
  ): void {
    const leftSlots = this.#leftSlots;
    const leftPseudonyms = this.#leftPseudonyms;
    const slotRound = this.#slotRound;
    const pseudonymRound = this.#pseudonymRound;
    if (
      leftSlots === undefined ||
      leftPseudonyms === undefined ||
      slotRound === undefined ||
      pseudonymRound === undefined
    )
      throw new InternalConsistencyError(
        `${engineId}: a count-only round was replayed after its count was discarded`,
      );
    if (slots.length !== pseudonyms.length)
      throw new InternalConsistencyError(
        `${engineId}: a count-only round has ${String(slots.length)} slots for ${String(pseudonyms.length)} pseudonyms`,
      );
    const round = ++this.rounds;
    let live = 0;
    for (let pair = 0; pair < slots.length; pair += 1) {
      const slot = slots[pair]!;
      const pseudonym = pseudonyms[pair]!;
      if (
        !(Number.isInteger(slot) && slot >= 0 && slot < this.slots) ||
        !(
          Number.isInteger(pseudonym) &&
          pseudonym >= 0 &&
          pseudonym < this.pseudonyms
        )
      )
        throw new InternalConsistencyError(
          `${engineId}: a count-only round paired a slot or pseudonym outside the exchange's sets`,
        );
      if (
        !pairsMayRepeat &&
        (slotRound[slot] === round || pseudonymRound[pseudonym] === round)
      )
        throw new InternalConsistencyError(
          `${engineId}: a count-only round's matches repeat a slot or a pseudonym`,
        );
      slotRound[slot] = round;
      pseudonymRound[pseudonym] = round;
      if (leftSlots[slot] === 0 && leftPseudonyms[pseudonym] === 0) live += 1;
    }
    if (live === 0) return;
    const graphSlots = new Int32Array(live);
    const graphPseudonyms = new Int32Array(live);
    let filled = 0;
    for (let pair = 0; pair < slots.length; pair += 1) {
      const slot = slots[pair]!;
      const pseudonym = pseudonyms[pair]!;
      if (leftSlots[slot] === 1 || leftPseudonyms[pseudonym] === 1) continue;
      graphSlots[filled] = slot;
      graphPseudonyms[filled] = pseudonym;
      filled += 1;
    }
    try {
      this.counted += maximumMatchingSize(graphPseudonyms, graphSlots);
      for (let pair = 0; pair < live; pair += 1) {
        leftSlots[graphSlots[pair]!] = 1;
        leftPseudonyms[graphPseudonyms[pair]!] = 1;
      }
    } finally {
      graphSlots.fill(0);
      graphPseudonyms.fill(0);
    }
  }

  /** The count over every round replayed. */
  get count(): number {
    return this.counted;
  }

  /** Zeroes and drops what the replay holds. */
  discard(): void {
    for (const held of [
      this.#leftSlots,
      this.#leftPseudonyms,
      this.#slotRound,
      this.#pseudonymRound,
    ])
      held?.fill(0);
    this.#leftSlots = undefined;
    this.#leftPseudonyms = undefined;
    this.#slotRound = undefined;
    this.#pseudonymRound = undefined;
  }
}
