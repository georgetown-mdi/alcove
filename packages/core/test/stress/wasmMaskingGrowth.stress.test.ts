import { execFile } from "node:child_process";
import { totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { beforeAll, expect, test } from "vitest";

import { WASM_MASKING_BYTES_PER_ELEMENT } from "../../src/psi/psiMatchSlices";

import type { WasmMaskingOperation } from "../../src/psi/psiMatchSlices";
import type { MaskingProbeResult } from "./wasmMaskingGrowth.probe";

// The WebAssembly engine's linear-memory growth for one masking call, per
// element it is handed, against the figure the engine sizes its masking
// chunks by (src/psi/psiMatchSlices.ts). Each call runs in its own process at
// each size in PSI_STRESS_MASKING_SIZES (2^20 by default), all at once. At
// 2^20 a call took 11 to 20 minutes on a hosted 4-vCPU runner shared by six
// calls, so the cases share one limit, PSI_STRESS_MASKING_TIMEOUT_MS.

const PROBE = fileURLToPath(
  new URL("./wasmMaskingGrowth.probe.ts", import.meta.url),
);
const MIB = 1024 * 1024;
const HEAP_MIB = Math.min(8_192, Math.floor(totalmem() / MIB / 4));
const PROBE_TIMEOUT_MS = Number(
  process.env.PSI_STRESS_MASKING_TIMEOUT_MS ?? 1_800_000,
);
const SIZES = (process.env.PSI_STRESS_MASKING_SIZES ?? "1048576")
  .split(",")
  .map(Number);
const OPERATIONS: ReadonlyArray<WasmMaskingOperation> = [
  "createSetupMessage",
  "createRequest",
  "processRequest",
];

async function probe(
  operation: WasmMaskingOperation,
  elements: number,
): Promise<MaskingProbeResult> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      `--max-old-space-size=${HEAP_MIB}`,
      "--import",
      "tsx",
      PROBE,
      operation,
      String(elements),
    ],
    {
      encoding: "utf8",
      maxBuffer: 1 << 20,
      timeout: PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  return JSON.parse(stdout.trim()) as MaskingProbeResult;
}

let results: ReadonlyArray<MaskingProbeResult> = [];

beforeAll(async () => {
  results = await Promise.all(
    OPERATIONS.flatMap((operation) =>
      SIZES.map((elements) => probe(operation, elements)),
    ),
  );
}, PROBE_TIMEOUT_MS + 60_000);

const perElement = (bytes: number, result: MaskingProbeResult): number =>
  (bytes - result.wasmBeforeBytes) / result.elements;

test.for(OPERATIONS)(
  "%s grows the engine's memory by no more than its stated figure an element",
  { timeout: PROBE_TIMEOUT_MS + 60_000 },
  (operation) => {
    for (const result of results.filter(
      (each) => each.operation === operation,
    )) {
      const below = perElement(result.wasmBeforeLastGrowthBytes, result);
      const above = perElement(result.wasmAfterBytes, result);
      console.log(
        `${operation} of ${result.elements}: ${result.ms.toFixed(0)} ms, ` +
          `${below.toFixed(0)} to ${above.toFixed(0)} bytes an element ` +
          `(wasm ${(result.wasmBeforeBytes / MIB).toFixed(0)} -> ` +
          `${(result.wasmAfterBytes / MIB).toFixed(0)} MiB)`,
      );
      // The call needed more than the length before its last growth, so a
      // figure below that is one the engine has outgrown.
      expect(below).toBeLessThanOrEqual(
        WASM_MASKING_BYTES_PER_ELEMENT[operation],
      );
    }
  },
);
