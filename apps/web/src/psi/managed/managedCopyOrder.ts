/**
 * Which of two copies of one exchange is newer, where the rotation histories
 * decide it (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Replacing a saved copy"):
 * a copy whose history holds the verifier of the other's secret retired that
 * secret, so it is the newer. The import's replace question states the order
 * found and still leaves the choice to the operator.
 */

import { deriveHistoryVerifier } from "@alcove/core";

import { getManagedExchange } from "./managedExchangeStore";
import { runnableManagedExchange } from "./managedExchangeRecord";

import type { ManagedExchangeRecord } from "./managedExchangeRecord";
import type { ManagedStoredCopy } from "./managedPairRecognition";

/** How an imported copy stands against a stored one. */
export type ManagedCopyOrder = "import-newer" | "import-older";

/** The fields of a copy the order is read from. */
type OrderedCopy = Pick<
  ManagedExchangeRecord,
  "sharedSecret" | "rotationHistory"
>;

/**
 * The order of `imported` against `stored`, or `undefined` where neither
 * history holds the other's secret, where both do, or where either holds no
 * secret.
 */
export async function managedCopyOrder(
  stored: OrderedCopy,
  imported: OrderedCopy,
): Promise<ManagedCopyOrder | undefined> {
  if (stored.sharedSecret === undefined || imported.sharedSecret === undefined)
    return undefined;
  const [storedVerifier, importedVerifier] = await Promise.all([
    deriveHistoryVerifier(stored.sharedSecret),
    deriveHistoryVerifier(imported.sharedSecret),
  ]);
  const storedRetiredImported = holdsVerifier(stored, importedVerifier);
  const importRetiredStored = holdsVerifier(imported, storedVerifier);
  if (storedRetiredImported === importRetiredStored) return undefined;
  return importRetiredStored ? "import-newer" : "import-older";
}

function holdsVerifier(copy: OrderedCopy, verifier: string): boolean {
  return (copy.rotationHistory ?? []).some(
    (entry) => entry.verifier === verifier,
  );
}

/**
 * `copies` with each runnable one's {@link ManagedStoredCopy.order} against
 * `imported`, read from the record `read` returns for its `id`. A copy whose
 * record is gone, unreadable, holds no secret, or orders nothing is returned
 * as it was: the order only adds to the question. The replace the operator
 * chooses re-checks the record it writes, so a record changed since is
 * refused there.
 */
export async function orderManagedStoredCopies(
  copies: ReadonlyArray<ManagedStoredCopy>,
  imported: ManagedExchangeRecord,
  read: (
    id: string,
  ) => Promise<ManagedExchangeRecord | undefined> = getManagedExchange,
): Promise<Array<ManagedStoredCopy>> {
  return Promise.all(
    copies.map(async (copy) => {
      if (copy.state !== "runs-here") return copy;
      let stored: ManagedExchangeRecord | undefined;
      try {
        stored = await read(copy.id);
      } catch {
        return copy;
      }
      if (stored === undefined || !runnableManagedExchange(stored)) return copy;
      const order = await managedCopyOrder(stored, imported);
      return order === undefined ? copy : { ...copy, order };
    }),
  );
}
