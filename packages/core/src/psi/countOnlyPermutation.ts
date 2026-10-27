import {
  InternalConsistencyError,
  PartnerProtocolRefusalError,
} from "../errors";

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
  if (!Number.isSafeInteger(size) || size < 0 || size > 2 ** 31 - 1)
    throw new InternalConsistencyError(
      `a permutation cannot have ${String(size)} positions`,
    );
  const order = new Int32Array(size);
  for (let index = 0; index < size; index += 1) order[index] = index;
  const words = new Uint32Array(RANDOM_WORDS_PER_DRAW);
  let next = words.length;
  const randomWord = (): number => {
    if (next === words.length) {
      crypto.getRandomValues(words);
      next = 0;
    }
    return words[next++]!;
  };
  for (let last = size - 1; last > 0; last -= 1) {
    const choices = last + 1;
    const limit = UINT32_RANGE - (UINT32_RANGE % choices);
    let word = randomWord();
    while (word >= limit) word = randomWord();
    const pick = word % choices;
    const held = order[last]!;
    order[last] = order[pick]!;
    order[pick] = held;
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
 * Refuses an index table that is not a permutation of `0` to its length minus
 * one, as a protocol error naming `engineId`.
 *
 * @internal
 */
export function assertIndexTableIsPermutation(
  engineId: string,
  indexTable: Int32Array,
): void {
  const seen = new Uint8Array(indexTable.length);
  for (const entry of indexTable) {
    if (entry < 0 || entry >= indexTable.length || seen[entry] === 1)
      throw new PartnerProtocolRefusalError(
        `${engineId} protocol error: the partner's index table is not a permutation of its ${String(indexTable.length)} positions`,
      );
    seen[entry] = 1;
  }
}

/**
 * The receiver's replay of the one-to-one cascade in the permuted space
 * (docs/spec/PROTOCOL.md, Computing the count): round by round, a pair is
 * accepted where neither its slot nor its pseudonym is accepted yet. It holds
 * which slots and pseudonyms are accepted and reports nothing but the count.
 *
 * @internal
 */
export class PermutedCountReplay {
  #acceptedSlots: Uint8Array | undefined;
  #acceptedPseudonyms: Uint8Array | undefined;
  // The 1-based round that last paired each slot and pseudonym, to refuse a
  // round whose pairs repeat one.
  #slotRound: Int32Array | undefined;
  #pseudonymRound: Int32Array | undefined;
  private rounds = 0;
  private accepted = 0;

  constructor(
    readonly slots: number,
    readonly pseudonyms: number,
  ) {
    this.#acceptedSlots = new Uint8Array(slots);
    this.#acceptedPseudonyms = new Uint8Array(pseudonyms);
    this.#slotRound = new Int32Array(slots);
    this.#pseudonymRound = new Int32Array(pseudonyms);
  }

  /**
   * Replays one round's pairs, `slots[i]` paired with `pseudonyms[i]`. A round
   * pairing a slot or a pseudonym twice is refused as a protocol error naming
   * `engineId`, before any of its pairs is accepted.
   */
  acceptRound(
    engineId: string,
    slots: ArrayLike<number>,
    pseudonyms: ArrayLike<number>,
  ): void {
    const acceptedSlots = this.#acceptedSlots;
    const acceptedPseudonyms = this.#acceptedPseudonyms;
    const slotRound = this.#slotRound;
    const pseudonymRound = this.#pseudonymRound;
    if (
      acceptedSlots === undefined ||
      acceptedPseudonyms === undefined ||
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
    for (let pair = 0; pair < slots.length; pair += 1) {
      const slot = slots[pair]!;
      const pseudonym = pseudonyms[pair]!;
      if (
        !(slot >= 0 && slot < this.slots) ||
        !(pseudonym >= 0 && pseudonym < this.pseudonyms)
      )
        throw new InternalConsistencyError(
          `${engineId}: a count-only round paired a slot or pseudonym outside the exchange's sets`,
        );
      if (slotRound[slot] === round || pseudonymRound[pseudonym] === round)
        throw new PartnerProtocolRefusalError(
          `${engineId} protocol error: the partner's response repeats an element, so a round's matches repeat a slot or a pseudonym`,
        );
      slotRound[slot] = round;
      pseudonymRound[pseudonym] = round;
    }
    for (let pair = 0; pair < slots.length; pair += 1) {
      const slot = slots[pair]!;
      const pseudonym = pseudonyms[pair]!;
      if (acceptedSlots[slot] === 1 || acceptedPseudonyms[pseudonym] === 1)
        continue;
      acceptedSlots[slot] = 1;
      acceptedPseudonyms[pseudonym] = 1;
      this.accepted += 1;
    }
  }

  /** The number of pairs accepted over every round replayed. */
  get count(): number {
    return this.accepted;
  }

  /** Zeroes and drops what the replay holds. */
  discard(): void {
    for (const held of [
      this.#acceptedSlots,
      this.#acceptedPseudonyms,
      this.#slotRound,
      this.#pseudonymRound,
    ])
      held?.fill(0);
    this.#acceptedSlots = undefined;
    this.#acceptedPseudonyms = undefined;
    this.#slotRound = undefined;
    this.#pseudonymRound = undefined;
  }
}
