import { WorkerPsiEngine, shardStalledError } from "@alcove/core";

import {
  BROWSER_PSI_SHARD_PROGRESS_TIMEOUT_MS,
  browserPsiShardCount,
} from "./psiShardPolicy";
import {
  createBrowserPsiEngineFactory,
  createPsiCryptoWorkerHandle,
} from "./psiCryptoController";

import type {
  PsiEngine,
  PsiEngineMode,
  PsiProcessedElementsReporter,
} from "@alcove/core";

import type {
  BrowserPsiEngineFactory,
  PsiCryptoWorker,
  PsiShardSplitMessage,
  SpawnPsiCryptoWorker,
} from "./psiCryptoController";
import type { BrowserPsiShardEnvironment } from "./psiShardPolicy";

/**
 * Connect each helper to the primary by a MessageChannel and transfer both
 * ends, so the primary's key goes from worker to worker and never through
 * this thread, which keeps no end of any channel.
 */
export function connectPsiWorkerKeys(
  primary: PsiCryptoWorker,
  helpers: ReadonlyArray<PsiCryptoWorker>,
): void {
  const primaryEnds: Array<MessagePort> = [];
  for (const helper of helpers) {
    const channel = new MessageChannel();
    helper.postMessage({ kind: "key-ports", ports: [channel.port2] }, [
      channel.port2,
    ]);
    primaryEnds.push(channel.port1);
  }
  primary.postMessage({ kind: "key-ports", ports: primaryEnds }, primaryEnds);
}

/**
 * A helper worker as the page sees it: whether its setup, building its
 * engine from the primary's key, succeeded; its fault, a rejection; and its
 * stop. The page sends a helper no request, and a helper refuses one: the
 * primary sends it its parts.
 */
export interface PsiPoolHelper {
  readonly ready: Promise<boolean>;
  readonly fault: Promise<never>;
  readonly stop: () => void;
}

/**
 * A {@link PsiEngine} whose every operation runs on the primary worker. The
 * first request creation or request processing waits for every helper's
 * setup, up to `progressTimeoutMs`, and tells the primary whether all set
 * up. If so, the primary splits those two operations across the helpers and
 * merges their parts itself, so this thread holds only the merged message; a
 * split fails at once on a helper's fault or on the primary reporting
 * nothing for `progressTimeoutMs`. If not, every helper is stopped and the
 * primary runs them alone.
 */
export class PsiWorkerPoolEngine implements PsiEngine {
  private split: Promise<boolean> | undefined;
  private onProcessed: PsiProcessedElementsReporter | undefined;
  private primaryProgressed: (() => void) | undefined;
  private endSetupWait: (() => void) | undefined;
  private disposed = false;

  constructor(
    private readonly primary: PsiEngine,
    private readonly tellPrimary: (message: PsiShardSplitMessage) => void,
    private readonly helpers: ReadonlyArray<PsiPoolHelper>,
    private readonly progressTimeoutMs: number,
  ) {
    primary.observeProcessedElements?.((processed) => {
      this.primaryProgressed?.();
      this.onProcessed?.(processed);
    });
  }

  observeProcessedElements(report: PsiProcessedElementsReporter): void {
    this.onProcessed = report;
  }

  private splitDecided(): Promise<boolean> {
    this.split ??= this.readyHelpers().then((split) => {
      this.tellPrimary({
        kind: "shard-split",
        split,
        progressTimeoutMs: this.progressTimeoutMs,
      });
      return split;
    });
    return this.split;
  }

  // Ends at the first failed setup, the timeout, or a dispose, any of which
  // stops every helper.
  private readyHelpers(): Promise<boolean> {
    return new Promise((resolve) => {
      let unreported = this.helpers.length;
      const end = (allReady: boolean): void => {
        if (this.endSetupWait === undefined) return;
        this.endSetupWait = undefined;
        clearTimeout(timer);
        const split = allReady && !this.disposed;
        if (!split) for (const helper of this.helpers) helper.stop();
        resolve(split);
      };
      this.endSetupWait = () => end(false);
      const timer = setTimeout(() => end(false), this.progressTimeoutMs);
      if (unreported === 0) end(true);
      for (const helper of this.helpers)
        void helper.ready.then((ready) => {
          unreported -= 1;
          if (!ready || unreported === 0) end(ready);
        });
    });
  }

  // The primary times each helper's part; this times the primary, which
  // reports a running count while any part is masked.
  private async splitOnPrimary<T>(run: () => Promise<T>): Promise<T> {
    if (!(await this.splitDecided())) return run();
    let fail: (error: Error) => void = () => undefined;
    const stalled = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const restart = (): void => {
      clearTimeout(timer);
      timer = setTimeout(
        () => fail(shardStalledError(this.progressTimeoutMs)),
        this.progressTimeoutMs,
      );
    };
    this.primaryProgressed = restart;
    restart();
    try {
      return await Promise.race([
        run(),
        stalled,
        ...this.helpers.map((helper) => helper.fault),
      ]);
    } finally {
      clearTimeout(timer);
      this.primaryProgressed = undefined;
    }
  }

  createServerSetup(
    values: ReadonlyArray<string>,
  ): Promise<{ setup: Uint8Array; permutation: Array<number> }> {
    return this.primary.createServerSetup(values);
  }

