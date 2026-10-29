import { describe, expect, test } from "vitest";

import {
  identifierTypedColumnNames,
  inferredRecordIdentifierStatement,
  inferMetadata,
  inferMetadataForEveryColumn,
  METADATA_NAME_SHAPE_MESSAGE,
  ALIAS_TYPE_META_MAP,
  NAMED_IDENTIFIER_LOOKUP_KEYS,
  NOT_RECORD_NUMBER_LOOKUP_KEYS,
  ownResultColumnNames,
  safeParseMetadata,
  disclosedColumnNames,
} from "../../src/config/metadata";
import { UsageError } from "../../src/errors";
import { buildOutputTable } from "../../src/payloadExchange";

import type { Metadata } from "../../src/config/metadata";
import type { SemanticType } from "../../src/types";

// --- inferMetadata: linkage columns ------------------------------------------

test("phone and email: linkage role, not payload by default", () => {
  const [phone] = inferMetadata(["phone_number"], []);
  const [email] = inferMetadata(["email_address"], []);
  expect(phone.role).toBe("linkage");
  expect(phone.isPayload).toBe(false);
  expect(email.role).toBe("linkage");
  expect(email.isPayload).toBe(false);
});

test("zip_code: linkage role, not payload by default", () => {
  // A recognized PII type defaults to linkage and is NOT disclosed: an inferred
  // ZIP column participates in matching only if a key references it, and is never
  // silently shipped as payload.
  const [zip] = inferMetadata(["zip"], []);
  expect(zip.type).toBe("zip_code");
  expect(zip.role).toBe("linkage");
  expect(zip.isPayload).toBe(false);
});

test("an inferred zip column and an unrecognized column are excluded from the disclosed set", () => {
  const disclosed = disclosedColumnNames(
    inferMetadata(["first_name", "last_name", "zip", "notes"], []),
  );
  expect(disclosed).not.toContain("zip");
  expect(disclosed).not.toContain("notes");
});

// --- inferMetadata: identifier column ----------------------------------------

test("identifier canonical name: identifier role, not linkage, not sent", () => {
  const [col] = inferMetadata(["identifier"], []);
  expect(col.type).toBe("identifier");
  expect(col.role).toBe("identifier");
  expect(col.isPayload).toBe(false);
});

test("identifier alias 'id': identifier role, not linkage, not sent", () => {
  const [col] = inferMetadata(["id"], []);
  expect(col.type).toBe("identifier");
  expect(col.role).toBe("identifier");
  expect(col.isPayload).toBe(false);
});

const IDENTIFIER_SPELLINGS = [
  "id",
  "identifier",
  "case_id",
  "Client ID",
  "ClientID",
  "PersonID",
  "PersonalID",
];

test.each(IDENTIFIER_SPELLINGS)(
  "declared-only inference sends nothing over an identifier column %j",
  (name) => {
    const metadata = inferMetadata([name, "first_name", "notes"], []);
    expect(metadata).toEqual([
      { name, type: "identifier", role: "identifier", isPayload: false },
      {
        name: "first_name",
        type: "first_name",
        role: "linkage",
        isPayload: false,
      },
    ]);
    expect(disclosedColumnNames(metadata)).toEqual([]);
  },
);

test.each(IDENTIFIER_SPELLINGS)(
  "direct inference declares an identifier column %j and does not send it, and sends an unrecognized column",
  (name) => {
    const metadata = inferMetadata([name, "first_name", "notes"], [], {
      mode: "direct",
    });
    expect(metadata).toEqual([
      { name, type: "identifier", role: "identifier", isPayload: false },
      {
        name: "first_name",
        type: "first_name",
        role: "linkage",
        isPayload: false,
      },
      { name: "notes", type: "other", role: "payload", isPayload: true },
    ]);
    expect(disclosedColumnNames(metadata)).toEqual(["notes"]);
  },
);

test.each(IDENTIFIER_SPELLINGS.filter((name) => name !== "case_id"))(
  "direct inference declares a second identifier column %j ignored, not sent",
  (name) => {
    const metadata = inferMetadata(["case_id", name, "notes"], [], {
      mode: "direct",
    });
    expect(metadata).toEqual([
      {
        name: "case_id",
        type: "identifier",
        role: "identifier",
        isPayload: false,
      },
      { name, type: "identifier", role: "ignored", isPayload: false },
      { name: "notes", type: "other", role: "payload", isPayload: true },
    ]);
    expect(disclosedColumnNames(metadata)).toEqual(["notes"]);
  },
);

// --- inferMetadata: _id suffix ----------------------------------------------

test("column ending in _id: inferred as identifier type, isPayload false", () => {
  const [col] = inferMetadata(["client_id"], []);
  expect(col.type).toBe("identifier");
  expect(col.isPayload).toBe(false);
});

test("single _id column: promoted to identifier role", () => {
  const [col] = inferMetadata(["client_id"], []);
  expect(col.role).toBe("identifier");
});

test("multiple _id columns: the first is the identifier, the rest left out", () => {
  expect(inferMetadata(["client_id", "member_id"], [])).toEqual([
    {
      name: "client_id",
      type: "identifier",
      role: "identifier",
      isPayload: false,
    },
  ]);
});

test("canonical id column ahead of an _id column: id is the identifier, _id is left out", () => {
  expect(inferMetadata(["id", "client_id"], [])).toEqual([
    { name: "id", type: "identifier", role: "identifier", isPayload: false },
  ]);
});

test("an _id column ahead of a canonical id column: the _id column is the identifier, id is left out", () => {
  expect(inferMetadata(["client_id", "id"], [])).toEqual([
    {
      name: "client_id",
      type: "identifier",
      role: "identifier",
      isPayload: false,
    },
  ]);
});

