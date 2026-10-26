import { describe, expect, test } from "vitest";

import { UNNAMED_PARTY_LABEL } from "@alcove/core";

import {
  DISCLOSED_AT_LABEL,
  DISCLOSURE_FACT_LABELS,
  FILEABLE_DISCLOSURE_NOTE,
  PARTIAL_DISCLOSURE_LABEL,
  UNBUILT_DISCLOSURE_NOTE,
  UNREADABLE_DISCLOSURE_NOTE,
  disclosureAccountingCsv,
  disclosureAccountingFileName,
  disclosureEntries,
  disclosureFacts,
  storedDisclosureAccountingDocument,
  storedDisclosureAccountingFileName,
  unfiledDisclosureRows,
} from "../../../src/recurring/disclosureAccountingModel.js";
import {
  DISCLOSURE_ACCOUNTING_VERSION,
  appendDisclosureRecord,
} from "../../../src/psi/disclosureAccounting.js";

import { disclosureRecord } from "../../utils/disclosureFixtures.js";

import type { DisclosureAccounting } from "../../../src/psi/disclosureAccounting.js";
import type { DisclosureFact } from "../../../src/recurring/disclosureAccountingModel.js";
import type { ExchangeRecord } from "@alcove/core";

/**
 * The accounting of disclosures as a reader meets it: the per-run facts on screen
 * and the CSV a compliance reader is handed. Every assertion here is against facts
 * read off a record core built, so a field the accounting stopped sourcing from the
 * record would fail rather than pass against a fixture literal.
 */

/** The accounting these runs' records form, filed in order. */
function accountingOf(...records: Array<ExchangeRecord>): DisclosureAccounting {
  return records.reduce<DisclosureAccounting>(
    (current, record) => appendDisclosureRecord(current, record),
    { version: DISCLOSURE_ACCOUNTING_VERSION, entries: [] },
  );
}

/** One labelled fact. */
function factNamed(
  facts: ReadonlyArray<DisclosureFact>,
  label: string,
): DisclosureFact {
  const found = facts.find((fact) => fact.label === label);
  if (found === undefined) throw new Error(`no fact labelled ${label}`);
  return found;
}

/** The values of one labelled fact, or its named empty state when it holds
 * none. */
function factValues(
  facts: ReadonlyArray<DisclosureFact>,
  label: string,
): Array<string> {
  const found = factNamed(facts, label);
  return found.values.length === 0 ? [found.muted] : [...found.values];
}

/** The exported CSV split into physical rows, the trailing terminator dropped. */
function csvRows(csv: string): Array<string> {
  return csv.split("\r\n").slice(0, -1);
}

