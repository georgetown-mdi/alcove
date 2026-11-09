import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

import {
  BROWSER_PSI_SET_MAX_ELEMENTS,
  InProcessPsiEngine,
  MAX_PSI_DECODE_ELEMENTS,
  PARTNER_SILENCE_BOUND_MS,
  STILL_WORKING_INTERVAL_MS,
  generateSharedSecret,
} from "@alcove/core";
import { chromium } from "playwright";

import { startStandaloneBroker } from "../utils/standaloneBroker.ts";

import {
  bundle,
  disableFeaturesSwitchWith,
  loadPartnerLibrary,
  startBenchServer,
} from "./browserRoundMemory.ts";
import { exposeNodePartnerEngine } from "./nodePartnerEngine.ts";
import { partyValues } from "./partyValues.ts";

import type { Browser, BrowserContext, Page } from "playwright";
import type {
  PageTelemetry,
  StillWorkingProbe,
} from "./browserStillWorking.page.ts";
import type { PartyLog, PartyResult, StepTime } from "./stillWorkingParty.ts";
import type { RoundOutcome, RoundSide } from "./wrappedRoundParty.ts";
import type { StillWorkingPartnerProbe } from "./browserStillWorking.partner.page.ts";

// One PSI round through core's still-working layer with the browser as the
// party that computes, its page hidden, to time the still-working frames a
// hidden tab's timer sends. Both parties run core's participant over the web
// app's PeerJS connection (openPeerMessageConnection, with the web app's own
// timeouts) wrapped in core's EncryptedMessageConnection, each through the
// layer a WebRTC exchange's PSI phase runs through. The measured page's engine
// is the web app's worker-backed WebAssembly engine; the partner is core's
// participant in a second Chromium driving a Node engine on the native addon
// where one ships, as in browserWrappedRound.ts.
//
// The measured browser runs headed, without the switches Playwright adds that
// turn off a hidden page's timer throttling and backgrounding, and attached
// over CDP with Playwright's default overrides off, whose focus emulation
// keeps a page visible behind another tab. Its page is hidden for the whole
// round by bringing a second page in its window to the front: that throttling
// is what is measured. On a host with no display, run it under `xvfb-run`.
//
//   node apps/web/test/bench/browserStillWorking.ts \
//     --role starter --elements 8388608 [--partner-elements 8388608]
//     [--overlap 1000] [--out results.jsonl]
//
// It writes one JSON record: the time of every frame the measured page sent
// and the partner read, and the largest gap between them through the PSI phase
// and through the measured page's longest step; the main thread's Long Tasks;
// the page's lifecycle events and `document.wasDiscarded`; its visibility,
// sampled on a timer in the page; each side's engine operations; and the
// outcome, the matched pairs or each side's failure and its catalog cause.
// Times in the record are milliseconds from the start of the round.
//
// --role starter has the browser build the server setup and then answer the
// request, the browser's two longest steps at the ceiling. Above about 6
// million a side, run it as `node --max-old-space-size=19075`, as
// browserWrappedRound.ts says.

const WORKER_ENTRY = fileURLToPath(
  new URL("../../src/psi/workers/psiCrypto.worker.ts", import.meta.url),
);
const PAGE_ENTRY = fileURLToPath(
  new URL("./browserStillWorking.page.ts", import.meta.url),
);
const PARTNER_ENTRY = fileURLToPath(
  new URL("./browserStillWorking.partner.page.ts", import.meta.url),
);

/** Playwright's switches that keep a hidden page's timers and renderer at
 * full rate, left off the measured browser. */
const THROTTLING_SWITCHES = [
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

/** How long the bench waits on a page answering for its records. */
const TELEMETRY_WAIT_MS = 60_000;

const TOP_LONG_TASKS = 5;

// Installed by the page entries; Playwright sends a page function as source
// text, so a call to one in a page function resolves in that page.
declare function stillWorkingProbe(): StillWorkingProbe;
declare function stillWorkingPartnerProbe(): StillWorkingPartnerProbe;

function flagValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

function pageHtml(title: string, script: string): string {
  return `<!doctype html>
<meta charset="utf-8" />
<title>${title}</title>
<script type="module" src="${script}"></script>
`;
}

function withTimeout<T>(run: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    run.catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(resolve, ms)),
  ]);
}

