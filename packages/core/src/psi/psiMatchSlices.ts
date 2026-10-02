import { InternalConsistencyError, markNamedDiagnosis } from "../errors";
import {
  PSI_CHUNK_MIN_ELEMENTS,
  chunkRangesOfSize,
  compareElementBytes,
} from "./psiChunks";

import type { PsiBackendSelection } from "./psiBackend";
import type { PsiChunkRange } from "./psiChunks";
import type { InProcessPsiEngineOptions } from "./psiEngine";

// Sizing the joiner's match so the WebAssembly engine's linear memory stays
// under its fixed maximum. A match call takes the whole setup it is handed and
// the response it is handed into that memory, so a large held setup is matched
// in contiguous slices of its own sorted order, each slice one library call
// (docs/spec/PROTOCOL.md, "A long masking operation runs as a few chunks").

/** The WebAssembly PSI engine's fixed linear-memory maximum, in bytes. */
export const WASM_PSI_MEMORY_MAX_BYTES = 2_147_483_648;

/** Measured linear-memory growth of one match call per setup element. */
export const WASM_MATCH_BYTES_PER_SETUP_ELEMENT = 252;

/** Measured linear-memory growth of one match call per response element. */
export const WASM_MATCH_BYTES_PER_RESPONSE_ELEMENT = 56;

/**
 * The linear memory one WebAssembly match call is sized to, in bytes: 1.5 GiB,
 * leaving 512 MiB of {@link WASM_PSI_MEMORY_MAX_BYTES} for the engine's own
 * baseline, the key state and allocator slack. A chosen figure, held against
 * a measured run by test/stress/wasmMatchSlices.stress.test.ts.
 */
export const WASM_PSI_MATCH_BUDGET_BYTES = 1_610_612_736;

/**
 * The most setup elements one match call may take beside
 * `responseElementsPerCall` response elements under `budgetBytes` of engine
 * memory. Throws when that falls below the chunk floor: every response the
 * element bounds admit leaves a slice far above it, so a smaller one means the
 * constants above no longer describe the engine.
 */
export function matchSetupSliceElements(
  responseElementsPerCall: number,
  budgetBytes: number,
): number {
  const sliceElements = Math.floor(
    (budgetBytes -
      WASM_MATCH_BYTES_PER_RESPONSE_ELEMENT * responseElementsPerCall) /
      WASM_MATCH_BYTES_PER_SETUP_ELEMENT,
  );
  if (!(sliceElements >= PSI_CHUNK_MIN_ELEMENTS))
    throw new InternalConsistencyError(
      `a PSI match over ${String(responseElementsPerCall)} response elements leaves a setup slice of ${String(sliceElements)} elements under a ${String(budgetBytes)}-byte budget, below the floor of ${String(PSI_CHUNK_MIN_ELEMENTS)}`,
    );
  return sliceElements;
}

/**
 * The contiguous ranges a `setupElements`-element setup is matched in, each
 * at most `sliceElements` long and the sizes differing by at most one.
 */
export function matchSetupSliceRanges(
  setupElements: number,
  sliceElements: number,
): PsiChunkRange[] {
  return chunkRangesOfSize(setupElements, sliceElements);
}

/**
 * Refuses a partner's setup whose elements are not strictly ascending by
 * bytes. The sliced match sums or offsets per-slice results, which equals the
 * single call only when no element appears in two slices; a conforming setup
 * holds distinct masked values in the library's sort order, so only a
 * nonconforming partner is refused. The message holds no partner bytes.
 */
export function assertStrictlyAscending(
  elements: ReadonlyArray<Uint8Array>,
  id: string,
): void {
  for (let index = 1; index < elements.length; index += 1)
    if (compareElementBytes(elements[index - 1]!, elements[index]!) >= 0)
      throw markNamedDiagnosis(
        new Error(
          `${id} protocol error: PSI server setup is not in strictly ascending element order`,
        ),
      );
}

/**
 * The engine options a worker serving `backend` runs under: the WebAssembly
 * engine's match is sized to {@link WASM_PSI_MATCH_BUDGET_BYTES}, and the
 * native addon, which has no fixed memory maximum, runs every match as one
 * call.
 */
export function psiEngineOptionsForBackend(
  backend: PsiBackendSelection["backend"],
): InProcessPsiEngineOptions {
  return backend === "wasm"
    ? { matchMemoryBudgetBytes: WASM_PSI_MATCH_BUDGET_BYTES }
    : {};
}
