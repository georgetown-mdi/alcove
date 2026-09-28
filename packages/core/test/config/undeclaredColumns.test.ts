import { describe, expect, test } from "vitest";

import {
  assertDeclaredPayloadColumnsPresent,
  describeUndeclaredColumns,
  disclosedColumnNames,
  inferMetadata,
  inferMetadataForEveryColumn,
  undeclaredColumnNames,
} from "../../src/config/metadata";
import { OperatorConfigError, UsageError } from "../../src/errors";
import { prepareForExchange, resolveExchangeInputs } from "../../src/exchange";
import { buildOutputTable, preparePayload } from "../../src/payloadExchange";

import type { Metadata } from "../../src/config/metadata";

describe("inference sends only what it recognizes", () => {
  test("an unrecognized column is left out of the inferred metadata", () => {
    const metadata = inferMetadata(["first_name", "notes"], []);
    expect(metadata.map((column) => column.name)).toEqual(["first_name"]);
    expect(disclosedColumnNames(metadata)).toEqual([]);
  });

  test("a sole _id column is the identifier and is not sent", () => {
    expect(inferMetadata(["case_id", "dob"], [])).toContainEqual({
      name: "case_id",
      type: "identifier",
      role: "identifier",
      isPayload: false,
    });
  });

  test("an _id column beside an id column is left out", () => {
    const metadata = inferMetadata(["id", "case_id"], []);
    expect(metadata.map((column) => column.name)).toEqual(["id"]);
  });

  test("two _id columns are both left out", () => {
    expect(inferMetadata(["case_id", "person_id"], [])).toEqual([]);
  });

  test("a recognized alias keeps its mapped values", () => {
    expect(inferMetadata(["DOB", "id", "zip"], [])).toEqual([
      {
        name: "DOB",
        type: "date_of_birth",
        role: "linkage",
        isPayload: false,
      },
      { name: "id", type: "identifier", role: "identifier", isPayload: true },
      { name: "zip", type: "zip_code", role: "linkage", isPayload: false },
    ]);
  });

  test("the every-column variant lists the rest as ignored, in header order", () => {
    expect(inferMetadataForEveryColumn(["notes", "id", "case_id"], [])).toEqual(
      [
        { name: "notes", type: "other", role: "ignored", isPayload: false },
        { name: "id", type: "identifier", role: "identifier", isPayload: true },
        {
          name: "case_id",
          type: "identifier",
          role: "ignored",
          isPayload: false,
        },
      ],
    );
  });

  test("the every-column variant refuses an empty name as inference does", () => {
    expect(() => inferMetadataForEveryColumn(["a", ""], [])).toThrow(
      UsageError,
    );
  });
});

describe("the undeclared-column list", () => {
  test("names the input columns inferred metadata leaves out", () => {
    const columns = ["first_name", "notes", "case_id", "id", "amount"];
    expect(undeclaredColumnNames(columns, inferMetadata(columns, []))).toEqual([
      "notes",
      "case_id",
      "amount",
    ]);
  });

  test("names the input columns an authored block does not name", () => {
    const metadata: Metadata = [
      {
        name: "first_name",
        type: "first_name",
        role: "linkage",
        isPayload: false,
      },
      { name: "notes", type: "other", role: "ignored", isPayload: false },
    ];
    expect(
      undeclaredColumnNames(["first_name", "notes", "dob"], metadata),
    ).toEqual(["dob"]);
  });

  test("is empty when every column is declared, and the notice is absent", () => {
    const columns = ["first_name", "last_name"];
    const undeclared = undeclaredColumnNames(
      columns,
      inferMetadata(columns, []),
    );
    expect(undeclared).toEqual([]);
    expect(describeUndeclaredColumns(undeclared)).toBeUndefined();
  });

  test("the notice names each column", () => {
    expect(describeUndeclaredColumns(["notes"])).toBe(
      "1 input column is not sent to your partner because the exchange's " +
        "column settings do not declare it: notes.",
    );
    expect(describeUndeclaredColumns(["notes", "amount"])).toBe(
      "2 input columns are not sent to your partner because the exchange's " +
        "column settings do not declare them: notes, amount.",
    );
  });

  test("prepareForExchange sets it on the prepared exchange", () => {
    const prepared = prepareForExchange(
      {},
      "alice",
      [{ first_name: "Ann", last_name: "Lee", dob: "1980-01-02", notes: "x" }],
      ["first_name", "last_name", "dob", "notes"],
    );
    expect(prepared.undeclaredColumns).toEqual(["notes"]);
    expect(disclosedColumnNames(prepared.metadata)).toEqual([]);
  });

  test("an undeclared column never reaches the payload frame", () => {
    const columns = [
      "first_name",
      "last_name",
      "dob",
      "notes",
      "case_id",
      "person_id",
    ];
    const row = {
      first_name: "Ann",
      last_name: "Lee",
      dob: "1980-01-02",
      notes: "x",
      case_id: "c1",
      person_id: "p1",
    };
    const prepared = prepareForExchange({}, "alice", [row], columns);
    expect(preparePayload([row], prepared.metadata, [[0], [0]])).toEqual({
      hasData: false,
    });
  });
});

