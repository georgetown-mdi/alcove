import { describe, expect, it } from "vitest";

import {
  REGISTRY_DECLARATION,
  RULE_SET_SOURCE,
  readRuleSets,
  readRuleSetsFrom,
} from "./builtInRuleSets.mjs";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** What one set's six declarations are called, under a per-set prefix. */
const declarationsOf = (prefix) => ({
  fieldSetName: `${prefix}_FIELD_SET_NAME`,
  fieldSetVersion: `${prefix}_FIELD_SET_VERSION`,
  fields: `${prefix}_FIELDS`,
  keySetName: `${prefix}_KEY_SET_NAME`,
  keySetVersion: `${prefix}_KEY_SET_VERSION`,
  keys: `${prefix}_KEYS`,
  ruleSet: `${prefix}_RULE_SET`,
});

/** One rule set as the source declares it: six declarations and the frozen
 * composition over them, the shape the reader follows. */
const ruleSetBlock = ({
  prefix = "DEFAULT",
  fieldSetName = '"baseline-pii"',
  fieldSetVersion = '"1.0.0"',
  fields = '[{ name: "ssn", type: "ssn" }]',
  keySetName = '"example-keys"',
  keySetVersion = '"1.0.0"',
  keys = '[{ name: "SSN", elements: [{ field: "ssn" }] }]',
} = {}) => {
  const declared = declarationsOf(prefix);
  return `export const ${declared.fieldSetName} = ${fieldSetName};
export const ${declared.fieldSetVersion} = ${fieldSetVersion};
const ${declared.fields}: ReadonlyArray<LinkageField> = ${fields};
export const ${declared.keySetName} = ${keySetName};
export const ${declared.keySetVersion} = ${keySetVersion};
const ${declared.keys} = ${keys};
export const ${declared.ruleSet}: BuiltInLinkageRuleSet = Object.freeze({
  reference: Object.freeze({
    fieldSet: {
      name: ${declared.fieldSetName},
      version: ${declared.fieldSetVersion},
    },
    keySet: {
      name: ${declared.keySetName},
      version: ${declared.keySetVersion},
    },
  }),
  linkageFields: frozenThroughContents(${declared.fields}),
  linkageKeys: frozenThroughContents(${declared.keys}),
});
`;
};

/** A whole source file: the given sets, and a registry over them. */
const source = ({ sets = [{}], registry } = {}) => {
  const entries = sets
    .map((set) => declarationsOf(set.prefix ?? "DEFAULT").ruleSet)
    .join(", ");
  return `import type { LinkageField } from "../config/linkageTermsSchema";

${sets.map(ruleSetBlock).join("\n")}
export const ${REGISTRY_DECLARATION}: ReadonlyArray<BuiltInLinkageRuleSet> =
  Object.freeze(${registry ?? `[${entries}]`});
`;
};

/** The one set a default source declares. */
const onlySet = (built) => {
  expect(built.unreadable).toEqual([]);
  expect(built.ruleSets).toHaveLength(1);
  return built.ruleSets[0];
};

