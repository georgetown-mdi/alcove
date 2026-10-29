import { describe, expect, test } from "vitest";

import {
  ALIAS_TYPE_META_MAP,
  buildAliasTypeMetaMap,
  columnNameLookupKey,
  disclosedColumnNames,
  inferMetadata,
  ownResultColumnNames,
} from "../../src/config/metadata";
import { getDefaultStandardization } from "../../src/defaults/builtInStandardization";

import type {
  LinkageField,
  LinkageTerms,
} from "../../src/config/linkageTermsSchema";
import type { MetadataInferenceMode } from "../../src/config/metadata";
import type { SemanticType } from "../../src/types";

// Recognition decides what is sent: in direct mode a header inference does not
// recognize is sent as payload, and a recognized one never is. Each list below
// is pinned in both modes.
const MODES: MetadataInferenceMode[] = ["declaredOnly", "direct"];

// Every header the lookup key newly recognizes, grouped by the fold step that
// makes it a listed name.
const FOLDED_HEADERS: Array<
  [step: string, header: string, type: SemanticType]
> = [
  ["case", "Ssn4", "ssn4"],
  ["case", "ZIP_CODE", "zip_code"],
  ["outer whitespace", " ssn", "ssn"],
  ["outer whitespace", "dob ", "date_of_birth"],
  ["outer whitespace", "\temail\t", "email_address"],
  ["outer whitespace", "  zip5  ", "zip_code"],
  ["inner whitespace", "First Name", "first_name"],
  ["inner whitespace", "last   name", "last_name"],
  ["inner whitespace", "phone \t number", "phone_number"],
  ["inner whitespace", "Social Security Number", "ssn"],
  ["inner whitespace", "Date of Birth", "date_of_birth"],
  ["inner whitespace", "Email Address", "email_address"],
  ["inner whitespace", "House Number", "street_number"],
  ["separator", "Street-No", "street_number"],
  ["inner whitespace", "Street Name", "street_name"],
  ["inner whitespace", "Unit Number", "unit"],
  ["separator", "Apt.No", "unit"],
  ["inner whitespace", "City Name", "city"],
  ["case", "CITY", "city"],
  ["inner whitespace", "Zip 5", "zip_code"],
  ["inner whitespace", "State Code", "state"],
  ["inner whitespace", "County Name", "county"],
  ["separator", "first-name", "first_name"],
  ["separator", "first.name", "first_name"],
  ["separator", "first__name", "first_name"],
  ["separator", "Date-of-Birth", "date_of_birth"],
  ["separator", "date.of.birth", "date_of_birth"],
  ["separator", "Last - Name", "last_name"],
  ["separator", "zip._-5", "zip_code"],
  ["separator", "Zip-Code", "zip_code"],
  ["every step", "  Social_-_Security . Number ", "ssn"],
];

// Headers that stay unrecognized: the lookup is a whole-name match on the
// folded key, never a substring, prefix or edit-distance test, and only
// whitespace is trimmed.
const UNRECOGNIZED_HEADERS = [
  "ssn_last4",
  "ssn last 4",
  "first_name_2",
  "first name 2",
  "zip_area",
  "Given Name",
  "Birthdate",
  "E-mail",
  "f name",
  "s.s.n",
  "first/name",
  "_ssn",
  "-ssn",
  "ssn.",
  "ssn_",
  ".dob",
  "SSN#",
  // An address line is typed by the operator, never inferred.
  "address",
  "Address",
  "street_address",
  "Street Address",
  "address1",
  "address_1",
  "Address Line 1",
  "address2",
  "address_2",
  "Address Line 2",
  "street",
  "number",
  "town",
];

function termsFor(type: SemanticType): LinkageTerms {
  return {
    version: "1.0.0",
    identity: "lookup key",
    date: "2025-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: false,
    linkageFields: [{ name: type, type }] as LinkageField[],
    linkageKeys: [{ name: "key", elements: [{ field: type }] }],
  };
}

