import { chmodSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import PSI from "@openmined/psi.js";
import { build } from "esbuild";
import { chromium } from "playwright";

import type { AddressInfo } from "node:net";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

// What the browser PSI round benches (browserSameSizeRound.ts and
// browserWrappedRound.ts) share: bundling a page or the shipped PSI worker,
// the local server set bytes move through, the renderer's resident set, and
// the worker's V8 heap read from V8's collection trace.

/**
 * Prepended to the worker bundle so a bench can read the engine's linear
 * memory, which the engine creates as an export of its instance and which only
 * grows, so its length after a step is the high-water mark so far.
 */
export const WASM_MEMORY_CAPTURE = `
(() => {
  const capture = (result) => {
    const instance = result && result.instance ? result.instance : result;
    for (const value of Object.values((instance && instance.exports) || {}))
      if (value instanceof WebAssembly.Memory) {
        self.__psiWasmMemory = self.__psiWasmMemory || value;
        break;
      }
    return result;
  };
  for (const name of ["instantiate", "instantiateStreaming"]) {
    const original = WebAssembly[name];
    if (original)
      WebAssembly[name] = (...args) =>
        original.apply(WebAssembly, args).then(capture);
  }
})();
`;

/** The `--js-flags` that make V8 print the collection trace parsed below. */
export const V8_TRACE_FLAGS =
  "--js-flags=--expose-gc --trace-gc --trace-gc-verbose --trace-gc-ignore-scavenger";

/** The worker's V8 heap in one step, in MiB as V8's collection trace prints it. */
export interface WorkerHeapStep {
  readonly beforeMiB: number;
  readonly peakMiB: number;
  readonly afterMiB?: number;
}

/**
 * A step's span on the worker's clock, from just after the collection forced
 * before it to just after the one forced after it.
 */
export interface StepWindow {
  readonly name: string;
  readonly fromMs: number;
  toMs?: number;
}

/** What {@link parseHeapTrace} reads off one run's trace. */
export interface HeapTrace {
  readonly workerSteps: ReadonlyArray<WorkerHeapStep>;
  readonly workerHeapLimitBytes?: number;
  readonly pageHeapPeakMiB?: number;
}

/** Bundles one page or worker entry for the browser, as ES module source. */
export async function bundle(
  entry: string,
  banner: string | undefined,
): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    // The engine's loader names Node builtins on a branch a worker never takes.
    external: ["url", "fs", "path", "crypto", "worker_threads"],
    banner: banner === undefined ? undefined : { js: banner },
    write: false,
    logLevel: "error",
  });
  return result.outputFiles[0].text;
}

/** The PSI library a Node partner runs: the native addon where one ships. */
export async function loadPartnerLibrary(): Promise<{
  library: PSILibrary;
  backend: "native" | "wasm";
}> {
  try {
    const { default: loadNative } =
      await import("@openmined/psi.js/psi_native_node.js");
    return { library: await loadNative(), backend: "native" };
  } catch {
    return { library: await PSI(), backend: "wasm" };
  }
}

/**
 * The largest resident set of a Playwright-launched Chromium renderer, which is
 * the process a page's dedicated workers run in: of the browser whose process
 * is `browserPid`, or of any browser when none is named.
 */
export async function rendererRssBytes(browserPid?: number): Promise<number> {
  const { stdout } = await promisify(execFile)(
    "ps",
    ["-A", "-o", "pid=,ppid=,rss=,command="],
    { maxBuffer: 1 << 24 },
  );
  const processes = stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match
      ? [
          {
            pid: Number(match[1]),
            parent: Number(match[2]),
            rssBytes: Number(match[3]) * 1024,
            command: match[4],
          },
        ]
      : [];
  });
  const parentOf = new Map(processes.map((each) => [each.pid, each.parent]));
  const descendsFromBrowser = (pid: number): boolean => {
    for (let at: number | undefined = pid; at !== undefined && at > 1;) {
      if (at === browserPid) return true;
      at = parentOf.get(at);
    }
    return false;
  };
  let largest = 0;
  for (const { pid, rssBytes, command } of processes)
    if (
      command.includes("--type=renderer") &&
      command.includes("ms-playwright") &&
      (browserPid === undefined || descendsFromBrowser(pid))
    )
      largest = Math.max(largest, rssBytes);
  return largest;
}

/**
 * V8's collection trace goes to the browser's standard output, which
 * Playwright does not hand back, so Chromium starts through a script that
 * appends that output, line-buffered where stdbuf exists, to a file, with its
 * error output, where V8 writes the message it stops a renderer with. The
 * script leaves the browser's process id in {@link browserPidFile}.
 */
export function chromiumWritingTraceTo(dir: string, log: string): string {
  const script = join(dir, "chromium.sh");
  const real = JSON.stringify(chromium.executablePath());
  const out = JSON.stringify(log);
  writeFileSync(
    script,
    "#!/bin/sh\n" +
      `echo $$ >${JSON.stringify(browserPidFile(dir))}\n` +
      `if command -v stdbuf >/dev/null; then exec stdbuf -oL ${real} "$@" >>${out} 2>&1; fi\n` +
      `exec ${real} "$@" >>${out} 2>&1\n`,
  );
  chmodSync(script, 0o755);
  return script;
}

/**
 * Where the script {@link chromiumWritingTraceTo} writes leaves the process id
 * of the browser it starts, which keeps it through `exec`.
 */
export function browserPidFile(dir: string): string {
  return join(dir, "chromium.pid");
}

/**
 * Playwright's own `--disable-features` switch with `feature` added, read off a
 * launch Playwright composed itself. Chromium keeps only the last such switch
 * on a command line, so a switch of the bench's own would drop Playwright's.
 */