describe("the registry it follows", () => {
  it("reads each entry's two halves out of the declarations it composes", () => {
    const ruleSet = onlySet(readRuleSets(source()));
    expect(ruleSet.declaration).toBe("DEFAULT_RULE_SET");
    expect(ruleSet.index).toBe(0);
    expect(ruleSet.fieldSet).toEqual({
      role: "fieldSet",
      name: "baseline-pii",
      content: [{ name: "ssn", type: "ssn" }],
    });
    expect(ruleSet.keySet).toEqual({
      role: "keySet",
      name: "example-keys",
      content: [{ name: "SSN", elements: [{ field: "ssn" }] }],
    });
  });

  it("reads every entry the registry holds, in its declaration order", () => {
    const { ruleSets, unreadable } = readRuleSets(
      source({
        sets: [{}, { prefix: "COUNTY", fieldSetName: '"county-pii"' }],
      }),
    );
    expect(unreadable).toEqual([]);
    expect(ruleSets.map((ruleSet) => ruleSet.fieldSet.name)).toEqual([
      "baseline-pii",
      "county-pii",
    ]);
    expect(ruleSets.map((ruleSet) => ruleSet.declaration)).toEqual([
      "DEFAULT_RULE_SET",
      "COUNTY_RULE_SET",
    ]);
  });

  it("reads an entry written inline in the registry", () => {
    const inline = readRuleSets(
      source({
        registry: `[
          {
            reference: {
              fieldSet: { name: "inline-pii", version: "2.0.0" },
              keySet: { name: "inline-keys", version: "2.0.0" },
            },
            linkageFields: [{ name: "ssn", type: "ssn" }],
            linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
          },
        ]`,
      }),
    );
    const ruleSet = onlySet(inline);
    expect(ruleSet.declaration).toBe(`${REGISTRY_DECLARATION}[0]`);
    expect(ruleSet.fieldSet.name).toBe("inline-pii");
    expect(ruleSet.keySet.name).toBe("inline-keys");
    expect(ruleSet.fieldSet.content).toEqual([{ name: "ssn", type: "ssn" }]);
  });

  it("refuses a registry that is not an array of entries", () => {
    expect(
      readRuleSets(source({ registry: "shippedRuleSets()" })).unreadable,
    ).toEqual([
      {
        declaration: REGISTRY_DECLARATION,
        reason: expect.stringContaining("rather than an array literal"),
      },
    ]);
    expect(
      readRuleSets(source({ registry: "[...LEGACY_SETS]" })).unreadable[0]
        .reason,
    ).toContain("spread");
    expect(
      readRuleSets(source({ registry: "[]" })).unreadable[0].reason,
    ).toContain("holds no rule set");
  });

  it("refuses a freezing call given more than the one value it returns", () => {
    const inlineEntry = readRuleSets(
      source({ registry: '[Object.freeze(DEFAULT_RULE_SET, "extra")]' }),
    );
    expect(inlineEntry.ruleSets).toEqual([]);
    expect(inlineEntry.unreadable).toEqual([
      {
        declaration: `${REGISTRY_DECLARATION}[0]`,
        reason: expect.stringContaining("called with 2 arguments"),
      },
    ]);

    const namedEntry = readRuleSets(
      source().replace(
        "export const DEFAULT_RULE_SET: BuiltInLinkageRuleSet = Object.freeze({",
        'export const DEFAULT_RULE_SET: BuiltInLinkageRuleSet = Object.freeze("extra", {',
      ),
    );
    expect(namedEntry.unreadable).toEqual([
      {
        declaration: "DEFAULT_RULE_SET",
        reason: expect.stringContaining("called with 2 arguments"),
      },
    ]);
  });

  it("refuses a source declaring no registry at all", () => {
    const withoutRegistry = ruleSetBlock();
    expect(readRuleSets(withoutRegistry).unreadable).toEqual([
      {
        declaration: REGISTRY_DECLARATION,
        reason: expect.stringContaining("no top-level"),
      },
    ]);
  });

  it("refuses an entry missing a half, naming the entry", () => {
    const withoutKeys = source().replace(
      /  linkageKeys: frozenThroughContents\(DEFAULT_KEYS\),\n/,
      "",
    );
    expect(readRuleSets(withoutKeys).unreadable).toEqual([
      {
        declaration: "DEFAULT_RULE_SET",
        reason: expect.stringContaining("declares no `linkageKeys`"),
      },
    ]);
  });
});