describe("a disclosure's facts", () => {
  test("name an unnamed partner as unnamed, on screen and in the export", () => {
    // `linkage_terms.identity` is optional, so a record can name no partner. The
    // accounting is a compliance reader's artifact: a blank Partner cell would
    // be treated as a rendering fault, and a stand-in would assert a party nobody
    // named. Both the on-screen fact and the exported row say what happened.
    return disclosureRecord({ partnerIdentity: null }).then((record) => {
      expect("partnerIdentity" in record).toBe(false);
      expect(factValues(disclosureFacts(record), "Partner")).toEqual([
        UNNAMED_PARTY_LABEL,
      ]);
      expect(disclosureEntries(accountingOf(record))[0].partner).toBe(
        UNNAMED_PARTY_LABEL,
      );
      expect(disclosureAccountingCsv(accountingOf(record))).toContain(
        UNNAMED_PARTY_LABEL,
      );
    });
  });

  test("state the accounting's fields from the run's own record", async () => {
    const record = await disclosureRecord({
      partnerIdentity: "Riverbend Schools",
      recordsExposed: 2,
      resultSize: 1,
      retentionDisposition: "Filed in the 2026 evaluation share, 3-year hold",
    });

    const facts = disclosureFacts(record);

    expect(factValues(facts, "Partner")).toEqual([record.partnerIdentity]);
    expect(factValues(facts, "Agreement")).toEqual(["MOU-2025-0042"]);
    expect(factValues(facts, "Purpose of the disclosure")).toEqual([
      "Evaluate shared program enrollment",
    ]);
    expect(factValues(facts, "What was disclosed")).toEqual([
      "Which records you both hold",
    ]);
    // The categories are the columns the record committed, with the data-dictionary
    // description where one was declared.
    expect(factValues(facts, "Columns you sent")).toEqual([
      "dose - Administered dose",
    ]);
    expect(factValues(facts, "Columns you received")).toEqual(["clinic"]);
    expect(factValues(facts, "Matched on")).toEqual([
      "date_of_birth (date_of_birth)",
      "last_name (last_name)",
    ]);
    expect(factValues(facts, "Records you exposed")).toEqual(["2"]);
    expect(factValues(facts, "Result size")).toEqual(["1"]);
    expect(factValues(facts, "Where the result was filed")).toEqual([
      "Filed in the 2026 evaluation share, 3-year hold",
    ]);
  });

  test("say a result size was not recorded rather than inferring one", async () => {
    // The record omits the result size unless both parties' terms had them both
    // receive output, so the accounting reports the omission as what it is.
    const record = await disclosureRecord({ resultSize: null });
    expect(record.resultSize).toBeUndefined();

    expect(factValues(disclosureFacts(record), "Result size")).toEqual([
      "Not recorded - only one party received the result",
    ]);
  });

  test("name the missing agreement rather than leaving the cell blank", async () => {
    const record = await disclosureRecord({ legalAgreement: null });

    const facts = disclosureFacts(record);

    expect(factValues(facts, "Agreement")).toEqual(["Not recorded"]);
    expect(factValues(facts, "Purpose of the disclosure")).toEqual([
      "Not recorded",
    ]);
  });

  test("read a count-only run as the count-only disclosure it was", async () => {
    const record = await disclosureRecord({ algorithm: "psi-c" });

    expect(factValues(disclosureFacts(record), "What was disclosed")).toEqual([
      "How many records you both hold - a count only, no identifiers",
    ]);
  });

  test("escape partner-controlled text at this display boundary, leaving the record byte-exact", async () => {
    // A record stores the partner's identity byte-for-byte, as the cross-party
    // validation needs; this module is the sink that renders it, so the bidi
    // override and the escape byte reach the reader as visible escapes.
    const deceptive = "Riverbend‮Schools[31m";
    const record = await disclosureRecord({ partnerIdentity: deceptive });
    expect(record.partnerIdentity).toBe(deceptive);

    const [partner] = factValues(disclosureFacts(record), "Partner");

    expect(partner).toBe("Riverbend\\u202eSchools\\x1b[31m");
  });

  test("state how the exchange ended, so a terminated run does not display as a completed one", async () => {
    // The record is written once the exchange has disclosed, whether or not the
    // signed-receipt swap after it completed (docs/spec/EXCHANGE_RECORD.md, When
    // a record is owed). Both entries are real disclosures, and this row is what
    // keeps a reader of the accounting from taking them for the same thing.
    const completed = disclosureFacts(await disclosureRecord());
    expect(factValues(completed, "How the exchange ended")).toEqual([
      "Completed",
    ]);

    const terminated = disclosureFacts(
      await disclosureRecord({ outcome: "receipt-swap-terminated" }),
    );
    expect(factValues(terminated, "How the exchange ended")).toEqual([
      "Disclosed, then stopped before the run finished",
    ]);
  });

  test("state an observed certificate mismatch beside the outcome, and only where the record has one", async () => {
    // The one arm where the record narrows who received the disclosure. It is a
    // value on the outcome fact rather than a column of its own, so the export's
    // header row is the same for every entry (docs/spec/EXCHANGE_RECORD.md, When
    // a record is owed).
    const refused = disclosureFacts(
      await disclosureRecord({
        outcome: "receipt-swap-terminated",
        certificateMismatchObserved: true,
      }),
    );
    const values = factValues(refused, "How the exchange ended");

    expect(values).toHaveLength(2);
    expect(values[0]).toBe("Disclosed, then stopped before the run finished");
    expect(values[1]).toContain("other than the one pinned for them");

    // A record observing none states nothing about the partner's certificate:
    // what every other entry shows for its partner is the self-asserted name the
    // Partner fact already holds, and a "no mismatch" line would read as a
    // confirmation the exchange never made.
    for (const record of [
      await disclosureRecord(),
      await disclosureRecord({ outcome: "receipt-swap-terminated" }),
    ]) {
      const stated = factValues(
        disclosureFacts(record),
        "How the exchange ended",
      );
      expect(stated).toHaveLength(1);
      expect(stated[0]).not.toContain("certificate");
    }
  });

  test("name no step of the run a terminated record does not prove it reached", async () => {
    // `receipt-swap-terminated` is written for every termination past this party's
    // payload send, so wording naming the receipt swap would tell a reader the run
    // reached a step it may never have started (docs/spec/EXCHANGE_RECORD.md, When
    // a record is owed).
    const terminated = disclosureFacts(
      await disclosureRecord({ outcome: "receipt-swap-terminated" }),
    );

    expect(factValues(terminated, "How the exchange ended")[0]).not.toContain(
      "receipt",
    );
  });

  test("qualify a terminated run's entry with what it cannot attest", async () => {
    // The entry must not read as a delivered disclosure: a record attests this
    // party's own act of sending and never the partner's receipt of it. The
    // qualification rides the outcome fact -- the one fact of such an entry that
    // always holds a value -- so it survives into the exported CSV as well.
    const terminated = disclosureFacts(
      await disclosureRecord({ outcome: "receipt-swap-terminated" }),
    );
    const outcome = factNamed(terminated, "How the exchange ended");

    expect(outcome.note).toContain("not confirmed");
    expect(outcome.note).toContain("no result file");
    expect(
      factNamed(
        disclosureFacts(await disclosureRecord()),
        "How the exchange ended",
      ).note,
    ).toBeUndefined();
  });

  test("say of a terminated run's result what the same entry's result size does not deny", async () => {
    // Core binds resultSize on a terminated record under the entitlement gate a
    // completed one takes, so the entry reports the intersection the exchange had
    // computed. What the run did not do is write a result file
    // (docs/spec/EXCHANGE_RECORD.md), which is what the note states: a note
    // denying a result outright would contradict the number beside it.
    const terminated = disclosureFacts(
      await disclosureRecord({
        outcome: "receipt-swap-terminated",
        resultSize: 3,
      }),
    );

    expect(factValues(terminated, "Result size")).toEqual(["3"]);
    expect(factNamed(terminated, "How the exchange ended").note).not.toContain(
      "no result was produced",
    );
  });

  test("name a terminated run's received columns as what arrived, not as what it accepted", async () => {
    // A run stopped by the received-payload refusal commits the very column names
    // it refused, so the label an operator reads beside them must not say the run
    // received and kept them (docs/spec/EXCHANGE_RECORD.md, When a record is
    // owed). The record itself is unchanged: the same names, under a label that
    // states when they arrived.
    const record = await disclosureRecord({
      outcome: "receipt-swap-terminated",
      partnerPayloadColumn: "ward",
    });

    const terminated = disclosureFacts(record);

    expect(
      record.governance.payloadReceived.map((column) => column.name),
    ).toEqual(["ward"]);
    expect(
      factValues(terminated, "Columns that arrived before the run stopped"),
    ).toEqual(["ward"]);
    expect(
      terminated.some((fact) => fact.label === "Columns you received"),
    ).toBe(false);
  });

  test("keep a terminated run's facts in the columns the export names", async () => {
    // The export's header is one row over every entry, so a relabelled fact must
    // still be the same column in the same position: an entry whose facts had
    // moved would export its values under another run's column headings.
    const terminated = disclosureFacts(
      await disclosureRecord({ outcome: "receipt-swap-terminated" }),
    );
    const completed = disclosureFacts(await disclosureRecord());

    expect(terminated).toHaveLength(completed.length);
    expect(
      terminated.map((fact, index) =>
        fact.label === completed[index].label ? fact.label : "relabelled",
      ),
    ).toEqual(
      DISCLOSURE_FACT_LABELS.map((label) =>
        label === "Columns you received" ? "relabelled" : label,
      ),
    );
  });

  test("state the labels the export's columns are named for", async () => {
    // The exported header is stated once so an empty accounting still has one; this
    // pins it against the facts a real record produces, so the two cannot drift.
    const facts = disclosureFacts(await disclosureRecord());

    expect(facts.map((fact) => fact.label)).toEqual([
      ...DISCLOSURE_FACT_LABELS,
    ]);
  });
});

