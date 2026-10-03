import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { InProcessPsiEngine } from "../../src/psi/psiEngine";
import { isNamedDiagnosis } from "../../src/errors";
import { MAX_PSI_DECODE_ELEMENTS } from "../../src/connection/frameSize";
import {
  PSI_CHUNK_MIN_ELEMENTS,
  chunkRangesOfSize,
  psiChunkRanges,
} from "../../src/psi/psiChunks";
import {
  WASM_MASKING_BYTES_PER_ELEMENT,
  WASM_MATCH_BYTES_PER_RESPONSE_ELEMENT,
  WASM_MATCH_BYTES_PER_SETUP_ELEMENT,
  WASM_PSI_MATCH_BUDGET_BYTES,
  WASM_PSI_MEMORY_MAX_BYTES,
  assertStrictlyAscending,
  maskingChunkRanges,
  matchSetupSliceElements,
  psiEngineOptionsForBackend,
} from "../../src/psi/psiMatchSlices";
import { loadNativeAddonOrSkip } from "../utils/nativeAddon";

import type { PsiChunkRange } from "../../src/psi/psiChunks";

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
  return chunkRangesOfSize(
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
  const ranges = chunkRangesOfSize(1_000_003, 300_000);
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
  const ranges = chunkRangesOfSize(elements.length, 5);
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

test("a setup that fits the budget matches in one call whatever the slice size would be", async () => {
  const library = await PSI();
  const setupValues = ["a", "b", "c", "d", "e", "f", "g"];
  const clientValues = ["c", "e", "z"];
  const budget =
    WASM_MATCH_BYTES_PER_SETUP_ELEMENT * setupValues.length +
    WASM_MATCH_BYTES_PER_RESPONSE_ELEMENT * clientValues.length;
  expect(() => matchSetupSliceElements(clientValues.length, budget)).toThrow(
    /below the floor/,
  );
  const options = { matchMemoryBudgetBytes: budget };
  const sender = new InProcessPsiEngine(
    library,
    "starter",
    "starter",
    "count-only",
    options,
  );
  const receiver = new InProcessPsiEngine(
    library,
    "joiner",
    "joiner",
    "count-only",
    options,
  );
  try {
    const { setup } = await sender.createServerSetup(setupValues);
    await receiver.receiveServerSetup(setup);
    const request = await receiver.createClientRequest(clientValues);
    const response = await sender.processClientRequest(request);
    expect(await receiver.computeIntersectionCardinality(response)).toBe(2);
  } finally {
    sender.dispose();
    receiver.dispose();
  }
});

// Masking chunks under the same budget: the chunk policy's sizes unless a
// chunk would grow the engine's memory past it.

const OPERATIONS = [
  "createSetupMessage",
  "createRequest",
  "processRequest",
] as const;

const largestRange = (ranges: ReadonlyArray<PsiChunkRange>): number =>
  Math.max(...ranges.map((range) => range.end - range.start));

const endsBetween = (ranges: ReadonlyArray<PsiChunkRange>): Array<number> =>
  ranges.slice(0, -1).map((range) => range.end);

test("without a budget or an operation a masking operation takes the policy's chunks", () => {
  expect(maskingChunkRanges(2 ** 24, undefined, 1)).toStrictEqual(
    psiChunkRanges(2 ** 24),
  );
  expect(
    maskingChunkRanges(2 ** 24, "processRequest", undefined),
  ).toStrictEqual(psiChunkRanges(2 ** 24));
});

test("a set at or below the chunk floor is one call under any budget", () => {
  expect(
    maskingChunkRanges(PSI_CHUNK_MIN_ELEMENTS, "processRequest", 1),
  ).toStrictEqual([{ start: 0, end: PSI_CHUNK_MIN_ELEMENTS }]);
});

test.each(OPERATIONS)(
  "a %s chunk at the per-set maximum fits the budget",
  (operation) => {
    const ranges = maskingChunkRanges(
      MAX_PSI_DECODE_ELEMENTS,
      operation,
      WASM_PSI_MATCH_BUDGET_BYTES,
    );
    expect(
      largestRange(ranges) * WASM_MASKING_BYTES_PER_ELEMENT[operation],
    ).toBeLessThanOrEqual(WASM_PSI_MATCH_BUDGET_BYTES);
    expect(ranges[0]!.start).toBe(0);
    expect(ranges.at(-1)!.end).toBe(MAX_PSI_DECODE_ELEMENTS);
  },
);

test.each([
  ["createSetupMessage", 7_643_790, 5],
  ["createRequest", 7_643_790, 5],
  ["processRequest", 7_643_790, 5],
  ["createSetupMessage", 2 ** 24, 5],
  ["createRequest", 2 ** 24, 5],
  ["processRequest", 2 ** 24, 6],
] as const)(
  "%s over %i elements runs in %i chunks under the budget",
  (operation, elements, chunks) => {
    expect(
      maskingChunkRanges(elements, operation, WASM_PSI_MATCH_BUDGET_BYTES),
    ).toHaveLength(chunks);
  },
);

test("a budget below one chunk's growth splits into chunks that fit", () => {
  const chunkElements = 10_000;
  const budget =
    chunkElements * WASM_MASKING_BYTES_PER_ELEMENT.createRequest + 1;
  const ranges = maskingChunkRanges(100_000, "createRequest", budget);
  expect(ranges).toHaveLength(10);
  expect(largestRange(ranges)).toBeLessThanOrEqual(chunkElements);
  for (let index = 1; index < ranges.length; index += 1)
    expect(ranges[index]!.start).toBe(ranges[index - 1]!.end);
});

test("a masking chunk below the floor is an internal error", () => {
  expect(() =>
    maskingChunkRanges(
      100_000,
      "processRequest",
      WASM_MASKING_BYTES_PER_ELEMENT.processRequest * 100,
    ),
  ).toThrow(/below the floor/);
});

// What the budget answers to, measured on the WebAssembly engine in Node
// (docs/spec/PROTOCOL.md, "A long masking operation runs as a few chunks"):
// the engine starts at 16.25 MiB, a 2^24 setup matched against a 2^16
// response in 3 slices peaked at 1,318 MiB, and answering a request at the
// 2,960,685-element chunk the budget allows peaked at 1,424 MiB.
const MEASURED_ENGINE_START_BYTES = 17_039_360;
const MEASURED_SLICED_MATCH_PEAK_BYTES = 1_318 * 1024 * 1024;
const MEASURED_MASKING_CHUNK_PEAK_BYTES = 1_493_172_224;

test("the budget sits above the measured calls and inside the maximum less the engine's start", () => {
  expect(MEASURED_SLICED_MATCH_PEAK_BYTES).toBeLessThanOrEqual(
    WASM_PSI_MATCH_BUDGET_BYTES,
  );
  expect(MEASURED_MASKING_CHUNK_PEAK_BYTES).toBeLessThanOrEqual(
    WASM_PSI_MATCH_BUDGET_BYTES,
  );
  expect(
    maskingChunkRanges(
      MAX_PSI_DECODE_ELEMENTS,
      "processRequest",
      WASM_PSI_MATCH_BUDGET_BYTES,
    )[0]!.end,
  ).toBeLessThanOrEqual(2_960_685);
  expect(
    WASM_PSI_MATCH_BUDGET_BYTES + MEASURED_ENGINE_START_BYTES,
  ).toBeLessThanOrEqual(WASM_PSI_MEMORY_MAX_BYTES);
});

test("the engine runs each masking operation in the chunks its budget allows", async () => {
  const library = (await loadNativeAddonOrSkip()) ?? (await PSI());
  const elements = 20_000;
  const overlap = 100;
  // The largest per-element figure sizes its operation's chunk to the floor,
  // which splits 20,000 elements in three where the policy splits them in two.
  const budget =
    PSI_CHUNK_MIN_ELEMENTS *
    Math.max(...Object.values(WASM_MASKING_BYTES_PER_ELEMENT));
  const expected = Object.fromEntries(
    OPERATIONS.map((operation) => [
      operation,
      endsBetween(maskingChunkRanges(elements, operation, budget)),
    ]),
  );
  expect(Object.values(expected)).toContainEqual(
    endsBetween(chunkRangesOfSize(elements, PSI_CHUNK_MIN_ELEMENTS)),
  );
  expect(endsBetween(psiChunkRanges(elements))).toHaveLength(1);

  const options = { matchMemoryBudgetBytes: budget };
  const starter = new InProcessPsiEngine(
    library,
    "starter",
    "starter",
    "identifier-revealing",
    options,
  );
  const joiner = new InProcessPsiEngine(
    library,
    "joiner",
    "joiner",
    "identifier-revealing",
    options,
  );
  const processed: Array<number> = [];
  starter.observeProcessedElements((count) => processed.push(count));
  joiner.observeProcessedElements((count) => processed.push(count));
  const ticks = async <T>(
    run: () => Promise<T>,
  ): Promise<[T, Array<number>]> => {
    processed.length = 0;
    const value = await run();
    return [value, [...processed]];
  };
  try {
    const [{ setup }, setupTicks] = await ticks(() =>
      starter.createServerSetup(
        Array.from({ length: elements }, (_, i) => `shared-${i}`),
      ),
    );
    const [request, requestTicks] = await ticks(() =>
      joiner.createClientRequest(
        Array.from({ length: elements }, (_, i) =>
          i < overlap ? `shared-${i}` : `joiner-${i}`,
        ),
      ),
    );
    const [response, responseTicks] = await ticks(() =>
      starter.processClientRequest(request),
    );
    expect(setupTicks).toStrictEqual(expected.createSetupMessage);
    expect(requestTicks).toStrictEqual(expected.createRequest);
    expect(responseTicks).toStrictEqual(expected.processRequest);
    await joiner.receiveServerSetup(setup);
    const [local] = await joiner.computeAssociationTable(response);
    expect(local).toHaveLength(overlap);
  } finally {
    starter.dispose();
    joiner.dispose();
  }
});