describe("columnNameLookupKey", () => {
  test.each([
    ["case", "SSN", "ssn"],
    ["outer whitespace", " \t ssn \n", "ssn"],
    ["inner whitespace run", "first \t  name", "first_name"],
    ["underscore run", "first___name", "first_name"],
    ["hyphen run", "first--name", "first_name"],
    ["dot run", "first..name", "first_name"],
    ["mixed separator run", "first _-. name", "first_name"],
  ])("folds %s", (_step, header, key) => {
    expect(columnNameLookupKey(header)).toBe(key);
  });

  test("trims only whitespace, so an outer separator stays in the key", () => {
    expect(columnNameLookupKey(" -ssn. ")).toBe("_ssn_");
  });

  test("every listed name is its own lookup key", () => {
    // A header whose lowercased form was a listed name has that name as its
    // lookup key, so every header recognized by the lowercase-only lookup is
    // recognized as the same type.
    for (const name of Object.keys(ALIAS_TYPE_META_MAP))
      expect(columnNameLookupKey(name)).toBe(name);
  });
});

describe("the recognized names", () => {
  test("are exactly the listed ones", () => {
    expect(Object.keys(ALIAS_TYPE_META_MAP).sort()).toEqual(
      [
        "date_of_birth",
        "dateofbirth",
        "dob",
        "email",
        "email_address",
        "emailaddress",
        "first_name",
        "firstname",
        "fname",
        "id",
        "identifier",
        "last_name",
        "lastname",
        "lname",
        "phone",
        "phone_number",
        "phonenumber",
        "social",
        "social_security_number",
        "ssn",
        "ssn4",
        "county",
        "county_name",
        "countyname",
        "state",
        "state_code",
        "state_name",
        "statecode",
        "statename",
        "address_number",
        "addressnumber",
        "house_no",
        "house_num",
        "house_number",
        "housenumber",
        "street_no",
        "street_num",
        "street_number",
        "streetnumber",
        "street_name",
        "streetname",
        "unit",
        "unit_number",
        "unitnumber",
        "unit_no",
        "unit_num",
        "apartment",
        "apartment_number",
        "apartmentnumber",
        "apt",
        "apt_no",
        "apt_num",
        "apt_number",
        "city",
        "city_name",
        "cityname",
        "zip",
        "zip5",
        "zip_5",
        "zip_code",
        "zipcode",
      ].sort(),
    );
  });

  test.each(MODES)("infer as before under %s, in any letter case", (mode) => {
    for (const [name, entry] of Object.entries(ALIAS_TYPE_META_MAP))
      for (const header of [name, name.toUpperCase()])
        expect(inferMetadata([header], [], { mode })).toEqual([
          {
            name: header,
            type: entry.type,
            role: entry.role,
            isPayload: entry.isPayload,
          },
        ]);
  });
});

describe.each(MODES)("under %s", (mode) => {
  test.each(FOLDED_HEADERS)(
    "%s: %j infers %s, keeps its header as its name, and is not sent",
    (_step, header, type) => {
      const metadata = inferMetadata([header], [], { mode });
      expect(metadata).toEqual([
        { name: header, type, role: "linkage", isPayload: false },
      ]);
      expect(disclosedColumnNames(metadata)).toEqual([]);
    },
  );

  test.each(FOLDED_HEADERS)(
    "%s: %j binds its transform input to the raw header",
    (_step, header, type) => {
      const metadata = inferMetadata([header], [], { mode });
      expect(getDefaultStandardization(metadata, termsFor(type))).toEqual([
        expect.objectContaining({ output: type, input: header }),
      ]);
    },
  );

  test.each(UNRECOGNIZED_HEADERS)("%j stays unrecognized", (header) => {
    const metadata = inferMetadata([header], [], { mode });
    expect(metadata).toEqual(
      mode === "direct"
        ? [{ name: header, type: "other", role: "payload", isPayload: true }]
        : [],
    );
  });

  test("the result names a folded column by its raw header", () => {
    const metadata = inferMetadata([" ssn", "Date of Birth"], [], { mode });
    expect(ownResultColumnNames(metadata, "all", [])).toEqual([
      " ssn",
      "Date of Birth",
    ]);
  });
});