describe("the accounting's entries", () => {
  test("are one per filed run, newest first, keyed by the run's own instant", async () => {
    const accounting = accountingOf(
      await disclosureRecord({ createdAt: "2026-07-01T09:00:00.000Z" }),
      await disclosureRecord({ createdAt: "2026-08-01T09:00:00.000Z" }),
    );

    const entries = disclosureEntries(accounting);

    expect(entries.map((entry) => entry.at)).toEqual([
      "2026-08-01T09:00:00.000Z",
      "2026-07-01T09:00:00.000Z",
    ]);
    expect(entries[0].when).toContain("2026");
  });

  test("hold the partner at the display boundary for the collapsed summary", async () => {
    const accounting = accountingOf(
      await disclosureRecord({ partnerIdentity: "Riverbend‮Schools" }),
    );

    expect(disclosureEntries(accounting)[0].partner).toBe(
      "Riverbend\\u202eSchools",
    );
  });

  test("hold the record's own bindingNonce as the entry's identity, distinct even when two runs share a createdAt", async () => {
    // createdAt is millisecond-resolution and not guaranteed unique (rapid
    // re-runs, a browser that coarsens Date resolution); bindingNonce is the
    // record's own CSPRNG-generated per-run identity (see appendDisclosureRecord
    // in disclosureAccounting.ts), so it is what the view keys and toggles on.
    const sharedCreatedAt = "2026-07-01T09:00:00.000Z";
    const accounting = accountingOf(
      await disclosureRecord({ createdAt: sharedCreatedAt }),
      await disclosureRecord({ createdAt: sharedCreatedAt }),
    );

    const [first, second] = disclosureEntries(accounting);

    expect(first.at).toBe(sharedCreatedAt);
    expect(second.at).toBe(sharedCreatedAt);
    expect(first.bindingNonce).not.toBe(second.bindingNonce);
    expect(first.bindingNonce).toBe(accounting.entries[1].bindingNonce);
    expect(second.bindingNonce).toBe(accounting.entries[0].bindingNonce);
  });

  test("mark a run that stopped after sending, so the list distinguishes it from a completed one", async () => {
    // The list shows one collapsed line per entry, so an entry attesting an
    // unconfirmed send has to state that where the operator reads the list rather
    // than only inside the entry they may never open.
    const accounting = accountingOf(
      await disclosureRecord({ createdAt: "2026-07-01T09:00:00.000Z" }),
      await disclosureRecord({
        createdAt: "2026-08-01T09:00:00.000Z",
        outcome: "receipt-swap-terminated",
      }),
    );

    const entries = disclosureEntries(accounting);

    expect(entries.map((entry) => entry.partial)).toEqual([true, false]);
    expect(PARTIAL_DISCLOSURE_LABEL).not.toBe("");
  });
});

