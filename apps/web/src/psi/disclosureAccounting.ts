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
  FormatMigrationError,
  declaresLaterFormatVersion,
  formatVersionFollows,
  migrateOnRead,
  parseExchangeRecord,
} from "@alcove/core";

import type { ExchangeRecord, FormatMigrations } from "@alcove/core";
import type { ZodType } from "zod";

/** The format version this build writes for a stored accounting. A reader
 * migrates an earlier version {@link DISCLOSURE_ACCOUNTING_MIGRATIONS} leads
 * from and refuses any other value. */
export const DISCLOSURE_ACCOUNTING_VERSION = "alcove-disclosure-accounting/v3";

/**
 * The first accounting version written after the exchange-record format was
 * reset to v1 at release 0.9.0. Fixed rather than the current version: an
 * envelope before it holds only entries a build before that release filed,
 * whose record ordinals a later build reuses for other formats.
 */
const FIRST_ACCOUNTING_VERSION_AFTER_RECORD_RESET =
  "alcove-disclosure-accounting/v3";

/**
 * The accounting envelope's migrations, run in memory at every read. A step
 * moves the envelope and never an entry: an entry is an exchange record, which
 * is migrated on its own read and never rewritten. A migrated envelope is
 * written at the current version by the next append, never by a read.
 *
 * The step from v2 moves the version alone, so a v2 accounting keeps its stored
 * form for export: its entries were filed before the exchange-record reset at
 * release 0.9.0, and {@link classifyRefusedDisclosureAccounting} reads them as
 * stranded.
 */
