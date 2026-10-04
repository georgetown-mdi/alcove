// One same-size PSI round with each party on the WebAssembly engine in its own
// worker thread, as a browser party runs it, run in its own process:
// `psiRoundWalls.stress.test.ts` spawns it once per size and reads the one
// JSON line it prints. Each operation reports its wall time, the worker's V8
// heap before it, at its peak and after it, and the engine's linear memory
// before and after it; a worker that dies ends the round there, and the line
// names the operation and the error.
//
// Usage: node --expose-gc --import tsx psiRoundWalls.probe.ts
//          <identifier-revealing|count-only> <elements>
//
// The starter's worker is stopped once it has built the response, so the
// joiner's match runs with only its own worker alive, as in a browser tab.

import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { GCProfiler, getHeapStatistics } from "node:v8";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";

import { InProcessPsiEngine } from "../../src/psi/psiEngine";
import { psiEngineOptionsForBackend } from "../../src/psi/psiMatchSlices";

import type { PsiEngineMode } from "../../src/psi/psiEngine";

/** One engine operation's figures, from the worker that ran it. */
export interface WallsOperation {
  readonly party: "starter" | "joiner";
  readonly operation: string;
  readonly ms: number;
  readonly heapBeforeBytes: number;
  readonly heapPeakBytes: number;
  readonly heapAfterBytes: number;
  readonly heapLimitBytes: number;
  readonly wasmBeforeBytes: number;
  readonly wasmAfterBytes: number;
}

/** The round's figures, printed as one JSON line. */
export interface WallsProbeResult {
  readonly mode: PsiEngineMode;
  readonly elements: number;
  readonly overlap: number;
  readonly operations: ReadonlyArray<WallsOperation>;
  readonly failure?: { readonly operation: string; readonly error: string };
  readonly matchesExpected: boolean;
  readonly maxRssBytes: number;
}

interface PartyInit {
  readonly party: "starter" | "joiner";
  readonly mode: PsiEngineMode;
  readonly elements: number;
  readonly overlap: number;
}

interface Request {
  readonly operation: string;
  readonly bytes?: Uint8Array;
}

interface Reply {
  readonly figures: WallsOperation;
  readonly bytes?: Uint8Array;
  readonly matched?: boolean;
  readonly sharedPositions?: Array<number>;
  readonly pairs?: [Array<number>, Array<number>];
  readonly error?: string;
}

const gc = (): void => (globalThis as { gc?: () => void }).gc?.();

function heapUsed(): number {
  return getHeapStatistics().used_heap_size;
}

// The engine's linear memory is an export of the instance the module creates,
// so it is caught as the module instantiates; it only grows, so its length
// after an operation is the high-water mark up to it.
let wasmMemory: WebAssembly.Memory | undefined;
function installWasmMemoryProbe(): void {
  const capture = <T>(result: T): T => {
    const instance =
      (result as { instance?: WebAssembly.Instance }).instance ??
      (result as WebAssembly.Instance);
    for (const value of Object.values(instance.exports ?? {}))
      if (value instanceof WebAssembly.Memory) {
        wasmMemory ??= value;
        break;
      }
    return result;
  };
  const instantiate = WebAssembly.instantiate.bind(WebAssembly);
  WebAssembly.instantiate = ((...args: Parameters<typeof instantiate>) =>
    instantiate(...args).then(capture)) as typeof WebAssembly.instantiate;
}

function partyValues(init: PartyInit): Array<string> {
  return Array.from({ length: init.elements }, (_, index) =>
    index < init.overlap ? `shared-${index}` : `${init.party}-${index}`,
  );
}

