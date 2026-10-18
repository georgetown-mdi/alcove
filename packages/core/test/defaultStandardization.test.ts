import { expect, test, describe, vi } from "vitest";

import {
  dateOfBirthParseSteps,
  getDefaultStandardization,
} from "../src/defaults/builtInStandardization";
import { getDefaultLinkageTerms } from "../src/defaults/builtInLinkageTerms";
import {
  createDateFormatInferrer,
  inferDateFormat,
  inferDateFormatWithCounts,
  columnValues,
  CANDIDATE_DATE_FORMATS,
  INFER_DATE_SCAN_CAP,
} from "../src/utils/date";
import {
  buildKeyStrings,
  buildStandardizedDataset,
  runPipeline,
  suffixes,
  titles,
} from "../src/standardization";
import {
  patternConformsToDialect,
  patternWeightedSize,
} from "../src/utils/linearRegex";
import {
  MAX_TRANSFORM_PATTERN_WEIGHTED_SIZE,
  regexStepPatternParam,
} from "../src/config/transformRegexDialect";
import type { CSVRow } from "../src/file";
import type { ColumnMetadata } from "../src/config/metadata";
import type { LinkageTerms } from "../src/config/linkageTermsSchema";
import type { StandardizationStep } from "../src/config/standardizationSchema";

// --- Fixtures ----------------------------------------------------------------

const minimalTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "test",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [
    { name: "ssn", type: "ssn" },
    { name: "ssn4", type: "ssn4" },
    { name: "first_name", type: "first_name" },
    { name: "last_name", type: "last_name" },
    { name: "name_suffix", type: "name_suffix" },
    { name: "date_of_birth", type: "date_of_birth" },
    { name: "phone_number", type: "phone_number" },
    { name: "email_address", type: "email_address" },
    { name: "street_number", type: "street_number" },
    { name: "zip_code", type: "zip_code" },
    { name: "state", type: "state" },
    { name: "county", type: "county" },
  ],
  linkageKeys: [
    {
      name: "test",
      elements: [{ field: "ssn" }],
    },
  ],
};

const fullMetadata: ColumnMetadata[] = [
  { name: "SSN", type: "ssn", role: "linkage", isPayload: false },
  { name: "SSN4", type: "ssn4", role: "linkage", isPayload: false },
  { name: "FIRST_NAME", type: "first_name", role: "linkage", isPayload: false },
  { name: "LAST_NAME", type: "last_name", role: "linkage", isPayload: false },
  { name: "SUFFIX", type: "name_suffix", role: "linkage", isPayload: false },
  { name: "DOB", type: "date_of_birth", role: "linkage", isPayload: false },
  { name: "PHONE", type: "phone_number", role: "linkage", isPayload: false },
  { name: "EMAIL", type: "email_address", role: "linkage", isPayload: false },
  {
    name: "HOUSE_NO",
    type: "street_number",
    role: "linkage",
    isPayload: false,
  },
  { name: "ZIP", type: "zip_code", role: "linkage", isPayload: false },
  { name: "STATE", type: "state", role: "linkage", isPayload: false },
  { name: "COUNTY", type: "county", role: "linkage", isPayload: false },
];

// A copy of `steps` whose `null_if` list containing `marker` is replaced by
// `values`, as an operator edits a placeholder list.
function withPlaceholders(
  steps: StandardizationStep[],
  marker: string,
  values: string[],
): StandardizationStep[] {
  const edited = structuredClone(steps);
  const step = edited.find(
    (candidate) =>
      candidate.function === "null_if" &&
      Array.isArray(candidate.params?.values) &&
      candidate.params.values.includes(marker),
  );
  if (step === undefined) throw new Error(`no null_if lists ${marker}`);
  step.params = { values };
  return edited;
}

// --- getDefaultStandardization -----------------------------------------------

describe("getDefaultStandardization — structure", () => {
  test("returns one transformation per matching linkage field", () => {
    const result = getDefaultStandardization(fullMetadata, minimalTerms);
    expect(result).toHaveLength(12);
  });

  test("output names match linkage field names", () => {
    const result = getDefaultStandardization(fullMetadata, minimalTerms);
    const outputs = result.map((t) => t.output);
    expect(outputs).toContain("ssn");
    expect(outputs).toContain("ssn4");
    expect(outputs).toContain("first_name");
    expect(outputs).toContain("last_name");
    expect(outputs).toContain("name_suffix");
    expect(outputs).toContain("date_of_birth");
    expect(outputs).toContain("phone_number");
    expect(outputs).toContain("email_address");
    expect(outputs).toContain("street_number");
    expect(outputs).toContain("zip_code");
    expect(outputs).toContain("state");
    expect(outputs).toContain("county");
  });

  test("input names come from metadata column names", () => {
    const result = getDefaultStandardization(fullMetadata, minimalTerms);
    const byOutput = Object.fromEntries(result.map((t) => [t.output, t.input]));
    expect(byOutput["ssn"]).toBe("SSN");
    expect(byOutput["first_name"]).toBe("FIRST_NAME");
    expect(byOutput["last_name"]).toBe("LAST_NAME");
    expect(byOutput["date_of_birth"]).toBe("DOB");
  });

  test("skips linkage fields whose type is absent from metadata", () => {
    const metadata: ColumnMetadata[] = [
      {
        name: "FIRST_NAME",
        type: "first_name",
        role: "linkage",
        isPayload: false,
      },
    ];
    const result = getDefaultStandardization(metadata, minimalTerms);
    expect(result).toHaveLength(1);
    expect(result[0].output).toBe("first_name");
  });

  test("returns empty array when metadata is empty", () => {
    const result = getDefaultStandardization([], minimalTerms);
    expect(result).toHaveLength(0);
  });

  test("metadata that binds no linkage field yields an empty standardization, not a throw", () => {
    // The CLI's `buildDataSpec` relies on totality here: it derives
    // standardization for a partner's terms over whatever columns the
    // operator's CSV has, so an input binding none of those fields must
    // resolve to an empty standardization, not a throw. Pinned as a check
    // so a future throwing step here or in `resolveFieldColumns` trips this
    // test, not a failed acceptance.
    const boundToNothing: ColumnMetadata[] = [
      // Right types, but no column is roled for matching.
      { name: "SSN", type: "ssn", role: "payload", isPayload: true },
      { name: "DOB", type: "date_of_birth", role: "ignored", isPayload: false },
      // Roled for matching, but no linkage field has these types.
      { name: "ID", type: "identifier", role: "linkage", isPayload: false },
      { name: "NOTE", type: "other", role: "linkage", isPayload: false },
    ];
    expect(getDefaultStandardization(boundToNothing, minimalTerms)).toEqual([]);
    expect(getDefaultStandardization([], minimalTerms)).toEqual([]);
  });

  test("skips identifier and other semantic types", () => {
    const terms: LinkageTerms = {
      ...minimalTerms,
      linkageFields: [{ name: "ssn", type: "ssn" }],
    };
    const metadata: ColumnMetadata[] = [
      { name: "SSN", type: "ssn", role: "linkage", isPayload: false },
      { name: "ID", type: "identifier", role: "identifier", isPayload: true },
    ];
    const result = getDefaultStandardization(metadata, terms);
    expect(result).toHaveLength(1);
    expect(result[0].output).toBe("ssn");
  });

  test("uses the linkage field name, not the semantic type, as output", () => {
    const terms: LinkageTerms = {
      ...minimalTerms,
      linkageFields: [{ name: "social_security", type: "ssn" }],
    };
    const result = getDefaultStandardization(
      [{ name: "SSN", type: "ssn", role: "linkage", isPayload: false }],
      terms,
    );
    expect(result[0].output).toBe("social_security");
  });

  test("each field's steps are independent of every other field's and call's", () => {
    const first = getDefaultStandardization(fullMetadata, minimalTerms);
    const steps = (output: string) =>
      first.find((t) => t.output === output)?.steps ?? [];
    const firstNameBefore = structuredClone(steps("first_name"));
    const lastNameBefore = structuredClone(steps("last_name"));
    steps("first_name").push({ function: "to_lower_case" });
    steps("first_name")[0].function = "remove_dashes";
    expect(steps("last_name")).toEqual(lastNameBefore);

    const second = getDefaultStandardization(fullMetadata, minimalTerms);
    expect(second.find((t) => t.output === "first_name")?.steps).toEqual(
      firstNameBefore,
    );
  });

  test("two parties derive identical pipelines, screens included, from the same defaults", () => {
    // The second party names its columns differently, lists them in another
    // order, holds an extra column, and derives ssn4 from its SSN column.
    const partnerMetadata: ColumnMetadata[] = [
      {
        name: "county_name",
        type: "county",
        role: "linkage",
        isPayload: false,
      },
      { name: "Zip5", type: "zip_code", role: "linkage", isPayload: false },
      { name: "St", type: "state", role: "linkage", isPayload: false },
      {
        name: "address",
        type: "street_number",
        role: "linkage",
        isPayload: false,
      },
      { name: "notes", type: "other", role: "payload", isPayload: true },
      {
        name: "eMail",
        type: "email_address",
        role: "linkage",
        isPayload: false,
      },
      { name: "tel", type: "phone_number", role: "linkage", isPayload: false },
      {
        name: "birth",
        type: "date_of_birth",
        role: "linkage",
        isPayload: false,
      },
      { name: "surname", type: "last_name", role: "linkage", isPayload: false },
      { name: "given", type: "first_name", role: "linkage", isPayload: false },
      { name: "social", type: "ssn", role: "linkage", isPayload: false },
      { name: "Sfx", type: "name_suffix", role: "linkage", isPayload: false },
    ];
    const stepsByField = (metadata: ColumnMetadata[]) =>
      new Map(
        getDefaultStandardization(metadata, minimalTerms).map((t) => [
          t.output,
          t.steps,
        ]),
      );
    const ours = stepsByField(fullMetadata);
    const theirs = stepsByField(partnerMetadata);
    expect(ours.size).toBe(minimalTerms.linkageFields.length);
    expect(theirs).toEqual(ours);
    const placeholderLists = [...ours.values()].flatMap((steps) =>
      (steps ?? []).filter(
        (step) =>
          step.function === "null_if" &&
          Array.isArray(step.params?.values) &&
          ["UNKNOWN", "19000101", "222222222", "2222"].some((value) =>
            (step.params!.values as string[]).includes(value),
          ),
      ),
    );
    // first_name, last_name, date_of_birth, ssn and ssn4 each hold one.
    expect(placeholderLists).toHaveLength(5);
  });

  test("each transformation has a non-empty steps array", () => {
    const result = getDefaultStandardization(fullMetadata, minimalTerms);
    for (const t of result) {
      expect(t.steps).toBeDefined();
      expect((t.steps ?? []).length).toBeGreaterThan(0);
    }
  });

  test("every raw-pattern step in every default pipeline is in the linear-time dialect and under the size cap", () => {
    // The dialect gate rejects out-of-dialect partner patterns at terms
    // validation; a SHIPPED default that drifted out of dialect would only
    // show up as a remote exchange failing to validate the bundled terms.
    // Pin it here directly (CONTRIBUTING: encode a runtime fact as a check)
    // so a new default the engine cannot compile trips this test, not a
    // counterparty.
    const transformations = getDefaultStandardization(
      fullMetadata,
      minimalTerms,
    );
    const patterns: string[] = [];
    for (const t of transformations) {
      for (const step of t.steps ?? []) {
        const paramKey = regexStepPatternParam(step.function);
        if (paramKey === undefined) continue;
        const raw = step.params?.[paramKey];
        // A default declares every raw pattern as text; the schema refuses an
        // absent or non-text one, so nothing else can reach the engine.
        expect(typeof raw, `${t.output}: ${step.function}`).toBe("string");
        patterns.push(raw as string);
      }
    }
    // Guard: the defaults DO exercise regex steps, so this is not a vacuous pass.
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      expect(patternConformsToDialect(pattern), `pattern: ${pattern}`).toBe(
        true,
      );
      expect(
        patternWeightedSize(pattern),
        `pattern: ${pattern}`,
      ).toBeLessThanOrEqual(MAX_TRANSFORM_PATTERN_WEIGHTED_SIZE);
    }
  });
});

