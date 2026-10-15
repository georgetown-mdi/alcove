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

test("parseArgs leaves the matching-key column off by default", () => {
  expect(parseArgs(argvWith({})).includeMatchingKey).toBe(false);
});

test("parseArgs reads --include-matching-key", () => {
  expect(
    parseArgs(argvWith({ "include-matching-key": true })).includeMatchingKey,
  ).toBe(true);
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
