import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { MAX_PSI_DECODE_ELEMENTS } from "../../src/connection/frameSize";
import { WASM_PSI_MEMORY_MAX_BYTES } from "../../src/psi/psiWasmBudget";

import type { PsiEngineMode } from "../../src/psi/psiEngine";
import type {
  GenerateProbeResult,
  MatchProbeResult,
} from "./streamedMatchLarge.probe";
import { stressMemory } from "./stressMemory";

// The joiner's streamed match on the WebAssembly engine at the per-set
// maximum: a setup and a response of PSI_STRESS_STREAMED_MATCH_N elements
// each (2^24 by default), all but 1,024 of them shared, in
// PSI_STRESS_STREAMED_MATCH_MODE (identifier-revealing by default, the mode
// whose pairs add to the engine's memory). The round is built on the native
// addon in one process and matched in another, so the match's figures are
// its own. The engine's fork measured this match at 2^24 at 99 min on a
// 10-CPU arm64 host; psiRoundWalls puts a hosted runner's WebAssembly engine
// about 1.4 times slower than the development container, so the match is
// expected near 145 min there. Each probe's limit is below.

const PROBE = fileURLToPath(
  new URL("./streamedMatchLarge.probe.ts", import.meta.url),
);
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const HEAP_MIB = Math.min(16_384, Math.floor(totalmem() / MIB) - 2_048);
// Building the round at 2^24 is three native operations of 2^24 elements;
// the setup alone took most of a 16 to 22 minute run on a hosted runner.
const GENERATE_TIMEOUT_MS = 75 * 60_000;
const MATCH_TIMEOUT_MS = Number(
  process.env.PSI_STRESS_STREAMED_MATCH_TIMEOUT_MS ?? 210 * 60_000,
);
const ELEMENTS = Number(
  process.env.PSI_STRESS_STREAMED_MATCH_N ?? MAX_PSI_DECODE_ELEMENTS,
);
const OVERLAP = ELEMENTS - Math.min(1_024, Math.floor(ELEMENTS / 2));
const MODE = (process.env.PSI_STRESS_STREAMED_MATCH_MODE ??
  "identifier-revealing") as PsiEngineMode;

// Building the setup peaks the process at 768 bytes an element, measured at
// 2^21 in the development container; the match needs far less.
function needBytes(elements: number): number {
  return Math.ceil((elements * 768) / GIB) * GIB + GIB;
}

function probe(
  step: "generate" | "match",
  directory: string,
  overlap: number,
): string {
  const timeout = step === "generate" ? GENERATE_TIMEOUT_MS : MATCH_TIMEOUT_MS;
  try {
    // A synchronous spawn blocks the event loop, so vitest's own test
    // timeout cannot fire while it runs; the spawn's timeout is the only
    // bound.
    return execFileSync(
      process.execPath,
      [
        ...(step === "generate" ? [`--max-old-space-size=${HEAP_MIB}`] : []),
        "--expose-gc",
        "--import",
        "tsx",
        PROBE,
        step,
        MODE,
        String(ELEMENTS),
        String(overlap),
        directory,
      ],
      {
        encoding: "utf8",
        maxBuffer: 1 << 20,
        timeout,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
  } catch (error) {
    const { signal, code } = error as NodeJS.ErrnoException & {
      signal?: string;
    };
    const reason =
      code === "ETIMEDOUT"
        ? `did not finish within ${timeout} ms and was killed`
        : `failed${signal ? ` with ${signal}` : ""}`;
    throw new Error(`the ${step} step at ${ELEMENTS} ${reason}`, {
      cause: error,
    });
  }
}

const mib = (bytes: number): string => (bytes / MIB).toFixed(0);
const minutes = (ms: number): string => (ms / 60_000).toFixed(1);

function report(built: GenerateProbeResult, result: MatchProbeResult): void {
  console.log(
    [
      `${result.mode} streamed match of ${result.elements} by ` +
        `${result.elements}, ${result.overlap} shared: ` +
        `matches expected ${result.matchesExpected}`,
      `  built on ${built.backend}: setup ${minutes(built.setupMs)} min, ` +
        `request ${minutes(built.requestMs)} min, ` +
        `response ${minutes(built.responseMs)} min, ` +
        `peak rss ${mib(built.maxRssBytes)} MiB`,
      `  setup in ${result.setupPieces} pieces: ` +
        `${(result.setupMs / 1000).toFixed(1)} s, ` +
        `wasm ${mib(result.wasmStartBytes)} -> ` +
        `${mib(result.wasmAfterSetupBytes)} MiB`,
      `  match: ${minutes(result.matchMs)} min, ` +
        `${((result.elements / result.matchMs) * 1000).toFixed(0)} ` +
        `elements a second, wasm peak ${mib(result.wasmPeakBytes)} MiB ` +
        `(${result.wasmPeakBytes} bytes)`,
      `  heap peak ${mib(result.heapPeakBytes)} MiB of ` +
        `${mib(result.heapLimitBytes)}, peak rss ${mib(result.maxRssBytes)} MiB`,
    ].join("\n"),
  );
}

test(
  `the ${MODE} streamed match of ${ELEMENTS} by ${ELEMENTS} finds the shared values`,
  { timeout: GENERATE_TIMEOUT_MS + MATCH_TIMEOUT_MS + 60_000 },
  (ctx) => {
    const memory = stressMemory();
    ctx.skip(
      memory.bytes < needBytes(ELEMENTS),
      `needs ${(needBytes(ELEMENTS) / GIB).toFixed(0)} GiB; this host's ` +
        `${memory.measure} is ${(memory.bytes / GIB).toFixed(1)} GiB`,
    );
    const directory = mkdtempSync(join(tmpdir(), "alcove-streamed-match-"));
    try {
      const built = JSON.parse(
        probe("generate", directory, OVERLAP),
      ) as GenerateProbeResult;
      const result = JSON.parse(
        probe("match", directory, OVERLAP),
      ) as MatchProbeResult;
      report(built, result);
      expect(result.matchesExpected).toBe(true);
      expect(result.wasmPeakBytes).toBeLessThanOrEqual(
        WASM_PSI_MEMORY_MAX_BYTES,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