// --- Default chains never emit the empty string ------------------------------

describe('default chains: a blank input yields null, never ""', () => {
  // Assumes default per-type cleaning maps a blank value to null, so a
  // fully-default exchange never emits "" as a key (link.ts
  // removeDuplicatesAndUndefineds drops only undefined). docs/spec/PROTOCOL.md
  // states this as prose; pinned here as a check so a chain that lets a blank
  // fall through does not silently widen default matching. toBeNull also
  // distinguishes the result from "". The one exception is name_suffix, whose
  // empty value means "no suffix" and is matched on.
  const blanks = ["", " ", "   ", "\t", " \t\n "];
  const allTransformations = getDefaultStandardization(
    fullMetadata,
    minimalTerms,
  );
  const transformations = allTransformations.filter(
    (t) => t.output !== "name_suffix",
  );
  const nameSuffix = allTransformations.find((t) => t.output === "name_suffix");

  // Guard: every default linkage field is exercised, so this is not a vacuous pass.
  test("covers all twelve default linkage fields", () => {
    expect(allTransformations).toHaveLength(12);
    expect(transformations).toHaveLength(11);
    expect(nameSuffix).toBeDefined();
  });

  test('name_suffix: every blank input, and one that cleans to empty, maps to ""', () => {
    for (const blank of [...blanks, "---", "...", "!!!", "@@@"])
      expect(
        runPipeline(blank, nameSuffix!.steps!),
        `input ${JSON.stringify(blank)}`,
      ).toBe("");
  });

  for (const t of transformations) {
    test(`${t.output}: every blank input maps to null`, () => {
      for (const blank of blanks) {
        expect(
          runPipeline(blank, t.steps!),
          `input ${JSON.stringify(blank)}`,
        ).toBeNull();
      }
    });
  }

  // A non-blank "junk" cell that CLEANS to empty (separators or punctuation a
  // type strips entirely) is the other half of the "blank/'' cleaned value"
  // case: it never arrives as whitespace but reduces to "" partway through.
  // Every default type drops these characters, so each maps to null for the same
  // reason a literal blank does; pin it so a chain that let a cleaned-empty value
  // survive trips this test.
  const cleansToEmpty = ["---", "...", "!!!", "@@@"];
  for (const t of transformations) {
    test(`${t.output}: a non-blank value that cleans to empty maps to null`, () => {
      for (const junk of cleansToEmpty) {
        expect(
          runPipeline(junk, t.steps!),
          `input ${JSON.stringify(junk)}`,
        ).toBeNull();
      }
    });
  }
});

// --- SSN / SSN4 explicit blank-drop ------------------------------------------

describe("default SSN / SSN4 pipelines: explicit blank-drop before pad_left", () => {
  // SSN/SSN4 pad a cleaned value to a fixed width, so an empty value would
  // pad into an all-zeros placeholder ("000000000" / "0000") unless something
  // drops it first. An explicit `null_if ""` placed BEFORE pad_left drops the
  // empty value as empty regardless of edits to the terminal placeholder
  // list. Pin the step's presence, its position, and that it -- not the
  // placeholder null_if -- handles the blank-drop.
  const cases: Array<{ type: "ssn" | "ssn4"; column: string }> = [
    { type: "ssn", column: "SSN" },
    { type: "ssn4", column: "SSN4" },
  ];

  function stepsFor(type: "ssn" | "ssn4", column: string) {
    const [t] = getDefaultStandardization(
      [{ name: column, type, role: "linkage", isPayload: false }],
      { ...minimalTerms, linkageFields: [{ name: type, type }] },
    );
    return t.steps ?? [];
  }

  for (const { type, column } of cases) {
    test(`${type}: an explicit null_if "" precedes pad_left`, () => {
      const steps = stepsFor(type, column);
      const emptyDropIdx = steps.findIndex(
        (s) => s.function === "null_if" && s.params?.value === "",
      );
      const padIdx = steps.findIndex((s) => s.function === "pad_left");
      expect(emptyDropIdx).toBeGreaterThanOrEqual(0);
      expect(padIdx).toBeGreaterThan(emptyDropIdx);
    });

    test(`${type}: a blank or cleaned-empty value still drops with the placeholder null_if removed`, () => {
      // Prove the explicit empty-drop is critical, not redundant with the
      // terminal placeholder null_if: strip the placeholder step (the null_if
      // listing all-zeros/sequential placeholders via `values`), and a value
      // that is blank ("", "   ") or cleans to empty ("abc", "----" lose every
      // non-digit) must still map to null. Without `null_if ""`, it would pad
      // to an all-zeros value and survive as a matchable key.
      const withoutPlaceholder = stepsFor(type, column).filter(
        (s) => !(s.function === "null_if" && s.params?.values !== undefined),
      );
      for (const input of ["", "   ", "abc", "----"]) {
        expect(
          runPipeline(input, withoutPlaceholder),
          `input ${JSON.stringify(input)}`,
        ).toBeNull();
      }
    });
  }
});

// --- SSN pipeline ------------------------------------------------------------

// Hyphen, non-breaking hyphen, figure dash, en dash, em dash, minus sign.
const UNICODE_DASHES = [
  "\u2010",
  "\u2011",
  "\u2012",
  "\u2013",
  "\u2014",
  "\u2212",
];

