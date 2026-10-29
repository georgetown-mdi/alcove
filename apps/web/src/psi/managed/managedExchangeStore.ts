/**
 * The IndexedDB-backed store for managed (recurring) exchange records,
 * origin-isolated by IndexedDB's same-origin model. A thin platform layer over
 * the pure record schema in {@link ./managedExchangeRecord.ts}: every record
 * written or read here is built or re-validated there. The whole exchange --
 * record, secret, working-folder grant, schedule, and run
 * bookkeeping -- is one object under one key, so a delete removes it entirely;
 * there is no separate secret-only retirement (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md).
 */

import { canonicalString } from "@alcove/core";

import {
  clearUnfiledExchangeFlag,
  clearUnfiledExchangeFlags,
} from "../unfiledDisclosureFlag";
import { unfiledDisclosureKey } from "../unfiledDisclosure";

import {
  ManagedExchangeLockUnavailableError,
  withManagedExchangeLock,
} from "./managedExchangeLock";
import {
  applyManagedExchangeCommandLinePair,
  applyManagedExchangeCompromiseResponse,
  applyManagedExchangeImportReplace,
  applyManagedExchangeLastRun,
  applyManagedExchangeLocalEdits,
  applyManagedExchangePayloadReceiveFill,
  applyManagedExchangeReinviteRotation,
  applyManagedExchangeRelayRegistrar,
  applyManagedExchangeRelayRegistrationConfirmed,
  applyManagedExchangeRotation,
  applyManagedExchangeRotationInFlight,
  applyManagedExchangeRotationInFlightCleared,
  applyManagedExchangeScheduleAdvance,
  applyManagedExchangeSentColumns,
  applyManagedExchangeStandingConditionCleared,
  applyManagedExchangeTermsChange,
  applyManagedExchangeWorkingDirectory,
  buildManagedExchangeRecord,
  diagnoseManagedExchangeRecord,
  parseManagedExchangeRecord,
  partitionReadableManagedExchanges,
  runnableManagedExchangeOrRefuse,
  safeParseManagedExchangeRecord,
  standingCompromiseResponse,
} from "./managedExchangeRecord";
import {
  decideCommandLinePairTarget,
  managedStoredCopy,
} from "./managedPairRecognition";
import {
  findRecordsByTermsAndSide,
  sameAgreedTermsAndSide,
} from "./managedLiveCopyMatch";
import { foldElapsedWindowsUnderResponse } from "./managedSchedule";
import { parseManagedLocalState } from "./managedLocalStateShape";

import type { LinkageTerms, RelayRegistrar } from "@alcove/core";

import type {
  ManagedBackupLocation,
  ManagedBackupMarker,
} from "./managedBackupState";
import type {
  ManagedExchangeDiagnosticEssentials,
  ManagedExchangeLastRun,
  ManagedExchangeLocalEdits,
  ManagedExchangeReadableRecords,
  ManagedExchangeRecord,
  ManagedExchangeReinviteRotation,
  ManagedExchangeRotation,
  ManagedExchangeScheduleAdvance,
  ManagedImportSource,
  ManagedTermsChangeWrite,
  NewManagedExchange,
  RunnableManagedExchangeRecord,
} from "./managedExchangeRecord";
import type {
  ManagedPairImportOptions,
  ManagedPairTarget,
  ManagedStoredCopy,
} from "./managedPairRecognition";
import type { ManagedLocalState } from "./managedLocalStateShape";

/** The IndexedDB database name, under the app's origin. */
export const MANAGED_EXCHANGE_DB_NAME = "alcove-managed-exchanges";

/** The object store holding one {@link ManagedExchangeRecord} per key. */
export const MANAGED_EXCHANGE_STORE_NAME = "records";

/**
 * The object store holding the local sibling state for a record (the backup and
 * import markers and any terms proposal), keyed by the record's `id`. A separate
 * store, not a record field: this state must never appear in the export
 * artifact, and keeping it a sibling makes that non-inclusion structural (the
 * exporter reads only the records store). Its shape is governed by
 * {@link ./managedLocalState.ts}.
 */
export const MANAGED_EXCHANGE_LOCAL_STORE_NAME = "localState";

/**
 * The object store holding a record's accounting of disclosures -- its runs'
 * self-attested exchange records -- keyed by the record's `id`. A separate store
 * for the same reason as the local-state store: the export artifact must not
 * include the accounting, so keeping it a sibling makes that structural. Its shape is
 * governed by {@link ./disclosureAccounting.ts}.
 */
export const MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME = "disclosures";

/**
 * The object store holding the results a scheduled run left for the operator's
 * next visit, keyed by the record's `id`. A separate store for the same reason as
 * the two above, and for one more: it is the only store here that holds row
 * values, so keeping it outside the record makes its exclusion from the export
 * artifact structural rather than a rule the exporter has to follow. Its shape
 * and retention are governed by {@link ../parkedResults.ts}.
 */
export const MANAGED_EXCHANGE_RESULTS_STORE_NAME = "results";

/** The database schema version this build opens. Bump only for an IndexedDB
 * structural migration (a new object store or index), never for a change to the
 * record's own `schemaVersion`, which the record schema governs.
 * @internal */
export const IDB_VERSION = 1;

/**
 * Open (creating or upgrading) the managed-exchange database. The records store is
 * keyed by the record's `id` (an in-line key path), so a record is its own key and
 * a delete needs only that id; the local-state store is keyed out-of-line by the
 * same id. Callers usually go through the higher-level CRUD functions below rather
 * than opening the database themselves.
 */
export function openManagedExchangeDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // Per the IndexedDB spec, `blocked` does not abort the request: this same
    // request's onupgradeneeded/onsuccess can still fire after `onblocked` already
    // settled the promise. This flag detects that case so the late success closes
    // the connection instead of leaking it or resolving a second time.
    let blocked = false;
    const request = indexedDB.open(MANAGED_EXCHANGE_DB_NAME, IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MANAGED_EXCHANGE_STORE_NAME))
        db.createObjectStore(MANAGED_EXCHANGE_STORE_NAME, { keyPath: "id" });
      if (!db.objectStoreNames.contains(MANAGED_EXCHANGE_LOCAL_STORE_NAME))
        db.createObjectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME);
      if (!db.objectStoreNames.contains(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME))
        db.createObjectStore(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME);
      if (!db.objectStoreNames.contains(MANAGED_EXCHANGE_RESULTS_STORE_NAME))
        db.createObjectStore(MANAGED_EXCHANGE_RESULTS_STORE_NAME);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) {
        db.close();
        return;
      }
      // Closes on a later open's version-change, so this connection does not hold an
      // older version open and block the next build's upgrade indefinitely (the
      // condition that fires `blocked` below).
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    // A version-change open is blocked when another live connection still holds an
    // older version, and settles neither way on its own; without this handler the
    // promise would hang forever. Rejecting classifies a blocked open as
    // store-unavailable rather than hanging the caller. The state is transient --
    // the `onversionchange` close above lets the other connection yield -- so a
    // reload recovers it.
    request.onblocked = () => {
      blocked = true;
      reject(
        new Error("managed-exchange database open blocked by another tab"),
      );
    };
  });
}

/**
 * Whether the managed store can be opened at all in this browser. Opens the
 * database and closes the connection at once, since holding it open could block a
 * later version-change transaction. Distinguishes an unopenable store (private
 * mode with storage blocked, an engine without IndexedDB) from an openable one.
 * Resolves `true` on a successful open, `false` when the open rejects, and never
 * rejects itself -- a caller degrades on `false` rather than catching.
 */
