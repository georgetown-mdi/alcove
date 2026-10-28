// Fixtures and the reference replay for the count-only construction over
// every agreed key (docs/spec/PROTOCOL.md, PSI-C: The count-only rounds,
// Computing the count).

/**
 * One record per row, one value per key in the agreed key order; "" is no
 * value for the key.
 */
export type Records = ReadonlyArray<ReadonlyArray<string>>;

/** `count` two-key records whose values no other fixture holds. */
export function filler(prefix: string, count: number): Array<Array<string>> {
  return Array.from({ length: count }, (_, index) => [
    `${prefix}-a-${String(index)}`,
    `${prefix}-b-${String(index)}`,
  ]);
}

// The two-key replay fixture of psiEngineCountOnlyPermuted.test.ts: receiver 0
// matches sender 0 on both keys, receiver 1 sender 1 on the first, and
// receiver 2 sender 1 on the second, a cross-key conflict the replay does not
// accept; receiver 3 and 5 share a first-key value, so both send a dummy.

/** The replay fixture's sender. */
export const SENDER: Records = [
  ["111", "ann"],
  ["222", "bob"],
  ["333", "cat"],
  ["444", "dan"],
  ...filler("s", 44),
];

/** The replay fixture's receiver. */
export const RECEIVER: Records = [
  ["111", "ann"],
  ["222", "zed"],
  ["999", "bob"],
  ["555", ""],
  ["", "fay"],
  ["555", "gus"],
  ...filler("r", 58),
];

/** The count over {@link SENDER} and {@link RECEIVER}. */
export const FIXTURE_COUNT = 2;

/**
 * The count as PROTOCOL.md, Computing the count, states it, written over
 * records rather than slots: each round pairs the records holding a value no
 * other record of their party holds, and the replay accepts a pair whose two
 * records are both still free.
 */
export function referenceCount(sender: Records, receiver: Records): number {
  const uniqueHolders = (records: Records, key: number) => {
    const holders = new Map<string, Array<number>>();
    records.forEach((record, index) => {
      const value = record[key]!;
      if (value !== "")
        holders.set(value, [...(holders.get(value) ?? []), index]);
    });
    return new Map(
      [...holders]
        .filter(([, rows]) => rows.length === 1)
        .map(([v, [row]]) => [v, row!]),
    );
  };
  const acceptedSender = new Set<number>();
  const acceptedReceiver = new Set<number>();
  for (let key = 0; key < sender[0]!.length; key += 1) {
    const senderHolders = uniqueHolders(sender, key);
    for (const [value, receiverRow] of uniqueHolders(receiver, key)) {
      const senderRow = senderHolders.get(value);
      if (
        senderRow === undefined ||
        acceptedSender.has(senderRow) ||
        acceptedReceiver.has(receiverRow)
      )
        continue;
      acceptedSender.add(senderRow);
      acceptedReceiver.add(receiverRow);
    }
  }
  return acceptedSender.size;
}

/** A linear congruential draw from `seed`, each call below `range`. */
export function seededDraw(seed: number): (range: number) => number {
  let state = seed;
  return (range) => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return (state >>> 8) % range;
  };
}

/**
 * Three keys over small value ranges, with gaps, repeats and cross-key
 * conflicts, from a fixed seed.
 */
export function randomRecords(seed: number, count: number): Records {
  const next = seededDraw(seed);
  return Array.from({ length: count }, () =>
    [0, 1, 2].map((key) =>
      next(5) === 0 ? "" : `k${String(key)}v${String(next(30))}`,
    ),
  );
}

/** Each key's values over `records`, one round's input per key. */
export function roundsOf(records: Records): Array<Array<string | undefined>> {
  return records[0]!.map((_, key) =>
    records.map((record) => (record[key] === "" ? undefined : record[key])),
  );
}
