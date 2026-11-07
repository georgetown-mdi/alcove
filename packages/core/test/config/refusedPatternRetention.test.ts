import { describe, expect, test } from "vitest";

import { STANDARDIZATION_FUNCTION_DESCRIPTORS } from "../../src/standardization";
import { safeParseLinkageTerms } from "../../src/config/linkageTermsSchema";
import {
  CLOSED_CLASS_COUNTED_REPEATS,
  ESCAPED_CARET_COUNTED_REPEATS,
  oversizedTransformPattern,
} from "../utils/oversizedPatterns";

// A pattern refused for size leaves nothing behind once the parse returns: the
// compile cache keeps only a pattern within the weighted-size cap. Each pattern
// below compiles to tens of megabytes, so one retained refusal moves the heap
// well past the bound, which is far above the collector's own noise.

/** The runner's collector, exposed by `--expose-gc` (`execArgv` in this
 * package's vitest config); without it a heap delta stands for nothing, so
 * the measurements skip themselves. */
const collect = (globalThis as { gc?: () => void }).gc;

const NO_COLLECTOR_REASON =
  "run without --expose-gc: a heap delta measured with no collector to settle " +
  "the heap stands for nothing";

const RETAINED_BYTES_BOUND = 16 * 1024 * 1024;

function heapUsed(): number {
  for (let i = 0; i < 4; i++) collect?.();
  return process.memoryUsage().heapUsed;
}

const base = {
  version: "1.0.0",
  identity: "Test Party",
  date: "2025-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [{ name: "lastName", type: "last_name" }],
  linkageKeys: [{ name: "Last Name", elements: [{ field: "lastName" }] }],
};

function transformDocument(pattern: string) {
  return {
    ...base,
    linkageKeys: [
      {
        name: "Last Name",
        elements: [
          {
            field: "lastName",
            transform: [{ function: "filter_regex", params: { pattern } }],
          },
        ],
      },
    ],
  };
}

function classDocument(allowedCharacters: string) {
  return {
    ...base,
    linkageFields: [
      {
        name: "lastName",
        type: "last_name",
        constraints: { allowedCharacters },
      },
    ],
  };
}

function refusalMessages(document: unknown): string[] {
  const result = safeParseLinkageTerms(document);
  return result.success ? [] : result.error.issues.map((i) => i.message);
}

describe("a pattern refused for size is not retained", () => {
  test("three distinct terms documents refused for a transform pattern", (ctx) => {
    ctx.skip(collect === undefined, NO_COLLECTOR_REASON);
    const before = heapUsed();
    for (const prefix of ["x", "y", "z"]) {
      const messages = refusalMessages(
        transformDocument(oversizedTransformPattern(prefix)),
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatch(/is too large: its size is \d+/);
    }
    expect(heapUsed() - before).toBeLessThan(RETAINED_BYTES_BOUND);
  });

  test("three distinct terms documents refused for an allowed_characters class", (ctx) => {
    ctx.skip(collect === undefined, NO_COLLECTOR_REASON);
    const before = heapUsed();
    for (const allowedCharacters of [
      CLOSED_CLASS_COUNTED_REPEATS,
      `x${CLOSED_CLASS_COUNTED_REPEATS}`,
      ESCAPED_CARET_COUNTED_REPEATS,
    ]) {
      const messages = refusalMessages(classDocument(allowedCharacters));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatch(/^allowed_characters is too large/);
    }
    expect(heapUsed() - before).toBeLessThan(RETAINED_BYTES_BOUND);
  });

  test("three distinct patterns the step editor refuses for size", (ctx) => {
    ctx.skip(collect === undefined, NO_COLLECTOR_REASON);
    const editor = STANDARDIZATION_FUNCTION_DESCRIPTORS["split_on"].params;
    const before = heapUsed();
    // Distinct from the patterns above, which an earlier test may have parsed.
    for (const prefix of ["u", "v", "w"]) {
      const result = editor.safeParse({
        delimiter: oversizedTransformPattern(prefix),
      });
      expect(result.success).toBe(false);
    }
    expect(heapUsed() - before).toBeLessThan(RETAINED_BYTES_BOUND);
  });
});
