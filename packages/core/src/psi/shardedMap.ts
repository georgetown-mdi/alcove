/**
 * The most entries one shard of a {@link ShardedMap} holds: a V8 `Map` holds
 * at most 2^24 (docs/spec/FILE_SYNC.md, Round set size limits), which the
 * stress tier checks against the running engine.
 *
 * @internal
 */
export const MAX_MAP_SHARD_ENTRIES = 2 ** 24;

/**
 * A `Map` that holds more entries than one V8 `Map` can, split into shards
 * filled one after another. A new key always goes into the last shard, so
 * visiting the shards in turn visits the entries in insertion order, as a
 * `Map` does. A lookup probes the shards in turn, one probe while the whole
 * map fits one shard. A value is never `undefined`, which a lookup reads as
 * absent. Entries are never deleted, which is what keeps every shard but the
 * last full.
 *
 * @internal
 */
export class ShardedMap<K, V extends NonNullable<unknown>> {
  private readonly shards: Array<Map<K, V>> = [new Map()];
  private readonly shardEntries: number;

  /** `shardEntries` is lowered only by tests. */
  constructor(shardEntries: number = MAX_MAP_SHARD_ENTRIES) {
    this.shardEntries = shardEntries;
  }

  /** The number of entries across every shard. */
  get size(): number {
    const last = this.shards.length - 1;
    return last * this.shardEntries + this.shards[last].size;
  }

  /**
   * The value already held against `key`; where there is none, holds `value`
   * against it in the last shard, opening a new one when the last is full,
   * and returns `undefined`. One probe of each shard either way.
   */
  setIfAbsent(key: K, value: V): V | undefined {
    for (const shard of this.shards) {
      const held = shard.get(key);
      if (held !== undefined) return held;
    }
    let tail = this.shards[this.shards.length - 1];
    if (tail.size === this.shardEntries) {
      tail = new Map();
      this.shards.push(tail);
    }
    tail.set(key, value);
    return undefined;
  }

  /**
   * Holds `value` against `key`: in the shard already holding the key, else
   * in the last shard, opening a new one when the last is full.
   */
  set(key: K, value: V): void {
    const last = this.shards.length - 1;
    for (let s = 0; s < last; ++s) {
      const shard = this.shards[s];
      if (shard.has(key)) {
        shard.set(key, value);
        return;
      }
    }
    let tail = this.shards[last];
    if (tail.size === this.shardEntries && !tail.has(key)) {
      tail = new Map();
      this.shards.push(tail);
    }
    tail.set(key, value);
  }

  /** Calls `visit` on every entry, in insertion order. */
  forEach(visit: (value: V, key: K) => void): void {
    for (const shard of this.shards) shard.forEach(visit);
  }
}
