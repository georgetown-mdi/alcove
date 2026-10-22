import { describe, expect, test } from "vitest";
import PSI from "@openmined/psi.js";

import {
  deriveAcceptedLinkageTerms,
  prepareForExchange,
  runExchange,
} from "@alcove/core";
import { createMessagePipe } from "@alcove/core/testing";

import {
  buildAdvancedTerms,
  draftFromTerms,
  draftWithKeyEnabled,
  gradeAuthoredKeys,
  inviterExchangeDataSpec,
  seedAdvancedInvite,
  validateAdvancedInvite,
} from "../../../src/psi/authoring/advancedInvite.js";

import type { CSVRow, LinkageTerms, PreparedExchange } from "@alcove/core";

import type {
  AdvancedInviteDraft,
  AdvancedInviteSeed,
} from "../../../src/psi/authoring/advancedInvite.js";

// An imported key conditioned on a date field, run from the draft as the
// inviter's exchange runs it: the built terms and the draft's own cleaning.

const psiLibrary = await PSI();

const NOW = new Date("2026-06-20T00:00:00.000Z");
const DATED = ["first_name", "last_name", "dob", "phone"];
const UNDATED = ["first_name", "last_name", "phone"];

const ada = (dob: string): CSVRow => ({
  first_name: "Ada",
  last_name: "Lovelace",
  dob,
  phone: "(202) 555-0143",
});
const partnerRows = [ada("03/07/1988")];

const conditionedDocument = (dateField: string): LinkageTerms => ({
  version: "1.0.0",
  identity: "Inviter",
  date: "2026-06-20",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "first_name", type: "first_name" },
    { name: "last_name", type: "last_name" },
    { name: "phone_number", type: "phone_number" },
    { name: dateField, type: "date_of_birth" },
  ],
  linkageKeys: [
    {
      name: "LN + FN + PHONE",
      elements: [
        { field: "last_name" },
        { field: "first_name" },
        { field: "phone_number" },
      ],
      condition: { missingField: dateField },
    },
  ],
});

function imported(
  dateField: string,
  columns: Array<string>,
  rows: Array<CSVRow>,
): { draft: AdvancedInviteDraft; seed: AdvancedInviteSeed } {
  const { seed } = seedAdvancedInvite("Inviter", columns, rows);
  return {
    draft: draftFromTerms(conditionedDocument(dateField), seed, 3600, rows),
    seed,
  };
}

/** How many pairs the exchange matches, from the inviter's draft against a
 * partner holding one dated record of the same person. */
async function pairsMatched(
  draft: AdvancedInviteDraft,
  columns: Array<string>,
  rows: Array<CSVRow>,
): Promise<number> {
  const terms = buildAdvancedTerms(draft);
  const inviter = prepareForExchange(
    inviterExchangeDataSpec(terms, {
      metadata: draft.metadata,
      standardization: draft.standardization,
    }),
    "Inviter",
    rows.map((row) =>
      Object.fromEntries(columns.map((column) => [column, row[column]])),
    ),
    columns,
  );
  const partner: PreparedExchange = prepareForExchange(
    { linkageTerms: deriveAcceptedLinkageTerms(terms, "Acceptor") },
    "Acceptor",
    partnerRows,
    DATED,
  );
  const [inviterConn, partnerConn] = createMessagePipe();
  const [result] = await Promise.all([
    runExchange(inviterConn, "initiator", inviter, { psiLibrary }),
    runExchange(partnerConn, "responder", partner, { psiLibrary }),
  ]);
  return result.associationTable?.[0].length ?? 0;
}

describe("an imported key conditioned on a date field", () => {
  test("named date_of_birth, matches a dated inviter's record with an empty date", async () => {
    const rows = [ada("")];
    const { draft } = imported("date_of_birth", DATED, rows);
    expect(draft.keys.map((entry) => entry.enabled)).toEqual([true]);
    expect(await pairsMatched(draft, DATED, rows)).toBe(1);
  });

  test("named otherwise, matches an undated inviter's record", async () => {
    const rows = [ada("")];
    const { draft } = imported("intake_dob", UNDATED, rows);
    expect(draft.keys.map((entry) => entry.enabled)).toEqual([true]);
    expect(await pairsMatched(draft, UNDATED, rows)).toBe(1);
  });

  test("named otherwise, arrives disabled for a dated inviter and cannot be turned on", () => {
    // Core would read the date column into the field with no cleaning, so an
    // empty date would count as a value and the record match nothing.
    const { draft, seed } = imported("intake_dob", DATED, [ada("")]);
    expect(draft.keys.map((entry) => entry.enabled)).toEqual([false]);
    expect(
      gradeAuthoredKeys(
        draft.metadata,
        draft.standardization,
        seed.columns,
        draft.keys.map((entry) => entry.key),
      ),
    ).toEqual([{ fitness: "unsatisfiable", missingField: "intake_dob" }]);

    const turnedOn = draftWithKeyEnabled(draft, 0, true);
    expect(
      buildAdvancedTerms(turnedOn).linkageFields.map((field) => field.name),
    ).not.toContain("intake_dob");
    const validation = validateAdvancedInvite(turnedOn, seed, NOW);
    expect(validation.canGenerate).toBe(false);
    expect(validation.errors.keys).toMatch(
      /not one of this exchange's linkage fields/,
    );
  });
});
