/** Admits the first report under a key in each window and refuses the rest. */
export interface FaultLatch {
  /** Whether a report under `key` may be written now: true at most once a
   * window for one key. */
  admit(key: string): boolean;
}

/**
 * A latch whose window is `windowMs`, measured on `now` in milliseconds. It
 * holds only the keys admitted within the last window, so its size is the
 * number of keys reported in one window.
 */
export function createFaultLatch(
  windowMs: number,
  now: () => number = () => performance.now(),
): FaultLatch {
  const admittedAt = new Map<string, number>();
  return {
    admit(key) {
      const at = now();
      // Keys are added in time order, so the expired ones lead the map.
      for (const [admitted, time] of admittedAt) {
        if (at - time < windowMs) break;
        admittedAt.delete(admitted);
      }
      if (admittedAt.has(key)) return false;
      admittedAt.set(key, at);
      return true;
    },
  };
}
