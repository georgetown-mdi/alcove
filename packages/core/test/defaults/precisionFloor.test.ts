import { describe, expect, test } from "vitest";

import * as core from "../../src/main";
import {
  BUILT_IN_LINKAGE_RULE_SETS,
  DEFAULT_LINKAGE_RULE_SET,
  DEFAULT_PRECISION_FLOOR_SELECTION,
  ONE_STATE_OR_METRO_AREA_NOT_ASKED,
  PRECISION_FLOORS,
  checkLinkageRuleSetCitation,
  findBuiltInLinkageRuleSet,
  getDefaultLinkageTerms,
  linkageKeysAtPrecisionFloor,
  linkageRuleSetReferenceFor,
  linkageTermsFromRuleSet,
  precisionFloorAsksCoverage,
  precisionFloorSelectionStatement,
  precisionFloorStatement,
  resolveLinkageRuleSetCitation,
} from "../../src/defaults/builtInLinkageTerms";
import { inferMetadata } from "../../src/config/metadata";

import type { LinkageRuleBand } from "../../src/defaults/builtInLinkageTerms";

const catalog = DEFAULT_LINKAGE_RULE_SET;
const bands: ReadonlyArray<LinkageRuleBand> = catalog.ruleBands ?? [];
const bandOf = (name: string): LinkageRuleBand | undefined =>
  bands.find((band) => band.rule === name);
const names = (keys: ReadonlyArray<{ name: string }>): Array<string> =>
  keys.map((key) => key.name);

describe("the catalog's bands", () => {
  test("give every key a band, in the keys' own order", () => {
    const bandedRules = bands
      .filter((band) => band.needs === undefined)
      .map((band) => band.rule);
    expect(names(catalog.linkageKeys)).toStrictEqual(bandedRules);
  });

  test("name a rule that needs an element no field supplies, with no key", () => {
    const unbuilt = bands.filter((band) => band.needs !== undefined);
    expect(unbuilt.map((band) => band.rule)).toStrictEqual([
      "LN + FN + DOB + street number + ZIP5",
      "LN + FN + SFX + PHONE",
      "PHONE + soundex(LN) + FN + SFX",
      "FN + SFX + PHONE",
      "LN + FN + SFX + EMAIL",
      "EMAIL + soundex(LN) + FN + SFX",
    ]);
    for (const band of unbuilt)
      expect(names(catalog.linkageKeys)).not.toContain(band.rule);
  });

  test("run the 99% band before the 95% band", () => {
    const order = bands.map((band) => band.band);
    expect(order).toStrictEqual([...order].sort((a, b) => b - a));
  });
});

describe("a precision floor", () => {
  const at99 = names(
    linkageKeysAtPrecisionFloor(catalog, {
      floor: 99,
      oneStateOrMetroArea: true,
    }),
  );
  const at95 = names(
    linkageKeysAtPrecisionFloor(catalog, {
      floor: 95,
      oneStateOrMetroArea: true,
    }),
  );

  test("selects a rule above the floor", () => {
    expect(bandOf("SSN + LN + DOB")?.band).toBe(99);
    expect(at95).toContain("SSN + LN + DOB");
  });

  test("selects a rule at the floor", () => {
    expect(at99).toContain("SSN + LN + DOB");
    expect(bandOf("SSN + FN")?.band).toBe(95);
    expect(at95).toContain("SSN + FN");
  });

  test("withholds a rule below the floor", () => {
    expect(at99).not.toContain("SSN + FN");
    expect(at99.every((name) => bandOf(name)?.band === 99)).toBe(true);
  });

  test("keeps the catalog order", () => {
    expect(at99).toStrictEqual(
      names(catalog.linkageKeys).filter((name) => at99.includes(name)),
    );
    expect(at95).toStrictEqual(names(catalog.linkageKeys));
  });
});

