// The heap this process can still take, read where it is about to parse
// untrusted JSON (boundedJson.ts). Read from globals rather than imports so the
// module bundles for the browser unchanged. See
// docs/spec/PARSED_INPUT_BOUNDS.md, Application-layer parsed-input bounds.

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

// Both reads are system calls that can fail; a failed read is no reading.
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
 * The bytes this process can still allocate on its JavaScript heap now: on
 * Node the least of the V8 heap's headroom and, in a container, the container
 * limit less the resident set; in a Chromium tab the heap's headroom; and
 * `undefined` where the runtime reports neither (a browser other than
 * Chromium). Garbage not yet collected counts as used.
 */
export function availableMemoryBytes(): number | undefined {
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
  if (readings.length === 0) return undefined;
  return Math.max(0, Math.min(...readings));
}

interface V8Flags {
  setFlagsFromString(flags: string): void;
}

interface VmContexts {
  runInNewContext(code: string): unknown;
}

// The collector found on the first call, or `null` where none can be had.
let collector: (() => void) | null | undefined;

// Node exposes `gc` only to a process started with `--expose-gc`; the flag
// set at run time exposes it to a context created after, which hands it back.
function obtainCollector(): (() => void) | null {
  if (typeof runtime.gc === "function") return runtime.gc;
  const proc = runtime.process;
  const v8 = proc?.getBuiltinModule?.("node:v8") as V8Flags | undefined;
  const vm = proc?.getBuiltinModule?.("node:vm") as VmContexts | undefined;
  if (v8 === undefined || vm === undefined) return null;
  try {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc");
    return typeof gc === "function" ? (gc as () => void) : null;
  } catch {
    return null;
  }
}

/**
 * Runs a full garbage collection where the runtime allows one (Node, whether
 * or not it was started with `--expose-gc`), so a following
 * {@link availableMemoryBytes} does not count garbage as used. Returns whether
 * it ran.
 */
export function collectGarbage(): boolean {
  if (collector === undefined) collector = obtainCollector();
  if (collector === null) return false;
  collector();
  return true;
}
