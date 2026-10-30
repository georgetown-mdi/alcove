import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  ALIAS_TYPE_META_MAP,
  RUN_TOGETHER_RECORD_NUMBER_LOOKUP_KEYS,
} from "../../src/config/metadata";
import { safeParseLinkageTerms } from "../../src/config/linkageTermsSchema";
import { getDefaultStandardization } from "../../src/defaults/builtInStandardization";
import { runPipeline, suffixes, titles } from "../../src/standardization";
import { SEMANTIC_TYPES } from "../../src/types";
import { US_STATE_CODES } from "../../src/usStateCodes";
import { DIRECTIONALS, STREET_SUFFIXES } from "../../src/uspsStreetName";
import { SECONDARY_UNIT_DESIGNATORS } from "../../src/defaults/secondaryUnitDesignators";
import { snakeizeKeys } from "../../src/utils/camelizeKeys";
import {
  CANDIDATE_DATE_FORMATS,
  INFER_DATE_SCAN_CAP,
} from "../../src/utils/date";

import type { ColumnMetadata } from "../../src/config/metadata";
import type {
  LinkageField,
  LinkageTerms,
} from "../../src/config/linkageTermsSchema";
import type { StandardizationStep } from "../../src/config/standardizationSchema";
import type { SemanticType } from "../../src/types";

// docs/spec/DEFAULT_STANDARDIZATION.md mirrors registries that live only in
// code: the per-type step arrays, the inference alias table, and the
// date-format inference parameters. This suite reads the published document
// and drives the shipped functions against it, so an edit to either side
// that drifts from the other fails here, rather than keeping a second copy
// of the pipelines as a third place to drift.
const DOC_RELATIVE_PATH = "docs/spec/DEFAULT_STANDARDIZATION.md";
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const docLines = readFileSync(`${repoRoot}${DOC_RELATIVE_PATH}`, "utf8").split(
  "\n",
);

// --- Document parsing --------------------------------------------------------

interface TypeSection {
  stepsYaml: string;
  examples: Array<{ input: string; result: string | null }>;
}

const CODE_SPAN = /^`(.*)`$/s;

function unwrapCodeSpan(cell: string): string {
  const match = CODE_SPAN.exec(cell.trim());
  if (match === null)
    throw new Error(`${DOC_RELATIVE_PATH}: expected a code span, got: ${cell}`);
  return match[1];
}