  processClientRequest(
    requestBytes: Uint8Array,
    declaredElements?: number,
    width?: number,
  ): Promise<Uint8Array> {
    return this.splitOnPrimary(() =>
      this.primary.processClientRequest(requestBytes, declaredElements, width),
    );
  }

  createClientRequest(
    values: ReadonlyArray<string>,
    width?: number,
  ): Promise<Uint8Array> {
    return this.splitOnPrimary(() =>
      this.primary.createClientRequest(values, width),
    );
  }

  receiveServerSetup(setupBytes: Uint8Array): Promise<void> {
    return this.primary.receiveServerSetup(setupBytes);
  }

  receiveServerSetupPiece(piece: Uint8Array): Promise<void> {
    return this.primary.receiveServerSetupPiece(piece);
  }

  completeServerSetup(): Promise<void> {
    return this.primary.completeServerSetup();
  }

  discardServerSetup(): Promise<void> {
    return this.primary.discardServerSetup();
  }

  computeAssociationTable(
    responseBytes: Uint8Array,
  ): Promise<[Array<number>, Array<number>]> {
    return this.primary.computeAssociationTable(responseBytes);
  }

  createPermutedSetup(
    values: ReadonlyArray<string>,
    width?: number,
  ): Promise<{ setup: Uint8Array; indexTable: Int32Array }> {
    return this.primary.createPermutedSetup(values, width);
  }

  receiveIndexTable(indexTable: Int32Array, width?: number): Promise<void> {
    return this.primary.receiveIndexTable(indexTable, width);
  }

  matchPermutedRound(responseBytes: Uint8Array): Promise<void> {
    return this.primary.matchPermutedRound(responseBytes);
  }

  finishPermutedCount(): Promise<number> {
    return this.primary.finishPermutedCount();
  }

  stopInFlight(): boolean {
    return this.primary.stopInFlight?.() ?? false;
  }

  /** Stop every worker, the helpers even if the primary's dispose throws. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.endSetupWait?.();
    try {
      this.primary.dispose();
    } finally {
      for (const helper of this.helpers) helper.stop();
    }
  }
}

/**
 * Spawn a primary and `shardCount - 1` helpers for one engine, connect their
 * key ports, and return the {@link PsiWorkerPoolEngine} over them.
 */
export function startPsiWorkerPool(
  spawn: SpawnPsiCryptoWorker,
  role: "starter" | "joiner",
  id: string,
  mode: PsiEngineMode,
  shardCount: number,
  progressTimeoutMs: number,
): PsiEngine {
  const primaryWorker = spawn({
    role,
    id,
    mode,
    shard: "primary",
    helpers: shardCount - 1,
  });
  const helperWorkers = Array.from({ length: shardCount - 1 }, () =>
    spawn({ role, id, mode, shard: "helper" }),
  );
  connectPsiWorkerKeys(primaryWorker, helperWorkers);
  // A primary that faults sends no key, so it fails every helper's setup.
  let reportPrimaryFault: () => void = () => undefined;
  const primaryFault = new Promise<false>((resolve) => {
    reportPrimaryFault = () => resolve(false);
  });
  const primary = new WorkerPsiEngine(
    createPsiCryptoWorkerHandle(primaryWorker, reportPrimaryFault),
  );
  const helpers = helperWorkers.map((worker): PsiPoolHelper => {
    let report: (ready: boolean) => void = () => undefined;
    const setup = new Promise<boolean>((resolve) => {
      report = resolve;
    });
    let reportFault: (error: Error) => void = () => undefined;
    const fault = new Promise<never>((_resolve, reject) => {
      reportFault = reject;
    });
    void fault.catch(() => undefined);
    const handle = createPsiCryptoWorkerHandle(worker, report);
    handle.setHandlers({ onMessage: () => undefined, onError: reportFault });
    return {
      ready: Promise.race([setup, primaryFault]),
      fault,
      stop: () => handle.terminate(),
    };
  });
  return new PsiWorkerPoolEngine(
    primary,
    (message) => primaryWorker.postMessage(message),
    helpers,
    progressTimeoutMs,
  );
}

/**
 * The {@link RunExchangeOptions.psiEngineFactory} of a web exchange. The
 * joiner, which creates the request, runs as many PSI workers as
 * {@link browserPsiShardCount} gives for `environment`. The starter, which
 * answers it, runs one worker: a pooled answer at the browser's set ceiling
 * ran the renderer out of memory where one worker did not
 * (docs/spec/PROTOCOL.md, "The browser runs its masking across a pool of PSI
 * workers").
 */
export function createPooledBrowserPsiEngineFactory(
  spawn: SpawnPsiCryptoWorker,
  environment: BrowserPsiShardEnvironment,
): BrowserPsiEngineFactory {
  const singleWorker = createBrowserPsiEngineFactory(spawn);
  const shardCount = browserPsiShardCount(environment);
  if (shardCount === 1) return singleWorker;
  return (role, id, mode) =>
    role === "starter"
      ? singleWorker(role, id, mode)
      : startPsiWorkerPool(
          spawn,
          role,
          id,
          mode,
          shardCount,
          BROWSER_PSI_SHARD_PROGRESS_TIMEOUT_MS,
        );
}
