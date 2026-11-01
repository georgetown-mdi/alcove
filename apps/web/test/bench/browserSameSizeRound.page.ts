import {
  createBrowserPsiEngineFactory,
  encodePsiWorkerInit,
} from "../../src/psi/workers/psiCryptoController";

import { download, upload } from "./benchSetTransfer";
import { partyValues } from "./partyValues";

import type { PsiEngine, PsiEngineMode } from "@alcove/core";
import type { PsiCryptoWorker } from "../../src/psi/workers/psiCryptoController";

// The page half of browserSameSizeRound.ts, bundled by it: the web app's own
// worker-backed PSI engine (createBrowserPsiEngineFactory over the shipped
// psiCrypto.worker.ts entry), driven one PSI operation per page call. Set
// bytes move between the page and the Node partner over the bench's own
// local HTTP server, never through a page call's return value.

/** The calls browserSameSizeRound.ts makes on the page, one per step. */
export interface RoundProbe {
  makeEngine: (role: "starter" | "joiner", mode: PsiEngineMode) => void;
  createServerSetup: (elements: number, overlap: number) => Promise<number>;
  createClientRequest: (elements: number, overlap: number) => Promise<number>;
  processClientRequest: () => Promise<number>;
  receiveServerSetup: () => Promise<void>;
  computeAssociationTable: () => Promise<Array<[number, number]>>;
  partnerPositionsOf: (localIndices: Array<number>) => Array<number>;
  dispose: () => void;
}

let engine: PsiEngine | undefined;
let permutation: Array<number> = [];

function requireEngine(): PsiEngine {
  if (!engine) throw new Error("makeEngine has not run");
  return engine;
}

const probe: RoundProbe = {
  makeEngine(role, mode) {
    engine = createBrowserPsiEngineFactory(
      (init) =>
        new Worker("/worker.js", {
          type: "module",
          name: encodePsiWorkerInit(init),
        }) as unknown as PsiCryptoWorker,
    )(role, role, mode);
  },
  async createServerSetup(elements, overlap) {
    const built = await requireEngine().createServerSetup(
      partyValues(elements, overlap, "browser"),
    );
    permutation = built.permutation;
    return upload("setup", built.setup);
  },
  async createClientRequest(elements, overlap) {
    return upload(
      "request",
      await requireEngine().createClientRequest(
        partyValues(elements, overlap, "browser"),
      ),
    );
  },
  async processClientRequest() {
    return upload(
      "response",
      await requireEngine().processClientRequest(await download("request")),
    );
  },
  async receiveServerSetup() {
    await requireEngine().receiveServerSetup(await download("setup"));
  },
  async computeAssociationTable() {
    const [local, partner] = await requireEngine().computeAssociationTable(
      await download("response"),
    );
    return local.map((index, pair) => [index, partner[pair]]);
  },
  partnerPositionsOf(localIndices) {
    const positions = new Map(localIndices.map((index) => [index, -1]));
    permutation.forEach((input, position) => {
      if (positions.has(input)) positions.set(input, position);
    });
    return localIndices.map((index) => positions.get(index)!);
  },
  dispose() {
    engine?.dispose();
    engine = undefined;
    permutation = [];
  },
};

(globalThis as unknown as { probeOf: () => RoundProbe }).probeOf = () => probe;
