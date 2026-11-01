import { describe, expect, test } from "vitest";

import { EXCHANGE_RECORD_VERSION, FormatMigrationError } from "@alcove/core";

import {
  DISCLOSURE_ACCOUNTING_MIGRATIONS,
  DISCLOSURE_ACCOUNTING_VERSION,
  appendDisclosureRecord,
  appendToStoredDisclosureAccounting,
  parseDisclosureAccounting,
  parseStoredDisclosureAccounting,
  storedEntriesAheadOfThisBuild,
  storedEnvelopeAheadOfThisBuild,
} from "../../../src/psi/disclosureAccounting.js";

import {
  UNMOVABLE_CAUSE,
  UNMOVABLE_FIELD,
  atPreviousVersion,
  nextVersionOf,
  previousVersionMigrations,
} from "../../utils/storedFormatMigrations.js";
import {
  disclosureRecord,
  neighbouringRecordVersion,
} from "../../utils/disclosureFixtures.js";

import type { DisclosureAccounting } from "../../../src/psi/disclosureAccounting.js";

/**
 * The stored shape of a managed exchange's accounting of disclosures: an entry is
 * one run's self-attested exchange record, verbatim, and the append that files it.
 *
 * A test asserting a summary of the record, rather than deep equality with what
 * core produced, would leave a derived-and-drifting store passing -- so this
 * suite checks the verbatim property directly.
 */

describe("the disclosure accounting's entries", () => {
  test("an appended entry is the run's exchange record, verbatim", async () => {
    const record = await disclosureRecord();

    const accounting = appendDisclosureRecord(undefined, record);

    expect(accounting.version).toBe(DISCLOSURE_ACCOUNTING_VERSION);
    expect(accounting.entries).toHaveLength(1);
    // Deep equality against core's own artifact: no field is dropped, renamed, or
    // summarized on its way into the accounting.
    expect(accounting.entries[0]).toEqual(record);
  });

  test("each run appends one entry, in run order", async () => {
    const first = await disclosureRecord({
      createdAt: "2026-07-01T09:00:00.000Z",
    });
    const second = await disclosureRecord({
      createdAt: "2026-08-01T09:00:00.000Z",
    });

    const accounting = appendDisclosureRecord(
      appendDisclosureRecord(undefined, first),
      second,
    );

    expect(accounting.entries.map((entry) => entry.createdAt)).toEqual([
      "2026-07-01T09:00:00.000Z",
      "2026-08-01T09:00:00.000Z",
    ]);
  });

  test("re-appending one run's record is a no-op, so a retried write cannot inflate the count", async () => {
    const record = await disclosureRecord();
    const filed = appendDisclosureRecord(undefined, record);

    const again = appendDisclosureRecord(filed, record);

    expect(again.entries).toHaveLength(1);
  });

  test("two runs with identical terms are two entries, told apart by their own binding nonces", async () => {
    // Same terms, same instant: what separates the two records is the per-exchange
    // binding nonce core generates locally for each, which is exactly what the
    // append matches on.
    const first = await disclosureRecord();
    const second = await disclosureRecord();
    expect(second.bindingNonce).not.toBe(first.bindingNonce);

    const accounting = appendDisclosureRecord(
      appendDisclosureRecord(undefined, first),
      second,
    );

    expect(accounting.entries).toHaveLength(2);
  });
});

describe("reading a stored accounting", () => {
  test("round-trips an accounting through the structured-clone shape a store holds", async () => {
    const accounting = appendDisclosureRecord(
      undefined,
      await disclosureRecord(),
    );

    const read = parseDisclosureAccounting(
      JSON.parse(JSON.stringify(accounting)),
    );

    expect(read).toEqual(accounting);
  });

  test("rejects an unrecognized format version rather than migrating it", async () => {
    const accounting = appendDisclosureRecord(
      undefined,
      await disclosureRecord(),
    );

    expect(() =>
      parseDisclosureAccounting({
        ...accounting,
        version: "alcove-disclosure-accounting/v3",
      }),
    ).toThrow();
  });

  test("rejects an entry that is not a valid exchange record, rather than dropping it", async () => {
    // A dropped entry would render as a shorter and quietly false account of what
    // this exchange disclosed, so the read fails instead.
    const accounting: DisclosureAccounting = {
      version: DISCLOSURE_ACCOUNTING_VERSION,
      entries: [await disclosureRecord()],
    };

    expect(() =>
      parseDisclosureAccounting({
        ...accounting,
        entries: [
          ...accounting.entries,
          { ...accounting.entries[0], version: "alcove-exchange-record/v100" },
        ],
      }),
    ).toThrow();
  });

  test("rejects an unknown key on the envelope", async () => {
    const accounting = appendDisclosureRecord(
      undefined,
      await disclosureRecord(),
    );

    expect(() =>
      parseDisclosureAccounting({ ...accounting, retainUntil: "2030-01-01" }),
    ).toThrow();
  });
});

