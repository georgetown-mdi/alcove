import { MAX_MAP_SHARD_ENTRIES, ShardedMap } from "../psi/shardedMap";

/**
 * How many values a per-record collection holds before it indexes them: below
 * it, a lookup compares the values one by one.
 *
 * @internal
 */
export const SCAN_UP_TO_VALUES = 16;

/**
 * The 30-bit FNV-1a hash of `value`'s UTF-16 code units: a small integer in
 * every V8 build, so a `Map` keyed by it allocates nothing per key.
 *
 * @internal
 */
export function valueHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++)
    hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193);
  return (hash ^ (hash >>> 15)) & 0x3fffffff;
}

/**
 * Distinct strings in first-seen order, each found by its position, with no
 * `Map` or `Set` lookup on the string itself. V8 adds any string a `Map` or
 * `Set` is asked about to its string table, whose lookups slow about fiftyfold
 * once it holds about 2^24 strings of 9 digits (docs/spec/FILE_SYNC.md, The
 * practical input bound); a cleaned SSN per record reaches that. Values are
 * indexed by {@link valueHash} and compared in full on a hit, so two values
 * are one entry exactly where `===` equates them; a value whose hash another
 * holds goes to a string-keyed map of its own.
 *
 * The first `scanUpTo` values are compared one by one rather than indexed, for
 * the per-record collections that rarely hold more than one. Tests lower
 * `shardEntries` and `scanUpTo`.
 *
 * @internal
 */
export class DistinctValues {
  /** The values, in the order first added; a value's position is its index. */
  readonly values: string[] = [];
  private readonly shardEntries: number;
  private readonly scanUpTo: number;
  private byHash: ShardedMap<number, number> | undefined;
  private collided: ShardedMap<string, number> | undefined;

  constructor({
    shardEntries = MAX_MAP_SHARD_ENTRIES,
    scanUpTo = 0,
  }: { shardEntries?: number; scanUpTo?: number } = {}) {
    this.shardEntries = shardEntries;
    this.scanUpTo = scanUpTo;
    if (scanUpTo === 0) this.byHash = new ShardedMap(shardEntries);
  }

  /** The number of distinct values held. */
  get size(): number {
    return this.values.length;
  }

  /** The position of `value`, or -1 where it is not held. */
  indexOf(value: string): number {
    if (this.byHash === undefined) return this.values.indexOf(value);
    return this.lookUp(value, valueHash(value));
  }

  /**
   * The position of `value`, which is added at the end where it is not held:
   * a value is new exactly where its position is the size before the call.
   */
  add(value: string): number {
    const byHash = this.byHash;
    if (byHash === undefined) {
      const held = this.values.indexOf(value);
      if (held !== -1) return held;
      this.values.push(value);
      if (this.values.length >= this.scanUpTo) this.indexAll();
      return this.values.length - 1;
    }
    const hash = valueHash(value);
    const position = this.values.length;
    const held = byHash.setIfAbsent(hash, position);
    if (held === undefined) {
      this.values.push(value);
      return position;
    }
    if (this.values[held] === value) return held;
    this.collided ??= new ShardedMap(this.shardEntries);
    const heldCollided = this.collided.setIfAbsent(value, position);
    if (heldCollided !== undefined) return heldCollided;
    this.values.push(value);
    return position;
  }

  private lookUp(value: string, hash: number): number {
    const held = this.byHash?.get(hash);
    if (held === undefined) return -1;
    if (this.values[held] === value) return held;
    return this.collided?.get(value) ?? -1;
  }

  private indexAll(): void {
    const byHash = new ShardedMap<number, number>(this.shardEntries);
    this.values.forEach((value, position) => {
      if (byHash.setIfAbsent(valueHash(value), position) === undefined) return;
      this.collided ??= new ShardedMap(this.shardEntries);
      this.collided.set(value, position);
    });
    this.byHash = byHash;
  }
}
