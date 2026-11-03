import { afterEach, expect, test, vi } from "vitest";

import {
  JSON_RETAINED_BYTES,
  JsonMemoryBudgetError,
  JsonStructureBoundError,
  jsonRetainedBytes,
  parseBoundedJson,
  partnerMessageMemoryShortfall,
} from "../../src/utils/boundedJson";

const memory = vi.hoisted(() => ({
  availableBytes: 0 as number | undefined,
  afterCollectionBytes: undefined as number | undefined,
  collections: 0,
}));

vi.mock("../../src/utils/availableMemory", () => ({
  availableMemoryBytes: () => memory.availableBytes,
  collectGarbage: () => {
    if (memory.afterCollectionBytes === undefined) return false;
    memory.collections += 1;
    memory.availableBytes = memory.afterCollectionBytes;
    return true;
  },
}));

afterEach(() => {
  memory.availableBytes = 0;
  memory.afterCollectionBytes = undefined;
  memory.collections = 0;
});

const C = JSON_RETAINED_BYTES;

// The outer array and its four elements, three empty arrays, and one object
// whose five members are new, each key a one-character string.
const DOCUMENT = '[[],[],[],{"a":1,"b":2,"c":3,"d":4,"e":5}]';
const DOCUMENT_BYTES =
  4 * C.array + 4 * C.element + C.object + 5 * (C.newMember + C.string + 1);

function refusal(input: Uint8Array | string): JsonMemoryBudgetError {
  try {
    parseBoundedJson(input);
  } catch (err) {
    expect(err).toBeInstanceOf(JsonMemoryBudgetError);
    return err as JsonMemoryBudgetError;
  }
  throw new Error("expected a refusal but the parse succeeded");
}

// `json` parses with exactly `bytes` available and is refused one byte short,
// from its string and from its UTF-8 bytes.
function expectCharge(json: string, bytes: number): void {
  for (const input of [json, new TextEncoder().encode(json)]) {
    memory.availableBytes = bytes;
    expect(() => parseBoundedJson(input)).not.toThrow();
    memory.availableBytes = bytes - 1;
    expect(refusal(input).neededBytes).toBe(bytes);
  }
}

test("a document whose values fit the available memory parses", () => {
  memory.availableBytes = DOCUMENT_BYTES;
  expect(parseBoundedJson(DOCUMENT)).toEqual([
    [],
    [],
    [],
    { a: 1, b: 2, c: 3, d: 4, e: 5 },
  ]);
});

test("a document one byte past the available memory is refused with both figures, bytes and string alike", () => {
  expect(jsonRetainedBytes(DOCUMENT)).toBe(957);
  memory.availableBytes = DOCUMENT_BYTES - 1;
  for (const input of [DOCUMENT, new TextEncoder().encode(DOCUMENT)]) {
    const err = refusal(input);
    expect(err.neededBytes).toBe(DOCUMENT_BYTES);
    expect(err.availableBytes).toBe(DOCUMENT_BYTES - 1);
    expect(err.message).toBe(
      "not enough free memory to read this JSON: it needs about 957 bytes " +
        "and 956 are available",
    );
  }
});

test("the budget is read at each parse, so it follows the memory available", () => {
  memory.availableBytes = DOCUMENT_BYTES;
  expect(() => parseBoundedJson(DOCUMENT)).not.toThrow();
  memory.availableBytes = DOCUMENT_BYTES - 1;
  expect(() => parseBoundedJson(DOCUMENT)).toThrow(JsonMemoryBudgetError);
});

test("where the runtime reports no memory reading the budget does not apply", () => {
  memory.availableBytes = undefined;
  memory.afterCollectionBytes = 0;
  expect(parseBoundedJson(DOCUMENT)).toHaveLength(4);
  expect(memory.collections).toBe(0);
});

test("a document over the budget parses when a collection frees enough", () => {
  memory.availableBytes = 1;
  memory.afterCollectionBytes = DOCUMENT_BYTES;
  expect(() => parseBoundedJson(DOCUMENT)).not.toThrow();
  expect(memory.collections).toBe(1);
});