test("a ClientID column ahead of a canonical id column: ClientID is the identifier, id is left out", () => {
  expect(inferMetadata(["ClientID", "id"], [])).toEqual([
    {
      name: "ClientID",
      type: "identifier",
      role: "identifier",
      isPayload: false,
    },
  ]);
});

// --- inferMetadata: no-separator client and person ids ----------------------

describe.each(["declaredOnly", "direct"] as const)(
  "%s mode: ClientID, PersonID and PersonalID infer as a client_id column does",
  (mode) => {
    const inferredAlone = (name: string) =>
      inferMetadataForEveryColumn([name], [], { mode }).map((column) => ({
        ...column,
        name: "client_id",
      }));

    test.each([
      "ClientID",
      "clientID",
      "clientid",
      "CLIENTID",
      "PersonID",
      "personId",
      "PersonalID",
      "PERSONALID",
      " personalid ",
    ])("%s", (name) => {
      expect(inferredAlone(name)).toEqual(inferredAlone("client_id"));
      expect(
        inferMetadata([name, "client_id", "first_name"], [], { mode }),
      ).toEqual(
        inferMetadata(["case_id", "client_id", "first_name"], [], {
          mode,
        }).map((column) =>
          column.name === "case_id" ? { ...column, name } : column,
        ),
      );
    });

    test("an id column keeps its own inference", () => {
      expect(inferMetadata(["id"], [], { mode })).toEqual([
        {
          name: "id",
          type: "identifier",
          role: "identifier",
          isPayload: false,
        },
      ]);
    });
  },
);

