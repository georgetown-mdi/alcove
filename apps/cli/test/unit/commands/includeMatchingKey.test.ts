import { expect, test } from "vitest";
import type { Arguments } from "yargs";

import { getDefaultLinkageTerms, UsageError } from "@alcove/core";
import {
  assertMatchingKeyAvailable,
  parseArgs,
} from "../../../src/commands/exchange";

function argvWith(flags: Record<string, unknown>): Arguments {
  return {
    _: [],
    $0: "alcove",
    input: "data.csv",
    ...flags,
  } as unknown as Arguments;
}

test("parseArgs leaves the matching-key column to the configuration when no flag is given", () => {
  expect(parseArgs(argvWith({})).includeMatchingKey).toBeUndefined();
});

test("parseArgs reads --include-matching-key and --no-include-matching-key", () => {
  expect(
    parseArgs(argvWith({ "include-matching-key": true })).includeMatchingKey,
  ).toBe(true);
  expect(
    parseArgs(argvWith({ "include-matching-key": false })).includeMatchingKey,
  ).toBe(false);
});

test("the matching-key column is available on cascade psi terms", () => {
  const terms = getDefaultLinkageTerms("test");
  expect(terms.linkageStrategy).toBe("cascade");
  expect(terms.algorithm).toBe("psi");
  expect(() => assertMatchingKeyAvailable(true, terms)).not.toThrow();
});

test("the matching-key column is refused on single-pass terms", () => {
  const terms = {
    ...getDefaultLinkageTerms("test"),
    linkageStrategy: "single-pass" as const,
  };
  expect(() => assertMatchingKeyAvailable(true, terms)).toThrow(UsageError);
  expect(() => assertMatchingKeyAvailable(true, terms)).toThrow(
    "--include-matching-key is set on a single-pass exchange",
  );
});

test("the matching-key column is refused on count-only terms", () => {
  const terms = {
    ...getDefaultLinkageTerms("test"),
    algorithm: "psi-c" as const,
  };
  expect(() => assertMatchingKeyAvailable(true, terms)).toThrow(UsageError);
  expect(() => assertMatchingKeyAvailable(true, terms)).toThrow(
    "count-only (psi-c)",
  );
});

test("terms the run does not ask the matching key of are not refused", () => {
  const terms = {
    ...getDefaultLinkageTerms("test"),
    linkageStrategy: "single-pass" as const,
  };
  expect(() => assertMatchingKeyAvailable(false, terms)).not.toThrow();
});

test("the matching-key column is refused on terms that give this party no result", () => {
  const defaults = getDefaultLinkageTerms("test");
  const terms = {
    ...defaults,
    output: { ...defaults.output, expectsOutput: false },
  };
  expect(terms.linkageStrategy).toBe("cascade");
  expect(() => assertMatchingKeyAvailable(true, terms)).toThrow(UsageError);
  expect(() => assertMatchingKeyAvailable(true, terms)).toThrow(
    "this exchange writes no result file for you",
  );
});

test("the matching-key column is available on terms that give this party a result", () => {
  const defaults = getDefaultLinkageTerms("test");
  const terms = {
    ...defaults,
    output: { ...defaults.output, expectsOutput: true },
  };
  expect(() => assertMatchingKeyAvailable(true, terms)).not.toThrow();
});
