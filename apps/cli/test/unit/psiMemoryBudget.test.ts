import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_PSI_DECODE_ELEMENTS,
  RoundCapacityError,
  UsageError,
  statesItsOwnNextStep,
  type InboundPsiFrameUse,
} from "@alcove/core";

import {
  assessPsiMemory,
  checkPartnerRoundMemory,
  checkSinglePassOwnValuesHeap,
  checkSinglePassPartnerMemory,
  checkPsiMemoryBudget,
  inboundFrameMemoryCheck,
  PSI_HEAP_CEILING_BYTES,
  PSI_HEAP_CEILING_MIB,
  PSI_ROUND_BYTES_PER_ELEMENT,
  PSI_ROUND_FIXED_BYTES,
  PSI_TARGET_ELEMENTS,
  PSI_WORKER_HEAP_BYTES_PER_ELEMENT,
  PSI_WORKER_HEAP_FIXED_BYTES,
  psiMemoryStatement,
  psiRoundMemoryNeedBytes,
  psiWorkerHeapNeedBytes,
  readMemory,
  SINGLE_PASS_MAIN_HEAP_BYTES_PER_VALUE,
  SINGLE_PASS_MAIN_HEAP_FIXED_BYTES,
  singlePassMainHeapNeedBytes,
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

  it("holds the heap ceiling to what a round at the protocol's per-set maximum needs", () => {
    expect(PSI_TARGET_ELEMENTS).toBe(MAX_PSI_DECODE_ELEMENTS);
    expect(PSI_HEAP_CEILING_BYTES).toBeGreaterThanOrEqual(
      psiRoundMemoryNeedBytes(MAX_PSI_DECODE_ELEMENTS),
    );
  });

  it("needs the fixed part plus the per-element cost", () => {
    expect(psiRoundMemoryNeedBytes(0)).toBe(271_000_000);
    expect(psiRoundMemoryNeedBytes(1_000)).toBe(272_176_000);
  });

  it("takes the least of the heap limit, host memory and container limit", () => {
    const readings: MemoryReadings = {
      engineHeapLimitBytes: 20e9,
      engineInWorker: true,
      mainThreadHeapLimitBytes: 20e9,
      hostBytes: 64e9,
      containerLimitBytes: 8e9,
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
    expect(readMemory(true, snapshot)).toEqual({
      engineHeapLimitBytes: PSI_HEAP_CEILING_MIB * 2 ** 20,
      engineInWorker: true,
      mainThreadHeapLimitBytes: 4_395_630_592,
      hostBytes: 25e9,
      containerLimitBytes: undefined,
    });
  });

  it("takes the process's own limit when the engine runs on this thread", () => {
    expect(readMemory(false, snapshot).engineHeapLimitBytes).toBe(
      4_395_630_592,
    );
  });

  it("keeps a larger limit the process was started with", () => {
    expect(
      readMemory(true, { ...snapshot, heapLimitBytes: 40e9 })
        .engineHeapLimitBytes,
    ).toBe(40e9);
  });

  it("counts a container limit only below the host's memory", () => {
    expect(
      readMemory(true, { ...snapshot, constrainedMemBytes: 8e9 })
        .containerLimitBytes,
    ).toBe(8e9);
    expect(
      readMemory(true, { ...snapshot, constrainedMemBytes: 0 })
        .containerLimitBytes,
    ).toBeUndefined();
  });
});