async function runParty(init: PartyInit): Promise<void> {
  installWasmMemoryProbe();
  const { default: loadWasm } = await import("@openmined/psi.js");
  const engine = new InProcessPsiEngine(
    await loadWasm(),
    init.party,
    init.party,
    init.mode,
    psiEngineOptionsForBackend("wasm"),
  );
  const port = parentPort!;
  port.on("message", (request: Request) => {
    void (async () => {
      gc();
      const heapBeforeBytes = heapUsed();
      const wasmBeforeBytes = wasmMemory?.buffer.byteLength ?? 0;
      // V8 reports the heap in use as each collection starts, which is where
      // the heap stands highest between collections.
      const profiler = new GCProfiler();
      profiler.start();
      const started = performance.now();
      let reply: Omit<Reply, "figures"> = {};
      try {
        reply = await operate(request);
      } catch (error) {
        reply = { error: String(error) };
      }
      const ms = performance.now() - started;
      const endBytes = heapUsed();
      const collections = profiler.stop()?.statistics ?? [];
      gc();
      const figures: WallsOperation = {
        party: init.party,
        operation: request.operation,
        ms,
        heapBeforeBytes,
        heapPeakBytes: Math.max(
          endBytes,
          ...collections.map((c) => c.beforeGC.heapStatistics.usedHeapSize),
        ),
        heapAfterBytes: heapUsed(),
        heapLimitBytes: getHeapStatistics().heap_size_limit,
        wasmBeforeBytes,
        wasmAfterBytes: wasmMemory?.buffer.byteLength ?? 0,
      };
      port.postMessage({ ...reply, figures } satisfies Reply);
    })();
  });

  async function operate(request: Request): Promise<Omit<Reply, "figures">> {
    switch (request.operation) {
      case "createServerSetup": {
        const built = await engine.createServerSetup(partyValues(init));
        const sharedPositions: Array<number> = [];
        built.permutation.forEach((input, position) => {
          if (input < init.overlap) sharedPositions[input] = position;
        });
        return { bytes: built.setup, sharedPositions };
      }
      case "createClientRequest":
        return { bytes: await engine.createClientRequest(partyValues(init)) };
      case "processClientRequest":
        return { bytes: await engine.processClientRequest(request.bytes!) };
      case "receiveServerSetup":
        await engine.receiveServerSetup(request.bytes!);
        return {};
      case "computeIntersectionCardinality":
        return {
          matched:
            (await engine.computeIntersectionCardinality(request.bytes!)) ===
            init.overlap,
        };
      case "computeAssociationTable": {
        const [local, partner] = await engine.computeAssociationTable(
          request.bytes!,
        );
        return { pairs: [local, partner] };
      }
      default:
        throw new Error(`no operation ${request.operation}`);
    }
  }
}

class Party {
  readonly operations: Array<WallsOperation> = [];
  private readonly worker: Worker;
  private settle?: (reply: Reply | Error) => void;

  constructor(init: PartyInit) {
    this.worker = new Worker(fileURLToPath(import.meta.url), {
      workerData: init,
    });
    this.worker.on("message", (reply: Reply) => this.settle?.(reply));
    this.worker.on("error", (error: Error) => this.settle?.(error));
    this.worker.on("exit", (code) =>
      this.settle?.(new Error(`the worker exited with code ${code}`)),
    );
  }

  async run(operation: string, bytes?: Uint8Array): Promise<Reply> {
    const reply = await new Promise<Reply | Error>((resolve) => {
      this.settle = resolve;
      this.worker.postMessage({ operation, bytes } satisfies Request);
    });
    this.settle = undefined;
    if (reply instanceof Error) {
      const code = (reply as NodeJS.ErrnoException).code;
      throw new Error(code ? `${code}: ${reply.message}` : reply.message);
    }
    this.operations.push(reply.figures);
    if (reply.error !== undefined) throw new Error(reply.error);
    return reply;
  }

  async stop(): Promise<void> {
    this.settle = undefined;
    await this.worker.terminate();
  }
}

async function main(): Promise<void> {
  const [modeArg, elementsArg] = process.argv.slice(2);
  const mode = modeArg as PsiEngineMode;
  const elements = Number(elementsArg);
  const overlap = Math.min(1_000, elements);
  const starter = new Party({ party: "starter", mode, elements, overlap });
  const joiner = new Party({ party: "joiner", mode, elements, overlap });
  let current = "createServerSetup";
  let failure: WallsProbeResult["failure"];
  let matchesExpected = false;
  const step = async (
    party: Party,
    operation: string,
    bytes?: Uint8Array,
  ): Promise<Reply> => {
    current = operation;
    process.stderr.write(`${new Date().toISOString()} ${operation}\n`);
    return party.run(operation, bytes);
  };
  try {
    const setup = await step(starter, "createServerSetup");
    const request = await step(joiner, "createClientRequest");
    const response = await step(starter, "processClientRequest", request.bytes);
    await starter.stop();
    await step(joiner, "receiveServerSetup", setup.bytes);
    if (mode === "count-only") {
      const result = await step(
        joiner,
        "computeIntersectionCardinality",
        response.bytes,
      );
      matchesExpected = result.matched === true;
    } else {
      const result = await step(
        joiner,
        "computeAssociationTable",
        response.bytes,
      );
      const [local, partner] = result.pairs!;
      matchesExpected =
        local.length === overlap &&
        local.every(
          (input, pair) =>
            input < overlap && setup.sharedPositions![input] === partner[pair],
        );
    }
  } catch (error) {
    failure = { operation: current, error: String(error).slice(0, 2_000) };
  } finally {
    await starter.stop();
    await joiner.stop();
  }
  const result: WallsProbeResult = {
    mode,
    elements,
    overlap,
    operations: [...starter.operations, ...joiner.operations].sort(
      (a, b) => ORDER.indexOf(a.operation) - ORDER.indexOf(b.operation),
    ),
    ...(failure === undefined ? {} : { failure }),
    matchesExpected,
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const ORDER = [
  "createServerSetup",
  "createClientRequest",
  "processClientRequest",
  "receiveServerSetup",
  "computeAssociationTable",
  "computeIntersectionCardinality",
];

if (isMainThread) await main();
else await runParty(workerData as PartyInit);
