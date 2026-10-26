import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  NOTE_SECTION,
  RULE_SET_SOURCE,
  inspect,
  keyFieldViolations,
  substrateReport,
} from "./check-zero-setup-keys.mjs";
import { CHECKS } from "./run-checks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SCRIPT = resolve(here, "check-zero-setup-keys.mjs");

const readRoot = (relative) =>
  readFileSync(resolve(repoRoot, relative), "utf8");

// The script driven as the workflow runs it, against `root` or -- with no root
// -- against this repository.
function runCheck(root) {
  const args = root === undefined ? [SCRIPT] : [SCRIPT, "--root", root];
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: error.status, stdout: error.stdout, stderr: error.stderr };
  }
}

const temporaryRoots = [];
afterAll(() => {
  for (const root of temporaryRoots)
    rmSync(root, { recursive: true, force: true });
});

const FIELDS = [
  { name: "ssn", type: "ssn" },
  { name: "last_name", type: "last_name" },
  { name: "date_of_birth", type: "date_of_birth" },
];

const KEYS = [
  {
    name: "SSN + LN + DOB",
    elements: [
      { field: "ssn" },
      { field: "last_name" },
      { field: "date_of_birth" },
    ],
  },
];

/** The rule set the check reads, as its reader hands it over. */
const ruleSet = ({ fields = FIELDS, keys = KEYS } = {}) => ({
  declaration: "DEFAULT_LINKAGE_RULE_SET",
  fieldSet: { name: "DEFAULT_LINKAGE_FIELDS", content: fields },
  keySet: { name: "DEFAULT_LINKAGE_KEYS", content: keys },
});

/** A tree holding only what the check reads: the rule set and the
 * declarations it composes. */
function fixtureTree({ fields = FIELDS, keys = KEYS, source } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "alcove-zero-setup-keys-"));
  temporaryRoots.push(root);
  mkdirSync(resolve(root, dirname(RULE_SET_SOURCE)), { recursive: true });
  writeFileSync(
    resolve(root, RULE_SET_SOURCE),
    source ??
      `const DEFAULT_LINKAGE_FIELDS = ${JSON.stringify(fields, null, 2)};
const DEFAULT_LINKAGE_KEYS = ${JSON.stringify(keys, null, 2)};
export const DEFAULT_LINKAGE_RULE_SET = Object.freeze({
  linkageFields: frozenThroughContents(DEFAULT_LINKAGE_FIELDS),
  linkageKeys: frozenThroughContents(DEFAULT_LINKAGE_KEYS),
});
`,
  );
  return root;
}

describe("the property it holds", () => {
  it("passes a key set built entirely from the declared fields", () => {
    expect(keyFieldViolations(ruleSet())).toEqual([]);
  });

  it("fails a key over a field the set does not declare, naming both", () => {
    const violations = keyFieldViolations(
      ruleSet({
        keys: [
          ...KEYS,
          {
            name: "PHONE + DOB",
            elements: [{ field: "phone_number" }, { field: "date_of_birth" }],
          },
        ],
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("outside");
    expect(violations[0].message).toContain('Key "PHONE + DOB"');
    expect(violations[0].message).toContain("`phone_number`");
    expect(violations[0].message).toContain(
      "DEFAULT_LINKAGE_FIELDS does not declare",
    );
    expect(violations[0].message).toContain(NOTE_SECTION);
  });

  it("fails a key over a field no input can supply by type", () => {
    const violations = keyFieldViolations(
      ruleSet({
        fields: [{ name: "ssn_full", type: "ssn" }, ...FIELDS.slice(1)],
        keys: [
          {
            name: "SSN + LN",
            elements: [{ field: "ssn_full" }, { field: "last_name" }],
          },
        ],
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("unbindable");
    expect(violations[0].message).toContain("`ssn_full`");
    expect(violations[0].message).toContain("type `ssn`");
  });

  it("reports one violation per offending element, not per key", () => {
    const violations = keyFieldViolations(
      ruleSet({
        keys: [
          {
            name: "PHONE + EMAIL",
            elements: [{ field: "phone_number" }, { field: "email_address" }],
          },
        ],
      }),
    );
    expect(violations.map(({ kind }) => kind)).toEqual(["outside", "outside"]);
  });

  it("holds nothing against a declared field no key references", () => {
    expect(
      keyFieldViolations(
        ruleSet({ fields: [...FIELDS, { name: "zip", type: "zip_code" }] }),
      ),
    ).toEqual([]);
  });

  it("states the substrate the property rests on", () => {
    expect(substrateReport({ ruleSet: ruleSet() })).toEqual([
      "  DEFAULT_LINKAGE_FIELDS  ssn -- type ssn",
      "  DEFAULT_LINKAGE_FIELDS  last_name -- type last_name",
      "  DEFAULT_LINKAGE_FIELDS  date_of_birth -- type date_of_birth",
      "  DEFAULT_LINKAGE_KEYS  1 key, every element inside DEFAULT_LINKAGE_FIELDS",
    ]);
  });
});

describe("the check driven end to end", () => {
  it("passes against this repository", () => {
    const { status, stdout } = runCheck();
    expect(status).toBe(0);
    expect(stdout).toContain("Zero-setup key-field check passed");
  });

  it("fails a tree whose default key leaves the field set", () => {
    const root = fixtureTree({
      keys: [
        ...KEYS,
        {
          name: "PHONE + DOB",
          elements: [{ field: "phone_number" }, { field: "date_of_birth" }],
        },
      ],
    });
    const { status, stderr } = runCheck(root);
    expect(status).toBe(1);
    expect(stderr).toContain("Zero-setup key-field check failed");
    expect(stderr).toContain("`phone_number`");
  });

  it("fails a set it cannot read rather than reading it as empty", () => {
    const root = fixtureTree({
      source: `const DEFAULT_LINKAGE_KEYS = buildDefaultKeys();
export const DEFAULT_LINKAGE_RULE_SET = Object.freeze({
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: frozenThroughContents(DEFAULT_LINKAGE_KEYS),
});
`,
    });
    const { status, stderr } = runCheck(root);
    expect(status).toBe(1);
    expect(stderr).toContain("could not run");
    expect(stderr).toContain("DEFAULT_LINKAGE_KEYS");
    expect(inspect(root).violations).toEqual([]);
  });

  it("fails a --root missing the source file rather than crashing", () => {
    const root = mkdtempSync(resolve(tmpdir(), "alcove-zero-setup-keys-"));
    temporaryRoots.push(root);
    const { status, stderr } = runCheck(root);
    expect(status).toBe(1);
    expect(stderr).toContain("Zero-setup key-field check could not run");
    expect(stderr).toContain(RULE_SET_SOURCE);
    expect(stderr).toContain("could not be read");
    expect(stderr).not.toMatch(/\n\s+at /);
  });

  it("refuses a --root it was handed no value for", () => {
    const { status } = (() => {
      try {
        execFileSync(process.execPath, [SCRIPT, "--root"], {
          cwd: repoRoot,
          encoding: "utf8",
        });
        return { status: 0 };
      } catch (error) {
        return { status: error.status };
      }
    })();
    expect(status).toBe(2);
  });
});

describe("the check's registration", () => {
  it("is the command the workflow invokes", () => {
    expect(JSON.parse(readRoot("package.json")).scripts).toHaveProperty(
      "check:zero-setup-keys",
      "node scripts/check-zero-setup-keys.mjs",
    );
  });

  it("is on the list the Static Checks gate runs", () => {
    expect(CHECKS.map((check) => check.script)).toContain(
      "check:zero-setup-keys",
    );
  });
});
