/**
 * The local sibling state a managed exchange holds beside its record: the backup
 * marker (when a backup was last taken), the import marker (when this device last
 * installed or replaced it from imported files), and the terms proposal. None is a
 * record field and none is in the export artifact:
 *
 * - The backup marker is derived-currency input the record must not hold -- a
 *   secret-derived or record-embedded "when I last backed up" would either force a
 *   new record `schemaVersion` (an older build drops a member it does not name)
 *   or leak into the artifact;
 *   keeping it a sibling makes its non-inclusion structural (see
 *   {@link ./managedBackupState.ts}).
 * - The import marker is this device's own restore history, meaningless to an
 *   imported copy.
 * - The terms proposal is a partner terms change an unattended run refused,
 *   pending the operator's decision on this device ({@link ./managedTermsProposal.ts}).
 *
 * This is the thin IndexedDB layer over the sibling store the records database also
 * holds ({@link MANAGED_EXCHANGE_LOCAL_STORE_NAME}); the state's shape and its
 * reader-rejects-unknown validation are the pure {@link ./managedLocalStateShape.ts}
 * (shared with the record store's rotation write, which clears the backup marker in
 * the same cross-store transaction), and the pure backup-state derivation is in
 * {@link ./managedBackupState.ts}. Every read validates through
 * {@link parseManagedLocalStateOfKey} and every write through
 * {@link storableManagedLocalState}, so a corrupted sibling entry rejects loudly
 * rather than loading, the same discipline the record store follows; the
 * unattended wake's read reports such an entry by key instead
 * ({@link listReadableManagedLocalState}). An entry at a format version this
 * build does not read is read as absent.
 */

import {
  MANAGED_EXCHANGE_LOCAL_STORE_NAME,
  runTransaction,
} from "./managedExchangeStore";
import {
  managedTermsProposalSchema,
  parseManagedLocalStateEntries,
  parseManagedLocalStateOfKey,
  partitionReadableManagedLocalState,
  storableManagedLocalState,
} from "./managedLocalStateShape";

import type {
  ManagedLocalState,
  ManagedReadableLocalState,
  ManagedTermsProposal,
} from "./managedLocalStateShape";

export type {
  ManagedImportMarker,
  ManagedLocalState,
  ManagedReadableLocalState,
  ManagedTermsProposal,
} from "./managedLocalStateShape";

/** Read every key and value of the local-state store in one readonly
 * transaction, as parallel arrays. */
function readLocalEntries(): Promise<{
  keys: Array<IDBValidKey>;
  values: Array<unknown>;
}> {
  return runTransaction(
    MANAGED_EXCHANGE_LOCAL_STORE_NAME,
    "readonly",
    ({ store }) => {
      const local = store(MANAGED_EXCHANGE_LOCAL_STORE_NAME);
      const keys = local.getAllKeys();
      const values = local.getAll();
      return () => ({ keys: keys.result, values: values.result });
    },
  );
}

/**
 * Read the local sibling state for a record, or `undefined` when none exists or
 * the entry is at a format version this build does not read. The stored value
 * is re-validated through {@link parseManagedLocalStateOfKey}, so a corrupted sibling
 * entry rejects rather than loading.
 *
 * @throws {ZodError} if the stored value is not valid local state.
 */
export async function getManagedLocalState(
  id: string,
): Promise<ManagedLocalState | undefined> {
  const raw = await runTransaction(
    MANAGED_EXCHANGE_LOCAL_STORE_NAME,
    "readonly",
    ({ store }) => {
      const read = store(MANAGED_EXCHANGE_LOCAL_STORE_NAME).get(id);
      return (): unknown => read.result;
    },
  );
  return parseManagedLocalStateOfKey(raw, id);
}

/**
 * Read every record id's local sibling state, as a map from id to state. Used by the
 * list to derive one backup state per exchange in a single sibling-store read rather
 * than one read per row. Each stored value is re-validated; a single invalid entry
 * rejects the whole read, and one at a format version this build does not read is
 * left out.
 *
 * @throws {ZodError} if any stored value is not valid local state.
 */
export async function listManagedLocalState(): Promise<
  Map<string, ManagedLocalState>
> {
  const { keys, values } = await readLocalEntries();
  return parseManagedLocalStateEntries(keys, values);
}

