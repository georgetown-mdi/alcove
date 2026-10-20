import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { countDeclaredPsiElements } from "../connection/psiElementScan";
import { markPsiLibraryFailure } from "../errors";
import {
  appendChunkElements,
  buildRequest,
  buildResponse,
  chunkRanges,
  mergeCountOnlyResponseChunks,
  serializeResponse,
} from "./psiChunks";
import {
  partnerRequestModeError,
  valuesContributedExactlyOnce,
} from "./psiEngine";

import type { PsiChunkRange } from "./psiChunks";
import type {
  PsiEngine,
  PsiEngineMode,
  PsiProcessedElementsReporter,
} from "./psiEngine";

// Splitting the two per-element masking steps of a round -- the joiner's
// request and the starter's response to it -- across engines that hold one
// key, and reassembling their results into the bytes one engine produces.
// Masking is one curve multiplication per element, so the split is exact; the
// merge rules are the ones psiChunks.ts states for chunks of one operation.

/**
 * The fewest elements one shard is given. A set too small to give a second
 * shard this many runs on the primary engine alone, as one engine runs it.
 */
export const PSI_SHARD_MIN_ELEMENTS = 1024;

/** Settings for a {@link ShardedPsiEngine}. */
export interface ShardedPsiEngineOptions {
  /**
   * @internal
   *
   * The fewest elements per shard, in place of
   * {@link PSI_SHARD_MIN_ELEMENTS}, so a unit test can shard a set it can
   * afford to mask.
   */
  readonly minShardElements?: number;
  /**
   * How long one shard of a split operation may go without a processed-count
   * tick or its result before the operation fails as if that shard had
   * stopped, in milliseconds. Left out, a shard is waited for however long it
   * runs.
   */
  readonly shardProgressTimeoutMs?: number;
}

/**
 * The failure of a split operation one of whose shards reported nothing for
 * `timeoutMs`.
 */
export function shardStalledError(timeoutMs: number): Error {
  const minutes = timeoutMs / 60_000;
  const span = Number.isInteger(minutes)
    ? `${String(minutes)} minute${minutes === 1 ? "" : "s"}`
    : `${String(Math.ceil(timeoutMs / 1000))} seconds`;
  return new Error(
    `Encrypting the data made no progress for ${span}. Run the exchange again.`,
  );
}

// One timer per running shard, restarted by each of its ticks and cleared
// when it settles; the first to expire rejects `stalled`. A shard that
// settles restarts the others: an engine masking on this thread holds it
// through its whole part, and the ticks the others sent meanwhile are read
// only after it settles.
class ShardProgressWatch {
  readonly stalled: Promise<never>;
  private fail: (error: Error) => void = () => undefined;
  private readonly timers: Array<ReturnType<typeof setTimeout> | undefined>;

  constructor(
    private readonly shards: number,
    private readonly timeoutMs: number,
  ) {
    this.stalled = new Promise<never>((_resolve, reject) => {
      this.fail = reject;
    });
    this.timers = Array.from({ length: shards }, () => this.start());
  }

  private start(): ReturnType<typeof setTimeout> {
    return setTimeout(
      () => this.fail(shardStalledError(this.timeoutMs)),
      this.timeoutMs,
    );
  }

  progressed(shard: number): void {
    const timer = this.timers[shard];
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers[shard] = this.start();
  }

  settled(shard: number): void {
    clearTimeout(this.timers[shard]);
    this.timers[shard] = undefined;
    for (let running = 0; running < this.shards; running += 1)
      this.progressed(running);
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.fill(undefined);
  }
}

