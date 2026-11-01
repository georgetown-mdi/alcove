// A brute-force reference for the one-to-one resolution, written from its
// definition (docs/spec/PROTOCOL.md, Record-level resolution: canonical order
// and tiebreak) rather than from the shipped search: the largest pairing's
// size by trying every way to pair each sender, and the first largest pairing
// by keeping each pair in canonical order when the pairs kept with it still
// leave room for a pairing of that size. Exponential in the senders, so for
// small rounds only.

/** A candidate pair, `[sender, receiver]`. */
export type Pair = readonly [number, number];

/** The distinct pairs in ascending (sender, receiver). */
export function canonicalOrder(pairs: ReadonlyArray<Pair>): Array<Pair> {
  const seen = new Set<string>();
  return [...pairs]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .filter(([s, r]) => {
      const key = `${s},${r}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** The most pairs any pairing of `pairs` holds. */
export function largestPairingSize(pairs: ReadonlyArray<Pair>): number {
  const bySender = new Map<number, Array<number>>();
  for (const [s, r] of pairs) {
    const receivers = bySender.get(s) ?? [];
    receivers.push(r);
    bySender.set(s, receivers);
  }
  const senders = [...bySender.values()];
  const used = new Set<number>();
  const best = (i: number): number => {
    if (i === senders.length) return 0;
    let most = best(i + 1);
    for (const r of senders[i]) {
      if (used.has(r)) continue;
      used.add(r);
      most = Math.max(most, 1 + best(i + 1));
      used.delete(r);
    }
    return most;
  };
  return best(0);
}

/** The first largest pairing of `pairs` in ascending (sender, receiver). */
export function firstLargestPairing(pairs: ReadonlyArray<Pair>): Array<Pair> {
  const ordered = canonicalOrder(pairs);
  const target = largestPairingSize(ordered);
  const kept: Array<Pair> = [];
  for (const pair of ordered) {
    const candidate = [...kept, pair];
    const senders = new Set(candidate.map(([s]) => s));
    const receivers = new Set(candidate.map(([, r]) => r));
    if (senders.size !== candidate.length) continue;
    if (receivers.size !== candidate.length) continue;
    const rest = ordered.filter(
      ([s, r]) => !senders.has(s) && !receivers.has(r),
    );
    if (candidate.length + largestPairingSize(rest) === target) kept.push(pair);
  }
  return kept;
}

/** Whether `chosen` is a pairing of `pairs`: drawn from them, no record twice. */
export function isPairingOf(
  chosen: ReadonlyArray<Pair>,
  pairs: ReadonlyArray<Pair>,
): boolean {
  const candidates = new Set(pairs.map(([s, r]) => `${s},${r}`));
  const senders = new Set(chosen.map(([s]) => s));
  const receivers = new Set(chosen.map(([, r]) => r));
  return (
    chosen.every(([s, r]) => candidates.has(`${s},${r}`)) &&
    senders.size === chosen.length &&
    receivers.size === chosen.length
  );
}
