import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { InProcessPsiEngine } from "@alcove/core";
import { chromium } from "playwright";

import {
  ALIGNMENT_SPAN_MS,
  V8_TRACE_FLAGS,
  WASM_MEMORY_CAPTURE,
  browserPidFile,
  bundle,
  chromiumWritingTraceTo,
  loadPartnerLibrary,
  parseHeapTrace,
  rendererRssBytes,
  startBenchServer,
} from "./browserRoundMemory.ts";
import { partyValues } from "./partyValues.ts";

import type { StepWindow, WorkerHeapStep } from "./browserRoundMemory.ts";
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
// the part framing and the element scan a real round adds are not run here,
// and browserWrappedRound.ts runs them.
//
//   node apps/web/test/bench/browserSameSizeRound.ts \
//     --role joiner --elements 7500000 [--mode identifier-revealing]
//     [--overlap 1000] [--out results.jsonl] [--trace-out v8-trace.log]
//
// --role joiner runs createClientRequest, receiveServerSetup and the match in
// the browser; --role starter runs createServerSetup and processClientRequest
// there. The partner runs on the native addon where one ships. --trace-out
// keeps the browser's output, V8's collection trace and any fatal message.
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

const PAGE_HTML = `<!doctype html>
<meta charset="utf-8" />
<title>browser same-size PSI round</title>
<script type="module" src="/page.js"></script>
`;

interface StepRecord {
  readonly ms: number;
  readonly value: unknown;
  readonly peakRendererRssBytes: number;
  readonly workerWasmBytes: number;
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

async function main(): Promise<void> {
  const role = flagValue("role", "joiner") as "starter" | "joiner";
  const mode = flagValue("mode", "identifier-revealing") as PsiEngineMode;
  const elements = Number(flagValue("elements", "65536"));
  const overlap = Math.min(Number(flagValue("overlap", "1000")), elements);
  const out = flagValue("out", "");
  const traceOut = flagValue("trace-out", "");

  const [workerSource, pageSource] = await Promise.all([
    bundle(WORKER_ENTRY, WASM_MEMORY_CAPTURE),
    bundle(PAGE_ENTRY, undefined),
  ]);
  const server = await startBenchServer(
    new Map([
      ["/worker.js", workerSource],
      ["/page.js", pageSource],
    ]),
    PAGE_HTML,
  );
  const { origin, sets } = server;

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
    args: ["--enable-precise-memory-info", V8_TRACE_FLAGS],
  });
  const browserPid = Number(readFileSync(browserPidFile(traceDir), "utf8"));
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
    void rendererRssBytes(browserPid)
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
    stepPeak = await rendererRssBytes(browserPid);
    const stepStarted = performance.now();
    const value = await run();
    const ms = performance.now() - stepStarted;
    stepPeak = Math.max(stepPeak, await rendererRssBytes(browserPid));
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
        partner.createServerSetup(partyValues(elements, overlap, "node")),
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
          partner.createClientRequest(partyValues(elements, overlap, "node")),
        ),
      );
      await step("processClientRequest", () =>
        page.evaluate(() => probeOf().processClientRequest()),
      );
      await partner.receiveServerSetup(sets.get("setup")!);
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
  if (traceOut) copyFileSync(traceLog, traceOut);
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