/** The largest gap between consecutive `times`, with `endMs` as the last,
 * among those that overlap `[fromMs, toMs]`. */
function largestGap(
  times: ReadonlyArray<number>,
  endMs: number | undefined,
  fromMs = -Infinity,
  toMs = Infinity,
): { gapMs: number; fromMs: number; toMs: number } | undefined {
  const points = [...times, ...(endMs === undefined ? [] : [endMs])].sort(
    (a, b) => a - b,
  );
  let largest: { gapMs: number; fromMs: number; toMs: number } | undefined;
  for (let i = 1; i < points.length; i++) {
    const [from, to] = [points[i - 1], points[i]];
    if (to <= fromMs || from >= toMs) continue;
    if (largest === undefined || to - from > largest.gapMs)
      largest = { gapMs: to - from, fromMs: from, toMs: to };
  }
  return largest;
}

/**
 * The measured browser: Chromium started headed with Playwright's own switches
 * less {@link THROTTLING_SWITCHES}, and attached over CDP with Playwright's
 * default overrides off. A page Playwright opens itself has focus emulation
 * on, which keeps it visible behind another tab.
 */
async function launchMeasuredBrowser(disableFeatures: string): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}> {
  const composed = await chromium.launchServer({ headless: false });
  const defaults = composed.process().spawnargs.slice(1);
  await composed.close();
  const userDataDir = mkdtempSync(join(tmpdir(), "browser-still-working-"));
  const owned = [
    ...THROTTLING_SWITCHES,
    "--remote-debugging-pipe",
    "--no-startup-window",
  ];
  const child = spawn(
    chromium.executablePath(),
    [
      ...defaults.filter(
        (arg) =>
          !owned.includes(arg) &&
          !arg.startsWith("--user-data-dir=") &&
          !arg.startsWith("--disable-features="),
      ),
      disableFeatures,
      `--user-data-dir=${userDataDir}`,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const exited = new Promise<void>((resolve) => child.once("exit", resolve));
  const portFile = join(userDataDir, "DevToolsActivePort");
  let port: string | undefined;
  for (let waited = 0; port === undefined; waited += 100) {
    if (waited > 30_000)
      throw new Error("the measured browser opened no debugging port");
    try {
      port = readFileSync(portFile, "utf8").split("\n")[0];
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
    noDefaults: true,
  });
  const [context] = browser.contexts();
  const page = context.pages()[0] ?? (await context.newPage());
  return {
    browser,
    context,
    page,
    close: async () => {
      await browser.close().catch(() => undefined);
      child.kill();
      await exited;
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
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
  const role = flagValue("role", "starter") as "starter" | "joiner";
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
  const mode = "identifier-revealing";
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
    strategy: "cascade",
  };
  const partnerSide: RoundSide = {
    ...side,
    id: "partner",
    role: partnerRole,
    ownCeiling: MAX_PSI_DECODE_ELEMENTS,
    partnerCeiling: BROWSER_PSI_SET_MAX_ELEMENTS,
  };

  const [workerSource, pageSource, partnerSource] = await Promise.all([
    bundle(WORKER_ENTRY, undefined),
    bundle(PAGE_ENTRY, undefined),
    bundle(PARTNER_ENTRY, undefined),
  ]);
  const server = await startBenchServer(
    new Map([
      ["/worker.js", workerSource],
      ["/page.js", pageSource],
      ["/partner.js", partnerSource],
      ["/partner.html", pageHtml("still-working partner", "/partner.js")],
    ]),
    pageHtml("still-working round", "/page.js"),
  );
  const broker = await startStandaloneBroker("browserStillWorking:");
  // Two browsers on one host meet on loopback host candidates, which
  // Chromium otherwise hides behind mDNS names.
  const disableFeatures = await disableFeaturesSwitchWith(
    "WebRtcHideLocalIpsWithMdns",
  );
  const { library, backend: partnerBackend } = await loadPartnerLibrary();
  const partner = new InProcessPsiEngine(library, partnerRole, "partner", mode);

  const measured = await launchMeasuredBrowser(disableFeatures);
  const { browser, context, page } = measured;
  const partnerBrowser = await chromium.launch({ args: [disableFeatures] });
  const partnerPage = await partnerBrowser.newPage();
  const pageEvents: Array<{ event: string; atMs: number }> = [];
  const note = (event: string) => pageEvents.push({ event, atMs: Date.now() });
  page.on("pageerror", (error) => note(`page error: ${String(error)}`));
  page.on("crash", () => note("crash"));
  page.on("close", () => note("close"));
  page.on("load", () => note("load"));
  partnerPage.on("pageerror", (error) =>
    note(`partner page error: ${String(error)}`),
  );

  const partnerStepsMs: Record<string, number> = {};
  await exposeNodePartnerEngine(
    partnerPage,
    partner,
    server.sets,
    (count) => partyValues(count, overlap, "node"),
    partnerStepsMs,
  );

  let roundStartMs = Date.now();
  let hiddenAtMs: number | undefined;
  const results: { browser?: PartyResult; partner?: PartyResult } = {};
  let error: string | undefined;
  const started = Date.now();
  try {
    await Promise.all([
      page.goto(`${server.origin}/`),
      partnerPage.goto(`${server.origin}/partner.html`),
    ]);
    await Promise.all([
      page.waitForFunction(() => "stillWorkingProbe" in globalThis),
      partnerPage.waitForFunction(
        () => "stillWorkingPartnerProbe" in globalThis,
      ),
    ]);
    await page.evaluate((roundSide) => {
      stillWorkingProbe().makeEngine(roundSide);
    }, side);
    const sharedSecret = generateSharedSecret();
    const sessionKey = Array.from(randomBytes(32));
    await partnerPage.evaluate(
      ([port, secret]) => stillWorkingPartnerProbe().listen(port, secret),
      [broker.port, sharedSecret] as const,
    );
    await Promise.all([
      partnerPage.evaluate(
        (key) => stillWorkingPartnerProbe().accept(key),
        sessionKey,
      ),
      page.evaluate(
        ([port, secret, key]) => stillWorkingProbe().connect(port, secret, key),
        [broker.port, sharedSecret, sessionKey] as const,
      ),
    ]);

    const cover = await context.newPage();
    await cover.bringToFront();
    hiddenAtMs = Date.now();

    // A side that fails leaves the other waiting until its silence bound, so
    // the first failure ends the round once both pages' records are read.
    let failed: () => void = () => undefined;
    const firstFailure = new Promise<void>((resolve) => (failed = resolve));
    const settle =
      (name: "browser" | "partner") =>
      (result: PartyResult): void => {
        results[name] = result;
        if ("failure" in result) failed();
      };
    const closed = (reason: unknown): PartyResult => ({
      failure: { message: `the page did not answer: ${String(reason)}` },
    });
    roundStartMs = Date.now();
    const runs = Promise.all([
      page
        .evaluate(
          ([roundSide, count, shared]) =>
            stillWorkingProbe().run(roundSide, count, shared),
          [side, elements, overlap] as const,
        )
        .catch(closed)
        .then(settle("browser")),
      partnerPage
        .evaluate(
          ([roundSide, count]) =>
            stillWorkingPartnerProbe().run(roundSide, count),
          [partnerSide, partnerElements] as const,
        )
        .catch(closed)
        .then(settle("partner")),
    ]);
    await Promise.race([runs, firstFailure]);
  } catch (caught) {
    error = String(caught).slice(0, 4000);
  }
  const wallMs = Date.now() - started;

  const telemetry = await withTimeout(
    page.evaluate(() => stillWorkingProbe().telemetry()),
    TELEMETRY_WAIT_MS,
  );
  const partnerLog = await withTimeout(
    partnerPage.evaluate(() => stillWorkingPartnerProbe().log()),
    TELEMETRY_WAIT_MS,
  );
  const browserVersion = browser.version();
  await Promise.allSettled([measured.close(), partnerBrowser.close()]);
  partner.dispose();
  await broker.stop();
  server.close();

  const record = composeRecord({
    role,
    elements,
    partnerElements,
    overlap,
    partnerBackend,
    browserVersion,
    wallMs,
    roundStartMs,
    hiddenAtMs,
    results,
    telemetry,
    partnerLog,
    partnerStepsMs,
    pageEvents,
    error,
  });
  console.log(JSON.stringify(record));
  if (out) appendFileSync(out, `${JSON.stringify(record)}\n`);
  if (record.error !== undefined || !record.outcome.matched)
    process.exitCode = 1;
}

interface RecordInputs {
  readonly role: "starter" | "joiner";
  readonly elements: number;
  readonly partnerElements: number;
  readonly overlap: number;
  readonly partnerBackend: "native" | "wasm";
  readonly browserVersion: string;
  readonly wallMs: number;
  readonly roundStartMs: number;
  readonly hiddenAtMs: number | undefined;
  readonly results: { browser?: PartyResult; partner?: PartyResult };
  readonly telemetry: PageTelemetry | undefined;
  readonly partnerLog: PartyLog | undefined;
  readonly partnerStepsMs: Record<string, number>;
  readonly pageEvents: Array<{ event: string; atMs: number }>;
  readonly error: string | undefined;
}

function composeRecord(inputs: RecordInputs) {
  const { roundStartMs: t0, telemetry, partnerLog, results } = inputs;
  const at = (ms: number): number => Math.round(ms - t0);
  const steps = (log: PartyLog | undefined) =>
    (log?.steps ?? []).map(({ name, startMs, endMs }: StepTime) => ({
      name,
      startMs: at(startMs),
      endMs: at(endMs),
      ms: endMs - startMs,
    }));
  const browserLog = telemetry?.log;
  const longest = [...(browserLog?.steps ?? [])]
    .sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs))
    .at(0);
  const sent = browserLog?.sent ?? [];
  const arrived = partnerLog?.received ?? [];
  const gap = (
    times: ReadonlyArray<number>,
    endMs: number | undefined,
    fromMs?: number,
    toMs?: number,
  ) => {
    const found = largestGap(times, endMs, fromMs, toMs);
    return found === undefined
      ? undefined
      : { gapMs: found.gapMs, fromMs: at(found.fromMs), toMs: at(found.toMs) };
  };
  const gapsOver = (fromMs?: number, toMs?: number) => ({
    sent: gap(
      sent.map((frame) => frame.atMs),
      browserLog?.phaseEndMs,
      fromMs,
      toMs,
    ),
    sentStillWorking: gap(
      sent.filter((frame) => frame.stillWorking).map((frame) => frame.atMs),
      browserLog?.phaseEndMs,
      fromMs,
      toMs,
    ),
    arrived: gap(
      arrived.map((frame) => frame.atMs),
      partnerLog?.phaseEndMs,
      fromMs,
      toMs,
    ),
  });
  const longTasks = [...(telemetry?.longTasks ?? [])].sort(
    (a, b) => b.durationMs - a.durationMs,
  );
  const within = (ms: number): boolean =>
    longest !== undefined && ms >= longest.startMs && ms <= longest.endMs;
  const samplesInStep = (telemetry?.visibility ?? []).filter((sample) =>
    within(sample.atMs),
  );
  // Each visibility the page reported, by sample or by change, in time order.
  const states = [
    ...(telemetry?.visibility ?? []),
    ...(telemetry?.lifecycle ?? []).flatMap(({ event, atMs }) =>
      event.startsWith("visibilitychange ")
        ? [{ atMs, state: event.slice("visibilitychange ".length) }]
        : [],
    ),
  ].sort((a, b) => a.atMs - b.atMs);
  const hiddenThroughLongestStep =
    longest !== undefined &&
    states.filter((each) => each.atMs <= longest.startMs).at(-1)?.state ===
      "hidden" &&
    states.every((each) => !within(each.atMs) || each.state === "hidden");
  const outcomeOf = (result: PartyResult | undefined) =>
    result === undefined
      ? { ended: false }
      : "outcome" in result
        ? {
            matched: matchesOverlap(result.outcome, inputs.overlap),
            pairs: result.outcome.pairs.length,
          }
        : { failure: result.failure };
  const browserOutcome = outcomeOf(results.browser);
  const partnerOutcome = outcomeOf(results.partner);
  return {
    date: new Date(t0).toISOString(),
    role: inputs.role,
    elements: inputs.elements,
    partnerElements: inputs.partnerElements,
    overlap: inputs.overlap,
    partnerBackend: inputs.partnerBackend,
    browserVersion: inputs.browserVersion,
    headless: false,
    throttlingSwitchesRemoved: THROTTLING_SWITCHES,
    stillWorkingIntervalMs: STILL_WORKING_INTERVAL_MS,
    partnerSilenceBoundMs: PARTNER_SILENCE_BOUND_MS,
    wallMs: inputs.wallMs,
    outcome: {
      matched:
        "matched" in browserOutcome &&
        browserOutcome.matched &&
        "matched" in partnerOutcome &&
        partnerOutcome.matched,
      browser: browserOutcome,
      partner: partnerOutcome,
    },
    hiddenAtMs:
      inputs.hiddenAtMs === undefined ? undefined : at(inputs.hiddenAtMs),
    phase: {
      browser: {
        startMs: at(browserLog?.phaseStartMs ?? t0),
        endMs:
          browserLog?.phaseEndMs === undefined
            ? undefined
            : at(browserLog.phaseEndMs),
      },
    },
    steps: {
      browser: steps(browserLog),
      partner: steps(partnerLog),
      partnerEngineMs: inputs.partnerStepsMs,
    },
    longestStep:
      longest === undefined
        ? undefined
        : {
            name: longest.name,
            startMs: at(longest.startMs),
            endMs: at(longest.endMs),
            ms: longest.endMs - longest.startMs,
          },
    gaps: {
      phase: gapsOver(),
      longestStep:
        longest === undefined
          ? undefined
          : gapsOver(longest.startMs, longest.endMs),
    },
    frames: {
      browserSent: sent.map((frame) => ({ ...frame, atMs: at(frame.atMs) })),
      partnerReceived: arrived.map((frame) => ({
        ...frame,
        atMs: at(frame.atMs),
      })),
    },
    longTasks: {
      count: longTasks.length,
      longestMs: longTasks[0]?.durationMs,
      longestDuringLongestStepMs: longTasks.find((task) => within(task.startMs))
        ?.durationMs,
      top: longTasks.slice(0, TOP_LONG_TASKS).map((task) => ({
        startMs: at(task.startMs),
        durationMs: task.durationMs,
      })),
    },
    lifecycle: {
      wasDiscarded: telemetry?.wasDiscarded,
      pageAnswered: telemetry !== undefined,
      events: (telemetry?.lifecycle ?? []).map((each) => ({
        ...each,
        atMs: at(each.atMs),
      })),
      playwrightEvents: inputs.pageEvents.map((each) => ({
        ...each,
        atMs: at(each.atMs),
      })),
    },
    visibility: {
      hiddenThroughLongestStep,
      samplesInLongestStep: samplesInStep.length,
      samples: (telemetry?.visibility ?? []).map((sample) => ({
        ...sample,
        atMs: at(sample.atMs),
      })),
    },
    ...(inputs.error === undefined ? {} : { error: inputs.error }),
  };
}

await main();
