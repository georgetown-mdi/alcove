import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import eslintConfig from "../eslint.config.mjs";
import {
  PROJECT_PARSER_OPTIONS,
  typeAwareRuleNames,
  withoutTypeAwareLayer,
} from "./eslint-strip-type-aware-layer.mjs";

// Coverage of the parse bans the repo-root eslint.config.mjs carries over
// packages/peerjs-broker/src: untrusted JSON is decoded through @alcove/core's
// parseBoundedJson, and a secret-bearing document through the same package's
// sensitive-parse chokepoint. This is the tree with an unauthenticated adversary
// in front of it -- the signaling socket parses whatever an internet client
// sends, and the abort a pathological body reaches is uncatchable -- so a ban
// that quietly stops matching here costs more than it would anywhere else.
//
// A ban fails silently: a `files` pattern or an object/property name that stops
// matching keeps reporting zero problems, which reads exactly like clean source.
// The shapes it does NOT catch are pinned below as well, so its reach is a
// measured property rather than an assumption a reader makes from the rule text.
//
// The raw-error-at-sink ban is the broker's third, and its tree coverage sits
// with that ban's other cases in eslint-display-sink-ban.test.mjs.
//
// One transform is applied to the config every case is linted through: the
// type-aware layer is stripped off (withoutTypeAwareLayer), so what this file
// reports rests on the text it hands in and nothing else, and no lint here waits
// on a TypeScript program being built.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: true,
  baseConfig: withoutTypeAwareLayer(eslintConfig),
});

// A path inside the guarded tree. The bans are scoped by `files` pattern, so the
// text each case hands in is linted as though it sat here; the path needs no
// file behind it.
const BROKER_SRC = resolve(
  repoRoot,
  "packages/peerjs-broker/src/banFixture.ts",
);

// A path inside the message routing, which the bans cover like the rest of the
// tree.
const BROKER_MESSAGE_ROUTING = resolve(
  repoRoot,
  "packages/peerjs-broker/src/contrib/messageHandler/banFixture.ts",
);

// A guarded path that exists on disk and parses, reserved for the canary.
const BROKER_FIRST_PARSE = resolve(
  repoRoot,
  "packages/peerjs-broker/src/standalone.ts",
);

/**
 * Messages `ruleId` reports for `source` linted as `filePath`, narrowed to those
 * whose text starts with `messagePrefix` when one is given -- a rule this tree
 * loads several bans into reports them all under the one id. A source that does
 * not parse throws rather than reading as zero problems.
 */
async function banHits(filePath, source, ruleId, messagePrefix = "") {
  const [result] = await eslint.lintText(source, { filePath });
  const fatal = result.messages.filter((message) => message.fatal);
  if (fatal.length > 0) {
    throw new Error(`${filePath}: ${fatal.map((m) => m.message).join("; ")}`);
  }
  return result.messages.filter(
    (message) =>
      message.ruleId === ruleId && message.message.startsWith(messagePrefix),
  );
}

const PREAMBLE = `
declare const YAML: {
  parse(text: string): unknown;
  parseDocument(text: string): unknown;
  parseAllDocuments(text: string): unknown;
};
declare function parseBoundedJson(text: string): unknown;
declare const text: string;
export function fixture(): unknown {
`;

function fixture(body) {
  return `${PREAMBLE}  ${body}\n}\n`;
}

