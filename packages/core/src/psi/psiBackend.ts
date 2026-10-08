import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

// Picks the PSILibrary a caller injects (RunExchangeOptions.psiLibrary). The
// two backends interoperate byte-for-byte, pinned by the
// psi-engine-wire-vectors.json fixture. See
// docs/spec/PROTOCOL.md#psi-base-function.

/** Which PSI crypto engine {@link loadPsiBackend} resolved. */
type PsiBackendKind = "native" | "wasm";

/**
 * Loaders the environment supplies to {@link loadPsiBackend}. The caller owns
 * how each backend is imported, so a browser bundle pulls in neither the node
 * WASM entry nor the native addon.
 */
interface PsiBackendLoaders {
  /**
   * Loads the native addon, or resolves `null` when no prebuild is available
   * for this platform. Consulted only under Node; a throw falls back to WASM
   * as `null` does. Omit on the browser.
   */
  readonly loadNative?: () => Promise<PSILibrary | null>;
  /** Loads the WebAssembly backend from the node or web entry. */
  readonly loadWasm: () => Promise<PSILibrary>;
}

/** Options controlling {@link loadPsiBackend}. */
export interface PsiBackendOptions {
  /**
   * Whether this is a Node runtime (native addon eligible). Defaults to
   * {@link detectNodeRuntime}; pass it where the environment is known.
   */
  readonly isNode?: boolean;
  /**
   * Called before falling back to WASM when the native backend was eligible
   * but yielded no library; `error` is set when the loader threw.
   */
  readonly onNativeUnavailable?: (info: { error?: unknown }) => void;
}

/** The engine {@link loadPsiBackend} resolved, and which backend it is. */
export interface PsiBackendSelection {
  readonly library: PSILibrary;
  readonly backend: PsiBackendKind;
}

/**
 * Best-effort check for a Node runtime: a Node `process` and no DOM `window`,
 * since a browser bundle can shim `process`.
 */
export function detectNodeRuntime(): boolean {
  const g = globalThis as {
    process?: { versions?: { node?: unknown } };
    window?: unknown;
  };
  return g.process?.versions?.node != null && g.window === undefined;
}

/**
 * Selects the PSI crypto backend: under Node the native addon, falling back to
 * WASM when it is unavailable or fails to load; in the browser, always WASM.
 */
export async function loadPsiBackend(
  loaders: PsiBackendLoaders,
  options: PsiBackendOptions = {},
): Promise<PsiBackendSelection> {
  const isNode = options.isNode ?? detectNodeRuntime();
  if (isNode && loaders.loadNative) {
    try {
      const native = await loaders.loadNative();
      if (native) return { library: native, backend: "native" };
      options.onNativeUnavailable?.({});
    } catch (error) {
      options.onNativeUnavailable?.({ error });
    }
  }
  return { library: await loaders.loadWasm(), backend: "wasm" };
}
