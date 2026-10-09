import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { WASM_PSI_MEMORY_MAX_BYTES } from "../../src/psi/psiWasmBudget";

import type { PsiEngineMode } from "../../src/psi/psiEngine";
import type { WallsProbeResult } from "./psiRoundWalls.probe";
import { stressMemory } from "./stressMemory";

// A same-size round with both parties on the WebAssembly engine, each in its
// own worker thread at Node's default heap limit, as a browser tab runs its
// party: where each operation leaves the worker's V8 heap and the engine's
// linear memory, and which operation, if any, meets a limit first. Sizes are
// PSI_STRESS_WALLS_SIZES (2^22 and 2^23 by default), run one at a time, each
// only when the host has twice the memory the round is expected to need.
// A round at 2^22 took 2 h 44 min on a hosted 4-vCPU runner, so each has
// PSI_STRESS_WALLS_TIMEOUT_MS, four hours by default. A worker that dies at
// its heap limit fails the case once the figures up to it are printed.

const PROBE = fileURLToPath(
  new URL("./psiRoundWalls.probe.ts", import.meta.url),
);
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const PROBE_TIMEOUT_MS = Number(
  process.env.PSI_STRESS_WALLS_TIMEOUT_MS ?? 14_400_000,
);
const SIZES = (process.env.PSI_STRESS_WALLS_SIZES ?? "4194304,8388608")
  .split(",")
  .map(Number);
const MODE = (process.env.PSI_STRESS_WALLS_MODE ??
  "identifier-revealing") as PsiEngineMode;

// Estimated, not measured: both workers hold their engine's linear memory,
// which never shrinks, while the starter builds the response; 1,400 bytes an
// element rounds up the command-line joiner's measured 1,176
// (docs/spec/FILE_SYNC.md, The measured costs) for the second worker.
function expectedNeedBytes(elements: number): number {
  return 1_400 * elements + GIB;
}

function probe(elements: number): WallsProbeResult {
  // A synchronous spawn blocks the event loop, so vitest's own test timeout
  // cannot fire while it runs; the spawn's timeout is the only bound.
  const out = execFileSync(
    process.execPath,
    ["--expose-gc", "--import", "tsx", PROBE, MODE, String(elements)],
    {
      encoding: "utf8",
      maxBuffer: 1 << 20,
      timeout: PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  return JSON.parse(out.trim()) as WallsProbeResult;
}

const mib = (bytes: number): string => (bytes / MIB).toFixed(0);

function report(result: WallsProbeResult): void {
  console.log(
    [
      `${result.mode} round of ${result.elements} a side: ` +
        (result.failure
          ? `${result.failure.operation} failed: ${result.failure.error}`
          : `matches expected ${result.matchesExpected}`) +
        `, peak process RSS ${mib(result.maxRssBytes)} MiB`,
      ...result.operations.map(
        (each) =>
          `  ${each.party} ${each.operation}: ${(each.ms / 1000).toFixed(0)} s, ` +
          `heap ${mib(each.heapBeforeBytes)} -> peak ${mib(each.heapPeakBytes)} ` +
          `-> ${mib(each.heapAfterBytes)} MiB of ${mib(each.heapLimitBytes)}, ` +
          `wasm ${mib(each.wasmBeforeBytes)} -> ${mib(each.wasmAfterBytes)} MiB`,
      ),
    ].join("\n"),
  );
}

function expectInsideLimits(result: WallsProbeResult): void {
  if (result.failure)
    expect.fail(`${result.failure.operation} failed: ${result.failure.error}`);
  for (const each of result.operations)
    expect(each.wasmAfterBytes).toBeLessThanOrEqual(WASM_PSI_MEMORY_MAX_BYTES);
  expect(result.matchesExpected).toBe(true);
}

test.for(SIZES)(
  "a WebAssembly round of %i a side stays inside each worker's limits",
  { timeout: PROBE_TIMEOUT_MS + 60_000 },
  (elements, ctx) => {
    const memory = stressMemory();
    const needBytes = 2 * expectedNeedBytes(elements);
    ctx.skip(
      memory.bytes < needBytes,
      `needs ${(needBytes / GIB).toFixed(1)} GiB; this host's ${memory.measure} ` +
        `is ${(memory.bytes / GIB).toFixed(1)} GiB`,
    );
    const result = probe(elements);
    report(result);
    expectInsideLimits(result);
  },
);

// A real worker heap exhaustion is not cheap to reproduce, so the failed round
// here is a hand-built fixture.
test("a round in which a worker runs out of heap fails", () => {
  const ranOutOfHeap: WallsProbeResult = {
    mode: MODE,
    elements: 2 ** 23,
    overlap: 1_000,
    operations: [],
    failure: {
      operation: "createServerSetup",
      error:
        "Error: ERR_WORKER_OUT_OF_MEMORY: Worker terminated due to reaching " +
        "memory limit: JS heap out of memory",
    },
    matchesExpected: false,
    maxRssBytes: 0,
  };
  expect(() => expectInsideLimits(ranOutOfHeap)).toThrow(
    /^createServerSetup failed: .*ERR_WORKER_OUT_OF_MEMORY/,
  );
});