/**
 * The rows for the runs the accounting is short. What each row says is left to
 * do must match what the browser holds for that run: two runs are equally
 * unfilable while one has a record at rest and the other never had one.
 */
describe("the runs the accounting is short", () => {
  test("a retained record says it can still be filed", async () => {
    const missed = await disclosureRecord();

    const [row] = unfiledDisclosureRows([
      { at: missed.createdAt, record: missed },
    ]);

    expect(row.fileable).toBe(true);
    expect(row.note).toBe(FILEABLE_DISCLOSURE_NOTE);
  });

  test("a run that built no record says none was made", () => {
    const [row] = unfiledDisclosureRows([{ at: "2026-08-01T09:00:00.000Z" }]);

    expect(row.fileable).toBe(false);
    expect(row.note).toBe(UNBUILT_DISCLOSURE_NOTE);
    expect(row.note).toContain("No record of this run was made");
  });

  test("a record this build cannot read says that, not that none is kept", () => {
    const [row] = unfiledDisclosureRows([
      { at: "2026-08-01T09:00:00.000Z", unreadableRecordRetained: true },
    ]);

    // The bytes are still in this browser; only this version's refusal makes the
    // run unfilable, so the copy must not report that nothing was kept.
    expect(row.fileable).toBe(false);
    expect(row.note).toBe(UNREADABLE_DISCLOSURE_NOTE);
    expect(row.note).toContain("cannot be read by this version of the app");
    expect(row.note).not.toContain("No record");
  });
});

