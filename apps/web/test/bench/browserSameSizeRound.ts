import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

import { InProcessPsiEngine } from "@alcove/core";
import PSI from "@openmined/psi.js";
import { build } from "esbuild";
import { chromium } from "playwright";

import type { AddressInfo } from "node:net";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type { Worker as PageWorker } from "playwright";
import type { PsiEngineMode } from "@alcove/core";
import type { RoundProbe } from "./browserSameSizeRound.page";

// One same-size PSI round with the browser as one party: the web app's own
// worker-backed WebAssembly engine (the shipped psiCrypto.worker.ts, bundled
// here) in Chromium against a Node partner, each step one page call with no
// time limit of its own. It records each step's wall time, the renderer's
// peak resident set (sampled with `ps` once a second, so any host with `ps`),
// the worker's engine memory after each step, the worker's V8 heap through
// each step and its heap limit, and whether the result matches the known
// overlap. The steps are the engine's alone: the frame transport,
// the part framing and the element scan a real round adds are not run.
//
//   node apps/web/test/bench/browserSameSizeRound.ts \
//     --role joiner --elements 7500000 [--mode identifier-revealing]
//     [--overlap 1000] [--out results.jsonl]
//
// --role joiner runs createClientRequest, receiveServerSetup and the match in
// the browser; --role starter runs createServerSetup and processClientRequest
// there. The partner runs on the native addon where one ships.
//
// Above about 6 million a side, run it as `node --max-old-space-size=19075`
// (the command-line application's heap ceiling, docs/spec/FILE_SYNC.md): the
// Node partner's answer to the request outgrows Node's default heap.

const WORKER_ENTRY = fileURLToPath(
  new URL("../../src/psi/workers/psiCrypto.worker.ts", import.meta.url),
);
const PAGE_ENTRY = fileURLToPath(
  new URL("./browserSameSizeRound.page.ts", import.meta.url),
);

