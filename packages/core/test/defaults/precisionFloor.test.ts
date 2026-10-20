import { describe, expect, test } from "vitest";

import * as core from "../../src/main";
import {
  BUILT_IN_LINKAGE_RULE_SETS,
  DEFAULT_LINKAGE_RULE_SET,
  DEFAULT_PRECISION_FLOOR_SELECTION,
  PRECISION_FLOORS,
  checkLinkageRuleSetCitation,
  findBuiltInLinkageRuleSet,
  getDefaultLinkageTerms,
  linkageKeysAtPrecisionFloor,
  linkageRuleSetReferenceFor,
  linkageTermsFromRuleSet,
  precisionFloorLabel,
  precisionFloorSelectionStatement,
  resolveLinkageRuleSetCitation,
} from "../../src/defaults/builtInLinkageTerms";
import { inferMetadata } from "../../src/config/metadata";
import { linkageKeyIsLessCertain } from "../../src/consent/lessCertainKey";

import type { LinkageKey } from "../../src/config/linkageTermsSchema";
import type { LinkageRuleBand } from "../../src/defaults/builtInLinkageTerms";

const catalog = DEFAULT_LINKAGE_RULE_SET;
const bands: ReadonlyArray<LinkageRuleBand> = catalog.ruleBands ?? [];
const bandOf = (name: string): LinkageRuleBand | undefined =>
  bands.find((band) => band.rule === name);
const names = (keys: ReadonlyArray<{ name: string }>): Array<string> =>
  keys.map((key) => key.name);
const FULL_FIRST_NAME = {
  field: "first_name",
  transform: [{ function: "filter_regex", params: { pattern: "^.{2,}$" } }],
};

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
  const at99 = names(linkageKeysAtPrecisionFloor(catalog, { floor: 99 }));
  const at95 = names(linkageKeysAtPrecisionFloor(catalog, { floor: 95 }));

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