export async function probeManagedStoreOpen(): Promise<boolean> {
  try {
    (await openManagedExchangeDatabase()).close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Request that the browser make the origin's storage persistent, so the managed
 * store is not evicted under storage pressure. Best-effort: the grant is never
 * assumed durable, and is not shown as its own status line -- durability rests
 * on rotation, fast re-invite, and the opt-in age bound, not on this request.
 * Returns the browser's grant decision, or `false` where the API is unavailable.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  // `navigator.storage.persist` is typed as always present by the DOM lib but
  // is absent outside a browser and on older engines, where the call throws;
  // the try/catch resolves either case to the secure-by-default no-grant, the
  // same wrap isDiagnosticMode uses for localStorage.
  try {
    return await globalThis.navigator.storage.persist();
  } catch {
    return false;
  }
}

/** Run `work` inside a transaction over the records store, resolving on the
 * transaction's `complete` event (not merely the request's success), so a caller
 * awaiting this has the write visible to a subsequent read. The database
 * connection is closed once the transaction settles. */
async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
  options?: { durability?: IDBTransactionDurability },
): Promise<T> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_STORE_NAME,
        mode,
        options,
      );
      const request = work(
        transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME),
      );
      let result: T;
      request.onsuccess = () => {
        result = request.result;
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Create and persist a new managed exchange record. The record is built and
 * validated through {@link buildManagedExchangeRecord} (which assigns `id` and
 * `schemaVersion` and enforces the label cap, the credential-free document, and
 * the secret format). The write uses `{ durability: "strict" }`, requesting OS
 * writeback before the transaction completes. Persistent storage is requested
 * alongside the write ({@link requestPersistentStorage}). Returns the persisted
 * record, including its assigned `id`.
 *
 * @throws {ZodError} if the fields do not form a valid record.
 */
export async function createManagedExchange(
  fields: NewManagedExchange,
): Promise<ManagedExchangeRecord> {
  const record = buildManagedExchangeRecord(fields);
  // Fired, not awaited: the request must be made before the record lands, but a
  // browser may gate the grant behind a user prompt, and a denied, absent, or
  // pending grant must neither delay nor fail the create (the helper never
  // rejects; the grant is never assumed).
  void requestPersistentStorage();
  await withStore("readwrite", (store) => store.add(record), {
    durability: "strict",
  });
  return record;
}

/**
 * Persist a whole managed exchange record, replacing any record with the same
 * `id`. The record is re-validated through {@link parseManagedExchangeRecord}
 * before the write, so an invalid record (an over-long label, a document holding
 * an `authentication` block, a malformed secret) never reaches storage. Uses
 * `{ durability: "strict" }` -- this is the write the persist-before-success
 * ordering runs when a rotation advances the secret.
 *
 * @throws {ZodError} if the record is invalid.
 */
export async function putManagedExchange(
  record: ManagedExchangeRecord,
): Promise<ManagedExchangeRecord> {
  const validated = parseManagedExchangeRecord(record);
  await withStore("readwrite", (store) => store.put(validated), {
    durability: "strict",
  });
  return validated;
}

/**
 * Read one managed exchange record by `id`, or `undefined` when none exists. The
 * stored value is re-validated through {@link parseManagedExchangeRecord}, so a
 * record whose `schemaVersion` the current build does not recognize -- or one an
 * app upgrade has otherwise invalidated -- rejects loudly rather than loading
 * (the recovery is re-invite, not migration).
 *
 * @throws {ZodError} if the stored value is not a valid v4 record.
 */
export async function getManagedExchange(
  id: string,
): Promise<ManagedExchangeRecord | undefined> {
  const raw = await withStore("readonly", (store) => store.get(id));
  if (raw === undefined) return undefined;
  return parseManagedExchangeRecord(raw);
}

/**
 * Read every managed exchange record. Each stored value is re-validated through
 * {@link parseManagedExchangeRecord}; a single invalid record rejects the whole
 * read rather than silently dropping it, so a corrupted or app-upgrade-
 * invalidated store surfaces rather than partially loading.
 *
 * @throws {ZodError} if any stored value is not a valid v4 record.
 */
export async function listManagedExchanges(): Promise<
  Array<ManagedExchangeRecord>
> {
  const raws = await withStore("readonly", (store) => store.getAll());
  return raws.map((raw) => parseManagedExchangeRecord(raw));
}

/**
 * Read every managed exchange record PER ENTRY: an entry this build cannot parse
 * is skipped and its stored key returned beside the records, rather than failing
 * the whole read the way {@link listManagedExchanges} does.
 *
 * This is the UNATTENDED runner's read only (see
 * {@link ./managedScheduleRunner.ts}): a wake has nobody present to meet the
 * read-failed recovery surface, so one unparseable entry must not stop every
 * other exchange's scheduled run.
 *
 * Keys and values are read in ONE transaction, so an entry that fails to parse
 * still yields the key it is stored under (its own `id` is untrusted once the
 * parse fails).
 */
export async function listReadableManagedExchanges(): Promise<ManagedExchangeReadableRecords> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<ManagedExchangeReadableRecords>(
      (resolve, reject) => {
        const transaction = db.transaction(
          MANAGED_EXCHANGE_STORE_NAME,
          "readonly",
        );
        const store = transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME);
        const keysRequest = store.getAllKeys();
        const valuesRequest = store.getAll();
        transaction.oncomplete = () => {
          resolve(
            partitionReadableManagedExchanges(
              keysRequest.result,
              valuesRequest.result,
            ),
          );
        };
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      },
    );
  } finally {
    db.close();
  }
}

/**
 * One entry in the diagnostic read: for a stored key, either the display essentials
 * the entry parsed to (`readable`) or an unreadable marker (`unreadable`) holding
 * only the key. Both hold the stored `id`, so a delete-by-key acts on either
 * without requiring a successful parse. Both also hold whether the sibling
 * local-state store states a backup (`backedUp`), so the delete confirm's custody
 * note shows on the recovery path exactly as on the normal list. A boolean
 * suffices for the backup marker, whose timestamp is never shown here. A
 * readable entry whose sibling entry does not parse holds `stateUnreadable`:
 * its page cannot load, so nothing it holds can be exported first.
 */
export type ManagedExchangeDiagnosticEntry =
  | {
      kind: "readable";
      essentials: ManagedExchangeDiagnosticEssentials;
      backedUp: boolean;
      stateUnreadable?: true;
    }
  | {
      kind: "unreadable";
      id: string;
      backedUp: boolean;
    };

/**
 * Read every stored entry for the read-failed recovery listing, per-record and
 * NEVER rejecting wholesale -- unlike {@link listManagedExchanges}. Exists ONLY for
 * the recovery surface: it attempts {@link diagnoseManagedExchangeRecord} on each
 * raw value and returns, per stored key, either its display essentials or an
 * unreadable marker, so an operator can discard the offending record even when the
 * normal list cannot load.
 *
 * SECURITY: entries hold display essentials only (label, side, dates, key) plus
 * the sibling custody, which has no secret material and no rotation epoch; the
 * `sharedSecret`, the document, the folder handle, and the backup marker's timestamp
 * never leave the diagnostic extraction. Keyed off the store's own keys rather than
 * the parsed records, so an unreadable entry still yields a key to delete by.
 *
 * The custody is read from the sibling local-state store in the same transaction.
 * A record whose sibling entry is present but does not parse yields its
 * essentials marked `stateUnreadable` where the record itself parses, and the
 * unreadable marker where it does not, and is conservative on doubt: it is
 * treated as backed up (a wrongly-shown custody warning is harmless; a
 * wrongly-suppressed one is not).
 */
export async function listManagedExchangesDiagnostic(): Promise<
  Array<ManagedExchangeDiagnosticEntry>
> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<Array<ManagedExchangeDiagnosticEntry>>(
      (resolve, reject) => {
        const transaction = db.transaction(
          [MANAGED_EXCHANGE_STORE_NAME, MANAGED_EXCHANGE_LOCAL_STORE_NAME],
          "readonly",
        );
        const records = transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME);
        const local = transaction.objectStore(
          MANAGED_EXCHANGE_LOCAL_STORE_NAME,
        );
        const keysRequest = records.getAllKeys();
        const valuesRequest = records.getAll();
        const localKeysRequest = local.getAllKeys();
        const localValuesRequest = local.getAll();
        transaction.oncomplete = () => {
          const keys = keysRequest.result;
          const values = valuesRequest.result;
          const custodyByKey = siblingCustodyByKey(
            localKeysRequest.result,
            localValuesRequest.result,
          );
          const entries: Array<ManagedExchangeDiagnosticEntry> = [];
          for (let index = 0; index < keys.length; index += 1) {
            const key = String(keys[index]);
            const sibling = custodyByKey.get(key);
            const custody =
              sibling?.siblingReadable === false
                ? { backedUp: true, stateUnreadable: true as const }
                : { backedUp: sibling?.backedUp ?? false };
            try {
              entries.push({
                kind: "readable",
                essentials: diagnoseManagedExchangeRecord(values[index]),
                ...custody,
              });
            } catch {
              // The parse failed, so the record's own `id` is untrusted; the store
              // key is the delete target instead, and the only field shown.
              entries.push({
                kind: "unreadable",
                id: key,
                backedUp: custody.backedUp,
              });
            }
          }
          resolve(entries);
        };
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      },
    );
  } finally {
    db.close();
  }
}

/** What a sibling entry states about one record's custody, for the diagnostic read:
 * whether the entry parsed, and whether an exported backup remains with the
 * operator. */
interface ManagedExchangeDiagnosticCustody {
  siblingReadable: boolean;
  backedUp: boolean;
}

/** Derive each record's custody from the sibling store's parallel key and value
 * arrays. CONSERVATIVE on doubt: a sibling entry that cannot be parsed is treated as
 * backed up (a wrongly-shown custody warning is harmless; a wrongly-suppressed one is
 * not). The backup marker's timestamp is never shown -- only its presence. */
function siblingCustodyByKey(
  keys: ReadonlyArray<IDBValidKey>,
  values: ReadonlyArray<unknown>,
): Map<string, ManagedExchangeDiagnosticCustody> {
  const custodyByKey = new Map<string, ManagedExchangeDiagnosticCustody>();
  for (let index = 0; index < keys.length; index += 1) {
    const key = String(keys[index]);
    try {
      const { backup } = parseManagedLocalState(values[index]);
      custodyByKey.set(key, {
        siblingReadable: true,
        backedUp: backup !== undefined,
      });
    } catch {
      custodyByKey.set(key, { siblingReadable: false, backedUp: true });
    }
  }
  return custodyByKey;
}

