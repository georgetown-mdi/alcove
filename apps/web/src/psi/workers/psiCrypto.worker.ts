// @ts-ignore this is really there
import PSI from "@openmined/psi.js/psi_wasm_worker";

import { loadPsiBackend } from "@alcove/core";

import { runPsiCryptoWorker } from "./psiCryptoWorkerProgram";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import type { PsiCryptoWorkerScope } from "./psiCryptoWorkerProgram";

/**
 * The off-main-thread PSI crypto worker. It runs core's PSI worker dispatcher
 * over a freshly loaded WASM engine, so the elliptic-curve masking a PSI round
 * performs runs here instead of on the browser's UI thread -- keeping the tab
 * interactive and the WebRTC peer keepalives firing during a round. Bundled by
 * Vite from {@link ./psiCryptoWorkerClient}; the WASM worker
 * build (`@openmined/psi.js/psi_wasm_worker`) is the worker-context sibling of the
 * `psi_wasm_web` entry the main thread loads.
 *
 * The program -- the primary that generates the key, the helper that takes it,
 * and the buffering of requests while the engine loads -- is
 * {@link runPsiCryptoWorker} (Node-unit-tested); this entry only wires the
 * worker globals to it. `onmessage` is attached synchronously at module top,
 * before the async engine load yields, so a request the host posts before this
 * script finishes running is held by the platform until the listener exists.
 */

// Worker globals are not in the app's DOM lib; narrow `globalThis` to the
// dedicated-worker affordances the program uses rather than pulling the
// WebWorker lib into the whole program (which would clash with DOM on
// `self`/`postMessage`).
const scope = globalThis as unknown as PsiCryptoWorkerScope;

// The browser always uses WASM; loadPsiBackend keeps the backend selection
// identical to the main-thread path, which has no native addon.
runPsiCryptoWorker(scope, () =>
  loadPsiBackend(
    { loadWasm: () => PSI() as Promise<PSILibrary> },
    { isNode: false },
  ),
);