/**
 * A {@link PsiEngine} that runs `createClientRequest` and
 * `processClientRequest` across several engines at once and every other
 * operation on the first of them, the primary.
 *
 * Every engine must be built for the same role and mode from the same secret
 * key: a shard under another key masks its part to different bytes, and the
 * merged message is then wrong without any engine failing. The engines must
 * not be shared with another caller, since each sees its own lockstep calls.
 * A partner request in the other mode is refused before any engine sees it,
 * with the message one engine named `id` refuses it with. A shard that fails
 * fails its operation at once, as does one silent past
 * {@link ShardedPsiEngineOptions.shardProgressTimeoutMs}; no shard is retried.
 *
 * `library` builds and parses the merged messages on the calling thread; it
 * creates no key and masks nothing.
 */
export class ShardedPsiEngine implements PsiEngine {
  private readonly library: PSILibrary;
  private readonly id: string;
  private readonly revealsIdentifiers: boolean;
  private readonly engines: ReadonlyArray<PsiEngine>;
  private readonly minShardElements: number;
  private readonly shardProgressTimeoutMs: number | undefined;
  private onProcessed: PsiProcessedElementsReporter | undefined;
  // Each shard's processed count while a split operation runs; undefined
  // while an operation runs on the primary alone, whose count passes through.
  private shardCounts: Array<number> | undefined;
  private shardWatch: ShardProgressWatch | undefined;
  private disposed = false;

  constructor(
    library: PSILibrary,
    id: string,
    mode: PsiEngineMode,
    primary: PsiEngine,
    helpers: ReadonlyArray<PsiEngine>,
    options: ShardedPsiEngineOptions = {},
  ) {
    this.library = library;
    this.id = id;
    this.revealsIdentifiers = mode === "identifier-revealing";
    this.engines = [primary, ...helpers];
    this.minShardElements = options.minShardElements ?? PSI_SHARD_MIN_ELEMENTS;
    this.shardProgressTimeoutMs = options.shardProgressTimeoutMs;
    // Taken whether or not a caller observes them: the progress timeout
    // reads each shard's ticks.
    this.engines.forEach((engine, shard) =>
      engine.observeProcessedElements?.((processed) =>
        this.shardProcessed(shard, processed),
      ),
    );
  }

  private get primary(): PsiEngine {
    return this.engines[0]!;
  }

  observeProcessedElements(report: PsiProcessedElementsReporter): void {
    this.onProcessed = report;
  }

  private shardProcessed(shard: number, processed: number): void {
    const counts = this.shardCounts;
    // Outside a split operation only the primary runs one; a helper's tick
    // then belongs to a split that has already failed.
    if (counts === undefined) {
      if (shard === 0) this.onProcessed?.(processed);
      return;
    }
    this.shardWatch?.progressed(shard);
    counts[shard] = processed;
    this.reportShardTotal(counts);
  }

  private reportShardTotal(counts: ReadonlyArray<number>): void {
    let total = 0;
    for (const count of counts) total += count;
    this.onProcessed?.(total);
  }

  private shardRangesFor(total: number): PsiChunkRange[] {
    const shards = Math.max(
      1,
      Math.min(this.engines.length, Math.floor(total / this.minShardElements)),
    );
    return chunkRanges(total, shards);
  }

  // Runs `run` on each range's engine at once and returns the results in
  // range order. A shard that finishes counts its whole range, reported while
  // another is still running, so the running total stays short of the
  // operation's element count until the last shard settles. The primary's
  // shard starts last, so where its engine masks on this thread every other
  // shard has its part before the thread is taken.
  private async overShards<T>(
    ranges: ReadonlyArray<PsiChunkRange>,
    run: (engine: PsiEngine, range: PsiChunkRange) => Promise<T>,
  ): Promise<Array<T>> {
    const counts = ranges.map(() => 0);
    this.shardCounts = counts;
    const watch =
      this.shardProgressTimeoutMs === undefined
        ? undefined
        : new ShardProgressWatch(ranges.length, this.shardProgressTimeoutMs);
    this.shardWatch = watch;
    let running = ranges.length;
    const runShard = async (shard: number): Promise<T> => {
      const range = ranges[shard]!;
      const result = await run(this.engines[shard]!, range);
      watch?.settled(shard);
      counts[shard] = range.end - range.start;
      running -= 1;
      if (running > 0 && this.shardCounts === counts)
        this.reportShardTotal(counts);
      return result;
    };
    try {
      const shards = new Array<Promise<T>>(ranges.length);
      for (let shard = ranges.length - 1; shard >= 0; shard -= 1)
        shards[shard] = runShard(shard);
      const results = Promise.all(shards);
      return await (watch === undefined
        ? results
        : Promise.race([results, watch.stalled]));
    } finally {
      watch?.stop();
      this.shardWatch = undefined;
      this.shardCounts = undefined;
    }
  }

