import { afterEach, expect, test, vi } from "vitest";

import {
  JSON_RETAINED_BYTES_PER_NODE,
  JsonStructureBoundError,
  parseBoundedJson,
} from "../../src/utils/boundedJson";

const memory = vi.hoisted(() => ({
  availableBytes: 0,
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

test("a document whose values fit the available memory parses", () => {
  memory.availableBytes = 10 * JSON_RETAINED_BYTES_PER_NODE;
  expect(parseBoundedJson(TEN_VALUES)).toEqual([
    [],
    [],
    [],
    { a: 1, b: 2, c: 3, d: 4, e: 5 },
  ]);
});

test("a document one value past the available memory is refused, bytes and string alike", () => {
  memory.availableBytes = 10 * JSON_RETAINED_BYTES_PER_NODE - 1;
  expect(() => parseBoundedJson(TEN_VALUES)).toThrow(JsonStructureBoundError);
  expect(() => parseBoundedJson(new TextEncoder().encode(TEN_VALUES))).toThrow(
    JsonStructureBoundError,
  );
});

test("the budget is read at each parse, so it follows the memory available", () => {
  memory.availableBytes = 10 * JSON_RETAINED_BYTES_PER_NODE;
  expect(() => parseBoundedJson(TEN_VALUES)).not.toThrow();
  memory.availableBytes = 9 * JSON_RETAINED_BYTES_PER_NODE;
  expect(() => parseBoundedJson(TEN_VALUES)).toThrow(JsonStructureBoundError);
});

test("a document over the budget parses when a collection frees enough", () => {
  memory.availableBytes = JSON_RETAINED_BYTES_PER_NODE;
  memory.afterCollectionBytes = 10 * JSON_RETAINED_BYTES_PER_NODE;
  expect(() => parseBoundedJson(TEN_VALUES)).not.toThrow();
  expect(memory.collections).toBe(1);
});

test("a document still over the budget after a collection is refused", () => {
  memory.availableBytes = JSON_RETAINED_BYTES_PER_NODE;
  memory.afterCollectionBytes = 9 * JSON_RETAINED_BYTES_PER_NODE;
  expect(() => parseBoundedJson(TEN_VALUES)).toThrow(JsonStructureBoundError);
  expect(memory.collections).toBe(1);
});

test("a per-container refusal runs no collection", () => {
  memory.availableBytes = 2 ** 40;
  memory.afterCollectionBytes = 2 ** 40;
  expect(() => parseBoundedJson("[".repeat(5000))).toThrow(
    JsonStructureBoundError,
  );
  expect(memory.collections).toBe(0);
});
