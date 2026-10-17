import { describe, expect, test } from "vitest";

import { getDefaultLinkageTerms } from "../src/defaults/builtInLinkageTerms";
import { getDefaultStandardization } from "../src/defaults/builtInStandardization";
import { buildStandardizedDataset } from "../src/standardization";
import { personColumns } from "../src/personColumns";
import { safeParseStandardization } from "../src/config/standardizationSchema";
import {
  droppedSharedValues,
  moreDistinctPeopleThan,
} from "../src/sharedValueScreen";

import type { ColumnMetadata } from "../src/config/metadata";
import type { LinkageTerms } from "../src/config/linkageTermsSchema";
import type { Standardization } from "../src/config/standardizationSchema";
import type { CSVRow } from "../src/file";

const terms: LinkageTerms = {
  version: "1.0.0",
  identity: "test",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [
    { name: "ssn", type: "ssn" },
    { name: "first_name", type: "first_name" },
    { name: "last_name", type: "last_name" },
    { name: "date_of_birth", type: "date_of_birth" },
    { name: "phone_number", type: "phone_number" },
    { name: "email_address", type: "email_address" },
  ],
  linkageKeys: [{ name: "ssn", elements: [{ field: "ssn" }] }],
};

const COLUMNS = [
  "SSN",
  "FIRST",
  "LAST",
  "DOB",
  "PHONE",
  "EMAIL",
  "ZIP",
] as const;
const COLUMN_TYPES = [
  "ssn",
  "first_name",
  "last_name",
  "date_of_birth",
  "phone_number",
  "email_address",
  "zip_code",
] as const;

const metadata: ColumnMetadata[] = COLUMNS.map((name, index) => ({
  name,
  type: COLUMN_TYPES[index],
  role: "linkage",
  isPayload: false,
}));

interface Person {
  ssn?: string;
  first?: string;
  last?: string;
  dob?: string;
  phone?: string;
  email?: string;
  zip?: string;
}

function row(person: Person): CSVRow {
  return {
    SSN: person.ssn ?? "",
    FIRST: person.first ?? "",
    LAST: person.last ?? "",
    DOB: person.dob ?? "",
    PHONE: person.phone ?? "",
    EMAIL: person.email ?? "",
    ZIP: person.zip ?? "",
  };
}

function termsDeclaring(...types: Array<(typeof COLUMN_TYPES)[number]>) {
  return {
    ...terms,
    linkageFields: types.map((type) => ({ name: type, type })),
    linkageKeys: [
      { name: "key", elements: types.map((type) => ({ field: type })) },
    ],
  } satisfies LinkageTerms;
}

function dataset(
  people: Person[],
  agreedTerms: LinkageTerms = terms,
  standardization: Standardization = getDefaultStandardization(
    metadata,
    agreedTerms,
  ),
  columns: ColumnMetadata[] = metadata,
) {
  const rows = people.map(row);
  return buildStandardizedDataset(
    standardization,
    rows,
    columns,
    agreedTerms,
    personColumns(standardization, columns, agreedTerms, rows),
  );
}

const SSN = "123-45-6780";
const PHONE = "(202) 555-0123";
const EMAIL = "family@example.org";

const maria: Person = { first: "Maria", last: "Lopez", dob: "01/02/1980" };

// The cleaned values of `field` for each row, with the default cleaning unless
// `standardization` is given.
function cleaned(
  field: string,
  people: Person[],
  standardization?: Standardization,
  agreedTerms: LinkageTerms = terms,
  columns: ColumnMetadata[] = metadata,
): string[][] {
  const standardized = dataset(
    people,
    agreedTerms,
    standardization ?? getDefaultStandardization(columns, agreedTerms),
    columns,
  ).getField(field);
  if (standardized === undefined) throw new Error(`no field ${field}`);
  return people.map((_, index) => standardized.get(index));
}

// `count` different people, each with a name and date of their own.
function distinctPeople(count: number, shared: Person): Person[] {
  return Array.from({ length: count }, (_, index) => ({
    ...shared,
    first: `Person${String.fromCharCode(65 + index)}`,
    last: "Rivera",
    dob: `03/${String(index + 1).padStart(2, "0")}/1990`,
  }));
}

