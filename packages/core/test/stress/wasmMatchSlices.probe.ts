// One joiner match on the WebAssembly engine, run in its own process so the
// engine's linear memory and the resident set it reports are its own:
// `wasmMatchSlices.stress.test.ts` spawns it once per case and reads the one
// JSON line it prints.
//
// Usage: node --max-old-space-size=<MiB> --import tsx wasmMatchSlices.probe.ts
//          <identifier-revealing|count-only> <setupElements> <responseElements>
//          <budget|slice> <bytes or elements>
//
// `budget` runs the match under that many bytes of engine memory, as a shipped
// WebAssembly worker does; `slice` forces that setup slice size instead.

import { performance } from "node:perf_hooks";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { InProcessPsiEngine } from "../../src/psi/psiEngine";
import { loadNativeAddonOrSkip } from "../utils/nativeAddon";

import type {
  InProcessPsiEngineOptions,
  PsiEngineMode,
} from "../../src/psi/psiEngine";

export interface MatchCall {
  readonly ms: number;
  readonly cpuMs: number;
  readonly wasmBytes: number;
  readonly heapUsedBytes: number;
  readonly rssBytes: number;
}

export interface MatchProbeResult {
  readonly mode: PsiEngineMode;
  readonly setupElements: number;
  readonly responseElements: number;
  readonly setupBackend: "native" | "wasm";
  readonly calls: ReadonlyArray<MatchCall>;
  readonly matchMs: number;
  readonly rssBeforeMatchBytes: number;
  readonly wasmBeforeMatchBytes: number;
  readonly wasmMaxBytes: number;
  readonly maxRssBytes: number;
  readonly matchesExpected: boolean;
}

let wasmMemory: WebAssembly.Memory | undefined;

const probeStarted = performance.now();

// Progress on stderr, so a run killed at its timeout still shows how far it
// got; stdout carries the one result line.
function phase(name: string): void {
  process.stderr.write(
    `${((performance.now() - probeStarted) / 1000).toFixed(1)} s ${name}\n`,
  );
}

// The engine's linear memory is an export of the instance the module creates,
// so it is caught as the module instantiates; it only grows, so its length
// after a call is the high-water mark up to that call.
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

function wasmBytes(): number {
  return wasmMemory?.buffer.byteLength ?? 0;
}

// `library` whose client records the wall time and the memory figures of
// every match call the engine makes.
function timedClientLibrary(
  library: PSILibrary,
  calls: Array<MatchCall>,
): PSILibrary {
  const client = library.client!;
  const time =
    <A extends Array<unknown>, R>(call: (...args: A) => R) =>
    (...args: A): R => {
      const started = performance.now();
      const cpuStarted = process.cpuUsage();
      const result = call(...args);
      const cpu = process.cpuUsage(cpuStarted);
      const memory = process.memoryUsage();
      const record: MatchCall = {
        ms: performance.now() - started,
        cpuMs: (cpu.user + cpu.system) / 1000,
        wasmBytes: wasmBytes(),
        heapUsedBytes: memory.heapUsed,
        rssBytes: memory.rss,
      };
      calls.push(record);
      phase(`match call ${calls.length} ${JSON.stringify(record)}`);
      return result;
    };
  return {
    ...library,
    client: {
      ...client,
      createWithNewKey: (revealIntersection?: boolean) => {
        const inner = client.createWithNewKey(revealIntersection);
        return new Proxy(inner, {
          get(target, property) {
            const value = Reflect.get(target, property) as unknown;
            if (
              property === "getAssociationTable" ||
              property === "getIntersectionSize"
            )
              return time(
                (value as (...args: unknown[]) => unknown).bind(target),
              );
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    },
  };
}

async function main(): Promise<void> {
  const [modeArg, setupArg, responseArg, sizing, sizingArg] =
    process.argv.slice(2);
  const mode = modeArg as PsiEngineMode;
  const setupElements = Number(setupArg);
  const responseElements = Number(responseArg);
  const revealsIdentifiers = mode === "identifier-revealing";
  const options: InProcessPsiEngineOptions =
    sizing === "budget"
      ? { matchMemoryBudgetBytes: Number(sizingArg) }
      : { setupSliceElements: Number(sizingArg) };

  installWasmMemoryProbe();
  const { default: loadWasm } = await import("@openmined/psi.js");
  const wasm = await loadWasm();
  const native = await loadNativeAddonOrSkip();
  const setupLibrary = native ?? wasm;

  const overlap = Math.min(1_000, setupElements, responseElements);
  const clientValues = Array.from({ length: responseElements }, (_, i) =>
    i < overlap ? `shared-${i}` : `c-${i}`,
  );

  // The starter's setup is built on its shipped path; only the overlap's
  // sorted positions are kept, so the joiner's figures below are not carried
  // on the starter's input.
  const starter = new InProcessPsiEngine(
    setupLibrary,
    "starter",
    "starter",
    mode,
  );
  const calls: Array<MatchCall> = [];
  const joiner = new InProcessPsiEngine(
    timedClientLibrary(wasm, calls),
    "joiner",
    "joiner",
    mode,
    options,
  );
  let matchesExpected: boolean;
  let matchMs: number;
  let rssBeforeMatchBytes: number;
  let wasmBeforeMatchBytes: number;
  try {
    const sharedPosition = new Int32Array(overlap);
    let setupBytes: Uint8Array;
    phase("building the setup");
    {
      const { setup, permutation } = await starter.createServerSetup(
        Array.from({ length: setupElements }, (_, i) =>
          i < overlap ? `shared-${i}` : `s-${i}`,
        ),
      );
      setupBytes = setup;
      permutation.forEach((input, position) => {
        if (input < overlap) sharedPosition[input] = position;
      });
    }
    phase("building the request and response");
    const responseBytes = await starter.processClientRequest(
      await joiner.createClientRequest(clientValues),
    );
    starter.dispose();
    (globalThis as { gc?: () => void }).gc?.();
    phase("decoding the setup");
    await joiner.receiveServerSetup(setupBytes);
    phase("matching");
    rssBeforeMatchBytes = process.memoryUsage().rss;
    wasmBeforeMatchBytes = wasmBytes();
    const started = performance.now();
    if (revealsIdentifiers) {
      const [local, partner] =
        await joiner.computeAssociationTable(responseBytes);
      matchMs = performance.now() - started;
      const expected = Array.from(sharedPosition, (position, input) => [
        input,
        position,
      ]).sort((a, b) => a[1]! - b[1]!);
      matchesExpected =
        local.length === overlap &&
        expected.every(
          ([localIndex, partnerIndex], index) =>
            local[index] === localIndex && partner[index] === partnerIndex,
        );
    } else {
      const size = await joiner.computeIntersectionCardinality(responseBytes);
      matchMs = performance.now() - started;
      matchesExpected = size === overlap;
    }
  } finally {
    starter.dispose();
    joiner.dispose();
  }

  const result: MatchProbeResult = {
    mode,
    setupElements,
    responseElements,
    setupBackend: native ? "native" : "wasm",
    calls,
    matchMs,
    rssBeforeMatchBytes,
    wasmBeforeMatchBytes,
    wasmMaxBytes: wasmBytes(),
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
    matchesExpected,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

await main();