  createServerSetup(
    values: ReadonlyArray<string>,
  ): Promise<{ setup: Uint8Array; permutation: Array<number> }> {
    return this.primary.createServerSetup(values);
  }

  async processClientRequest(requestBytes: Uint8Array): Promise<Uint8Array> {
    let declared: number;
    try {
      declared = countDeclaredPsiElements(
        requestBytes,
        "request",
        Number.MAX_SAFE_INTEGER,
      );
    } catch {
      // The primary refuses a malformed request as one engine does.
      return this.primary.processClientRequest(requestBytes);
    }
    let request;
    try {
      request = this.library.request.deserializeBinary(requestBytes);
    } catch (error) {
      throw markPsiLibraryFailure(error);
    }
    // The merge below follows this wrapper's mode, so a request in the other
    // mode is refused here even if every shard would serve it.
    const revealFlag = request.getRevealIntersection();
    if (revealFlag !== this.revealsIdentifiers)
      throw partnerRequestModeError(
        this.id,
        revealFlag,
        this.revealsIdentifiers,
      );
    const ranges = this.shardRangesFor(declared);
    if (ranges.length === 1)
      return this.primary.processClientRequest(requestBytes);
    // Each part keeps the partner's own reveal flag, so every shard applies
    // the mode check one engine applies to the whole request.
    const inbound = request.getEncryptedElementsList_asU8();
    const parts = await this.overShards(ranges, async (engine, range) =>
      this.library.response
        .deserializeBinary(
          await engine.processClientRequest(
            buildRequest(
              this.library,
              inbound.slice(range.start, range.end),
              revealFlag,
            ).serializeBinary(),
          ),
        )
        .getEncryptedElementsList_asU8(),
    );
    if (!this.revealsIdentifiers)
      return serializeResponse(
        this.library,
        mergeCountOnlyResponseChunks(parts),
      );
    const response = buildResponse(this.library, []);
    for (const part of parts) appendChunkElements(response, part);
    return response.serializeBinary();
  }

  async createClientRequest(
    values: ReadonlyArray<string>,
  ): Promise<Uint8Array> {
    // Filtered over the whole set before it is split: a value repeated across
    // two parts occurs once in each, and neither shard would drop it.
    const contributed = this.revealsIdentifiers
      ? values
      : valuesContributedExactlyOnce(values);
    const ranges = this.shardRangesFor(contributed.length);
    if (ranges.length === 1) return this.primary.createClientRequest(values);
    const parts = await this.overShards(ranges, async (engine, range) =>
      this.library.request
        .deserializeBinary(
          await engine.createClientRequest(
            contributed.slice(range.start, range.end),
          ),
        )
        .getEncryptedElementsList_asU8(),
    );
    const request = buildRequest(this.library, [], this.revealsIdentifiers);
    for (const part of parts) appendChunkElements(request, part);
    return request.serializeBinary();
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
    const stopping = this.engines.map(
      (engine) => engine.stopInFlight?.() ?? false,
    );
    return stopping.includes(true);
  }

  /** Dispose every engine, each even if another's dispose throws. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const failures: Array<unknown> = [];
    for (const engine of this.engines) {
      try {
        engine.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw failures[0];
  }
}