describe("default SSN pipeline", () => {
  function run(input: string) {
    const [t] = getDefaultStandardization(
      [{ name: "SSN", type: "ssn", role: "linkage", isPayload: false }],
      {
        ...minimalTerms,
        linkageFields: [{ name: "ssn", type: "ssn" }],
      },
    );
    return runPipeline(input, t.steps!);
  }

  test("strips dashes from dashed format", () => {
    expect(run("287-65-4321")).toBe("287654321");
  });

  test("strips spaces from space-separated format", () => {
    expect(run("287 65 4321")).toBe("287654321");
  });

  // Each would otherwise lose characters and pad to a different SSN.
  test.each([
    ["fullwidth digits", "1234567\uff18\uff19"],
    ["Arabic-Indic digits", "123-45-67\u0668\u0669"],
    ["a group masked with ?", "123-??-8924"],
    ["a group masked with _", "123-__-8924"],
    ["a group masked with bullets", "123-\u2022\u2022-8924"],
    ["a float-formatted number", "78051120.0"],
    ["dots", "287.65.4321"],
    ["parentheses", "(287) 65-4321"],
  ])("drops a value holding %s (%j)", (_label, input) => {
    expect(run(input)).toBeNull();
  });

  test.each(UNICODE_DASHES)(
    "a Unicode dash %j separates the digits as a hyphen does",
    (dash) => {
      expect(run(`287${dash}65${dash}4321`)).toBe(run("287-65-4321"));
      expect(run(`287${dash}65${dash}4321`)).toBe("287654321");
    },
  );

  test("drops a value holding a Unicode dash and a fullwidth digit", () => {
    expect(run("287\u201065\u2010432\uff11")).toBeNull();
  });

  test("trims surrounding whitespace", () => {
    expect(run("  287654321  ")).toBe("287654321");
  });

  test("passes through a bare 9-digit string unchanged", () => {
    expect(run("287654321")).toBe("287654321");
  });

  test("zero-pads an 8-digit SSN missing a leading zero", () => {
    expect(run("23456789")).toBe("023456789");
  });

  test("returns null for more than 9 digits", () => {
    expect(run("1234567890")).toBeNull();
  });

  test("returns null for placeholder value", () => {
    expect(run("123456789")).toBeNull();
  });

  test("zero-pads a 7-digit SSN missing two leading zeros", () => {
    expect(run("1234567")).toBe("001234567");
  });

  test.each(["123456", "8924", "1", "45-6789"])(
    "drops %j, too few digits to be an SSN missing leading zeros",
    (input) => {
      expect(run(input)).toBeNull();
    },
  );

  test.each([
    "***-**-8924",
    "XXX-XX-8924",
    "xxx-xx-8924",
    "###-##-8924",
    "*****8924",
    "XXXXX8924",
    "X78-05-1120",
    "078-05-112*",
  ])("drops the masked value %j", (input) => {
    expect(run(input)).toBeNull();
  });

  test.each(["000-00-8924", "000008924", "000-12-3456", "00008924"])(
    "drops %j, whose area number is 000",
    (input) => {
      expect(run(input)).toBeNull();
    },
  );

  test.each([
    ["001-23-4567", "001234567"],
    ["010-01-0001", "010010001"],
    ["100-10-1000", "100101000"],
  ])("keeps %j, whose area number is not 000", (input, expected) => {
    expect(run(input)).toBe(expected);
  });

  test.each([
    "666-12-3456",
    "900-12-3456",
    "987-65-4321",
    "999-12-3456",
    "123-00-4567",
    "123-45-0000",
  ])("drops %j, whose area, group or serial the SSA never issues", (input) => {
    expect(run(input)).toBeNull();
  });

  test.each([
    ["665-12-3456", "665123456"],
    ["667-12-3456", "667123456"],
    ["656-12-3456", "656123456"],
    ["899-12-3456", "899123456"],
    ["123-01-4567", "123014567"],
    ["123-10-4567", "123104567"],
    ["123-45-0001", "123450001"],
    ["123-45-1000", "123451000"],
  ])(
    "keeps %j, whose area, group and serial are each issued",
    (input, expected) => {
      expect(run(input)).toBe(expected);
    },
  );

  test.each([
    "000000000",
    "111111111",
    "222-22-2222",
    "333333333",
    "444444444",
    "555555555",
    "666666666",
    "777-77-7777",
    "888888888",
    "999999999",
    "123456789",
  ])("drops the placeholder %j", (input) => {
    expect(run(input)).toBeNull();
  });

  test("keeps a value of one digit but for one place", () => {
    expect(run("222-22-2223")).toBe("222222223");
  });
});

// --- ssn4 derived from a full SSN column -------------------------------------

describe("default ssn4 derived from a full SSN column", () => {
  const ssnTerms: LinkageTerms = {
    ...minimalTerms,
    linkageFields: [
      { name: "ssn", type: "ssn" },
      { name: "ssn4", type: "ssn4" },
    ],
  };
  const ssnOnly: ColumnMetadata[] = [
    { name: "SSN", type: "ssn", role: "linkage", isPayload: false },
  ];

  function cleaned(metadata: ColumnMetadata[], input: string) {
    const transformations = getDefaultStandardization(metadata, ssnTerms);
    return Object.fromEntries(
      transformations.map((t) => [t.output, runPipeline(input, t.steps!)]),
    );
  }

  test("derives ssn4 from the SSN column when there is no ssn4 column", () => {
    const result = getDefaultStandardization(ssnOnly, ssnTerms);
    expect(result.map((t) => [t.output, t.input])).toEqual([
      ["ssn", "SSN"],
      ["ssn4", "SSN"],
    ]);
    expect(cleaned(ssnOnly, "078-05-1120")).toEqual({
      ssn: "078051120",
      ssn4: "1120",
    });
  });

  test.each(["***-**-8924", "XXX-XX-8924", "xxx-xx-8924", "###-##-8924"])(
    "a masked value %j is dropped from ssn and kept as ssn4",
    (input) => {
      expect(cleaned(ssnOnly, input)).toEqual({ ssn: null, ssn4: "8924" });
    },
  );

  test("a zero-masked value is dropped from ssn and kept as ssn4", () => {
    expect(cleaned(ssnOnly, "000-00-8924")).toEqual({
      ssn: null,
      ssn4: "8924",
    });
  });

  test("a never-issued value is dropped from ssn and kept as ssn4", () => {
    expect(cleaned(ssnOnly, "900-12-3456")).toEqual({
      ssn: null,
      ssn4: "3456",
    });
  });

  test.each([
    "078-05-XXXX",
    "078-05-\u2022\u2022\u2022\u2022",
    "078-05-\uff38\uff38\uff38\uff38",
  ])(
    "a value masked in its last four (%j) is dropped from both fields",
    (input) => {
      expect(cleaned(ssnOnly, input)).toEqual({ ssn: null, ssn4: null });
    },
  );

  test("a group-masked value is dropped from ssn and keeps its ssn4", () => {
    expect(cleaned(ssnOnly, "123-??-8924")).toEqual({
      ssn: null,
      ssn4: "8924",
    });
  });

  test.each(UNICODE_DASHES)(
    "a Unicode dash %j separates the digits as a hyphen does",
    (dash) => {
      expect(cleaned(ssnOnly, `078${dash}05${dash}1120`)).toEqual({
        ssn: "078051120",
        ssn4: "1120",
      });
      expect(cleaned(ssnOnly, `***${dash}**${dash}8924`)).toEqual({
        ssn: null,
        ssn4: "8924",
      });
    },
  );

  test("a fullwidth digit drops the value from both fields", () => {
    expect(cleaned(ssnOnly, "078-05-112\uff10")).toEqual({
      ssn: null,
      ssn4: null,
    });
  });

  test("a leading-zero SSN stored as a number keeps both fields", () => {
    expect(cleaned(ssnOnly, "1234567")).toEqual({
      ssn: "001234567",
      ssn4: "4567",
    });
  });

  test("an ssn4 column is used when present, and nothing is derived", () => {
    const both: ColumnMetadata[] = [
      { name: "SSN", type: "ssn", role: "linkage", isPayload: false },
      { name: "LAST4", type: "ssn4", role: "linkage", isPayload: false },
    ];
    const result = getDefaultStandardization(both, ssnTerms);
    expect(result.map((t) => [t.output, t.input])).toEqual([
      ["ssn", "SSN"],
      ["ssn4", "LAST4"],
    ]);
  });

  test("an SSN column not roled for linkage supplies no ssn4", () => {
    const payloadSsn: ColumnMetadata[] = [
      { name: "SSN", type: "ssn", role: "payload", isPayload: true },
    ];
    expect(getDefaultStandardization(payloadSsn, ssnTerms)).toEqual([]);
  });
});

// --- SSN4 pipeline -----------------------------------------------------------

describe("default SSN4 pipeline", () => {
  function run(input: string) {
    const [t] = getDefaultStandardization(
      [{ name: "SSN4", type: "ssn4", role: "linkage", isPayload: false }],
      {
        ...minimalTerms,
        linkageFields: [{ name: "ssn4", type: "ssn4" }],
      },
    );
    return runPipeline(input, t.steps!);
  }

  test("passes through a bare 4-digit value", () => {
    expect(run("6789")).toBe("6789");
  });

  test("extracts last 4 digits from a full dashed SSN", () => {
    expect(run("123-45-6789")).toBe("6789");
  });

  test("extracts last 4 digits from a bare 9-digit SSN", () => {
    expect(run("123456789")).toBe("6789");
  });

  test("strips non-digit characters before extracting", () => {
    expect(run("12 34")).toBe("1234");
  });

  test("zero-pads a 3-digit SSN4 missing a leading zero", () => {
    expect(run("123")).toBe("0123");
  });

  test.each(UNICODE_DASHES)(
    "a Unicode dash %j separates the digits as a hyphen does",
    (dash) => {
      expect(run(`078${dash}05${dash}1120`)).toBe("1120");
      expect(run(`***${dash}**${dash}8924`)).toBe("8924");
      expect(run(`${dash}1120`)).toBe("1120");
    },
  );

  test.each([
    ["***-**-8924", "8924"],
    ["8924", "8924"],
    ["078-05-1120", "1120"],
    ["078 05 1120", "1120"],
    ["078-05-11 20", "1120"],
  ])("keeps %j, whose last four are digits, as %j", (input, expected) => {
    expect(run(input)).toBe(expected);
  });

  test.each([
    "078-05-XXXX",
    "XXXX",
    "078-05-112X",
    "07805****",
    "78*",
    "078-05-\u2022\u2022\u2022\u2022",
    "078-05-\uff38\uff38\uff38\uff38",
    "1234567\uff18\uff19",
    "123-45-67\u0668\u0669",
    "78051120.0",
    "1120.0",
  ])("drops %j, not four ASCII digits at its end", (input) => {
    expect(run(input)).toBeNull();
  });

  test.each([
    ["123-??-8924", "8924"],
    ["123-\u2022\u2022-8924", "8924"],
    ["\u2022\u2022\u2022-\u2022\u2022-8924", "8924"],
  ])("keeps %j, masked only before its last four, as %j", (input, expected) => {
    expect(run(input)).toBe(expected);
  });

  test.each(["0000", "1111", "2222", "5555", "9999", "123-45-7777", "0"])(
    "drops %j, one digit repeated",
    (input) => {
      expect(run(input)).toBeNull();
    },
  );

  test.each([
    ["1112", "1112"],
    ["0001", "0001"],
    ["70", "0070"],
  ])("keeps %j, not one digit repeated, as %j", (input, expected) => {
    expect(run(input)).toBe(expected);
  });
});