/**
 * Assumption under test: a moved exchange-record version literal invalidates the
 * stored entries but leaves the envelope intact, so entries come back verbatim
 * through the envelope-only read. The bump is derived from core's constant, so
 * it stays non-current as that constant moves. Limit: a real bump also moves
 * the record's field set, so a real entry could fail for more than the version
 * alone.
 */
describe("a moved exchange-record version leaves the stored entries recoverable", () => {
  /** A stored accounting whose entries hold a record version this build does not
   * admit, as an app upgrade that moved the literal would leave at rest. */
  async function accountingFromAnotherRecordVersion(): Promise<unknown> {
    const record = await disclosureRecord();
    expect(record.version).toBe(EXCHANGE_RECORD_VERSION);
    return {
      version: DISCLOSURE_ACCOUNTING_VERSION,
      entries: [{ ...record, version: `${EXCHANGE_RECORD_VERSION}-moved` }],
    };
  }

  test("the entries reject and the envelope does not, which is what makes an export possible", async () => {
    const stored = await accountingFromAnotherRecordVersion();

    // One value, two reads: the validating read refuses it wholesale -- the state
    // an operator is stranded in -- while the envelope read returns it.
    expect(() => parseDisclosureAccounting(stored)).toThrow();
    expect(() => parseStoredDisclosureAccounting(stored)).not.toThrow();
  });

  test("the envelope read hands back every stored entry verbatim", async () => {
    const stored = (await accountingFromAnotherRecordVersion()) as {
      version: string;
      entries: Array<unknown>;
    };

    const recovered = parseStoredDisclosureAccounting(stored);

    // Deep equality against what is at rest, not a count: an export that dropped
    // or reshaped an entry would hand the operator a shorter account of what was
    // disclosed, which is the failure the validating read exists to prevent.
    expect(recovered.entries).toEqual(stored.entries);
    expect(recovered.version).toBe(DISCLOSURE_ACCOUNTING_VERSION);
  });

  test("a mix of admissible and inadmissible entries comes back whole", async () => {
    // The realistic post-upgrade shape: runs filed before the bump and runs filed
    // after it, in one accounting. The export must hold both.
    const current = await disclosureRecord();
    const earlier = {
      ...(await disclosureRecord()),
      version: `${EXCHANGE_RECORD_VERSION}-moved`,
    };
    const stored = {
      version: DISCLOSURE_ACCOUNTING_VERSION,
      entries: [earlier, current],
    };

    expect(() => parseDisclosureAccounting(stored)).toThrow();
    expect(parseStoredDisclosureAccounting(stored).entries).toEqual([
      earlier,
      current,
    ]);
  });
});

/**
 * Which direction a refused entry's version differs in separates a stranded
 * accounting (this build is ahead -- the app-upgrade case the destructive
 * recovery exists for) from a stale page (this build is behind). Both directions
 * are driven from core's own constant, not a hard-coded literal beside it.
 *
 * {@link neighbouringRecordVersion} throws rather than falling back when core's
 * literal holds no ordinal to count from, so a broken ordering cannot pass
 * silently.
 */