describe("shared SSN within a file", () => {
  test("an SSN two different people hold is dropped from both", () => {
    const people = [
      { ...maria, ssn: SSN },
      { first: "Ana", last: "Silva", dob: "05/05/1990", ssn: SSN },
    ];
    expect(cleaned("ssn", people)).toEqual([[], []]);
  });

  test("an SSN shared with a record missing its name, on another date, is dropped", () => {
    const people = [
      { ...maria, ssn: SSN },
      { dob: "05/05/1990", ssn: SSN },
    ];
    expect(cleaned("ssn", people)).toEqual([[], []]);
  });

  test("an SSN shared with a record missing its name, on the same date, is kept", () => {
    const people = [
      { ...maria, ssn: SSN },
      { dob: maria.dob, ssn: SSN },
    ];
    expect(cleaned("ssn", people)).toEqual([["123456780"], ["123456780"]]);
  });

  test("an SSN shared with a record whose name is a placeholder, on another date, is dropped", () => {
    const people = [
      { ...maria, ssn: SSN },
      { first: "Unknown", last: "Lopez", dob: "05/05/1990", ssn: SSN },
    ];
    expect(cleaned("ssn", people)).toEqual([[], []]);
  });

  test("a person's own duplicate records sharing an SSN keep it", () => {
    const people = [
      { ...maria, ssn: SSN },
      { ...maria, first: " MARIA ", ssn: SSN },
      { ...maria, ssn: SSN, phone: PHONE },
    ];
    expect(cleaned("ssn", people)).toEqual([
      ["123456780"],
      ["123456780"],
      ["123456780"],
    ]);
  });

  test("a record missing its date beside two people who differ is no third person, and the SSN is still dropped", () => {
    const people = [
      { ...maria, ssn: SSN },
      { ...maria, dob: "07/07/1975", ssn: SSN },
      { first: maria.first, last: maria.last, ssn: SSN },
    ];
    expect(cleaned("ssn", people)).toEqual([[], [], []]);
  });

  test("the screen drops only the shared value, not the record's other fields", () => {
    const people = [
      { ...maria, ssn: SSN },
      { first: "Ana", last: "Silva", dob: "05/05/1990", ssn: SSN },
    ];
    expect(cleaned("first_name", people)).toEqual([["MARIA"], ["ANA"]]);
  });
});

describe("shared phone or email within a file", () => {
  test.each([
    ["phone_number", { phone: PHONE }, "2025550123"],
    ["email_address", { email: EMAIL }, "family@example.org"],
  ] as const)(
    "%s: kept at five distinct people, dropped at six",
    (field, shared, value) => {
      expect(cleaned(field, distinctPeople(5, shared))).toEqual(
        Array.from({ length: 5 }, () => [value]),
      );
      expect(cleaned(field, distinctPeople(6, shared))).toEqual(
        Array.from({ length: 6 }, () => []),
      );
    },
  );

  test("a couple's shared number is kept", () => {
    const people = [
      { ...maria, phone: PHONE, email: EMAIL },
      {
        first: "Jose",
        last: "Lopez",
        dob: "09/09/1978",
        phone: PHONE,
        email: EMAIL,
      },
    ];
    expect(cleaned("phone_number", people)).toEqual([
      ["2025550123"],
      ["2025550123"],
    ]);
    expect(cleaned("email_address", people)).toEqual([
      ["family@example.org"],
      ["family@example.org"],
    ]);
  });

  test("one person's two records count once", () => {
    const people = [
      ...distinctPeople(5, { phone: PHONE }),
      { ...distinctPeople(1, { phone: PHONE })[0] },
    ];
    expect(cleaned("phone_number", people)).toEqual(
      Array.from({ length: 6 }, () => ["2025550123"]),
    );
  });

  test("a record missing its date that no other record completes is a person of its own", () => {
    const kept = [
      ...distinctPeople(5, { phone: PHONE }),
      { first: "PersonA", last: "Rivera", phone: PHONE },
    ];
    expect(cleaned("phone_number", kept)).toEqual(
      Array.from({ length: 6 }, () => ["2025550123"]),
    );
    const dropped = [
      ...distinctPeople(5, { phone: PHONE }),
      { first: "Grace", last: "Rivera", phone: PHONE },
    ];
    expect(cleaned("phone_number", dropped)).toEqual(
      Array.from({ length: 6 }, () => []),
    );
  });

  test("an edited limit is the one applied, to its own field only", () => {
    const standardization = getDefaultStandardization(metadata, terms).map(
      (transformation) =>
        transformation.output === "phone_number"
          ? { ...transformation, maxPeoplePerValue: 1 }
          : transformation,
    );
    const people = distinctPeople(2, { phone: PHONE, email: EMAIL });
    expect(cleaned("phone_number", people, standardization)).toEqual([[], []]);
    expect(cleaned("email_address", people, standardization)).toEqual([
      ["family@example.org"],
      ["family@example.org"],
    ]);
  });

  test("a limit removed from the standardization drops nothing", () => {
    const standardization = getDefaultStandardization(metadata, terms).map(
      ({ maxPeoplePerValue: _, ...transformation }) => transformation,
    );
    expect(
      cleaned(
        "phone_number",
        distinctPeople(6, { phone: PHONE }),
        standardization,
      ),
    ).toEqual(Array.from({ length: 6 }, () => ["2025550123"]));
  });
});