test("PersonalID is the identifier, unsent, by default", () => {
  expect(inferMetadata(["PersonalID", "FirstName", "notes"], [])).toEqual([
    {
      name: "PersonalID",
      type: "identifier",
      role: "identifier",
      isPayload: false,
    },
    {
      name: "FirstName",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
  ]);
});

test("other no-separator id spellings are not identifiers", () => {
  expect(
    inferMetadataForEveryColumn(
      ["caseid", "personalidx", "patientids", "mrns"],
      [],
    ).map((column) => column.type),
  ).toEqual(["other", "other", "other", "other"]);
});

test("the named identifier spellings are not entries of the alias table", () => {
  for (const key of [
    "clientid",
    "personid",
    "personalid",
    "patientid",
    "recordid",
    "memberid",
    "mrn",
  ])
    expect(Object.hasOwn(ALIAS_TYPE_META_MAP, key)).toBe(false);
});

test("no alias table key is a key the identifier or not-a-record-number lists hold", () => {
  const tableKeys = Object.keys(ALIAS_TYPE_META_MAP);
  const listKeys = [
    ...NAMED_IDENTIFIER_LOOKUP_KEYS,
    ...NOT_RECORD_NUMBER_LOOKUP_KEYS,
  ];
  expect(tableKeys.filter((key) => listKeys.includes(key))).toEqual([]);
  expect(
    [...NOT_RECORD_NUMBER_LOOKUP_KEYS].filter((key) =>
      NAMED_IDENTIFIER_LOOKUP_KEYS.has(key),
    ),
  ).toEqual([]);
  expect(
    tableKeys.filter(
      (key) =>
        key.endsWith("_id") && ALIAS_TYPE_META_MAP[key].type !== "identifier",
    ),
  ).toEqual([]);
});

// --- inferMetadata: MRN, run-together ids and record numbers ----------------

const RECORD_IDENTIFIER_SPELLINGS = [
  "MRN",
  "mrn",
  " Mrn ",
  "PatientID",
  "patientid",
  "RecordID",
  "recordId",
  "MemberID",
  "MEMBERID",
  "case_number",
  "Case Number",
  "CaseNumber",
  "casenumber",
  "CASE_NUMBER",
  "record_number",
  "RecordNumber",
  "record_no",
  "Record No",
  "Record-No",
  "RECORD_NO",
  "RecordNo",
  "recordNo",
  "CaseNo",
  "case_no",
  "account_number",
  "PolicyNo",
  "zip_no",
  "ethnicity_number",
  "warehouse_number",
  "WareHouseNumber",
  "estate_no",
  "state_number",
  "hotel_number",
  "Case #",
  "Case#",
  "Record No.",
  "RecordNo.",
  "Case #:",
  "(RecordNo)",
  "RecordNo:",
];

describe.each(["declaredOnly", "direct"] as const)(
  "%s mode: a record identifier spelling infers as a client_id column does",
  (mode) => {
    const inferredAlone = (name: string) =>
      inferMetadataForEveryColumn([name], [], { mode }).map((column) => ({
        ...column,
        name: "client_id",
      }));

    test.each(RECORD_IDENTIFIER_SPELLINGS)("%j", (name) => {
      expect(inferredAlone(name)).toEqual(inferredAlone("client_id"));
      const metadata = inferMetadata([name, "first_name", "notes"], [], {
        mode,
      });
      expect(metadata[0]).toEqual({
        name,
        type: "identifier",
        role: "identifier",
        isPayload: false,
      });
      expect(disclosedColumnNames(metadata)).toEqual(
        mode === "direct" ? ["notes"] : [],
      );
    });
  },
);

test.each(RECORD_IDENTIFIER_SPELLINGS)(
  "declared-only and direct inference type %j the same way",
  (name) => {
    const typesIn = (mode: "declaredOnly" | "direct") =>
      inferMetadataForEveryColumn(["id", name], [], { mode }).map(
        ({ type, role, isPayload }) => ({ type, role, isPayload }),
      );
    expect(typesIn("declaredOnly")).toEqual(typesIn("direct"));
    expect(typesIn("direct")[1]).toEqual({
      type: "identifier",
      role: "ignored",
      isPayload: false,
    });
  },
);

// The alias table is looked up before the record-number rule, so a name it
// lists keeps its type, and a name on the not-a-record-number list, or ending
// as no record number does, infers as any name the table does not list: type
// `other`, sent under direct inference.
const NUMBER_SUFFIX_FALSE_MATCHES: Array<[name: string, type: SemanticType]> = [
  ["phone_number", "phone_number"],
  ["Phone Number", "phone_number"],
  ["PhoneNumber", "phone_number"],
  ["social_security_number", "ssn"],
  ["Social Security Number", "ssn"],
  ["street_no", "street_number"],
  ["StreetNumber", "street_number"],
  ["StreetNo", "street_number"],
  ["STREETNO", "street_number"],
  ["street_nbr", "street_number"],
  ["house_number", "street_number"],
  ["house_no", "street_number"],
  ["HouseNo", "street_number"],
  ["address_number", "street_number"],
  ["AddressNo", "street_number"],
  ["unit_no", "unit"],
  ["unit_number", "unit"],
  ["UnitNo", "unit"],
  ["apartment_number", "unit"],
  ["ApartmentNo", "unit"],
  ["apt_no", "unit"],
  ["apt_number", "unit"],
  ["AptNo", "unit"],
  ["ssn", "ssn"],
  ["SSN", "ssn"],
  ["social", "ssn"],
  ["SOCIAL_SECURITY_NUMBER", "ssn"],
  ["Casino", "other"],
  ["casino", "other"],
  ["CASINO", "other"],
  ["Piano", "other"],
  ["volcano", "other"],
  ["yes_no", "other"],
  ["Yes No", "other"],
  ["YesNo", "other"],
  ["YESNO", "other"],
  ["number", "other"],
  ["Number", "other"],
  ["No", "other"],
  ["no", "other"],
  ["_number", "other"],
  ["_no", "other"],
];

describe.each(["declaredOnly", "direct"] as const)(
  "%s mode: a name ending in number or no that is not a record number keeps its inference",
  (mode) => {
    test.each(NUMBER_SUFFIX_FALSE_MATCHES)("%j", (name, type) => {
      const [column] = inferMetadataForEveryColumn([name], [], { mode });
      if (type !== "other") {
        expect(column).toEqual({
          name,
          type,
          role: "linkage",
          isPayload: false,
        });
        return;
      }
      expect(column).toEqual(
        mode === "direct"
          ? { name, type: "other", role: "payload", isPayload: true }
          : { name, type: "other", role: "ignored", isPayload: false },
      );
    });
  },
);

// --- inferMetadata: SSN and phone spellings ---------------------------------

const SSN_SPELLINGS = [
  "ssn_number",
  "ssn_no",
  "ssnno",
  "SSNNO",
  "SSNNumber",
  "SSN No",
  "SSN Num",
  "SocialSecurityNumber",
  "socialsecuritynumber",
  "SOCIALSECURITYNO",
  "social_security_no",
  "Social Security No",
  "Social Security",
  "social_no",
  "socialno",
  "SocSecNo",
  "soc_sec_no",
  "Soc Sec Number",
  "ss_number",
  "SSNumber",
  "SS_No",
  "ss_nbr",
  "SSN No.",
  "Soc. Sec. No.",
  "SSN #",
  "SS#",
  "(ssn)",
  "ssn:",
  "SSN:",
];

const PHONE_SPELLINGS = [
  "telephone_number",
  "Telephone",
  "tel",
  "tel_no",
  "phone_no",
  "PhoneNo",
  "PHONENO",
  "phoneno",
  "Phone Num",
  "cell",
  "cell_no",
  "CellNo",
  "CELLNO",
  "CellNumber",
  "Cell Phone",
  "cell_phone",
  "cellphonenumber",
  "mobile",
  "mobile_number",
  "Mobile Phone No",
  "home_phone",
  "Home Phone Number",
  "HomePhoneNumber",
  "homephonenumber",
  "HOMEPHONENUMBER",
  "work_phone",
  "workphonenumber",
  "primaryphonenumber",
  "alternate_phone",
  "contact_phone_number",
  "Phone No.",
  "Phone #",
  "Cell #",
  "Tel.",
  "[Phone #]",
];

describe.each(["declaredOnly", "direct"] as const)(
  "%s mode: an SSN or phone spelling is a linkage name, never sent",
  (mode) => {
    test.each([
      ...SSN_SPELLINGS.map((name) => [name, "ssn"] as const),
      ...PHONE_SPELLINGS.map((name) => [name, "phone_number"] as const),
    ])("%j infers %s", (name, type) => {
      expect(inferMetadataForEveryColumn([name], [], { mode })).toEqual([
        { name, type, role: "linkage", isPayload: false },
      ]);
      const metadata = inferMetadata([name, "first_name", "notes"], [], {
        mode,
      });
      expect(disclosedColumnNames(metadata)).toEqual(
        mode === "direct" ? ["notes"] : [],
      );
      expect(metadata.some((column) => column.role === "identifier")).toBe(
        false,
      );
      expect(identifierTypedColumnNames([name])).toEqual([]);
    });

    test.each([
      [["ssn_number", "case_number"]],
      [["case_number", "ssn_number"]],
      [["HomePhoneNumber", "case_number", "cell_no"]],
    ])("%j picks case_number as the record identifier", (columns) => {
      expect(
        inferMetadataForEveryColumn(columns, [], { mode })
          .filter((column) => column.role === "identifier")
          .map((column) => column.name),
      ).toEqual(["case_number"]);
    });
  },
);

test("a file whose only number columns are SSN or phone numbers has no record identifier", () => {
  const metadata = inferMetadata(
    ["ssn_number", "PhoneNo", "first_name", "notes"],
    [],
    { mode: "direct" },
  );
  expect(metadata.some((column) => column.role === "identifier")).toBe(false);
  expect(inferredRecordIdentifierStatement(metadata)).toBe(
    NO_IDENTIFIER_STATEMENT,
  );
  expect(disclosedColumnNames(metadata)).toEqual(["notes"]);
});

// --- inferMetadata: punctuation at either end of a header -------------------

describe.each(["declaredOnly", "direct"] as const)(
  "%s mode: a header with punctuation at either end infers as without it",
  (mode) => {
    test.each([
      [".id", "id"],
      ["client_id.", "client_id"],
      ["_client_id_", "client_id"],
      ["-ssn", "ssn"],
      ["ssn.", "ssn"],
      [" .dob. ", "dob"],
      ["RecordNo.", "RecordNo"],
      ["notes.", "notes"],
      ["(notes):", "notes"],
      ["(client_id)", "client_id"],
      ["[ssn]", "ssn"],
      ["...", "notes"],
      ["()", "notes"],
    ])("%j infers as %j", (header, bare) => {
      const inferredRoles = (first: string) =>
        inferMetadataForEveryColumn([first, "first_name", "comments"], [], {
          mode,
        }).map(({ type, role, isPayload }) => ({ type, role, isPayload }));
      expect(inferredRoles(header)).toEqual(inferredRoles(bare));
    });
  },
);

test("a header of only punctuation folds to an empty key and is an unrecognized name", () => {
  expect(
    inferMetadataForEveryColumn(["()", "..."], [], { mode: "direct" }),
  ).toEqual([
    { name: "()", type: "other", role: "payload", isPayload: true },
    { name: "...", type: "other", role: "payload", isPayload: true },
  ]);
  expect(inferMetadata(["()", "..."], [], { mode: "declaredOnly" })).toEqual(
    [],
  );
});

// --- inferMetadata: choosing the record identifier ---------------------------

const recordIdentifierOf = (
  columns: Array<string>,
  mode: "declaredOnly" | "direct",
) =>
  inferMetadataForEveryColumn(columns, [], { mode })
    .filter((column) => column.role === "identifier")
    .map((column) => column.name);

describe.each(["declaredOnly", "direct"] as const)(
  "%s mode: a record number does not outrank an id recognized by name",
  (mode) => {
    test.each([
      [["Visit Number", "client_id", "first_name"], "client_id"],
      [["case_number", "client_id"], "client_id"],
      [["case_number", "MRN"], "MRN"],
      [["RecordNo", "id"], "id"],
      [["visit_no", "PersonalID", "Member ID"], "PersonalID"],
      [["case_number", "visit_no"], "case_number"],
      [["visit_no", "case_number", "notes"], "visit_no"],
    ])("%j picks %j", (columns, expected) => {
      expect(recordIdentifierOf(columns, mode)).toEqual([expected]);
      const everyColumn = inferMetadataForEveryColumn(columns, [], { mode });
      for (const column of everyColumn)
        if (column.type === "identifier") expect(column.isPayload).toBe(false);
    });
  },
);

test("a record number passed over for the record identifier is held back", () => {
  expect(
    inferMetadata(["Visit Number", "client_id", "first_name"], []).map(
      (column) => column.name,
    ),
  ).toEqual(["client_id", "first_name"]);
  expect(
    inferMetadata(["Visit Number", "client_id", "first_name", "notes"], [], {
      mode: "direct",
    }),
  ).toEqual([
    {
      name: "Visit Number",
      type: "identifier",
      role: "ignored",
      isPayload: false,
    },
    {
      name: "client_id",
      type: "identifier",
      role: "identifier",
      isPayload: false,
    },
    {
      name: "first_name",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
    { name: "notes", type: "other", role: "payload", isPayload: true },
  ]);
});

test("two canonical identifier columns: only the first is the identifier", () => {
  expect(inferMetadata(["identifier", "id"], [])).toEqual([
    {
      name: "identifier",
      type: "identifier",
      role: "identifier",
      isPayload: false,
    },
  ]);
  expect(
    inferMetadataForEveryColumn(["identifier", "id"], []).map((c) => c.role),
  ).toEqual(["identifier", "ignored"]);
});

test("identifierTypedColumnNames lists the identifier-typed names in order and skips an empty one", () => {
  expect(
    identifierTypedColumnNames(["notes", "Record ID", "", "case_id", "ssn"]),
  ).toEqual(["Record ID", "case_id"]);
  expect(identifierTypedColumnNames([])).toEqual([]);
});

test("direct mode: a later identifier-typed column is declared ignored, not sent", () => {
  expect(inferMetadata(["client_id", "id"], [], { mode: "direct" })).toEqual([
    {
      name: "client_id",
      type: "identifier",
      role: "identifier",
      isPayload: false,
    },
    { name: "id", type: "identifier", role: "ignored", isPayload: false },
  ]);
});

// --- inferMetadata: name is preserved ----------------------------------------

test("original column name casing is preserved", () => {
  const [upper] = inferMetadata(["LAST_NAME"], []);
  const [mixed] = inferMetadata(["First_Name"], []);
  expect(upper.name).toBe("LAST_NAME");
  expect(mixed.name).toBe("First_Name");
});

// --- inferMetadata: alias resolution -----------------------------------------

test.each([
  ["first_name", "first_name"],
  ["fname", "first_name"],
  ["last_name", "last_name"],
  ["lname", "last_name"],
  ["date_of_birth", "date_of_birth"],
  ["dob", "date_of_birth"],
  ["social_security_number", "ssn"],
  ["social", "ssn"],
  ["phone_number", "phone_number"],
  ["phone", "phone_number"],
  ["email_address", "email_address"],
  ["email", "email_address"],
  ["street_number", "street_number"],
  ["street_no", "street_number"],
  ["street_num", "street_number"],
  ["house_number", "street_number"],
  ["house_no", "street_number"],
  ["house_num", "street_number"],
  ["address_number", "street_number"],
  ["street_name", "street_name"],
  ["unit", "unit"],
  ["unit_number", "unit"],
  ["unit_no", "unit"],
  ["unit_num", "unit"],
  ["apartment", "unit"],
  ["apartment_number", "unit"],
  ["apt", "unit"],
  ["apt_no", "unit"],
  ["apt_num", "unit"],
  ["apt_number", "unit"],
  ["city", "city"],
  ["city_name", "city"],
  ["zip_code", "zip_code"],
  ["zip", "zip_code"],
  ["zip5", "zip_code"],
  ["zip_5", "zip_code"],
  ["zipcode", "zip_code"],
  ["state", "state"],
  ["state_code", "state"],
  ["statecode", "state"],
  ["state_name", "state"],
  ["statename", "state"],
  ["county", "county"],
  ["county_name", "county"],
  ["countyname", "county"],
  ["id", "identifier"],
  // No-separator spellings: a single-token column export still infers. The
  // lookup key joins words with `_`, so these must stay explicit aliases.
  ["firstname", "first_name"],
  ["lastname", "last_name"],
  ["dateofbirth", "date_of_birth"],
  ["phonenumber", "phone_number"],
  ["emailaddress", "email_address"],
  ["streetnumber", "street_number"],
  ["housenumber", "street_number"],
  ["addressnumber", "street_number"],
  ["streetname", "street_name"],
  ["unitnumber", "unit"],
  ["apartmentnumber", "unit"],
  ["cityname", "city"],
] as const)('alias "%s" resolves to type "%s"', (alias, expectedType) => {
  const [col] = inferMetadata([alias], []);
  expect(col.type).toBe(expectedType);
});

test.each([
  "address",
  "street_address",
  "streetaddress",
  "address1",
  "address_line_1",
  "address2",
  "address_line_2",
  "street",
])("an address-line column %s is not inferred as an address part", (name) => {
  expect(inferMetadata([name], [])).toEqual([]);
  expect(inferMetadata([name], [], { mode: "direct" })[0].type).toBe("other");
});

describe("the street address names leave every other type's names as they were", () => {
  test.each([
    ["zip", "zip_code"],
    ["zipcode", "zip_code"],
    ["zip_code", "zip_code"],
    ["house_number", "street_number"],
    ["street_no", "street_number"],
    ["address_number", "street_number"],
    ["state", "state"],
    ["county", "county"],
    ["unit_id", "identifier"],
  ] as const)("%s still infers %s", (name, type) => {
    expect(inferMetadata([name], [])[0].type).toBe(type);
  });

  test("a file with every address part infers each column as its own type", () => {
    const columns = [
      "house_number",
      "street_name",
      "apt",
      "city",
      "state",
      "zip",
      "address",
    ];
    expect(
      inferMetadata(columns, [], { mode: "direct" }).map((column) => [
        column.name,
        column.type,
      ]),
    ).toEqual([
      ["house_number", "street_number"],
      ["street_name", "street_name"],
      ["apt", "unit"],
      ["city", "city"],
      ["state", "state"],
      ["zip", "zip_code"],
      ["address", "other"],
    ]);
  });
});

// --- inferMetadata: case-insensitive lookup -----------------------------------

test.each([
  ["SSN", "ssn"],
  ["FIRST_NAME", "first_name"],
  ["Email", "email_address"],
  ["DOB", "date_of_birth"],
] as const)(
  'column name "%s" is matched case-insensitively',
  (name, expectedType) => {
    const [col] = inferMetadata([name], []);
    expect(col.type).toBe(expectedType);
  },
);

test.each(["constructor", "Constructor", "__proto__", "toString"])(
  "column %s, an Object.prototype member name, is left out like any unrecognized column",
  (name) => {
    const metadata = inferMetadata(["id", name], []);
    expect(metadata.map((column) => column.name)).toEqual(["id"]);
    expect(safeParseMetadata(metadata).success).toBe(true);
    expect(disclosedColumnNames(metadata)).not.toContain(name);
  },
);

// --- inferMetadata: mixed columns --------------------------------------------

test("known columns are inferred and an unknown one left out in a single call", () => {
  const result = inferMetadata(["ssn", "program_start_date", "first_name"], []);
  expect(result).toHaveLength(2);
  expect(result[0]).toMatchObject({
    type: "ssn",
    role: "linkage",
    isPayload: false,
  });
  expect(result[1]).toMatchObject({
    type: "first_name",
    role: "linkage",
    isPayload: false,
  });
});

// --- ALIAS_TYPE_META_MAP ------------------------------------------------------

test("ALIAS_TYPE_META_MAP entries have type, role, and isPayload", () => {
  const entry = ALIAS_TYPE_META_MAP["ssn"];
  expect(entry).toHaveProperty("type", "ssn");
  expect(entry).toHaveProperty("role", "linkage");
  expect(entry).toHaveProperty("isPayload", false);
});

test("ALIAS_TYPE_META_MAP identifier entry has role identifier, not linkage", () => {
  const entry = ALIAS_TYPE_META_MAP["identifier"];
  expect(entry.role).toBe("identifier");
});

// --- safeParseMetadata --------------------------------------------------------

test("safeParseMetadata camelizes the on-disk snake_case keys", () => {
  // The form saveConfig writes (is_payload, not isPayload).
  const result = safeParseMetadata([
    { name: "SSN", type: "ssn", role: "linkage", is_payload: false },
  ]);
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.data[0]).toEqual({
    name: "SSN",
    type: "ssn",
    role: "linkage",
    isPayload: false,
  });
});

test("safeParseMetadata also accepts the camelCase form", () => {
  const result = safeParseMetadata([
    { name: "SSN", type: "ssn", role: "linkage", isPayload: false },
  ]);
  expect(result.success).toBe(true);
});

test("safeParseMetadata fails on an invalid semantic type", () => {
  const result = safeParseMetadata([
    { name: "X", type: "not_a_type", role: "linkage", is_payload: false },
  ]);
  expect(result.success).toBe(false);
});

// The metadata `type` shares the semantic-type enum with linkage fields, so it
// accepts the same snake_case values -- including the single-word identifier and
// other that are not linkage-field types -- and rejects the old camelCase ones.
test.each([
  "ssn",
  "ssn4",
  "first_name",
  "last_name",
  "date_of_birth",
  "identifier",
  "phone_number",
  "email_address",
  "other",
] as const)('safeParseMetadata accepts semantic type "%s"', (type) => {
  const result = safeParseMetadata([
    { name: "c", type, role: "linkage", is_payload: false },
  ]);
  expect(result.success).toBe(true);
});

test.each([
  "firstName",
  "lastName",
  "dateOfBirth",
  "phoneNumber",
  "emailAddress",
] as const)('safeParseMetadata rejects the old camelCase type "%s"', (type) => {
  const result = safeParseMetadata([
    { name: "c", type, role: "linkage", is_payload: false },
  ]);
  expect(result.success).toBe(false);
});

// --- column-name uniqueness ---------------------------------------------------

test("safeParseMetadata rejects duplicate column names", () => {
  const result = safeParseMetadata([
    { name: "X", type: "other", role: "ignored", is_payload: false },
    { name: "X", type: "other", role: "payload", is_payload: true },
  ]);
  expect(result.success).toBe(false);
});

test("safeParseMetadata does not echo a duplicated name in the error", () => {
  // The name is operator-authored and may hold control/ANSI/bidi bytes; the
  // uniqueness refine reports a static message, never the offending name.
  const evil = "\x1b[31mDUP\x1b[0m\u202e";
  const result = safeParseMetadata([
    { name: evil, type: "other", role: "payload", is_payload: true },
    { name: evil, type: "other", role: "payload", is_payload: true },
  ]);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.message).not.toContain("DUP");
    expect(result.error.message).not.toContain("\x1b");
    expect(result.error.message).not.toContain("\u202e");
  }
});

