import PSI from "@openmined/psi.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { loadPsiBackend } from "@alcove/core";
import type {
  PsiBackendOptions,
  PsiBackendSelection,
  PsiWorkerInit,
} from "@alcove/core";

/**
 * Loads the native N-API PSI addon when a prebuild is available for this
 * platform, or resolves `null` so the CLI falls back to WASM. The addon is a
 * performance accelerator only -- correctness never depends on it. Prebuild
 * resolution and the WASM-fallback contract: docs/spec/NPM_INSTALL_POLICY.md,
 * "The vendored @openmined/psi.js addon".
 */
async function loadNativePsiAddon(): Promise<PSILibrary | null> {
  try {
    const { default: loadNativeLibrary } =
      await import("@openmined/psi.js/psi_native_node.js");
    return await loadNativeLibrary();
  } catch (error) {
    // isNativeUnavailable separates the expected no-prebuild / module-not-found
    // cases (fall back to WASM) from a corrupt or ABI-mismatched .node, which is
    // re-thrown so onNativeUnavailable can report it instead.
    if (isNativeUnavailable(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Whether a native-addon load error is the ordinary "no native build for this
 * platform / package" case (quiet fallback) rather than a broken load worth
 * reporting. Exported so the classification the WASM fallback depends on is
 * pinned by unit tests -- misclassifying a broken addon as "unavailable" would
 * hide a real regression behind a silent fallback (see psiBackend.test.ts).
 */
export function isNativeUnavailable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
    return true;
  }
  return (
    error instanceof Error && /No native build was found/i.test(error.message)
  );
}

/**
 * Resolves the CLI's PSI crypto backend: the native addon when a prebuild is
 * available for this platform, otherwise the Node WASM build. The CLI always
 * runs under Node, so the native addon is always eligible;
 * {@link loadNativePsiAddon} decides whether one is actually present.
 */
export function loadCliPsiBackend(
  options?: Pick<PsiBackendOptions, "onNativeUnavailable">,
): Promise<PsiBackendSelection> {
  return loadPsiBackend(
    { loadWasm: () => PSI(), loadNative: loadNativePsiAddon },
    { isNode: true, ...options },
  );
}

/**
 * What the CLI's PSI worker is started with: core's seed and the backend the
 * host selected, which the memory check charged and the worker loads.
 */
export interface CliPsiWorkerInit extends PsiWorkerInit {
  readonly backend: PsiBackendSelection["backend"];
}

/** The loaders {@link loadNamedCliPsiBackend} calls; a test supplies its own. @internal */
export interface CliPsiBackendLoaders {
  loadWasm: () => Promise<PSILibrary>;
  loadNative: () => Promise<PSILibrary | null>;
}

const CLI_PSI_BACKEND_LOADERS: CliPsiBackendLoaders = {
  loadWasm: () => PSI(),
  loadNative: loadNativePsiAddon,
};

/**
 * Loads exactly `backend`, with no fallback: the PSI worker's load, so it
 * masks on the library the host's memory check charged. Throws when the native
 * addon is requested and does not load.
 */
export async function loadNamedCliPsiBackend(
  backend: PsiBackendSelection["backend"],
  loaders: CliPsiBackendLoaders = CLI_PSI_BACKEND_LOADERS,
): Promise<PSILibrary> {
  switch (backend) {
    case "wasm":
      return loaders.loadWasm();
    case "native": {
      const native = await loaders.loadNative();
      if (native === null)
        throw new Error(
          "the native PSI library the run selected does not load in the PSI worker",
        );
      return native;
    }
    default:
      throw new Error(`unknown PSI library requested: ${String(backend)}`);
  }
}
