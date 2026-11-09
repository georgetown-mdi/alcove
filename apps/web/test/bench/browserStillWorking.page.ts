import {
  createBrowserPsiEngineFactory,
  encodePsiWorkerInit,
} from "../../src/psi/workers/psiCryptoController";

import { partyLog, runStillWorkingRound, wrapAsApp } from "./stillWorkingParty";
import { dial } from "./wrappedRoundParty";
import { partyValues } from "./partyValues";

import type { MessageConnection, PsiEngine } from "@alcove/core";
import type { PartyLog, PartyResult } from "./stillWorkingParty";
import type { PsiCryptoWorker } from "../../src/psi/workers/psiCryptoController";
import type { RoundSide } from "./wrappedRoundParty";

// The measured page of browserStillWorking.ts, bundled by it: the web app's own
// worker-backed PSI engine in one PSI round of core's participant through
// core's still-working layer, over a PeerJS data channel opened as the web app
// opens one. The bench hides this page for the round. Beside the frames and
// steps the round logs, the page records every Long Task on its main thread,
// its page lifecycle events, and its visibility on a timer of its own, which a
// hidden page's throttling slows as it slows the layer's.

/** What the page recorded beside the round. */
export interface PageTelemetry {
  readonly log: PartyLog;
  readonly longTasks: Array<{ startMs: number; durationMs: number }>;
  readonly lifecycle: Array<{ event: string; atMs: number }>;
  readonly visibility: Array<{ atMs: number; state: DocumentVisibilityState }>;
  readonly wasDiscarded: boolean;
}

/** The calls browserStillWorking.ts makes on the measured page. */
export interface StillWorkingProbe {
  makeEngine: (side: RoundSide) => void;
  connect: (
    brokerPort: number,
    sharedSecret: string,
    sessionKey: ReadonlyArray<number>,
  ) => Promise<void>;
  run: (
    side: RoundSide,
    elements: number,
    overlap: number,
  ) => Promise<PartyResult>;
  telemetry: () => PageTelemetry;
}

const VISIBILITY_SAMPLE_MS = 10_000;

const log = partyLog();
const longTasks: PageTelemetry["longTasks"] = [];
const lifecycle: PageTelemetry["lifecycle"] = [];
const visibility: PageTelemetry["visibility"] = [];

new PerformanceObserver((list) => {
  for (const entry of list.getEntries())
    longTasks.push({
      startMs: performance.timeOrigin + entry.startTime,
      durationMs: entry.duration,
    });
}).observe({ type: "longtask", buffered: true });
for (const event of ["freeze", "resume", "pagehide", "pageshow"])
  document.addEventListener(event, () =>
    lifecycle.push({ event, atMs: Date.now() }),
  );
document.addEventListener("visibilitychange", () =>
  lifecycle.push({
    event: `visibilitychange ${document.visibilityState}`,
    atMs: Date.now(),
  }),
);
const sampleVisibility = (): void => {
  visibility.push({ atMs: Date.now(), state: document.visibilityState });
};
sampleVisibility();
setInterval(sampleVisibility, VISIBILITY_SAMPLE_MS);

let engine: PsiEngine | undefined;
let connection: MessageConnection | undefined;

const probe: StillWorkingProbe = {
  makeEngine(side) {
    engine = createBrowserPsiEngineFactory(
      (init) =>
        new Worker("/worker.js", {
          type: "module",
          name: encodePsiWorkerInit(init),
        }) as unknown as PsiCryptoWorker,
    )(side.role, side.id, side.mode);
  },
  async connect(brokerPort, sharedSecret, sessionKey) {
    connection = await wrapAsApp(
      await dial(brokerPort, sharedSecret),
      sessionKey,
      "initiator",
    );
  },
  async run(side, elements, overlap) {
    if (!engine || !connection)
      throw new Error("makeEngine and connect have not both run");
    return runStillWorkingRound(
      connection,
      engine,
      side,
      partyValues(elements, overlap, "browser"),
      log,
    );
  },
  telemetry() {
    sampleVisibility();
    return {
      log,
      longTasks,
      lifecycle,
      visibility,
      wasDiscarded:
        (document as unknown as { wasDiscarded?: boolean }).wasDiscarded ===
        true,
    };
  },
};

(
  globalThis as unknown as { stillWorkingProbe: () => StillWorkingProbe }
).stillWorkingProbe = () => probe;