test("safeParseMetadata accepts names differing only in case (matching is exact)", () => {
  // Column identity is case-sensitive everywhere a column is read by name, so
  // "X" and "x" are distinct columns, not a duplicate.
  const result = safeParseMetadata([
    { name: "X", type: "other", role: "payload", is_payload: true },
    { name: "x", type: "other", role: "payload", is_payload: true },
  ]);
  expect(result.success).toBe(true);
});

// --- column-name length bound -------------------------------------------------

test("safeParseMetadata rejects an empty column name", () => {
  const result = safeParseMetadata([
    { name: "", type: "other", role: "payload", is_payload: true },
  ]);
  expect(result.success).toBe(false);
});

test("safeParseMetadata rejects a column name over the length bound", () => {
  const result = safeParseMetadata([
    { name: "a".repeat(257), type: "other", role: "payload", is_payload: true },
  ]);
  expect(result.success).toBe(false);
});

test("safeParseMetadata accepts a column name at the length bound", () => {
  const result = safeParseMetadata([
    { name: "a".repeat(256), type: "other", role: "payload", is_payload: true },
  ]);
  expect(result.success).toBe(true);
});

test("safeParseMetadata does not echo an over-long name in the error", () => {
  // The name is operator-authored and may hold control/ANSI/bidi bytes; the
  // length bound reports a static message, never the offending name.
  const evil = "\x1b[31m" + "D".repeat(300) + "\x1b[0m\u202e";
  const result = safeParseMetadata([
    { name: evil, type: "other", role: "payload", is_payload: true },
  ]);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.message).not.toContain("D".repeat(300));
    expect(result.error.message).not.toContain("\x1b");
    expect(result.error.message).not.toContain("\u202e");
  }
});