describe("telling a stranded accounting from a stale page", () => {
  /** A stored accounting holding exactly these entries. */
  function storedWith(entries: Array<unknown>) {
    return parseStoredDisclosureAccounting({
      version: DISCLOSURE_ACCOUNTING_VERSION,
      entries,
    });
  }

  test("an entry from a later record format says this page is behind", async () => {
    const record = await disclosureRecord();
    const later = neighbouringRecordVersion(1);
    expect(later).not.toBe(EXCHANGE_RECORD_VERSION);

    expect(
      storedEntriesAheadOfThisBuild(
        storedWith([{ ...record, version: later }]),
      ),
    ).toBe(true);
  });

  test("an entry from an earlier record format does not", async () => {
    // The app-upgrade direction: this build is current, the entries are stranded,
    // and the export-then-reset recovery is what gets them out.
    const record = await disclosureRecord();

    expect(
      storedEntriesAheadOfThisBuild(
        storedWith([{ ...record, version: neighbouringRecordVersion(-1) }]),
      ),
    ).toBe(false);
  });

  test("entries this build admits are not ahead of it", async () => {
    const record = await disclosureRecord();
    expect(record.version).toBe(EXCHANGE_RECORD_VERSION);

    expect(storedEntriesAheadOfThisBuild(storedWith([record]))).toBe(false);
  });

  test("one later entry beside admissible ones is enough", async () => {
    // Mixed, so the reading is not "everything here is newer" but "something here
    // is": the build that should decide what to do about the rest is the current
    // one, which this page is not running.
    const record = await disclosureRecord();
    const later = { ...record, version: neighbouringRecordVersion(1) };

    expect(storedEntriesAheadOfThisBuild(storedWith([record, later]))).toBe(
      true,
    );
  });

  test("a version literal it cannot order is not ahead", async () => {
    // Another family, an unparsable literal, and an entry that is not an object
    // at all: nothing can be concluded from any of them, so each keeps the
    // app-upgrade reading -- the one that offers a way out.
    const record = await disclosureRecord();

    for (const entry of [
      { ...record, version: `${EXCHANGE_RECORD_VERSION}-moved` },
      { ...record, version: "alcove-disclosure-accounting/v100" },
      { ...record, version: "alcove-exchange-record/vNext" },
      { ...record, version: 6 },
      "one disclosure",
      null,
    ]) {
      expect(storedEntriesAheadOfThisBuild(storedWith([entry]))).toBe(false);
    }
  });

  test("a later version written with a leading zero is not ahead", async () => {
    const record = await disclosureRecord();
    const later = neighbouringRecordVersion(1).replace("/v", "/v0");

    expect(
      storedEntriesAheadOfThisBuild(
        storedWith([{ ...record, version: later }]),
      ),
    ).toBe(false);
  });
});

describe("whether a stored envelope is ahead of this build", () => {
  test("a later envelope version is, whatever its entries", () => {
    const later = nextVersionOf(DISCLOSURE_ACCOUNTING_VERSION);
    expect(
      storedEnvelopeAheadOfThisBuild({ version: later, entries: [] }),
    ).toBe(true);
    expect(storedEnvelopeAheadOfThisBuild({ version: later })).toBe(true);
  });

  test("this version, an earlier one, or one it cannot order is not", () => {
    for (const version of [
      DISCLOSURE_ACCOUNTING_VERSION,
      "alcove-disclosure-accounting/v1",
      "alcove-disclosure-accounting/v03",
      "alcove-exchange-record/v99",
      undefined,
    ])
      expect(storedEnvelopeAheadOfThisBuild({ version, entries: [] })).toBe(
        false,
      );
    expect(storedEnvelopeAheadOfThisBuild(undefined)).toBe(false);
  });
});

describe("the envelope-only read is scoped to the envelope, not an override", () => {
  test("an accounting this version can read is returned unchanged by it", async () => {
    const accounting = appendDisclosureRecord(
      undefined,
      await disclosureRecord(),
    );

    expect(parseStoredDisclosureAccounting(accounting).entries).toEqual(
      accounting.entries,
    );
  });

  test("rejects an unrecognized accounting version, exactly as the validating read does", async () => {
    const accounting = appendDisclosureRecord(
      undefined,
      await disclosureRecord(),
    );

    expect(() =>
      parseStoredDisclosureAccounting({
        ...accounting,
        version: "alcove-disclosure-accounting/v3",
      }),
    ).toThrow();
  });

  test("rejects an unknown key on the envelope", async () => {
    const accounting = appendDisclosureRecord(
      undefined,
      await disclosureRecord(),
    );

    expect(() =>
      parseStoredDisclosureAccounting({
        ...accounting,
        retainUntil: "2030-01-01",
      }),
    ).toThrow();
  });

  test("rejects a value whose entries are not a list, so a corrupted envelope offers nothing", () => {
    // The state the recovery surface must distinguish from a version bump: there
    // is no export to offer, and the surface says so rather than handing over a
    // shape it cannot vouch for at all.
    expect(() =>
      parseStoredDisclosureAccounting({
        version: DISCLOSURE_ACCOUNTING_VERSION,
        entries: "one disclosure",
      }),
    ).toThrow();
  });
});

