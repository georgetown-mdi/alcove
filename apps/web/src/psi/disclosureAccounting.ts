/**
 * A managed exchange's accounting of disclosures: the self-attested exchange
 * records its runs produce, accumulated in run order. This is the pure,
 * IndexedDB-free half of {@link ./disclosureAccountingStore.ts}, so the shape
 * and the append rule are unit-testable in Node with no database.
 *
 * An entry IS a run's exchange record, verbatim -- not a derived summary.
 * Every fact the accounting states is a field of that record (see
 * docs/spec/EXCHANGE_RECORD.md), which is exactly what makes the record the
 * accounting's single source.
 *
 * The managed record cannot hold this by design: its `lastRun` keeps only
 * the most recent run (see docs/spec/MANAGED_EXCHANGE_RECORD.md, the
 * `lastRun` row). So the accounting is a SIBLING store keyed by the same
 * record id, which also keeps it out of the export artifact.
 *
 * What it holds at rest is the record's own cleartext content -- names,
 * categories, references, aggregate counts -- never a payload value,
 * linkage-field value, or matched identifier. The `resultSize` an entry
 * holds is the intersection CARDINALITY under the record format's
 * entitlement gate, not the intersection itself.
 */

import { z } from "zod";

import {
  EXCHANGE_RECORD_VERSION,
  migrateOnRead,
  parseExchangeRecord,
} from "@alcove/core";

import type { ExchangeRecord, FormatMigrations } from "@alcove/core";
import type { ZodType } from "zod";

/** The format version this build writes for a stored accounting. A reader
 * migrates an earlier version {@link DISCLOSURE_ACCOUNTING_MIGRATIONS} leads
 * from and refuses any other value. */
export const DISCLOSURE_ACCOUNTING_VERSION = "alcove-disclosure-accounting/v2";

/**
 * The accounting envelope's migrations, run in memory at every read. A step
 * moves the envelope and never an entry: an entry is an exchange record, which
 * is migrated on its own read and never rewritten. A migrated envelope is
 * written at the current version by the next append, never by a read.
 */
export const DISCLOSURE_ACCOUNTING_MIGRATIONS: FormatMigrations<string> =
  Object.freeze({
    fileName: "The accounting of disclosures",
    versionField: "version",
    current: DISCLOSURE_ACCOUNTING_VERSION,
    steps: Object.freeze([]),
    unchangedStatement: "The stored accounting was not changed.",
    failureRemedy:
      "Open the exchange's accounting of disclosures, download what it " +
      "offers, then start a fresh accounting.",
  });

/** One managed exchange's accounting of disclosures: its runs' exchange records,
 * oldest first. */
export interface DisclosureAccounting {
  version: typeof DISCLOSURE_ACCOUNTING_VERSION;
  /** The runs' self-attested exchange records, verbatim and in run order. */
  entries: ReadonlyArray<ExchangeRecord>;
}

/**
 * A stored accounting as its ENVELOPE alone admits it: the format version, and
 * the entries exactly as they sit at rest, held to nothing. The entries are
 * `unknown` because that is the whole point -- this shape exists for a stored
 * accounting whose entries the current exchange-record format no longer admits,
 * where the typed {@link DisclosureAccounting} is unobtainable.
 */
export interface StoredDisclosureAccounting {
  version: typeof DISCLOSURE_ACCOUNTING_VERSION;
  /** The stored entries, unvalidated and in stored order. */
  entries: ReadonlyArray<unknown>;
}

/** The envelope validator. The entries are validated one by one through core's own
 * {@link parseExchangeRecord} rather than a schema restated here, so a stored entry
 * is held to the exchange-record format itself and this module cannot drift from
 * it. */
const accountingEnvelopeSchema: ZodType<{
  version: typeof DISCLOSURE_ACCOUNTING_VERSION;
  entries: Array<unknown>;
}> = z
  .object({
    version: z.literal(DISCLOSURE_ACCOUNTING_VERSION),
    entries: z.array(z.unknown()),
  })
  .strict();

/**
 * Parse the ENVELOPE of a value read from the accounting store, migrated in
 * memory where it is at an earlier version: the stored entries verbatim and
 * unvalidated. Rejects any other `version` or an unknown key, but looks
 * inside no entry. This is the recovery read and the append's -- the only
 * admitted uses are handing stored bytes back to the operator, since an entry
 * whose record migration fails strands the full read below, and writing the
 * stored entries back unchanged. Never render what it returns AS an
 * accounting (see docs/spec/EXCHANGE_RECORD.md on the version literal moving
 * with the field set).
 *
 * @param migrations the envelope's migrations; this build's by default.
 * @throws {FormatMigrationError} if the envelope's migration fails.
 * @throws {ZodError} if the envelope is not a valid accounting envelope.
 */
export function parseStoredDisclosureAccounting(
  raw: unknown,
  migrations: FormatMigrations<string> = DISCLOSURE_ACCOUNTING_MIGRATIONS,
): StoredDisclosureAccounting {
  const envelope = accountingEnvelopeSchema.parse(
    migrateOnRead(raw, migrations),
  );
  return {
    version: DISCLOSURE_ACCOUNTING_VERSION,
    entries: envelope.entries,
  };
}

/** The `<family>/v<n>` shape a format version literal takes, split so two literals
 * of the same family can be ordered. A literal that does not take it has no
 * ordinal, and orders against nothing. */