describe("the exported accounting", () => {
  test("is a header row plus one row per run, oldest first", async () => {
    const accounting = accountingOf(
      await disclosureRecord({ createdAt: "2026-07-01T09:00:00.000Z" }),
      await disclosureRecord({ createdAt: "2026-08-01T09:00:00.000Z" }),
    );

    const rows = csvRows(disclosureAccountingCsv(accounting));

    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe(
      [DISCLOSED_AT_LABEL, ...DISCLOSURE_FACT_LABELS]
        .map((label) => `"${label}"`)
        .join(","),
    );
    // The screen reads newest first and the export oldest first, so the exported
    // rows are the entry order reversed.
    const [newest, oldest] = disclosureEntries(accounting);
    expect(rows[1]).toContain(oldest.when);
    expect(rows[2]).toContain(newest.when);
  });

  test("has every fact of a run in its row", async () => {
    const accounting = accountingOf(
      await disclosureRecord({
        recordsExposed: 7,
        resultSize: 3,
        retentionDisposition: "Program share drive, 3-year hold",
      }),
    );

    const [, row] = csvRows(disclosureAccountingCsv(accounting));

    expect(row).toContain('"Riverbend Schools"');
    expect(row).toContain('"MOU-2025-0042"');
    expect(row).toContain('"Evaluate shared program enrollment"');
    expect(row).toContain('"dose - Administered dose"');
    expect(row).toContain('"clinic"');
    expect(row).toContain('"7"');
    expect(row).toContain('"3"');
    expect(row).toContain('"Program share drive, 3-year hold"');
  });

  test("states a stopped run's outcome and what it cannot attest in that run's row", async () => {
    // The export is where a compliance reader meets the entry without the screen
    // around it, so the row has to state the same qualification the screen shows:
    // a file asserting more than the screen did would read an unconfirmed send as
    // a delivered one.
    const accounting = accountingOf(
      await disclosureRecord({ outcome: "receipt-swap-terminated" }),
    );

    const [header, row] = csvRows(disclosureAccountingCsv(accounting));
    const cell =
      splitCsvRow(row)[splitCsvRow(header).indexOf("How the exchange ended")];

    expect(cell).toContain("Disclosed, then stopped before the run finished");
    expect(cell).toContain("not confirmed");
    // The header names one set of columns for every entry, so the received names
    // sit under the standing heading and this note is where the file says what
    // they are.
    expect(splitCsvRow(header)).toContain("Columns you received");
    expect(
      splitCsvRow(row)[splitCsvRow(header).indexOf("Columns you received")],
    ).toBe("clinic");
    expect(cell).toContain("recorded as received");
  });

  test("states an observed certificate mismatch in the same cell, under the standing header", async () => {
    const accounting = accountingOf(
      await disclosureRecord({
        outcome: "receipt-swap-terminated",
        certificateMismatchObserved: true,
      }),
    );

    const [header, row] = csvRows(disclosureAccountingCsv(accounting));
    const columns = splitCsvRow(header);
    const cell = splitCsvRow(row)[columns.indexOf("How the exchange ended")];

    expect(cell).toContain("Disclosed, then stopped before the run finished");
    expect(cell).toContain("other than the one pinned for them");
    // The note names the fact it qualifies rather than a position on screen:
    // in the export that fact is a column of this same row, and the screen's
    // vertical list shows the same label.
    expect(cell).toContain("The name under Partner");
    expect(columns).toContain("Partner");
    // The marker widens no entry's column set: the header a compliance reader
    // reads is the same one every other accounting exports.
    expect(columns).toEqual(
      splitCsvRow(
        csvRows(
          disclosureAccountingCsv(accountingOf(await disclosureRecord())),
        )[0],
      ),
    );
  });

  test("quotes a value holding the delimiter, so a comma cannot shift the columns", async () => {
    const accounting = accountingOf(
      await disclosureRecord({
        legalAgreement: {
          reference: "MOU-2025-0042",
          purpose: "Enrollment, attendance, and outcomes",
          expirationDate: "2027-01-01",
        },
      }),
    );

    const [header, row] = csvRows(disclosureAccountingCsv(accounting));

    expect(row).toContain('"Enrollment, attendance, and outcomes"');
    // The row still has exactly one cell per header column: the comma inside the
    // quoted purpose did not become a delimiter.
    expect(splitCsvRow(row)).toHaveLength(splitCsvRow(header).length);
  });

  test("doubles an embedded quote rather than closing the cell early", async () => {
    const accounting = accountingOf(
      await disclosureRecord({ partnerIdentity: 'Riverbend "Schools"' }),
    );

    const [, row] = csvRows(disclosureAccountingCsv(accounting));

    expect(row).toContain('"Riverbend ""Schools"""');
  });

  test("separates a multi-value cell with a newline no value can itself hold", async () => {
    // The display boundary escapes every non-printable-ASCII code point, so a
    // newline inside a quoted cell is unambiguously the separator. A partner
    // planting one in a column name gets the escape, not a second line.
    const record = await disclosureRecord({
      partnerIdentity: "Riverbend\nSchools",
    });
    const accounting = accountingOf(record);

    const [, row] = csvRows(disclosureAccountingCsv(accounting));

    expect(row).toContain('"Riverbend\\x0aSchools"');
    expect(splitCsvRow(row)).toHaveLength(DISCLOSURE_FACT_LABELS.length + 1);
  });

  test("neutralizes every formula lead, in each cell the partner chose the value of", async () => {
    // The partner identity, the agreement reference and purpose, and the payload
    // column names are all values the partner chose, and this file is opened in a
    // spreadsheet by a compliance reader. Each of the four leads the guard names is
    // driven, one per partner-chosen cell, so no lead is covered only by argument.
    const accounting = accountingOf(
      await disclosureRecord({
        partnerIdentity: '=HYPERLINK("http://elsewhere.example","click")',
        legalAgreement: {
          reference: "+MOU-2025-0042",
          purpose: "-1+1",
          expirationDate: "2027-01-01",
        },
        partnerPayloadColumn: "@SUM(A1:A9)",
      }),
    );

    const [, row] = csvRows(disclosureAccountingCsv(accounting));

    expect(row).toContain(
      '"\'=HYPERLINK(""http://elsewhere.example"",""click"")"',
    );
    expect(row).toContain('"\'+MOU-2025-0042"');
    expect(row).toContain('"\'-1+1"');
    expect(row).toContain('"\'@SUM(A1:A9)"');
  });

  test("leaves a tab- or return-led value unprefixed, the display boundary having escaped the lead", async () => {
    // Tab and carriage return are formula leads a spreadsheet honors, and the
    // guard does not list them: a value reaches a cell only through
    // the display boundary, which escapes every non-printable-ASCII code point, so
    // what leads the cell is a backslash rather than the control character. Pinned
    // here so the narrowing is checked rather than argued.
    const accounting = accountingOf(
      await disclosureRecord({
        partnerIdentity: "\tRiverbend Schools",
        legalAgreement: {
          reference: "\rMOU-2025-0042",
          purpose: "Evaluate shared program enrollment",
          expirationDate: "2027-01-01",
        },
      }),
    );

    const [, row] = csvRows(disclosureAccountingCsv(accounting));

    expect(row).toContain('"\\x09Riverbend Schools"');
    expect(row).toContain('"\\x0dMOU-2025-0042"');
    expect(row).not.toContain("\t");
    expect(row).not.toContain("\r");
  });

  test("exports its header even with no entries, so an empty accounting is still an answer", () => {
    const rows = csvRows(disclosureAccountingCsv(accountingOf()));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(`"${DISCLOSED_AT_LABEL}"`);
  });

  test("names the download by the export instant", () => {
    expect(
      disclosureAccountingFileName(new Date("2026-08-20T12:30:00.000Z")),
    ).toBe("alcove-disclosures-2026-08-20T12-30-00-000Z.csv");
  });
});