describe("the coverage answer", () => {
  const sameAreaOnly = [
    "LN + FN + DOB",
    "swap(LN, FN) + DOB",
    "split(LN) + FN + DOB",
  ];

  test("admits the name and date rules where both files share one area", () => {
    const keys = names(
      linkageKeysAtPrecisionFloor(catalog, {
        floor: 95,
        oneStateOrMetroArea: true,
      }),
    );
    for (const name of sameAreaOnly) expect(keys).toContain(name);
  });

  test("withholds them otherwise, and only them", () => {
    const keys = names(
      linkageKeysAtPrecisionFloor(catalog, {
        floor: 95,
        oneStateOrMetroArea: false,
      }),
    );
    for (const name of sameAreaOnly) expect(keys).not.toContain(name);
    expect(
      names(catalog.linkageKeys).filter((name) => !keys.includes(name)),
    ).toStrictEqual(
      bands
        .filter(
          (band) =>
            band.coverage === "one_state_or_metro_area" &&
            band.needs === undefined,
        )
        .map((band) => band.rule),
    );
  });
});

describe("the geography rules", () => {
  const ZIP3_RULE = "LN + FN + DOB + ZIP3";
  const STATE_RULE = "LN + FN + DOB + STATE";
  const COUNTY_RULE = "LN + FN + DOB + COUNTY";
  const GEOGRAPHY_RULES = [ZIP3_RULE, STATE_RULE, COUNTY_RULE];

  const withGeography = inferMetadata(
    ["first_name", "last_name", "dob", "zip", "state", "county"],
    [],
  );
  const keysFor = (
    metadata: ReturnType<typeof inferMetadata>,
    floor: 99 | 95,
    oneStateOrMetroArea: boolean,
  ) =>
    names(
      linkageTermsFromRuleSet(catalog, "Party A", metadata, {
        floor,
        oneStateOrMetroArea,
      }).linkageKeys,
    );

  test("are built from the ZIP3, state and county elements", () => {
    const keyOf = (name: string) =>
      catalog.linkageKeys.find((key) => key.name === name);
    const nameAndDate = [
      { field: "last_name" },
      { field: "first_name" },
      { field: "date_of_birth" },
    ];
    expect(keyOf(ZIP3_RULE)?.elements).toStrictEqual([
      ...nameAndDate,
      { field: "zip_code", transform: [{ function: "zip3" }] },
    ]);
    expect(keyOf(STATE_RULE)?.elements).toStrictEqual([
      ...nameAndDate,
      { field: "state" },
    ]);
    expect(keyOf(COUNTY_RULE)?.elements).toStrictEqual([
      ...nameAndDate,
      { field: "county" },
    ]);
    expect(
      catalog.linkageFields.filter((field) =>
        ["state", "county"].includes(field.name),
      ),
    ).toStrictEqual([
      { name: "state", type: "state" },
      { name: "county", type: "county" },
    ]);
  });

  test("sit in the 95% band at any coverage", () => {
    expect(bandOf(ZIP3_RULE)).toStrictEqual({
      rule: ZIP3_RULE,
      band: 95,
      coverage: "any",
    });
    expect(bandOf(STATE_RULE)).toStrictEqual({
      rule: STATE_RULE,
      band: 95,
      coverage: "any",
    });
    expect(bandOf(COUNTY_RULE)).toStrictEqual({
      rule: COUNTY_RULE,
      band: 95,
      coverage: "any",
    });
  });

  test("are selected by floor and coverage answer as their bands state", () => {
    expect(keysFor(withGeography, 95, true)).toEqual(
      expect.arrayContaining(GEOGRAPHY_RULES),
    );
    const at95No = keysFor(withGeography, 95, false);
    expect(at95No).toEqual(expect.arrayContaining(GEOGRAPHY_RULES));
    for (const oneStateOrMetroArea of [true, false])
      for (const rule of GEOGRAPHY_RULES)
        expect(keysFor(withGeography, 99, oneStateOrMetroArea)).not.toContain(
          rule,
        );
  });

  test("are selected only where the file supplies the column", () => {
    const zipOnly = inferMetadata(
      ["first_name", "last_name", "dob", "zip"],
      [],
    );
    expect(keysFor(zipOnly, 95, true)).toContain(ZIP3_RULE);
    expect(keysFor(zipOnly, 95, true)).not.toContain(STATE_RULE);
    expect(keysFor(zipOnly, 95, true)).not.toContain(COUNTY_RULE);
    const stateOnly = inferMetadata(
      ["first_name", "last_name", "dob", "state"],
      [],
    );
    expect(keysFor(stateOnly, 95, true)).toContain(STATE_RULE);
    expect(keysFor(stateOnly, 95, true)).not.toContain(ZIP3_RULE);
    const countyOnly = inferMetadata(
      ["first_name", "last_name", "dob", "county_name"],
      [],
    );
    expect(keysFor(countyOnly, 95, true)).toContain(COUNTY_RULE);
    expect(keysFor(countyOnly, 95, true)).not.toContain(STATE_RULE);
  });

  test("run in the catalog's order, before the name and date rule they refine", () => {
    const keys = keysFor(withGeography, 95, true);
    expect(keys).toStrictEqual([
      "LN + FN + DOB + ZIP5",
      ZIP3_RULE,
      "ZIP5 + soundex(LN) + FN + DOB",
      "ZIP5 + LN + FN + DOB +/-1 year",
      STATE_RULE,
      COUNTY_RULE,
      "LN + FN + DOB",
      "swap(LN, FN) + DOB",
      "split(LN) + FN + DOB",
      "LN + FN + YOB + MOB + ZIP5",
    ]);
    const all = names(catalog.linkageKeys);
    expect(all.indexOf(ZIP3_RULE)).toBe(
      all.indexOf("SSN4 + LN4 + YOB + MOB") + 1,
    );
    expect(all.indexOf(STATE_RULE)).toBe(
      all.indexOf("ZIP5 + LN + FN + DOB +/-1 year") + 1,
    );
    expect(all.indexOf(COUNTY_RULE)).toBe(all.indexOf(STATE_RULE) + 1);
    expect(all.indexOf("LN + FN + DOB")).toBe(all.indexOf(COUNTY_RULE) + 1);
  });

  test("leave a file with no ZIP, state or county column the keys and fields it had", () => {
    const withoutGeography = inferMetadata(
      ["ssn", "first_name", "last_name", "dob", "phone", "email"],
      [],
    );
    const terms = linkageTermsFromRuleSet(catalog, "Party A", withoutGeography);
    expect(names(terms.linkageKeys)).toStrictEqual([
      "SSN + LN + DOB",
      "SSN + LN4 + DOB",
      "SSN + LN3 + DOB",
      "SSN + DOB + FN",
      "SSN + FN3 + DOB",
      "SSN + DOB",
      "SSN + FN + LN",
      "SSN + soundex(FN) + soundex(LN)",
      "SSN + LN + FN1",
      "SSN + LN3 + FN1",
      "SSN + FN + YOB + MOB",
      "SSN + FN3 + YOB + MOB",
      "SSN + LN4 + YOB + MOB",
      "SSN4 + LN + DOB",
      "SSN4 + split(LN) + FN + DOB",
      "SSN4 + FN + DOB",
      "SSN4 + LN + FN + DOB +/-1 year",
      "SSN4 + LN + FN + DOB +/-1 day",
      "SSN4 + LN + FN + DOB day/month exchanged",
      "SSN4 + swap(LN, FN) + DOB",
      "LN + FN + DOB + PHONE",
      "FN + DOB + PHONE",
      "SSN + FN",
      "SSN4 + LN4 + YOB + MOB",
      "LN + FN + DOB",
      "swap(LN, FN) + DOB",
      "split(LN) + FN + DOB",
      "FN + DOB + EMAIL",
    ]);
    expect(terms.linkageFields.map((field) => field.name)).toStrictEqual([
      "ssn",
      "ssn4",
      "first_name",
      "last_name",
      "date_of_birth",
      "phone_number",
      "email_address",
    ]);
  });

  test("cite the catalog over the subset a file with these columns supplies", () => {
    const terms = linkageTermsFromRuleSet(catalog, "Party A", withGeography);
    expect(terms.linkageFields.map((field) => field.name)).toStrictEqual([
      "first_name",
      "last_name",
      "date_of_birth",
      "zip_code",
      "state",
      "county",
    ]);
    expect(linkageRuleSetReferenceFor(terms)).toStrictEqual(catalog.reference);
    expect(checkLinkageRuleSetCitation(catalog.reference, terms)).toStrictEqual(
      { fieldSet: "consistent", keySet: "consistent" },
    );
  });
});