/**
 * Read every record id's local sibling state one entry at a time: the entries
 * that parse, and the keys of those that do not. The unattended wake's read, so
 * one entry this build cannot parse costs its own exchange's scheduled runs
 * rather than every exchange's (see {@link partitionReadableManagedLocalState});
 * the attended list keeps the strict {@link listManagedLocalState}.
 */
export async function listReadableManagedLocalState(): Promise<ManagedReadableLocalState> {
  const { keys, values } = await readLocalEntries();
  return partitionReadableManagedLocalState(keys, values);
}

/** Read the sibling state under `id`, apply `transform` to it (undefined when none
 * exists), and write the result back inside ONE readwrite transaction, so no other
 * write lands between the read and the write-back. A `null` result deletes the
 * entry (a fully-cleared state leaves nothing behind). `transform` is synchronous
 * (Zod validation is), so the transaction does not auto-commit before the write. */
async function readModifyWriteLocalState(
  id: string,
  transform: (
    current: ManagedLocalState | undefined,
  ) => ManagedLocalState | null,
): Promise<void> {
  await runTransaction(
    MANAGED_EXCHANGE_LOCAL_STORE_NAME,
    "readwrite",
    ({ store, readEach }) => {
      const local = store(MANAGED_EXCHANGE_LOCAL_STORE_NAME);
      readEach([local.get(id)], ([raw]) => {
        const next = transform(parseManagedLocalStateOfKey(raw, id));
        if (next === null) local.delete(id);
        else local.put(storableManagedLocalState(next), id);
      });
      return () => undefined;
    },
  );
}

/**
 * Record that a backup was taken for a record as of `backedUpAt`, advancing only the
 * backup marker and leaving the other markers untouched. The read-modify-write runs
 * in one transaction, so the marker update cannot clobber a concurrent sibling
 * write.
 */
export async function markManagedExchangeBackedUp(
  id: string,
  backedUpAt: string,
): Promise<void> {
  await readModifyWriteLocalState(id, (current) => ({
    ...current,
    backup: { backedUpAt },
  }));
}

/**
 * Mark a record imported and backed-up as of the import instant -- a fresh install
 * from a backup artifact, which is itself a current backup of the installed secret.
 * Both markers are stamped in one read-modify-write, so the record reads green and
 * holds its restore evidence together. The import marker is what the desync tiering
 * reads to tell an import-since-last-success apart from an unexplained handshake
 * failure (see {@link ./managedFailureTiers.ts}); the backup marker keeps the freshly
 * installed record from immediately prompting a re-export.
 */
export async function markManagedExchangeImported(
  id: string,
  at: string,
): Promise<void> {
  await readModifyWriteLocalState(id, (current) => ({
    ...current,
    backup: { backedUpAt: at },
    imported: { importedAt: at },
  }));
}

/**
 * Mark a record imported as of the import instant, and nothing else -- a fresh
 * install from a command-line `alcove.yaml` and its `.alcove.key`. The import
 * marker is the same restore evidence {@link markManagedExchangeImported}
 * stamps; the backup marker is not stamped, since it attests the app's own
 * backup file and the pair is not one (docs/spec/MANAGED_EXCHANGE_RECORD.md,
 * "The backup and import markers").
 */
export async function markManagedExchangeKeyImported(
  id: string,
  at: string,
): Promise<void> {
  await readModifyWriteLocalState(id, (current) => ({
    ...current,
    imported: { importedAt: at },
  }));
}

/**
 * Keep the partner terms change an unattended run refused, for the next
 * visit to apply or decline, replacing any earlier one: the latest refusal
 * states the partner's current terms.
 */
export async function recordManagedExchangeTermsProposal(
  id: string,
  proposal: ManagedTermsProposal,
): Promise<void> {
  const termsProposal = managedTermsProposalSchema.parse(proposal);
  await readModifyWriteLocalState(id, (current) => ({
    ...current,
    termsProposal,
  }));
}

/**
 * Drop the pending terms proposal for a record, leaving every other sibling
 * marker as it is: the operator applied or declined it, or a later run agreed on
 * terms with the partner and so has nothing left to take on.
 */
export async function clearManagedExchangeTermsProposal(
  id: string,
): Promise<void> {
  await readModifyWriteLocalState(id, (current) => {
    const { termsProposal: _cleared, ...rest } = current ?? {};
    return Object.keys(rest).length === 0 ? null : rest;
  });
}