// --- column-name shape --------------------------------------------------------
// The block's `name` takes the shape the linkage-terms names take: a declared
// column name is a name rather than a data value, it is matched on, and each
// disclosed one reaches the partner in the invitation's payload column list and
// both parties' exchange records. The two refused classes are written as escapes
// so this source holds no raw invisible byte.

test("safeParseMetadata accepts a column name written in letters", () => {
  // What the rule leaves alone: letters in three scripts, an astral character,
  // and the two invisibles outside the class -- the zero-width joiner and the
  // left-to-right MARK, which opens no scope.
  const result = safeParseMetadata([
    {
      name: "Ministe\u0300re \u200d\u5389\u751f\u52b4\u50cd\u7701\u200e \u{1f600}",
      type: "other",
      role: "payload",
      is_payload: true,
    },
  ]);
  expect(result.success).toBe(true);
});

test.each([
  ["a NUL", "\u0000"],
  ["a BEL", "\u0007"],
  ["a tab", "\t"],
  ["a line feed", "\n"],
  ["a carriage return", "\r"],
  ["an ESC", "\u001b"],
  ["a DEL", "\u007f"],
  ["a C1 control", "\u0085"],
  ["a left-to-right embedding", "\u202a"],
  ["a right-to-left embedding", "\u202b"],
  ["a pop directional formatting", "\u202c"],
  ["a left-to-right override", "\u202d"],
  ["a right-to-left override", "\u202e"],
  ["a left-to-right isolate", "\u2066"],
  ["a right-to-left isolate", "\u2067"],
  ["a first-strong isolate", "\u2068"],
  ["a pop directional isolate", "\u2069"],
])(
  "safeParseMetadata rejects a column name holding %s",
  (_label, character) => {
    const result = safeParseMetadata([
      {
        name: `id${character}`,
        type: "other",
        role: "payload",
        is_payload: true,
      },
    ]);
    expect(result.success).toBe(false);
  },
);