export async function disableFeaturesSwitchWith(
  feature: string,
): Promise<string> {
  const prefix = "--disable-features=";
  const server = await chromium.launchServer({ headless: true });
  try {
    const own = server
      .process()
      .spawnargs.find((arg) => arg.startsWith(prefix));
    return own === undefined ? `${prefix}${feature}` : `${own},${feature}`;
  } finally {
    await server.close();
  }
}

const FULL_COLLECTION =
  /^\[(\d+):(0x[0-9a-f]+)\] +(\d+) ms: [^:]*?Mark-Compact\D*([\d.]+) \([\d.]+\) -> ([\d.]+) \([\d.]+\) MB/;
const ALLOCATOR =
  /^\[(\d+):(0x[0-9a-f]+)\] Memory allocator, +used: +(\d+) KB, available: +(\d+) KB/;

/** How far ahead of any other the aligning collection is forced. */
export const ALIGNMENT_SPAN_MS = 250;

/**
 * Reads the worker's and the page's V8 heap off the collection trace. A bench
 * forces collections in the worker (reason "testing"), which name the
 * worker's isolate; the first, forced {@link ALIGNMENT_SPAN_MS} before any
 * other, aligns the isolate's trace clock with the worker's. A step's heap
 * before and after are what the forced collections left, its peak the most any
 * full collection in its window found in use. The trace prints whole
 * milliseconds, hence the one of slack at each edge. The heap limit is the sum
 * of the used and available bytes V8's memory allocator reports.
 */
export function parseHeapTrace(
  text: string,
  alignedAtMs: number,
  windows: ReadonlyArray<StepWindow>,
): HeapTrace {
  const lines = text.split("\n");
  const collections = lines.flatMap((line) => {
    const match = FULL_COLLECTION.exec(line);
    return match
      ? [
          {
            pid: match[1],
            isolate: `${match[1]}:${match[2]}`,
            atMs: Number(match[3]),
            beforeMiB: Number(match[4]),
            afterMiB: Number(match[5]),
            forced: line.includes(" testing;"),
          },
        ]
      : [];
  });
  const first = collections.find((each) => each.forced);
  if (!first)
    throw new Error(
      "the heap trace holds no forced collection: the V8 trace line this bench parses has changed, so no worker heap figure can be read",
    );
  const worker = collections.filter((c) => c.isolate === first.isolate);
  const alignment = worker
    .filter((c) => c.forced && c.atMs <= first.atMs + ALIGNMENT_SPAN_MS)
    .at(-1)!;
  const offset = alignment.atMs - alignedAtMs;
  const workerAt = worker.map((c) => ({ ...c, atMs: c.atMs - offset }));
  const leftBy = (ms: number): number | undefined =>
    workerAt.filter((c) => c.forced && c.atMs <= ms + 1).at(-1)?.afterMiB;
  const workerSteps = windows.map((window): WorkerHeapStep => {
    const inside = workerAt.filter(
      (c) =>
        c.atMs > window.fromMs + 1 &&
        (window.toMs === undefined || c.atMs <= window.toMs + 1),
    );
    const beforeMiB = leftBy(window.fromMs) ?? 0;
    return {
      beforeMiB,
      peakMiB: Math.max(beforeMiB, ...inside.map((c) => c.beforeMiB)),
      ...(window.toMs === undefined ? {} : { afterMiB: leftBy(window.toMs) }),
    };
  });
  let workerHeapLimitBytes: number | undefined;
  for (const line of lines) {
    const match = ALLOCATOR.exec(line);
    if (match && `${match[1]}:${match[2]}` === first.isolate)
      workerHeapLimitBytes = Math.max(
        workerHeapLimitBytes ?? 0,
        (Number(match[3]) + Number(match[4])) * 1024,
      );
  }
  const page = collections.filter(
    (c) => c.pid === first.pid && c.isolate !== first.isolate,
  );
  return {
    workerSteps,
    workerHeapLimitBytes,
    pageHeapPeakMiB: page.length
      ? Math.max(...page.map((c) => c.beforeMiB))
      : undefined,
  };
}

/** The bench's local server: its address, the sets it holds, and its stop. */
export interface BenchServer {
  readonly origin: string;
  readonly sets: Map<string, Uint8Array>;
  close: () => void;
}

/**
 * Serves `files` by path, a `.js` path as a script and any other as a page,
 * `/` and any other unknown path as `html`, and set bytes at `/set/<name>`: a
 * GET answers the set, and a POST stores it in pieces, `?piece=0` starting it
 * and `&last` joining it.
 */
export async function startBenchServer(
  files: ReadonlyMap<string, string>,
  html: string,
): Promise<BenchServer> {
  const sets = new Map<string, Uint8Array>();
  const pieces = new Map<string, Array<Buffer>>();
  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    if (url.startsWith("/set/")) {
      const { pathname, searchParams } = new URL(url, "http://bench");
      const name = pathname.slice("/set/".length);
      if (request.method === "POST") {
        if (searchParams.get("piece") === "0") pieces.set(name, []);
        request.on("data", (chunk: Buffer) => pieces.get(name)?.push(chunk));
        request.on("end", () => {
          if (searchParams.has("last")) {
            sets.set(name, new Uint8Array(Buffer.concat(pieces.get(name)!)));
            pieces.delete(name);
          }
          response.writeHead(204).end();
        });
        return;
      }
      const bytes = sets.get(name);
      if (!bytes) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": bytes.byteLength,
      });
      response.end(bytes);
      return;
    }
    const { pathname } = new URL(url, "http://bench");
    const file = files.get(pathname);
    response.writeHead(200, {
      "content-type":
        file !== undefined && pathname.endsWith(".js")
          ? "text/javascript"
          : "text/html",
    });
    response.end(file ?? html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sets,
    close: () => server.close(),
  };
}
