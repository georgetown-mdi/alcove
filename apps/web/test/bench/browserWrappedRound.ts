import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  BROWSER_PSI_SET_MAX_ELEMENTS,
  InProcessPsiEngine,
  MAX_PSI_DECODE_ELEMENTS,
  generateSharedSecret,
} from "@alcove/core";
import { chromium } from "playwright";

import { startStandaloneBroker } from "../utils/standaloneBroker.ts";

import {
  ALIGNMENT_SPAN_MS,
  V8_TRACE_FLAGS,
  WASM_MEMORY_CAPTURE,
  browserPidFile,
  bundle,
  chromiumWritingTraceTo,
  disableFeaturesSwitchWith,
  loadPartnerLibrary,
  parseHeapTrace,
  rendererRssBytes,
  startBenchServer,
} from "./browserRoundMemory.ts";
import { partyValues } from "./partyValues.ts";

import type {
  MeasuredProbe,
  PageMemorySamples,
} from "./browserWrappedRound.page.ts";
import type { RoundOutcome, RoundSide } from "./wrappedRoundParty.ts";
import type { StepWindow, WorkerHeapStep } from "./browserRoundMemory.ts";
import type { Worker as PageWorker } from "playwright";
import type { PartnerProbe } from "./browserWrappedRound.partner.page.ts";
import type { PsiEngineMode } from "@alcove/core";

// One PSI round with the browser as one party, its sets crossing a WebRTC data
// channel as the web app's do: core's participant over the web app's PeerJS
// connection (openPeerMessageConnection) wrapped in core's
// EncryptedMessageConnection, so the part framing, the element scan, the
// receive ceiling and the wrap's copies of each frame all run. The measured
// page's engine is the web app's own worker-backed WebAssembly engine; the
// partner is core's participant in a second Chromium, driving a Node engine on
// the native addon where one ships. It records what browserSameSizeRound.ts
// records for each engine operation, the same way, and for the measured page
// through the whole round: its V8 heap and the bytes its ArrayBuffers hold
// (DevTools' Runtime.getHeapUsage, once a second), its
// `performance.memory.usedJSHeapSize` (sampled in the page every 100 ms),
// and its renderer's resident set, each by phase, a phase being one engine
// operation or the transport after one.
//
//   node apps/web/test/bench/browserWrappedRound.ts \
//     --role starter --elements 8388608 [--partner-elements 8388608]
//     [--mode identifier-revealing] [--overlap 1000] [--out results.jsonl]
//     [--trace-out v8-trace.log]
//
// --elements is the browser's set, --partner-elements the partner's (the
// same by default). --trace-out keeps the measured browser's output, V8's
// collection trace and any fatal message. Above about 6 million a side, run it as
// `node --max-old-space-size=19075` (the command-line application's heap
// ceiling, docs/spec/FILE_SYNC.md), as browserSameSizeRound.ts says.

const WORKER_ENTRY = fileURLToPath(
  new URL("../../src/psi/workers/psiCrypto.worker.ts", import.meta.url),
);
const PAGE_ENTRY = fileURLToPath(
  new URL("./browserWrappedRound.page.ts", import.meta.url),
);
const PARTNER_ENTRY = fileURLToPath(
  new URL("./browserWrappedRound.partner.page.ts", import.meta.url),
);

const SAMPLE_INTERVAL_MS = 1000;

function pageHtml(title: string, script: string): string {
  return `<!doctype html>
<meta charset="utf-8" />
<title>${title}</title>
<script type="module" src="${script}"></script>
`;
}

interface StepRecord {
  readonly ms: number;
  readonly peakRendererRssBytes: number;
  readonly workerWasmBytes: number;
}

/** The measured page's peaks in one phase of the round. */
interface PhasePeaks {
  peakRendererRssBytes?: number;
  /** DevTools' `usedSize`: the page's V8 heap in use. */
  peakV8HeapUsedBytes?: number;
  /** DevTools' `backingStorageSize`: the bytes the page's ArrayBuffers hold. */
  peakArrayBufferBytes?: number;
  /** The page's own `performance.memory.usedJSHeapSize`. */
  peakUsedJSHeapSizeBytes?: number;
}

