// One joiner's streamed match, in two processes: `generate` builds the round
// on the native addon where one ships and writes it to a directory, and
// `match-wasm` or `match-native` matches it on that engine, so the memory,
// heap and resident set the match reports are its own. Each prints one JSON
// line; `streamedMatchLarge.case.ts` spawns both and reads them.
//
// Usage: node --expose-gc --import tsx streamedMatchLarge.probe.ts
//          <generate|match-wasm|match-native>
//          <identifier-revealing|count-only> <elements> <overlap> <directory>
//
// Both sides hold `elements` values, the first `overlap` of them shared. The
// joiner's key is written with the round, so the request built under it is
// the one the match decrypts on either engine.

import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { GCProfiler, getHeapStatistics } from "node:v8";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { MAX_FRAME_SIZE_BYTES } from "../../src/connection/frameSize";
import { InProcessPsiEngine } from "../../src/psi/psiEngine";
import { PSI_SET_PART_HEADER_BYTES } from "../../src/psi/psiSetParts";
import { psiEngineOptionsForBackend } from "../../src/psi/psiWasmBudget";
import { loadNativeAddonOrSkip } from "../utils/nativeAddon";

import type { PsiEngineMode } from "../../src/psi/psiEngine";

/** What `generate` prints. */
export interface GenerateProbeResult {
  readonly backend: "native" | "wasm";
  readonly setupMs: number;
  readonly requestMs: number;
  readonly responseMs: number;
  readonly setupBytes: number;
  readonly responseBytes: number;
  readonly maxRssBytes: number;
}

/** The WebAssembly engine's linear memory over a match, in bytes. */
export interface WasmMemoryFigures {
  readonly startBytes: number;
  readonly afterSetupBytes: number;
  readonly peakBytes: number;
}

/** The engine a match step runs on. */
export type MatchBackend = "wasm" | "native";

/** What `match-wasm` and `match-native` print. */
export interface MatchProbeResult {
  readonly backend: MatchBackend;
  readonly mode: PsiEngineMode;
  readonly elements: number;
  readonly overlap: number;
  readonly setupPieces: number;
  readonly setupMs: number;
  readonly matchMs: number;
  /** Undefined on the native addon, whose memory is in the resident set. */
  readonly wasm: WasmMemoryFigures | undefined;
  readonly rssAfterSetupBytes: number;
  readonly heapPeakBytes: number;
  readonly heapLimitBytes: number;
  readonly maxRssBytes: number;
  readonly matchesExpected: boolean;
}

// The set bytes one part holds on a connection with no envelope, which is
// how the joiner's setup arrives at the engine (psiSetPartPayloadBytes).
const SETUP_PIECE_BYTES = MAX_FRAME_SIZE_BYTES - PSI_SET_PART_HEADER_BYTES;

const GENERATE_SLICE_ELEMENTS = 1 << 20;

const KEY_FILE = "joiner.key";
const SETUP_FILE = "setup.bin";
const RESPONSE_FILE = "response.bin";
// Each shared value's position in the sorted setup, by its input index.
const POSITIONS_FILE = "shared-positions.bin";

const gc = (): void => (globalThis as { gc?: () => void }).gc?.();

const probeStarted = performance.now();

// Progress on stderr, with the peak resident set so far, so a run killed at
// its timeout or its memory limit still shows how far it got; stdout has the
// one result line.
function phase(name: string): void {
  const peakMib = process.resourceUsage().maxRSS / 1024;
  process.stderr.write(
    `${((performance.now() - probeStarted) / 1000).toFixed(1)} s ` +
      `(peak rss ${peakMib.toFixed(0)} MiB) ${name}\n`,
  );
}

let wasmMemory: WebAssembly.Memory | undefined;

// The engine's linear memory is an export of the instance the module creates,
// so it is caught as the module instantiates; it only grows, so its length
// after the match is the match's high-water mark.
function installWasmMemoryProbe(): void {
  const capture = <T>(result: T): T => {
    const instance =
      (result as { instance?: WebAssembly.Instance }).instance ??
      (result as WebAssembly.Instance);
    for (const value of Object.values(instance.exports ?? {}))
      if (value instanceof WebAssembly.Memory) {
        wasmMemory ??= value;
        break;
      }
    return result;
  };
  const instantiate = WebAssembly.instantiate.bind(WebAssembly);
  WebAssembly.instantiate = ((...args: Parameters<typeof instantiate>) =>
    instantiate(...args).then(capture)) as typeof WebAssembly.instantiate;
}

