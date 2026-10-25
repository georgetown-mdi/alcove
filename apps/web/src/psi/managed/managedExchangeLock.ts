/**
 * The run+rotate single-writer lock of a managed (recurring) exchange. A module
 * of its own because the run ({@link ./managedExchangeRun.ts}), the re-invite
 * ({@link ./managedReinviteDriver.ts}), relay enrollment and its stop
 * ({@link ./managedRelayRegistration.ts}) and the store's import replace
 * ({@link ./managedExchangeStore.ts}) take it, and the run imports the store.
 * Every other write to the record runs unlocked. A same-profile liveness
 * guard, auto-released with its holder; a second device or profile is guarded
 * by export semantics instead (docs/notes/managed-exchange-design.md).
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
 * lock: a run, or a re-invite, relay enrollment or import replace taking it for
 * its step. The runner treats each as "a run is already in progress on this
 * device".
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

/**
 * Wait for a turn at the run+rotate lock for `id`, queued behind every request
 * made before this one, and release it at once. Web Locks grants an exclusive
 * lock's queued requests in the order they were made, and refuses an
 * `ifAvailable` request while any is queued, so an operation queued ahead of
 * this call has run when it resolves.
 */
export async function awaitManagedExchangeLockTurn(id: string): Promise<void> {
  await withManagedExchangeLock(id, () => Promise.resolve());
}
