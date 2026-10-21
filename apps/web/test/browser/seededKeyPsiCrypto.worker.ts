// @ts-ignore this is really there
import PSI from "@openmined/psi.js/psi_wasm_worker";

import { loadPsiBackend } from "@alcove/core";

import { runPsiCryptoWorker } from "@psi/workers/psiCryptoWorkerProgram";

import { withSeededKeys } from "./seededPsiKeys";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import type { PsiCryptoWorkerScope } from "@psi/workers/psiCryptoWorkerProgram";

// The production PSI worker (src/psi/workers/psiCrypto.worker.ts) with each
// new key replaced by a seeded one (./seededPsiKeys.ts), so a browser test
// can compare a pool's bytes with one engine's under the same key. Test-only:
// spawned from test/browser and never imported by src/.

const scope = globalThis as unknown as PsiCryptoWorkerScope;

runPsiCryptoWorker(scope, () =>
  loadPsiBackend(
    {
      loadWasm: async () =>
        withSeededKeys(await (PSI() as Promise<PSILibrary>)),
    },
    { isNode: false },
  ),
);