describe("the declarations it evaluates", () => {
  it("evaluates the literal forms the sets are written in", () => {
    const ruleSet = onlySet(
      readRuleSets(
        source({
          sets: [
            {
              fields: `[
                {
                  name: "ssn",
                  type: "ssn",
                  constraints: { exclude: ["111111111"], validOnly: true },
                },
                {
                  "date_of_birth": "quoted key",
                  transform: [{ params: { start: 1, length: -3 } }],
                  absent: null,
                },
              ]`,
            },
          ],
        }),
      ),
    );
    expect(ruleSet.fieldSet.content).toEqual([
      {
        name: "ssn",
        type: "ssn",
        constraints: { exclude: ["111111111"], validOnly: true },
      },
      {
        date_of_birth: "quoted key",
        transform: [{ params: { start: 1, length: -3 } }],
        absent: null,
      },
    ]);
  });

  it("sees through the type assertions a declaration may have", () => {
    const asserted = readRuleSets(
      source({ sets: [{ keys: '[{ name: "SSN" }] as const' }] }),
    );
    expect(onlySet(asserted).keySet.content).toEqual([{ name: "SSN" }]);
  });

  it("refuses an initializer that is not a literal, naming the declaration", () => {
    const { ruleSets, unreadable } = readRuleSets(
      source({ sets: [{ keys: "buildDefaultKeys()" }] }),
    );
    expect(ruleSets).toEqual([]);
    expect(unreadable).toEqual([
      {
        declaration: "DEFAULT_KEYS",
        reason: expect.stringContaining("rather than a literal"),
      },
    ]);
  });

  it("refuses a spread, whose value lives in another binding", () => {
    const { unreadable } = readRuleSets(
      source({ sets: [{ keys: '[...LEGACY_KEYS, { name: "SSN" }]' }] }),
    );
    expect(unreadable).toEqual([
      {
        declaration: "DEFAULT_KEYS",
        reason: expect.stringContaining("spread"),
      },
    ]);
  });

  it("refuses a computed key and a shorthand property", () => {
    expect(
      readRuleSets(source({ sets: [{ fields: "[{ [nameOf(field)]: 1 }]" }] }))
        .unreadable[0].reason,
    ).toContain("object key is");
    expect(
      readRuleSets(source({ sets: [{ fields: "[{ name }]" }] })).unreadable[0]
        .reason,
    ).toContain("plain `key: value` assignment");
  });

  it("reports a declaration the source does not contain", () => {
    const trimmed = source().replace(/^.*DEFAULT_KEY_SET_NAME = .*$/m, "");
    expect(readRuleSets(trimmed).unreadable).toEqual([
      {
        declaration: "DEFAULT_KEY_SET_NAME",
        reason: expect.stringContaining("no top-level"),
      },
    ]);
  });

  it("refuses a declaration that reads itself", () => {
    const circular = source().replace(
      /^const DEFAULT_KEYS = .*$/m,
      "const DEFAULT_KEYS = DEFAULT_KEYS;",
    );
    expect(readRuleSets(circular).unreadable).toEqual([
      {
        declaration: "DEFAULT_KEYS",
        reason: expect.stringContaining("reads itself"),
      },
    ]);
  });

  it("ignores a same-named binding inside a function", () => {
    const shadowed = `${source()}
function build() {
  const DEFAULT_KEYS = [{ name: "shadow" }];
  return DEFAULT_KEYS;
}
`;
    expect(onlySet(readRuleSets(shadowed)).keySet.content).toEqual([
      { name: "SSN", elements: [{ field: "ssn" }] },
    ]);
  });

  it("reads the committed source", () => {
    const { ruleSets, unreadable } = readRuleSetsFrom(repoRoot);
    expect(unreadable).toEqual([]);
    expect(ruleSets.length).toBe(1);
    expect(ruleSets[0].fieldSet.name).toBe("baseline-pii");
    expect(ruleSets[0].keySet.name).toBe("precision-ranked-rules");
    expect(ruleSets[0].keySet.content.length).toBeGreaterThan(0);
  });

  it("fails a tree that does not contain the source at all, naming the file", () => {
    const root = mkdtempSync(resolve(tmpdir(), "alcove-rule-set-source-"));
    try {
      const { ruleSets, unreadable } = readRuleSetsFrom(root);
      expect(ruleSets).toEqual([]);
      expect(unreadable).toEqual([
        {
          declaration: RULE_SET_SOURCE,
          reason: expect.stringContaining("ENOENT"),
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the source it names", () => {
  it("is the file the built-in sets are declared in", () => {
    expect(RULE_SET_SOURCE).toBe(
      "packages/core/src/defaults/builtInLinkageTerms.ts",
    );
  });

  it("names the registry the committed source declares", () => {
    expect(REGISTRY_DECLARATION).toBe("BUILT_IN_LINKAGE_RULE_SETS");
  });
});