describe("the quick exchange's selection", () => {
  test("is the 95% floor with the coverage question answered yes", () => {
    expect(DEFAULT_PRECISION_FLOOR_SELECTION).toStrictEqual({
      floor: 95,
      oneStateOrMetroArea: true,
    });
    expect(names(getDefaultLinkageTerms("Party A").linkageKeys)).toStrictEqual(
      names(
        linkageKeysAtPrecisionFloor(catalog, DEFAULT_PRECISION_FLOOR_SELECTION),
      ),
    );
  });
});

describe("the citation", () => {
  const sameAreaNo99 = { floor: 99, oneStateOrMetroArea: false } as const;

  test("names the catalog and its version, not the floor", () => {
    const terms = linkageTermsFromRuleSet(
      catalog,
      "Party A",
      undefined,
      sameAreaNo99,
    );
    expect(terms.linkageRuleSet).toStrictEqual(catalog.reference);
    expect(catalog.reference).toStrictEqual({
      fieldSet: { name: "baseline-pii", version: "1.2.0" },
      keySet: { name: "precision-ranked-rules", version: "2.1.0" },
    });
  });

  test("of the previous versions resolves to no set, and is unchecked", () => {
    const previous = {
      fieldSet: { name: "baseline-pii", version: "1.1.0" },
      keySet: { name: "precision-ranked-rules", version: "2.0.0" },
    };
    const terms = linkageTermsFromRuleSet(
      catalog,
      "Party A",
      inferMetadata(["ssn", "first_name", "last_name", "dob"], []),
    );
    expect(findBuiltInLinkageRuleSet(previous)).toBeUndefined();
    expect(resolveLinkageRuleSetCitation(previous)).toStrictEqual({
      linkageFields: undefined,
      linkageKeys: undefined,
    });
    expect(checkLinkageRuleSetCitation(previous, terms)).toStrictEqual({
      fieldSet: "unchecked",
      keySet: "unchecked",
    });
  });

  test("is consistent over the subset of a floor's rules a file supplies", () => {
    const metadata = inferMetadata(["first_name", "last_name", "dob"], []);
    const terms = linkageTermsFromRuleSet(
      catalog,
      "Party A",
      metadata,
      DEFAULT_PRECISION_FLOOR_SELECTION,
    );
    expect(terms.linkageKeys.length).toBeGreaterThan(0);
    expect(terms.linkageKeys.length).toBeLessThan(catalog.linkageKeys.length);
    expect(linkageRuleSetReferenceFor(terms)).toStrictEqual(catalog.reference);
    expect(checkLinkageRuleSetCitation(catalog.reference, terms)).toStrictEqual(
      { fieldSet: "consistent", keySet: "consistent" },
    );
  });

  test("is not earned by rules edited outside the catalog", () => {
    const terms = getDefaultLinkageTerms("Party A");
    const edited = {
      ...terms,
      linkageKeys: [
        ...terms.linkageKeys,
        {
          name: "FN + EMAIL",
          elements: [{ field: "first_name" }, { field: "email_address" }],
        },
      ],
    };
    expect(linkageRuleSetReferenceFor(edited)).toBeUndefined();
    expect(checkLinkageRuleSetCitation(catalog.reference, edited).keySet).toBe(
      "contradicted",
    );
  });
});