test("a document still over the budget after a collection is refused with the memory then available", () => {
  memory.availableBytes = 1;
  memory.afterCollectionBytes = DOCUMENT_BYTES - 1;
  expect(refusal(DOCUMENT).availableBytes).toBe(DOCUMENT_BYTES - 1);
  expect(memory.collections).toBe(1);
});

test("a document within the budget runs no collection", () => {
  memory.availableBytes = DOCUMENT_BYTES;
  memory.afterCollectionBytes = DOCUMENT_BYTES;
  parseBoundedJson(DOCUMENT);
  expect(memory.collections).toBe(0);
});

test("a per-container refusal runs no collection", () => {
  memory.availableBytes = 2 ** 40;
  memory.afterCollectionBytes = 2 ** 40;
  expect(() => parseBoundedJson("[".repeat(5000))).toThrow(
    JsonStructureBoundError,
  );
  expect(memory.collections).toBe(0);
});

// --- The charge per kind -----------------------------------------------------

test("an object-heavy body and an array-heavy body of the same value count are charged by kind", () => {
  // Each holds the document, two containers, and two numbers.
  expect(jsonRetainedBytes('[{"a":1},{"b":2}]')).toBe(
    C.array + 2 * C.element + 2 * C.object + 2 * (C.newMember + C.string + 1),
  );
  expect(jsonRetainedBytes("[[1],[2]]")).toBe(3 * C.array + 4 * C.element);
});

test("objects repeating the previous object's keys are charged the repeated members without their key strings", () => {
  expectCharge(
    '[{"a":1,"b":2},{"a":3,"b":4},{"a":5,"b":6}]',
    C.array +
      3 * C.element +
      3 * C.object +
      2 * (C.newMember + C.string + 1) +
      4 * C.repeatedMember,
  );
});

test("objects alternating between two key orders are charged new members throughout", () => {
  expectCharge(
    '[{"a":1,"b":2},{"b":3,"a":4},{"a":5,"b":6}]',
    C.array + 3 * C.element + 3 * C.object + 6 * (C.newMember + C.string + 1),
  );
});

test("a member after the first key that differs is new, though a later key matches", () => {
  expectCharge(
    '[{"a":1,"b":2,"c":3},{"a":1,"x":2,"c":3}]',
    C.array +
      2 * C.element +
      2 * C.object +
      5 * (C.newMember + C.string + 1) +
      C.repeatedMember,
  );
});

test("integer-like keys are charged the integer-key charge, repeated or not", () => {
  expectCharge(
    '[{"1":0},{"1":0}]',
    C.array +
      2 * C.element +
      2 * C.object +
      2 * (C.integerKeyMember + C.string + 1),
  );
  // An escape may decode to digits.
  expectCharge(
    '{"\\u0031":0}',
    C.object + C.integerKeyMember + C.string + 2 * 6,
  );
});

test("a long string is charged for its length", () => {
  const long = "x".repeat(1000);
  expectCharge(`["${long}"]`, C.array + C.element + C.string + 1000);
  // A character past Latin-1 makes every character two bytes: one code unit
  // of the string, two bytes of its UTF-8.
  const wide = `Ā${long}`;
  expect(jsonRetainedBytes(`"${wide}"`)).toBe(C.string + 2 * 1001);
  expect(jsonRetainedBytes(new TextEncoder().encode(`"${wide}"`))).toBe(
    C.string + 2 * 1002,
  );
});

test("numbers outside the small-integer range are charged, small integers are not", () => {
  expect(jsonRetainedBytes("[123456789]")).toBe(C.array + C.element);
  for (const number of ["1234567890", "1.5", "1e3", "-1", "-0"])
    expect(jsonRetainedBytes(`[${number}]`)).toBe(
      C.array + C.element + C.number,
    );
});

test("a partner message refused for memory is reported as this machine's shortfall, with the figures and a remedy", () => {
  expect(
    partnerMessageMemoryShortfall(
      "the partner's message",
      new JsonMemoryBudgetError(6_000_000_000, 1_500_000_000),
    ),
  ).toBe(
    "this machine does not have enough free memory to read the partner's " +
      "message: it needs about 6,000,000,000 bytes and 1,500,000,000 are " +
      "available. Free memory on this machine, or raise the container's " +
      "memory limit, and run the exchange again.",
  );
});
