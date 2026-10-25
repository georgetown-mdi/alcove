/**
 * Standing up the spent state an earlier version's export wrote, for the browser
 * suites that drive what still reads it: the hand-off gate, the run's refusal, the
 * import refusals and revives, and the saved-exchange rows. No current path writes
 * the state, so the suites write the sibling entry directly.
 */

import {
  MANAGED_EXCHANGE_LOCAL_STORE_NAME,
  openManagedExchangeDatabase,
} from "@psi/managed/managedExchangeStore";
import { parseManagedLocalState } from "@psi/managed/managedLocalStateShape";

import type { ManagedSpentHandoff } from "@psi/managed/managedLocalStateShape";

/** Mark the record under `id` spent as of `spentAt` -- under `handoff`, or as the
 * device migration when it is omitted -- keeping every other marker its sibling
 * entry holds, validated as the store's own writes are. */
export async function seedSpentState(
  id: string,
  spentAt: string,
  handoff?: ManagedSpentHandoff,
): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_LOCAL_STORE_NAME,
        "readwrite",
      );
      const store = transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME);
      let failure: unknown;
      const read = store.get(id);
      read.onsuccess = () => {
        try {
          const current =
            read.result === undefined
              ? undefined
              : parseManagedLocalState(read.result);
          store.put(
            parseManagedLocalState({
              ...current,
              spent: { spentAt, ...(handoff !== undefined ? { handoff } : {}) },
            }),
            id,
          );
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(failure ?? transaction.error);
      transaction.onabort = () => reject(failure ?? transaction.error);
    });
  } finally {
    db.close();
  }
}