const VERSION_SHAPE = /^(.+)\/v(\d+)$/;

/** A version literal's family and ordinal, or `undefined` for a value that is not
 * a literal of that shape. */
function versionParts(
  version: unknown,
): { family: string; ordinal: number } | undefined {
  if (typeof version !== "string") return undefined;
  const match = VERSION_SHAPE.exec(version);
  if (match === null) return undefined;
  return { family: match[1], ordinal: Number(match[2]) };
}

/**
 * Whether any stored entry names a LATER exchange-record format than this
 * build admits -- the direction that says the READER is behind, not the
 * stored value. An earlier-format entry whose migration fails is stranded
 * until exported and cleared; a later one means a newer deployment already
 * exists and reloading is the fix (the service worker does not swap code
 * under a running page; see {@link ../utils/appShellUpdate.ts}), so clearing
 * it here would destroy readable records. True on any such entry, including a
 * mixed accounting. A version literal this cannot order (another family, or
 * a shape holding no ordinal) is treated as not later.
 */
export function storedEntriesAheadOfThisBuild(
  stored: StoredDisclosureAccounting,
): boolean {
  const build = versionParts(EXCHANGE_RECORD_VERSION);
  if (build === undefined) return false;
  return stored.entries.some((entry) => {
    const version =
      entry !== null && typeof entry === "object"
        ? (entry as Record<string, unknown>)["version"]
        : undefined;
    const entryVersion = versionParts(version);
    return (
      entryVersion !== undefined &&
      entryVersion.family === build.family &&
      entryVersion.ordinal > build.ordinal
    );
  });
}

/**
 * Parse and validate a value read from the accounting store, the envelope and
 * each entry migrated in memory where it is at an earlier version. Rejects any
 * other `version`, an unknown key, an entry that is not a valid exchange
 * record, or a failed migration, rather than loading it -- so a corrupted
 * accounting, or one whose migration fails, shows as a read failure rather
 * than silently rendering a shorter, false account. Composed on
 * {@link parseStoredDisclosureAccounting}, so the envelope read and the
 * per-entry validation can only ever fail together or fail at the entries.
 *
 * @param migrations the envelope's migrations; this build's by default.
 * @throws {FormatMigrationError} if a migration fails.
 * @throws {ZodError} if the value is not a valid accounting.
 */
export function parseDisclosureAccounting(
  raw: unknown,
  migrations: FormatMigrations<string> = DISCLOSURE_ACCOUNTING_MIGRATIONS,
): DisclosureAccounting {
  const stored = parseStoredDisclosureAccounting(raw, migrations);
  return {
    version: DISCLOSURE_ACCOUNTING_VERSION,
    entries: stored.entries.map((entry) => parseExchangeRecord(entry)),
  };
}

/**
 * The value an append writes: the stored accounting `current` (`undefined`
 * where none is stored) with `record` after its entries, at the current
 * version. The stored entries are written back exactly as they sit at rest,
 * never as their migrated reading, and `record` as given, so a past exchange
 * record is never rewritten.
 *
 * Refuses wherever {@link parseDisclosureAccounting} refuses `current` or
 * core's parser refuses `record`, so an accounting this build cannot read
 * cannot be appended to either. A run already held is matched as
 * {@link appendDisclosureRecord} matches it, and adds no entry.
 *
 * @param migrations the envelope's migrations; this build's by default.
 * @throws {FormatMigrationError} if a migration fails.
 * @throws {ZodError} if `current` is not a valid accounting or `record` not a
 *   valid exchange record.
 */
export function appendToStoredDisclosureAccounting(
  current: unknown,
  record: unknown,
  migrations: FormatMigrations<string> = DISCLOSURE_ACCOUNTING_MIGRATIONS,
): StoredDisclosureAccounting {
  const parsed = parseExchangeRecord(record);
  if (current === undefined)
    return { version: DISCLOSURE_ACCOUNTING_VERSION, entries: [record] };
  const stored = parseStoredDisclosureAccounting(current, migrations);
  const accounting = parseDisclosureAccounting(stored, migrations);
  if (appendDisclosureRecord(accounting, parsed) === accounting) return stored;
  return {
    version: DISCLOSURE_ACCOUNTING_VERSION,
    entries: [...stored.entries, record],
  };
}

/**
 * Append one run's exchange record to the accounting, returning the result;
 * a missing accounting starts one. The record is stored verbatim.
 *
 * Appending the same run twice is a no-op, matched on the record's own
 * `bindingNonce` (CSPRNG-generated locally per exchange, so it distinguishes
 * runs within this holder's own log; see docs/spec/EXCHANGE_RECORD.md,
 * "Record fields"). The append is idempotent, so a retried write cannot
 * inflate the disclosure count.
 */
export function appendDisclosureRecord(
  current: DisclosureAccounting | undefined,
  record: ExchangeRecord,
): DisclosureAccounting {
  if (current === undefined)
    return { version: DISCLOSURE_ACCOUNTING_VERSION, entries: [record] };
  if (
    current.entries.some((entry) => entry.bindingNonce === record.bindingNonce)
  )
    return current;
  return {
    version: DISCLOSURE_ACCOUNTING_VERSION,
    entries: [...current.entries, record],
  };
}
