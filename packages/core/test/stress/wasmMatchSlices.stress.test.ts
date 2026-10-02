import { execFileSync } from "node:child_process";
import { totalmem } from "node:os";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { chunkRangesOfSize, psiChunkRanges } from "../../src/psi/psiChunks";
import {
  WASM_PSI_MATCH_BUDGET_BYTES,
  WASM_PSI_MEMORY_MAX_BYTES,
  matchSetupSliceElements,
} from "../../src/psi/psiMatchSlices";

import type { PsiEngineMode } from "../../src/psi/psiEngine";
import type { MatchProbeResult } from "./wasmMatchSlices.probe";
import { stressMemory } from "./stressMemory";

// The joiner's WebAssembly match over a setup far past the size one call
// holds in the engine's 2 GiB of linear memory, run under the shipped budget
// (src/psi/psiMatchSlices.ts). Each run is its own process, so the engine
// memory and resident set it reports are its own. PSI_STRESS_MATCH_N sets the
// setup size (2^24 by default, the most the decode bound admits) and
// PSI_STRESS_MATCH_RESPONSE_N the response size; each slice decrypts the
// whole response it meets, so a larger response multiplies the run time. At
// the defaults one run takes tens of minutes, most of it building the
// starter's setup and passing each slice through the engine, so the probe's
// limit is PSI_STRESS_MATCH_TIMEOUT_MS, an hour by default.

const PROBE = fileURLToPath(
  new URL("./wasmMatchSlices.probe.ts", import.meta.url),
);
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const HEAP_MIB = Math.min(16_384, Math.floor(totalmem() / MIB) - 2_048);
const PROBE_TIMEOUT_MS = Number(
  process.env.PSI_STRESS_MATCH_TIMEOUT_MS ?? 3_600_000,
);
const SETUP_N = Number(process.env.PSI_STRESS_MATCH_N ?? 2 ** 24);
const RESPONSE_N = Number(process.env.PSI_STRESS_MATCH_RESPONSE_N ?? 2 ** 16);

function probe(
  mode: PsiEngineMode,
  setupElements: number,
  responseElements: number,
  sizing: "budget" | "slice",
  value: number,
): MatchProbeResult {
  let out: string;
  try {
    // A synchronous spawn blocks the event loop, so vitest's own test timeout
    // cannot fire while it runs; the spawn's timeout is the only bound.
    out = execFileSync(
      process.execPath,
      [
        `--max-old-space-size=${HEAP_MIB}`,
        "--expose-gc",
        "--import",
        "tsx",
        PROBE,
        mode,
        String(setupElements),
        String(responseElements),
        sizing,
        String(value),
      ],
      {
        encoding: "utf8",
        maxBuffer: 1 << 20,
        timeout: PROBE_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
    );
  } catch (error) {
    const { signal, code } = error as NodeJS.ErrnoException & {
      signal?: string;
    };
    const reason =
      code === "ETIMEDOUT"
        ? `did not finish within ${PROBE_TIMEOUT_MS} ms and was killed`
        : `failed${signal ? ` with ${signal}` : ""}`;
    throw new Error(
      `the ${mode} match of ${setupElements} by ${responseElements} ${reason}`,
      { cause: error },
    );
  }
  return JSON.parse(out.trim()) as MatchProbeResult;
}

const mib = (bytes: number): string => (bytes / MIB).toFixed(0);

function report(result: MatchProbeResult, slices: number): void {
  const rows = result.calls.map(
    (call, index) =>
      `  call ${index + 1}/${result.calls.length}: ${call.ms.toFixed(0)} ms ` +
      `(cpu ${call.cpuMs.toFixed(0)} ms), wasm ${mib(call.wasmBytes)} MiB, ` +
      `heapUsed ${mib(call.heapUsedBytes)} MiB, rss ${mib(call.rssBytes)} MiB`,
  );
  console.log(
    [
      `${result.mode} ${result.setupElements} x ${result.responseElements} ` +
        `(setup on ${result.setupBackend}), k=${slices}: ` +
        `match ${result.matchMs.toFixed(0)} ms, ` +
        `wasm ${mib(result.wasmBeforeMatchBytes)} -> ${mib(result.wasmMaxBytes)} MiB, ` +
        `rss before match ${mib(result.rssBeforeMatchBytes)} MiB, ` +
        `peak rss ${mib(result.maxRssBytes)} MiB`,
      ...rows,
    ].join("\n"),
  );
}

// The free memory a run needs before it spawns, rounded up from the measured
// 2^24 runs: about 12 GB peak resident, most of it the starter's setup build,
// and about 8 GB through the match.
function needGiB(setupElements: number): number {
  return Math.ceil((setupElements * 600) / GIB) + 2;
}

test.for(["identifier-revealing", "count-only"] as const)(
  `the %s match of ${SETUP_N} setup elements stays under the engine maximum`,
  { timeout: PROBE_TIMEOUT_MS + 60_000 },
  (mode, ctx) => {
    const memory = stressMemory();
    ctx.skip(
      memory.bytes / GIB < needGiB(SETUP_N),
      `needs ${needGiB(SETUP_N)} GiB; this host's ${memory.measure} is ` +
        `${(memory.bytes / GIB).toFixed(1)} GiB`,
    );
    const responseChunks =
      mode === "count-only" ? 1 : psiChunkRanges(RESPONSE_N).length;
    const perCall =
      mode === "count-only"
        ? RESPONSE_N
        : Math.max(
            ...psiChunkRanges(RESPONSE_N).map(
              (range) => range.end - range.start,
            ),
          );
    const sliceElements = matchSetupSliceElements(
      perCall,
      WASM_PSI_MATCH_BUDGET_BYTES,
    );
    const slices =
      sliceElements >= SETUP_N
        ? 1
        : chunkRangesOfSize(SETUP_N, sliceElements).length;

    const result = probe(
      mode,
      SETUP_N,
      RESPONSE_N,
      "budget",
      WASM_PSI_MATCH_BUDGET_BYTES,
    );
    report(result, slices);

    expect(result.matchesExpected).toBe(true);
    expect(result.calls).toHaveLength(slices * responseChunks);
    expect(result.wasmMaxBytes).toBeGreaterThan(0);
    expect(result.wasmMaxBytes).toBeLessThanOrEqual(WASM_PSI_MEMORY_MAX_BYTES);
  },
);

// Whether the engine decrypts the whole response on every match call, or
// only once, decides what a sliced match costs; it is read off the engine by
// timing one setup matched in one slice and in two against one response.
// Processor time rather than wall time, so a loaded host does not skew it.
test(
  "every match call decrypts the whole response it is handed",
  { timeout: PROBE_TIMEOUT_MS + 60_000 },
  () => {
    const setup = 16_384;
    const response = 32_768;
    const cpu = (result: MatchProbeResult): number =>
      result.calls.reduce((total, call) => total + call.cpuMs, 0);
    const one = probe("count-only", setup, response, "slice", setup);
    const two = probe("count-only", setup, response, "slice", setup / 2);
    report(one, 1);
    report(two, 2);
    expect(one.calls).toHaveLength(1);
    expect(two.calls).toHaveLength(2);
    expect(one.matchesExpected && two.matchesExpected).toBe(true);
    // The setup is a small share of the work, so a second pass over the
    // response nearly doubles it; one pass would leave it about level.
    expect(cpu(two)).toBeGreaterThan(1.6 * cpu(one));
  },
);