/**
 * Read the record under `id` and write back `transform`'s result inside a SINGLE
 * readwrite transaction, so no other write can land between the read and the
 * write-back -- a cross-transaction read-modify-write would have an await gap in
 * which a concurrent rotation write could land and be silently reverted.
 * `transform` must be synchronous (Zod validation is) or the transaction would
 * auto-commit before the write is issued; it throws to abort the transaction,
 * leaving the stored record unchanged, and receives `undefined` when no record
 * exists under `id`. A transform returning {@link UnwrittenRecord} writes
 * nothing and resolves with the record it names.
 */
async function readModifyWriteRecord(
  id: string,
  transform: (stored: unknown) => ManagedExchangeRecord | UnwrittenRecord,
): Promise<ManagedExchangeRecord> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<ManagedExchangeRecord>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_STORE_NAME,
        "readwrite",
        { durability: "strict" },
      );
      const store = transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME);
      const read = store.get(id);
      let written: ManagedExchangeRecord;
      let failure: unknown;
      read.onsuccess = () => {
        try {
          const next = transform(read.result);
          if ("unwritten" in next) written = next.unwritten;
          else {
            written = next;
            store.put(written);
          }
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve(written);
      // A failed request's error event reaches the transaction before the
      // abort sets `transaction.error`, so the request's own error is read
      // there; an explicit abort leaves `transaction.error` null.
      transaction.onerror = (event) =>
        reject(
          failure ?? storeWriteFailure((event.target as IDBRequest).error),
        );
      transaction.onabort = () =>
        reject(failure ?? storeWriteFailure(transaction.error));
    });
  } finally {
    db.close();
  }
}

/** What a {@link readModifyWriteRecord} transform returns to write nothing:
 * the stored record, as read. */
interface UnwrittenRecord {
  unwritten: ManagedExchangeRecord;
}

/**
 * What a run's own terms write compares the stored terms with: the terms the
 * run read when it took the lock, or the terms its own last terms write
 * stored. An Apply or a terms update takes no lock, so either can land while
 * the run is in flight; a run's write finding the stored terms moved past
 * these writes nothing, so the operator's write is the one kept.
 */
export interface ManagedRunRecordExpectation {
  id: string;
  linkageTerms: LinkageTerms;
}

/**
 * A run's own terms write: `apply` over the stored record, inside one
 * strict-durability readwrite transaction, only where it still holds the
 * terms `expected` names.
 *
 * @returns the record written, or `undefined` where nothing was.
 * @throws {Error} if no record with the id exists.
 */
