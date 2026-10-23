import { Readable } from "node:stream";

import { describe, expect, test } from "vitest";

import {
  StandardizedField,
  inferMetadata,
  lastNameColumn,
  loadCSVFile,
} from "@alcove/core";

import {
  buildKeyStrings,
  buildStandardizedDataset,
  personColumns,
} from "@alcove/core/testing";

import {
  SAMPLE_INVITER_CSV,
  SAMPLE_INVITER_FILE_NAME,
  SAMPLE_PARTNER_CSV,
  SAMPLE_PARTNER_FILE_NAME,
  SAMPLE_SHARED_RECORD_IDS,
} from "@psi/sampleData";
import {
  cleaningCoverageProblems,
  inviterCleaningAttention,
} from "@psi/inviterModel";
import { computeFieldCoverage } from "@psi/workers/nonEmptyAggregate";
import { editorFromCsv } from "@psi/inviterEditor";
import { samplePartnerFile } from "@exchange/sampleData";

import type { CSVRow, LinkageTerms } from "@alcove/core";

import type { AcquiredCsv } from "@psi/inviterEditor";

const INVITER_COLUMNS = [
  "record_id",
  "first_name",
  "last_name",
  "dob",
  "ssn",
  "sex",
  "zip",
  "income_flag",
];

const PARTNER_COLUMNS = [
  "record_id",
  "first_name",
  "last_name",
  "dob",
  "ssn",
  "sex",
  "phone",
  "email",
  "street_address_number",
  "street_name",
  "zip",
  "renewal_date",
];

const MASKED_SSN = /^\*\*\*-\*\*-\d{4}$/;
const FULL_SSN = /^\d{3}-\d{2}-\d{4}$/;

async function acquire(
  csvText: string,
  fileName: string,
): Promise<AcquiredCsv> {
  const result = await loadCSVFile(Readable.from(csvText));
  return {
    fileName,
    sizeBytes: csvText.length,
    rawRows: result.data,
    columns: result.meta.fields ?? [],
    rowCount: result.data.length,
  };
}

let sampleFilesRead: Promise<[AcquiredCsv, AcquiredCsv]> | undefined;

function sampleFiles(): Promise<[AcquiredCsv, AcquiredCsv]> {
  sampleFilesRead ??= Promise.all([
    acquire(SAMPLE_INVITER_CSV, SAMPLE_INVITER_FILE_NAME),
    acquire(SAMPLE_PARTNER_CSV, SAMPLE_PARTNER_FILE_NAME),
  ]);
  return sampleFilesRead;
}

function cell(row: CSVRow, column: string): string {
  return row[column] ?? "";
}

function rowsById(csv: AcquiredCsv): Map<string, CSVRow> {
  return new Map(csv.rawRows.map((row) => [cell(row, "record_id"), row]));
}

/** The two rows of each person in both files, inviter's first. */
async function sharedRows(): Promise<Array<[CSVRow, CSVRow]>> {
  const [inviter, partner] = await sampleFiles();
  const inviterById = rowsById(inviter);
  const partnerById = rowsById(partner);
  return SAMPLE_SHARED_RECORD_IDS.map(([inviterId, partnerId]) => {
    const inviterRow = inviterById.get(inviterId);
    const partnerRow = partnerById.get(partnerId);
    if (inviterRow === undefined || partnerRow === undefined)
      throw new Error(`no row for ${inviterId} or ${partnerId}`);
    return [inviterRow, partnerRow];
  });
}

/** A `M/D/YYYY` or `MM/DD/YYYY` date as `YYYY-MM-DD`. */
function calendarDate(value: string): string {
  const [month, day, year] = value.split("/");
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/** The fewest edits (an insert, delete, substitution, or swap of two adjacent
 * letters) that turn `a` into `b`. */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_row, i) =>
    Array.from({ length: b.length + 1 }, (_column, j) =>
      i === 0 ? j : j === 0 ? i : 0,
    ),
  );
  for (let i = 1; i <= a.length; i += 1)
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