describe("people counted from the party's own columns", () => {
  const ana: Person = { first: "Ana", last: "Silva", dob: "05/05/1990" };

  test.each([
    ["only ssn", termsDeclaring("ssn")],
    ["ssn and zip_code", termsDeclaring("ssn", "zip_code")],
  ])(
    "terms declaring %s still drop an SSN two different people hold",
    (_, agreedTerms) => {
      const people = [
        { ...maria, ssn: SSN, zip: "20057" },
        { ...ana, ssn: SSN, zip: "20057" },
      ];
      expect(cleaned("ssn", people, undefined, agreedTerms)).toEqual([[], []]);
      expect(
        cleaned("ssn", [people[0], { ...people[0] }], undefined, agreedTerms),
      ).toEqual([["123456780"], ["123456780"]]);
    },
  );

  test("terms declaring a phone but no name still drop a phone six people hold", () => {
    const agreedTerms = termsDeclaring("phone_number");
    expect(
      cleaned(
        "phone_number",
        distinctPeople(6, { phone: PHONE }),
        undefined,
        agreedTerms,
      ),
    ).toEqual(Array.from({ length: 6 }, () => []));
    expect(
      cleaned(
        "phone_number",
        distinctPeople(5, { phone: PHONE }),
        undefined,
        agreedTerms,
      ),
    ).toEqual(Array.from({ length: 5 }, () => ["2025550123"]));
  });

  test("a date of birth the terms do not declare is parsed in the format inferred from its column", () => {
    const agreedTerms = termsDeclaring("ssn");
    const people = [
      { ...maria, dob: "1980-01-02", ssn: SSN },
      { ...maria, dob: "1990-05-05", ssn: SSN },
    ];
    expect(cleaned("ssn", people, undefined, agreedTerms)).toEqual([[], []]);
  });

  test("a name the party's own standardization cleans is counted as it cleans it", () => {
    const agreedTerms = termsDeclaring("ssn", "first_name");
    const people = [
      { ...maria, ssn: SSN },
      { ...maria, first: "MARIA", ssn: SSN },
    ];
    expect(cleaned("ssn", people, undefined, agreedTerms)).toEqual([
      ["123456780"],
      ["123456780"],
    ]);
    const ownStandardization = getDefaultStandardization(
      metadata,
      agreedTerms,
    ).map((transformation) =>
      transformation.output === "first_name"
        ? { ...transformation, steps: [] }
        : transformation,
    );
    expect(cleaned("ssn", people, ownStandardization, agreedTerms)).toEqual([
      [],
      [],
    ]);
  });

  test("a file with no name or date of birth column drops nothing", () => {
    const columns = metadata.filter((column) => column.type === "ssn");
    const agreedTerms = termsDeclaring("ssn");
    expect(
      cleaned(
        "ssn",
        [
          { ...maria, ssn: SSN },
          { ...ana, ssn: SSN },
        ],
        undefined,
        agreedTerms,
        columns,
      ),
    ).toEqual([["123456780"], ["123456780"]]);
  });

  test("a screen stated without the party's person columns is refused", () => {
    const rows = [row({ ...maria, ssn: SSN })];
    expect(() =>
      buildStandardizedDataset(
        getDefaultStandardization(metadata, terms),
        rows,
        metadata,
        terms,
      ),
    ).toThrow(/person columns/);
  });
});