describe("an accounting an earlier version stored", () => {
  const rename = { field: "entries", storedName: "records" };
  const migrations = previousVersionMigrations(
    "The accounting of disclosures",
    "version",
    DISCLOSURE_ACCOUNTING_VERSION,
    rename,
  );

  test("is migrated in memory, the stored value unchanged", async () => {
    const record = await disclosureRecord();
    const stored = atPreviousVersion(
      { version: DISCLOSURE_ACCOUNTING_VERSION, entries: [record] },
      "version",
      rename,
    );
    const before = structuredClone(stored);

    expect(parseDisclosureAccounting(stored, migrations)).toEqual({
      version: DISCLOSURE_ACCOUNTING_VERSION,
      entries: [record],
    });
    expect(stored).toEqual(before);
  });

  test("is written at the current version by the next append", async () => {
    const [first, next] = [await disclosureRecord(), await disclosureRecord()];
    const stored = atPreviousVersion(
      { version: DISCLOSURE_ACCOUNTING_VERSION, entries: [first] },
      "version",
      rename,
    );

    expect(
      appendToStoredDisclosureAccounting(stored, next, migrations),
    ).toEqual({
      version: DISCLOSURE_ACCOUNTING_VERSION,
      entries: [first, next],
    });
    expect(
      appendToStoredDisclosureAccounting(stored, first, migrations),
    ).toEqual({ version: DISCLOSURE_ACCOUNTING_VERSION, entries: [first] });
  });

  test("whose migration fails is refused naming the cause, the stored value unchanged", async () => {
    const stored = {
      ...atPreviousVersion(
        {
          version: DISCLOSURE_ACCOUNTING_VERSION,
          entries: [await disclosureRecord()],
        },
        "version",
        rename,
      ),
      [UNMOVABLE_FIELD]: true,
    };
    const before = structuredClone(stored);
    const next = await disclosureRecord();

    expect(() => parseStoredDisclosureAccounting(stored, migrations)).toThrow(
      UNMOVABLE_CAUSE,
    );
    expect(() =>
      appendToStoredDisclosureAccounting(stored, next, migrations),
    ).toThrow(UNMOVABLE_CAUSE);
    expect(stored).toEqual(before);
  });

  test("at a version no step leads from is refused by name", () => {
    expect(() =>
      parseStoredDisclosureAccounting({
        version: "alcove-disclosure-accounting/v1",
        entries: [],
      }),
    ).toThrow(
      new FormatMigrationError(
        DISCLOSURE_ACCOUNTING_MIGRATIONS,
        "alcove-disclosure-accounting/v1",
        DISCLOSURE_ACCOUNTING_VERSION,
        "it has no migration from version alcove-disclosure-accounting/v1",
      ),
    );
  });
});

describe("the append writes the stored entries as they sit at rest", () => {
  test("a stored entry is written back as the value at rest, not a parse of it", async () => {
    // An entry is a past exchange record, never rewritten: the append writes
    // the stored value, not the reading the accounting's display takes of it.
    // The browser suite drives this with an entry a step migrates.
    const entry = await disclosureRecord();
    const stored = { version: DISCLOSURE_ACCOUNTING_VERSION, entries: [entry] };
    const next = await disclosureRecord();

    const written = appendToStoredDisclosureAccounting(stored, next);

    expect(written.entries[0]).toBe(entry);
    expect(written.entries[1]).toBe(next);
  });

  test("starts an accounting where none is stored", async () => {
    const record = await disclosureRecord();
    expect(appendToStoredDisclosureAccounting(undefined, record)).toEqual({
      version: DISCLOSURE_ACCOUNTING_VERSION,
      entries: [record],
    });
  });

  test("refuses an accounting holding an entry this build cannot read", async () => {
    const stranded = {
      ...(await disclosureRecord()),
      version: neighbouringRecordVersion(-1),
    };
    const next = await disclosureRecord();
    expect(() =>
      appendToStoredDisclosureAccounting(
        { version: DISCLOSURE_ACCOUNTING_VERSION, entries: [stranded] },
        next,
      ),
    ).toThrow(FormatMigrationError);
  });
});
