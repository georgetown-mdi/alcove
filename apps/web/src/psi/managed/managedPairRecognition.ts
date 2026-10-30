/**
 * Where a command-line `alcove.yaml` and `.alcove.key` land among the stored
 * records when no stored record holds their secret, decided without the store
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Importing the key file beside a
 * configuration"). The store makes the decision here inside its own
 * transaction, on the records it read there.
 *
 * A pair holds no record id, so after the secret the one thing naming its
 * stored record is the agreed terms and `side` ({@link findRecordsByTermsAndSide}).
 * Two exchanges can share both, so a record found that way is offered to the
 * operator and the pair lands in it only on their word.
 */

import { findRecordsByTermsAndSide } from "./managedLiveCopyMatch";
import { runnableManagedExchange } from "./managedExchangeRecord";

import type { ManagedCopyOrder } from "./managedCopyOrder";
import type { ManagedExchangeRecord } from "./managedExchangeRecord";

/** What a stored record an import may land in holds: a configuration only, or
 * a secret of its own. */
export type ManagedStoredCopyState = "configuration-only" | "runs-here";

/** A stored record an import names for the operator to take the import into,
 * with its label (empty when the operator named nothing). */
export interface ManagedStoredCopy {
  id: string;
  label: string;
  state: ManagedStoredCopyState;
  /** Which copy is newer, where the two rotation histories decide it
   * ({@link ./managedCopyOrder.ts}); absent where they do not. */
  order?: ManagedCopyOrder;
}

/** What a pair import asks of the reconciliation beyond the pair itself: the
 * operator's answer to a {@link ManagedStoredCopy} named to them. */
export interface ManagedPairImportOptions {
  /** The stored record the operator chose to take the pair into. */
  into?: string;
  /** The stored records the operator chose to install the pair beside. */
  besideIds?: ReadonlyArray<string>;
}

/**
 * Where a pair lands, once no stored record holds its secret:
 *
 * - `"complete"` -- lay the pair over the configuration-only record the
 *   operator chose.
 * - `"replace"` -- replace the runnable record the operator chose, over the
 *   `sharedSecret` it holds here, a write the store makes under that record's
 *   run lock, outside this decision.
 * - `"stored-copy"` -- `copies` may be its exchange; nothing lands until the
 *   operator answers.
 * - `"chosen-copy-changed"` -- the record the operator chose can no longer
 *   take the pair: it was deleted or changed since they chose.
 * - `"no-match"` -- the pair installs as a new record.
 */
export type ManagedPairTarget =
  | { kind: "complete"; into: ManagedExchangeRecord }
  | { kind: "replace"; id: string; sharedSecret: string }
  | { kind: "stored-copy"; copies: ReadonlyArray<ManagedStoredCopy> }
  | { kind: "chosen-copy-changed" }
  | { kind: "no-match" };

/** Which {@link ManagedStoredCopyState} `record` is in. */
function storedCopyState(
  record: ManagedExchangeRecord,
): ManagedStoredCopyState {
  return runnableManagedExchange(record) ? "runs-here" : "configuration-only";
}

/** `record` as an import's question names it. */
export function managedStoredCopy(
  record: ManagedExchangeRecord,
): ManagedStoredCopy {
  return {
    id: record.id,
    label: record.label,
    state: storedCopyState(record),
  };
}

/**
 * Decide where `imported` lands among `records`, the stored records none of
 * which holds its secret, in store order. `options.into` lands the pair in the
 * record the operator chose, provided it still has the pair's agreed terms and
 * side, and without it every such record not in `options.besideIds` is named.
 */
export function decideCommandLinePairTarget(
  records: Iterable<ManagedExchangeRecord>,
  imported: ManagedExchangeRecord,
  options: ManagedPairImportOptions = {},
): ManagedPairTarget {
  if (options.into !== undefined) {
    const chosen = findRecordsByTermsAndSide(records, imported).find(
      ({ id }) => id === options.into,
    );
    if (chosen === undefined) return { kind: "chosen-copy-changed" };
    return runnableManagedExchange(chosen)
      ? { kind: "replace", id: chosen.id, sharedSecret: chosen.sharedSecret }
      : { kind: "complete", into: chosen };
  }
  const copies = findRecordsByTermsAndSide(
    records,
    imported,
    options.besideIds,
  );
  if (copies.length === 0) return { kind: "no-match" };
  return {
    kind: "stored-copy",
    copies: copies.map(managedStoredCopy),
  };
}