test("the shape refusal names the field by path, not the value", () => {
  const result = safeParseMetadata([
    {
      name: "id\u0007unrepeatable-name",
      type: "other",
      role: "payload",
      is_payload: true,
    },
  ]);
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(
    "0.name",
  );
  const rendered = JSON.stringify(result.error.issues);
  expect(rendered).toContain(METADATA_NAME_SHAPE_MESSAGE);
  expect(rendered).not.toContain("unrepeatable-name");
});

test("the shape refusal names the remedy and the removal behind it", () => {
  // A configuration reaches this refusal by declaring a column as the header
  // was typed, so the rule alone leaves the operator with nothing to do: the
  // message ties the character to the header read and names both ways out.
  expect(METADATA_NAME_SHAPE_MESSAGE).toContain(
    "the CSV read removes these characters from a header",
  );
  expect(METADATA_NAME_SHAPE_MESSAGE).toContain("re-run alcove init");
  expect(METADATA_NAME_SHAPE_MESSAGE).toContain(
    "delete the character from the name",
  );
});

// --- role: ignored ------------------------------------------------------------

test("safeParseMetadata accepts role: ignored", () => {
  const result = safeParseMetadata([
    { name: "COUNTY", type: "other", role: "ignored", is_payload: false },
  ]);
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.data[0].role).toBe("ignored");
});

