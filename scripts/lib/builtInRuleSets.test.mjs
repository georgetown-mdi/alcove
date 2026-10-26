import { describe, expect, it } from "vitest";

import {
  RULE_SET_DECLARATION,
  RULE_SET_SOURCE,
  readRuleSet,
  readRuleSetFrom,
} from "./builtInRuleSets.mjs";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** A whole source file as the reader follows it: the field and key
 * declarations, and the frozen composition over them. */
const source = ({
  fields = '[{ name: "ssn", type: "ssn" }]',
  keys = '[{ name: "SSN", elements: [{ field: "ssn" }] }]',
  ruleSet,
} = {}) => `import type { LinkageField } from "../config/linkageTermsSchema";

const DEFAULT_LINKAGE_FIELDS: ReadonlyArray<LinkageField> = ${fields};
const DEFAULT_LINKAGE_KEYS = ${keys};
export const ${RULE_SET_DECLARATION}: BuiltInLinkageRuleSet = ${
  ruleSet ??
  `Object.freeze({
  linkageFields: frozenThroughContents(DEFAULT_LINKAGE_FIELDS),
  linkageKeys: frozenThroughContents(DEFAULT_LINKAGE_KEYS),
})`
};
`;

/** The set a source declares, which must read cleanly. */
const readable = (built) => {
  expect(built.unreadable).toEqual([]);
  return built.ruleSet;
};

describe("the declaration it follows", () => {
  it("reads the two halves out of the declarations the set composes", () => {
    const ruleSet = readable(readRuleSet(source()));
    expect(ruleSet.declaration).toBe(RULE_SET_DECLARATION);
    expect(ruleSet.fieldSet).toEqual({
      role: "fieldSet",
      name: "DEFAULT_LINKAGE_FIELDS",
      content: [{ name: "ssn", type: "ssn" }],
    });
    expect(ruleSet.keySet).toEqual({
      role: "keySet",
      name: "DEFAULT_LINKAGE_KEYS",
      content: [{ name: "SSN", elements: [{ field: "ssn" }] }],
    });
  });

  it("reads a half written inline, naming it by its property", () => {
    const inline = readRuleSet(
      source({
        ruleSet: `{
          linkageFields: [{ name: "ssn", type: "ssn" }],
          linkageKeys: frozenThroughContents(DEFAULT_LINKAGE_KEYS),
        }`,
      }),
    );
    const ruleSet = readable(inline);
    expect(ruleSet.fieldSet.name).toBe(`${RULE_SET_DECLARATION}.linkageFields`);
    expect(ruleSet.fieldSet.content).toEqual([{ name: "ssn", type: "ssn" }]);
    expect(ruleSet.keySet.name).toBe("DEFAULT_LINKAGE_KEYS");
  });

  it("refuses a set that is not an object literal", () => {
    expect(
      readRuleSet(source({ ruleSet: "shippedRuleSet()" })).unreadable,
    ).toEqual([
      {
        declaration: RULE_SET_DECLARATION,
        reason: expect.stringContaining("rather than an object literal"),
      },
    ]);
  });

  it("refuses a freezing call given more than the one value it returns", () => {
    const built = readRuleSet(
      source().replace(
        `${RULE_SET_DECLARATION}: BuiltInLinkageRuleSet = Object.freeze({`,
        `${RULE_SET_DECLARATION}: BuiltInLinkageRuleSet = Object.freeze("extra", {`,
      ),
    );
    expect(built.ruleSet).toBeUndefined();
    expect(built.unreadable).toEqual([
      {
        declaration: RULE_SET_DECLARATION,
        reason: expect.stringContaining("called with 2 arguments"),
      },
    ]);
  });

  it("refuses a source declaring no rule set at all", () => {
    const withoutSet = source().replace(/export const [\s\S]*$/, "");
    expect(readRuleSet(withoutSet).unreadable).toEqual([
      {
        declaration: RULE_SET_DECLARATION,
        reason: expect.stringContaining("no top-level"),
      },
    ]);
  });

  it("refuses a set missing a half, naming the set", () => {
    const withoutKeys = source().replace(
      /  linkageKeys: frozenThroughContents\(DEFAULT_LINKAGE_KEYS\),\n/,
      "",
    );
    expect(readRuleSet(withoutKeys).unreadable).toEqual([
      {
        declaration: RULE_SET_DECLARATION,
        reason: expect.stringContaining("declares no `linkageKeys`"),
      },
    ]);
  });
});