// --- Name pipelines ----------------------------------------------------------

describe("default name pipeline (first_name / last_name)", () => {
  function runFirst(input: string) {
    const [t] = getDefaultStandardization(
      [{ name: "FN", type: "first_name", role: "linkage", isPayload: false }],
      {
        ...minimalTerms,
        linkageFields: [{ name: "first_name", type: "first_name" }],
      },
    );
    return runPipeline(input, t.steps!);
  }

  function runLast(input: string) {
    const [t] = getDefaultStandardization(
      [{ name: "LN", type: "last_name", role: "linkage", isPayload: false }],
      {
        ...minimalTerms,
        linkageFields: [{ name: "last_name", type: "last_name" }],
      },
    );
    return runPipeline(input, t.steps!);
  }

  test("uppercases a plain name", () => {
    expect(runLast("smith")).toBe("SMITH");
  });

  test("trims leading and trailing whitespace", () => {
    expect(runLast("  Jones  ")).toBe("JONES");
  });

  test("normalizes accented characters", () => {
    expect(runLast("Héloïse")).toBe("HELOISE");
  });

  test("removes title prefix", () => {
    expect(runFirst("Dr. Jane")).toBe("JANE");
  });

  test("removes suffix", () => {
    expect(runLast("Smith Jr.")).toBe("SMITH");
  });

  test("removes both title and suffix", () => {
    expect(runFirst("Dr. Jane Smith Jr.")).toBe("JANE SMITH");
  });

  describe("affixes are stripped only at the edges of the field", () => {
    test.each([
      ["Judge", "JUDGE"],
      ["Herr", "HERR"],
      ["Md", "MD"],
      ["Iv", "IV"],
      ["Van Der Herr", "VAN DER HERR"],
      ["O'Judge", "O JUDGE"],
      ["Judge-Smith", "JUDGE SMITH"],
      ["Md Rahman", "MD RAHMAN"],
      ["Smith Jr.", "SMITH"],
      ["Smith, Jr.", "SMITH"],
      ["Smith Jr III", "SMITH"],
      ["Mr Smith Jr", "SMITH"],
      ["Dr. Smith", "SMITH"],
      ["Smith Ph.D.", "SMITH"],
      ["Smith Junior", "SMITH"],
      ["Smith 3rd", "SMITH"],
      ["Mary Mr Smith", "MARY MR SMITH"],
      ["Dr.Smith", "SMITH"],
      ["Mr Iv", "IV"],
    ])("%s -> %s in both name pipelines", (input, expected) => {
      expect(runFirst(input)).toBe(expected);
      expect(runLast(input)).toBe(expected);
    });

    test.each([
      "Mr",
      "Mr.",
      "MRS",
      "ms",
      "Mx",
      "Dr",
      "Prof.",
      "Mr Dr",
      "Miss",
      "Sir.",
      "Frau",
      "Monsieur",
    ])("%s, a field that is only a title, becomes null", (input) => {
      expect(runFirst(input)).toBeNull();
      expect(runLast(input)).toBeNull();
    });

    test.each(titles)(
      "the title %s standing alone becomes null in both name pipelines",
      (title) => {
        expect(runFirst(title)).toBeNull();
        expect(runLast(title)).toBeNull();
      },
    );

    test.each([
      ["Sir John", "JOHN"],
      ["Miss Smith", "SMITH"],
    ])("%s -> %s in both name pipelines", (input, expected) => {
      expect(runFirst(input)).toBe(expected);
      expect(runLast(input)).toBe(expected);
    });

    test("a suffix standing alone is kept", () => {
      expect(runLast("Jr")).toBe("JR");
    });
  });

  test("converts hyphen to space in hyphenated name", () => {
    expect(runLast("Smith-Jones")).toBe("SMITH JONES");
  });

  test("converts apostrophe to space", () => {
    expect(runLast("O'Brien")).toBe("O BRIEN");
  });

  test("squashes multiple spaces", () => {
    expect(runLast("Smith  Jones")).toBe("SMITH JONES");
  });

  test("returns null for a string that is only an affix", () => {
    expect(runFirst("Dr.")).toBeNull();
  });

  test("first_name and last_name clean a name of two or more letters alike", () => {
    expect(runFirst("O'Brien-Smith")).toBe(runLast("O'Brien-Smith"));
  });

  test.each([
    "Unknown",
    "UNK",
    "Doe",
    "baby",
    "Boy",
    "Girl",
    "Twin",
    "Male",
    "Female",
    "Trauma",
    "Refused",
    "Anonymous",
    "None",
    "Test",
    " unknown. ",
  ])("drops the placeholder %j in both name fields", (input) => {
    expect(runFirst(input)).toBeNull();
    expect(runLast(input)).toBeNull();
  });

  test.each([
    ["J", "J"],
    ["j.", "J"],
    [" Q ", "Q"],
    ["Dr. J", "J"],
  ])(
    "keeps %j as the one-letter first name %j and drops it as a last name",
    (input, initial) => {
      expect(runFirst(input)).toBe(initial);
      expect(runLast(input)).toBeNull();
    },
  );

  test("a one-letter first name reaches the built-in first-initial keys", () => {
    const keys = getDefaultLinkageTerms("test").linkageKeys.filter((key) =>
      ["SSN + LN + FN1", "SSN + LN3 + FN1"].includes(key.name),
    );
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      const initial = key.elements.find((e) => e.field === "first_name")!;
      const firstName = runFirst("J.");
      expect(firstName).toBe("J");
      expect(runPipeline(firstName as string, initial.transform!)).toBe("J");
    }
  });

  test.each([
    ["Jo", "JO"],
    ["J R", "J R"],
    ["Jane Doe", "JANE DOE"],
    ["Doering", "DOERING"],
    ["Baby Boy", "BABY BOY"],
  ])("keeps %j as %j", (input, expected) => {
    expect(runFirst(input)).toBe(expected);
    expect(runLast(input)).toBe(expected);
  });

  test("an edited placeholder list is the one applied, to its own field only", () => {
    const transformations = getDefaultStandardization(
      [
        { name: "FN", type: "first_name", role: "linkage", isPayload: false },
        { name: "LN", type: "last_name", role: "linkage", isPayload: false },
      ],
      {
        ...minimalTerms,
        linkageFields: [
          { name: "first_name", type: "first_name" },
          { name: "last_name", type: "last_name" },
        ],
      },
    );
    const steps = new Map(transformations.map((t) => [t.output, t.steps!]));
    const lastName = withPlaceholders(steps.get("last_name")!, "UNKNOWN", [
      "UNKNOWN",
      "NOBODY",
    ]);
    expect(runPipeline("Doe", lastName)).toBe("DOE");
    expect(runPipeline("Nobody", lastName)).toBeNull();
    expect(runPipeline("Unknown", lastName)).toBeNull();
    expect(runPipeline("Doe", steps.get("first_name")!)).toBeNull();
    expect(runPipeline("Nobody", steps.get("first_name")!)).toBe("NOBODY");
  });

  describe("Unicode whitespace folds to one space between words", () => {
    test.each([
      ["a lone no-break space", "Mary\u00a0Jane"],
      ["a lone narrow no-break space", "Mary\u202fJane"],
      ["a lone ideographic space", "Mary\u3000Jane"],
      ["a lone next-line control", "Mary\u0085Jane"],
      ["a run of mixed Unicode spaces", "Mary\u2003\u00a0 \u2009\u205fJane"],
      ["a tab", "Mary\tJane"],
      ["a carriage return", "Mary\rJane"],
      ["a line feed", "Mary\nJane"],
      ["a CRLF with surrounding spaces", "Mary \r\n Jane"],
      ["leading and trailing no-break spaces", "\u00a0Mary Jane\u00a0\t"],
    ])("%s", (_label, input) => {
      expect(runFirst(input)).toBe("MARY JANE");
      expect(runLast(input)).toBe("MARY JANE");
    });
  });

  describe("typographic apostrophes and dashes split words as ASCII ones do", () => {
    test.each(["\u2018", "\u2019", "\u201b", "\u02bc", "\uff07"])(
      "apostrophe %s",
      (apostrophe) => {
        expect(runLast(`O${apostrophe}Brien`)).toBe(runLast("O'Brien"));
      },
    );

    test.each([
      "\u2010",
      "\u2011",
      "\u2012",
      "\u2013",
      "\u2014",
      "\u2015",
      "\u2212",
      "\ufe58",
      "\ufe63",
      "\uff0d",
    ])("dash %s", (dash) => {
      expect(runLast(`Smith${dash}Jones`)).toBe(runLast("Smith-Jones"));
    });

    test("pins the right single quote and the hyphen to their ASCII outputs", () => {
      expect(runFirst("O\u2019Brien")).toBe("O BRIEN");
      expect(runLast("Smith\u2010Jones")).toBe("SMITH JONES");
    });
  });

  describe("letters with no decomposition map to an ASCII spelling", () => {
    test.each([
      ["\u00df", "ss"],
      ["\u1e9e", "SS"],
      ["\u00c6", "AE"],
      ["\u00e6", "ae"],
      ["\u0152", "OE"],
      ["\u0153", "oe"],
      ["\u00de", "TH"],
      ["\u00fe", "th"],
      ["\u0141", "L"],
      ["\u0142", "l"],
      ["\u00d8", "O"],
      ["\u00f8", "o"],
      ["\u0110", "D"],
      ["\u0111", "d"],
      ["\u00d0", "D"],
      ["\u00f0", "d"],
    ])("%s -> %s", (letter, ascii) => {
      expect(runPipeline(`a${letter}b`, [{ function: "remove_accents" }])).toBe(
        `a${ascii}b`,
      );
      const expected = `A${ascii.toUpperCase()}B`;
      expect(runFirst(`a${letter}b`)).toBe(expected);
      expect(runLast(`a${letter}b`)).toBe(expected);
    });

    test("names spelled with the letters match their ASCII spellings", () => {
      expect(runLast("Gro\u00df")).toBe(runLast("Gross"));
      expect(runLast("\u00d8stergaard")).toBe("OSTERGAARD");
      expect(runFirst("\u0141ucja")).toBe("LUCJA");
    });
  });
});

