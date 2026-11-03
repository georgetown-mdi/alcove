import { afterEach, expect, test, vi } from "vitest";

import {
  JSON_RETAINED_BYTES_PER_NODE,
  JsonMemoryBudgetError,
  JsonStructureBoundError,
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

// Ten values: the array, its three empty arrays, the object, and its five
// members' values.
const TEN_VALUES = '[[],[],[],{"a":1,"b":2,"c":3,"d":4,"e":5}]';
const TEN_VALUES_BYTES = 10 * JSON_RETAINED_BYTES_PER_NODE;

function refusal(input: Uint8Array | string): JsonMemoryBudgetError {
  try {
    parseBoundedJson(input);
  } catch (err) {
    expect(err).toBeInstanceOf(JsonMemoryBudgetError);
    return err as JsonMemoryBudgetError;
  }
  throw new Error("expected a refusal but the parse succeeded");
}

test("a document whose values fit the available memory parses", () => {
  memory.availableBytes = TEN_VALUES_BYTES;
  expect(parseBoundedJson(TEN_VALUES)).toEqual([
    [],
    [],
    [],
    { a: 1, b: 2, c: 3, d: 4, e: 5 },
  ]);
});

test("a document one byte past the available memory is refused with both figures, bytes and string alike", () => {
  memory.availableBytes = TEN_VALUES_BYTES - 1;
  for (const input of [TEN_VALUES, new TextEncoder().encode(TEN_VALUES)]) {
    const err = refusal(input);
    expect(err.neededBytes).toBe(TEN_VALUES_BYTES);
    expect(err.availableBytes).toBe(TEN_VALUES_BYTES - 1);
    expect(err.message).toBe(
      "not enough free memory to read this JSON: it needs about 400 bytes " +
        "and 399 are available",
    );
  }
});

test("the budget is read at each parse, so it follows the memory available", () => {
  memory.availableBytes = TEN_VALUES_BYTES;
  expect(() => parseBoundedJson(TEN_VALUES)).not.toThrow();
  memory.availableBytes = 9 * JSON_RETAINED_BYTES_PER_NODE;
  expect(() => parseBoundedJson(TEN_VALUES)).toThrow(JsonMemoryBudgetError);
});

test("where the runtime reports no memory reading the budget does not apply", () => {
  memory.availableBytes = undefined;
  memory.afterCollectionBytes = 0;
  expect(parseBoundedJson(TEN_VALUES)).toHaveLength(4);
  expect(memory.collections).toBe(0);
});

test("a document over the budget parses when a collection frees enough", () => {
  memory.availableBytes = JSON_RETAINED_BYTES_PER_NODE;
  memory.afterCollectionBytes = TEN_VALUES_BYTES;
  expect(() => parseBoundedJson(TEN_VALUES)).not.toThrow();
  expect(memory.collections).toBe(1);
});

test("a document still over the budget after a collection is refused with the memory then available", () => {
  memory.availableBytes = JSON_RETAINED_BYTES_PER_NODE;
  memory.afterCollectionBytes = 9 * JSON_RETAINED_BYTES_PER_NODE;
  expect(refusal(TEN_VALUES).availableBytes).toBe(
    9 * JSON_RETAINED_BYTES_PER_NODE,
  );
  expect(memory.collections).toBe(1);
});

test("a document within the budget runs no collection", () => {
  memory.availableBytes = TEN_VALUES_BYTES;
  memory.afterCollectionBytes = TEN_VALUES_BYTES;
  parseBoundedJson(TEN_VALUES);
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
