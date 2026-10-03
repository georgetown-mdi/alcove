// Loaded with `--import` into each party a completion stress test spawns: as
// the process exits, it writes the process's peak resident set, in bytes, to
// the file ALCOVE_STRESS_PEAK_RSS_FILE names. The PSI worker is a thread of the
// same process, so the figure covers it.
//
// With ALCOVE_STRESS_MEMORY_SAMPLE_FILE set, it also appends one JSON line to
// that file every 200 ms: the process's resident set and its peak so far, the
// main thread's process.memoryUsage(), and each live worker's V8 heap. A
// preload does not run inside a worker, so the worker figures are read from
// the main thread through a wrapped Worker constructor, which reaches a CLI
// that reads `Worker` off the module when it starts one, as the bundled CLI
// does; samples that list no worker during a round mean it did not.
import { appendFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isMainThread } from "node:worker_threads";

const target = process.env.ALCOVE_STRESS_PEAK_RSS_FILE;
if (isMainThread && target !== undefined)
  process.on("exit", () => {
    writeFileSync(target, String(process.resourceUsage().maxRSS * 1024));
  });

const sampleFile = process.env.ALCOVE_STRESS_MEMORY_SAMPLE_FILE;
if (isMainThread && sampleFile !== undefined) {
  const workerThreads = createRequire(import.meta.url)("node:worker_threads");
  const BaseWorker = workerThreads.Worker;
  const liveWorkers = new Set();
  workerThreads.Worker = class extends BaseWorker {
    constructor(...args) {
      super(...args);
      liveWorkers.add(this);
      this.once("exit", () => liveWorkers.delete(this));
    }
  };
  let sampling = false;
  const sample = async () => {
    if (sampling) return;
    sampling = true;
    try {
      const at = Date.now();
      const main = process.memoryUsage();
      const maxRss = process.resourceUsage().maxRSS * 1024;
      const workers = await Promise.all(
        [...liveWorkers].map((worker) =>
          worker.getHeapStatistics().then(
            (heap) => ({
              heapUsed: heap.used_heap_size,
              heapTotal: heap.total_heap_size,
              external: heap.external_memory,
              malloced: heap.malloced_memory,
            }),
            () => undefined,
          ),
        ),
      );
      appendFileSync(
        sampleFile,
        JSON.stringify({
          at,
          rss: main.rss,
          maxRss,
          mainHeapUsed: main.heapUsed,
          mainHeapTotal: main.heapTotal,
          mainExternal: main.external,
          mainArrayBuffers: main.arrayBuffers,
          workers: workers.filter((worker) => worker !== undefined),
        }) + "\n",
      );
    } finally {
      sampling = false;
    }
  };
  setInterval(() => void sample(), 200).unref();
}
