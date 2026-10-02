import { expect, test } from "vitest";

import { isNamedDiagnosis } from "../../src/errors";
import { MAX_PSI_DECODE_ELEMENTS } from "../../src/connection/frameSize";
import {
  PSI_CHUNK_MIN_ELEMENTS,
  psiChunkRanges,
} from "../../src/psi/psiChunks";
import {
  WASM_MATCH_BYTES_PER_RESPONSE_ELEMENT,
  WASM_MATCH_BYTES_PER_SETUP_ELEMENT,
  WASM_PSI_MATCH_BUDGET_BYTES,
  WASM_PSI_MEMORY_MAX_BYTES,
  assertStrictlyAscending,
  matchSetupSliceElements,
  matchSetupSliceRanges,
  psiEngineOptionsForBackend,
} from "../../src/psi/psiMatchSlices";

// The setup slicing the joiner's WebAssembly match runs under. The slice
// counts are the compute cost a round pays (each slice decrypts the whole
// response it is matched against), so they are pinned at the sizes the
// receive ceilings admit.

function largestChunk(total: number): number {
  return psiChunkRanges(total).reduce(
    (largest, range) => Math.max(largest, range.end - range.start),
    0,
  );
}

function sliceCount(
  setupElements: number,
  responseElementsPerCall: number,
): number {
  return matchSetupSliceRanges(
    setupElements,
    matchSetupSliceElements(
      responseElementsPerCall,
      WASM_PSI_MATCH_BUDGET_BYTES,
    ),
  ).length;
}

test("the budget leaves room under the engine's fixed maximum", () => {
  expect(WASM_PSI_MATCH_BUDGET_BYTES).toBeLessThan(WASM_PSI_MEMORY_MAX_BYTES);
});

test("a slice holds what the budget leaves after the response", () => {
  const response = 65_536;
  const slice = matchSetupSliceElements(response, WASM_PSI_MATCH_BUDGET_BYTES);
  const callBytes = (setup: number): number =>
    WASM_MATCH_BYTES_PER_SETUP_ELEMENT * setup +
    WASM_MATCH_BYTES_PER_RESPONSE_ELEMENT * response;
  expect(callBytes(slice)).toBeLessThanOrEqual(WASM_PSI_MATCH_BUDGET_BYTES);
  expect(callBytes(slice + 1)).toBeGreaterThan(WASM_PSI_MATCH_BUDGET_BYTES);
});

test.each([
  ["identifier-revealing", 65_536, 1],
  ["identifier-revealing", 7_500_000, 2],
  ["identifier-revealing", 2 ** 24, 3],
  ["count-only", 65_536, 1],
  ["count-only", 7_500_000, 2],
  ["count-only", 2 ** 24, 7],
] as const)(
  "a %s match of %i a side runs in %i slices",
  (mode, elements, slices) => {
    const perCall = mode === "count-only" ? elements : largestChunk(elements);
    expect(sliceCount(elements, perCall)).toBe(slices);
  },
);

test("every response the decode bound admits leaves a slice above the floor", () => {
  expect(
    matchSetupSliceElements(
      MAX_PSI_DECODE_ELEMENTS,
      WASM_PSI_MATCH_BUDGET_BYTES,
    ),
  ).toBeGreaterThan(PSI_CHUNK_MIN_ELEMENTS);
});

test("a slice below the floor is an internal error, not a tiny slice", () => {
  expect(() =>
    matchSetupSliceElements(1, WASM_MATCH_BYTES_PER_SETUP_ELEMENT * 100),
  ).toThrow(/below the floor/);
  expect(() =>
    matchSetupSliceElements(2 ** 26, WASM_PSI_MATCH_BUDGET_BYTES),
  ).toThrow(/below the floor/);
});

test("slice ranges cover the setup contiguously", () => {
  const ranges = matchSetupSliceRanges(1_000_003, 300_000);
  expect(ranges).toHaveLength(4);
  expect(ranges[0]!.start).toBe(0);
  expect(ranges.at(-1)!.end).toBe(1_000_003);
  for (let index = 1; index < ranges.length; index += 1)
    expect(ranges[index]!.start).toBe(ranges[index - 1]!.end);
  for (const range of ranges)
    expect(range.end - range.start).toBeLessThanOrEqual(300_000);
});

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

test("a strictly ascending setup passes", () => {
  expect(() =>
    assertStrictlyAscending([bytes(1), bytes(1, 0), bytes(2), bytes(3)], "p"),
  ).not.toThrow();
  expect(() => assertStrictlyAscending([], "p")).not.toThrow();
});

test.each([
  ["an equal pair", [bytes(1), bytes(2, 5), bytes(2, 5), bytes(3)]],
  ["a descending pair", [bytes(1), bytes(3), bytes(2)]],
  ["a prefix after its extension", [bytes(1, 0), bytes(1)]],
])("a setup holding %s is refused by name", (_name, elements) => {
  let caught: unknown;
  try {
    assertStrictlyAscending(elements, "joiner");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe(
    "joiner protocol error: PSI server setup is not in strictly ascending element order",
  );
  expect(isNamedDiagnosis(caught)).toBe(true);
});

test("a repeat straddling a slice boundary is refused", () => {
  const elements = Array.from({ length: 10 }, (_, index) => bytes(index));
  const ranges = matchSetupSliceRanges(elements.length, 5);
  elements[ranges[1]!.start] = elements[ranges[0]!.end - 1]!;
  expect(() => assertStrictlyAscending(elements, "joiner")).toThrow(
    /strictly ascending/,
  );
});

test("only the WebAssembly backend is budgeted", () => {
  expect(psiEngineOptionsForBackend("wasm")).toStrictEqual({
    matchMemoryBudgetBytes: WASM_PSI_MATCH_BUDGET_BYTES,
  });
  expect(psiEngineOptionsForBackend("native")).toStrictEqual({});
});