function wasmBytes(): number {
  if (wasmMemory === undefined)
    throw new Error(
      "installWasmMemoryProbe caught no WebAssembly.Memory export as the " +
        "engine instantiated, so the engine memory cannot be measured",
    );
  return wasmMemory.buffer.byteLength;
}

// `library` whose every new client is created from `key`, so an engine built
// on it in either process holds the one joiner key.
function libraryWithClientKey(
  library: PSILibrary,
  key: Uint8Array,
): PSILibrary {
  const client = library.client!;
  return {
    ...library,
    client: {
      ...client,
      createWithNewKey: (revealIntersection?: boolean) =>
        client.createFromKey(key, revealIntersection),
    },
  };
}

function values(
  party: "s" | "c",
  start: number,
  end: number,
  overlap: number,
): Array<string> {
  return Array.from({ length: end - start }, (_, k) => {
    const i = start + k;
    return i < overlap ? `shared-${i}` : `${party}-${i}`;
  });
}

async function generate(
  mode: PsiEngineMode,
  elements: number,
  overlap: number,
  directory: string,
): Promise<GenerateProbeResult> {
  const native = await loadNativeAddonOrSkip();
  const library =
    native ?? (await (await import("@openmined/psi.js")).default());
  const keyClient = library.client!.createWithNewKey(
    mode === "identifier-revealing",
  );
  const key = keyClient.getPrivateKeyBytes();
  keyClient.delete();
  writeFileSync(join(directory, KEY_FILE), key);

  const starter = new InProcessPsiEngine(library, "starter", "starter", mode);
  const joiner = new InProcessPsiEngine(
    libraryWithClientKey(library, key),
    "joiner",
    "joiner",
    mode,
  );
  try {
    phase("building the setup");
    let started = performance.now();
    let setupBytes: number;
    {
      const { setup, permutation } = await starter.createServerSetup(
        values("s", 0, elements, overlap),
      );
      setupBytes = setup.byteLength;
      writeFileSync(join(directory, SETUP_FILE), setup);
      const sharedPositions = new Int32Array(overlap);
      permutation.forEach((input, position) => {
        if (input < overlap) sharedPositions[input] = position;
      });
      writeFileSync(join(directory, POSITIONS_FILE), sharedPositions);
    }
    const setupMs = performance.now() - started;
    gc();

    // A serialized response is a list of elements, so the responses to
    // consecutive slices of the request join into the response to the whole
    // request, in request order: built a slice at a time, the round never
    // holds a whole request. A count-only response is then sorted only within
    // each slice, which the count does not depend on.
    phase("building the request and response");
    let requestMs = 0;
    let responseMs = 0;
    let responseBytes = 0;
    const responseFile = openSync(join(directory, RESPONSE_FILE), "w");
    try {
      for (let start = 0; start < elements; start += GENERATE_SLICE_ELEMENTS) {
        const end = Math.min(elements, start + GENERATE_SLICE_ELEMENTS);
        started = performance.now();
        const request = await joiner.createClientRequest(
          values("c", start, end, overlap),
        );
        requestMs += performance.now() - started;
        started = performance.now();
        const response = await starter.processClientRequest(request);
        responseMs += performance.now() - started;
        writeSync(responseFile, response);
        responseBytes += response.byteLength;
      }
    } finally {
      closeSync(responseFile);
    }
    phase("done");
    return {
      backend: native ? "native" : "wasm",
      setupMs,
      requestMs,
      responseMs,
      setupBytes,
      responseBytes,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
    };
  } finally {
    starter.dispose();
    joiner.dispose();
  }
}

// Each pair names a shared value at its own input index and its setup
// position, in setup position order, and there is one per shared value.
function pairsMatchExpected(
  local: ReadonlyArray<number>,
  partner: ReadonlyArray<number>,
  sharedPositions: Int32Array,
): boolean {
  if (local.length !== sharedPositions.length) return false;
  for (let pair = 0; pair < local.length; pair += 1) {
    const input = local[pair]!;
    if (input >= sharedPositions.length) return false;
    if (sharedPositions[input] !== partner[pair]) return false;
    if (pair > 0 && partner[pair]! <= partner[pair - 1]!) return false;
  }
  return true;
}