describe("the rules marked less certain", () => {
  const NAME_AND_DATE_RULES = [
    "LN + FN + DOB",
    "swap(LN, FN) + DOB",
    "split(LN) + FN + DOB",
  ];
  const lessCertain = (keys: ReadonlyArray<LinkageKey>) =>
    names(
      keys.filter((key) => linkageKeyIsLessCertain(key, catalog.linkageFields)),
    );

  test("are the name and date rules, in the 95% band", () => {
    expect(lessCertain(catalog.linkageKeys)).toStrictEqual(NAME_AND_DATE_RULES);
    for (const name of NAME_AND_DATE_RULES) expect(bandOf(name)?.band).toBe(95);
  });

  test("are selected at the 95% floor, and the quick exchange runs them", () => {
    expect(
      lessCertain(linkageKeysAtPrecisionFloor(catalog, { floor: 95 })),
    ).toStrictEqual(NAME_AND_DATE_RULES);
    expect(
      lessCertain(linkageKeysAtPrecisionFloor(catalog, { floor: 99 })),
    ).toStrictEqual([]);
    const nameAndDateOnly = inferMetadata(
      ["first_name", "last_name", "dob"],
      [],
    );
    expect(
      names(getDefaultLinkageTerms("Party A", nameAndDateOnly).linkageKeys),
    ).toStrictEqual(NAME_AND_DATE_RULES);
  });

  test("leave no selection condition on any band", () => {
    for (const band of bands)
      expect(Object.keys(band).sort()).toStrictEqual(
        band.needs === undefined ? ["band", "rule"] : ["band", "needs", "rule"],
      );
  });

  test("leave no coverage question in core's exports", () => {
    for (const retired of [
      "ONE_STATE_OR_METRO_AREA_QUESTION",
      "ONE_STATE_OR_METRO_AREA_HELP",
      "ONE_STATE_OR_METRO_AREA_NOT_ASKED",
      "precisionFloorAsksCoverage",
    ])
      expect(Object.keys(core)).not.toContain(retired);
    expect(DEFAULT_PRECISION_FLOOR_SELECTION).toStrictEqual({ floor: 95 });
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
  ) =>
    names(
      linkageTermsFromRuleSet(catalog, "Party A", metadata, { floor })
        .linkageKeys,
    );

  test("are built from the ZIP3, state and county elements", () => {
    const keyOf = (name: string) =>
      catalog.linkageKeys.find((key) => key.name === name);
    const nameAndDate = [
      { field: "last_name" },
      FULL_FIRST_NAME,
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

  test("sit in the 95% band", () => {
    expect(bandOf(ZIP3_RULE)).toStrictEqual({ rule: ZIP3_RULE, band: 95 });
    expect(bandOf(STATE_RULE)).toStrictEqual({ rule: STATE_RULE, band: 95 });
    expect(bandOf(COUNTY_RULE)).toStrictEqual({ rule: COUNTY_RULE, band: 95 });
  });

  test("are selected by floor as their bands state", () => {
    expect(keysFor(withGeography, 95)).toEqual(
      expect.arrayContaining(GEOGRAPHY_RULES),
    );
    for (const rule of GEOGRAPHY_RULES)
      expect(keysFor(withGeography, 99)).not.toContain(rule);
  });

  test("are selected only where the file supplies the column", () => {
    const zipOnly = inferMetadata(
      ["first_name", "last_name", "dob", "zip"],
      [],
    );
    expect(keysFor(zipOnly, 95)).toContain(ZIP3_RULE);
    expect(keysFor(zipOnly, 95)).not.toContain(STATE_RULE);
    expect(keysFor(zipOnly, 95)).not.toContain(COUNTY_RULE);
    const stateOnly = inferMetadata(
      ["first_name", "last_name", "dob", "state"],
      [],
    );
    expect(keysFor(stateOnly, 95)).toContain(STATE_RULE);
    expect(keysFor(stateOnly, 95)).not.toContain(ZIP3_RULE);
    const countyOnly = inferMetadata(
      ["first_name", "last_name", "dob", "county_name"],
      [],
    );
    expect(keysFor(countyOnly, 95)).toContain(COUNTY_RULE);
    expect(keysFor(countyOnly, 95)).not.toContain(STATE_RULE);
  });

  test("run in the catalog's order, before the name and date rule they refine", () => {
    const keys = keysFor(withGeography, 95);
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

describe("the street number rule", () => {
  const STREET_NUMBER_RULE = "LN + FN + DOB + street number + ZIP5";
  const ZIP5_RULE = "LN + FN + DOB + ZIP5";
  const GEOGRAPHY_KEYS_AT_95 = [
    ZIP5_RULE,
    "LN + FN + DOB + ZIP3",
    "ZIP5 + soundex(LN) + FN + DOB",
    "ZIP5 + LN + FN + DOB +/-1 year",
    "LN + FN + DOB + STATE",
    "LN + FN + DOB + COUNTY",
    "LN + FN + DOB",
    "swap(LN, FN) + DOB",
    "split(LN) + FN + DOB",
    "LN + FN + YOB + MOB + ZIP5",
  ];

  const geographyColumns = [
    "first_name",
    "last_name",
    "dob",
    "zip",
    "state",
    "county",
  ];
  const withStreetNumber = inferMetadata(
    [...geographyColumns, "house_number"],
    [],
  );
  const withoutStreetNumber = inferMetadata(geographyColumns, []);
  const keysFor = (
    metadata: ReturnType<typeof inferMetadata>,
    floor: 99 | 95,
  ) =>
    names(
      linkageTermsFromRuleSet(catalog, "Party A", metadata, { floor })
        .linkageKeys,
    );

  test("is built from the street number and ZIP5 elements", () => {
    expect(
      catalog.linkageKeys.find((key) => key.name === STREET_NUMBER_RULE)
        ?.elements,
    ).toStrictEqual([
      { field: "last_name" },
      FULL_FIRST_NAME,
      { field: "date_of_birth" },
      { field: "street_number" },
      { field: "zip_code" },
    ]);
    expect(
      catalog.linkageFields.filter((field) => field.name === "street_number"),
    ).toStrictEqual([{ name: "street_number", type: "street_number" }]);
  });

  test("sits in the 99% band", () => {
    expect(bandOf(STREET_NUMBER_RULE)).toStrictEqual({
      rule: STREET_NUMBER_RULE,
      band: 99,
    });
  });

  test.each(PRECISION_FLOORS)(
    "is selected at the %i%% floor where the file supplies a street number and a ZIP",
    (floor) => {
      expect(keysFor(withStreetNumber, floor)).toContain(STREET_NUMBER_RULE);
      const streetNumberOnly = inferMetadata(
        ["first_name", "last_name", "dob", "house_number"],
        [],
      );
      expect(keysFor(streetNumberOnly, floor)).not.toContain(
        STREET_NUMBER_RULE,
      );
      expect(keysFor(withoutStreetNumber, floor)).not.toContain(
        STREET_NUMBER_RULE,
      );
    },
  );

  test("runs first among the ZIP rules, before the ZIP5 rule it refines", () => {
    expect(keysFor(withStreetNumber, 99)).toStrictEqual([
      STREET_NUMBER_RULE,
      ZIP5_RULE,
    ]);
    expect(keysFor(withStreetNumber, 95)).toStrictEqual([
      STREET_NUMBER_RULE,
      ...GEOGRAPHY_KEYS_AT_95,
    ]);
    const all = names(catalog.linkageKeys);
    expect(all.indexOf(STREET_NUMBER_RULE)).toBe(
      all.indexOf("SSN4 + swap(LN, FN) + DOB") + 1,
    );
    expect(all.indexOf(ZIP5_RULE)).toBe(all.indexOf(STREET_NUMBER_RULE) + 1);
  });

  test("leaves a file with no street number column the keys and fields it had, under this citation", () => {
    const terms = linkageTermsFromRuleSet(
      catalog,
      "Party A",
      withoutStreetNumber,
    );
    expect(names(terms.linkageKeys)).toStrictEqual(GEOGRAPHY_KEYS_AT_95);
    expect(terms.linkageFields.map((field) => field.name)).toStrictEqual([
      "first_name",
      "last_name",
      "date_of_birth",
      "zip_code",
      "state",
      "county",
    ]);
    expect(terms.linkageRuleSet).toStrictEqual(catalog.reference);
    expect(checkLinkageRuleSetCitation(catalog.reference, terms)).toStrictEqual(
      { fieldSet: "consistent", keySet: "consistent" },
    );
  });

  test("cites the catalog over the subset a file with a street number supplies", () => {
    const terms = linkageTermsFromRuleSet(catalog, "Party A", withStreetNumber);
    expect(terms.linkageFields.map((field) => field.name)).toStrictEqual([
      "first_name",
      "last_name",
      "date_of_birth",
      "zip_code",
      "state",
      "county",
      "street_number",
    ]);
    expect(linkageRuleSetReferenceFor(terms)).toStrictEqual(catalog.reference);
    expect(checkLinkageRuleSetCitation(catalog.reference, terms)).toStrictEqual(
      { fieldSet: "consistent", keySet: "consistent" },
    );
  });
});

describe("the quick exchange's selection", () => {
  test("is the 95% floor", () => {
    expect(DEFAULT_PRECISION_FLOOR_SELECTION).toStrictEqual({ floor: 95 });
    expect(names(getDefaultLinkageTerms("Party A").linkageKeys)).toStrictEqual(
      names(
        linkageKeysAtPrecisionFloor(catalog, DEFAULT_PRECISION_FLOOR_SELECTION),
      ),
    );
  });
});

describe("the citation", () => {
  test("names the catalog and its version, not the floor", () => {
    const terms = linkageTermsFromRuleSet(catalog, "Party A", undefined, {
      floor: 99,
    });
    expect(terms.linkageRuleSet).toStrictEqual(catalog.reference);
    expect(catalog.reference).toStrictEqual({
      fieldSet: { name: "baseline-pii", version: "1.3.0" },
      keySet: { name: "precision-ranked-rules", version: "2.4.0" },
    });
  });

  test.each([
    ["1.2.0", "2.1.0"],
    ["1.1.0", "2.0.0"],
  ])(
    "of the previous versions %s and %s resolves to no set, and is unchecked",
    (fieldVersion, keyVersion) => {
      const previous = {
        fieldSet: { name: "baseline-pii", version: fieldVersion },
        keySet: { name: "precision-ranked-rules", version: keyVersion },
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
    },
  );

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
  test("names the floor by its label, starting lowercase", () => {
    expect(
      precisionFloorSelectionStatement(DEFAULT_PRECISION_FLOOR_SELECTION),
    ).toBe("broader matching");
    expect(precisionFloorSelectionStatement({ floor: 99 })).toBe(
      "highest precision",
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

describe("precisionFloorLabel", () => {
  test("labels each floor", () => {
    expect(precisionFloorLabel(99)).toBe("Highest precision");
    expect(precisionFloorLabel(95)).toBe("Broader matching");
  });

  test("states no percentage", () => {
    for (const floor of PRECISION_FLOORS)
      expect(precisionFloorLabel(floor)).not.toMatch(/\d/);
  });

  test("names the floor in the words the selection statement uses", () => {
    for (const floor of PRECISION_FLOORS)
      expect(precisionFloorSelectionStatement({ floor })).toBe(
        precisionFloorLabel(floor).toLowerCase(),
      );
  });
});
