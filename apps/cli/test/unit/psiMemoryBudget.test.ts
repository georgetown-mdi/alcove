import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { UsageError } from "@alcove/core";

import {
  assessPsiMemory,
  checkPsiMemoryBudget,
  PSI_HEAP_CEILING_BYTES,
  PSI_HEAP_CEILING_MIB,
  PSI_ROUND_BYTES_PER_ELEMENT,
  PSI_ROUND_FIXED_BYTES,
  PSI_TARGET_ELEMENTS,
  psiMemoryStatement,
  psiRoundMemoryNeedBytes,
  readMemory,
  type MemoryReadings,
} from "../../src/psiMemoryBudget";
import { startPsiWorkerThread } from "../../src/psiWorkerHost";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const ENTRYPOINT = path.join(REPO_ROOT, "docker-entrypoint.sh");

let scratch: string | undefined;
afterEach(() => {
  if (scratch !== undefined) fs.rmSync(scratch, { recursive: true });
  scratch = undefined;
});

function scratchDir(): string {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-heap-"));
  return scratch;
}

// A worker entry that reports its own heap limit to its parent and exits.
const HEAP_REPORTING_WORKER = `
const { getHeapStatistics } = require("node:v8");
const { parentPort } = require("node:worker_threads");
parentPort.postMessage(getHeapStatistics().heap_size_limit);
`;

describe("the budget", () => {
  it("derives the ceiling from the measured cost at the 2^24 target", () => {
    expect(PSI_TARGET_ELEMENTS).toBe(16_777_216);
    expect(PSI_ROUND_BYTES_PER_ELEMENT).toBe(1_176);
    expect(PSI_ROUND_FIXED_BYTES).toBe(271_000_000);
    expect(PSI_HEAP_CEILING_BYTES).toBe(20_001_006_016);
    expect(PSI_HEAP_CEILING_MIB).toBe(19_075);
    expect(PSI_HEAP_CEILING_MIB * 2 ** 20).toBeGreaterThanOrEqual(
      PSI_HEAP_CEILING_BYTES,
    );
  });

  it("needs the fixed part plus the per-element cost", () => {
    expect(psiRoundMemoryNeedBytes(0)).toBe(271_000_000);
    expect(psiRoundMemoryNeedBytes(1_000)).toBe(272_176_000);
  });

  it("takes the least of the heap limit, host memory and container limit", () => {
    const readings: MemoryReadings = {
      engineHeapLimitBytes: 20e9,
      hostBytes: 64e9,
      containerLimitBytes: 8e9,
      heapRaisedByRestart: false,
    };
    expect(assessPsiMemory(10, readings)).toMatchObject({
      availableBytes: 8e9,
      limitedBy: "container",
    });
    expect(
      assessPsiMemory(10, { ...readings, containerLimitBytes: undefined }),
    ).toMatchObject({ availableBytes: 20e9, limitedBy: "heap" });
    expect(
      assessPsiMemory(10, {
        ...readings,
        hostBytes: 4e9,
        containerLimitBytes: undefined,
      }),
    ).toMatchObject({ availableBytes: 4e9, limitedBy: "host" });
  });
});

describe("the readings", () => {
  const snapshot = {
    nodeVersion: "v26.10.0",
    hostMemBytes: 25e9,
    heapLimitBytes: 4_395_630_592,
    constrainedMemBytes: 2 ** 64,
  };

  it("takes the raised limit when the engine runs in a worker", () => {
    expect(readMemory(true, false, snapshot)).toEqual({
      engineHeapLimitBytes: PSI_HEAP_CEILING_MIB * 2 ** 20,
      hostBytes: 25e9,
      containerLimitBytes: undefined,
      heapRaisedByRestart: false,
    });
  });

  it("takes the process's own limit when the engine runs on this thread", () => {
    expect(readMemory(false, false, snapshot).engineHeapLimitBytes).toBe(
      4_395_630_592,
    );
  });

  it("keeps a larger limit the process was started with", () => {
    expect(
      readMemory(true, false, { ...snapshot, heapLimitBytes: 40e9 })
        .engineHeapLimitBytes,
    ).toBe(40e9);
  });

  it("counts a container limit only below the host's memory", () => {
    expect(
      readMemory(true, false, { ...snapshot, constrainedMemBytes: 8e9 })
        .containerLimitBytes,
    ).toBe(8e9);
    expect(
      readMemory(true, false, { ...snapshot, constrainedMemBytes: 0 })
        .containerLimitBytes,
    ).toBeUndefined();
  });
});

