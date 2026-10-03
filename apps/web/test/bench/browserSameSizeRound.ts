import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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
// the worker's engine memory after each step, and whether the result matches
// the known overlap. The steps are the engine's alone: the frame transport,
// the part framing and the element scan a real round adds are not run.
//
//   node apps/web/test/bench/browserSameSizeRound.ts \
//     --role joiner --elements 7500000 [--mode identifier-revealing]
//     [--overlap 1000] [--out results.jsonl]
//
// --role joiner runs createClientRequest, receiveServerSetup and the match in
// the browser; --role starter runs createServerSetup and processClientRequest
// there. The partner runs on the native addon where one ships.

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
  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    if (url.startsWith("/set/")) {
      const name = url.slice("/set/".length);
      if (request.method === "POST") {
        const chunks: Array<Buffer> = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          sets.set(name, new Uint8Array(Buffer.concat(chunks)));
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
  const browser = await chromium.launch({
    args: ["--enable-precise-memory-info"],
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
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    stepPeak = await rendererRssBytes();
    const stepStarted = performance.now();
    const value = await run();
    const ms = performance.now() - stepStarted;
    stepPeak = Math.max(stepPeak, await rendererRssBytes());
    psiWorker ??= page.workers().at(0);
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
    matchesExpected,
    ...(error === undefined ? {} : { error }),
  };
  await browser.close();
  server.close();
  console.log(JSON.stringify(record));
  if (out) appendFileSync(out, `${JSON.stringify(record)}\n`);
  if (error !== undefined || !matchesExpected) process.exitCode = 1;
}

await main();
