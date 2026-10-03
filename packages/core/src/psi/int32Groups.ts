import { InternalConsistencyError } from "../errors";
import { PACED_STRETCH_RECORDS, type PaceableSteps } from "../utils/eventLoop";

// The per-record structures of a round are held in typed arrays rather than in
// a `Map` or `Set`, which V8 caps at 2^24 entries (docs/spec/PROTOCOL.md, One
// round's matched records). Every key here is a dense ordinal -- a rank, a
// slot, a position -- so an array indexed by it holds the same thing.

/**
 * An `Int32Array` grown by doubling, for a list whose length is known only once
 * it is built.
 *
 * @internal
 */
export class Int32Builder {
  private buffer: Int32Array;
  private filled = 0;

  constructor(capacity = 1024) {
    this.buffer = new Int32Array(Math.max(capacity, 16));
  }

  /** How many values the list holds. */
  get length(): number {
    return this.filled;
  }

  /** Appends `value`, which must be a 32-bit integer. */
  push(value: number): void {
    if ((value | 0) !== value)
      throw new InternalConsistencyError(
        `a round's per-record list was given ${value}, which is not a ` +
          "32-bit integer",
      );
    if (this.filled === this.buffer.length) {
      const grown = new Int32Array(this.buffer.length * 2);
      grown.set(this.buffer);
      this.buffer = grown;
    }
    this.buffer[this.filled++] = value;
  }

  /** Drops every value past the first `length`. */
  truncate(length: number): void {
    if (length < this.filled) this.filled = Math.max(0, length);
  }

  /** The values pushed, in order, as a view over the builder's buffer. */
  finish(): Int32Array {
    return this.buffer.subarray(0, this.filled);
  }
}

/**
 * Values grouped by a dense key: key `k` holds
 * `values[starts[k] .. starts[k + 1])`, ascending and distinct.
 *
 * @internal
 */
export interface Int32Groups {
  readonly starts: Int32Array;
  readonly values: Int32Array;
}

/** @internal the values key `key` of `groups` holds. */
export function groupOf(groups: Int32Groups, key: number): Int32Array {
  return groups.values.subarray(groups.starts[key], groups.starts[key + 1]);
}

// Sorts `values[from .. to)` in place, by insertion for the short runs a
// record's group mostly is.
function sortRange(values: Int32Array, from: number, to: number): void {
  if (to - from > 16) {
    values.subarray(from, to).sort();
    return;
  }
  for (let i = from + 1; i < to; ++i) {
    const value = values[i];
    let j = i - 1;
    while (j >= from && values[j] > value) {
      values[j + 1] = values[j];
      --j;
    }
    values[j + 1] = value;
  }
}

/**
 * The pairs `(keys[i], values[i])` grouped by key, each key's values ascending
 * with repeats dropped: a `Map` from key to `Set` of values, for keys running
 * `0 .. keyCount - 1`.
 *
 * @internal
 */
export function* groupDistinctByKey(
  keys: ArrayLike<number>,
  values: ArrayLike<number>,
  keyCount: number,
): PaceableSteps<Int32Groups> {
  if (keys.length !== values.length)
    throw new InternalConsistencyError(
      `a round's per-record grouping was given ${keys.length} key(s) for ` +
        `${values.length} value(s)`,
    );
  const count = keys.length;
  const bounds = new Int32Array(keyCount + 1);
  for (let i = 0; i < count; ++i) {
    const key = keys[i];
    if (!Number.isInteger(key) || key < 0 || key >= keyCount)
      throw new InternalConsistencyError(
        `a round's per-record grouping was given key ${key} outside ` +
          `0 .. ${keyCount - 1}`,
      );
    ++bounds[key + 1];
  }
  for (let k = 0; k < keyCount; ++k) bounds[k + 1] += bounds[k];
  const cursor = bounds.slice(0, keyCount);
  const grouped = new Int32Array(count);
  for (let i = 0; i < count; ++i) {
    if ((i + 1) % PACED_STRETCH_RECORDS === 0) yield;
    const value = values[i];
    if ((value | 0) !== value)
      throw new InternalConsistencyError(
        `a round's per-record grouping was given ${value}, which is not a ` +
          "32-bit integer",
      );
    grouped[cursor[keys[i]]++] = value;
  }
  const starts = new Int32Array(keyCount + 1);
  let filled = 0;
  for (let k = 0; k < keyCount; ++k) {
    if ((k + 1) % PACED_STRETCH_RECORDS === 0) yield;
    const from = bounds[k];
    const to = bounds[k + 1];
    sortRange(grouped, from, to);
    for (let i = from; i < to; ++i) {
      const value = grouped[i];
      if (i === from || value !== grouped[filled - 1])
        grouped[filled++] = value;
    }
    starts[k + 1] = filled;
  }
  return { starts, values: grouped.subarray(0, filled) };
}

/**
 * `values` ascending with repeats dropped, each a 32-bit integer.
 *
 * @internal
 */
export function sortedDistinctInt32(values: ArrayLike<number>): Int32Array {
  const sorted = new Int32Array(values.length);
  for (let i = 0; i < values.length; ++i) {
    const value = values[i];
    if ((value | 0) !== value)
      throw new InternalConsistencyError(
        `a round's per-record list was given ${value}, which is not a ` +
          "32-bit integer",
      );
    sorted[i] = value;
  }
  sorted.sort();
  let filled = 0;
  for (let i = 0; i < sorted.length; ++i)
    if (i === 0 || sorted[i] !== sorted[filled - 1])
      sorted[filled++] = sorted[i];
  return sorted.subarray(0, filled);
}

/**
 * `values` ascending with repeats dropped. Row indices on the partner's side
 * reach past 2^31, so these are held as doubles.
 *
 * @internal
 */
export function sortedDistinct(values: ArrayLike<number>): Float64Array {
  const sorted = Float64Array.from(values).sort();
  let filled = 0;
  for (let i = 0; i < sorted.length; ++i)
    if (i === 0 || sorted[i] !== sorted[filled - 1])
      sorted[filled++] = sorted[i];
  return sorted.subarray(0, filled);
}

/**
 * The index of `value` in `sorted[from .. to)`, which ascends, or -1 where it
 * is absent.
 *
 * @internal
 */
export function indexInSorted(
  sorted: ArrayLike<number>,
  value: number,
  from = 0,
  to = sorted.length,
): number {
  let low = from;
  let high = to;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low < to && sorted[low] === value ? low : -1;
}
