/**
 * The note a run leaves when its disclosure record never reached the exchange's
 * accounting of disclosures: the pure half of {@link ./unfiledDisclosureStore.ts}.
 * The append is best-effort, so a scheduled run with nobody present leaves this
 * note for the next visit. It sits in the disclosure store under a key of its
 * own, and keeps one retained exchange record per unfiled run where the run
 * built one (docs/spec/MANAGED_EXCHANGE_RECORD.md, "A run whose record was not
 * filed").
 */

import { z } from "zod";

import { parseExchangeRecord } from "@alcove/core";

import type { ExchangeRecord } from "@alcove/core";
import type { ZodType } from "zod";

/** The single recognized format version for a stored note; a reader rejects any
 * other value rather than migrating it. */
export const UNFILED_DISCLOSURE_VERSION = "alcove-unfiled-disclosure/v2";

/** The second element of the note's key. */
const UNFILED_DISCLOSURE_KEY_PART = "unfiled";

/**
 * Where one exchange's note sits in the disclosure store: an array key of the
 * record id and a fixed part. An array key equals no string key, so a note
 * collides with no exchange's accounting whatever the id is.
 */
export function unfiledDisclosureKey(id: string): [string, string] {
  return [id, UNFILED_DISCLOSURE_KEY_PART];
}

/**
 * One run whose disclosure record never reached the accounting, as it sits at
 * rest. The retained record is not validated here, so a record a later format
 * refuses keeps its stored bytes ({@link unfiledDisclosuresOf}).
 */
export interface StoredUnfiledDisclosure {
  /** ISO-8601 instant the shortfall was noted, during the run. */
  at: string;
  /** The run's own exchange record, retained so the append can be retried;
   * absent where the run built none. */
  record?: unknown;
}

/** One exchange's unfiled runs, oldest first. */
export interface StoredUnfiledDisclosures {
  version: typeof UNFILED_DISCLOSURE_VERSION;
  entries: ReadonlyArray<StoredUnfiledDisclosure>;
}

const storedSchema: ZodType<StoredUnfiledDisclosures> = z
  .object({
    version: z.literal(UNFILED_DISCLOSURE_VERSION),
    entries: z.array(
      z
        .object({ at: z.iso.datetime(), record: z.unknown().optional() })
        .strict(),
    ),
  })
  .strict();

/**
 * Parse a value read from the note's key. Rejects an unrecognized `version`, an
 * unknown key, or an entry with no instant, and looks inside no retained record.
 *
 * @throws {ZodError} if the value is not a stored note this build recognizes.
 */
export function parseStoredUnfiledDisclosures(
  raw: unknown,
): StoredUnfiledDisclosures {
  return storedSchema.parse(raw);
}

/** The retained record's binding nonce, or `undefined`, read without
 * validating the record. */
function bindingNonceOf(record: unknown): string | undefined {
  if (record === null || typeof record !== "object") return undefined;
  const nonce = (record as Record<string, unknown>)["bindingNonce"];
  return typeof nonce === "string" ? nonce : undefined;
}

/** Whether `entry` is already noted, matched on its record's binding nonce or,
 * with no record, on its instant. */
function alreadyNoted(
  entries: ReadonlyArray<StoredUnfiledDisclosure>,
  entry: StoredUnfiledDisclosure,
): boolean {
  const nonce = bindingNonceOf(entry.record);
  if (nonce === undefined)
    return entries.some(
      (noted) => noted.at === entry.at && noted.record === undefined,
    );
  return entries.some((noted) => bindingNonceOf(noted.record) === nonce);
}

/**
 * Note one unfiled run, in run order; a missing note starts one. Noting the
 * same run twice is a no-op (docs/spec/EXCHANGE_RECORD.md, "Record fields"), so
 * the entry count is the number of runs the accounting is short.
 */
export function noteUnfiledDisclosure(
  current: StoredUnfiledDisclosures | undefined,
  entry: StoredUnfiledDisclosure,
): StoredUnfiledDisclosures {
  if (current === undefined)
    return { version: UNFILED_DISCLOSURE_VERSION, entries: [entry] };
  if (alreadyNoted(current.entries, entry)) return current;
  return {
    version: UNFILED_DISCLOSURE_VERSION,
    entries: [...current.entries, entry],
  };
}

/** One unfiled run as the next visit reads it. */
export interface UnfiledDisclosure {
  /** The record's own `createdAt` where one was retained and admitted,
   * otherwise the instant the shortfall was noted. */
  at: string;
  /** The retained record, where the run built one and this build admits it;
   * without it the entry cannot be filed. */
  record?: ExchangeRecord;
  /** Set where a record for this run is stored and this build's record format
   * refuses it, so the UI does not claim nothing was kept. */
  unreadableRecordRetained?: true;
}

/**
 * The stored note's entries as the next visit reads them, oldest first, each
 * retained record validated through core's {@link parseExchangeRecord}. A
 * refused record leaves the entry with no record, marked retained but
 * unreadable; the stored bytes are untouched, since only a write prunes an
 * entry.
 */
export function unfiledDisclosuresOf(
  stored: StoredUnfiledDisclosures,
): Array<UnfiledDisclosure> {
  return stored.entries.map((entry) => {
    if (entry.record === undefined) return { at: entry.at };
    try {
      const record = parseExchangeRecord(entry.record);
      return { at: record.createdAt, record };
    } catch {
      return { at: entry.at, unreadableRecordRetained: true };
    }
  });
}

/**
 * The note left after the runs whose binding nonces `filed` holds were appended
 * to the accounting, or `undefined` when nothing is left, so the store removes
 * the key. An entry that was not filed stays exactly as stored.
 */
export function unfiledDisclosuresAfterFiling(
  stored: StoredUnfiledDisclosures,
  filed: ReadonlySet<string>,
): StoredUnfiledDisclosures | undefined {
  const entries = stored.entries.filter((entry) => {
    const nonce = bindingNonceOf(entry.record);
    return nonce === undefined || !filed.has(nonce);
  });
  if (entries.length === 0) return undefined;
  return { version: UNFILED_DISCLOSURE_VERSION, entries };
}