async function loadMatchLibrary(backend: MatchBackend): Promise<PSILibrary> {
  if (backend === "wasm") {
    installWasmMemoryProbe();
    const { default: loadWasm } = await import("@openmined/psi.js");
    return loadWasm();
  }
  const native = await loadNativeAddonOrSkip();
  if (native === undefined)
    throw new Error("no native addon ships for this platform");
  return native;
}

async function match(
  backend: MatchBackend,
  mode: PsiEngineMode,
  elements: number,
  overlap: number,
  directory: string,
): Promise<MatchProbeResult> {
  const library = await loadMatchLibrary(backend);
  const key = new Uint8Array(readFileSync(join(directory, KEY_FILE)));
  const joiner = new InProcessPsiEngine(
    libraryWithClientKey(library, key),
    "joiner",
    "joiner",
    mode,
    psiEngineOptionsForBackend(backend),
  );
  const engineBytes = (): number => (backend === "wasm" ? wasmBytes() : 0);
  joiner.observeProcessedElements((processed) =>
    phase(`matched ${processed} response elements`),
  );
  try {
    gc();
    const wasmStartBytes = engineBytes();
    // V8 reports the heap in use as each collection starts, which is where
    // the heap stands highest between collections.
    const profiler = new GCProfiler();
    profiler.start();

    phase("feeding the setup");
    let started = performance.now();
    let setupPieces = 0;
    const setupFile = openSync(join(directory, SETUP_FILE), "r");
    try {
      let left = fstatSync(setupFile).size;
      while (left > 0) {
        const piece = new Uint8Array(Math.min(left, SETUP_PIECE_BYTES));
        if (readSync(setupFile, piece) !== piece.byteLength)
          throw new Error("the setup file ended early");
        await joiner.receiveServerSetupPiece(piece);
        left -= piece.byteLength;
        setupPieces += 1;
      }
    } finally {
      closeSync(setupFile);
    }
    await joiner.completeServerSetup();
    const setupMs = performance.now() - started;
    const wasmAfterSetupBytes = engineBytes();
    const rssAfterSetupBytes = process.memoryUsage.rss();

    const response = new Uint8Array(
      readFileSync(join(directory, RESPONSE_FILE)),
    );
    phase("matching");
    started = performance.now();
    let matchesExpected: boolean;
    if (mode === "identifier-revealing") {
      const [local, partner] = await joiner.computeAssociationTable(response);
      const sharedPositions = new Int32Array(
        new Uint8Array(readFileSync(join(directory, POSITIONS_FILE))).buffer,
      );
      matchesExpected =
        local.length === overlap &&
        pairsMatchExpected(local, partner, sharedPositions);
    } else {
      matchesExpected =
        (await joiner.computeIntersectionCardinality(response)) === overlap;
    }
    const matchMs = performance.now() - started;
    const heapEndBytes = getHeapStatistics().used_heap_size;
    const collections = profiler.stop()?.statistics ?? [];
    const wasmPeakBytes = engineBytes();
    phase("done");
    return {
      backend,
      mode,
      elements,
      overlap,
      setupPieces,
      setupMs,
      matchMs,
      wasm:
        backend === "wasm"
          ? {
              startBytes: wasmStartBytes,
              afterSetupBytes: wasmAfterSetupBytes,
              peakBytes: wasmPeakBytes,
            }
          : undefined,
      rssAfterSetupBytes,
      heapPeakBytes: Math.max(
        heapEndBytes,
        ...collections.map((c) => c.beforeGC.heapStatistics.usedHeapSize),
      ),
      heapLimitBytes: getHeapStatistics().heap_size_limit,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
      matchesExpected,
    };
  } finally {
    joiner.dispose();
  }
}

async function main(): Promise<void> {
  const [step, modeArg, elementsArg, overlapArg, directory] =
    process.argv.slice(2);
  const mode = modeArg as PsiEngineMode;
  const elements = Number(elementsArg);
  const overlap = Number(overlapArg);
  if (directory === undefined) throw new Error("no round directory given");
  const result =
    step === "generate"
      ? await generate(mode, elements, overlap, directory)
      : step === "match-wasm"
        ? await match("wasm", mode, elements, overlap, directory)
        : step === "match-native"
          ? await match("native", mode, elements, overlap, directory)
          : undefined;
  if (result === undefined) throw new Error(`no probe step ${step}`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

await main();
