import { describe, expect, test } from "vitest";

import * as core from "../../src/main";
import {
  BUILT_IN_LINKAGE_RULE_SETS,
  DEFAULT_LINKAGE_RULE_SET,
  DEFAULT_PRECISION_FLOOR_SELECTION,
  checkLinkageRuleSetCitation,
  findBuiltInLinkageRuleSet,
  getDefaultLinkageTerms,
  linkageKeysAtPrecisionFloor,
  linkageRuleSetReferenceFor,
  linkageTermsFromRuleSet,
  precisionFloorSelectionStatement,
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
      "LN + FN + DOB + ZIP3",
      "LN + FN + DOB + STATE or COUNTY",
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
  const nameAndDate = [
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
    for (const name of nameAndDate) expect(keys).toContain(name);
  });

  test("withholds them otherwise, and only them", () => {
    const keys = names(
      linkageKeysAtPrecisionFloor(catalog, {
        floor: 95,
        oneStateOrMetroArea: false,
      }),
    );
    for (const name of nameAndDate) expect(keys).not.toContain(name);
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
    expect(catalog.reference.keySet).toStrictEqual({
      name: "precision-ranked-rules",
      version: "2.0.0",
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
        floor: 99,
        oneStateOrMetroArea: false,
      }),
    ).toBe(
      "the built-in rules at 99% precision and above that your file " +
        "supplies, leaving out the rules that need both files to draw " +
        "their members from one state or one metropolitan area",
    );
  });
});