test("safeParseMetadata accepts role: ignored with is_payload: true (accept-but-ignore)", () => {
  // The is_payload + ignored open question is resolved as accept-but-ignore: the
  // schema accepts any is_payload on an ignored column; transmission is suppressed
  // at the preparePayload chokepoint (see payloadExchange.test.ts), not at parse.
  const result = safeParseMetadata([
    { name: "COUNTY", type: "other", role: "ignored", is_payload: true },
  ]);
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.data[0]).toEqual({
    name: "COUNTY",
    type: "other",
    role: "ignored",
    isPayload: true,
  });
});

test("safeParseMetadata rejects an unknown role", () => {
  const result = safeParseMetadata([
    { name: "c", type: "other", role: "excluded", is_payload: false },
  ]);
  expect(result.success).toBe(false);
});

test("inferMetadata never assigns role: ignored", () => {
  // inferMetadata leaves an unrecognized column out rather than listing it as
  // ignored. Exercise linkage, canonical-identifier, _id-suffix,
  // promoted-single-id, and unknown columns together.
  const result = inferMetadata(
    [
      "ssn",
      "first_name",
      "identifier",
      "client_id",
      "member_id",
      "program_start_date",
    ],
    [],
  );
  expect(result.every((c) => c.role !== "ignored")).toBe(true);
});

// --- inferMetadata: empty column name -----------------------------------------

test("inferMetadata rejects an empty column name at intake", () => {
  // An empty (zero-length) name -- a trailing delimiter, a blank cell, or a
  // leading delimiter in the CSV header -- cannot be used for linkage,
  // identification, or payload (every downstream name floors at .min(1)). Reject
  // it at this intake chokepoint as a clear UsageError rather than disclosing it
  // and losing the audit record to the non-fatal record-build guard. A
  // UsageError so the CLI exits 64.
  expect(() => inferMetadata([""], [])).toThrow(UsageError);
  expect(() => inferMetadata(["ssn", "", "first_name"], [])).toThrow(
    UsageError,
  );
});

