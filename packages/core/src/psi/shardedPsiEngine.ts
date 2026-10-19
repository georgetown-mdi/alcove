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
 * with the message one engine named `id` refuses it with.
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
  private onProcessed: PsiProcessedElementsReporter | undefined;
  // Each shard's processed count while a split operation runs; undefined
  // while an operation runs on the primary alone, whose count passes through.
  private shardCounts: Array<number> | undefined;
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
  }

  private get primary(): PsiEngine {
    return this.engines[0]!;
  }

  observeProcessedElements(report: PsiProcessedElementsReporter): void {
    this.onProcessed = report;
    this.engines.forEach((engine, shard) =>
      engine.observeProcessedElements?.((processed) =>
        this.shardProcessed(shard, processed),
      ),
    );
  }

  private shardProcessed(shard: number, processed: number): void {
    const counts = this.shardCounts;
    // Outside a split operation only the primary runs one; a helper's tick
    // then belongs to a split that has already failed.
    if (counts === undefined) {
      if (shard === 0) this.onProcessed?.(processed);
      return;
    }
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
  // operation's element count until the last shard settles.
  private async overShards<T>(
    ranges: ReadonlyArray<PsiChunkRange>,
    run: (engine: PsiEngine, range: PsiChunkRange) => Promise<T>,
  ): Promise<Array<T>> {
    const counts = ranges.map(() => 0);
    this.shardCounts = counts;
    let running = ranges.length;
    try {
      return await Promise.all(
        ranges.map(async (range, shard) => {
          const result = await run(this.engines[shard]!, range);
          counts[shard] = range.end - range.start;
          running -= 1;
          if (running > 0 && this.shardCounts === counts)
            this.reportShardTotal(counts);
          return result;
        }),
      );
    } finally {
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
