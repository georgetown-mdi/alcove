// One masking call on the WebAssembly engine, run in its own process so the
// engine's linear memory it reports is that call's alone:
// `wasmMaskingGrowth.stress.test.ts` spawns it once per case and reads the
// one JSON line it prints.
//
// Usage: node --max-old-space-size=<MiB> --import tsx wasmMaskingGrowth.probe.ts
//          <createSetupMessage|createRequest|processRequest> <elements>
//
// processRequest's request is built on the native addon where one ships, so
// building it leaves the WebAssembly engine's memory where it started.

import { performance } from "node:perf_hooks";

import { loadNativeAddonOrSkip } from "../utils/nativeAddon";

import type { WasmMaskingOperation } from "../../src/psi/psiMatchSlices";

export interface MaskingProbeResult {
  readonly operation: WasmMaskingOperation;
  readonly elements: number;
  readonly requestBackend: "native" | "wasm" | "none";
  readonly wasmBeforeBytes: number;
  readonly wasmAfterBytes: number;
  readonly wasmBeforeLastGrowthBytes: number;
  readonly ms: number;
}

let wasmMemory: WebAssembly.Memory | undefined;
let beforeLastGrowth = 0;

// The engine's linear memory is an export of the instance the module creates,
// so it is caught as the module instantiates; it only grows, so its length
// after the call is the call's high-water mark.
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

// The engine grows its memory past what a call asks for, by up to 96 MiB, so
// the length after a call overstates what the call needed, and the length
// before its last growth is below it: the two bound the call's need.
function installWasmGrowthProbe(): void {
  const grow = WebAssembly.Memory.prototype.grow;
  WebAssembly.Memory.prototype.grow = function (
    this: WebAssembly.Memory,
    delta: number,
  ): number {
    beforeLastGrowth = this.buffer.byteLength;
    return grow.call(this, delta);
  };
}

function wasmBytes(): number {
  return wasmMemory?.buffer.byteLength ?? 0;
}

async function main(): Promise<void> {
  const [operationArg, elementsArg] = process.argv.slice(2);
  const operation = operationArg as WasmMaskingOperation;
  const elements = Number(elementsArg);

  installWasmMemoryProbe();
  installWasmGrowthProbe();
  const { default: loadWasm } = await import("@openmined/psi.js");
  const wasm = await loadWasm();
  const values = Array.from({ length: elements }, (_, i) => `v-${i}`);

  const server = wasm.server!.createWithNewKey(true);
  const client = wasm.client!.createWithNewKey(true);
  let requestBackend: MaskingProbeResult["requestBackend"] = "none";
  let request: ReturnType<typeof client.createRequest> | undefined;
  if (operation === "processRequest") {
    const native = await loadNativeAddonOrSkip();
    const builder = (native ?? wasm).client!.createWithNewKey(true);
    request = wasm.request.deserializeBinary(
      builder.createRequest(values).serializeBinary(),
    );
    builder.delete();
    requestBackend = native ? "native" : "wasm";
  }

  const wasmBeforeBytes = wasmBytes();
  beforeLastGrowth = wasmBeforeBytes;
  const started = performance.now();
  if (operation === "createSetupMessage")
    server.createSetupMessage(0, -1, values, wasm.dataStructure.Raw, []);
  else if (operation === "createRequest") client.createRequest(values);
  else server.processRequest(request!);
  const ms = performance.now() - started;
  const wasmAfterBytes = wasmBytes();
  server.delete();
  client.delete();

  const result: MaskingProbeResult = {
    operation,
    elements,
    requestBackend,
    wasmBeforeBytes,
    wasmAfterBytes,
    wasmBeforeLastGrowthBytes: beforeLastGrowth,
    ms,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

await main();