// Loading the typescript-eslint parser for the first time is the expensive part
// of a lintText call, independent of which file or how much text it is given;
// under cold process or CPU load that one-time cost alone can outrun the default
// per-test timeout on a CI runner.
describe("the broker parse bans", { timeout: 60_000 }, () => {
  it("lints every path here with no TypeScript program behind it", async () => {
    for (const filePath of [BROKER_SRC, BROKER_FIRST_PARSE]) {
      const config = await eslint.calculateConfigForFile(filePath);
      const parserOptions = config.languageOptions?.parserOptions ?? {};
      expect(
        Object.keys(parserOptions).filter((option) =>
          PROJECT_PARSER_OPTIONS.includes(option),
        ),
        `${filePath}: a TypeScript program is configured, so a type-aware rule can run -- and crash -- on ground this file does not test`,
      ).toEqual([]);
      expect(
        typeAwareRuleNames(config.rules, (prefix) => config.plugins?.[prefix]),
        `${filePath}: a type-aware rule survived the strip`,
      ).toEqual([]);
    }
  });

  it("lints the text it is handed, not the file on disk", async () => {
    expect(
      existsSync(BROKER_FIRST_PARSE),
      `${BROKER_FIRST_PARSE} no longer exists`,
    ).toBe(true);
    const [result] = await eslint.lintText("this is not typescript !!! (((\n", {
      filePath: BROKER_FIRST_PARSE,
    });
    expect(
      result.messages.map((message) => message.message).join("; "),
      `${BROKER_FIRST_PARSE}: the source on disk was linted instead, so a case asserting zero problems proves nothing about the text it handed in`,
    ).toMatch(/Parsing error/);
  });

  it("resolves the JSON.parse ban for the broker tree", async () => {
    const config = await eslint.calculateConfigForFile(BROKER_SRC);
    const [, ...entries] = config.rules["no-restricted-properties"] ?? [];
    expect(
      entries.some(
        (entry) => entry.object === "JSON" && entry.property === "parse",
      ),
      `${BROKER_SRC}: the resolved no-restricted-properties options do not carry the JSON.parse ban, so linting it reports zero however the parse is written`,
    ).toBe(true);
  });

  for (const [shape, body] of [
    ["a direct call", 'return JSON.parse("{}");'],
    ["an alias", "return JSON.parse;"],
    ["a computed access", 'return JSON["parse"]("{}");'],
    ["a destructure", "const { parse } = JSON;\n  return parse;"],
  ]) {
    it(`refuses ${shape} of JSON.parse`, async () => {
      expect(
        await banHits(BROKER_SRC, fixture(body), "no-restricted-properties"),
      ).not.toHaveLength(0);
    });
  }

  // The reach the syntactic form does not have: both need value-flow analysis,
  // and both are left to review, exactly as the identical ban over
  // packages/core/src states of itself.
  for (const [shape, body] of [
    ["a renamed JSON object", 'const J = JSON;\n  return J.parse("{}");'],
    ["a globalThis access", 'return globalThis.JSON.parse("{}");'],
  ]) {
    it(`does not reach ${shape}`, async () => {
      expect(
        await banHits(BROKER_SRC, fixture(body), "no-restricted-properties"),
      ).toHaveLength(0);
    });
  }

  it("leaves the bounded chokepoint and JSON.stringify alone", async () => {
    for (const body of [
      "return parseBoundedJson(text);",
      "return JSON.stringify({});",
    ]) {
      expect(
        await banHits(BROKER_SRC, fixture(body), "no-restricted-properties"),
      ).toHaveLength(0);
    }
  });

  for (const parser of ["parse", "parseDocument", "parseAllDocuments"]) {
    it(`refuses YAML.${parser}`, async () => {
      expect(
        await banHits(
          BROKER_SRC,
          fixture(`return YAML.${parser}(text);`),
          "no-restricted-syntax",
          "Parse operator/credential files",
        ),
      ).not.toHaveLength(0);
    });

    it(`refuses a named '${parser}' import from yaml`, async () => {
      expect(
        await banHits(
          BROKER_SRC,
          `import { ${parser} } from "yaml";\n\nexport const parsed = ${parser}("a: 1");\n`,
          "no-restricted-imports",
        ),
      ).not.toHaveLength(0);
    });
  }

  it("reaches the message routing", async () => {
    expect(
      await banHits(
        BROKER_MESSAGE_ROUTING,
        fixture('return JSON.parse("{}");'),
        "no-restricted-properties",
      ),
    ).not.toHaveLength(0);
  });
});