// --- Date of birth pipeline --------------------------------------------------

describe("default date_of_birth pipeline", () => {
  function run(input: string) {
    const [t] = getDefaultStandardization(
      [
        {
          name: "DOB",
          type: "date_of_birth",
          role: "linkage",
          isPayload: false,
        },
      ],
      {
        ...minimalTerms,
        linkageFields: [{ name: "date_of_birth", type: "date_of_birth" }],
      },
    );
    return runPipeline(input, t.steps!);
  }

  test("converts MM/DD/YYYY to YYYYMMDD", () => {
    expect(run("01/15/1990")).toBe("19900115");
  });

  test("pads single-digit month and day", () => {
    expect(run("1/5/1990")).toBe("19900105");
  });

  test("trims surrounding whitespace before parsing", () => {
    expect(run("  01/15/1990  ")).toBe("19900115");
  });

  test("returns null for a non-date string", () => {
    expect(run("not-a-date")).toBeNull();
  });

  test("returns null for a calendar-invalid date", () => {
    expect(run("13/01/1990")).toBeNull();
  });

  test("returns null for ISO 8601 format (YYYY-MM-DD)", () => {
    // Default pipeline assumes MM/DD/YYYY; other formats need explicit config.
    expect(run("1990-01-15")).toBeNull();
  });

  test.each([
    ["01/01/1902", "19020101"],
    ["12/31/1900", "19001231"],
    ["01/02/1900", "19000102"],
    ["01/01/2099", "20990101"],
  ])("keeps %j as %j", (input, expected) => {
    expect(run(input)).toBe(expected);
  });

  test.each(["12/31/1899", "01/01/1850", "06/15/0990"])(
    "drops %j, a year before 1900",
    (input) => {
      expect(run(input)).toBeNull();
    },
  );

  test.each(["01/01/1900", "1/1/1901"])("drops the placeholder %j", (input) => {
    expect(run(input)).toBeNull();
  });

  test("an edited placeholder list is the one applied", () => {
    const [t] = getDefaultStandardization(
      [
        {
          name: "DOB",
          type: "date_of_birth",
          role: "linkage",
          isPayload: false,
        },
      ],
      {
        ...minimalTerms,
        linkageFields: [{ name: "date_of_birth", type: "date_of_birth" }],
      },
    );
    const steps = withPlaceholders(t.steps!, "19000101", [
      "19010101",
      "19990909",
    ]);
    expect(runPipeline("01/01/1900", steps)).toBe("19000101");
    expect(runPipeline("09/09/1999", steps)).toBeNull();
    expect(runPipeline("01/01/1901", steps)).toBeNull();
  });
});

// --- Phone number pipeline ---------------------------------------------------

describe("default phone_number pipeline", () => {
  function run(input: string) {
    const [t] = getDefaultStandardization(
      [
        {
          name: "PHONE",
          type: "phone_number",
          role: "linkage",
          isPayload: false,
        },
      ],
      {
        ...minimalTerms,
        linkageFields: [{ name: "phone_number", type: "phone_number" }],
      },
    );
    return runPipeline(input, t.steps!);
  }

  test("strips formatting to 10 digits", () => {
    expect(run("(123) 456-7890")).toBe("1234567890");
  });

  test("passes a bare 10-digit number through unchanged", () => {
    expect(run("1234567890")).toBe("1234567890");
  });

  test("strips dots used as separators", () => {
    expect(run("123.456.7890")).toBe("1234567890");
  });

  test("strips leading 1 from 11-digit US number", () => {
    expect(run("11234567890")).toBe("1234567890");
  });

  test("strips +1 country code prefix", () => {
    expect(run("+11234567890")).toBe("1234567890");
  });

  test("strips +1 country code from formatted number", () => {
    expect(run("+1 (123) 456-7890")).toBe("1234567890");
  });

  test("strips 1- country code from dashed format", () => {
    expect(run("1-123-456-7890")).toBe("1234567890");
  });

  test("returns null for 11-digit number not starting with 1", () => {
    expect(run("21234567890")).toBeNull();
  });

  test("returns null for fewer than 10 digits", () => {
    expect(run("123456789")).toBeNull();
  });

  test("returns null for alphabetic input", () => {
    expect(run("not-a-phone")).toBeNull();
  });
});

// --- Email address pipeline --------------------------------------------------

describe("default email_address pipeline", () => {
  function run(input: string) {
    const [t] = getDefaultStandardization(
      [
        {
          name: "EMAIL",
          type: "email_address",
          role: "linkage",
          isPayload: false,
        },
      ],
      {
        ...minimalTerms,
        linkageFields: [{ name: "email_address", type: "email_address" }],
      },
    );
    return runPipeline(input, t.steps!);
  }

  test("lowercases a mixed-case address", () => {
    expect(run("John.Doe@Example.COM")).toBe("john.doe@example.com");
  });

  test("trims surrounding whitespace", () => {
    expect(run("  user@example.com  ")).toBe("user@example.com");
  });

  test("passes a lowercase address through unchanged", () => {
    expect(run("user@example.com")).toBe("user@example.com");
  });

  test("returns null for a string without an @ sign", () => {
    expect(run("notanemail")).toBeNull();
  });

  test("returns null for a string without a domain dot", () => {
    expect(run("user@nodot")).toBeNull();
  });

  test("strips non-ASCII before the @-pattern filter (TRANSFORM_REGEX_DIALECT ordering claim)", () => {
    // The RE2 dialect's `\s` is ASCII-only, narrower than JavaScript's. The
    // email filter pattern uses `[^\s@]`, so TRANSFORM_REGEX_DIALECT.md relies on
    // `remove_non_ascii` running before this filter_regex, so no non-ASCII code
    // point ever reaches that class. Pin the ordering so the doc's runtime claim
    // cannot rot silently (CONTRIBUTING: encode a runtime fact as a check).
    const [t] = getDefaultStandardization(
      [
        {
          name: "EMAIL",
          type: "email_address",
          role: "linkage",
          isPayload: false,
        },
      ],
      {
        ...minimalTerms,
        linkageFields: [{ name: "email_address", type: "email_address" }],
      },
    );
    const steps = t.steps ?? [];
    const asciiIdx = steps.findIndex((s) => s.function === "remove_non_ascii");
    const emailFilterIdx = steps.findIndex(
      (s) =>
        s.function === "filter_regex" &&
        typeof s.params?.pattern === "string" &&
        s.params.pattern.includes("@"),
    );
    expect(asciiIdx).toBeGreaterThanOrEqual(0);
    expect(emailFilterIdx).toBeGreaterThan(asciiIdx);
  });
});

// --- Street number pipeline --------------------------------------------------

describe("default street_number pipeline", () => {
  function run(input: string) {
    const [t] = getDefaultStandardization(
      [
        {
          name: "ADDRESS",
          type: "street_number",
          role: "linkage",
          isPayload: false,
        },
      ],
      {
        ...minimalTerms,
        linkageFields: [{ name: "street_number", type: "street_number" }],
      },
    );
    return runPipeline(input, t.steps!);
  }

  test.each([
    ["123", "123"],
    ["123 Main St", "123"],
    ["123 Main St Apt 4", "123"],
    ["123 Main St, Unit 4B", "123"],
    ["123-B Main St", "123"],
    ["123B Main St", "123"],
    ["123 N. Main St.", "123"],
    ["\t123 Main St ", "123"],
    ["100 Elm", "100"],
    ["4821", "4821"],
  ])("keeps the leading number of %j as %j", (input, expected) => {
    expect(run(input)).toBe(expected);
  });

  test("removes leading zeros, so a padded number agrees with a bare one", () => {
    expect(run("  0042 Elm")).toBe("42");
    expect(run("0042")).toBe(run("42 Elm St"));
    expect(run("007")).toBe("7");
  });

  test("keeps a range's first number", () => {
    expect(run("123-125 Main")).toBe("123");
    expect(run("123 - 125 Main")).toBe("123");
    expect(run("37-12 75th St")).toBe("37");
  });

  test("drops a fraction after the number", () => {
    expect(run("123 1/2 Main")).toBe("123");
    expect(run("123½ Main")).toBe("123");
  });

  test.each([
    "0",
    "000",
    "0 Main St",
    "Main St",
    "PO Box 12",
    "RR 2 Box 5",
    "#12 Main St",
    "No. 12 Main St",
    "N6W23001 Bluemound Rd",
    "１２３ Main St",
    "-12 Main",
    "",
    "   ",
  ])("drops %j", (input) => {
    expect(run(input)).toBeNull();
  });

  test("two parties with differently written addresses agree", () => {
    const inviter = ["123 Main St Apt 4", "0042 Elm", "7-9 Oak Ave"];
    const acceptor = ["123", "42", "7 Oak Avenue"];
    expect(inviter.map(run)).toEqual(acceptor.map(run));
  });
});