interface WrappedRoundRecord {
  readonly date: string;
  readonly role: "starter" | "joiner";
  readonly mode: PsiEngineMode;
  readonly elements: number;
  readonly partnerElements: number;
  readonly overlap: number;
  readonly partnerBackend: "native" | "wasm";
  readonly browserVersion: string;
  readonly wallMs: number;
  readonly matchesExpected: boolean;
  readonly steps: Record<string, StepRecord>;
  readonly partnerStepsMs: Record<string, number>;
  readonly workerHeap: Record<string, WorkerHeapStep>;
  readonly workerHeapLimitBytes?: number;
  readonly pageHeapLimitBytes: number;
  /** The page's V8 heap at the start of its fullest full collection. */
  readonly pageHeapPeakMiB?: number;
  readonly pagePeaks: PhasePeaks & { peakV8PlusArrayBufferBytes: number };
  readonly pageUsedJSHeapSizeSamples: number;
  readonly phases: Record<string, PhasePeaks>;
  readonly peakRendererRssBytes: number;
  readonly hostMemAvailableMinBytes?: number;
  readonly loadAverageOneMinuteMax: number;
  readonly error?: string;
}

// Installed by the page entries; Playwright sends a page function as source
// text, so a call to one in a page function resolves in that page.
declare function measuredProbe(): MeasuredProbe;
declare function partnerProbe(): PartnerProbe;

function flagValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

// MemAvailable from /proc/meminfo, or undefined where the host has none.
function hostMemAvailableBytes(): number | undefined {
  try {
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(
      readFileSync("/proc/meminfo", "utf8"),
    );
    return match ? Number(match[1]) * 1024 : undefined;
  } catch {
    return undefined;
  }
}

function matchesOverlap(outcome: RoundOutcome, overlap: number): boolean {
  return (
    outcome.pairs.length === overlap &&
    outcome.pairs.every(
      ([local, partner]) => local < overlap && local === partner,
    )
  );
}