describe("the _id rule on the lookup key", () => {
  test.each(["Member ID", "member-id", "Member.Id", " member _ ID "])(
    "%j is the sole identifier, unsent when declared-only",
    (header) => {
      expect(inferMetadata([header, "dob"], [])).toEqual([
        {
          name: header,
          type: "identifier",
          role: "identifier",
          isPayload: false,
        },
        {
          name: "dob",
          type: "date_of_birth",
          role: "linkage",
          isPayload: false,
        },
      ]);
    },
  );

  test("Member ID is not sent in direct mode, as member_id is not", () => {
    for (const header of ["Member ID", "member_id"])
      expect(inferMetadata([header], [], { mode: "direct" })).toEqual([
        {
          name: header,
          type: "identifier",
          role: "identifier",
          isPayload: false,
        },
      ]);
  });

  test("two folded _id columns are both declared and neither sent in direct mode, the first the identifier", () => {
    expect(
      inferMetadata(["Member ID", "case-id"], [], { mode: "direct" }),
    ).toEqual([
      {
        name: "Member ID",
        type: "identifier",
        role: "identifier",
        isPayload: false,
      },
      {
        name: "case-id",
        type: "identifier",
        role: "ignored",
        isPayload: false,
      },
    ]);
  });

  test("a folded id is the identifier ahead of an _id column", () => {
    expect(inferMetadata([" ID ", "case_id"], [])).toEqual([
      {
        name: " ID ",
        type: "identifier",
        role: "identifier",
        isPayload: false,
      },
    ]);
  });

  test("a folded identifier header is the identifier when it comes first", () => {
    expect(inferMetadata(["Record ID", "case_id", "ssn"], [])).toEqual([
      {
        name: "Record ID",
        type: "identifier",
        role: "identifier",
        isPayload: false,
      },
      { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
    ]);
  });

  test("an _id column is the identifier ahead of a folded identifier header", () => {
    expect(inferMetadata(["case_id", "Record ID", "ssn"], [])).toEqual([
      {
        name: "case_id",
        type: "identifier",
        role: "identifier",
        isPayload: false,
      },
      { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
    ]);
  });

  test("CaseID, with no separator, is not an identifier", () => {
    expect(inferMetadata(["CaseID"], [], { mode: "direct" })).toEqual([
      { name: "CaseID", type: "other", role: "payload", isPayload: true },
    ]);
  });
});

describe("buildAliasTypeMetaMap", () => {
  const linkage = { role: "linkage", isPayload: false } as const;

  test("refuses two types whose names share a lookup key", () => {
    expect(() =>
      buildAliasTypeMetaMap([
        { type: "ssn", aliases: ["social"], ...linkage },
        { type: "first_name", aliases: ["Social"], ...linkage },
      ]),
    ).toThrow(/"Social" \(type first_name\).*type ssn already uses/);
  });

  test("refuses an alias that shares a lookup key with another type's name", () => {
    expect(() =>
      buildAliasTypeMetaMap([
        { type: "first_name", aliases: [], ...linkage },
        { type: "last_name", aliases: ["first-name"], ...linkage },
      ]),
    ).toThrow(/lookup key "first_name"/);
  });

  test("refuses a type that lists its own name again in another spelling", () => {
    expect(() =>
      buildAliasTypeMetaMap([
        { type: "first_name", aliases: ["First Name"], ...linkage },
      ]),
    ).toThrow(/lookup key "first_name"/);
  });

  test("builds a table with no shared key", () => {
    expect(
      buildAliasTypeMetaMap([
        { type: "first_name", aliases: ["fname"], ...linkage },
      ]),
    ).toEqual({
      first_name: { type: "first_name", ...linkage },
      fname: { type: "first_name", ...linkage },
    });
  });
});
