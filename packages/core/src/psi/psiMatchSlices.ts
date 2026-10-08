import { InternalConsistencyError } from "../errors";
import {
  PSI_CHUNK_MIN_ELEMENTS,
  chunkRangesOfSize,
  compareElementBytes,
  psiChunkRanges,
} from "./psiChunks";

import type { PsiBackendSelection } from "./psiBackend";
import type { PsiChunkRange } from "./psiChunks";
import type { InProcessPsiEngineOptions } from "./psiEngine";

// Sizing each WebAssembly engine call so its linear memory stays under its
// fixed maximum, which a call's whole input must fit in (docs/spec/PROTOCOL.md,
// "The single-pass dataset ceiling: receiver memory and masking compute").

/** The WebAssembly PSI engine's fixed linear-memory maximum, in bytes. */
export const WASM_PSI_MEMORY_MAX_BYTES = 2_147_483_648;

/** Measured linear-memory growth of one match call per setup element. */
export const WASM_MATCH_BYTES_PER_SETUP_ELEMENT = 252;

/** Measured linear-memory growth of one match call per response element. */
export const WASM_MATCH_BYTES_PER_RESPONSE_ELEMENT = 56;

/**
 * The linear memory one WebAssembly match or masking call is sized to, in
 * bytes: 1.5 GiB, leaving 512 MiB of {@link WASM_PSI_MEMORY_MAX_BYTES} for the
 * engine's own baseline, the key state and allocator slack. A chosen figure,
 * held against measured runs by test/stress/wasmMatchSlices.stress.test.ts and
 * test/psi/psiMatchSlices.test.ts.
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
 * floor, as {@link matchSetupSliceElements} does.
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
 * The protocol error refusing a partner's setup whose elements are not
 * strictly ascending by bytes, whichever match method finds it. The message
 * holds no partner bytes.
 */
export function setupNotStrictlyAscendingError(id: string): Error {
  return new Error(
    `${id} protocol error: PSI server setup is not in strictly ascending element order`,
  );
}

/**
 * The protocol error refusing a partner's setup that is not a Raw data
 * structure, whichever match method finds it.
 */
export function setupNotRawError(id: string): Error {
  return new Error(
    `${id} protocol error: PSI server setup is not a Raw data structure`,
  );
}

/**
 * Refuses a partner's setup whose elements are not strictly ascending by
 * bytes, before every sliced match whether it runs in slices or one call. The
 * sliced match sums or offsets per-slice results, which equals the single
 * call only when no element appears in two slices; a conforming setup holds
 * distinct masked values in the library's sort order, so only a
 * nonconforming partner is refused.
 */
export function assertStrictlyAscending(
  elements: ReadonlyArray<Uint8Array>,
  id: string,
): void {
  for (let index = 1; index < elements.length; index += 1)
    if (compareElementBytes(elements[index - 1]!, elements[index]!) >= 0)
      throw setupNotStrictlyAscendingError(id);
}

/**
 * The engine options a worker serving `backend` runs under: the WebAssembly
 * engine's masking chunks, and its match slices where a match runs sliced,
 * are sized to {@link WASM_PSI_MATCH_BUDGET_BYTES}, and the native addon,
 * which has no fixed memory maximum, runs every masking operation at the
 * chunk policy's sizes. Both match by the engine's default method, the
 * streamed match.
 */
export function psiEngineOptionsForBackend(
  backend: PsiBackendSelection["backend"],
): InProcessPsiEngineOptions {
  return backend === "wasm"
    ? { matchMemoryBudgetBytes: WASM_PSI_MATCH_BUDGET_BYTES }
    : {};
}