// A cell holding a JSON scalar in a code span (`"abc"` or `null`), the form the
// worked-example tables use so leading and trailing whitespace stays visible.
function jsonScalarCell(cell: string): string | null {
  const raw = unwrapCodeSpan(cell);
  const value: unknown = JSON.parse(raw);
  if (value !== null && typeof value !== "string")
    throw new Error(
      `${DOC_RELATIVE_PATH}: expected a string or null, got: ${raw}`,
    );
  return value;
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isSeparatorRow(line: string): boolean {
  return /^\|[\s:|-]+\|$/.test(line);
}

// Rows of the table whose header row is at `headerIndex`, up to the first line
// that is not a table row.
function tableRows(headerIndex: number): string[][] {
  const rows: string[][] = [];
  for (let i = headerIndex + 1; i < docLines.length; i++) {
    const line = docLines[i];
    if (!line.startsWith("|")) break;
    if (isSeparatorRow(line)) continue;
    rows.push(splitRow(line));
  }
  return rows;
}

function parseDocument() {
  const typeSections = new Map<string, TypeSection>();
  const aliasRows: string[][] = [];
  const parameterRows: string[][] = [];
  const affixRows: string[][] = [];
  const stateCodeRows: string[][] = [];
  const streetSuffixRows: string[][] = [];
  const directionalRows: string[][] = [];
  const unitDesignatorRows: string[][] = [];
  const affixExamples: Array<{ input: string; result: string | null }> = [];
  const derivedSsn4: TypeSection = { stepsYaml: "", examples: [] };
  let currentType: string | undefined;
  let inAffixSection = false;
  let inDerivedSsn4Section = false;
  let inFence = false;
  let fenceLanguage = "";
  let fenceBody: string[] = [];
  const currentSection = (): TypeSection | undefined =>
    currentType === undefined ? undefined : typeSections.get(currentType);

  for (let i = 0; i < docLines.length; i++) {
    const line = docLines[i];

    if (line.startsWith("```")) {
      if (!inFence) {
        inFence = true;
        fenceLanguage = line.slice(3).trim();
        fenceBody = [];
        continue;
      }
      inFence = false;
      const section = inDerivedSsn4Section ? derivedSsn4 : currentSection();
      if (fenceLanguage === "yaml" && section?.stepsYaml === "")
        section.stepsYaml = fenceBody.join("\n");
      continue;
    }
    if (inFence) {
      fenceBody.push(line);
      continue;
    }

    const typeHeading = /^### `([a-z0-9_]+)`$/.exec(line);
    if (typeHeading !== null) {
      currentType = typeHeading[1];
      typeSections.set(currentType, { stepsYaml: "", examples: [] });
      inAffixSection = false;
      inDerivedSsn4Section = false;
      continue;
    }
    // Any other heading of the same or a higher level closes the type section.
    if (/^#{1,3} /.test(line)) currentType = undefined;
    // The "Affix removal" subsection's own worked examples are their own
    // bucket, not absorbed into whichever type section is still open: the
    // rule it documents applies to first_name and last_name alike.
    if (/^#+ /.test(line)) inAffixSection = /^#### Affix removal$/.test(line);
    // The derived ssn4 pipeline and its worked examples are a bucket of their
    // own too, checked against the steps that derive ssn4 from an ssn column.
    if (/^#+ /.test(line))
      inDerivedSsn4Section = /^#### Last four derived from a full SSN$/.test(
        line,
      );

    if (/^\| Input \| Result \|/.test(line)) {
      if (inDerivedSsn4Section) {
        for (const row of tableRows(i))
          derivedSsn4.examples.push({
            input: jsonScalarCell(row[0]) ?? "",
            result: jsonScalarCell(row[1]),
          });
        continue;
      }
      if (inAffixSection) {
        for (const row of tableRows(i))
          affixExamples.push({
            input: jsonScalarCell(row[0]) ?? "",
            result: jsonScalarCell(row[1]),
          });
        continue;
      }
      const section = currentSection();
      if (section === undefined)
        throw new Error(
          `${DOC_RELATIVE_PATH}:${i + 1}: worked examples outside a type section`,
        );
      for (const row of tableRows(i))
        section.examples.push({
          input: jsonScalarCell(row[0]) ?? "",
          result: jsonScalarCell(row[1]),
        });
      continue;
    }
    if (/^\| Semantic type \|/.test(line)) aliasRows.push(...tableRows(i));
    if (/^\| Parameter \| Value \|/.test(line))
      parameterRows.push(...tableRows(i));
    if (/^\| List \| Words \|/.test(line)) affixRows.push(...tableRows(i));
    if (/^\| Code \| Names \|/.test(line)) stateCodeRows.push(...tableRows(i));
    if (/^\| Suffix name \| Forms \| Abbreviation \|/.test(line))
      streetSuffixRows.push(...tableRows(i));
    if (/^\| Directional \| Abbreviation \|/.test(line))
      directionalRows.push(...tableRows(i));
    if (/^\| Designator \| Abbreviation \| Stands alone \|/.test(line))
      unitDesignatorRows.push(...tableRows(i));
  }

  return {
    typeSections,
    aliasRows,
    parameterRows,
    affixRows,
    affixExamples,
    stateCodeRows,
    streetSuffixRows,
    directionalRows,
    unitDesignatorRows,
    derivedSsn4,
  };
}

const {
  typeSections,
  aliasRows,
  parameterRows,
  affixRows,
  affixExamples,
  stateCodeRows,
  streetSuffixRows,
  directionalRows,
  unitDesignatorRows,
  derivedSsn4,
} = parseDocument();

// The Words cell is a plain comma-separated list (unlike the alias table's code
// spans), in the order the doc lists them for reading.
function affixWords(listName: string): string[] {
  const row = affixRows.find((cells) => cells[0] === listName);
  if (row === undefined)
    throw new Error(`${DOC_RELATIVE_PATH}: no affix row for "${listName}"`);
  return row[1].split(",").map((word) => word.trim());
}

// --- Registry side -----------------------------------------------------------

function termsFor(types: readonly SemanticType[]): LinkageTerms {
  return {
    version: "1.0.0",
    identity: "doc parity",
    date: "2025-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: false,
    linkageFields: types.map((type) => ({
      name: type,
      type,
    })) as LinkageField[],
    linkageKeys: [{ name: "key", elements: [{ field: types[0] }] }],
  };
}

function metadataFor(types: readonly SemanticType[]): ColumnMetadata[] {
  return types.map((type) => ({
    name: type,
    type,
    role: "linkage",
    isPayload: false,
  }));
}

// The semantic types the linkage-terms schema accepts as a linkage field: the
// set the defaults must cover, recovered from the schema rather than listed.
const linkageFieldTypes = SEMANTIC_TYPES.filter(
  (type) => safeParseLinkageTerms(termsFor([type])).success,
);

const defaultTransformations = getDefaultStandardization(
  metadataFor(linkageFieldTypes),
  termsFor(linkageFieldTypes),
);

const defaultSteps = new Map<string, StandardizationStep[]>(
  defaultTransformations.map((transformation) => [
    transformation.output,
    transformation.steps ?? [],
  ]),
);

const defaultMaxPeoplePerValue = new Map<string, number | undefined>(
  defaultTransformations.map((transformation) => [
    transformation.output,
    transformation.maxPeoplePerValue,
  ]),
);

const defaultNullIfLastName = new Map(
  defaultTransformations.map((transformation) => [
    transformation.output,
    transformation.nullIfLastName,
  ]),
);

// --- Assertions --------------------------------------------------------------

describe("DEFAULT_STANDARDIZATION.md pipelines", () => {
  test("documents exactly the types the defaults clean", () => {
    expect([...typeSections.keys()].sort()).toEqual(
      [...defaultSteps.keys()].sort(),
    );
  });

  test("covers every type a linkage field may declare", () => {
    expect([...defaultSteps.keys()].sort()).toEqual(
      [...linkageFieldTypes].sort(),
    );
  });

  test.each([...typeSections.keys()])("%s steps match the registry", (type) => {
    const documented = parseYaml(typeSections.get(type)!.stepsYaml) as {
      steps: unknown;
    };
    expect(documented.steps).toEqual(snakeizeKeys(defaultSteps.get(type)));
  });

  test.each([...typeSections.keys()])(
    "%s shared-value screen matches the registry",
    (type) => {
      const documented = parseYaml(typeSections.get(type)!.stepsYaml) as {
        max_people_per_value?: unknown;
      };
      expect(documented.max_people_per_value).toEqual(
        defaultMaxPeoplePerValue.get(type),
      );
    },
  );

  test.each([...typeSections.keys()])(
    "%s rule for a listed last name matches the registry",
    (type) => {
      const documented = parseYaml(typeSections.get(type)!.stepsYaml) as {
        null_if_last_name?: unknown;
      };
      expect(documented.null_if_last_name).toEqual(
        snakeizeKeys(defaultNullIfLastName.get(type)),
      );
    },
  );

  test.each([...typeSections.keys()])("%s worked examples hold", (type) => {
    const steps = defaultSteps.get(type)!;
    const examples = typeSections.get(type)!.examples;
    expect(examples.length).toBeGreaterThan(0);
    for (const { input, result } of examples)
      expect(
        runPipeline(input, steps),
        `input ${JSON.stringify(input)}`,
      ).toEqual(result);
  });
});

describe("DEFAULT_STANDARDIZATION.md ssn4 derived from a full SSN", () => {
  const derivedSteps =
    getDefaultStandardization(
      metadataFor(["ssn"]),
      termsFor(["ssn", "ssn4"]),
    ).find((transformation) => transformation.output === "ssn4")?.steps ?? [];

  test("steps match the derivation", () => {
    const documented = parseYaml(derivedSsn4.stepsYaml) as { steps: unknown };
    expect(derivedSteps.length).toBeGreaterThan(0);
    expect(documented.steps).toEqual(snakeizeKeys(derivedSteps));
  });

  test("worked examples hold", () => {
    expect(derivedSsn4.examples.length).toBeGreaterThan(0);
    for (const { input, result } of derivedSsn4.examples)
      expect(
        runPipeline(input, derivedSteps),
        `input ${JSON.stringify(input)}`,
      ).toEqual(result);
  });
});

describe("DEFAULT_STANDARDIZATION.md inference table", () => {
  test("matches the alias registry", () => {
    const documented = new Map<string, unknown>();
    for (const [type, aliases, role, isPayload] of aliasRows)
      for (const alias of aliases.split(","))
        documented.set(unwrapCodeSpan(alias), {
          type: unwrapCodeSpan(type),
          role: unwrapCodeSpan(role),
          isPayload: unwrapCodeSpan(isPayload) === "true",
        });
    expect(Object.fromEntries(documented)).toEqual(ALIAS_TYPE_META_MAP);
  });

  test("lists the run-together record-number keys the code holds", () => {
    const start = docLines.findIndex((line) =>
      line.startsWith("The run-together record-number list holds"),
    );
    expect(start).toBeGreaterThanOrEqual(0);
    const paragraph = docLines
      .slice(start, docLines.indexOf("", start))
      .join(" ");
    const documented = [...paragraph.matchAll(/`([^`]+)`/g)].map(
      (match) => match[1],
    );
    expect(documented).toHaveLength(
      RUN_TOGETHER_RECORD_NUMBER_LOOKUP_KEYS.size,
    );
    expect(new Set(documented)).toEqual(RUN_TOGETHER_RECORD_NUMBER_LOOKUP_KEYS);
  });
});

describe("DEFAULT_STANDARDIZATION.md affix table", () => {
  test("lists the titles removeAffixes strips", () => {
    expect(affixWords("Titles")).toEqual(titles);
  });

  test("lists the suffixes removeAffixes strips", () => {
    expect(affixWords("Suffixes")).toEqual(suffixes);
  });

  test("worked examples hold for both first_name and last_name", () => {
    const firstNameSteps = defaultSteps.get("first_name")!;
    const lastNameSteps = defaultSteps.get("last_name")!;
    expect(affixExamples.length).toBeGreaterThan(0);
    for (const { input, result } of affixExamples) {
      expect(
        runPipeline(input, firstNameSteps),
        `first_name input ${JSON.stringify(input)}`,
      ).toEqual(result);
      expect(
        runPipeline(input, lastNameSteps),
        `last_name input ${JSON.stringify(input)}`,
      ).toEqual(result);
    }
  });
});

describe("DEFAULT_STANDARDIZATION.md state table", () => {
  test("lists exactly the codes and names state_code recognizes", () => {
    const documented = stateCodeRows.map(([code, names]) => ({
      code: unwrapCodeSpan(code),
      names: names.split(",").map(unwrapCodeSpan),
    }));
    expect(documented).toEqual(US_STATE_CODES);
  });
});

describe("DEFAULT_STANDARDIZATION.md street name and unit tables", () => {
  test("lists exactly the suffix rows usps_street_name reads", () => {
    const documented = streetSuffixRows.map(([name, forms, abbreviation]) => ({
      name: unwrapCodeSpan(name),
      forms: forms.split(",").map(unwrapCodeSpan),
      abbreviation: unwrapCodeSpan(abbreviation),
    }));
    expect(documented).toEqual(STREET_SUFFIXES);
  });

  test("lists exactly the directionals usps_street_name reads", () => {
    const documented = directionalRows.map(([word, abbreviation]) => ({
      word: unwrapCodeSpan(word),
      abbreviation: unwrapCodeSpan(abbreviation),
    }));
    expect(documented).toEqual(DIRECTIONALS);
  });

  test("lists exactly the designators the unit pipeline reads", () => {
    const documented = unitDesignatorRows.map(
      ([names, abbreviation, standsAlone]) => ({
        names: names.split(",").map(unwrapCodeSpan),
        abbreviation: unwrapCodeSpan(abbreviation),
        standsAlone: standsAlone === "yes",
      }),
    );
    expect(documented).toEqual(SECONDARY_UNIT_DESIGNATORS);
  });
});

describe("DEFAULT_STANDARDIZATION.md date-format inference", () => {
  const parameter = (label: string): string => {
    const row = parameterRows.find((cells) => cells[0] === label);
    if (row === undefined)
      throw new Error(`${DOC_RELATIVE_PATH}: no parameter row for "${label}"`);
    return row[1];
  };

  test("lists the candidate formats in tie-break order", () => {
    const documented = parameter("Candidate input formats, in tie-break order")
      .split(",")
      .map(unwrapCodeSpan);
    expect(documented).toEqual([...CANDIDATE_DATE_FORMATS]);
  });

  test("states the scan cap", () => {
    expect(
      Number(unwrapCodeSpan(parameter("Maximum non-empty values scanned"))),
    ).toBe(INFER_DATE_SCAN_CAP);
  });
});