// --- Name suffix pipeline ----------------------------------------------------

describe("default name_suffix pipeline", () => {
  const suffixTerms: LinkageTerms = {
    ...minimalTerms,
    linkageFields: [{ name: "name_suffix", type: "name_suffix" }],
  };
  const suffixMetadata: ColumnMetadata[] = [
    { name: "SFX", type: "name_suffix", role: "linkage", isPayload: false },
  ];

  function run(input: string) {
    const [t] = getDefaultStandardization(suffixMetadata, suffixTerms);
    return runPipeline(input, t.steps!);
  }

  test.each(["JR", "SR", "II", "III", "IV"])("keeps the code %j", (code) => {
    expect(run(code)).toBe(code);
  });

  test.each([
    ["Jr", "JR"],
    ["jr", "JR"],
    ["Jr.", "JR"],
    ["J.R.", "JR"],
    ["Jr.,", "JR"],
    [" jr ", "JR"],
    ["Junior", "JR"],
    ["JUNIOR", "JR"],
    ["Jnr", "JR"],
    ["Sr.", "SR"],
    ["senior", "SR"],
    ["Snr", "SR"],
    ["ii", "II"],
    ["2", "II"],
    ["2nd", "II"],
    ["3rd", "III"],
    ["III.", "III"],
    ["4th", "IV"],
    ["iv", "IV"],
  ])("folds %j to %j", (input, expected) => {
    expect(run(input)).toBe(expected);
  });

  test.each(["", " ", "\t", "-", "."])(
    "keeps %j as the empty suffix",
    (input) => {
      expect(run(input)).toBe("");
    },
  );

  test.each([
    "V",
    "I",
    "3",
    "1st",
    "5th",
    "Esq",
    "MD",
    "PhD",
    "N/A",
    "None",
    "J R",
    "Jr Sr",
    "Junior High",
    "Smith Jr",
    "Jr MD",
    "III, Esq.",
    "Ⅲ",
    "ＪＲ",
  ])("drops %j", (input) => {
    expect(run(input)).toBeNull();
  });

  // The generational entries of the list remove_affixes strips, each with the
  // code it cleans to. Every other entry of that list is dropped.
  const generationalCodes: Record<string, string> = {
    jr: "JR",
    jnr: "JR",
    junior: "JR",
    sr: "SR",
    snr: "SR",
    senior: "SR",
    "2": "II",
    "2nd": "II",
    "3rd": "III",
    "4th": "IV",
    ii: "II",
    iii: "III",
    iv: "IV",
  };

  test("agrees with the suffix list the name cleaning strips", () => {
    for (const code of Object.keys(generationalCodes)) {
      expect(suffixes).toContain(code);
    }
    for (const suffix of suffixes) {
      expect(run(suffix), suffix).toBe(generationalCodes[suffix] ?? null);
    }
  });

  // Key values on both sides: a suffix element whose value is "" is kept, so
  // two records with no suffix build the same key, and JR never matches it.
  describe("key values", () => {
    const keyTerms: LinkageTerms = {
      ...minimalTerms,
      linkageFields: [
        { name: "last_name", type: "last_name" },
        { name: "first_name", type: "first_name" },
        { name: "name_suffix", type: "name_suffix" },
      ],
      linkageKeys: [
        {
          name: "LN+FN+SFX",
          elements: [
            { field: "last_name" },
            { field: "first_name" },
            { field: "name_suffix" },
          ],
        },
      ],
    };
    const keyMetadata: ColumnMetadata[] = [
      { name: "LAST", type: "last_name", role: "linkage", isPayload: false },
      { name: "FIRST", type: "first_name", role: "linkage", isPayload: false },
      { name: "SFX", type: "name_suffix", role: "linkage", isPayload: false },
    ];

    function keyValues(rows: CSVRow[]): Array<string[] | null> {
      const dataset = buildStandardizedDataset(
        getDefaultStandardization(keyMetadata, keyTerms),
        rows,
        keyMetadata,
        keyTerms,
      );
      return rows.map((_row, index) => {
        const built = buildKeyStrings(keyTerms.linkageKeys[0], dataset, index);
        return built === null ? null : [...built];
      });
    }

    test("an empty suffix is a key value, and matches an empty suffix", () => {
      const inviter = keyValues([{ LAST: "Smith", FIRST: "John", SFX: "" }]);
      const acceptor = keyValues([{ LAST: "SMITH", FIRST: "john", SFX: " " }]);
      expect(inviter).toEqual([["SMITHJOHN"]]);
      expect(acceptor).toEqual(inviter);
    });

    test("JR does not match an empty suffix", () => {
      const [junior] = keyValues([
        { LAST: "Smith", FIRST: "John", SFX: "Jr." },
      ]);
      const [none] = keyValues([{ LAST: "Smith", FIRST: "John", SFX: "" }]);
      expect(junior).toEqual(["SMITHJOHNJR"]);
      expect(junior).not.toEqual(none);
    });

    test("a folded spelling matches its code", () => {
      expect(
        keyValues([{ LAST: "Smith", FIRST: "John", SFX: "Junior" }]),
      ).toEqual(keyValues([{ LAST: "Smith", FIRST: "John", SFX: "JR" }]));
    });

    test("a dropped suffix, or a row with no suffix cell, builds no key", () => {
      expect(
        keyValues([
          { LAST: "Smith", FIRST: "John", SFX: "Esq" },
          { LAST: "Smith", FIRST: "John" },
        ]),
      ).toEqual([null, null]);
    });

    test("an empty suffix does not stand in for a missing name", () => {
      expect(keyValues([{ LAST: "", FIRST: "John", SFX: "" }])).toEqual([null]);
    });
  });
});

// --- ZIP code pipeline -------------------------------------------------------

describe("default zip_code pipeline", () => {
  function run(input: string) {
    const [t] = getDefaultStandardization(
      [{ name: "ZIP", type: "zip_code", role: "linkage", isPayload: false }],
      {
        ...minimalTerms,
        linkageFields: [{ name: "zip_code", type: "zip_code" }],
      },
    );
    return runPipeline(input, t.steps!);
  }

  test("passes a bare 5-digit ZIP through unchanged", () => {
    expect(run("90210")).toBe("90210");
  });

  test("truncates a ZIP+4 to its 5-digit prefix", () => {
    expect(run("90210-1234")).toBe("90210");
  });

  test("strips non-digit formatting before truncating", () => {
    expect(run(" 90210 ")).toBe("90210");
  });

  test("zero-pads a 4-digit New England ZIP missing its leading zero", () => {
    expect(run("2139")).toBe("02139");
  });

  test("keeps only the first 5 digits of a 9-digit ZIP+4 run together", () => {
    expect(run("902101234")).toBe("90210");
  });

  test('explicit null_if "" precedes pad_left so a cleaned-empty value never pads to 00000', () => {
    // Mirrors the SSN/SSN4 blank-drop guard: pad_left would otherwise mask a value
    // that cleaned to empty as "00000". substring already nulls an empty slice, so
    // this pins the belt-and-suspenders ordering, not new coverage.
    const [t] = getDefaultStandardization(
      [{ name: "ZIP", type: "zip_code", role: "linkage", isPayload: false }],
      {
        ...minimalTerms,
        linkageFields: [{ name: "zip_code", type: "zip_code" }],
      },
    );
    const steps = t.steps ?? [];
    const emptyDropIdx = steps.findIndex(
      (s) => s.function === "null_if" && s.params?.value === "",
    );
    const padIdx = steps.findIndex((s) => s.function === "pad_left");
    expect(emptyDropIdx).toBeGreaterThanOrEqual(0);
    expect(padIdx).toBeGreaterThan(emptyDropIdx);
  });
});

// --- ZIP3 transform ----------------------------------------------------------

describe("the zip3 transform over a cleaned zip_code", () => {
  function zip3Of(raw: string) {
    const [t] = getDefaultStandardization(
      [{ name: "ZIP", type: "zip_code", role: "linkage", isPayload: false }],
      {
        ...minimalTerms,
        linkageFields: [{ name: "zip_code", type: "zip_code" }],
      },
    );
    const cleaned = runPipeline(raw, t.steps!);
    if (typeof cleaned !== "string") return cleaned;
    return runPipeline(cleaned, [{ function: "zip3" }]);
  }

  test("keeps the leading zeros of a New England ZIP", () => {
    expect(zip3Of("02139")).toBe("021");
    expect(zip3Of("2139")).toBe("021");
    expect(zip3Of("00501")).toBe("005");
  });

  test("takes the area of a ZIP+4 from its cleaned five digits", () => {
    expect(zip3Of("20057-1234")).toBe("200");
    expect(zip3Of("200571234")).toBe("200");
  });

  test("drops a value that is not a cleaned five-digit ZIP", () => {
    expect(runPipeline("2005", [{ function: "zip3" }])).toBeNull();
    expect(runPipeline("20057-1234", [{ function: "zip3" }])).toBeNull();
    expect(runPipeline("ABCDE", [{ function: "zip3" }])).toBeNull();
    expect(runPipeline("", [{ function: "zip3" }])).toBeNull();
    expect(zip3Of("abc")).toBeNull();
  });
});

// --- State and county pipelines ----------------------------------------------

function runDefault(type: "state" | "county", input: string) {
  const [t] = getDefaultStandardization(
    [{ name: "COL", type, role: "linkage", isPayload: false }],
    { ...minimalTerms, linkageFields: [{ name: type, type }] },
  );
  return runPipeline(input, t.steps!);
}

