import { describe, expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import {
  WASM_MASKING_BYTES_PER_ELEMENT,
  maskingChunkRanges,
} from "../../src/psi/psiMatchSlices";
import { loadNativeAddonOrSkip } from "../utils/nativeAddon";
import {
  chunkIdentityValues,
  expectChunkedCountMatchesSingleCall,
  expectChunkedRoundMatchesSingleCall,
} from "../utils/psiChunkIdentity";

import type { WasmMaskingOperation } from "../../src/psi/psiMatchSlices";

// A round whose masking chunks and match slices come from the memory budget
// goes on the wire as the single call's bytes. The budget's floor is lowered
// to a unit-sized set so the cap binds at 200 elements; the policy's own chunk
// count still reads the shipped floor and takes the set in one chunk, so every
// split below is the budget's.
vi.mock("../../src/psi/psiChunks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/psi/psiChunks")>()),
  PSI_CHUNK_MIN_ELEMENTS: 16,
}));

const TOTAL = 200;
const BUDGET_BYTES = 30 * WASM_MASKING_BYTES_PER_ELEMENT.processRequest;

const { serverValues, clientValues } = chunkIdentityValues(TOTAL);

const wasm = await PSI();
const native: PSILibrary | undefined = await loadNativeAddonOrSkip();

function budgetChunkStarts(operation: WasmMaskingOperation): Array<number> {
  const ranges = maskingChunkRanges(TOTAL, operation, BUDGET_BYTES);
  expect(ranges.length).toBeGreaterThan(1);
  return ranges.slice(1).map((range) => range.start);
}

describe.each([
  ["wasm", wasm],
  ["native addon", native],
])("the %s backend under a binding memory budget", (_name, library) => {
  test("a round reproduces the single call byte for byte", async (ctx) => {
    if (!library) {
      ctx.skip();
      return;
    }
    const processed = await expectChunkedRoundMatchesSingleCall({
      library,
      serverValues,
      clientValues,
      matchMemoryBudgetBytes: BUDGET_BYTES,
    });
    expect(processed.createServerSetup).toStrictEqual(
      budgetChunkStarts("createSetupMessage"),
    );
    expect(processed.createClientRequest).toStrictEqual(
      budgetChunkStarts("createRequest"),
    );
    expect(processed.processClientRequest).toStrictEqual(
      budgetChunkStarts("processRequest"),
    );
    expect(processed.computeAssociationTable?.length).toBeGreaterThan(0);
  });

  test("a count-only round reproduces the single call's bytes and cardinality", async (ctx) => {
    if (!library) {
      ctx.skip();
      return;
    }
    const matchProcessed = await expectChunkedCountMatchesSingleCall({
      library,
      serverValues,
      clientValues,
      matchMemoryBudgetBytes: BUDGET_BYTES,
    });
    expect(matchProcessed.length).toBeGreaterThan(0);
  });
});