// Prepended to the worker bundle so the bench can read the engine's linear
// memory, which the engine creates as an export of its instance and which
// only grows, so its length after a step is the high-water mark so far.
const WASM_MEMORY_CAPTURE = `
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

const PAGE_HTML = `<!doctype html>
<meta charset="utf-8" />
<title>browser same-size PSI round</title>
<script type="module" src="/page.js"></script>
`;

/** The worker's V8 heap in one step, in MiB as V8's collection trace prints it. */
interface WorkerHeapStep {
  readonly beforeMiB: number;
  readonly peakMiB: number;
  readonly afterMiB?: number;
}

interface StepRecord {
  readonly ms: number;
  readonly value: unknown;
  readonly peakRendererRssBytes: number;
  readonly workerWasmBytes: number;
}

interface HeapTrace {
  readonly workerSteps: ReadonlyArray<WorkerHeapStep>;
  readonly workerHeapLimitBytes?: number;
  readonly pageHeapPeakMiB?: number;
}

interface RoundRecord {
  readonly date: string;
  readonly role: "starter" | "joiner";
  readonly mode: PsiEngineMode;
  readonly elements: number;
  readonly overlap: number;
  readonly partnerBackend: "native" | "wasm";
  readonly browserVersion: string;
  readonly steps: Record<string, StepRecord>;
  readonly wallMs: number;
  readonly peakRendererRssBytes: number;
  readonly workerHeap: Record<string, WorkerHeapStep>;
  readonly workerHeapLimitBytes?: number;
  readonly pageHeapLimitBytes: number;
  readonly pageHeapPeakMiB?: number;
  readonly matchesExpected: boolean;
  readonly error?: string;
}

// Installed by the page entry; Playwright sends a page function as source
// text, so a call to it in one resolves in the page.
declare function probeOf(): RoundProbe;

function flagValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

async function bundle(
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

async function loadPartnerLibrary(): Promise<{
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

// The largest resident set of any Playwright-launched Chromium renderer, which
// is the process a page's dedicated workers run in.
async function rendererRssBytes(): Promise<number> {
  const { stdout } = await promisify(execFile)(
    "ps",
    ["-A", "-o", "rss=,command="],
    { maxBuffer: 1 << 24 },
  );
  let largest = 0;
  for (const line of stdout.split("\n")) {
    if (!line.includes("--type=renderer") || !line.includes("ms-playwright"))
      continue;
    largest = Math.max(largest, Number(line.trim().split(/\s+/)[0]) * 1024);
  }
  return largest;
}

// V8's collection trace goes to the browser's standard output, which
// Playwright does not hand back, so Chromium starts through a script that
// appends that output, line-buffered where stdbuf exists, to a file.
function chromiumWritingTraceTo(dir: string, log: string): string {
  const script = join(dir, "chromium.sh");
  const real = JSON.stringify(chromium.executablePath());
  const out = JSON.stringify(log);
  writeFileSync(
    script,
    "#!/bin/sh\n" +
      `if command -v stdbuf >/dev/null; then exec stdbuf -oL ${real} "$@" >>${out}; fi\n` +
      `exec ${real} "$@" >>${out}\n`,
  );
  chmodSync(script, 0o755);
  return script;
}

const FULL_COLLECTION =
  /^\[(\d+):(0x[0-9a-f]+)\] +(\d+) ms: [^:]*?Mark-Compact\D*([\d.]+) \([\d.]+\) -> ([\d.]+) \([\d.]+\) MB/;
const ALLOCATOR =
  /^\[(\d+):(0x[0-9a-f]+)\] Memory allocator, +used: +(\d+) KB, available: +(\d+) KB/;

const ALIGNMENT_SPAN_MS = 250;

/**
 * A step's span on the worker's clock, from just after the collection forced
 * before it to just after the one forced after it.
 */
interface StepWindow {
  readonly name: string;
  readonly fromMs: number;
  toMs?: number;
}

// The bench forces collections in the worker (reason "testing"), which name
// the worker's isolate; the first, forced ALIGNMENT_SPAN_MS before any other,
// aligns the isolate's trace clock with the worker's. A step's heap before and
// after are what the forced collections left, its peak the most any full
// collection in its window found in use. The trace prints whole milliseconds,
// hence the one of slack at each edge. The heap limit is the sum of the used
// and available bytes V8's memory allocator reports.
function parseHeapTrace(
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

function partyValues(elements: number, overlap: number): Array<string> {
  return Array.from({ length: elements }, (_, index) =>
    index < overlap ? `shared-${index}` : `node-${index}`,
  );
}

async function main(): Promise<void> {
  const role = flagValue("role", "joiner") as "starter" | "joiner";
  const mode = flagValue("mode", "identifier-revealing") as PsiEngineMode;
  const elements = Number(flagValue("elements", "65536"));
  const overlap = Math.min(Number(flagValue("overlap", "1000")), elements);
  const out = flagValue("out", "");

  const [workerSource, pageSource] = await Promise.all([
    bundle(WORKER_ENTRY, WASM_MEMORY_CAPTURE),
    bundle(PAGE_ENTRY, undefined),
  ]);
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
    const script = new Map([
      ["/worker.js", workerSource],
      ["/page.js", pageSource],
    ]).get(url);
    response.writeHead(200, {
      "content-type": script === undefined ? "text/html" : "text/javascript",
    });
    response.end(script ?? PAGE_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const { library, backend: partnerBackend } = await loadPartnerLibrary();
  const partner = new InProcessPsiEngine(
    library,
    role === "joiner" ? "starter" : "joiner",
    "partner",
    mode,
  );
  const traceDir = mkdtempSync(join(tmpdir(), "browser-round-"));
  const traceLog = join(traceDir, "v8-trace.log");
  writeFileSync(traceLog, "");
  const browser = await chromium.launch({
    executablePath: chromiumWritingTraceTo(traceDir, traceLog),
    args: [
      "--enable-precise-memory-info",
      "--js-flags=--expose-gc --trace-gc --trace-gc-verbose --trace-gc-ignore-scavenger",
    ],
  });
  const page = await browser.newPage();
  const pageErrors: Array<string> = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("crash", () => pageErrors.push("the page crashed"));

  let stepPeak = 0;
  let runPeak = 0;
  let sampling = false;
  const sampler = setInterval(() => {
    if (sampling) return;
    sampling = true;
    void rendererRssBytes()
      .then((bytes) => {
        stepPeak = Math.max(stepPeak, bytes);
        runPeak = Math.max(runPeak, bytes);
      })
      .finally(() => {
        sampling = false;
      });
  }, 1000);

  const steps: Record<string, StepRecord> = {};
  const started = Date.now();
  let matchesExpected = false;
  let error: string | undefined;
  let psiWorker: PageWorker | undefined;
  // The worker's clock just after a collection forced in it.
  const collectInWorker = async (): Promise<number> =>
    psiWorker
      ? psiWorker.evaluate(() => {
          (globalThis as unknown as { gc?: () => void }).gc?.();
          return performance.now();
        })
      : 0;
  let alignedAtMs = 0;
  let pageHeapLimitBytes = 0;
  const stepWindows: Array<StepWindow> = [];
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const window: StepWindow = { name, fromMs: await collectInWorker() };
    stepWindows.push(window);
    stepPeak = await rendererRssBytes();
    const stepStarted = performance.now();
    const value = await run();
    const ms = performance.now() - stepStarted;
    stepPeak = Math.max(stepPeak, await rendererRssBytes());
    window.toMs = await collectInWorker();
    const workerWasmBytes = psiWorker
      ? await psiWorker.evaluate(
          () =>
            (
              globalThis as unknown as {
                __psiWasmMemory?: WebAssembly.Memory;
              }
            ).__psiWasmMemory?.buffer.byteLength ?? 0,
        )
      : 0;
    runPeak = Math.max(runPeak, stepPeak);
    steps[name] = {
      ms,
      value: typeof value === "number" ? value : undefined,
      peakRendererRssBytes: stepPeak,
      workerWasmBytes,
    };
    console.error(name, JSON.stringify(steps[name]));
    return value;
  };
  try {
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => "probeOf" in globalThis);
    await page.evaluate(
      ([browserRole, browserMode]) => {
        probeOf().makeEngine(browserRole, browserMode);
      },
      [role, mode] as const,
    );
    psiWorker = page.workers().at(0) ?? (await page.waitForEvent("worker"));
    alignedAtMs = await collectInWorker();
    pageHeapLimitBytes = await page.evaluate(
      () =>
        (performance as unknown as { memory: { jsHeapSizeLimit: number } })
          .memory.jsHeapSizeLimit,
    );
    await new Promise((resolve) => setTimeout(resolve, 2 * ALIGNMENT_SPAN_MS));
    if (role === "joiner") {
      const built = await step("partnerCreateServerSetup", () =>
        partner.createServerSetup(partyValues(elements, overlap)),
      );
      sets.set("setup", built.setup);
      await step("createClientRequest", () =>
        page.evaluate(([n, m]) => probeOf().createClientRequest(n, m), [
          elements,
          overlap,
        ] as const),
      );
      sets.set(
        "response",
        await step("partnerProcessClientRequest", () =>
          partner.processClientRequest(sets.get("request")!),
        ),
      );
      await step("receiveServerSetup", () =>
        page.evaluate(() => probeOf().receiveServerSetup()),
      );
      if (mode === "count-only") {
        const size = await step("computeIntersectionCardinality", () =>
          page.evaluate(() => probeOf().computeIntersectionCardinality()),
        );
        matchesExpected = size === overlap;
      } else {
        const pairs = await step("computeAssociationTable", () =>
          page.evaluate(() => probeOf().computeAssociationTable()),
        );
        const partnerPosition = new Map(
          built.permutation.map((input, position) => [input, position]),
        );
        matchesExpected =
          pairs.length === overlap &&
          pairs.every(
            ([local, position]) =>
              local < overlap && partnerPosition.get(local) === position,
          );
      }
    } else {
      await step("createServerSetup", () =>
        page.evaluate(([n, m]) => probeOf().createServerSetup(n, m), [
          elements,
          overlap,
        ] as const),
      );
      sets.set(
        "request",
        await step("partnerCreateClientRequest", () =>
          partner.createClientRequest(partyValues(elements, overlap)),
        ),
      );
      await step("processClientRequest", () =>
        page.evaluate(() => probeOf().processClientRequest()),
      );
      await partner.receiveServerSetup(sets.get("setup")!);
      if (mode === "count-only") {
        const size = await step("partnerComputeIntersectionCardinality", () =>
          partner.computeIntersectionCardinality(sets.get("response")!),
        );
        matchesExpected = size === overlap;
      } else {
        const [local, partnerIndices] = await step(
          "partnerComputeAssociationTable",
          () => partner.computeAssociationTable(sets.get("response")!),
        );
        const expected = await page.evaluate(
          (indices) => probeOf().partnerPositionsOf(indices),
          local,
        );
        matchesExpected =
          local.length === overlap &&
          local.every(
            (index, pair) =>
              index < overlap && expected[pair] === partnerIndices[pair],
          );
      }
    }
  } catch (caught) {
    error = [String(caught), ...pageErrors].join("\n").slice(0, 4000);
  } finally {
    clearInterval(sampler);
    partner.dispose();
  }

  await browser.close();
  const heap = parseHeapTrace(
    readFileSync(traceLog, "utf8"),
    alignedAtMs,
    stepWindows,
  );
  rmSync(traceDir, { recursive: true, force: true });
  const workerHeap = Object.fromEntries(
    stepWindows.map((window, index) => [window.name, heap.workerSteps[index]]),
  );
  const record: RoundRecord = {
    date: new Date().toISOString(),
    role,
    mode,
    elements,
    overlap,
    partnerBackend,
    browserVersion: browser.version(),
    steps,
    wallMs: Date.now() - started,
    peakRendererRssBytes: runPeak,
    workerHeap,
    workerHeapLimitBytes: heap.workerHeapLimitBytes,
    pageHeapLimitBytes,
    pageHeapPeakMiB: heap.pageHeapPeakMiB,
    matchesExpected,
    ...(error === undefined ? {} : { error }),
  };
  server.close();
  console.log(JSON.stringify(record));
  if (out) appendFileSync(out, `${JSON.stringify(record)}\n`);
  if (error !== undefined || !matchesExpected) process.exitCode = 1;
}

await main();