describe("the check", () => {
  const smallHost: MemoryReadings = {
    engineHeapLimitBytes: 4_395_630_592,
    engineInWorker: false,
    mainThreadHeapLimitBytes: 4_395_630_592,
    hostBytes: 2e9,
    containerLimitBytes: 512e6,
  };

  function run(records: number, allowShortfall: boolean) {
    const debugs: string[] = [];
    const infos: string[] = [];
    const warnings: string[] = [];
    const outcome = (() => {
      try {
        return checkPsiMemoryBudget({
          records,
          allowShortfall,
          readings: smallHost,
          log: {
            debug: (m) => debugs.push(m),
            info: (m) => infos.push(m),
          },
          onShortfallWarning: (m) => warnings.push(m),
        });
      } catch (error) {
        return error;
      }
    })();
    return { outcome, debugs, infos, warnings };
  }

  it("passes a small input on a small container, stating the figures once at debug", () => {
    const { outcome, debugs, infos, warnings } = run(1_000, false);
    expect(outcome).not.toBeInstanceOf(Error);
    expect(warnings).toEqual([]);
    expect(infos).toEqual([]);
    expect(debugs).toEqual([
      "memory: the PSI engine runs on this process's main thread under a " +
        "heap limit of 4.40 GB; a round over this run's 1,000 records needs " +
        "about 0.27 GB, and this process has 0.51 GB (host memory 2.00 GB, " +
        "container memory limit 0.51 GB)",
    ]);
  });

  // The installed CLI's two threads: the worker at the ceiling the flag sets,
  // and the main thread at whatever limit it measures.
  const inWorker = (mainThreadHeapLimitBytes: number): MemoryReadings => ({
    engineHeapLimitBytes: PSI_HEAP_CEILING_MIB * 2 ** 20,
    engineInWorker: true,
    mainThreadHeapLimitBytes,
    hostBytes: 64e9,
    containerLimitBytes: undefined,
  });

  it("states both threads' limits", () => {
    const statement = psiMemoryStatement(
      assessPsiMemory(1_000, inWorker(20_102_250_496)),
    );
    expect(statement).toBe(
      "memory: the PSI engine runs in a worker thread under a heap limit of " +
        "20.00 GB, and this process's main thread, which reads the input, " +
        "under 20.10 GB; a round over this run's 1,000 records needs about " +
        "0.27 GB, and this process has 20.00 GB (host memory 64.00 GB, no " +
        "container memory limit)",
    );
  });

  it("states the main thread's limit as measured, below the ceiling too", () => {
    const statement = psiMemoryStatement(
      assessPsiMemory(1_000, inWorker(4_395_630_592)),
    );
    expect(statement).toContain("under 4.40 GB; a round");
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

describe("the partner's round", () => {
  const smallHost: MemoryReadings = {
    engineHeapLimitBytes: 4_395_630_592,
    engineInWorker: false,
    mainThreadHeapLimitBytes: 4_395_630_592,
    hostBytes: 2e9,
    containerLimitBytes: 512e6,
  };

  function run(partnerRoundValues: number, allowShortfall: boolean) {
    const warnings: string[] = [];
    let outcome: unknown;
    try {
      outcome = checkPartnerRoundMemory({
        partnerRoundValues,
        allowShortfall,
        readings: smallHost,
        onShortfallWarning: (m) => warnings.push(m),
      });
    } catch (error) {
      outcome = error;
    }
    return { outcome, warnings };
  }

  it("passes a partner round the process has memory for", () => {
    const { outcome, warnings } = run(1_000, false);
    expect(outcome).not.toBeInstanceOf(Error);
    expect(warnings).toEqual([]);
  });

  it("refuses a partner round short of memory as this party's capacity, naming both figures and the remedies", () => {
    const { outcome, warnings } = run(1_000_000, false);
    expect(outcome).toBeInstanceOf(RoundCapacityError);
    expect(outcome).toBeInstanceOf(UsageError);
    expect((outcome as Error).message).toBe(
      "your partner's set for one linkage key can hold up to 1,000,000 " +
        "values, a PSI round over that many needs about 1.45 GB of memory, " +
        "and this process has 0.51 GB (its container's memory limit), so the " +
        "exchange stopped before any linkage key was sent and told your " +
        "partner. Run the exchange on a host with more memory, or with a " +
        "larger docker run --memory, or ask your partner to split their " +
        "input into smaller files and run one exchange for each. Pass " +
        "--allow-memory-shortfall to run anyway; the exchange may then run " +
        "out of memory partway through, which fails it for both parties.",
    );
    expect(warnings).toEqual([]);
  });

  it("passes the per-set maximum on a host with exactly the memory a round of it needs", () => {
    // The core figure is held to the per-set maximum, so a host sized for it
    // admits every partner.
    const need = psiRoundMemoryNeedBytes(MAX_PSI_DECODE_ELEMENTS);
    const warnings: string[] = [];
    expect(() =>
      checkPartnerRoundMemory({
        partnerRoundValues: MAX_PSI_DECODE_ELEMENTS,
        allowShortfall: false,
        readings: {
          engineHeapLimitBytes: need,
          engineInWorker: false,
          mainThreadHeapLimitBytes: need,
          hostBytes: need,
          containerLimitBytes: undefined,
        },
        onShortfallWarning: (m) => warnings.push(m),
      }),
    ).not.toThrow();
    expect(warnings).toEqual([]);
  });

  it("warns instead under the override", () => {
    const { outcome, warnings } = run(1_000_000, true);
    expect(outcome).not.toBeInstanceOf(Error);
    expect(warnings).toEqual([
      "running with --allow-memory-shortfall: your partner's set for one " +
        "linkage key can hold up to 1,000,000 values, a PSI round over that " +
        "many needs about 1.45 GB of memory, and this process has 0.51 GB " +
        "(its container's memory limit). The exchange may run out of memory " +
        "partway through, which fails it for both parties.",
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

describe("the single-pass partner size at the terms exchange", () => {
  const run = (
    params: {
      irreducibleReplyBytes?: number;
      inboundFrameBytes?: number;
      inboundFrameUse?: InboundPsiFrameUse;
      encrypted?: boolean;
    },
    availableBytes: number,
    allowShortfall = false,
  ) => {
    const lines: Array<string> = [];
    const shortfall: Array<string> = [];
    checkSinglePassPartnerMemory({
      size: {
        partnerValueSlots: 10_500_000,
        localValueSlots: 350_000,
        partnerRecordCount: 150_000,
        irreducibleReplyBytes: params.irreducibleReplyBytes ?? 0,
        inboundFrameBytes: params.inboundFrameBytes ?? 0,
        inboundFrameUse: params.inboundFrameUse ?? "stream",
      },
      encrypted: params.encrypted ?? true,
      allowShortfall,
      availableBytes,
      log: { warn: (message) => lines.push(message) },
      onShortfallWarning: (message) => shortfall.push(message),
    });
    return { lines, shortfall };
  };

  it("states the partner's value slots and the worst case on a run that fits", () => {
    const { lines, shortfall } = run(
      { irreducibleReplyBytes: 15_000_000 },
      15_000_000,
    );
    expect(shortfall).toEqual([]);
    expect(lines).toEqual([
      "your partner declared 10,500,000 value slots, so it can test up to " +
        "that many values against yours; at worst this run needs about " +
        "10.85 GB of memory and 3 minute(s), at rates measured on one machine.",
    ]);
  });

  it("refuses a reply whose index table alone cannot fit what is available", () => {
    const over = () => run({ irreducibleReplyBytes: 15_000_001 }, 15_000_000);
    expect(over).toThrow(RoundCapacityError);
    expect(over).toThrow(
      /could take up to 0\.0\d GB of memory, but this machine has 0\.0\d GB available now.*--allow-memory-shortfall/,
    );
  });

  // 100 MB frames: a reply read with its decryption, a reply read without
  // it and handed to the worker, and a request the worker decodes.
  it.each([
    ["an encrypted reply", "stream", true, 400_000_000],
    ["an unencrypted reply", "stream", false, 300_000_000],
    ["an encrypted request", "decode", true, 965_000_000],
  ] as const)(
    "weighs %s the counts allow at the measured multiples",
    (_what, inboundFrameUse, encrypted, needBytes) => {
      const size = {
        inboundFrameBytes: 100_000_000,
        inboundFrameUse,
        encrypted,
      };
      expect(() => run(size, needBytes)).not.toThrow();
      expect(() => run(size, needBytes - 1)).toThrow(RoundCapacityError);
    },
  );

  it("refuses with one plain message naming the override", () => {
    expect(() =>
      run(
        { inboundFrameBytes: 500_000_000, inboundFrameUse: "stream" },
        1_200_000_000,
      ),
    ).toThrow(
      "your partner declared 150,000 records, and reading what they send " +
        "could take up to 2.00 GB of memory, but this machine has 1.20 GB " +
        "available now, so the exchange stopped before any value was masked " +
        "and told your partner. Run the exchange on a host with more memory, " +
        "or ask your partner to split their input into smaller files and run " +
        "one exchange for each. Pass --allow-memory-shortfall to run anyway; " +
        "the exchange may then run out of memory partway through, which " +
        "fails it for both parties.",
    );
  });

  it("runs past that refusal under --allow-memory-shortfall, and still states the worst case", () => {
    const { lines, shortfall } = run(
      { irreducibleReplyBytes: 15_000_001 },
      15_000_000,
      true,
    );
    expect(shortfall).toHaveLength(1);
    expect(shortfall[0]).toMatch(/^running with --allow-memory-shortfall: /);
    expect(lines).toHaveLength(1);
  });
});

describe("the memory check before a partner message is read or handed to the worker", () => {
  const check = (availableBytes: number, allowShortfall = false) => {
    const warnings: Array<string> = [];
    const weigh = inboundFrameMemoryCheck({
      allowShortfall,
      onShortfallWarning: (message) => warnings.push(message),
      availableBytes: () => availableBytes,
    });
    return { weigh, warnings };
  };

  it("lets a message through when what it needs is available", () => {
    const { weigh, warnings } = check(2_000_000_000);
    expect(() => weigh(500_000_000, 2_000_000_000)).not.toThrow();
    expect(warnings).toEqual([]);
  });

  it("refuses a message that needs more, saying what to do", () => {
    const { weigh } = check(1_200_000_000);
    let refusal: unknown;
    try {
      weigh(480_000_000, 1_920_000_000);
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(UsageError);
    expect((refusal as Error).message).toBe(
      "your partner's message is 480.0 MB and needs about 1.92 GB of memory " +
        "to process, but this machine has 1.20 GB available now, so the " +
        "exchange stopped. Run the exchange on a host with more memory, or " +
        "pass --allow-memory-shortfall to run anyway; the exchange may then " +
        "run out of memory, which fails it for both parties.",
    );
    expect(statesItsOwnNextStep(refusal)).toBe(true);
  });

  it("warns instead under --allow-memory-shortfall", () => {
    const { weigh, warnings } = check(1_200_000_000, true);
    expect(() => weigh(480_000_000, 1_920_000_000)).not.toThrow();
    expect(warnings).toEqual([
      "running with --allow-memory-shortfall: your partner's message is " +
        "480.0 MB and needs about 1.92 GB of memory to process, but this " +
        "machine has 1.20 GB available now. The exchange may run out of " +
        "memory, which fails it for both parties.",
    ]);
  });

  it("reads the memory available when no reading is given", () => {
    const weigh = inboundFrameMemoryCheck({
      allowShortfall: false,
      onShortfallWarning: () => undefined,
    });
    expect(() => weigh(1, 1)).not.toThrow();
    expect(() => weigh(1, Number.MAX_SAFE_INTEGER)).toThrow(UsageError);
  });
});

describe("the PSI worker's heap, from the counts", () => {
  it("is the measured worker heap per element of the larger set", () => {
    expect(PSI_WORKER_HEAP_BYTES_PER_ELEMENT).toBe(709);
    expect(PSI_WORKER_HEAP_FIXED_BYTES).toBe(298_000_000);
    expect(psiWorkerHeapNeedBytes(10_500_000)).toBe(7_742_500_000);
  });

  it("reaches a worker started for counts past the default ceiling", async () => {
    const heapBytes = psiWorkerHeapNeedBytes(40_000_000);
    expect(heapBytes).toBeGreaterThan(PSI_HEAP_CEILING_BYTES);
    const entry = path.join(scratchDir(), "worker.cjs");
    fs.writeFileSync(entry, HEAP_REPORTING_WORKER);
    const worker = startPsiWorkerThread(
      entry,
      { role: "joiner", id: "heap-probe", mode: "identifier-revealing" },
      heapBytes,
    );
    const limit = await new Promise<number>((resolve, reject) => {
      worker.once("message", (value: number) => resolve(value));
      worker.once("error", reject);
    });
    await worker.terminate();
    expect(limit).toBeGreaterThanOrEqual(heapBytes);
  });
});

describe("the main thread's heap, from this party's distinct values", () => {
  // The smallest heap limit a single-pass link completed under, both roles,
  // from docs/spec/FILE_SYNC.md, "The main thread's heap, from the values".
  const MEASURED: Array<[values: number, heapLimitMiB: number]> = [
    [500_000, 178],
    [1_000_000, 236],
    [2_000_000, 341],
    [2_999_990, 499],
  ];

  it("is at least each measured limit", () => {
    expect(SINGLE_PASS_MAIN_HEAP_BYTES_PER_VALUE).toBe(135);
    expect(SINGLE_PASS_MAIN_HEAP_FIXED_BYTES).toBe(120_000_000);
    for (const [values, mib] of MEASURED)
      expect(singlePassMainHeapNeedBytes(values)).toBeGreaterThanOrEqual(
        mib * 2 ** 20,
      );
  });

  const check = (heapLimitBytes: number, allowShortfall = false) => {
    const warnings: Array<string> = [];
    const run = () =>
      checkSinglePassOwnValuesHeap({
        distinctValues: 2_000_000,
        allowShortfall,
        onShortfallWarning: (message) => warnings.push(message),
        heapLimitBytes,
      });
    return { run, warnings };
  };

  it("lets a run through when its heap limit is enough", () => {
    const { run, warnings } = check(390_000_000);
    expect(run).not.toThrow();
    expect(warnings).toEqual([]);
  });

  it("refuses a run whose heap limit is short, naming the setting", () => {
    const { run } = check(300_000_000);
    let refusal: unknown;
    try {
      run();
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(UsageError);
    expect((refusal as Error).message).toBe(
      "matching your 2,000,000 distinct values needs about 0.39 GB of heap, " +
        "more than this process's limit of 0.30 GB, so the exchange stopped " +
        "and told your partner. Set NODE_OPTIONS=--max-old-space-size=" +
        `${PSI_HEAP_CEILING_MIB} in the environment and run the exchange ` +
        "again, or pass --allow-memory-shortfall to run anyway; the exchange " +
        "may then run out of memory, which fails it for both parties.",
    );
    expect(statesItsOwnNextStep(refusal)).toBe(true);
  });

  it("warns instead under --allow-memory-shortfall", () => {
    const { run, warnings } = check(300_000_000, true);
    expect(run).not.toThrow();
    expect(warnings).toEqual([
      "running with --allow-memory-shortfall: matching your 2,000,000 " +
        "distinct values needs about 0.39 GB of heap, more than this " +
        "process's limit of 0.30 GB. The exchange may run out of memory, " +
        "which fails it for both parties.",
    ]);
  });

  it("reads this thread's heap limit when none is given", () => {
    expect(() =>
      checkSinglePassOwnValuesHeap({
        distinctValues: 1,
        allowShortfall: false,
        onShortfallWarning: () => undefined,
      }),
    ).not.toThrow();
  });
});