describe("default state pipeline", () => {
  test("state_code alone folds letter case but no other spelling", () => {
    const stateCode = [{ function: "state_code" }];
    expect(runPipeline("maryland", stateCode)).toBe("MD");
    expect(runPipeline("Md", stateCode)).toBe("MD");
    expect(runPipeline("NEW  YORK", stateCode)).toBeNull();
    expect(runPipeline("D.C.", stateCode)).toBeNull();
  });

  test.each([
    ["Maryland", "MD"],
    ["MARYLAND", "MD"],
    ["mArYlAnD", "MD"],
    ["MD", "MD"],
    ["md", "MD"],
    [" New   York ", "NY"],
    ["District of Columbia", "DC"],
    ["D.C.", "DC"],
    ["Puerto Rico", "PR"],
    ["U.S. Virgin Islands", "VI"],
    ["Virgin Islands", "VI"],
    ["Guam", "GU"],
  ])("keeps %j as %j", (input, expected) => {
    expect(runDefault("state", input)).toBe(expected);
  });

  test.each([
    "Calif",
    "Ontario",
    "ZZ",
    "FM",
    "AE",
    "Marylandd",
    "Washington DC",
    "",
    "   ",
  ])("drops %j", (input) => {
    expect(runDefault("state", input)).toBeNull();
  });
});

describe("default county pipeline", () => {
  test.each([
    ["Montgomery County", "MONTGOMERY"],
    ["MONTGOMERY COUNTY", "MONTGOMERY"],
    ["montgomery county", "MONTGOMERY"],
    ["Montgomery", "MONTGOMERY"],
    ["Montgomery Co.", "MONTGOMERY CO"],
    ["Prince George's County", "PRINCE GEORGES"],
    ["St. Mary's", "ST MARYS"],
    ["Miami-Dade County", "MIAMI DADE"],
    ["Miami–Dade County", "MIAMI DADE"],
    ["County of Los Angeles", "LOS ANGELES"],
    ["Doña Ana County", "DONA ANA"],
    ["  Fairfax   County  ", "FAIRFAX"],
  ])("keeps %j as %j", (input, expected) => {
    expect(runDefault("county", input)).toBe(expected);
  });

  test.each(["", "   ", "County", "COUNTY", "..."])("drops %j", (input) => {
    expect(runDefault("county", input)).toBeNull();
  });
});

// --- inferDateFormat ---------------------------------------------------------

describe("inferDateFormat — format identification", () => {
  test("identifies MM/DD/YYYY", () => {
    expect(inferDateFormat(["01/15/1990", "12/31/2000", "06/28/1975"])).toBe(
      "MM/DD/YYYY",
    );
  });

  test("identifies YYYY-MM-DD", () => {
    expect(inferDateFormat(["1990-01-15", "2000-12-31", "1975-06-28"])).toBe(
      "YYYY-MM-DD",
    );
  });

  test("identifies YYYYMMDD", () => {
    expect(inferDateFormat(["19900115", "20001231", "19750628"])).toBe(
      "YYYYMMDD",
    );
  });

  test("identifies MM-DD-YYYY", () => {
    expect(inferDateFormat(["01-15-1990", "12-31-2000", "06-28-1975"])).toBe(
      "MM-DD-YYYY",
    );
  });

  test("identifies MM/DD/YY", () => {
    expect(inferDateFormat(["01/15/90", "12/31/00", "06/28/75"])).toBe(
      "MM/DD/YY",
    );
  });

  test("identifies YYYY/MM/DD", () => {
    expect(inferDateFormat(["1990/01/15", "2000/12/31", "1975/06/28"])).toBe(
      "YYYY/MM/DD",
    );
  });

  test("identifies DD/MM/YYYY when day > 12 disambiguates from MM/DD/YYYY", () => {
    expect(inferDateFormat(["13/05/1990", "21/03/1985", "28/12/2000"])).toBe(
      "DD/MM/YYYY",
    );
  });

  test("identifies DD-MM-YYYY when day > 12 disambiguates", () => {
    expect(inferDateFormat(["13-05-1990", "21-03-1985", "28-12-2000"])).toBe(
      "DD-MM-YYYY",
    );
  });

  test("prefers MM/DD/YYYY over DD/MM/YYYY when both are consistent (all days ≤ 12)", () => {
    expect(inferDateFormat(["01/05/1990", "03/12/1985", "06/08/2000"])).toBe(
      "MM/DD/YYYY",
    );
  });
});

describe("inferDateFormat — edge cases", () => {
  test("returns undefined for an empty array", () => {
    expect(inferDateFormat([])).toBeUndefined();
  });

  test("returns undefined when all values are empty strings", () => {
    expect(inferDateFormat(["", "  ", ""])).toBeUndefined();
  });

  test("returns undefined when no format reaches the parse threshold", () => {
    expect(
      inferDateFormat(["foo", "bar", "baz", "qux", "quux"]),
    ).toBeUndefined();
  });

  test("ignores empty strings when computing the parse fraction", () => {
    const values = ["01/15/1990", "", "12/31/2000", "  ", "06/28/1975"];
    expect(inferDateFormat(values)).toBe("MM/DD/YYYY");
  });

  test("handles whitespace-padded values", () => {
    expect(inferDateFormat(["  01/15/1990  ", "  12/31/2000  "])).toBe(
      "MM/DD/YYYY",
    );
  });

  test("rejects calendar-invalid dates, not just format mismatches", () => {
    // Month 13 is syntactically MM/DD/YYYY-like but not a valid date.
    expect(inferDateFormat(["13/32/1990", "14/29/2000"])).toBeUndefined();
  });

  test("a 7-digit value is read as YYYYMMDD, as the pipeline reads it", () => {
    expect(inferDateFormat(["1990115", "2000631"])).toBe("YYYYMMDD");
    expect(
      runPipeline("1990115", dateOfBirthParseSteps("YYYYMMDD")),
    ).not.toBeNull();
  });
});

describe("inferDateFormat — agreement with the date_of_birth parsing steps", () => {
  const probes = [
    "01/15/1990",
    "1/2/1990",
    "1/2/199",
    "1/2/90",
    "01/15/19900",
    "1990-1-2",
    "19900102",
    "1990115",
    "02/30/1990",
    "13/01/1990",
    "31-12-2000",
    "1990/02/29",
    " 01/15/1990 ",
    "01/15/1990\u00a0",
  ];

  test.each(probes)(
    "%j infers the first candidate whose pipeline keeps it",
    (value) => {
      const kept = CANDIDATE_DATE_FORMATS.find(
        (format) => runPipeline(value, dateOfBirthParseSteps(format)) !== null,
      );
      expect(inferDateFormat([value])).toBe(kept);
    },
  );

  test("a pre-1900 date still shows its layout, so the screens do not change the inferred format", () => {
    const column = ["03/04/1990", "05/06/1985", "13/05/1850", "13/06/1850"];
    const format = inferDateFormat(column);
    expect(format).toBe("DD/MM/YYYY");
    const [t] = getDefaultStandardization(
      [
        {
          name: "DOB",
          type: "date_of_birth",
          role: "linkage",
          isPayload: false,
        },
      ],
      {
        ...minimalTerms,
        linkageFields: [{ name: "date_of_birth", type: "date_of_birth" }],
      },
      { dateInputFormat: format },
    );
    expect(runPipeline("03/04/1990", t.steps!)).toBe("19900403");
    expect(runPipeline("13/05/1850", t.steps!)).toBeNull();
  });

  test("a 3-digit year parses under no candidate", () => {
    expect(inferDateFormat(["1/2/199"])).toBeUndefined();
  });
});

describe("inferDateFormat — outliers", () => {
  // Month/day/4-digit-year values with days above 12, so MM/DD/YYYY is the
  // only layout that reads all of them.
  const usDates = (count: number): Array<string> =>
    Array.from(
      { length: count },
      (_, i) => `${(i % 12) + 1}/${(i % 16) + 13}/19${50 + (i % 50)}`,
    );

  test("one 3-digit-year typo does not select MM/DD/YY", () => {
    const values = ["01/15/1990", "1/2/199", "02/20/1985", "12/31/1970"];
    expect(inferDateFormatWithCounts(values)).toEqual({
      format: "MM/DD/YYYY",
      scanned: 4,
      unparsed: 1,
    });
  });

  test("one 2-digit-year value does not select MM/DD/YY", () => {
    const values = [...usDates(20), "3/4/85", ...usDates(20)];
    expect(inferDateFormatWithCounts(values)).toEqual({
      format: "MM/DD/YYYY",
      scanned: 41,
      unparsed: 1,
    });
  });

  test("one day-first value does not select DD/MM/YYYY", () => {
    const values = ["13/01/1990", ...usDates(20)];
    expect(inferDateFormatWithCounts(values)).toEqual({
      format: "MM/DD/YYYY",
      scanned: 21,
      unparsed: 1,
    });
  });

  test("an outlier late in the scan does not select its format", () => {
    const values = usDates(1009);
    values[998] = "1/2/199";
    expect(inferDateFormatWithCounts(values)).toEqual({
      format: "MM/DD/YYYY",
      scanned: INFER_DATE_SCAN_CAP,
      unparsed: 1,
    });
  });

  test("noise supports no candidate and is counted as unparsed", () => {
    const values = ["unknown", ...usDates(3), "n/a"];
    expect(inferDateFormatWithCounts(values)).toEqual({
      format: "MM/DD/YYYY",
      scanned: 5,
      unparsed: 2,
    });
  });

  test("a column split evenly between two layouts infers no format", () => {
    const values = ["1990-01-15", "1985-06-28", ...usDates(2)];
    expect(inferDateFormatWithCounts(values)).toEqual({
      scanned: 4,
      unparsed: 4,
    });
  });

  test("a format parsing a bare majority of the dates is inferred", () => {
    const values = ["1990-01-15", "1985-06-28", ...usDates(3)];
    expect(inferDateFormat(values)).toBe("MM/DD/YYYY");
  });

  test("the incremental inferrer stops accepting at the scan cap", () => {
    const inferrer = createDateFormatInferrer();
    const accepted = usDates(INFER_DATE_SCAN_CAP + 5).map((value) =>
      inferrer.add(value),
    );
    expect(accepted.indexOf(false)).toBe(INFER_DATE_SCAN_CAP - 1);
    expect(inferrer.add("")).toBe(false);
    expect(inferrer.result().scanned).toBe(INFER_DATE_SCAN_CAP);
  });
});