async function modifyRunRecordIfCurrent(
  expected: ManagedRunRecordExpectation,
  apply: (existing: ManagedExchangeRecord) => ManagedExchangeRecord,
): Promise<ManagedExchangeRecord | undefined> {
  const outcome: { written?: ManagedExchangeRecord } = {};
  await readModifyWriteRecord(expected.id, (stored) => {
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${expected.id}`);
    const existing = parseManagedExchangeRecord(stored);
    if (
      canonicalString(existing.exchangeFile.linkageTerms) !==
      canonicalString(expected.linkageTerms)
    )
      return { unwritten: existing };
    outcome.written = apply(existing);
    return outcome.written;
  });
  return outcome.written;
}

/** The rejection for a store write whose transaction did not commit: the
 * error IndexedDB gave, or a stated one where it gave none. */
function storeWriteFailure(error: DOMException | null): Error {
  return error ?? new Error("the store write was aborted before it committed");
}

/**
 * Persist a rotation to the stored record AND clear its backup and import markers,
 * in one transaction spanning both stores -- clearing a marker in a separate
 * transaction would leave a window where the rotated record reads over stale
 * sibling evidence. An export taken before the rotation holds the old secret, so
 * the backup marker must clear atomically with it: "marker present" then means "an
 * export of the current secret was taken since the last rotation." The import
 * marker clears for the same reason: a rotation is driven by a completed handshake
 * that proves both parties held the same secret, so it must not shield a later,
 * unexplained handshake failure (see {@link ./managedFailureTiers.ts}).
 *
 * The record write is field-scoped through `transform` exactly as
 * {@link readModifyWriteRecord}, so it cannot include a stale secret or document;
 * `transform` must be synchronous (Zod validation is) or the transaction
 * auto-commits before the writes are issued.
 */
async function readModifyWriteRotation<T extends ManagedExchangeRecord>(
  id: string,
  transform: (stored: unknown) => T,
): Promise<T> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(
        [MANAGED_EXCHANGE_STORE_NAME, MANAGED_EXCHANGE_LOCAL_STORE_NAME],
        "readwrite",
        { durability: "strict" },
      );
      const records = transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME);
      const local = transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME);
      const read = records.get(id);
      const readLocal = local.get(id);
      let written: T;
      let failure: unknown;
      const applyWhenReady = () => {
        if (read.readyState !== "done" || readLocal.readyState !== "done")
          return;
        try {
          written = transform(read.result);
          records.put(written);
          clearRotationSiblingsOnLocalStore(local, id, readLocal.result);
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      read.onsuccess = applyWhenReady;
      readLocal.onsuccess = applyWhenReady;
      transaction.oncomplete = () => resolve(written);
      transaction.onerror = () => reject(failure ?? transaction.error);
      transaction.onabort = () => reject(failure ?? transaction.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Drop the backup and import markers from a record's sibling local-state entry, on
 * an already-open local-state object store inside a live transaction, by deleting
 * the entry. Nothing in it is kept, so it is deleted unread: an entry this build
 * cannot parse goes too, rather than aborting a rotation the partner has already
 * made.
 */
function clearRotationSiblingsOnLocalStore(
  store: IDBObjectStore,
  id: string,
  raw: unknown,
): void {
  if (raw !== undefined) store.delete(id);
}

/**
 * Read the current stored record for `id`, compose the export's bytes from it, AND
 * stamp its backup marker as of `backedUpAt`, saved as the location `composeExport`
 * returns, all inside one transaction spanning the record and sibling stores,
 * returning the record read. The marker attests exactly the bytes the export
 * serialized, so a stale-tab export cannot stamp a marker over a secret it did
 * not serialize. Because the mark is cross-store-atomic with the read, a
 * concurrent rotation (which clears the marker in its own cross-store
 * transaction) is never masked: this transaction either marks the pre-rotation
 * record before the rotation clears it, or marks the already-rotated secret.
 * The marker only advances forward, so a slow export's late mark cannot
 * revert a newer one; the other sibling markers are left untouched.
 *
 * `composeExport` runs synchronously here, BEFORE the mark is issued: if it throws
 * (an export that refuses the record it read), the whole transaction aborts and no
 * marker is written. It must stay synchronous and store-free, or the transaction
 * would commit out from under it.
 *
 * @throws {Error} if no record with `id` exists.
 * @throws {ZodError} if the stored record or sibling entry is invalid.
 */
export async function readRecordAndMarkBackedUp(
  id: string,
  backedUpAt: string,
  composeExport: (record: ManagedExchangeRecord) => ManagedBackupLocation,
): Promise<ManagedExchangeRecord> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<ManagedExchangeRecord>((resolve, reject) => {
      const transaction = db.transaction(
        [MANAGED_EXCHANGE_STORE_NAME, MANAGED_EXCHANGE_LOCAL_STORE_NAME],
        "readwrite",
        { durability: "strict" },
      );
      const records = transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME);
      const local = transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME);
      const read = records.get(id);
      const readLocal = local.get(id);
      let record: ManagedExchangeRecord;
      let failure: unknown;
      const applyWhenReady = () => {
        if (read.readyState !== "done" || readLocal.readyState !== "done")
          return;
        try {
          if (read.result === undefined)
            throw new Error(`no managed exchange with id ${id}`);
          record = parseManagedExchangeRecord(read.result);
          const savedAs = composeExport(record);
          markBackupOnLocalStore(local, id, readLocal.result, {
            backedUpAt,
            savedAs,
          });
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      read.onsuccess = applyWhenReady;
      readLocal.onsuccess = applyWhenReady;
      transaction.oncomplete = () => resolve(record);
      transaction.onerror = () => reject(failure ?? transaction.error);
      transaction.onabort = () => reject(failure ?? transaction.error);
    });
  } finally {
    db.close();
  }
}

/** How a checked backup mark turned out: `"marked"` where the stored secret was
 * the one the written backup holds and the marker was stamped, `"superseded"`
 * where the secret had moved on, and `"gone"` where no record is stored under
 * the id. The two refusals write nothing. */
export type ManagedBackupMarkOutcome = "marked" | "superseded" | "gone";

/**
 * Stamp the backup marker as of `backedUpAt`, but ONLY while the stored record
 * still holds `expectedSharedSecret`, the secret a backup already written
 * elsewhere holds. For a backup whose landing is known only after it is
 * written, so the mark cannot be issued in the step that composed it: the read,
 * the comparison, and the mark are one transaction spanning the record and
 * sibling stores, so a rotation landing after the write is seen and the marker
 * is not stamped over a secret the file does not hold. The marker only advances
 * forward, as in {@link readRecordAndMarkBackedUp}, and the other markers are kept.
 *
 * @throws {ZodError} if the stored record or sibling entry is invalid; the
 *   transaction aborts and nothing is written.
 */
export async function markManagedBackupIfCurrent(
  id: string,
  expectedSharedSecret: string,
  backedUpAt: string,
  savedAs?: ManagedBackupLocation,
): Promise<ManagedBackupMarkOutcome> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<ManagedBackupMarkOutcome>((resolve, reject) => {
      const transaction = db.transaction(
        [MANAGED_EXCHANGE_STORE_NAME, MANAGED_EXCHANGE_LOCAL_STORE_NAME],
        "readwrite",
        { durability: "strict" },
      );
      const records = transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME);
      const local = transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME);
      const read = records.get(id);
      const readLocal = local.get(id);
      let outcome: ManagedBackupMarkOutcome = "superseded";
      let failure: unknown;
      const applyWhenReady = () => {
        if (read.readyState !== "done" || readLocal.readyState !== "done")
          return;
        try {
          if (read.result === undefined) {
            outcome = "gone";
            return;
          }
          const stored = parseManagedExchangeRecord(read.result);
          if (stored.sharedSecret !== expectedSharedSecret) return;
          markBackupOnLocalStore(local, id, readLocal.result, {
            backedUpAt,
            ...(savedAs !== undefined ? { savedAs } : {}),
          });
          outcome = "marked";
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      read.onsuccess = applyWhenReady;
      readLocal.onsuccess = applyWhenReady;
      transaction.oncomplete = () => resolve(outcome);
      transaction.onerror = () => reject(failure ?? transaction.error);
      transaction.onabort = () => reject(failure ?? transaction.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Advance the backup marker on a record's sibling entry to `marker`, on an
 * already-open local-state object store inside a live transaction, preserving the
 * other markers. The marker only moves forward: a stamp older than the stored marker
 * is a no-op, so a slow export's late mark cannot revert a newer one. Compared as
 * parsed instants, since the schema admits ISO stamps of differing precision.
 * The merged entry is validated before it is written, so a marker the reader
 * would reject throws here and leaves the stored entry as it was.
 */
function markBackupOnLocalStore(
  store: IDBObjectStore,
  id: string,
  raw: unknown,
  marker: ManagedBackupMarker,
): void {
  const current = raw === undefined ? undefined : parseManagedLocalState(raw);
  if (
    current?.backup !== undefined &&
    Date.parse(current.backup.backedUpAt) > Date.parse(marker.backedUpAt)
  )
    return;
  store.put(parseManagedLocalState({ ...current, backup: marker }), id);
}

/**
 * Apply local edits (the label, schedule, max-token-age policy, and the
 * document's own-columns choice, delimiter, and retention note -- the only
 * fields that update in place without a re-invite) to the stored record and
 * persist the result. The read, the edit application through
 * {@link applyManagedExchangeLocalEdits} (which re-validates), and the write-back
 * run inside one readwrite transaction ({@link readModifyWriteRecord}), so the
 * edit applies to the freshest stored record and cannot reintroduce a stale
 * secret over a concurrent rotation write. A change to the agreed terms is a new
 * exchange, not an edit here: the terms, the connection, and the secret are not
 * editable through this path.
 *
 * An edit to the max-token-age policy re-derives `expires` conservatively -- never
 * extending the stored credential's life without a rotation (see
 * {@link applyManagedExchangeLocalEdits}). The clock is captured once before the
 * transaction opens, since the field-scoped transform must be synchronous.
 *
 * @throws {Error} if no record with `id` exists.
 * @throws {ZodError} if the stored value is not a valid v4 record or the edit
 *   produces an invalid one; the transaction aborts and nothing is written.
 */
export async function updateManagedExchangeLocalFields(
  id: string,
  edits: ManagedExchangeLocalEdits,
): Promise<ManagedExchangeRecord> {
  const now = Date.now();
  return readModifyWriteRecord(id, (stored) => {
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    const existing = parseManagedExchangeRecord(stored);
    return applyManagedExchangeLocalEdits(existing, edits, now);
  });
}

/**
 * Persist a rotation to the stored record: advance the rotated secret and the
 * `expires` bound, remove the rotation-in-flight marker, and set the pending
 * relay key registration, and nothing else, AND clear the record's backup
 * marker -- both in one strict-durability transaction spanning the record and
 * sibling stores ({@link readModifyWriteRotation}). The record write is
 * field-scoped through {@link applyManagedExchangeRotation} (which
 * re-validates), so it cannot include a stale secret or document. This is the
 * durable write the persist-before-success ordering awaits before the data
 * exchange begins (see docs/spec/MANAGED_EXCHANGE_RECORD.md).
 *
 * The write replaces `expectedSharedSecret`, the secret the run read when it
 * took the lock, and refuses where the record read inside the transaction holds
 * another. A safety check: the re-invite and the import replace take the same
 * lock, so neither lands while the run holds it.
 *
 * @throws {Error} if no record with `id` exists, or if the stored record holds a
 *   configuration only ({@link runnableManagedExchangeOrRefuse}): the `id` carries
 *   no shape, so the record read inside the transaction is what the rotation is
 *   narrowed on, and the transaction aborts with the record still keyless.
 * @throws {ManagedExchangeSecretChangedError} if the stored secret is not
 *   `expectedSharedSecret`; the transaction aborts and nothing is written.
 * @throws {ZodError} if the stored value is not a valid v4 record or the rotation
 *   produces an invalid one; the transaction aborts and nothing is written.
 */
export async function persistManagedExchangeRotation(
  id: string,
  expectedSharedSecret: string,
  rotation: ManagedExchangeRotation,
): Promise<RunnableManagedExchangeRecord> {
  return readModifyWriteRotation(id, (stored) => {
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    const existing = runnableManagedExchangeOrRefuse(
      parseManagedExchangeRecord(stored),
    );
    refuseChangedSecret(existing, expectedSharedSecret);
    return applyManagedExchangeRotation(existing, rotation);
  });
}

/**
 * Raised when a write finds the stored record holding a secret other than the
 * one its operation began from or was made under: a run's rotation, a
 * re-invite, or an import replace landed in between. The write aborts and
 * nothing is stored.
 */
export class ManagedExchangeSecretChangedError extends Error {
  constructor(id: string) {
    super(
      `the shared secret of managed exchange ${id} changed since this write began, so nothing was written`,
    );
    this.name = "ManagedExchangeSecretChangedError";
  }
}

/** Refuse a secret-replacing write over a record whose secret is not the one
 * the operation began from. */
function refuseChangedSecret(
  stored: ManagedExchangeRecord,
  expectedSharedSecret: string | undefined,
): void {
  if (stored.sharedSecret !== expectedSharedSecret)
    throw new ManagedExchangeSecretChangedError(stored.id);
}

/**
 * Mark the stored record's rotation as in flight at `since`, before the key
 * exchange that may rotate its secret, in a strict-durability transaction
 * awaited to `complete` -- the marker must be on disk before the terms exchange
 * can rotate anything, or a crash between this side sending its value and its
 * rotation write would leave no trace. Field-scoped through
 * {@link applyManagedExchangeRotationInFlight}, which keeps a marker already
 * present; the rotation write ({@link persistManagedExchangeRotation}) removes
 * it (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Persist-before-success ordering").
 *
 * @throws {Error} if no record with `id` exists, or it holds a configuration
 *   only.
 * @throws {ZodError} if the stored value or the resulting record is invalid.
 */
export async function markManagedExchangeRotationInFlight(
  id: string,
  since: string,
): Promise<void> {
  await readModifyWriteRecord(id, (stored) => {
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    return applyManagedExchangeRotationInFlight(
      runnableManagedExchangeOrRefuse(parseManagedExchangeRecord(stored)),
      since,
    );
  });
}

/**
 * Remove the stored record's rotation-in-flight marker after a responder run
 * that completed its key exchange and ended at the terms exchange with neither
 * side able to have stored the next secret
 * ({@link applyManagedExchangeRotationInFlightCleared}). Writes nothing where
 * the stored secret is not `sharedSecret`, the one the run authenticated with.
 *
 * @throws {Error} if no record with `id` exists, or it holds a configuration
 *   only.
 * @throws {ZodError} if the stored value or the resulting record is invalid.
 */
export async function clearManagedExchangeRotationInFlight(
  id: string,
  sharedSecret: string,
): Promise<void> {
  await readModifyWriteRecord(id, (stored) => {
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    const existing = runnableManagedExchangeOrRefuse(
      parseManagedExchangeRecord(stored),
    );
    if (
      existing.sharedSecret !== sharedSecret ||
      existing.rotationInFlightSince === undefined
    )
      return { unwritten: existing };
    return applyManagedExchangeRotationInFlightCleared(existing);
  });
}

/**
 * Raised when a re-invite's rotation is refused because the record the store holds
 * has a standing compromise response: a fresh secret on the channel the operator
 * flagged is the act the response names as the wrong one, and the rotation would
 * clear the response along with the condition holding it. A page that read the
 * record before the answer was written has a live control over a record that no
 * longer admits the mint, so the refusal is made against the record inside the
 * transaction rather than against any page's copy. The clear-and-acknowledge
 * ({@link clearManagedExchangeStandingCondition}) is what puts the mint back on
 * offer.
 */
export class ManagedReinviteWithheldError extends Error {
  constructor(id: string) {
    super(
      `a compromise response stands on managed exchange ${id}, so no fresh invitation is minted`,
    );
    this.name = "ManagedReinviteWithheldError";
  }
}

/**
 * Persist a re-invite's rotation to the stored record: advance the fresh setup
 * secret and re-derive the `expires` bound exactly as
 * {@link persistManagedExchangeRotation}, AND drop any `lastRun` bookkeeping -- all
 * in the one cross-store transaction that also clears the backup and import markers
 * ({@link readModifyWriteRotation}). Distinct from the run's rotation write because a
 * re-invite consumes the failure `lastRun` recorded: leaving it in place, with the
 * import marker now cleared, would re-derive a stale `auth` failure as the attack
 * tier, resurrecting a framing the operator already recovered from (see
 * {@link ./managedFailureTiers.ts}). The same write stores the coordination server
 * the re-invite named as the document's webrtc `server`, where the inviter's later
 * runs register. The record write is field-scoped through
 * {@link applyManagedExchangeReinviteRotation} (which re-validates), so it cannot
 * include a stale secret or document.
 *
 * The record read inside the transaction is what the refusal above is decided on,
 * so this is the one place the compromise response holds the mint: a caller's own
 * check is over a record read before the answer may have been written (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, the response's rules).
 *
 * On a record whose relay registrar holds the key of the secret this replaces
 * ({@link reinviteLosesRegistrarKey}), the write stores the registration as
 * pending for the reason `"reinvite"`, and `registerReinvitedKey` is handed the
 * record as read and as written: the replaced secret is held by that call
 * alone, to sign the registration of the fresh one. What it returns is what
 * this returns.
 *
 * The caller holds the record's run+rotate lock ({@link ./managedExchangeLock.ts})
 * across the read the re-invite is composed over and this write, so no run's
 * rotation lands between them. The write replaces `expectedSharedSecret`, the
 * secret the re-invite was composed over, and refuses where the record read
 * inside the transaction holds another: a safety check, since the lock already
 * excludes every other secret write.
 *
 * @throws {Error} if no record with `id` exists, or if the stored record holds a
 *   configuration only, narrowed inside the transaction exactly as
 *   {@link persistManagedExchangeRotation} narrows it.
 * @throws {ManagedReinviteWithheldError} if the stored record has a standing
 *   compromise response; the transaction aborts, leaving the secret and the
 *   response as they were.
 * @throws {ManagedExchangeSecretChangedError} if the stored secret is not
 *   `expectedSharedSecret`; the transaction aborts and nothing is written.
 * @throws {ZodError} if the stored value is not a valid v4 record or the rotation
 *   produces an invalid one; the transaction aborts and nothing is written.
 */
export async function persistManagedExchangeReinvite(
  id: string,
  expectedSharedSecret: string,
  rotation: ManagedExchangeReinviteRotation,
  registerReinvitedKey?: (
    replaced: RunnableManagedExchangeRecord,
    written: RunnableManagedExchangeRecord,
  ) => Promise<RunnableManagedExchangeRecord>,
): Promise<RunnableManagedExchangeRecord> {
  const read: { replaced?: RunnableManagedExchangeRecord } = {};
  const written = await readModifyWriteRotation(id, (stored) => {
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    const existing = runnableManagedExchangeOrRefuse(
      parseManagedExchangeRecord(stored),
    );
    if (standingCompromiseResponse(existing) !== undefined)
      throw new ManagedReinviteWithheldError(id);
    refuseChangedSecret(existing, expectedSharedSecret);
    read.replaced = existing;
    return applyManagedExchangeReinviteRotation(
      existing,
      reinviteLosesRegistrarKey(existing)
        ? {
            ...rotation,
            relayRegistrationPendingSince: new Date().toISOString(),
            relayRegistrationPendingReason: "reinvite",
          }
        : rotation,
    );
  });
  const { replaced } = read;
  return replaced !== undefined &&
    registerReinvitedKey !== undefined &&
    reinviteLosesRegistrarKey(replaced)
    ? registerReinvitedKey(replaced, written)
    : written;
}

/**
 * Whether a re-invite of `record` replaces the secret whose relay key its
 * registrar holds: the record names a registrar.
 */
function reinviteLosesRegistrarKey(
  record: RunnableManagedExchangeRecord,
): boolean {
  return record.relayRegistrar !== undefined;
}

/**
 * Set or remove the relay registrar the stored record registers at
 * ({@link applyManagedExchangeRelayRegistrar}), in one strict-durability
 * transaction. Setting one is refused unless the record still holds
 * `confirmedSecret`, the secret whose relay key the registrar confirmed.
 *
 * @throws {Error} if no record with `id` exists, or it holds a configuration
 *   only.
 * @throws {ManagedRelayRegistrarStaleError} if the record's secret is not
 *   `confirmedSecret`; nothing is written.
 * @throws {ZodError} if the stored value or the resulting record is invalid.
 */
export async function persistManagedExchangeRelayRegistrar(
  id: string,
  registrar: RelayRegistrar | undefined,
  confirmedSecret?: string,
): Promise<RunnableManagedExchangeRecord> {
  const written = await readModifyWriteRecord(id, (stored) => {
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    return applyManagedExchangeRelayRegistrar(
      runnableManagedExchangeOrRefuse(parseManagedExchangeRecord(stored)),
      registrar,
      confirmedSecret,
    );
  });
  return runnableManagedExchangeOrRefuse(written);
}

/**
 * Drop the stored record's pending relay key registration once the registrar
 * confirmed the key derived from `confirmedSecret`
 * ({@link applyManagedExchangeRelayRegistrationConfirmed}); a record that has
 * rotated past that secret since keeps its marker. Returns the stored record.
 *
 * @throws {Error} if no record with `id` exists, or it holds a configuration
 *   only.
 * @throws {ZodError} if the stored value or the resulting record is invalid.
 */
export async function clearManagedExchangeRelayRegistrationPending(
  id: string,
  confirmedSecret: string,
): Promise<RunnableManagedExchangeRecord> {
  const written = await readModifyWriteRecord(id, (stored) => {
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    return applyManagedExchangeRelayRegistrationConfirmed(
      runnableManagedExchangeOrRefuse(parseManagedExchangeRecord(stored)),
      confirmedSecret,
    );
  });
  return runnableManagedExchangeOrRefuse(written);
}

/**
 * Record a partner's changed linkage terms into the stored record's exchange
 * file ({@link applyManagedExchangeTermsChange}), inside one strict-durability
 * readwrite transaction, so the write lands on the freshest stored record and
 * cannot carry a stale secret back over a rotation. Takes no lock: a run in
 * flight runs the terms it read when it took the lock, whatever this writes,
 * and its own terms writes leave this one stored
 * ({@link persistManagedRunTermsChange}).
 *
 * With `expectedSharedSecret`, the secret the change was checked under, the
 * write refuses where the record read inside the transaction holds another: a
 * run's rotation or a re-invite landed since the change was read.
 *
 * @throws {Error} if no record with `id` exists.
 * @throws {ManagedExchangeSecretChangedError} if the stored secret is not
 *   `expectedSharedSecret`; nothing is written.
 * @throws {UsageError} for an `apply` or `update` the record's own identity
 *   cannot take.
 * @throws {ZodError} if the stored value or the resulting record is invalid.
 */
export async function persistManagedExchangeTermsChange(
  id: string,
  write: ManagedTermsChangeWrite,
  expectedSharedSecret?: string,
): Promise<ManagedExchangeRecord> {
  return readModifyWriteRecord(id, (stored) => {
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    const existing = parseManagedExchangeRecord(stored);
    if (expectedSharedSecret !== undefined)
      refuseChangedSecret(existing, expectedSharedSecret);
    return applyManagedExchangeTermsChange(existing, write);
  });
}

/**
 * A run's own terms write, the partner's changed terms an attended run took on:
 * {@link persistManagedExchangeTermsChange}, made only while the stored record
 * holds the terms `expected` names. Where an operator's terms write moved it
 * past them, nothing is written and the operator's write is kept.
 *
 * @returns the record written, or `undefined` where nothing was.
 * @throws {Error} if no record with the id exists.
 * @throws {UsageError} for an `apply` the record's own identity cannot take.
 * @throws {ZodError} if the stored value or the resulting record is invalid.
 */
export async function persistManagedRunTermsChange(
  expected: ManagedRunRecordExpectation,
  write: ManagedTermsChangeWrite,
): Promise<ManagedExchangeRecord | undefined> {
  return modifyRunRecordIfCurrent(expected, (existing) =>
    applyManagedExchangeTermsChange(existing, write),
  );
}

/**
 * Record which of this party's own columns the stored exchange sends
 * ({@link applyManagedExchangeSentColumns}), inside one strict-durability
 * readwrite transaction, as {@link persistManagedExchangeTermsChange} does.
 * Takes no lock, as that write does not.
 *
 * @throws {Error} if no record with `id` exists.
 * @throws {UsageError} where the exchange offers no such choice.
 * @throws {ZodError} if the stored value or the resulting record is invalid.
 */
export async function persistManagedExchangeSentColumns(
  id: string,
  sent: ReadonlyArray<string>,
): Promise<ManagedExchangeRecord> {
  return readModifyWriteRecord(id, (stored) => {
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    return applyManagedExchangeSentColumns(
      parseManagedExchangeRecord(stored),
      sent,
    );
  });
}

/**
 * Record a run's `lastRun` bookkeeping on the stored record, leaving the rotated
 * secret and the document untouched. The read, the field-scoped application
 * through {@link applyManagedExchangeLastRun}, and the write-back run inside one
 * strict-durability readwrite transaction, so recording an outcome cannot revert a
 * concurrent rotation write. Separate from {@link persistManagedExchangeRotation}
 * so the outcome (succeeded, or a `storage` failure when the rotation persist
 * itself failed) is recorded without re-touching the secret.
 *
 * The write rules are {@link applyManagedExchangeLastRun}'s, so this is the one
 * call every runner -- attended and scheduled -- records an outcome through:
 * a write staler than the stored entry is a no-op, and a failure outcome is a
 * no-op against a success stamped at or after `runStartedAtMs`, the instant the
 * run producing `lastRun` began.
 *
 * With `expectedSharedSecret`, the secret the run last stored or began from,
 * the write is also a no-op where the stored record holds another: a write
 * made after the run released its lock finds a re-invite or a later run
 * replaced it, so the record is theirs and this run's outcome is not stamped
 * on it.
 *
 * @throws {Error} if no record with `id` exists.
 * @throws {ZodError} if the stored value or the resulting record is invalid.
 */
export async function recordManagedExchangeLastRun(
  id: string,
  lastRun: ManagedExchangeLastRun,
  runStartedAtMs: number,
  expectedSharedSecret?: string,
): Promise<ManagedExchangeRecord> {
  return readModifyWriteRecord(id, (stored) => {
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    const existing = parseManagedExchangeRecord(stored);
    if (
      expectedSharedSecret !== undefined &&
      existing.sharedSecret !== expectedSharedSecret
    )
      return { unwritten: existing };
    return applyManagedExchangeLastRun(existing, lastRun, runStartedAtMs);
  });
}

/**
 * Record the `payload.receive` a run filled from the partner's declared send
 * set into the stored record's terms ({@link applyManagedExchangePayloadReceiveFill}),
 * inside one strict-durability readwrite transaction, so the write lands on
 * the freshest stored record and cannot carry a stale secret back over a
 * rotation. Awaited at the terms exchange, before any key or payload moves: a
 * rejection stops the run.
 *
 * Made only while the stored record holds the terms `expected` names. Where an
 * operator's terms write moved it past them, nothing is written and nothing is
 * thrown: the operator's write is kept, and the run goes on under the terms it
 * agreed on with the partner.
 *
 * @returns the record written, or `undefined` where nothing was.
 * @throws {Error} if no record with the id exists, or its terms already
 *   state the list.
 * @throws {ZodError} if the stored value or the resulting record is invalid.
 */
export async function persistManagedRunPayloadReceiveFill(
  expected: ManagedRunRecordExpectation,
  columns: ReadonlyArray<string>,
): Promise<ManagedExchangeRecord | undefined> {
  return modifyRunRecordIfCurrent(expected, (existing) =>
    applyManagedExchangePayloadReceiveFill(existing, columns),
  );
}

/**
 * Clear the stored record's standing condition -- the operator's explicit
 * clear-and-acknowledge -- advancing that field and the schedule bookkeeping the
 * response it holds earned ({@link foldElapsedWindowsUnderResponse}) inside one
 * strict-durability readwrite transaction, so the acknowledgement cannot carry a
 * stale secret or a stale document back over a concurrent rotation write.
 *
 * The fold and the clear are one write because the fold is only computable while
 * the answer is still on the record: every window that elapsed under the response
 * is recorded skipped here, so the next wake -- reading a record the answer has
 * left -- cannot count those windows as the partner's misses and tell the
 * operator to check with them. It is the acknowledgement that folds them because
 * it is the clearer a standing response admits: the re-invite's own write refuses
 * while one stands, and deleting the exchange takes the schedule with the record
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md, the `standingCondition` row).
 *
 * This is the only clear that is not part of another write.
 *
 * @param now The clearing instant, UTC milliseconds, which the fold walks the
 *   schedule up to; defaults to the clock.
 * @throws {Error} if no record with `id` exists.
 * @throws {ZodError} if the stored value or the resulting record is invalid.
 */
export async function clearManagedExchangeStandingCondition(
  id: string,
  now: number = Date.now(),
): Promise<ManagedExchangeRecord> {
  return readModifyWriteRecord(id, (stored) => {
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    const existing = parseManagedExchangeRecord(stored);
    return applyManagedExchangeStandingConditionCleared(
      foldElapsedWindowsUnderResponse(existing, now),
    );
  });
}

/**
 * Record the operator's compromise response -- "something does not add up" at a
 * failure gate -- on the stored record, advancing only the standing-condition
 * field through {@link applyManagedExchangeCompromiseResponse} inside one
 * strict-durability readwrite transaction, so the answer cannot carry a stale
 * secret or a stale document back over a concurrent rotation write.
 *
 * The answer is written against the record the STORE holds, not the one the page
 * mounted with: a condition raised by a run since the mount is the one the answer
 * attaches to, and the carrier this write raises where none stands is a last
 * resort rather than a second condition beside it.
 *
 * It has no clear of its own. The three acts that clear a standing condition
 * clear the answer with it, each by the whole-field write it already performs
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md, the `standingCondition` row).
 *
 * @throws {Error} if no record with `id` exists.
 * @throws {ZodError} if the stored value or the resulting record is invalid.
 */
export async function recordManagedExchangeCompromiseResponse(
  id: string,
  at: string,
): Promise<ManagedExchangeRecord> {
  return readModifyWriteRecord(id, (stored) => {
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    const existing = parseManagedExchangeRecord(stored);
    return applyManagedExchangeCompromiseResponse(existing, at);
  });
}

/**
 * Persist a scheduled window's bookkeeping to the stored record: `nextWindow`,
 * `consecutiveMisses`, and the window's `lastRun` advance in ONE strict-durability
 * readwrite transaction ({@link readModifyWriteRecord}), leaving the rotated
 * secret and the document untouched. Atomicity matters: split across two writes, a
 * wake interrupted between them would leave a planned window moved past a count
 * that has not (or the reverse), and the next wake would recount or skip the
 * difference. Field-scoped through {@link applyManagedExchangeScheduleAdvance}
 * (which re-validates and conditions on the stored cadence, planned window, and
 * miss count), so it cannot reintroduce a stale secret over a concurrent rotation,
 * overwrite a schedule edited or cleared from another tab, or rewind one a newer
 * wake already advanced.
 *
 * @throws {Error} if no record with `id` exists.
 * @throws {ZodError} if the stored value or the resulting record is invalid.
 */
export async function persistManagedExchangeScheduleAdvance(
  id: string,
  advance: ManagedExchangeScheduleAdvance,
): Promise<ManagedExchangeRecord> {
  return readModifyWriteRecord(id, (stored) => {
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    const existing = parseManagedExchangeRecord(stored);
    return applyManagedExchangeScheduleAdvance(existing, advance);
  });
}

/**
 * Persist a working-folder grant onto the stored record, or drop it with `null`,
 * advancing only `workingDirectoryHandle` and nothing else. The read, the
 * field-scoped application through {@link applyManagedExchangeWorkingDirectory}
 * (which re-validates), and the write-back run inside one strict-durability
 * readwrite transaction ({@link readModifyWriteRecord}), so the grant the operator
 * just took cannot carry a stale secret or document back over a concurrent
 * rotation write. Used where the operator grants or re-points the folder a run
 * reads its input from and a scheduled run writes its results into.
 *
 * @throws {Error} if no record with `id` exists.
 * @throws {ZodError} if the stored value is not a valid v4 record or the result is
 *   invalid; the transaction aborts and nothing is written.
 */
export async function persistManagedExchangeWorkingDirectory(
  id: string,
  handle: FileSystemDirectoryHandle | null,
): Promise<ManagedExchangeRecord> {
  return readModifyWriteRecord(id, (stored) => {
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    const existing = parseManagedExchangeRecord(stored);
    return applyManagedExchangeWorkingDirectory(existing, handle);
  });
}

/**
 * How {@link reconcileManagedBackupImport} reconciled an artifact against the
 * records in the store. Nothing is written by any of them:
 *
 * - `"held"` -- a stored record holds the artifact's secret already: it is the
 *   same exchange. The caller refuses the import, naming that record's
 *   `label`, and whether its sibling entry does not parse
 *   (`stateUnreadable`), which keeps its page from loading.
 * - `"live-copy"` -- no stored record holds the artifact's secret, and one or
 *   more have its agreed terms and side not yet acknowledged
 *   ({@link findRecordsByTermsAndSide}), listed in `copies`. The caller names
 *   them all and imports only on the operator's word: one `id` back as `into`
 *   to replace it, or every `id` in `besideIds` to install beside them.
 * - `"replace"` -- the record `into` names still has the artifact's agreed
 *   terms and side, so the caller replaces it
 *   ({@link replaceManagedExchangeFromImport}), over the `sharedSecret` it
 *   held at this read, absent where it held a configuration only.
 * - `"chosen-copy-changed"` -- the record `into` names is gone or no longer has
 *   the artifact's agreed terms and side.
 * - `"no-match"` -- nothing above applies, so the caller installs a fresh record.
 */
export type ManagedBackupReconcileOutcome =
  | { kind: "held"; label: string; stateUnreadable?: true }
  | { kind: "live-copy"; copies: ReadonlyArray<ManagedStoredCopy> }
  | { kind: "replace"; id: string; sharedSecret?: string }
  | { kind: "chosen-copy-changed" }
  | { kind: "no-match" };

/** What a backup import asks of the reconciliation beyond the artifact itself:
 * the operator's answer to a `"live-copy"` outcome. */
export interface ManagedBackupImportOptions {
  /** The stored record the operator chose to replace with the backup. */
  into?: string;
  /** The stored records the operator confirmed installing beside, which the
   * terms-and-side rule then passes over. */
  besideIds?: ReadonlyArray<string>;
}

/**
 * Reconcile a reconstructed artifact against the store, in one transaction
 * reading every record and comparing each record's `sharedSecret` with
 * `reconstructed`'s in memory, so nothing secret-derived is ever persisted. A
 * stored record holding the same secret is the same exchange and refuses
 * (`"held"`): a second copy of one secret splits at the first rotation either
 * side makes. Otherwise the stored records with the artifact's agreed terms and
 * side, other than those in `besideIds`, are named together for the operator to
 * decide on ({@link findRecordsByTermsAndSide}): either secret may have rotated
 * past the other. An `into` answer is checked against the same rule here, and
 * nothing is written: the replace is its own write.
 *
 * Each stored record is parsed on its own, and an entry this build cannot parse is
 * SKIPPED rather than failing the reconciliation: one invalid record must not block
 * an import for a different exchange, which is the way forward the read-failed
 * recovery surface offers. The invalid entry stays in the store, listed by that
 * surface's diagnostic read, until the operator discards it.
 */
export async function reconcileManagedBackupImport(
  reconstructed: ManagedExchangeRecord,
  options: ManagedBackupImportOptions = {},
): Promise<ManagedBackupReconcileOutcome> {
  const outcome = await reconcileImportedSecret(
    reconstructed,
    "",
    "backup",
    options,
  );
  if (outcome.kind === "completed" || outcome.kind === "stored-copy")
    throw new Error(
      `a backup reconciliation reported ${outcome.kind}, which only a command-line pair import reaches`,
    );
  return outcome;
}

/**
 * How {@link reconcileManagedCommandLinePair} reconciled an imported
 * command-line pair: `"held"` and `"no-match"` read as on the backup import,
 * and those only a pair reaches ({@link ManagedPairTarget}):
 *
 * - `"completed"` -- the configuration-only record the operator chose took
 *   the pair, holding the completed record.
 * - `"replace"`, `"stored-copy"`, and `"chosen-copy-changed"` -- as
 *   {@link ManagedPairTarget} states; nothing is written.
 */
export type ManagedPairReconcileOutcome =
  | Exclude<ManagedBackupReconcileOutcome, { kind: "live-copy" }>
  | { kind: "completed"; record: ManagedExchangeRecord }
  | { kind: "stored-copy"; copies: ReadonlyArray<ManagedStoredCopy> };

/**
 * Reconcile a record read from a command-line `alcove.yaml` and its
 * `.alcove.key` against the store, in the transaction the backup import's
 * {@link reconcileManagedBackupImport} uses. A stored record holding the same
 * `sharedSecret`, compared in memory, is the same exchange and refuses exactly
 * as it does there. Where none holds it, the records with its agreed terms and
 * side are looked for, and the pair lands in one only as `options.into` names
 * it ({@link decideCommandLinePairTarget}).
 *
 * A configuration-only record takes the pair's fields laid over it here
 * ({@link applyManagedExchangeCommandLinePair}) -- the document, side, max-age
 * policy, key pair, and relay registration -- keeping its id, label, and
 * standing condition, and is marked imported as of `at`; no backup marker is
 * stamped. A record that runs here is replaced by the caller instead
 * (`"replace"`, {@link replaceManagedExchangeFromImport}), under its run lock,
 * which a configuration-only record needs no part of.
 *
 * @throws {ZodError} if the completed record is invalid; nothing is written.
 */
export async function reconcileManagedCommandLinePair(
  imported: RunnableManagedExchangeRecord,
  at: string,
  options: ManagedPairImportOptions = {},
): Promise<ManagedPairReconcileOutcome> {
  const outcome = await reconcileImportedSecret(
    imported,
    at,
    "command-line",
    {},
    options,
  );
  if (outcome.kind === "live-copy")
    throw new Error(
      `a command-line pair reconciliation reported ${outcome.kind}, which only a backup import asks for`,
    );
  return outcome;
}

/** The reconciliation both imports run, differing by `source` only where
 * {@link reconcileManagedCommandLinePair} states. A held record's sibling entry
 * is read only to report whether it parses. */
async function reconcileImportedSecret(
  reconstructed: ManagedExchangeRecord,
  at: string,
  source: ManagedImportSource,
  options: ManagedBackupImportOptions,
  pairOptions: ManagedPairImportOptions = {},
): Promise<ManagedBackupReconcileOutcome | ManagedPairReconcileOutcome> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<
      ManagedBackupReconcileOutcome | ManagedPairReconcileOutcome
    >((resolve, reject) => {
      const transaction = db.transaction(
        [MANAGED_EXCHANGE_STORE_NAME, MANAGED_EXCHANGE_LOCAL_STORE_NAME],
        "readwrite",
        { durability: "strict" },
      );
      const records = transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME);
      const local = transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME);
      const readRecords = records.getAll();
      let outcome: ManagedBackupReconcileOutcome | ManagedPairReconcileOutcome =
        { kind: "no-match" };
      let failure: unknown;
      readRecords.onsuccess = () => {
        try {
          let held: ManagedExchangeRecord | undefined;
          const others: Array<ManagedExchangeRecord> = [];
          for (const raw of readRecords.result) {
            const parsed = safeParseManagedExchangeRecord(raw);
            if (!parsed.success) continue;
            if (parsed.data.sharedSecret === reconstructed.sharedSecret)
              held ??= parsed.data;
            else others.push(parsed.data);
          }
          if (held !== undefined) {
            const { label } = held;
            outcome = { kind: "held", label };
            const readHeldLocal = local.get(held.id);
            readHeldLocal.onsuccess = () => {
              if (
                readHeldLocal.result !== undefined &&
                parsedSiblingEntry(readHeldLocal.result) === undefined
              )
                outcome = { kind: "held", label, stateUnreadable: true };
            };
            return;
          }
          if (source === "backup") {
            outcome = decideBackupTarget(others, reconstructed, options);
            return;
          }
          const imported = runnableManagedExchangeOrRefuse(reconstructed);
          const target = decideCommandLinePairTarget(
            others,
            imported,
            pairOptions,
          );
          if (target.kind !== "complete") {
            if (target.kind !== "no-match") outcome = target;
            return;
          }
          const completed = applyManagedExchangeCommandLinePair(
            target.into,
            imported,
          );
          records.put(completed);
          local.put(
            parseManagedLocalState({ imported: { importedAt: at } }),
            target.into.id,
          );
          outcome = { kind: "completed", record: completed };
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve(outcome);
      transaction.onerror = () => reject(failure ?? transaction.error);
      transaction.onabort = () => reject(failure ?? transaction.error);
    });
  } finally {
    db.close();
  }
}

/** Where a backup lands once no stored record holds its secret: the record
 * `options.into` chose, provided it still has the backup's agreed terms and
 * side, or else the question naming every such record not in
 * `options.besideIds`. */
function decideBackupTarget(
  records: ReadonlyArray<ManagedExchangeRecord>,
  imported: ManagedExchangeRecord,
  options: ManagedBackupImportOptions,
): ManagedBackupReconcileOutcome {
  if (options.into !== undefined) {
    const chosen = findRecordsByTermsAndSide(records, imported).find(
      ({ id }) => id === options.into,
    );
    return chosen === undefined
      ? { kind: "chosen-copy-changed" }
      : {
          kind: "replace",
          id: chosen.id,
          ...(chosen.sharedSecret !== undefined
            ? { sharedSecret: chosen.sharedSecret }
            : {}),
        };
  }
  const liveCopies = findRecordsByTermsAndSide(
    records,
    imported,
    options.besideIds,
  );
  return liveCopies.length > 0
    ? { kind: "live-copy", copies: liveCopies.map(managedStoredCopy) }
    : { kind: "no-match" };
}

/** A stored sibling entry as parsed, or `undefined` where there is none or it
 * does not parse. */
function parsedSiblingEntry(raw: unknown): ManagedLocalState | undefined {
  if (raw === undefined) return undefined;
  try {
    return parseManagedLocalState(raw);
  } catch {
    return undefined;
  }
}

/**
 * How {@link replaceManagedExchangeFromImport} ended. `"replaced"` is the one
 * outcome that writes, holding the record that runs here from then on. The
 * refusals write nothing:
 *
 * - `"run-in-flight"` -- a run of the record holds its run+rotate lock, so a
 *   replace landing beside it would overwrite the secret it rotates.
 * - `"changed"` -- the record is gone, lacks the import's agreed terms
 *   and side, or holds another secret, since the operator chose it.
 */
export type ManagedReplaceOutcome =
  | { kind: "replaced"; record: RunnableManagedExchangeRecord }
  | { kind: "run-in-flight" }
  | { kind: "changed" };

/**
 * Replace the stored record `id`, which the operator chose, with an imported
 * one ({@link applyManagedExchangeImportReplace}), keeping its `id`, so its
 * accounting of disclosures, any parked results, and any unfiled-run note --
 * all kept under that id -- stay with it.
 *
 * The sibling entry is written in the same transaction: the import marker as
 * of `at`, and from a backup the backup marker too, since the file just
 * imported is a backup of the secret it installs. A pending terms proposal is
 * kept; every other marker is dropped with the replaced secret, and an entry
 * this build cannot parse is dropped whole.
 *
 * The step takes the record's run+rotate lock ({@link ./managedExchangeLock.ts})
 * with `ifAvailable` before its transaction opens, as the re-invite does, so a
 * run holding it refuses the replace rather than having its secret replaced
 * mid-exchange. The read, the check that the record still has the import's
 * agreed terms and side, the check that it still holds `expectedSharedSecret`
 * -- the secret the reconciliation that chose it read, absent for a
 * configuration-only record -- and both writes are one transaction, so a
 * re-invite or a run landing between that reconciliation and the lock refuses
 * the replace.
 *
 * @throws {Error} if `imported` holds no secret; nothing is written.
 * @throws {ZodError} if the stored record or the result is invalid; the
 *   transaction aborts and nothing is written.
 */
export async function replaceManagedExchangeFromImport(
  id: string,
  expectedSharedSecret: string | undefined,
  at: string,
  imported: ManagedExchangeRecord,
  source: ManagedImportSource,
): Promise<ManagedReplaceOutcome> {
  try {
    return await withManagedExchangeLock(
      id,
      () => replaceStoredCopy(id, expectedSharedSecret, at, imported, source),
      { ifAvailable: true },
    );
  } catch (error) {
    if (error instanceof ManagedExchangeLockUnavailableError)
      return { kind: "run-in-flight" };
    throw error;
  }
}

/** The replace itself, run under the record's run+rotate lock. */
async function replaceStoredCopy(
  id: string,
  expectedSharedSecret: string | undefined,
  at: string,
  imported: ManagedExchangeRecord,
  source: ManagedImportSource,
): Promise<ManagedReplaceOutcome> {
  const runnable = runnableManagedExchangeOrRefuse(imported);
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<ManagedReplaceOutcome>((resolve, reject) => {
      const transaction = db.transaction(
        [MANAGED_EXCHANGE_STORE_NAME, MANAGED_EXCHANGE_LOCAL_STORE_NAME],
        "readwrite",
        { durability: "strict" },
      );
      const records = transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME);
      const local = transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME);
      const read = records.get(id);
      const readLocal = local.get(id);
      let outcome: ManagedReplaceOutcome = { kind: "changed" };
      let failure: unknown;
      const applyWhenReady = () => {
        if (read.readyState !== "done" || readLocal.readyState !== "done")
          return;
        try {
          if (read.result === undefined) return;
          const stored = parseManagedExchangeRecord(read.result);
          if (!sameAgreedTermsAndSide(stored, runnable)) return;
          if (stored.sharedSecret !== expectedSharedSecret) return;
          const replaced = applyManagedExchangeImportReplace(
            stored,
            runnable,
            source,
          );
          const termsProposal = parsedSiblingEntry(
            readLocal.result,
          )?.termsProposal;
          records.put(replaced);
          local.put(
            parseManagedLocalState({
              ...(termsProposal !== undefined ? { termsProposal } : {}),
              ...(source === "backup" ? { backup: { backedUpAt: at } } : {}),
              imported: { importedAt: at },
            }),
            id,
          );
          outcome = { kind: "replaced", record: replaced };
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      read.onsuccess = applyWhenReady;
      readLocal.onsuccess = applyWhenReady;
      transaction.oncomplete = () => resolve(outcome);
      transaction.onerror = () => reject(failure ?? transaction.error);
      transaction.onabort = () => reject(failure ?? transaction.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Delete a managed exchange in one step, removing everything the browser holds
 * for it -- the record, the secret, the working-folder grant, the schedule, the run bookkeeping, the local sibling state (the backup
 * and import markers and any terms proposal), its accounting of disclosures and the note of any
 * run that could not be filed into it, AND the results a scheduled run parked
 * for the operator -- so nothing is left behind. All of it is removed in one
 * transaction spanning the four stores, so a delete cannot leave a stranded
 * sibling entry. Idempotent: a delete of a missing id resolves without error.
 *
 * The accounting goes with the exchange: it is this exchange's own disclosure
 * history, and leaving it behind would strand cleartext partner and agreement
 * metadata under an id nothing surfaces. The unfiled-run note goes for the same
 * reason -- it retains a run's own record ({@link ../unfiledDisclosure.ts}) --
 * and its localStorage fallback flag goes with it. That flag sits in a separate
 * store, so it is dropped after the transaction completes rather than in it: a
 * delete that did not take leaves the flag standing. It is dropped here rather
 * than by a caller so no delete path can leave an id of an exchange this browser
 * no longer holds. An operator who must keep the accounting exports it before deleting;
 * the delete confirm says so. The parked results go with it for a stronger
 * reason: they are matched rows, and an id no surface offers would leave them at
 * rest with nothing to remove them but the retention.
 */
export async function deleteManagedExchange(id: string): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        [
          MANAGED_EXCHANGE_STORE_NAME,
          MANAGED_EXCHANGE_LOCAL_STORE_NAME,
          MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
          MANAGED_EXCHANGE_RESULTS_STORE_NAME,
        ],
        "readwrite",
      );
      transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME).delete(id);
      transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME).delete(id);
      const disclosures = transaction.objectStore(
        MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
      );
      disclosures.delete(id);
      disclosures.delete(unfiledDisclosureKey(id));
      transaction.objectStore(MANAGED_EXCHANGE_RESULTS_STORE_NAME).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    await clearUnfiledExchangeFlag(id);
  } finally {
    db.close();
  }
}

/**
 * Delete every managed exchange record, all local sibling state, every accounting
 * of disclosures with the unfiled-run notes beside them, and every scheduled
 * run's parked results. Used to reset the store; all four stores are cleared in
 * one transaction, so no sibling entry outlives the records it belonged to. The
 * notes' localStorage fallback flags go too, on the same terms the single delete
 * clears one: after the transaction, so nothing is dropped for a clear that did
 * not take.
 */
export async function clearManagedExchanges(): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        [
          MANAGED_EXCHANGE_STORE_NAME,
          MANAGED_EXCHANGE_LOCAL_STORE_NAME,
          MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
          MANAGED_EXCHANGE_RESULTS_STORE_NAME,
        ],
        "readwrite",
      );
      transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME).clear();
      transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME).clear();
      transaction.objectStore(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME).clear();
      transaction.objectStore(MANAGED_EXCHANGE_RESULTS_STORE_NAME).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    await clearUnfiledExchangeFlags();
  } finally {
    db.close();
  }
}
