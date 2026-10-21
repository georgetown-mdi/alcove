import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import repoConfig from "../eslint.config.mjs";
import {
  PROJECT_PARSER_OPTIONS,
  typeAwareRuleNames,
  withoutTypeAwareLayer,
} from "./eslint-strip-type-aware-layer.mjs";

// Coverage of the regex-in-toMatchObject ban. `toMatchObject` compares a
// RegExp value against the received property by equality, so a regex written as
// a property value passes whatever the received value is. The ban is one
// no-restricted-syntax selector, carried by the repo-root block that covers the
// test trees of packages/ and apps/cli and by the test block of
// apps/web/eslint.config.js (reached here through the repo-root config, which
// embeds apps/web's blocks under apps/web/). A selector that stops matching
// keeps reporting zero problems, indistinguishable from clean source, so these
// cases pin both what it reports and what it leaves alone.
//
// The type-aware layer is stripped off (withoutTypeAwareLayer), so what is
// reported rests on the text handed in and nothing else.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: true,
  baseConfig: withoutTypeAwareLayer(repoConfig),
});

/** The ban's messages reported for `source` linted as `filePath`. */
async function banHits(filePath, source) {
  const [result] = await eslint.lintText(source, { filePath });
  const fatal = result.messages.filter((message) => message.fatal);
  if (fatal.length > 0) {
    throw new Error(`${filePath}: ${fatal.map((m) => m.message).join("; ")}`);
  }
  return result.messages.filter(
    (message) =>
      message.ruleId === "no-restricted-syntax" &&
      message.message.startsWith("A regex value inside toMatchObject"),
  );
}

const TEST_FILES = [
  resolve(repoRoot, "apps/web/test/unit/toMatchObjectBanFixture.test.ts"),
  resolve(repoRoot, "apps/cli/test/unit/toMatchObjectBanFixture.test.ts"),
  resolve(repoRoot, "packages/core/test/toMatchObjectBanFixture.test.ts"),
];

// Loading the typescript-eslint parser for the first time can exceed vitest's
// 5s default under cold load.
const LINT_TIMEOUT_MS = 30_000;

const FLAGGED = [
  [
    "a regex property value",
    "expect(error).toMatchObject({ kind: 'usage', message: /refused/ });",
  ],
  [
    "a regex property value on a rejection",
    "await expect(pending).rejects.toMatchObject({ message: /refused/ });",
  ],
  [
    "a regex property value in a nested object",
    "expect(value).toMatchObject({ outer: { message: /refused/ } });",
  ],
  [
    "a regex element of an array property",
    "expect(value).toMatchObject({ messages: [/refused/] });",
  ],
  [
    "a regex property value among several",
    "expect(value).toMatchObject({ a: 1, b: /x/, c: 'z' });",
  ],
];

const EXEMPT = [
  [
    "expect.stringMatching in the object",
    "expect(error).toMatchObject({ message: expect.stringMatching(/refused/) });",
  ],
  [
    "a string property value",
    "expect(error).toMatchObject({ message: 'refused' });",
  ],
  [
    "rejects.toThrow with a regex",
    "await expect(pending).rejects.toThrow(/refused/);",
  ],
  [
    "a regex in the received value, outside the argument",
    "expect({ pattern: /x/ }).toMatchObject({ pattern: expect.any(RegExp) });",
  ],
  ["a regex matched against a string", "expect(/x/.test('x')).toBe(true);"],
  [
    "a regex property value in a different matcher",
    "expect(value).toEqual({ message: /refused/ });",
  ],
];

describe("the regex-in-toMatchObject ban", { timeout: LINT_TIMEOUT_MS }, () => {
  it("lints every path here with no TypeScript program behind it", async () => {
    for (const filePath of TEST_FILES) {
      const config = await eslint.calculateConfigForFile(filePath);
      const parserOptions = config.languageOptions?.parserOptions ?? {};
      expect(
        Object.keys(parserOptions).filter((option) =>
          PROJECT_PARSER_OPTIONS.includes(option),
        ),
        `${filePath}: a TypeScript program is configured`,
      ).toEqual([]);
      expect(
        typeAwareRuleNames(config.rules, (prefix) => config.plugins?.[prefix]),
        `${filePath}: a type-aware rule survived the strip`,
      ).toEqual([]);
    }
  });

  for (const filePath of TEST_FILES) {
    const tree = filePath.slice(repoRoot.length + 1).split("/test/")[0];
    for (const [label, source] of FLAGGED) {
      it(`rejects ${label} under ${tree}/test`, async () => {
        expect(await banHits(filePath, `${source}\n`)).toHaveLength(1);
      });
    }
    for (const [label, source] of EXEMPT) {
      it(`accepts ${label} under ${tree}/test`, async () => {
        expect(await banHits(filePath, `${source}\n`)).toHaveLength(0);
      });
    }
  }
});