describe("inferDateFormat — scanning", () => {
  test("returns the correct format for a column larger than the scan cap", () => {
    const values = Array.from({ length: INFER_DATE_SCAN_CAP * 4 }, (_, i) => {
      const year = 1950 + (i % 50);
      const month = String((i % 12) + 1).padStart(2, "0");
      const day = String((i % 28) + 1).padStart(2, "0");
      return `${month}/${day}/${year}`;
    });
    expect(inferDateFormat(values)).toBe("MM/DD/YYYY");
  });

  test("skips non-date values and continues scanning", () => {
    // Leading non-date rows are skipped (no candidate matches them); valid
    // dates that follow still narrow the candidate set normally.
    const junk = Array.from({ length: 100 }, () => "not-a-date");
    const dates = Array.from({ length: 100 }, (_, i) => {
      const month = String((i % 12) + 1).padStart(2, "0");
      const day = String((i % 28) + 1).padStart(2, "0");
      return `${month}/${day}/2000`;
    });
    expect(inferDateFormat([...junk, ...dates])).toBe("MM/DD/YYYY");
  });

  test("covers all formats in CANDIDATE_DATE_FORMATS", () => {
    // Smoke-test that every exported candidate can be identified from clean
    // data.
    const samples: Record<string, string[]> = {
      "MM/DD/YYYY": ["01/15/1990", "06/28/1975", "12/31/2000"],
      "YYYY-MM-DD": ["1990-01-15", "1975-06-28", "2000-12-31"],
      YYYYMMDD: ["19900115", "19750628", "20001231"],
      "MM-DD-YYYY": ["01-15-1990", "06-28-1975", "12-31-2000"],
      "MM/DD/YY": ["01/15/90", "06/28/75", "12/31/00"],
      "YYYY/MM/DD": ["1990/01/15", "1975/06/28", "2000/12/31"],
      "DD/MM/YYYY": ["15/01/1990", "28/06/1975", "31/12/2000"],
      "DD-MM-YYYY": ["15-01-1990", "28-06-1975", "31-12-2000"],
    };
    for (const fmt of CANDIDATE_DATE_FORMATS) {
      expect(inferDateFormat(samples[fmt]), `format: ${fmt}`).toBe(fmt);
    }
  });

  test("interleaved empties do not consume the scan budget", () => {
    // Empties are skipped lazily and must not spend the cap: a run of empty
    // values longer than INFER_DATE_SCAN_CAP, followed by real dates, must still
    // infer. If empties counted toward the cap the budget would be exhausted
    // before any date was reached and the result would be undefined.
    const values = [
      ...Array.from({ length: INFER_DATE_SCAN_CAP * 2 }, () => ""),
      "01/15/1990",
      "12/31/2000",
      "06/28/1975",
    ];
    expect(inferDateFormat(values)).toBe("MM/DD/YYYY");
  });

  test("consumes the source lazily, stopping at the scan cap", () => {
    // All days and months <= 12 keep both MM/DD/YYYY and DD/MM/YYYY alive, so the
    // candidate set never narrows to one and the cap alone governs how far we
    // scan. The generator can yield far past the cap; inferDateFormat must stop
    // pulling at INFER_DATE_SCAN_CAP rather than draining the whole source -- the
    // property that lets a large file be scanned without materializing its column.
    let yielded = 0;
    function* ambiguousDates(): Generator<string> {
      for (let i = 0; i < INFER_DATE_SCAN_CAP * 3; i++) {
        yielded++;
        yield "01/05/1990";
      }
    }
    expect(inferDateFormat(ambiguousDates())).toBe("MM/DD/YYYY");
    expect(yielded).toBeLessThanOrEqual(INFER_DATE_SCAN_CAP + 1);
  });
});

describe("columnValues", () => {
  test("yields each row's value for the named column", () => {
    expect([...columnValues([{ dob: "a" }, { dob: "b" }], "dob")]).toEqual([
      "a",
      "b",
    ]);
  });

  test("yields the empty string for a row missing the column", () => {
    expect([
      ...columnValues([{ dob: "a" }, { other: "x" }, { dob: "c" }], "dob"),
    ]).toEqual(["a", "", "c"]);
  });

  test("is lazy: pulls a row only as the consumer advances", () => {
    let yielded = 0;
    function* rows(): Generator<Record<string, string>> {
      for (let i = 0; i < 100; i++) {
        yielded++;
        yield { dob: "01/15/1990" };
      }
    }
    const gen = columnValues(rows(), "dob");
    gen.next();
    gen.next();
    expect(yielded).toBe(2);
  });
});

// --- getDefaultStandardization -- dateInputFormat option ---------------------

describe("getDefaultStandardization — dateInputFormat option", () => {
  const dobTerms: LinkageTerms = {
    ...minimalTerms,
    linkageFields: [{ name: "date_of_birth", type: "date_of_birth" }],
  };
  const dobMeta = [
    {
      name: "DOB",
      type: "date_of_birth" as const,
      role: "linkage" as const,
      isPayload: false,
    },
  ];

  test("defaults to MM/DD/YYYY when no option is provided", () => {
    const [t] = getDefaultStandardization(dobMeta, dobTerms);
    expect(runPipeline("01/15/1990", t.steps!)).toBe("19900115");
    expect(runPipeline("1990-01-15", t.steps!)).toBeNull();
  });

  test("uses the provided dateInputFormat", () => {
    const [t] = getDefaultStandardization(dobMeta, dobTerms, {
      dateInputFormat: "YYYY-MM-DD",
    });
    expect(runPipeline("1990-01-15", t.steps!)).toBe("19900115");
    expect(runPipeline("01/15/1990", t.steps!)).toBeNull();
  });

  test("YYYYMMDD input format round-trips correctly", () => {
    const [t] = getDefaultStandardization(dobMeta, dobTerms, {
      dateInputFormat: "YYYYMMDD",
    });
    expect(runPipeline("19900115", t.steps!)).toBe("19900115");
  });

  test("a two-digit-year (MM/DD/YY) DOB column standardizes to non-empty keys", () => {
    // The default/recommended path binds parse_date with the inferred MM/DD/YY
    // format; the YY token parses, so a two-digit-year DOB column produces key
    // values rather than emptying. The year resolves against the fixed 1969-2068
    // window: 90 -> 1990, and 00 -> 2000.
    const [t] = getDefaultStandardization(dobMeta, dobTerms, {
      dateInputFormat: "MM/DD/YY",
    });
    expect(runPipeline("01/15/90", t.steps!)).toBe("19900115");
    expect(runPipeline("12/31/00", t.steps!)).toBe("20001231");
    expect(runPipeline("not-a-date", t.steps!)).toBeNull();
  });

  test("the inferred format for a 2-digit-year column feeds the default pipeline end to end", () => {
    // Inference selects MM/DD/YY for two-digit data (see inferDateFormat tests),
    // and the format it selects is one core tokenizes, so the bound pipeline
    // matches what core parses rather than dropping every record.
    const values = ["01/15/90", "12/31/00", "06/28/75"];
    const dateInputFormat = inferDateFormat(values);
    expect(dateInputFormat).toBe("MM/DD/YY");
    const [t] = getDefaultStandardization(dobMeta, dobTerms, {
      dateInputFormat,
    });
    for (const value of values)
      expect(runPipeline(value, t.steps!), `input ${value}`).not.toBeNull();
  });

  test("two parties with different clocks produce identical keys for a 2-digit-year DOB", () => {
    // The pivot is a fixed protocol constant, not a clock read: standardize the
    // same two-digit-year DOB under two wildly different local clocks and require
    // byte-identical output. A per-party clock read would split a boundary year
    // across centuries and miss the match; the constant makes them agree by
    // construction. Definitional here, but it stands as a regression guard against
    // any clock read sneaking back into the default path.
    const keyUnderClock = (isoNow: string) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(isoNow));
      try {
        const [t] = getDefaultStandardization(dobMeta, dobTerms, {
          dateInputFormat: "MM/DD/YY",
        });
        return runPipeline("06/15/40", t.steps!);
      } finally {
        vi.useRealTimers();
      }
    };
    const keyA = keyUnderClock("2099-01-01T00:00:00Z");
    const keyB = keyUnderClock("2000-01-01T00:00:00Z");
    expect(keyA).toBe("20400615");
    expect(keyB).toBe(keyA);
  });

  test("non-date types are unaffected by dateInputFormat", () => {
    const terms: LinkageTerms = {
      ...minimalTerms,
      linkageFields: [{ name: "ssn", type: "ssn" }],
    };
    const meta = [
      {
        name: "SSN",
        type: "ssn" as const,
        role: "linkage" as const,
        isPayload: false,
      },
    ];
    const withOpt = getDefaultStandardization(meta, terms, {
      dateInputFormat: "YYYY-MM-DD",
    });
    const withoutOpt = getDefaultStandardization(meta, terms);
    expect(withOpt).toEqual(withoutOpt);
  });
});
