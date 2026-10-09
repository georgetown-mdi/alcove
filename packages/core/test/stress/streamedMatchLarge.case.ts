import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { MAX_PSI_DECODE_ELEMENTS } from "../../src/connection/frameSize";
import { WASM_PSI_MEMORY_MAX_BYTES } from "../../src/psi/psiWasmBudget";
import { loadNativeAddonOrSkip } from "../utils/nativeAddon";

import { stressMemory } from "./stressMemory";

import type { PsiEngineMode } from "../../src/psi/psiEngine";
import type {
  GenerateProbeResult,
  MatchBackend,
  MatchProbeResult,
} from "./streamedMatchLarge.probe";

// The joiner's streamed match at the per-set maximum, shared by the
// WebAssembly and native-addon stress files: a setup and a response of
// PSI_STRESS_STREAMED_MATCH_N elements each (2^24 by default), all but 1,024
// of them shared, in PSI_STRESS_STREAMED_MATCH_MODE (identifier-revealing by
// default, the mode whose pairs add to the engine's memory).
// PSI_STRESS_STREAMED_MATCH_TIMEOUT_MS overrides the running file's match
// limit. The round is built on the native addon in one process and matched
// in another, so the match's figures are its own.

const PROBE = fileURLToPath(
  new URL("./streamedMatchLarge.probe.ts", import.meta.url),
);
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const HEAP_MIB = Math.min(16_384, Math.floor(totalmem() / MIB) - 2_048);

// Satisfying Record<PsiEngineMode, ...> makes the compiler reject a missing
// or an extra mode, so the accepted set follows the engine's type.
const ENGINE_MODES = {
  "identifier-revealing": true,
  "count-only": true,
} as const satisfies Record<PsiEngineMode, true>;

const ENGINE_NAMES = {
  wasm: "the WebAssembly engine",
  native: "the native addon",
} as const satisfies Record<MatchBackend, string>;

function isEngineMode(value: string): value is PsiEngineMode {
  return Object.hasOwn(ENGINE_MODES, value);
}

function positiveIntegerFromEnvironment(
  name: string,
  fallback: number,
): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(value))
    throw new Error(
      `${name} is "${raw}"; set it to a positive whole number in decimal ` +
        `digits, or leave it unset for ${fallback}`,
    );
  return value;
}

function modeFromEnvironment(name: string): PsiEngineMode {
  const raw = process.env[name] ?? "identifier-revealing";
  if (!isEngineMode(raw))
    throw new Error(
      `${name} is "${raw}"; set it to ` +
        `${Object.keys(ENGINE_MODES).join(" or ")}, or leave it unset for ` +
        `identifier-revealing`,
    );
  return raw;
}

// Building the setup peaks the process at 768 bytes an element, measured at
// 2^21 in the development container; the match needs far less.
function needBytes(elements: number): number {
  return Math.ceil((elements * 768) / GIB) * GIB + GIB;
}

const mib = (bytes: number): string => (bytes / MIB).toFixed(0);
const minutes = (ms: number): string => (ms / 60_000).toFixed(1);

function report(built: GenerateProbeResult, result: MatchProbeResult): void {
  const { wasm } = result;
  console.log(
    [
      `${result.mode} streamed match on ${result.backend} of ` +
        `${result.elements} by ${result.elements}, ${result.overlap} shared: ` +
        `matches expected ${result.matchesExpected}`,
      `  built on ${built.backend}: setup ${minutes(built.setupMs)} min, ` +
        `request ${minutes(built.requestMs)} min, ` +
        `response ${minutes(built.responseMs)} min, ` +
        `peak rss ${mib(built.maxRssBytes)} MiB`,
      `  setup in ${result.setupPieces} pieces: ` +
        `${(result.setupMs / 1000).toFixed(1)} s, ` +
        `rss after it ${mib(result.rssAfterSetupBytes)} MiB` +
        (wasm
          ? `, wasm ${mib(wasm.startBytes)} -> ` +
            `${mib(wasm.afterSetupBytes)} MiB`
          : ""),
      `  match: ${minutes(result.matchMs)} min, ` +
        `${((result.elements / result.matchMs) * 1000).toFixed(0)} ` +
        `elements a second` +
        (wasm
          ? `, wasm peak ${mib(wasm.peakBytes)} MiB (${wasm.peakBytes} bytes)`
          : ""),
      `  heap peak ${mib(result.heapPeakBytes)} MiB of ` +
        `${mib(result.heapLimitBytes)}, peak rss ${mib(result.maxRssBytes)} MiB`,
    ].join("\n"),
  );
}

/** The engine a streamed-match stress file matches on, and its limits. */
export interface StreamedMatchLargeCase {
  readonly backend: MatchBackend;
  readonly generateTimeoutMs: number;
  /** The match limit when PSI_STRESS_STREAMED_MATCH_TIMEOUT_MS is unset. */
  readonly matchTimeoutMs: number;
}

/**
 * Registers the test that builds the round and matches it on
 * `options.backend`. It skips when the host has too little memory, and on
 * the native addon also when no addon ships for the platform.
 */
export function streamedMatchLargeTest(options: StreamedMatchLargeCase): void {
  const { backend, generateTimeoutMs } = options;
  const matchTimeoutMs = positiveIntegerFromEnvironment(
    "PSI_STRESS_STREAMED_MATCH_TIMEOUT_MS",
    options.matchTimeoutMs,
  );
  const elements = positiveIntegerFromEnvironment(
    "PSI_STRESS_STREAMED_MATCH_N",
    MAX_PSI_DECODE_ELEMENTS,
  );
  const overlap = elements - Math.min(1_024, Math.floor(elements / 2));
  const mode = modeFromEnvironment("PSI_STRESS_STREAMED_MATCH_MODE");

  function probe(
    step: "generate" | `match-${MatchBackend}`,
    directory: string,
  ) {
    const timeout = step === "generate" ? generateTimeoutMs : matchTimeoutMs;
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
          mode,
          String(elements),
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
      throw new Error(`the ${step} step at ${elements} ${reason}`, {
        cause: error,
      });
    }
  }

  test(
    `the ${mode} streamed match of ${elements} by ${elements} on ` +
      `${ENGINE_NAMES[backend]} finds the shared values`,
    { timeout: generateTimeoutMs + matchTimeoutMs + 60_000 },
    async (ctx) => {
      if (backend === "native")
        ctx.skip(
          (await loadNativeAddonOrSkip()) === undefined,
          "no native addon ships for this platform",
        );
      const memory = stressMemory();
      ctx.skip(
        memory.bytes < needBytes(elements),
        `needs ${(needBytes(elements) / GIB).toFixed(0)} GiB; this host's ` +
          `${memory.measure} is ${(memory.bytes / GIB).toFixed(1)} GiB`,
      );
      const directory = mkdtempSync(join(tmpdir(), "alcove-streamed-match-"));
      try {
        const built = JSON.parse(
          probe("generate", directory),
        ) as GenerateProbeResult;
        const result = JSON.parse(
          probe(`match-${backend}`, directory),
        ) as MatchProbeResult;
        report(built, result);
        expect(result.matchesExpected).toBe(true);
        if (backend === "wasm") {
          expect(result.wasm?.peakBytes).toBeGreaterThan(0);
          expect(result.wasm?.peakBytes).toBeLessThanOrEqual(
            WASM_PSI_MEMORY_MAX_BYTES,
          );
        } else {
          expect(built.backend).toBe("native");
          expect(result.wasm).toBeUndefined();
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
}