describe("counting distinct people", () => {
  const A = "A";
  const B = "B";
  const D = "D";
  const E = "E";
  const U = undefined;

  test.each([
    [
      "one complete person and a record it completes",
      [
        [A, B, D],
        [A, U, D],
        [U, U, U],
      ],
      1,
      false,
    ],
    [
      "two complete people",
      [
        [A, B, D],
        [A, B, E],
      ],
      1,
      true,
    ],
    [
      "a partial no complete person completes",
      [
        [A, B, D],
        [U, U, E],
      ],
      1,
      true,
    ],
    [
      "two partials neither completes",
      [
        [A, U, U],
        [U, U, D],
      ],
      1,
      true,
    ],
    [
      "a partial completed through another partial",
      [
        [A, B, D],
        [A, B, U],
        [A, U, U],
      ],
      1,
      false,
    ],
    [
      "a partial completed by either of two people",
      [
        [A, B, D],
        [A, B, E],
        [A, B, U],
      ],
      2,
      false,
    ],
  ] as const)("%s", (_, holders, maxPeople, expected) => {
    expect(moreDistinctPeopleThan(maxPeople, holders)).toBe(expected);
  });

  test("a value held by more people than any count keeps is dropped", () => {
    const people = Array.from({ length: 200 }, (_, index) => [
      `P${index}`,
      "RIVERA",
      "19900101",
    ]);
    const dropped = droppedSharedValues(
      5,
      people.length + 1,
      (index) => (index < people.length ? ["2025550123"] : ["2025550199"]),
      (index) => people[index] ?? ["SOLO", "RIVERA", "19900101"],
    );
    expect(dropped.has("2025550123")).toBe(true);
    expect(dropped.has("2025550199")).toBe(false);
    expect(dropped.has("2025550100")).toBe(false);
  });

  test("a name field with several values compares them all", () => {
    const persons = [
      [["ANA", "MARIA"], "LOPEZ", "19800101"],
      [["ANA", "MARIA"], "LOPEZ", "19800101"],
      [["ANA", "LUISA"], "LOPEZ", "19800101"],
    ];
    const screen = (count: number) =>
      droppedSharedValues(
        1,
        count,
        () => ["123456780"],
        (index) => persons[index],
      );
    expect(screen(2).none).toBe(true);
    expect(screen(3).has("123456780")).toBe(true);
  });

  test("with no person field, every record holding a value is one person", () => {
    const dropped = droppedSharedValues(
      1,
      10,
      () => ["123456780"],
      () => [],
    );
    expect(dropped.none).toBe(true);
  });
});

describe("the limit in a standardization document", () => {
  test("is read from max_people_per_value", () => {
    const parsed = safeParseStandardization([
      { output: "phone_number", input: "PHONE", max_people_per_value: 3 },
    ]);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.[0].maxPeoplePerValue).toBe(3);
  });

  test.each([0, -1, 1.5, "5"])("refuses %j", (value) => {
    expect(
      safeParseStandardization([
        { output: "phone_number", input: "PHONE", max_people_per_value: value },
      ]).success,
    ).toBe(false);
  });
});

describe("the default terms", () => {
  test("screen the ssn, phone and email fields they select at their limits", () => {
    const defaults = getDefaultLinkageTerms("test", metadata);
    const limits = new Map(
      getDefaultStandardization(metadata, defaults).map((transformation) => [
        transformation.output,
        transformation.maxPeoplePerValue,
      ]),
    );
    expect(limits.get("ssn")).toBe(1);
    expect(limits.get("phone_number")).toBe(5);
    expect(limits.get("email_address")).toBe(5);
    expect(limits.get("zip_code")).toBeUndefined();
    expect(limits.get("first_name")).toBeUndefined();

    const people = distinctPeople(6, { phone: PHONE, email: EMAIL, ssn: SSN });
    for (const field of ["ssn", "phone_number", "email_address"])
      expect(cleaned(field, people, undefined, defaults)).toEqual(
        Array.from({ length: 6 }, () => []),
      );
  });
});

describe("cross-party parity", () => {
  test("both parties derive the same limits and screen the same records alike", () => {
    const partnerMetadata: ColumnMetadata[] = [...metadata]
      .reverse()
      .map((column) => ({ ...column, name: `partner_${column.name}` }));
    const limits = (columns: ColumnMetadata[]) =>
      new Map(
        getDefaultStandardization(columns, terms).map((transformation) => [
          transformation.output,
          transformation.maxPeoplePerValue,
        ]),
      );
    expect(limits(partnerMetadata)).toEqual(limits(metadata));
    expect(limits(metadata)).toEqual(
      new Map([
        ["ssn", 1],
        ["first_name", undefined],
        ["last_name", undefined],
        ["date_of_birth", undefined],
        ["phone_number", 5],
        ["email_address", 5],
      ]),
    );

    const people = [
      ...distinctPeople(6, { phone: PHONE }),
      { ...maria, ssn: SSN },
      { dob: "05/05/1990", ssn: SSN },
    ];
    const partnerRows = people.map((person) =>
      Object.fromEntries(
        Object.entries(row(person)).map(([column, value]) => [
          `partner_${column}`,
          value,
        ]),
      ),
    );
    const partnerStandardization = getDefaultStandardization(
      partnerMetadata,
      terms,
    );
    const partnerDataset = buildStandardizedDataset(
      partnerStandardization,
      partnerRows,
      partnerMetadata,
      terms,
      personColumns(
        partnerStandardization,
        partnerMetadata,
        terms,
        partnerRows,
      ),
    );
    for (const field of ["ssn", "phone_number"]) {
      const partnerField = partnerDataset.getField(field)!;
      expect(partnerRows.map((_, index) => partnerField.get(index))).toEqual(
        cleaned(field, people),
      );
    }
  });
});