describe("this party's own result file", () => {
  const columns = ["id", "first_name", "last_name", "dob", "notes", "case_id"];
  const row = {
    id: "r1",
    first_name: "Ann",
    last_name: "Lee",
    dob: "1980-01-02",
    notes: "x",
    case_id: "c1",
  };
  const noPartnerPayload = { columns: [], rowIndices: [], rows: [] };

  test("`all` writes an undeclared column after the declared ones", () => {
    const prepared = prepareForExchange({}, "alice", [row], columns);
    expect(prepared.undeclaredColumns).toEqual(["notes", "case_id"]);
    const { headers, rows } = buildOutputTable(
      [[0], [0]],
      prepared.rawRows,
      prepared.metadata,
      noPartnerPayload,
      "all",
      prepared.undeclaredColumns,
    );
    expect(headers).toEqual([
      "id",
      "row_id",
      "first_name",
      "last_name",
      "dob",
      "notes",
      "case_id",
    ]);
    expect(rows).toEqual([["r1", "0", "Ann", "Lee", "1980-01-02", "x", "c1"]]);
  });

  test("`all` writes an undeclared column beside an authored metadata block", () => {
    const metadata: Metadata = [
      { name: "dob", type: "date_of_birth", role: "linkage", isPayload: false },
      { name: "id", type: "identifier", role: "identifier", isPayload: false },
      {
        name: "first_name",
        type: "first_name",
        role: "linkage",
        isPayload: false,
      },
      {
        name: "last_name",
        type: "last_name",
        role: "linkage",
        isPayload: false,
      },
    ];
    const prepared = prepareForExchange({ metadata }, "alice", [row], columns);
    const { headers } = buildOutputTable(
      [[0], [0]],
      prepared.rawRows,
      prepared.metadata,
      noPartnerPayload,
      "all",
      prepared.undeclaredColumns,
    );
    expect(headers).toEqual([
      "id",
      "row_id",
      "dob",
      "first_name",
      "last_name",
      "notes",
      "case_id",
    ]);
  });

  test("`disclosed` leaves an undeclared column out", () => {
    const prepared = prepareForExchange({}, "alice", [row], columns);
    const { headers } = buildOutputTable(
      [[0], [0]],
      prepared.rawRows,
      prepared.metadata,
      noPartnerPayload,
      "disclosed",
      prepared.undeclaredColumns,
    );
    expect(headers).toEqual(["id", "row_id"]);
  });

  test("the payload frame holds no undeclared column", () => {
    const prepared = prepareForExchange({}, "alice", [row], columns);
    expect(preparePayload([row], prepared.metadata, [[0], [0]])).toMatchObject({
      hasData: true,
      columns: ["id"],
    });
  });
});

describe("a sent column the input does not hold", () => {
  const metadata: Metadata = [
    {
      name: "first_name",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
    { name: "last_name", type: "last_name", role: "linkage", isPayload: false },
    { name: "notes", type: "other", role: "payload", isPayload: true },
    { name: "amount", type: "other", role: "payload", isPayload: true },
    { name: "ssn", type: "ssn", role: "ignored", isPayload: true },
  ];

  test("is refused naming each missing column", () => {
    let caught: unknown;
    try {
      assertDeclaredPayloadColumnsPresent(metadata, [
        "first_name",
        "last_name",
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OperatorConfigError);
    expect((caught as Error).message).toContain(
      "the input file does not hold: notes, amount.",
    );
  });

  test("passes when the input holds every sent column", () => {
    expect(() =>
      assertDeclaredPayloadColumnsPresent(metadata, [
        "first_name",
        "last_name",
        "notes",
        "amount",
      ]),
    ).not.toThrow();
  });

  test("is refused by resolveExchangeInputs, before any preparation", () => {
    expect(() =>
      resolveExchangeInputs({ metadata }, "alice", ["first_name", "notes"], []),
    ).toThrow(/does not hold: amount\./);
  });

  test("is refused by prepareForExchange with no commitment on record", () => {
    expect(() =>
      prepareForExchange(
        { metadata },
        "alice",
        [{ first_name: "Ann", last_name: "Lee", notes: "x" }],
        ["first_name", "last_name", "notes"],
      ),
    ).toThrow(OperatorConfigError);
  });
});

test("an input with no recognized column gets default terms with no key", () => {
  // A pipe-delimited file read with the comma default is one unrecognized
  // column: its default terms declare no key, rather than every built-in key.
  const { linkageTerms, undeclaredColumns } = resolveExchangeInputs(
    {},
    "alice",
    ["first_name|last_name|dob"],
    [],
  );
  expect(linkageTerms.linkageKeys).toEqual([]);
  expect(undeclaredColumns).toEqual(["first_name|last_name|dob"]);
});
