import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { expect, test } from "vitest";

import {
  MAIN_THREAD_HEAP_BYTES_PER_RECORD,
  mainThreadHeapNeedBytes,
} from "../../src/inputHeapCheck";
import { PSI_HEAP_CEILING_MIB } from "../../src/psiMemoryBudget";

import type { MainThreadHeapProbeResult } from "./mainThreadHeap.probe";
import { stressMemory } from "./stressMemory";

// The main thread's heap check against the wall it guards: at Node's default
// heap, an input of the records the check admits is read, prepared and
// counted through the first round without running out of heap
// (docs/spec/FILE_SYNC.md, "The main thread's heap"). The probe runs in its
// own process, started with no heap option and NODE_OPTIONS cleared. About 13
// minutes and 4.4 GB resident on the measured host.

const PROBE = fileURLToPath(
  new URL("./mainThreadHeap.probe.ts", import.meta.url),
);
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const GIB = 2 ** 30;
const NEED_GIB = 5;
const PROBE_TIMEOUT_MS = 30 * 60_000;

test(
  "an input of the records the main thread's heap check admits completes at Node's default heap",
  { timeout: PROBE_TIMEOUT_MS + 60_000 },
  (ctx) => {
    const memory = stressMemory();
    ctx.skip(
      memory.bytes / GIB < NEED_GIB,
      `the run needs ${NEED_GIB} GiB; this host's ${memory.measure} is ` +
        `${(memory.bytes / GIB).toFixed(1)} GiB`,
    );
    const dir = mkdtempSync(join(tmpdir(), "alcove-main-heap-"));
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    let out: string;
    try {
      // A synchronous spawn blocks the event loop, so vitest's own test
      // timeout cannot fire while it runs; the spawn's timeout is the bound.
      out = execFileSync(
        process.execPath,
        ["--import", TSX, PROBE, join(dir, "input.csv")],
        {
          encoding: "utf8",
          env,
          maxBuffer: 1 << 20,
          timeout: PROBE_TIMEOUT_MS,
          killSignal: "SIGKILL",
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const result = JSON.parse(out.trim()) as MainThreadHeapProbeResult;
    console.log(
      `${result.rows} records at a heap limit of ${result.heapLimitBytes} ` +
        `bytes: peak heap ${result.peakHeapUsedBytes} bytes, peak RSS ` +
        `${result.peakRssBytes} bytes`,
    );

    expect(result.heapLimitBytes).toBeLessThan(PSI_HEAP_CEILING_MIB * 2 ** 20);
    expect(result.rows).toBe(
      Math.floor(result.heapLimitBytes / MAIN_THREAD_HEAP_BYTES_PER_RECORD),
    );
    expect(mainThreadHeapNeedBytes(result.rows + 1)).toBeGreaterThan(
      result.heapLimitBytes,
    );
    expect(result.firstRoundOneUnder).toBe("refused");
  },
);