describe("the declarations it evaluates", () => {
  it("evaluates the literal forms the set is written in", () => {
    const ruleSet = readable(
      readRuleSet(
        source({
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
    const asserted = readRuleSet(
      source({ keys: '[{ name: "SSN" }] as const' }),
    );
    expect(readable(asserted).keySet.content).toEqual([{ name: "SSN" }]);
  });

  it("refuses an initializer that is not a literal, naming the declaration", () => {
    const { ruleSet, unreadable } = readRuleSet(
      source({ keys: "buildDefaultKeys()" }),
    );
    expect(ruleSet).toBeUndefined();
    expect(unreadable).toEqual([
      {
        declaration: "DEFAULT_LINKAGE_KEYS",
        reason: expect.stringContaining("rather than a literal"),
      },
    ]);
  });

  it("refuses a spread, whose value lives in another binding", () => {
    const { unreadable } = readRuleSet(
      source({ keys: '[...LEGACY_KEYS, { name: "SSN" }]' }),
    );
    expect(unreadable).toEqual([
      {
        declaration: "DEFAULT_LINKAGE_KEYS",
        reason: expect.stringContaining("spread"),
      },
    ]);
  });

  it("refuses a computed key and a shorthand property", () => {
    expect(
      readRuleSet(source({ fields: "[{ [nameOf(field)]: 1 }]" })).unreadable[0]
        .reason,
    ).toContain("object key is");
    expect(
      readRuleSet(source({ fields: "[{ name }]" })).unreadable[0].reason,
    ).toContain("plain `key: value` assignment");
  });

  it("reports a declaration the source does not contain", () => {
    const trimmed = source().replace(/^const DEFAULT_LINKAGE_KEYS = .*$/m, "");
    expect(readRuleSet(trimmed).unreadable).toEqual([
      {
        declaration: "DEFAULT_LINKAGE_KEYS",
        reason: expect.stringContaining("no top-level"),
      },
    ]);
  });

  it("refuses a declaration that reads itself", () => {
    const circular = source().replace(
      /^const DEFAULT_LINKAGE_KEYS = .*$/m,
      "const DEFAULT_LINKAGE_KEYS = DEFAULT_LINKAGE_KEYS;",
    );
    expect(readRuleSet(circular).unreadable).toEqual([
      {
        declaration: "DEFAULT_LINKAGE_KEYS",
        reason: expect.stringContaining("reads itself"),
      },
    ]);
  });

  it("ignores a same-named binding inside a function", () => {
    const shadowed = `${source()}
function build() {
  const DEFAULT_LINKAGE_KEYS = [{ name: "shadow" }];
  return DEFAULT_LINKAGE_KEYS;
}
`;
    expect(readable(readRuleSet(shadowed)).keySet.content).toEqual([
      { name: "SSN", elements: [{ field: "ssn" }] },
    ]);
  });

  it("reads the committed source", () => {
    const ruleSet = readable(readRuleSetFrom(repoRoot));
    expect(ruleSet.fieldSet.name).toBe("DEFAULT_LINKAGE_FIELDS");
    expect(ruleSet.keySet.name).toBe("DEFAULT_LINKAGE_KEYS");
    expect(ruleSet.keySet.content.length).toBeGreaterThan(0);
  });

  it("fails a tree that does not contain the source at all, naming the file", () => {
    const root = mkdtempSync(resolve(tmpdir(), "alcove-rule-set-source-"));
    try {
      const { ruleSet, unreadable } = readRuleSetFrom(root);
      expect(ruleSet).toBeUndefined();
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
  it("is the file the built-in set is declared in", () => {
    expect(RULE_SET_SOURCE).toBe(
      "packages/core/src/defaults/builtInLinkageTerms.ts",
    );
  });

  it("names the declaration the committed source composes the set in", () => {
    expect(RULE_SET_DECLARATION).toBe("DEFAULT_LINKAGE_RULE_SET");
  });
});
