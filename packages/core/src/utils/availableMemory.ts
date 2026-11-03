// The memory this process can still take, read where it is about to hold
// untrusted input: the JSON node budget (boundedJson.ts) and the inbound
// read-ahead (messageConnection.ts). Read from globals rather than imports so
// the module bundles for the browser unchanged. See
// docs/spec/PARSED_INPUT_BOUNDS.md, Application-layer parsed-input bounds.

/**
 * The bytes assumed available where the runtime reports no figure (a browser
 * other than Chromium): the order of a 64-bit browser tab's heap ceiling.
 */
export const UNREPORTED_AVAILABLE_MEMORY_BYTES = 2 ** 32;

interface HeapStatistics {
  heap_size_limit: number;
  used_heap_size: number;
}

interface RuntimeGlobals {
  process?: {
    getBuiltinModule?: (id: string) => unknown;
    constrainedMemory?: () => number;
    memoryUsage?: { rss?: () => number };
  };
  performance?: {
    memory?: { jsHeapSizeLimit: number; usedJSHeapSize: number };
  };
  gc?: () => void;
}

const runtime = globalThis as unknown as RuntimeGlobals;

// A container's memory limit does not change while the process runs, and
// reading it costs a file read, so it is read once. `null` means none: Node
// reports an unconstrained process as 0 or a figure past the host's memory.
let containerLimitBytes: number | null | undefined;

function readContainerLimitBytes(): number | null {
  if (containerLimitBytes !== undefined) return containerLimitBytes;
  const proc = runtime.process;
  const os = proc?.getBuiltinModule?.("node:os") as
    { totalmem(): number } | undefined;
  const limit = proc?.constrainedMemory?.() ?? 0;
  containerLimitBytes =
    os !== undefined && limit > 0 && limit < os.totalmem() ? limit : null;
  return containerLimitBytes;
}

// Both reads are system calls that can fail. A failed read is no reading,
// since a caller (the inbound queue's deliver) must not throw.
function readContainerHeadroomBytes(): number | undefined {
  try {
    const limit = readContainerLimitBytes();
    const rss = runtime.process?.memoryUsage?.rss;
    return limit === null || rss === undefined ? undefined : limit - rss();
  } catch {
    return undefined;
  }
}

/**
 * The bytes this process can still allocate now: on Node the least of the V8
 * heap's headroom and, in a container, the container limit less the resident
 * set; in a Chromium tab the JavaScript heap's headroom; elsewhere
 * {@link UNREPORTED_AVAILABLE_MEMORY_BYTES}. Garbage not yet collected counts
 * as used.
 */
export function availableMemoryBytes(): number {
  const readings: number[] = [];
  const v8 = runtime.process?.getBuiltinModule?.("node:v8") as
    { getHeapStatistics(): HeapStatistics } | undefined;
  if (v8 !== undefined) {
    const heap = v8.getHeapStatistics();
    readings.push(heap.heap_size_limit - heap.used_heap_size);
    const containerReading = readContainerHeadroomBytes();
    if (containerReading !== undefined) readings.push(containerReading);
  }
  const tabHeap = runtime.performance?.memory;
  if (tabHeap !== undefined)
    readings.push(tabHeap.jsHeapSizeLimit - tabHeap.usedJSHeapSize);
  if (readings.length === 0) return UNREPORTED_AVAILABLE_MEMORY_BYTES;
  return Math.max(0, Math.min(...readings));
}

/**
 * Runs a full garbage collection where the runtime exposes one (Node started
 * with `--expose-gc`, as the command-line application is), so a following
 * {@link availableMemoryBytes} does not count garbage as used. Returns whether
 * it ran.
 */
export function collectGarbage(): boolean {
  const gc = runtime.gc;
  if (typeof gc !== "function") return false;
  gc();
  return true;
}