/** The cleaned key strings each row of `csv` produces under `terms`, by key
 * name -- the strings the PSI intersection compares. `isReceiver` swaps the
 * swap keys' elements so the partner side is compared the way the exchange
 * compares it. */
function keyStringsByRow(
  csv: AcquiredCsv,
  terms: LinkageTerms,
  isReceiver: boolean,
): Array<Map<string, Set<string>>> {
  const { standardization, metadata } = editorFromCsv("Sample Org", csv).draft;
  const dataset = buildStandardizedDataset(
    standardization,
    csv.rawRows,
    metadata,
    terms,
    personColumns(standardization, metadata, terms, csv.rawRows),
    lastNameColumn(standardization, metadata, terms, csv.rawRows),
  );
  return csv.rawRows.map(
    (_, rowIndex) =>
      new Map(
        terms.linkageKeys.map((key) => [
          key.name,
          new Set(buildKeyStrings(key, dataset, rowIndex, isReceiver) ?? []),
        ]),
      ),
  );
}

/** A pair of rows the default terms match, by record id, with the first rule
 * in the terms' order that matches it. */
interface DefaultTermsMatch {
  inviterId: string;
  partnerId: string;
  rule: string;
}

/** Every (inviter, partner) pair the inviter's default terms match, over the
 * whole cross-product of the two files. */
async function defaultTermsMatches(): Promise<Array<DefaultTermsMatch>> {
  const [inviter, partner] = await sampleFiles();
  const terms = editorFromCsv("Sample Org", inviter).seed.terms;
  const inviterKeys = keyStringsByRow(inviter, terms, false);
  const partnerKeys = keyStringsByRow(partner, terms, true);
  const matches: Array<DefaultTermsMatch> = [];
  inviterKeys.forEach((inviterStrings, inviterIndex) => {
    partnerKeys.forEach((partnerStrings, partnerIndex) => {
      const rule = terms.linkageKeys.find((key) =>
        [...(inviterStrings.get(key.name) ?? [])].some(
          (value) => partnerStrings.get(key.name)?.has(value) === true,
        ),
      );
      if (rule !== undefined)
        matches.push({
          inviterId: cell(inviter.rawRows[inviterIndex], "record_id"),
          partnerId: cell(partner.rawRows[partnerIndex], "record_id"),
          rule: rule.name,
        });
    });
  });
  return matches;
}

