import { expect, test } from "vitest";
import { vi } from "vitest";

import PSI from "@openmined/psi.js";

import { InProcessPsiEngine } from "../../src/psi/psiEngine";
import { isPsiLibraryFailure, ProtocolRefusalError } from "../../src/errors";
import { classifyFailure } from "../../src/failureClass";
import {
  BROWSER_PSI_SET_MAX_ELEMENTS,
  MAX_PSI_DECODE_ELEMENTS,
} from "../../src/connection/frameSize";
import {
  PSI_CHUNK_MIN_ELEMENTS,
  chunkRangesOfSize,
  psiChunkRanges,
} from "../../src/psi/psiChunks";
import {
  WASM_MASKING_BYTES_PER_ELEMENT,
  WASM_PSI_CALL_BUDGET_BYTES,
  WASM_PSI_MEMORY_MAX_BYTES,
  maskingChunkRanges,
  psiEngineOptionsForBackend,
  setupNotRawError,
  setupNotStrictlyAscendingError,
} from "../../src/psi/psiWasmBudget";
import { loadNativeAddonOrSkip } from "../utils/nativeAddon";

vi.setConfig({ testTimeout: 60_000 });

import type { PsiChunkRange } from "../../src/psi/psiChunks";

test("the budget leaves room under the engine's fixed maximum", () => {
  expect(WASM_PSI_CALL_BUDGET_BYTES).toBeLessThan(WASM_PSI_MEMORY_MAX_BYTES);
});

test.each([
  [
    "setupNotStrictlyAscendingError",
    setupNotStrictlyAscendingError,
    "joiner protocol error: PSI server setup is not in strictly ascending element order",
  ],
  [
    "setupNotRawError",
    setupNotRawError,
    "joiner protocol error: PSI server setup is not a Raw data structure",
  ],
] as const)(
  "%s is the partner's protocol refusal, not a library failure",
  (_name, refusal, message) => {
    const caught = refusal("joiner");
    expect(caught).toBeInstanceOf(ProtocolRefusalError);
    expect(caught.message).toBe(message);
    expect(classifyFailure(caught)).toBe("partner-refused");
    expect(isPsiLibraryFailure(caught)).toBe(false);
  },
);

test("only the WebAssembly backend is budgeted", () => {
  expect(psiEngineOptionsForBackend("wasm")).toStrictEqual({
    maskingMemoryBudgetBytes: WASM_PSI_CALL_BUDGET_BYTES,
  });
  expect(psiEngineOptionsForBackend("native")).toStrictEqual({});
});

// Masking chunks under the budget: the chunk policy's sizes unless a chunk
// would grow the engine's memory past it.

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
      WASM_PSI_CALL_BUDGET_BYTES,
    );
    expect(
      largestRange(ranges) * WASM_MASKING_BYTES_PER_ELEMENT[operation],
    ).toBeLessThanOrEqual(WASM_PSI_CALL_BUDGET_BYTES);
    expect(ranges[0]!.start).toBe(0);
    expect(ranges.at(-1)!.end).toBe(MAX_PSI_DECODE_ELEMENTS);
  },
);

test.each([
  ["createSetupMessage", BROWSER_PSI_SET_MAX_ELEMENTS, 5],
  ["createRequest", BROWSER_PSI_SET_MAX_ELEMENTS, 5],
  ["processRequest", BROWSER_PSI_SET_MAX_ELEMENTS, 5],
  ["createSetupMessage", 2 ** 24, 5],
  ["createRequest", 2 ** 24, 5],
  ["processRequest", 2 ** 24, 6],
] as const)(
  "%s over %i elements runs in %i chunks under the budget",
  (operation, elements, chunks) => {
    expect(
      maskingChunkRanges(elements, operation, WASM_PSI_CALL_BUDGET_BYTES),
    ).toHaveLength(chunks);
  },
);

test.each(OPERATIONS)(
  "%s at the browser ceiling runs at the chunk policy's sizes",
  (operation) => {
    expect(
      maskingChunkRanges(
        BROWSER_PSI_SET_MAX_ELEMENTS,
        operation,
        WASM_PSI_CALL_BUDGET_BYTES,
      ),
    ).toStrictEqual(psiChunkRanges(BROWSER_PSI_SET_MAX_ELEMENTS));
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
// (docs/spec/PROTOCOL.md, "The single-pass dataset ceiling: receiver memory
// and masking compute"): the engine starts at 16.25 MiB, answering a request
// at the 2,960,685-element chunk the budget allows peaked at 1,424 MiB, and
// creating a setup or a request at the policy's 3,355,444-element chunk at
// 2^24 peaked at 1,263 MiB.
const MEASURED_ENGINE_START_BYTES = 17_039_360;
const MEASURED_MASKING_CHUNK_PEAK_BYTES = 1_493_172_224;
const MEASURED_POLICY_CHUNK_PEAK_BYTES = 1_324_351_488;

test("the budget sits above the measured calls and inside the maximum less the engine's start", () => {
  expect(MEASURED_MASKING_CHUNK_PEAK_BYTES).toBeLessThanOrEqual(
    WASM_PSI_CALL_BUDGET_BYTES,
  );
  expect(MEASURED_POLICY_CHUNK_PEAK_BYTES).toBeLessThanOrEqual(
    WASM_PSI_CALL_BUDGET_BYTES,
  );
  expect(
    maskingChunkRanges(
      MAX_PSI_DECODE_ELEMENTS,
      "processRequest",
      WASM_PSI_CALL_BUDGET_BYTES,
    )[0]!.end,
  ).toBeLessThanOrEqual(2_960_685);
  expect(
    WASM_PSI_CALL_BUDGET_BYTES + MEASURED_ENGINE_START_BYTES,
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

  const options = { maskingMemoryBudgetBytes: budget };
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
