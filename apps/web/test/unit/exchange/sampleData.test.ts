import { Readable } from "node:stream";

import { describe, expect, test } from "vitest";

import { inferMetadata, loadCSVFile } from "@alcove/core";

import {
  buildKeyStrings,
  buildStandardizedDataset,
} from "@alcove/core/testing";

import {
  SAMPLE_INVITER_CSV,
  SAMPLE_INVITER_FILE_NAME,
  SAMPLE_PARTNER_CSV,
  SAMPLE_PARTNER_FILE_NAME,
} from "@psi/sampleData";
import { computeFieldCoverage } from "@psi/workers/nonEmptyAggregate";
import { editorFromCsv } from "@psi/inviterEditor";
import { inviterCleaningAttention } from "@psi/inviterModel";

import type { AcquiredCsv } from "@psi/inviterEditor";

const EXPECTED_COLUMNS = ["first_name", "last_name", "dob", "zip", "member_id"];

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

/** The set of cleaned key strings a row produces across the file's default
 * keys -- the exact strings the PSI intersection compares. Two rows match when
 * these sets intersect. `isReceiver` swaps the swap-keys' elements so the
 * partner side is compared the way the exchange actually compares it. */
function keyStringsForRow(
  csv: AcquiredCsv,
  rowIndex: number,
  isReceiver: boolean,
): Set<string> {
  const editor = editorFromCsv("Sample Org", csv);
  const metadata = editor.draft.metadata;
  const terms = editor.seed.terms;
  const dataset = buildStandardizedDataset(
    editor.draft.standardization,
    csv.rawRows,
    metadata,
    terms,
  );
  const strings = new Set<string>();
  for (const key of terms.linkageKeys) {
    const produced = buildKeyStrings(key, dataset, rowIndex, isReceiver);
    if (produced === null) continue;
    // "|" appears in neither a default key name nor a cleaned key string, so
    // the pair cannot collide with a different (name, value) split.
    for (const value of produced) strings.add(`${key.name}|${value}`);
  }
  return strings;
}

function rowsIntersect(
  inviter: AcquiredCsv,
  inviterRow: number,
  partner: AcquiredCsv,
  partnerRow: number,
): boolean {
  const inviterKeys = keyStringsForRow(inviter, inviterRow, false);
  const partnerKeys = keyStringsForRow(partner, partnerRow, true);
  for (const value of inviterKeys) if (partnerKeys.has(value)) return true;
  return false;
}

describe("sample data", () => {
  test("both files parse to the intended synthetic columns", async () => {
    const inviter = await acquire(SAMPLE_INVITER_CSV, SAMPLE_INVITER_FILE_NAME);
    const partner = await acquire(SAMPLE_PARTNER_CSV, SAMPLE_PARTNER_FILE_NAME);

    expect(inviter.columns).toEqual(EXPECTED_COLUMNS);
    expect(partner.columns).toEqual(EXPECTED_COLUMNS);
    expect(inviter.rawRows).toHaveLength(11);
    expect(partner.rawRows).toHaveLength(11);
  });

  test.each([
    [SAMPLE_INVITER_FILE_NAME, SAMPLE_INVITER_CSV],
    [SAMPLE_PARTNER_FILE_NAME, SAMPLE_PARTNER_CSV],
  ])(
    "default cleaning of %s shows no failing field",
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
    },
  );

  test("the header infers the default matching columns with zero customization", async () => {
    const metadata = inferMetadata(EXPECTED_COLUMNS, []);
    const byName = new Map(metadata.map((column) => [column.name, column]));
    expect(byName.get("first_name")?.type).toBe("first_name");
    expect(byName.get("last_name")?.type).toBe("last_name");
    expect(byName.get("dob")?.type).toBe("date_of_birth");
    expect(byName.get("zip")?.type).toBe("zip_code");
    expect(byName.get("member_id")?.role).toBe("identifier");

    const inviter = await acquire(SAMPLE_INVITER_CSV, SAMPLE_INVITER_FILE_NAME);
    const editor = editorFromCsv("Sample Org", inviter);
    // The seed enables every derived key, and several keys are derivable from
    // these columns, so the file is matchable straight out of read. The ZIP
    // column brings in the built-in ZIP keys, on like the rest.
    const derived = editor.draft.keys;
    expect(derived.length).toBeGreaterThan(1);
    expect(derived.every((entry) => entry.enabled)).toBe(true);
    expect(derived.map((entry) => entry.key.name)).toContain(
      "LN + FN + DOB + ZIP5",
    );
  });

  test("the six engineered pairs standardize equal under default cleaning", async () => {
    const inviter = await acquire(SAMPLE_INVITER_CSV, SAMPLE_INVITER_FILE_NAME);
    const partner = await acquire(SAMPLE_PARTNER_CSV, SAMPLE_PARTNER_FILE_NAME);

    // Rows 1-6 (0-based 0-5) are the matching pairs, in the same order on both
    // sides. Each holds a distinct near-miss the default pipeline resolves.
    for (let row = 0; row < 6; row += 1) {
      expect(rowsIntersect(inviter, row, partner, row)).toBe(true);
    }
  });

  test("the two look-close pairs do not match once cleaned", async () => {
    const inviter = await acquire(SAMPLE_INVITER_CSV, SAMPLE_INVITER_FILE_NAME);
    const partner = await acquire(SAMPLE_PARTNER_CSV, SAMPLE_PARTNER_FILE_NAME);

    // Rows 7-8 (0-based 6-7) look close to their same-index partner row but
    // differ on a key element (a misspelled surname, a different birth year),
    // so no default key intersects.
    expect(rowsIntersect(inviter, 6, partner, 6)).toBe(false);
    expect(rowsIntersect(inviter, 7, partner, 7)).toBe(false);
  });

  test("the matching pairs are exactly six across the whole cross-product", async () => {
    const inviter = await acquire(SAMPLE_INVITER_CSV, SAMPLE_INVITER_FILE_NAME);
    const partner = await acquire(SAMPLE_PARTNER_CSV, SAMPLE_PARTNER_FILE_NAME);

    let matches = 0;
    for (let i = 0; i < inviter.rawRows.length; i += 1) {
      for (let p = 0; p < partner.rawRows.length; p += 1) {
        if (rowsIntersect(inviter, i, partner, p)) matches += 1;
      }
    }
    expect(matches).toBe(6);
  });
});