export const DISCLOSURE_ACCOUNTING_MIGRATIONS: FormatMigrations<string> =
  Object.freeze({
    fileName: "The accounting of disclosures",
    versionField: "version",
    current: DISCLOSURE_ACCOUNTING_VERSION,
    steps: Object.freeze([
      Object.freeze({
        from: "alcove-disclosure-accounting/v2",
        to: "alcove-disclosure-accounting/v3",
        migrate: (document: Record<string, unknown>) => document,
      }),
    ]),
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

/**
 * A stored accounting as it is handed back to the operator: the entries exactly
 * as they sit at rest, under the envelope version the browser actually stored.
 * That version is not {@link DISCLOSURE_ACCOUNTING_VERSION} for an accounting an
 * earlier build wrote, whose file must name the build that wrote it. Apart from
 * {@link StoredDisclosureAccounting}, which an append writes back at the current
 * version.
 */
export interface RecoveredDisclosureAccounting {
  version: string;
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

/**
 * Whether any stored entry names a LATER exchange-record format than this
 * build admits -- the direction that says the READER is behind, not the
 * stored value. An earlier-format entry whose migration fails is stranded
 * until exported and cleared; a later one means a newer deployment already
 * exists and reloading is the fix (the service worker does not swap code
 * under a running page; see {@link ../utils/appShellUpdate.ts}), so clearing
 * it here would destroy readable records. True on any such entry, including a
 * mixed accounting. A version literal this cannot order (another family, or
 * a shape holding no canonical ordinal) is treated as not later.
 */
export function storedEntriesAheadOfThisBuild(
  stored: Pick<StoredDisclosureAccounting, "entries">,
): boolean {
  return stored.entries.some((entry) =>
    formatVersionFollows(
      entry !== null && typeof entry === "object"
        ? (entry as Record<string, unknown>)["version"]
        : undefined,
      EXCHANGE_RECORD_VERSION,
    ),
  );
}

/**
 * Whether `raw`, a value read from the accounting store, declares an
 * envelope version later than this build's: an accounting a later build
 * wrote, which this page being behind explains, never a damaged one.
 */
export function storedEnvelopeAheadOfThisBuild(raw: unknown): boolean {
  return declaresLaterFormatVersion(raw, DISCLOSURE_ACCOUNTING_MIGRATIONS);
}

/**
 * Whether `raw`, a value read from the accounting store, declares an envelope
 * version before {@link FIRST_ACCOUNTING_VERSION_AFTER_RECORD_RESET}: an
 * accounting a build before release 0.9.0 filed. Its entries name record
 * formats numbered before the reset, so an entry ordinal above this build's is
 * never evidence of a later build.
 */
export function storedEnvelopePredatesRecordReset(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return false;
  return formatVersionFollows(
    FIRST_ACCOUNTING_VERSION_AFTER_RECORD_RESET,
    (raw as Record<string, unknown>)["version"],
  );
}

/**
 * How a stored accounting the validating parse refused is read. The two kinds
 * have opposite recoveries: an accounting this build is ahead of, or a damaged
 * one, is stranded and takes export then reset; one a later build wrote means
 * this page is behind, and reloading is the recovery.
 */
export type RefusedDisclosureAccounting =
  /** A stored value the validating parse refused -- a corrupted accounting, one
   * whose migration failed, or one an earlier release filed. `stored` holds the
   * entries exactly as they sit at rest when the ENVELOPE still parses (an entry
   * whose record migration failed, which is what makes the export arm
   * possible), and is `undefined` when the envelope is gone too and there is
   * nothing to hand back. `migrationFailure` is the refusal where a migration
   * failed, its message naming the versions and the cause, and is absent for
   * damage. `fromEarlierRelease` is set where no migration failed and the
   * envelope predates the exchange-record reset at release 0.9.0
   * ({@link storedEnvelopePredatesRecordReset}): every entry is a record an
   * earlier release filed, which this build cannot read. */
  | {
      kind: "unreadable";
      stored: RecoveredDisclosureAccounting | undefined;
      migrationFailure?: FormatMigrationError;
      fromEarlierRelease?: true;
    }
  /** A stored value the validating parse refused whose envelope declares a
   * LATER accounting version, or whose entries name a LATER exchange-record
   * format, than this build admits: the records are fine and this PAGE is
   * behind them (see {@link storedEnvelopeAheadOfThisBuild} and
   * {@link storedEntriesAheadOfThisBuild}). Its recovery is to reload onto the
   * build that wrote them, never the reset -- which would destroy records the
   * current build reads. `stored` is the same envelope-only value, since
   * handing back stored bytes claims nothing either way, and is `undefined`
   * where the envelope itself is the later one. */
  | { kind: "stale-page"; stored: RecoveredDisclosureAccounting | undefined };

/** The stored value held only to its envelope, or `undefined` when even that
 * refuses, under the envelope version it was stored at. Never a rendering
 * source: these are the entries the validating parse declined to vouch for, fit
 * for handing back to the operator as stored bytes and for nothing else (see
 * {@link parseStoredDisclosureAccounting}). */
function recoverableStored(
  raw: unknown,
  migrations: FormatMigrations<string>,
): RecoveredDisclosureAccounting | undefined {
  try {
    const { entries } = parseStoredDisclosureAccounting(raw, migrations);
    return {
      version: (raw as Record<string, unknown>)["version"] as string,
      entries,
    };
  } catch {
    return undefined;
  }
}

/**
 * Classify `raw`, a stored accounting {@link parseDisclosureAccounting} refused
 * with `refusal`, by which side is behind. The envelope's own version is read
 * first: a later one is a stale page, and one before the exchange-record reset
 * is stranded whatever its entries name. Only then do the entries' record
 * versions decide, a later one making a stale page.
 *
 * @param migrations the envelope's migrations; this build's by default.
 */
export function classifyRefusedDisclosureAccounting(
  raw: unknown,
  refusal: unknown,
  migrations: FormatMigrations<string> = DISCLOSURE_ACCOUNTING_MIGRATIONS,
): RefusedDisclosureAccounting {
  if (storedEnvelopeAheadOfThisBuild(raw))
    return { kind: "stale-page", stored: undefined };
  const stored = recoverableStored(raw, migrations);
  const migrationFailure =
    refusal instanceof FormatMigrationError ? refusal : undefined;
  if (storedEnvelopePredatesRecordReset(raw))
    return migrationFailure === undefined
      ? { kind: "unreadable", stored, fromEarlierRelease: true }
      : { kind: "unreadable", stored, migrationFailure };
  if (stored !== undefined && storedEntriesAheadOfThisBuild(stored))
    return { kind: "stale-page", stored };
  return {
    kind: "unreadable",
    stored,
    ...(migrationFailure === undefined ? {} : { migrationFailure }),
  };
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
