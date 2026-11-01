import {
  createBrowserPsiEngineFactory,
  encodePsiWorkerInit,
} from "../../src/psi/workers/psiCryptoController";

import { dial, runRound, wrap } from "./wrappedRoundParty";
import { partyValues } from "./partyValues";

import type { MessageConnection, PsiEngine } from "@alcove/core";
import type { RoundOutcome, RoundSide } from "./wrappedRoundParty";
import type { PsiCryptoWorker } from "../../src/psi/workers/psiCryptoController";

// The measured page of browserWrappedRound.ts, bundled by it: the web app's own
// worker-backed PSI engine (the shipped psiCrypto.worker.ts entry) in one PSI
// round of core's participant, over a PeerJS data channel wrapped in core's
// EncryptedMessageConnection. Around each engine operation the page calls the
// bench, which forces a collection in the worker and reads its memory, and
// between calls it samples its own heap.

/** The calls browserWrappedRound.ts makes on the measured page. */
export interface MeasuredProbe {
  makeEngine: (side: RoundSide) => void;
  connect: (
    brokerPort: number,
    sharedSecret: string,
    sessionKey: ReadonlyArray<number>,
  ) => Promise<void>;
  run: (
    side: RoundSide,
    elements: number,
    overlap: number,
  ) => Promise<RoundOutcome>;
  pageMemory: () => PageMemorySamples;
}

/**
 * The page's `performance.memory.usedJSHeapSize` sampled through the round:
 * the most in each phase the bench named and the most overall. On the build
 * measured it counts the bytes of every live ArrayBuffer beside the V8 heap.
 */
export interface PageMemorySamples {
  readonly peakBytes: number;
  readonly peakBytesByPhase: Record<string, number>;
  readonly samples: number;
}

// Exposed by the bench before the page loads: marks the edge of one engine
// operation, and answers the name of the phase that edge starts.
declare function benchStepBoundary(
  edge: "begin" | "end",
  operation: string,
): Promise<string>;

const SAMPLE_INTERVAL_MS = 100;

let engine: PsiEngine | undefined;
let connection: MessageConnection | undefined;
let phase = "before the first operation";
let peakBytes = 0;
let samples = 0;
const peakBytesByPhase: Record<string, number> = {};

function sampleHeap(): void {
  const used = (
    performance as unknown as { memory: { usedJSHeapSize: number } }
  ).memory.usedJSHeapSize;
  samples++;
  peakBytes = Math.max(peakBytes, used);
  peakBytesByPhase[phase] = Math.max(peakBytesByPhase[phase] ?? 0, used);
}

// The engine the participant drives, with each operation marked to the bench.
function steppedEngine(inner: PsiEngine): PsiEngine {
  const step = async <T>(
    operation: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    sampleHeap();
    phase = await benchStepBoundary("begin", operation);
    try {
      return await run();
    } finally {
      sampleHeap();
      phase = await benchStepBoundary("end", operation);
    }
  };
  return {
    createServerSetup: (values) =>
      step("createServerSetup", () => inner.createServerSetup(values)),
    processClientRequest: (request) =>
      step("processClientRequest", () => inner.processClientRequest(request)),
    createClientRequest: (values) =>
      step("createClientRequest", () => inner.createClientRequest(values)),
    receiveServerSetup: (setup) =>
      step("receiveServerSetup", () => inner.receiveServerSetup(setup)),
    receiveServerSetupPiece: (piece) =>
      step("receiveServerSetupPiece", () =>
        inner.receiveServerSetupPiece(piece),
      ),
    completeServerSetup: () =>
      step("completeServerSetup", () => inner.completeServerSetup()),
    discardServerSetup: () => inner.discardServerSetup(),
    computeAssociationTable: (response) =>
      step("computeAssociationTable", () =>
        inner.computeAssociationTable(response),
      ),
    createPermutedSetup: (values) => inner.createPermutedSetup(values),
    receiveIndexTable: (table) => inner.receiveIndexTable(table),
    matchPermutedRound: (response) => inner.matchPermutedRound(response),
    finishPermutedCount: () => inner.finishPermutedCount(),
    observeProcessedElements: (report) =>
      inner.observeProcessedElements?.(report),
    stopInFlight: () => inner.stopInFlight?.() ?? false,
    dispose: () => inner.dispose(),
  };
}

const probe: MeasuredProbe = {
  makeEngine(side) {
    engine = steppedEngine(
      createBrowserPsiEngineFactory(
        (init) =>
          new Worker("/worker.js", {
            type: "module",
            name: encodePsiWorkerInit(init),
          }) as unknown as PsiCryptoWorker,
      )(side.role, side.id, side.mode),
    );
  },
  async connect(brokerPort, sharedSecret, sessionKey) {
    connection = await wrap(
      await dial(brokerPort, sharedSecret),
      sessionKey,
      "initiator",
    );
    setInterval(sampleHeap, SAMPLE_INTERVAL_MS);
  },
  async run(side, elements, overlap) {
    if (!engine || !connection)
      throw new Error("makeEngine and connect have not both run");
    return runRound(
      connection,
      engine,
      side,
      partyValues(elements, overlap, "browser"),
    );
  },
  pageMemory() {
    sampleHeap();
    return { peakBytes, peakBytesByPhase: { ...peakBytesByPhase }, samples };
  },
};

(
  globalThis as unknown as { measuredProbe: () => MeasuredProbe }
).measuredProbe = () => probe;