/**
 * The stored-form export: the file an operator recovers an accounting into when
 * this build's exchange-record format can no longer read the entries. Its whole
 * contract is that it asserts nothing about them -- it hands back what is at rest,
 * so the entries must survive it byte-for-byte in content.
 */
describe("the stored accounting as a recovery file", () => {
  /** Entries as they would sit at rest after a record-version move: the format's
   * own fields, under a version this build does not admit. */
  const storedEntries: ReadonlyArray<unknown> = [
    {
      version: "alcove-exchange-record/v-moved",
      createdAt: "2026-07-01T09:00:00.000Z",
      partnerIdentity: "Riverbend Schools",
      recordsExposed: 11,
      fieldTheFormatNoLongerCarries: ["kept anyway"],
    },
    {
      version: "alcove-exchange-record/v-moved",
      createdAt: "2026-08-01T09:00:00.000Z",
      partnerIdentity: "Falls County Clinic",
      recordsExposed: 23,
    },
  ];

  test("retains every entry verbatim, including fields this build has no meaning for", () => {
    const document = storedDisclosureAccountingDocument({
      version: DISCLOSURE_ACCOUNTING_VERSION,
      entries: storedEntries,
    });

    // Deep equality after a round trip, not a spot check on a field: the export's
    // one job is to lose nothing, and a field the current format does not hold is
    // exactly the field a bump would have made unreadable.
    expect(JSON.parse(document)).toEqual({
      version: DISCLOSURE_ACCOUNTING_VERSION,
      entries: storedEntries,
    });
  });

  test("has no reading of the entries, only the stored shape", () => {
    const document = storedDisclosureAccountingDocument({
      version: DISCLOSURE_ACCOUNTING_VERSION,
      entries: storedEntries,
    });

    // The CSV's column labels are this app's reading of a record under the CURRENT
    // format's meaning. An entry from another version licenses none of it, so the
    // recovery file must hold the record's own field names and no label of ours.
    for (const label of DISCLOSURE_FACT_LABELS)
      expect(document).not.toContain(label);
    expect(document).toContain("partnerIdentity");
  });

  test("an accounting with no entries still recovers as a document", () => {
    expect(
      JSON.parse(
        storedDisclosureAccountingDocument({
          version: DISCLOSURE_ACCOUNTING_VERSION,
          entries: [],
        }),
      ),
    ).toEqual({ version: DISCLOSURE_ACCOUNTING_VERSION, entries: [] });
  });

  test("names the download by the export instant, apart from the CSV's name", () => {
    const exportedAt = new Date("2026-08-20T12:30:00.000Z");

    expect(storedDisclosureAccountingFileName(exportedAt)).toBe(
      "alcove-disclosures-stored-2026-08-20T12-30-00-000Z.json",
    );
    // Two forms of one accounting must not land in a downloads folder under one
    // name: only one of them is a reading a compliance reader can rely on.
    expect(storedDisclosureAccountingFileName(exportedAt)).not.toBe(
      disclosureAccountingFileName(exportedAt),
    );
  });
});

/** Split one CSV row into its cells, honoring the quoting the writer emits: a
 * comma or a newline inside a quoted cell is data, and a doubled quote is one
 * quote. Written here rather than reusing the writer's own escaping, so a row the
 * writer mis-quoted is not parsed back by the same mistake. */
function splitCsvRow(row: string): Array<string> {
  const cells: Array<string> = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (row[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }
  cells.push(cell);
  return cells;
}