describe("sample data", () => {
  test("each file parses to its agency's columns and row count", async () => {
    const [inviter, partner] = await sampleFiles();

    expect(inviter.columns).toEqual(INVITER_COLUMNS);
    expect(partner.columns).toEqual(PARTNER_COLUMNS);
    expect(inviter.rawRows).toHaveLength(100);
    expect(partner.rawRows).toHaveLength(200);
  });

  test("each row is a distinct person, with a record id prefix per side", async () => {
    const [inviter, partner] = await sampleFiles();

    for (const [csv, prefix] of [
      [inviter, /^INV-\d{4}$/],
      [partner, /^PTR-\d{4}$/],
    ] as const) {
      const ids = csv.rawRows.map((row) => cell(row, "record_id"));
      expect(new Set(ids).size).toBe(csv.rawRows.length);
      for (const id of ids) expect(id).toMatch(prefix);
      // No two rows of one file share a name and date of birth.
      const people = csv.rawRows.map((row) =>
        [row.first_name, row.last_name, calendarDate(cell(row, "dob"))].join(
          "|",
        ),
      );
      expect(new Set(people).size).toBe(csv.rawRows.length);
    }
  });

  test("exactly 50 people are in both files, each once per file", async () => {
    const [inviter, partner] = await sampleFiles();
    const inviterIds = SAMPLE_SHARED_RECORD_IDS.map(([id]) => id);
    const partnerIds = SAMPLE_SHARED_RECORD_IDS.map(([, id]) => id);

    expect(SAMPLE_SHARED_RECORD_IDS).toHaveLength(50);
    expect(new Set(inviterIds).size).toBe(50);
    expect(new Set(partnerIds).size).toBe(50);
    const inviterById = rowsById(inviter);
    const partnerById = rowsById(partner);
    for (const id of inviterIds) expect(inviterById.has(id)).toBe(true);
    for (const id of partnerIds) expect(partnerById.has(id)).toBe(true);
  });

  test("every partner cell is filled apart from the SSN", async () => {
    const [, partner] = await sampleFiles();
    for (const row of partner.rawRows)
      for (const column of PARTNER_COLUMNS)
        if (column !== "ssn") expect(cell(row, column)).not.toBe("");
  });

  test("every SSN is full, masked, or blank, and the default cleaning keeps each full one", async () => {
    const kinds = new Set<string>();
    for (const csv of await sampleFiles()) {
      const ssnCleaning = editorFromCsv(
        "Sample Org",
        csv,
      ).draft.standardization.find(
        (transformation) => transformation.output === "ssn",
      );
      if (ssnCleaning === undefined) throw new Error("no ssn cleaning");
      const field = new StandardizedField(
        ssnCleaning.output,
        ssnCleaning.input,
        ssnCleaning.steps ?? [],
        [],
      );
      for (const row of csv.rawRows) {
        const ssn = cell(row, "ssn");
        if (ssn === "") kinds.add("blank");
        else if (MASKED_SSN.test(ssn)) kinds.add("masked");
        else {
          expect(ssn).toMatch(FULL_SSN);
          expect(field.evaluateRow({ [ssnCleaning.input]: ssn })).toEqual([
            ssn.replaceAll("-", ""),
          ]);
          kinds.add("full");
        }
      }
    }
    expect([...kinds].sort()).toEqual(["blank", "full", "masked"]);
  });

  test("default cleaning yields an SSN for every full one and a last four for every SSN", async () => {
    for (const csv of await sampleFiles()) {
      const { standardization } = editorFromCsv("Sample Org", csv).draft;
      const rates = new Map(
        computeFieldCoverage(csv.rawRows, standardization).map((coverage) => [
          coverage.output,
          coverage,
        ]),
      );
      expect(rates.get("ssn")?.produced).toBe(
        csv.rawRows.filter((row) => FULL_SSN.test(cell(row, "ssn"))).length,
      );
      expect(rates.get("ssn4")?.produced).toBe(
        csv.rawRows.filter((row) => cell(row, "ssn") !== "").length,
      );
    }
  });

  test.each([
    [SAMPLE_INVITER_FILE_NAME, SAMPLE_INVITER_CSV],
    [SAMPLE_PARTNER_FILE_NAME, SAMPLE_PARTNER_CSV],
  ])(
    "default cleaning of %s shows no failing field and no coverage problem",
    async (fileName, csvText) => {
      const csv = await acquire(csvText, fileName);
      const editor = editorFromCsv("Sample Org", csv);
      expect(editor.draft.standardization.length).toBeGreaterThan(0);
      const rates = new Map(
        computeFieldCoverage(csv.rawRows, editor.draft.standardization).map(
          (coverage) => [coverage.output, coverage],
        ),
      );
      const attention = inviterCleaningAttention(editor, rates, false);
      expect(attention.failingFieldCount).toBe(0);
      expect(attention.needsAttention).toBe(false);
      // A coverage problem disables Create the invitation.
      expect(cleaningCoverageProblems(editor, rates)).toEqual([]);
      // Every name and date of birth survives cleaning, so none is a
      // placeholder the default cleaning drops.
      for (const field of ["first_name", "last_name", "date_of_birth"])
        expect(rates.get(field)?.produced).toBe(csv.rawRows.length);
    },
  );

  test("the headers infer the default matching columns with zero customization", async () => {
    const inviterColumns = new Map(
      inferMetadata(INVITER_COLUMNS, []).map((column) => [column.name, column]),
    );
    expect(inviterColumns.get("record_id")?.role).toBe("identifier");
    expect(inviterColumns.get("first_name")?.type).toBe("first_name");
    expect(inviterColumns.get("last_name")?.type).toBe("last_name");
    expect(inviterColumns.get("dob")?.type).toBe("date_of_birth");
    expect(inviterColumns.get("ssn")?.type).toBe("ssn");
    expect(inviterColumns.get("zip")?.type).toBe("zip_code");

    const partnerColumns = new Map(
      inferMetadata(PARTNER_COLUMNS, []).map((column) => [column.name, column]),
    );
    expect(partnerColumns.get("record_id")?.role).toBe("identifier");
    expect(partnerColumns.get("phone")?.type).toBe("phone_number");
    expect(partnerColumns.get("email")?.type).toBe("email_address");

    const [inviter] = await sampleFiles();
    const derived = editorFromCsv("Sample Org", inviter).draft.keys;
    expect(derived.every((entry) => entry.enabled)).toBe(true);
    expect(derived.map((entry) => entry.key.name)).toEqual(
      expect.arrayContaining([
        "SSN4 + LN + DOB",
        "LN + FN + DOB + ZIP5",
        "split(LN) + FN + DOB",
      ]),
    );
  });

  test("the default terms match 41 pairs, each a person in both files, one to one", async () => {
    const matches = await defaultTermsMatches();
    const shared = new Set(
      SAMPLE_SHARED_RECORD_IDS.map(([inviterId, partnerId]) =>
        [inviterId, partnerId].join("|"),
      ),
    );

    expect(matches).toHaveLength(41);
    for (const { inviterId, partnerId } of matches)
      expect(shared.has([inviterId, partnerId].join("|"))).toBe(true);
    expect(new Set(matches.map(({ inviterId }) => inviterId)).size).toBe(41);
    expect(new Set(matches.map(({ partnerId }) => partnerId)).size).toBe(41);
  });

  test("the first rule to match a pair is a full-SSN rule for 22, a last-four rule for 7, and a rule without the SSN for 12", async () => {
    const firstRuleFamilies = new Map<string, number>();
    for (const { rule } of await defaultTermsMatches()) {
      const family = rule.startsWith("SSN + ")
        ? "full SSN"
        : rule.startsWith("SSN4 + ")
          ? "last four"
          : "no SSN";
      firstRuleFamilies.set(family, (firstRuleFamilies.get(family) ?? 0) + 1);
    }
    expect(Object.fromEntries(firstRuleFamilies)).toEqual({
      "full SSN": 22,
      "last four": 7,
      "no SSN": 12,
    });
  });

  test("the people in both files show each kind of disagreement", async () => {
    const pairs = await sharedRows();
    // The number of people in both files whose two rows satisfy `predicate`.
    const pairsWhere = (
      predicate: (inviterRow: CSVRow, partnerRow: CSVRow) => boolean,
    ) =>
      pairs.filter(([inviterRow, partnerRow]) =>
        predicate(inviterRow, partnerRow),
      ).length;
    const first = (row: CSVRow) => cell(row, "first_name");
    const last = (row: CSVRow) => cell(row, "last_name");
    const ssn = (row: CSVRow) => cell(row, "ssn");
    const dob = (row: CSVRow) => cell(row, "dob");

    // Date format: zero-padded on the inviter side, unpadded on the partner's.
    for (const [inviterRow, partnerRow] of pairs) {
      expect(dob(inviterRow)).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
      expect(dob(partnerRow)).toMatch(/^[1-9]\d?\/[1-9]\d?\/\d{4}$/);
      expect(calendarDate(dob(inviterRow))).toBe(calendarDate(dob(partnerRow)));
    }
    expect(pairsWhere((i, p) => dob(i) !== dob(p))).toBeGreaterThan(0);

    // First-name nicknames and typos.
    expect(
      pairsWhere((i, p) => first(i) === "Jon" && first(p) === "John"),
    ).toBe(1);
    expect(
      pairsWhere((i, p) => first(i) === "Tiff" && first(p) === "Tiffany"),
    ).toBe(1);
    expect(
      pairsWhere(
        (i, p) =>
          first(i).length >= 5 && editDistance(first(i), first(p)) === 1,
      ),
    ).toBeGreaterThan(0);

    // Surname typos and dropped letters, hyphenated against single surnames,
    // and a surname change with the SSN and date of birth agreeing.
    expect(
      pairsWhere((i, p) => last(i) === "Montoa" && last(p) === "Montoya"),
    ).toBe(1);
    expect(
      pairsWhere(
        (i, p) => last(i).length >= 5 && editDistance(last(i), last(p)) === 1,
      ),
    ).toBeGreaterThan(1);
    expect(
      pairsWhere(
        (i, p) => last(i) === "Matthews-Toth" && last(p) === "Matthews",
      ),
    ).toBe(1);
    expect(
      pairsWhere(
        (i, p) =>
          last(i) !== last(p) &&
          (last(i).split("-").includes(last(p)) ||
            last(p).split("-").includes(last(i))),
      ),
    ).toBeGreaterThan(1);
    expect(
      pairsWhere(
        (i, p) =>
          first(i) === first(p) &&
          editDistance(last(i), last(p)) > 2 &&
          !last(i).includes("-") &&
          !last(p).includes("-") &&
          FULL_SSN.test(ssn(i)) &&
          ssn(i) === ssn(p),
      ),
    ).toBeGreaterThan(0);

    // An SSN on one side only, and a masked SSN against the same last four.
    expect(
      pairsWhere((i, p) => (ssn(i) === "") !== (ssn(p) === "")),
    ).toBeGreaterThan(0);
    expect(
      pairsWhere(
        (i, p) =>
          (MASKED_SSN.test(ssn(i)) && FULL_SSN.test(ssn(p))) ||
          (FULL_SSN.test(ssn(i)) && MASKED_SSN.test(ssn(p))),
      ),
    ).toBeGreaterThan(0);
    for (const [inviterRow, partnerRow] of pairs)
      if (ssn(inviterRow) !== "" && ssn(partnerRow) !== "")
        expect(ssn(inviterRow).slice(-4)).toBe(ssn(partnerRow).slice(-4));

    // A ZIP that differs (a move) for some pairs, the same ZIP for most.
    const moved = pairsWhere((i, p) => cell(i, "zip") !== cell(p, "zip"));
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(pairs.length / 2);
  });

  test("some rows in one file only share a date of birth with a row in the other", async () => {
    const [inviter, partner] = await sampleFiles();
    const shared = new Set(
      SAMPLE_SHARED_RECORD_IDS.map((pair) => pair.join("|")),
    );
    let lookClose = 0;
    for (const inviterRow of inviter.rawRows)
      for (const partnerRow of partner.rawRows)
        if (
          calendarDate(cell(inviterRow, "dob")) ===
            calendarDate(cell(partnerRow, "dob")) &&
          !shared.has(
            [cell(inviterRow, "record_id"), cell(partnerRow, "record_id")].join(
              "|",
            ),
          )
        )
          lookClose += 1;
    // None of these pairs match: the match test checks that every pair the
    // default terms match is a person in both files.
    expect(lookClose).toBeGreaterThanOrEqual(3);
  });

  test("the sample partner file is the partner CSV under its file name", async () => {
    const file = samplePartnerFile();
    expect(file.name).toBe(SAMPLE_PARTNER_FILE_NAME);
    expect(file.type).toBe("text/csv");
    expect(await file.text()).toBe(SAMPLE_PARTNER_CSV);
  });
});