describe("the registry", () => {
  test("holds the catalog alone", () => {
    expect(BUILT_IN_LINKAGE_RULE_SETS).toStrictEqual([
      DEFAULT_LINKAGE_RULE_SET,
    ]);
  });

  test("resolves no other version of the catalog's field set", () => {
    const otherFieldVersion = {
      fieldSet: { name: catalog.reference.fieldSet.name, version: "1.0.0" },
      keySet: catalog.reference.keySet,
    };
    expect(findBuiltInLinkageRuleSet(otherFieldVersion)).toBeUndefined();
    expect(
      resolveLinkageRuleSetCitation(otherFieldVersion).linkageFields,
    ).toBeUndefined();
    expect(
      checkLinkageRuleSetCitation(
        otherFieldVersion,
        getDefaultLinkageTerms("Party A"),
      ),
    ).toStrictEqual({ fieldSet: "unchecked", keySet: "consistent" });
  });
});

describe("the guided opt-in offers", () => {
  test("are retired from core", () => {
    expect(Object.keys(core)).not.toContain("optInLinkageKeys");
    expect(Object.keys(core)).not.toContain("isOptInLinkageKey");
    expect(Object.keys(core)).not.toContain("OPT_IN_LINKAGE_FIELD_TYPES");
  });

  test("leave one list of the contact and location types", () => {
    expect(core.CONTACT_AND_LOCATION_FIELD_TYPES).toStrictEqual([
      "phone_number",
      "email_address",
      "zip_code",
    ]);
  });
});

