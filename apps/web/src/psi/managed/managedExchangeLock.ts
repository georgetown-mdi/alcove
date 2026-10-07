/**
 * The run+rotate single-writer lock of a managed (recurring) exchange. A module
 * of its own because both the run ({@link ./managedExchangeRun.ts}) and the
 * store's secret-touching writes ({@link ./managedExchangeStore.ts}) take it, and
 * the run imports the store. A same-profile liveness guard, auto-released with
 * its holder; a second device or profile is guarded by export semantics instead
 * (docs/notes/managed-exchange-design.md).
 */

/** Namespace prefix keeping the lock name clear of other same-origin locks. */
const MANAGED_EXCHANGE_LOCK_PREFIX = "alcove-managed-exchange:";

/** The Web Locks name for a managed record's run+rotate critical section. */
export function managedExchangeLockName(id: string): string {
  return `${MANAGED_EXCHANGE_LOCK_PREFIX}${id}`;
}

/**
 * Whether any same-origin context, this one included, holds the run+rotate lock
 * for `id`. A point-in-time reading with no change event, so a surface polls it.
 * Gate presentation on it, never a write: a write that must not cross a run takes
 * the lock itself.
 */
export async function managedExchangeRunLockHeld(id: string): Promise<boolean> {
  const name = managedExchangeLockName(id);
  const snapshot = await globalThis.navigator.locks.query();
  return snapshot.held?.some((lock) => lock.name === name) === true;
}

/**
 * Raised on the `ifAvailable` path when another same-origin context holds the
 * lock: a run, or a store write taking it for its step. The runner treats both
 * as "a run is already in progress on this device".
 */
export class ManagedExchangeLockUnavailableError extends Error {
  constructor(id: string) {
    super(`a run is already in progress for managed exchange ${id}`);
    this.name = "ManagedExchangeLockUnavailableError";
  }
}

/** How the run+rotate lock is acquired when a second context already holds it. */
export interface ManagedExchangeLockOptions {
  /** `true` fails at once with {@link ManagedExchangeLockUnavailableError} when
   * the lock is held; `false` (the default) queues behind the holder. */
  ifAvailable?: boolean;
}

/**
 * Hold the run+rotate lock for `id` until `critical` settles. Never taken with
 * `steal: true`, which would let a second context take it mid-run.
 *
 * @throws {ManagedExchangeLockUnavailableError} if `ifAvailable` is set and the
 *   lock is already held.
 */
export async function withManagedExchangeLock<T>(
  id: string,
  critical: () => Promise<T>,
  options: ManagedExchangeLockOptions = {},
): Promise<T> {
  const name = managedExchangeLockName(id);
  const request: LockOptions = { mode: "exclusive" };
  if (options.ifAvailable === true) request.ifAvailable = true;
  return globalThis.navigator.locks.request(name, request, async (lock) => {
    // Null only under `ifAvailable` when held: never run `critical` unguarded.
    if (lock === null) throw new ManagedExchangeLockUnavailableError(id);
    return critical();
  });
}