async function main(): Promise<void> {
  const role = flagValue("role", "joiner") as "starter" | "joiner";
  const mode = flagValue("mode", "identifier-revealing") as PsiEngineMode;
  const elements = Number(flagValue("elements", "65536"));
  const partnerElements = Number(
    flagValue("partner-elements", String(elements)),
  );
  const overlap = Math.min(
    Number(flagValue("overlap", "1000")),
    elements,
    partnerElements,
  );
  const out = flagValue("out", "");
  const traceOut = flagValue("trace-out", "");
  const partnerRole = role === "joiner" ? "starter" : "joiner";
  const starterElements = role === "starter" ? elements : partnerElements;
  const joinerElements = role === "joiner" ? elements : partnerElements;
  const side: RoundSide = {
    id: "browser",
    role,
    mode,
    starterElements,
    joinerElements,
    ownCeiling: BROWSER_PSI_SET_MAX_ELEMENTS,
    partnerCeiling: MAX_PSI_DECODE_ELEMENTS,
  };
  const partnerSide: RoundSide = {
    id: "partner",
    role: partnerRole,
    mode,
    starterElements,
    joinerElements,
    ownCeiling: MAX_PSI_DECODE_ELEMENTS,
    partnerCeiling: BROWSER_PSI_SET_MAX_ELEMENTS,
  };

  const [workerSource, pageSource, partnerSource] = await Promise.all([
    bundle(WORKER_ENTRY, WASM_MEMORY_CAPTURE),
    bundle(PAGE_ENTRY, undefined),
    bundle(PARTNER_ENTRY, undefined),
  ]);
  const server = await startBenchServer(
    new Map([
      ["/worker.js", workerSource],
      ["/page.js", pageSource],
      ["/partner.js", partnerSource],
      ["/partner.html", pageHtml("wrapped PSI round partner", "/partner.js")],
    ]),
    pageHtml("wrapped PSI round", "/page.js"),
  );
  const { origin, sets } = server;
  const broker = await startStandaloneBroker("browserWrappedRound:");
  // Two browsers on one host meet on loopback host candidates, which
  // Chromium otherwise hides behind mDNS names.
  const disableFeatures = await disableFeaturesSwitchWith(
    "WebRtcHideLocalIpsWithMdns",
  );

  const { library, backend: partnerBackend } = await loadPartnerLibrary();
  const partner = new InProcessPsiEngine(library, partnerRole, "partner", mode);
  const traceDir = mkdtempSync(join(tmpdir(), "browser-wrapped-round-"));
  const traceLog = join(traceDir, "v8-trace.log");
  writeFileSync(traceLog, "");
  const browser = await chromium.launch({
    executablePath: chromiumWritingTraceTo(traceDir, traceLog),
    args: ["--enable-precise-memory-info", V8_TRACE_FLAGS, disableFeatures],
  });
  // Only the measured browser's renderer is sampled, not the partner's.
  const measuredBrowserPid = Number(
    readFileSync(browserPidFile(traceDir), "utf8"),
  );
  const partnerBrowser = await chromium.launch({ args: [disableFeatures] });
  const page = await browser.newPage();
  const partnerPage = await partnerBrowser.newPage();
  const pageErrors: Array<string> = [];
  page.on("pageerror", (error) => pageErrors.push(`page: ${String(error)}`));
  page.on("crash", () => pageErrors.push("the measured page crashed"));
  partnerPage.on("pageerror", (error) =>
    pageErrors.push(`partner: ${String(error)}`),
  );
  partnerPage.on("crash", () => pageErrors.push("the partner's page crashed"));

  let phase = "connect";
  const phases = new Map<string, PhasePeaks>();
  // A phase no sample landed in holds no figure, rather than a zero.
  const raise = (name: string, figure: keyof PhasePeaks, bytes: number) => {
    const peaks = phases.get(name) ?? {};
    peaks[figure] = Math.max(peaks[figure] ?? 0, bytes);
    phases.set(name, peaks);
  };
  let stepPeak = 0;
  let runPeak = 0;
  let peakV8PlusArrayBufferBytes = 0;
  let hostMemAvailableMinBytes: number | undefined;
  let loadAverageOneMinuteMax = loadavg()[0];
  const noteRss = (bytes: number): void => {
    stepPeak = Math.max(stepPeak, bytes);
    runPeak = Math.max(runPeak, bytes);
    raise(phase, "peakRendererRssBytes", bytes);
  };

  const cdp = await page.context().newCDPSession(page);
  let sampling = false;
  const sampler = setInterval(() => {
    if (sampling) return;
    sampling = true;
    const available = hostMemAvailableBytes();
    if (available !== undefined)
      hostMemAvailableMinBytes = Math.min(
        hostMemAvailableMinBytes ?? available,
        available,
      );
    loadAverageOneMinuteMax = Math.max(loadAverageOneMinuteMax, loadavg()[0]);
    void Promise.all([
      rendererRssBytes(measuredBrowserPid).then(noteRss),
      cdp.send("Runtime.getHeapUsage").then((usage) => {
        raise(phase, "peakV8HeapUsedBytes", usage.usedSize);
        raise(phase, "peakArrayBufferBytes", usage.backingStorageSize);
        peakV8PlusArrayBufferBytes = Math.max(
          peakV8PlusArrayBufferBytes,
          usage.usedSize + usage.backingStorageSize,
        );
      }),
    ])
      .catch(() => undefined)
      .finally(() => {
        sampling = false;
      });
  }, SAMPLE_INTERVAL_MS);

  let psiWorker: PageWorker | undefined;
  // The worker's clock just after a collection forced in it.
  const collectInWorker = async (): Promise<number> =>
    psiWorker
      ? psiWorker.evaluate(() => {
          (globalThis as unknown as { gc?: () => void }).gc?.();
          return performance.now();
        })
      : 0;
  const steps: Record<string, StepRecord> = {};
  const stepWindows: Array<StepWindow> = [];
  const timesSeen = new Map<string, number>();
  let openStep:
    { name: string; window: StepWindow; startedAt: number } | undefined;
  await page.exposeFunction(
    "benchStepBoundary",
    async (edge: "begin" | "end", operation: string): Promise<string> => {
      if (edge === "begin") {
        const seen = (timesSeen.get(operation) ?? 0) + 1;
        timesSeen.set(operation, seen);
        const name = seen === 1 ? operation : `${operation} ${seen}`;
        const window: StepWindow = { name, fromMs: await collectInWorker() };
        stepWindows.push(window);
        phase = name;
        stepPeak = 0;
        noteRss(await rendererRssBytes(measuredBrowserPid));
        openStep = { name, window, startedAt: performance.now() };
        return name;
      }
      if (!openStep) throw new Error(`${operation} ended without a start`);
      const { name, window, startedAt } = openStep;
      openStep = undefined;
      const ms = performance.now() - startedAt;
      noteRss(await rendererRssBytes(measuredBrowserPid));
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
      steps[name] = { ms, peakRendererRssBytes: stepPeak, workerWasmBytes };
      console.error(name, JSON.stringify(steps[name]));
      phase = `after ${name}`;
      return phase;
    },
  );

  const partnerStepsMs: Record<string, number> = {};
  const take = (name: string): Uint8Array => {
    const bytes = sets.get(name);
    if (!bytes) throw new Error(`the partner's page sent no ${name} set`);
    sets.delete(name);
    return bytes;
  };
  const partnerValues = (count: number): Array<string> =>
    partyValues(count, overlap, "node");
  const partnerOperation = async (
    operation: string,
    count: number | undefined,
  ): Promise<unknown> => {
    switch (operation) {
      case "createServerSetup": {
        const built = await partner.createServerSetup(partnerValues(count!));
        sets.set("partner-setup", built.setup);
        sets.set(
          "partner-permutation",
          new Uint8Array(Int32Array.from(built.permutation).buffer),
        );
        return undefined;
      }
      case "createClientRequest":
        sets.set(
          "partner-request",
          await partner.createClientRequest(partnerValues(count!)),
        );
        return undefined;
      case "processClientRequest":
        sets.set(
          "partner-response",
          await partner.processClientRequest(take("partner-input")),
        );
        return undefined;
      case "receiveServerSetup":
        return partner.receiveServerSetup(take("partner-input"));
      case "receiveServerSetupPiece":
        return partner.receiveServerSetupPiece(take("partner-input"));
      case "completeServerSetup":
        return partner.completeServerSetup();
      case "discardServerSetup":
        return partner.discardServerSetup();
      case "computeAssociationTable":
        return partner.computeAssociationTable(take("partner-input"));
      case "dispose":
        partner.dispose();
        return undefined;
    }
    throw new Error(`the bench's partner engine has no ${operation}`);
  };
  await partnerPage.exposeFunction(
    "benchPartnerEngine",
    async (operation: string, count?: number): Promise<unknown> => {
      const started = performance.now();
      try {
        return await partnerOperation(operation, count);
      } finally {
        partnerStepsMs[operation] =
          (partnerStepsMs[operation] ?? 0) + performance.now() - started;
      }
    },
  );

  // A failure on one side would leave the other waiting on the channel, so
  // the first failure closes both browsers.
  const stopOnFailure = <T>(run: Promise<T>): Promise<T> =>
    run.catch(async (error: unknown) => {
      await Promise.allSettled([browser.close(), partnerBrowser.close()]);
      throw error;
    });

  let alignedAtMs = 0;
  let pageHeapLimitBytes = 0;
  let matchesExpected = false;
  let error: string | undefined;
  let pageMemory: PageMemorySamples | undefined;
  const started = Date.now();
  try {
    await Promise.all([
      page.goto(`${origin}/`),
      partnerPage.goto(`${origin}/partner.html`),
    ]);
    await Promise.all([
      page.waitForFunction(() => "measuredProbe" in globalThis),
      partnerPage.waitForFunction(() => "partnerProbe" in globalThis),
    ]);
    await page.evaluate((roundSide) => {
      measuredProbe().makeEngine(roundSide);
    }, side);
    psiWorker = page.workers().at(0) ?? (await page.waitForEvent("worker"));
    alignedAtMs = await collectInWorker();
    pageHeapLimitBytes = await page.evaluate(
      () =>
        (performance as unknown as { memory: { jsHeapSizeLimit: number } })
          .memory.jsHeapSizeLimit,
    );
    await new Promise((resolve) => setTimeout(resolve, 2 * ALIGNMENT_SPAN_MS));

    const sharedSecret = generateSharedSecret();
    const sessionKey = Array.from(randomBytes(32));
    await partnerPage.evaluate(
      ([port, secret]) => partnerProbe().listen(port, secret),
      [broker.port, sharedSecret] as const,
    );
    await Promise.all([
      stopOnFailure(
        partnerPage.evaluate((key) => partnerProbe().accept(key), sessionKey),
      ),
      stopOnFailure(
        page.evaluate(
          ([port, secret, key]) => measuredProbe().connect(port, secret, key),
          [broker.port, sharedSecret, sessionKey] as const,
        ),
      ),
    ]);
    phase = "before the first operation";
    const [outcome] = await Promise.all([
      stopOnFailure(
        page.evaluate(
          ([roundSide, count, shared]) =>
            measuredProbe().run(roundSide, count, shared),
          [side, elements, overlap] as const,
        ),
      ),
      stopOnFailure(
        partnerPage.evaluate(
          ([roundSide, count]) => partnerProbe().run(roundSide, count),
          [partnerSide, partnerElements] as const,
        ),
      ),
    ]);
    matchesExpected = matchesOverlap(outcome, overlap);
    pageMemory = await page.evaluate(() => measuredProbe().pageMemory());
  } catch (caught) {
    error = [String(caught), ...pageErrors].join("\n").slice(0, 4000);
  } finally {
    clearInterval(sampler);
    partner.dispose();
  }
  const wallMs = Date.now() - started;

  await Promise.allSettled([browser.close(), partnerBrowser.close()]);
  await broker.stop();
  server.close();
  const heap = parseHeapTrace(
    readFileSync(traceLog, "utf8"),
    alignedAtMs,
    stepWindows,
  );
  if (traceOut) copyFileSync(traceLog, traceOut);
  rmSync(traceDir, { recursive: true, force: true });
  for (const [name, peak] of Object.entries(pageMemory?.peakBytesByPhase ?? {}))
    raise(name, "peakUsedJSHeapSizeBytes", peak);
  const peakOverPhases = (figure: keyof PhasePeaks): number =>
    Math.max(0, ...[...phases.values()].map((peaks) => peaks[figure] ?? 0));
  const record: WrappedRoundRecord = {
    date: new Date().toISOString(),
    role,
    mode,
    elements,
    partnerElements,
    overlap,
    partnerBackend,
    browserVersion: browser.version(),
    wallMs,
    matchesExpected,
    steps,
    partnerStepsMs,
    workerHeap: Object.fromEntries(
      stepWindows.map((window, index) => [
        window.name,
        heap.workerSteps[index],
      ]),
    ),
    workerHeapLimitBytes: heap.workerHeapLimitBytes,
    pageHeapLimitBytes,
    pageHeapPeakMiB: heap.pageHeapPeakMiB,
    pagePeaks: {
      peakRendererRssBytes: runPeak,
      peakV8HeapUsedBytes: peakOverPhases("peakV8HeapUsedBytes"),
      peakArrayBufferBytes: peakOverPhases("peakArrayBufferBytes"),
      peakV8PlusArrayBufferBytes,
      peakUsedJSHeapSizeBytes: pageMemory?.peakBytes,
    },
    pageUsedJSHeapSizeSamples: pageMemory?.samples ?? 0,
    phases: Object.fromEntries(phases),
    peakRendererRssBytes: runPeak,
    hostMemAvailableMinBytes,
    loadAverageOneMinuteMax,
    ...(error === undefined ? {} : { error }),
  };
  console.log(JSON.stringify(record));
  if (out) appendFileSync(out, `${JSON.stringify(record)}\n`);
  if (error !== undefined || !matchesExpected) process.exitCode = 1;
}

await main();