test("inferMetadata empty-name error names the positions, not input", () => {
  // The message reports the 1-based positions (not operator-controlled content) so
  // the operator can find the unnamed headers; both empty columns are named.
  let message = "";
  try {
    inferMetadata(["ssn", "", "first_name", ""], []);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  expect(message).toContain("2");
  expect(message).toContain("4");
});

test("the empty-name refusal blames the removal when it emptied the name", () => {
  // A header made only of control characters is neither a trailing delimiter
  // nor a blank cell, so a caller holding the parse's sanitation positions gets a
  // cause and a remedy that fit what the operator's file actually had.
  let message = "";
  try {
    inferMetadata(["id", "", "city"], [2]);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  expect(message).toContain("input column 2 has an empty name");
  expect(message).toContain("invisible control characters");
  expect(message).toContain("ordinary characters");
  expect(message).not.toContain("trailing delimiter");
});

test("the empty-name refusal states both causes for a mixed header", () => {
  let message = "";
  try {
    inferMetadata(["id", "", "city", ""], [2]);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  expect(message).toContain("input columns 2, 4 have an empty name");
  expect(message).toContain("column 2 held");
  expect(message).toContain("invisible control characters");
  expect(message).toContain("trailing delimiter");
});

test("a sanitized position that is not empty leaves the generic cause", () => {
  // The parse strips a name that keeps other characters too; that column is named
  // and is not what this refusal is about.
  let message = "";
  try {
    inferMetadata(["id", "city", ""], [2]);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  expect(message).toContain("trailing delimiter");
  expect(message).not.toContain("invisible control characters");
});

test("inferMetadata accepts a fully-named header (no regression)", () => {
  expect(() =>
    inferMetadata(["ssn", "first_name", "last_name", "dob"], []),
  ).not.toThrow();
});

test("a rejected metadata type is not echoed in the parse error", () => {
  // The metadata `type` is a z.enum(SEMANTIC_TYPES) reached by the operator-config
  // path (loadConfigLinkageSource), which relays the Zod issue message verbatim.
  // Like the linkage-terms discriminator, the z.enum mismatch reports only the
  // expected options and the issue path, never the received value -- pin that so
  // an offending value holding control/ANSI/bidi bytes cannot leak through.
  const evil = "\x1b[31mfirstName\x1b[0m\u202e";
  const result = safeParseMetadata([
    { name: "c", type: evil, role: "linkage", is_payload: false },
  ]);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.message).not.toContain("firstName");
    expect(result.error.message).not.toContain("\x1b");
    expect(result.error.message).not.toContain("\u202e");
  }
});

// --- ownResultColumnNames ----------------------------------------------------

const ownColumnsMeta: Metadata = [
  { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
  { name: "pid", type: "identifier", role: "identifier", isPayload: true },
  { name: "dose", type: "other", role: "payload", isPayload: true },
  { name: "internal", type: "other", role: "ignored", isPayload: true },
];

test("ownResultColumnNames: 'disclosed' is the transmitted set less the identifier", () => {
  // pid is transmitted (is_payload with role identifier) but heads the result's
  // first column already; internal is ignored and notes undeclared, so
  // neither is transmitted.
  expect(ownResultColumnNames(ownColumnsMeta, "disclosed", ["notes"])).toEqual([
    "dose",
  ]);
});

test("ownResultColumnNames: 'all' is every declared column less the identifier, in metadata order", () => {
  expect(ownResultColumnNames(ownColumnsMeta, "all", [])).toEqual([
    "ssn",
    "dose",
    "internal",
  ]);
});

test("ownResultColumnNames: 'all' writes the undeclared columns after the declared ones", () => {
  expect(
    ownResultColumnNames(ownColumnsMeta, "all", ["notes", "code"]),
  ).toEqual(["ssn", "dose", "internal", "notes", "code"]);
});

// --- inferredRecordIdentifierStatement ---------------------------------------

const NO_IDENTIFIER_STATEMENT =
  "none found; the result's row_id column identifies your rows by their " +
  "position in the file, counting from 0";

/** The first header and first-column cells of the result for `metadata`, with
 * rows 1 and 2 of `rows` matched. */
function resultFirstColumn(
  metadata: Metadata,
  rows: Array<Record<string, string>>,
): Array<string> {
  const { headers, rows: out } = buildOutputTable(
    [
      [1, 2],
      [0, 1],
    ],
    rows,
    metadata,
    { columns: [], rowIndices: [], rows: [] },
  );
  return [headers[0], ...out.map((row) => row[0])];
}

test.each([
  [["ssn", "record_id", "dob"], "record_id"],
  [["ssn", "case_id", "id"], "case_id"],
  [["Identifier", "ssn"], "Identifier"],
])(
  "inferredRecordIdentifierStatement names the first id column of %j",
  (columns, expected) => {
    const metadata = inferMetadata(columns, [], { mode: "direct" });
    expect(inferredRecordIdentifierStatement(metadata)).toBe(
      `${expected}, the first id column in your file`,
    );
    const rows = [0, 1, 2].map((index) =>
      Object.fromEntries(columns.map((name) => [name, `${name}-${index}`])),
    );
    expect(resultFirstColumn(metadata, rows)).toEqual([
      expected,
      `${expected}-1`,
      `${expected}-2`,
    ]);
  },
);

test("inferredRecordIdentifierStatement says a record number ahead of the identifier was passed over", () => {
  const columns = ["case_number", "client_id", "ssn"];
  const metadata = inferMetadata(columns, [], { mode: "direct" });
  expect(inferredRecordIdentifierStatement(metadata)).toBe(
    "client_id, the first id column in your file that is not a record number",
  );
  const rows = [0, 1, 2].map((index) =>
    Object.fromEntries(columns.map((name) => [name, `${name}-${index}`])),
  );
  expect(resultFirstColumn(metadata, rows)).toEqual([
    "client_id",
    "client_id-1",
    "client_id-2",
  ]);
  expect(
    inferredRecordIdentifierStatement(
      inferMetadata(["case_number", "visit_no"], [], { mode: "direct" }),
    ),
  ).toBe("case_number, the first id column in your file");
});

test("inferredRecordIdentifierStatement with no id column says the result numbers rows from 0", () => {
  const columns = ["ssn", "dob", "notes"];
  const metadata = inferMetadata(columns, [], { mode: "direct" });
  expect(inferredRecordIdentifierStatement(metadata)).toBe(
    NO_IDENTIFIER_STATEMENT,
  );
  const rows = [0, 1, 2].map((index) =>
    Object.fromEntries(columns.map((name) => [name, `${name}-${index}`])),
  );
  expect(resultFirstColumn(metadata, rows)).toEqual(["row_id", "1", "2"]);
});

test("inferredRecordIdentifierStatement escapes a control or text-direction character in the name", () => {
  const metadata: Metadata = [
    {
      name: "a\u202Eid\u0007",
      type: "identifier",
      role: "identifier",
      isPayload: true,
    },
  ];
  const statement = inferredRecordIdentifierStatement(metadata);
  expect(statement).not.toMatch(/[\u202E\u0007]/);
  expect(statement).toBe("a\\u202eid\\x07, the first id column in your file");
});

test("ownResultColumnNames: with no identifier column every declared column stands", () => {
  // The result's first column is then the row index, which no input column is.
  const meta = ownColumnsMeta.filter((column) => column.name !== "pid");
  expect(ownResultColumnNames(meta, "all", [])).toEqual([
    "ssn",
    "dose",
    "internal",
  ]);
});