describe("the check", () => {
  const smallHost: MemoryReadings = {
    engineHeapLimitBytes: 4_395_630_592,
    hostBytes: 2e9,
    containerLimitBytes: 512e6,
    heapRaisedByRestart: false,
  };

  function run(records: number, allowShortfall: boolean) {
    const infos: string[] = [];
    const warnings: string[] = [];
    const outcome = (() => {
      try {
        return checkPsiMemoryBudget({
          records,
          allowShortfall,
          readings: smallHost,
          log: { info: (m) => infos.push(m) },
          onShortfallWarning: (m) => warnings.push(m),
        });
      } catch (error) {
        return error;
      }
    })();
    return { outcome, infos, warnings };
  }

  it("passes a small input on a small container, stating the figures once", () => {
    const { outcome, infos, warnings } = run(1_000, false);
    expect(outcome).not.toBeInstanceOf(Error);
    expect(warnings).toEqual([]);
    expect(infos).toEqual([
      "memory: the PSI engine runs under a heap limit of 4.40 GB; a round " +
        "over this run's 1,000 records needs about 0.27 GB, and this process " +
        "has 0.51 GB (host memory 2.00 GB, container memory limit 0.51 GB)",
    ]);
  });

  it("names the restart that raised the heap limit", () => {
    const statement = psiMemoryStatement(
      assessPsiMemory(1_000, { ...smallHost, heapRaisedByRestart: true }),
    );
    expect(statement).toContain(
      "heap limit of 4.40 GB (raised by restarting this process with " +
        "--max-old-space-size=19075); a round",
    );
  });

  it("refuses a run short of memory, naming both figures and the override", () => {
    const { outcome, infos, warnings } = run(1_000_000, false);
    expect(outcome).toBeInstanceOf(UsageError);
    expect((outcome as Error).message).toBe(
      "this run needs about 1.45 GB of memory for a PSI round over its " +
        "1,000,000 records, and this process has 0.51 GB (its container's " +
        "memory limit). Give the run more memory -- a larger host, or a " +
        "larger docker run --memory -- or split the input into smaller files " +
        "and run one exchange for each. Pass --allow-memory-shortfall to run " +
        "anyway; the exchange may then run out of memory partway through, " +
        "which fails it for both parties.",
    );
    expect(infos).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("warns instead under the override, and still states the figures", () => {
    const { outcome, infos, warnings } = run(1_000_000, true);
    expect(outcome).not.toBeInstanceOf(Error);
    expect(infos).toHaveLength(1);
    expect(warnings).toEqual([
      "running with --allow-memory-shortfall: this run needs about 1.45 GB " +
        "of memory for a PSI round over its 1,000,000 records, and this " +
        "process has 0.51 GB (its container's memory limit). The exchange " +
        "may run out of memory partway through, which fails it for both " +
        "parties.",
    ]);
  });
});

describe("the limit reaches the thread that runs the engine", () => {
  it("raises the PSI worker's heap to the ceiling", async () => {
    const entry = path.join(scratchDir(), "worker.cjs");
    fs.writeFileSync(entry, HEAP_REPORTING_WORKER);
    const worker = startPsiWorkerThread(entry, {
      role: "starter",
      id: "heap-probe",
      mode: "identifier-revealing",
    });
    const limit = await new Promise<number>((resolve, reject) => {
      worker.once("message", (value: number) => resolve(value));
      worker.once("error", reject);
    });
    await worker.terminate();
    expect(limit).toBeGreaterThanOrEqual(PSI_HEAP_CEILING_BYTES);
  });

  it("states the ceiling in the image entrypoint", () => {
    const script = fs.readFileSync(ENTRYPOINT, "utf8");
    const stated = [...script.matchAll(/--max-old-space-size=(\d+)/g)].map(
      (match) => Number(match[1]),
    );
    expect(stated).toEqual([PSI_HEAP_CEILING_MIB]);
  });

  // The real entrypoint under the real shell, with a `node` on PATH that runs
  // the real Node on a probe instead of the CLI, which exists only in the
  // image: the probe reports the heap limit of its main thread and of a worker.
  function runEntrypoint(nodeOptions: string | undefined): {
    main: number;
    worker: number;
  } {
    const dir = scratchDir();
    const probe = path.join(dir, "probe.cjs");
    fs.writeFileSync(
      probe,
      `
const { getHeapStatistics } = require("node:v8");
const { Worker } = require("node:worker_threads");
const worker = new Worker(${JSON.stringify(
        HEAP_REPORTING_WORKER,
      )}, { eval: true });
worker.once("message", (limit) => {
  process.stdout.write(JSON.stringify({
    main: getHeapStatistics().heap_size_limit,
    worker: limit,
  }));
  worker.terminate();
});
`,
    );
    const stub = path.join(dir, "node");
    fs.writeFileSync(
      stub,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(probe)}\n`,
    );
    fs.chmodSync(stub, 0o755);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
    };
    delete env.NODE_OPTIONS;
    if (nodeOptions !== undefined) env.NODE_OPTIONS = nodeOptions;
    const result = spawnSync("/bin/sh", [ENTRYPOINT, "exchange"], {
      encoding: "utf8",
      env,
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as { main: number; worker: number };
  }

  it.skipIf(process.platform === "win32")(
    "reaches the main thread and the worker in the image",
    () => {
      const limits = runEntrypoint(undefined);
      expect(limits.main).toBeGreaterThanOrEqual(PSI_HEAP_CEILING_BYTES);
      expect(limits.worker).toBeGreaterThanOrEqual(PSI_HEAP_CEILING_BYTES);
    },
  );

  it.skipIf(process.platform === "win32")(
    "yields to a larger limit the container is started with",
    () => {
      const limits = runEntrypoint("--max-old-space-size=30000");
      expect(limits.main).toBeGreaterThanOrEqual(30_000 * 2 ** 20);
      expect(limits.worker).toBeGreaterThanOrEqual(30_000 * 2 ** 20);
    },
  );
});
