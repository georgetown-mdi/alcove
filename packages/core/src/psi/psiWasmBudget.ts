import {
  InternalConsistencyError,
  PartnerProtocolRefusalError,
} from "../errors";
import {
  PSI_CHUNK_MIN_ELEMENTS,
  chunkRangesOfSize,
  psiChunkRanges,
} from "./psiChunks";

import type { PsiBackendSelection } from "./psiBackend";
import type { PsiChunkRange } from "./psiChunks";
import type { InProcessPsiEngineOptions } from "./psiEngine";

// Sizing each WebAssembly masking call so its linear memory stays under its
// fixed maximum, which a call's whole input must fit in (docs/spec/PROTOCOL.md,
// "The single-pass dataset ceiling: receiver memory and masking compute").

/** The WebAssembly PSI engine's fixed linear-memory maximum, in bytes. */
export const WASM_PSI_MEMORY_MAX_BYTES = 2_147_483_648;

/**
 * The linear memory one WebAssembly masking call is sized to, in bytes:
 * 1.5 GiB, leaving 512 MiB of {@link WASM_PSI_MEMORY_MAX_BYTES} for the
 * engine's own baseline, the key state and allocator slack. A chosen figure,
 * held against measured runs by test/stress/wasmMaskingGrowth.stress.test.ts
 * and test/psi/psiWasmBudget.test.ts.
 */
export const WASM_PSI_CALL_BUDGET_BYTES = 1_610_612_736;

/** A masking call the WebAssembly engine runs over one chunk of a set. */
export type WasmMaskingOperation =
  "createSetupMessage" | "createRequest" | "processRequest";

/**
 * Linear-memory growth of one masking call per element it is handed: the
 * most measured at any size run, up to 3,355,444 elements a call, rounded up.
 * test/stress/wasmMaskingGrowth.stress.test.ts holds each at or above a
 * fresh measurement.
 */
export const WASM_MASKING_BYTES_PER_ELEMENT: Readonly<
  Record<WasmMaskingOperation, number>
> = {
  createSetupMessage: 432,
  createRequest: 400,
  processRequest: 544,
};

/**
 * The ranges one masking operation over `total` elements runs in: the chunk
 * policy's (psiChunks.ts), unless one of its chunks would grow the engine's
 * memory past `budgetBytes`, in which case chunks of the most elements that
 * fit. Without a budget or an operation, and for a set at or below the chunk
 * floor, the policy's ranges. Throws when the most that fit falls below the
 * floor: every set the element bounds admit leaves a chunk far above it, so a
 * smaller one means the constants above no longer describe the engine.
 */
export function maskingChunkRanges(
  total: number,
  operation: WasmMaskingOperation | undefined,
  budgetBytes: number | undefined,
): PsiChunkRange[] {
  const policy = psiChunkRanges(total);
  if (
    operation === undefined ||
    budgetBytes === undefined ||
    total <= PSI_CHUNK_MIN_ELEMENTS
  )
    return policy;
  const chunkElements = Math.floor(
    budgetBytes / WASM_MASKING_BYTES_PER_ELEMENT[operation],
  );
  if (!(chunkElements >= PSI_CHUNK_MIN_ELEMENTS))
    throw new InternalConsistencyError(
      `a PSI ${operation} chunk under a ${String(budgetBytes)}-byte budget holds ${String(chunkElements)} elements, below the floor of ${String(PSI_CHUNK_MIN_ELEMENTS)}`,
    );
  return policy.every((range) => range.end - range.start <= chunkElements)
    ? policy
    : chunkRangesOfSize(total, chunkElements);
}

/**
 * The protocol refusal of a partner's setup whose elements are not strictly
 * ascending by bytes. The message holds no partner bytes.
 */
export function setupNotStrictlyAscendingError(
  id: string,
): PartnerProtocolRefusalError {
  return new PartnerProtocolRefusalError(
    `${id} protocol error: PSI server setup is not in strictly ascending element order`,
  );
}

/** The protocol refusal of a partner's setup that is not a Raw data structure. */
export function setupNotRawError(id: string): PartnerProtocolRefusalError {
  return new PartnerProtocolRefusalError(
    `${id} protocol error: PSI server setup is not a Raw data structure`,
  );
}

/**
 * The engine options a worker serving `backend` runs under: the WebAssembly
 * engine's masking chunks are sized to {@link WASM_PSI_CALL_BUDGET_BYTES},
 * and the native addon, which has no fixed memory maximum, runs every masking
 * operation at the chunk policy's sizes.
 */
export function psiEngineOptionsForBackend(
  backend: PsiBackendSelection["backend"],
): InProcessPsiEngineOptions {
  return backend === "wasm"
    ? { maskingMemoryBudgetBytes: WASM_PSI_CALL_BUDGET_BYTES }
    : {};
}