describe("precisionFloorSelectionStatement", () => {
  test("names the floor and the coverage answer", () => {
    expect(
      precisionFloorSelectionStatement(DEFAULT_PRECISION_FLOOR_SELECTION),
    ).toBe(
      "the built-in rules at 95% precision and above that your file " +
        "supplies, for two files that both draw their members from one " +
        "state or one metropolitan area",
    );
    expect(
      precisionFloorSelectionStatement({
        floor: 95,
        oneStateOrMetroArea: false,
      }),
    ).toBe(
      "the built-in rules at 95% precision and above that your file " +
        "supplies, leaving out the rules that need both files to draw " +
        "their members from one state or one metropolitan area",
    );
  });

  test("names no coverage condition at a floor the answer does not change", () => {
    for (const oneStateOrMetroArea of [true, false])
      expect(
        precisionFloorSelectionStatement({ floor: 99, oneStateOrMetroArea }),
      ).toBe(
        "the built-in rules at 99% precision and above that your file " +
          "supplies",
      );
  });
});

describe("precisionFloorAsksCoverage", () => {
  test("is true exactly where the coverage answer changes the selection", () => {
    const metadata = inferMetadata(
      ["ssn", "first_name", "last_name", "dob", "zip", "phone", "email"],
      [],
    );
    for (const floor of PRECISION_FLOORS) {
      const keysAnswering = (oneStateOrMetroArea: boolean) =>
        names(
          linkageTermsFromRuleSet(catalog, "Party A", metadata, {
            floor,
            oneStateOrMetroArea,
          }).linkageKeys,
        );
      expect(precisionFloorAsksCoverage(floor)).toBe(
        keysAnswering(true).length !== keysAnswering(false).length,
      );
    }
  });

  test("is true only at the 95% floor, the band the not-asked note names", () => {
    expect(
      PRECISION_FLOORS.filter((floor) => precisionFloorAsksCoverage(floor)),
    ).toStrictEqual([95]);
    expect(ONE_STATE_OR_METRO_AREA_NOT_ASKED).toBe(
      "Applies only to the 95% rules.",
    );
  });
});

describe("PRECISION_FLOORS", () => {
  test("names every band the catalog places a rule in, most precise first", () => {
    const placed = [...new Set(bands.map((band) => band.band))];
    expect([...PRECISION_FLOORS].sort()).toStrictEqual(placed.sort());
    expect(PRECISION_FLOORS).toStrictEqual(
      [...PRECISION_FLOORS].sort((a, b) => b - a),
    );
  });
});

describe("precisionFloorStatement", () => {
  test("states the 99% floor's share, with no coverage condition", () => {
    expect(precisionFloorStatement(99)).toStrictEqual({
      label: "The built-in rules at 99% precision and above",
      description:
        "Of the pairs each rule matches, at least 99 in 100 are the same " +
        "person.",
    });
  });

  test("states the 95% floor's share and its coverage condition", () => {
    expect(precisionFloorStatement(95)).toStrictEqual({
      label: "The built-in rules at 95% precision and above",
      description:
        "Of the pairs each rule matches, at least 95 in 100 are the same " +
        "person. The rules that match on a name and a date of birth alone " +
        "are included only when both files draw their members from one " +
        "state or one metropolitan area.",
    });
  });

  test("names the floor in the words the selection statement uses", () => {
    for (const floor of PRECISION_FLOORS)
      expect(
        precisionFloorSelectionStatement({ floor, oneStateOrMetroArea: true }),
      ).toContain(precisionFloorStatement(floor).label.toLowerCase());
  });
});
