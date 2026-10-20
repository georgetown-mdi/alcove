import { ShardedPsiEngine, WorkerPsiEngine } from "@alcove/core";

import { createPsiCryptoWorkerHandle } from "./psiCryptoController";

import type {
  PsiEngine,
  PsiEngineMode,
  PsiProcessedElementsReporter,
} from "@alcove/core";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import type {
  PsiCryptoWorker,
  SpawnPsiCryptoWorker,
} from "./psiCryptoController";

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

/** A helper's engine and whether its setup, building that engine from the primary's key, succeeded. */
export interface PsiPoolHelper {
  readonly engine: PsiEngine;
  readonly ready: Promise<boolean>;
}

/**
 * A {@link PsiEngine} over a primary worker and its helpers. The first
 * request creation or request processing waits for every helper's setup, up
 * to `progressTimeoutMs`, and from then on those two operations run as a
 * {@link ShardedPsiEngine} over the primary and the helpers that set up; a
 * helper that did not is disposed, and the run goes on without it. Every
 * other operation runs on the primary.
 */
export class PsiWorkerPoolEngine implements PsiEngine {
  private sharded: Promise<ShardedPsiEngine> | undefined;
  private onProcessed: PsiProcessedElementsReporter | undefined;
  private endSetupWait: (() => void) | undefined;
  private disposed = false;

  constructor(
    private readonly library: PSILibrary,
    private readonly id: string,
    private readonly mode: PsiEngineMode,
    private readonly primary: PsiEngine,
    private readonly helpers: ReadonlyArray<PsiPoolHelper>,
    private readonly progressTimeoutMs: number,
  ) {
    primary.observeProcessedElements?.((processed) =>
      this.onProcessed?.(processed),
    );
  }

  observeProcessedElements(report: PsiProcessedElementsReporter): void {
    this.onProcessed = report;
  }

  private shardedEngine(): Promise<ShardedPsiEngine> {
    this.sharded ??= this.readyHelpers().then((ready) => {
      const engine = new ShardedPsiEngine(
        this.library,
        this.id,
        this.mode,
        this.primary,
        ready,
        { shardProgressTimeoutMs: this.progressTimeoutMs },
      );
      engine.observeProcessedElements((processed) =>
        this.onProcessed?.(processed),
      );
      return engine;
    });
    return this.sharded;
  }

  private readyHelpers(): Promise<Array<PsiEngine>> {
    const outcomes = this.helpers.map((): boolean | undefined => undefined);
    return new Promise((resolve) => {
      const end = (): void => {
        if (this.endSetupWait === undefined) return;
        this.endSetupWait = undefined;
        clearTimeout(timer);
        const ready: Array<PsiEngine> = [];
        this.helpers.forEach((helper, index) => {
          if (outcomes[index] === true && !this.disposed)
            ready.push(helper.engine);
          else helper.engine.dispose();
        });
        resolve(ready);
      };
      this.endSetupWait = end;
      const timer = setTimeout(end, this.progressTimeoutMs);
      void Promise.all(
        this.helpers.map((helper, index) =>
          helper.ready.then((ready) => {
            outcomes[index] = ready;
          }),
        ),
      ).then(end);
    });
  }

  createServerSetup(
    values: ReadonlyArray<string>,
  ): Promise<{ setup: Uint8Array; permutation: Array<number> }> {
    return this.primary.createServerSetup(values);
  }

  async processClientRequest(requestBytes: Uint8Array): Promise<Uint8Array> {
    return (await this.shardedEngine()).processClientRequest(requestBytes);
  }

  async createClientRequest(
    values: ReadonlyArray<string>,
  ): Promise<Uint8Array> {
    return (await this.shardedEngine()).createClientRequest(values);
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

  computeIntersectionCardinality(responseBytes: Uint8Array): Promise<number> {
    return this.primary.computeIntersectionCardinality(responseBytes);
  }

  stopInFlight(): boolean {
    const stopping = [this.primary, ...this.helpers.map((h) => h.engine)].map(
      (engine) => engine.stopInFlight?.() ?? false,
    );
    return stopping.includes(true);
  }

  /** Dispose every worker's engine, each even if another's dispose throws. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.endSetupWait?.();
    const failures: Array<unknown> = [];
    for (const engine of [this.primary, ...this.helpers.map((h) => h.engine)])
      try {
        engine.dispose();
      } catch (error) {
        failures.push(error);
      }
    if (failures.length > 0) throw failures[0];
  }
}

/**
 * Spawn a primary and `shardCount - 1` helpers for one engine, connect their
 * key ports, and return the {@link PsiWorkerPoolEngine} over them.
 */
export function startPsiWorkerPool(
  spawn: SpawnPsiCryptoWorker,
  library: PSILibrary,
  role: "starter" | "joiner",
  id: string,
  mode: PsiEngineMode,
  shardCount: number,
  progressTimeoutMs: number,
): PsiEngine {
  const primaryWorker = spawn({ role, id, mode, shard: "primary" });
  const helperWorkers = Array.from({ length: shardCount - 1 }, () =>
    spawn({ role, id, mode, shard: "helper" }),
  );
  connectPsiWorkerKeys(primaryWorker, helperWorkers);
  const helpers = helperWorkers.map((worker): PsiPoolHelper => {
    let report: (ready: boolean) => void = () => undefined;
    const ready = new Promise<boolean>((resolve) => {
      report = resolve;
    });
    const engine = new WorkerPsiEngine(
      createPsiCryptoWorkerHandle(worker, report),
    );
    return { engine, ready };
  });
  return new PsiWorkerPoolEngine(
    library,
    id,
    mode,
    new WorkerPsiEngine(createPsiCryptoWorkerHandle(primaryWorker)),
    helpers,
    progressTimeoutMs,
  );
}
