import { expect, test } from "vitest";

import { buildOutputTable, MATCHED_KEY_COLUMN } from "../src/payloadExchange";
import { InternalConsistencyError } from "../src/errors";

import type { Metadata } from "../src/config/metadata";
import type { PartnerPayload } from "../src/payloadExchange";

const metadata: Metadata = [
  { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
  {
    name: "patient_id",
    type: "identifier",
    role: "identifier",
    isPayload: true,
  },
  { name: "diagnosis", type: "other", role: "payload", isPayload: true },
];

const rawRows = [
  { ssn: "001", patient_id: "P0", diagnosis: "A" },
  { ssn: "002", patient_id: "P1", diagnosis: "B" },
  { ssn: "003", patient_id: "P2", diagnosis: "C" },
];

const notesPayload: PartnerPayload = {
  columns: ["notes"],
  rowIndices: [0, 1],
  rows: [["n0"], ["n1"]],
};

const noPayload: PartnerPayload = { columns: [], rowIndices: [], rows: [] };

test("the matching-key column is written last, after the partner's and the own columns", () => {
  const { headers, rows } = buildOutputTable(
    [
      [0, 2],
      [1, 0],
    ],
    rawRows,
    metadata,
    notesPayload,
    "disclosed",
    [],
    ",",
    ["SSN + LN + DOB", "SSN + LN1 + FN1"],
  );
  expect(headers).toEqual([
    "patient_id",
    "row_id",
    "notes",
    "diagnosis",
    MATCHED_KEY_COLUMN,
  ]);
  expect(rows).toEqual([
    ["P0", "1", "n1", "A", "SSN + LN + DOB"],
    ["P2", "0", "n0", "C", "SSN + LN1 + FN1"],
  ]);
});

test("the matching-key column follows the partner row index when no payload is received", () => {
  const { headers, rows } = buildOutputTable(
    [[1], [4]],
    rawRows,
    metadata,
    noPayload,
    undefined,
    [],
    ",",
    ["SSN only"],
  );
  expect(headers).toEqual(["patient_id", "row_id", MATCHED_KEY_COLUMN]);
  expect(rows).toEqual([["P1", "4", "SSN only"]]);
});

test("the leading columns keep their positions when the matching key is added", () => {
  const without = buildOutputTable([[0], [1]], rawRows, metadata, notesPayload);
  const withKey = buildOutputTable(
    [[0], [1]],
    rawRows,
    metadata,
    notesPayload,
    undefined,
    [],
    ",",
    ["SSN + LN + DOB"],
  );
  expect(withKey.headers.slice(0, without.headers.length)).toEqual(
    without.headers,
  );
  expect(withKey.rows[0].slice(0, without.rows[0].length)).toEqual(
    without.rows[0],
  );
});

test("a partner column named like the matching-key column keeps its name", () => {
  const { headers } = buildOutputTable(
    [[0], [0]],
    rawRows,
    metadata,
    { columns: [MATCHED_KEY_COLUMN], rowIndices: [0], rows: [["theirs"]] },
    undefined,
    [],
    ",",
    ["SSN + LN + DOB"],
  );
  expect(headers).toEqual([
    "patient_id",
    "row_id",
    MATCHED_KEY_COLUMN,
    `own_${MATCHED_KEY_COLUMN}`,
  ]);
});

test("a key name holding the delimiter is escaped like every other cell", () => {
  const { rows } = buildOutputTable(
    [[0], [0]],
    rawRows,
    metadata,
    noPayload,
    undefined,
    [],
    ",",
    ["SSN, last name"],
  );
  expect(rows[0][2]).toBe('"SSN, last name"');
});

test("a matching-key list that does not have one entry per pair is refused", () => {
  expect(() =>
    buildOutputTable(
      [
        [0, 1],
        [0, 1],
      ],
      rawRows,
      metadata,
      noPayload,
      undefined,
      [],
      ",",
      ["SSN + LN + DOB"],
    ),
  ).toThrow(InternalConsistencyError);
});
