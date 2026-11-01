import type { Client as PSIClient } from "@openmined/psi.js/implementation/client.d.ts";
import type {
  Match as PSIMatch,
  MatchResult as PSIMatchResult,
} from "@openmined/psi.js/implementation/match.d.ts";
import type { Request as PSIRequest } from "@openmined/psi.js/implementation/proto/psi_pb.d.ts";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type { Server as PSIServer } from "@openmined/psi.js/implementation/server.d.ts";

import {
  countDeclaredPsiElements,
  PsiElementScan,
} from "../connection/psiElementScan";
import {
  InternalConsistencyError,
  isPsiLibraryFailure,
  markPsiLibraryFailure,
  PartnerProtocolRefusalError,
} from "../errors";
import { DistinctValues } from "../utils/distinctValues";
import {
  assertIndexTableIsPermutation,
  assertResponseElementsDistinct,
  HeldPermutation,
  PermutedCountReplay,
} from "./countOnlyPermutation";
import {
  appendChunkElements,
  buildRequest,
  buildResponse,
  chunkRangesOfSize,
  concatChunkElements,
  mergeSetupChunks,
  serializeResponse,
  serializeSetup,
} from "./psiChunks";
import {
  setupNotRawError,
  setupNotStrictlyAscendingError,
  maskingChunkRanges,
} from "./psiWasmBudget";

import type { PsiChunkRange } from "./psiChunks";
import type { WasmMaskingOperation } from "./psiWasmBudget";
import type { Config } from "../types";

// The partner's setup until it completes; `bytes` counts the bytes received.
// A count-only-permuted engine also counts its elements, for the index table
// to be held to.
interface SetupInProgress {
  readonly match: PSIMatch;
  bytes: number;
  readonly scan: PsiElementScan | undefined;
  elements: number;
}

// The setup refusals the engine names by its fixed status text, each raised
// as a protocol error. psiEngineStreamedMatch.test.ts pins them on every
// backend, so a re-vendored engine whose text differs fails there.
const ENGINE_SETUP_NOT_ASCENDING =
  "server setup is not in strictly ascending element order";
const ENGINE_SETUP_NOT_RAW = "server setup is not a single Raw data structure";
const ENGINE_SETUP_INCOMPLETE = "server setup is incomplete";

/**
 * Which disclosure a {@link PsiEngine} is built for.
 *
 * - `identifier-revealing` -- the `psi` construction: the round resolves to
 *   matched positions and an association table.
 * - `count-only-permuted` -- the psi-c construction over every agreed key
 *   (docs/spec/PROTOCOL.md, PSI-C): the library's revealing mode, the sender
 *   reordering every response under one permutation it holds for the
 *   exchange and sending an index table of pseudonyms with every setup, and
 *   the receiver keeping every round's pairs and returning only the count.
 *
 * The mode is fixed when the engine is constructed, never chosen per call:
 * it fixes which operations the engine answers. Both modes set the library's
 * reveal-intersection flag, which rides the receiver's request and which the
 * sender enforces agreement on.
 */
export type PsiEngineMode = "identifier-revealing" | "count-only-permuted";

/**
 * The library's reveal-intersection flag every engine's key objects are
 * created with. No mode runs the library's cardinality mode, the flag
 * cleared (docs/spec/PROTOCOL.md, PSI-C).
 *
 * @internal
 */
export const REVEAL_INTERSECTION_FLAG = true;

/**
 * The mode an engine built with `mode` runs. TypeScript does not reach a JS
 * caller of the published package, which can pass a string outside
 * PsiEngineMode; any such value is refused rather than run as a hybrid of
 * two modes.
 *
 * @internal
 */
export function knownEngineMode(mode: PsiEngineMode): PsiEngineMode {
  if (mode === "identifier-revealing" || mode === "count-only-permuted")
    return mode;
  throw new InternalConsistencyError(
    "a PSI engine was asked for a mode that is neither identifier-revealing nor count-only-permuted",
  );
}

/**
 * The refusal of a partner's PSI request whose reveal flag is cleared, the
 * library's cardinality mode, which the engine `engineId` in `engineMode`
 * does not serve.
 */
export function partnerRequestModeError(
  engineId: string,
  engineMode: PsiEngineMode,
): Error {
  return new Error(
    `${engineId} protocol error: the partner's PSI request ran the ` +
      `library's cardinality mode, where this exchange runs ${knownEngineMode(engineMode)}`,
  );
}

// Runs a PSI library call over a partner's frame, tagging what it throws as
// the library's failure: the one failure the frame boundary above reports as
// the frame failing to decode (decodePsiBinaryFrame, psi/psiBinaryFrame.ts).
function fromLibrary<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    throw markPsiLibraryFailure(error);
  }
}

/**
 * Takes the running count of elements the operation now in flight has finished
 * masking or matching. Reported between chunks and never after the last one,
 * so the figure is always short of the operation's own element count, which
 * its settle report states. A count and nothing else crosses this boundary: no
 * element, no value, no index.
 *
 * A match reports the response elements it has fed to the engine's streaming
 * match, between the pieces it feeds the response in.
 */
export type PsiProcessedElementsReporter = (processed: number) => void;

/**
 * The PSI crypto core behind {@link ./participant.PSIParticipant}: it owns the
 * library's `server` / `client` objects, and with them the secret key, and
 * runs each protocol step over bytes, value lists and index lists. No live
 * library handle crosses the interface, so a worker can host the engine, and
 * the joiner's setup stays inside it from its first piece to its match. The
 * participant bounds each partner frame's element count before calling it.
 *
 * An engine is built for one {@link PsiEngineMode}; the other mode's
 * operations refuse. A failure the PSI library raises on a partner's frame is
 * tagged with `markPsiLibraryFailure` (`errors.ts`), and only that failure, so
 * the caller can report it as the frame failing to decode.
 */
export interface PsiEngine {
  /**
   * Encrypts this party's values once under the server key, returning the
   * serialized setup message and the sorting permutation (see
   * {@link ./participant.PSIParticipant.createServerSetup}). Server role.
   * A count-only-permuted engine refuses: its setup is
   * {@link createPermutedSetup}.
   */
  createServerSetup(
    values: ReadonlyArray<string>,
  ): Promise<{ setup: Uint8Array; permutation: Array<number> }>;
  /**
   * Doubly-encrypts a deserialized-from-`requestBytes` client request under the
   * server key, returning the serialized response. Server role. A
   * count-only-permuted engine reorders the response under `pi`, drawn on the
   * first request, so slot `s` answers request position `pi(s)`; a later
   * request with another element count is refused as a protocol error.
   *
   * `declaredElements` is the record count the partner declared. A
   * count-only-permuted engine requires it and refuses, as a protocol error
   * and before it draws `pi`, a request whose element count as the library
   * parsed it differs; the identifier-revealing mode ignores it.
   */
  processClientRequest(
    requestBytes: Uint8Array,
    declaredElements?: number,
  ): Promise<Uint8Array>;
  /**
   * Encrypts this party's values once under the client key. Client role. A
   * count-only-permuted engine contributes every value, one per receiver
   * record in record order; values must be distinct, and every round's
   * request must have as many.
   */
  createClientRequest(values: ReadonlyArray<string>): Promise<Uint8Array>;
  /**
   * Takes the partner's whole serialized server setup as one piece and
   * completes it: {@link receiveServerSetupPiece} then
   * {@link completeServerSetup}. Client role.
   */
  receiveServerSetup(setupBytes: Uint8Array): Promise<void>;
  /**
   * Takes the next piece of the partner's serialized server setup, cut at any
   * byte, as its parts arrive; the first piece starts a setup. Client role.
   * The streamed match checks the setup's shape and order as each piece
   * arrives, so a setup that is not one Raw data structure, or whose elements
   * are not strictly ascending, can be refused at the piece that shows it.
   * A refusal discards the setup received so far. A piece while a completed
   * setup awaits its match is refused as an internal fault.
   */
  receiveServerSetupPiece(piece: Uint8Array): Promise<void>;
  /**
   * Ends the setup the pieces above started, refusing one that is not a whole
   * Raw data structure whose elements are strictly ascending, and holds it for
   * the match the engine's mode allows -- {@link computeAssociationTable} or
   * {@link matchPermutedRound}. Client role. Split from the match
   * so the joiner can validate the setup as it arrives (a fail-fast before it
   * sends its own request), while the response it matches against arrives a
   * round trip later.
   */
  completeServerSetup(): Promise<void>;
  /**
   * Frees the partner's setup, whether its pieces are still arriving or it
   * awaits its match, so a round a refusal ends holds none past the refusal.
   * A no-op when no setup is held. In the count-only-permuted mode, discarding
   * a held setup ends the exchange's count: later round calls and the count
   * refuse. With no setup held nothing is latched, so a caller ending the
   * exchange between rounds must not ask for the count. Client role.
   */
  discardServerSetup(): Promise<void>;
  /**
   * Removes this party's encryption layer from the partner's doubly-encrypted
   * response and compares it against the setup the preceding
   * {@link completeServerSetup} holds, returning
   * `[localIndices, partnerIndices]` ordered by partner index, as the
   * library's own call orders them. Client role; throws if no setup is held.
   * Identifier-revealing mode only: a count-only-permuted engine refuses
   * instead of returning a pairing.
   */
  computeAssociationTable(
    responseBytes: Uint8Array,
  ): Promise<[Array<number>, Array<number>]>;
  /**
   * Encrypts one element per sender record, `values` in record order, and
   * returns the serialized setup with the round's index table: entry `p` is
   * the pseudonym `sigma` gives the record whose element is at setup position
   * `p`. `sigma` is drawn on the first call and serves every later one, which
   * must have as many values; values must be distinct. Server role,
   * count-only-permuted mode only.
   */
  createPermutedSetup(
    values: ReadonlyArray<string>,
  ): Promise<{ setup: Uint8Array; indexTable: Int32Array }>;
  /**
   * Takes the round's index table for the setup the preceding
   * {@link completeServerSetup} holds, refusing as a protocol error a table
   * whose length is not the setup's element count, or the length earlier
   * rounds had, or which is not a permutation. Client role,
   * count-only-permuted mode only.
   */
  receiveIndexTable(indexTable: Int32Array): Promise<void>;
  /**
   * Matches the partner's permuted response against the held setup and index
   * table and replays the round's (slot, pseudonym) pairs into the count,
   * returning nothing: no pair, slot, pseudonym or per-round count leaves the
   * engine. A response that is not a list of 33-byte elements or that repeats
   * an element is refused as a protocol error before any element is matched,
   * and one whose element count is not this party's request's after. A
   * 33-byte element that is not a valid point is refused by the library
   * during the match. Client role, count-only-permuted mode only.
   */
  matchPermutedRound(responseBytes: Uint8Array): Promise<void>;
  /**
   * Returns the count over every round matched, then discards the replay; no
   * round is matched after it. Once a round call has failed, this and every
   * later round call refuse: as a protocol error where the engine refused the
   * partner's setup, index table or response, and as an internal fault
   * otherwise. An exchange ended between rounds, with no setup held, latches
   * nothing, and this still returns the count over the earlier rounds, so
   * its caller must not ask for it then. Client role, count-only-permuted
   * mode only.
   */
  finishPermutedCount(): Promise<number>;
  /**
   * Register `report`, taking the running processed-element count while an
   * operation above is in flight. Optional: an engine that reports nothing
   * omits it, and the participant then shows an operation's element count and
   * elapsed time alone. One sink at a time -- a second registration replaces
   * the first.
   */
  observeProcessedElements?(report: PsiProcessedElementsReporter): void;
  /**
   * Ask the operation in flight to stop at its next chunk boundary, where it
   * rejects with a {@link ./psiWorkerEngine.PsiOperationStoppedError} instead
   * of running on, and return whether it will. A no-op returning false between
   * operations. Optional: an engine without it runs each operation to its end.
   */
  stopInFlight?(): boolean;
  /**
   * Release engine resources. The in-process engine frees the library's server /
   * client objects -- embind wrappers over WASM-heap C++ state, including the
   * generated secret key, which JS garbage collection does NOT reclaim (only their
   * explicit `delete()` does) -- bounding the key's lifetime to the exchange; the
   * worker-backed engine terminates its worker (which frees that state with the
   * whole isolate). A count-only-permuted engine also zeroes and drops `pi`,
   * `sigma` and the receiver's replay. Terminal: no other method may be called
   * after dispose().
   */
  dispose(): void;
}

/**
 * The operation a {@link ./shardedPsiEngine.ShardedPsiEngine} in the
 * count-only-permuted mode runs on its primary to create a split request: the
 * primary masks the first part while the helpers mask the rest, and keeps the
 * receiver's record count and the round's failure.
 */
export interface PermutedShardPrimary {
  /** The mode the engine was built in. */
  readonly mode: PsiEngineMode;
  /**
   * Checks `values`, the whole of a receiver's request, as
   * {@link PsiEngine.createClientRequest} checks it, records it as the
   * exchange's request, and masks only its first `partElements` values,
   * returning that part as a request. Client role, count-only-permuted mode
   * only.
   */
  createRequestFirstPart(
    values: ReadonlyArray<string>,
    partElements: number,
  ): Promise<Uint8Array>;
}

/** Settings for an {@link InProcessPsiEngine}; the worker entry points pass them through {@link ./psiWorkerEngine.servePsiWorker}. */
export interface InProcessPsiEngineOptions {
  /**
   * The engine memory one masking call is sized to, in bytes: a masking
   * operation runs over chunks that each fit (psiWasmBudget.ts). Left out,
   * every masking operation runs at the chunk policy's sizes, as the native
   * addon runs them.
   */
  readonly maskingMemoryBudgetBytes?: number;
  /**
   * The secret key to build the engine from instead of generating one: the
   * bytes {@link InProcessPsiEngine.copySecretKey} returned on the engine a
   * shard helper masks for, so both mask to the same bytes. The library
   * copies the key into its own state; a key outside the curve's order is
   * refused there.
   */
  readonly secretKey?: Uint8Array;
  /**
   * @internal
   *
   * The chunk size each operation splits at, in place of the measured policy
   * in psiChunks.ts, and the response piece size a streamed match feeds. The
   * byte-identity suite sets it so the chunked path runs over a set a unit
   * test can afford, where the policy would take one chunk.
   */
  readonly chunkElements?: number;
}

// The false-positive rate and client-input count every setup message is built
// with. Both are what selects the Raw data structure the protocol sends and
// accepts: a rate of 0 admits no false positive, and -1 leaves the library to
// size the structure from the inputs it was handed.
const SETUP_FALSE_POSITIVE_RATE = 0.0;
const SETUP_CLIENT_INPUT_COUNT = -1;

/**
 * The default {@link PsiEngine}: runs the crypto synchronously on the
 * calling thread, wrapping the injected {@link PSILibrary}, extracted
 * behind the interface so a worker-backed engine can replace it without
 * disturbing {@link ./participant.PSIParticipant} or its callers. The
 * browser and every test use it directly; the CLI wraps a worker-backed
 * engine around the same per-thread logic.
 *
 * Each operation over a set large enough to split runs as a sequence of
 * chunks, reporting the running processed count between them, so a display has
 * a figure that moves through an operation the library would otherwise run as
 * one call lasting minutes. The chunk results reassemble into the bytes the
 * single call produces (psiChunks.ts states the merge rules and the sizing
 * policy); a set at or below the chunk floor takes one chunk and runs the
 * single call unchanged.
 */
export class InProcessPsiEngine implements PsiEngine, PermutedShardPrimary {
  private readonly library: PSILibrary;
  private readonly id: string;
  /** The mode the engine was built in. */
  readonly mode: PsiEngineMode;
  private readonly revealFlag = REVEAL_INTERSECTION_FLAG;
  private readonly server?: PSIServer;
  private readonly client?: PSIClient;
  // The joiner's setup from its first piece until it completes, then until
  // the match that consumes it. Undefined outside those windows. A completed
  // setup is a live library object, so the engine holds it, not its caller.
  private receivingSetup: SetupInProgress | undefined;
  private heldSetup: PSIMatch | undefined;
  private heldSetupElements = 0;
  // The count-only-permuted state, held for the exchange and discarded with
  // the engine: the sender's two permutations, and the receiver's record
  // counts, the round's index table and the replay. The secret parts are
  // JavaScript private fields, which no caller can read at runtime.
  #pi: HeldPermutation | undefined;
  #sigma: HeldPermutation | undefined;
  private receiverRecords: number | undefined;
  private senderRecords: number | undefined;
  #heldIndexTable: Int32Array | undefined;
  #replay: PermutedCountReplay | undefined;
  private countTaken = false;
  // Latched when a count-only-permuted receiver's round fails, on the
  // partner's input or here: the count over the rounds before it is not the
  // exchange's count, so no later round or count is answered.
  private failedRound: "partner" | "local" | undefined;
  // Latched by dispose() so freeing the library objects is idempotent: their
  // embind delete() is not safe to call twice.
  private disposed = false;
  // The sink the running processed count goes to, undefined while nothing
  // watches (see observeProcessedElements).
  private onProcessed: PsiProcessedElementsReporter | undefined;
  private readonly chunkElements: number | undefined;
  private readonly maskingMemoryBudgetBytes: number | undefined;

  constructor(
    library: PSILibrary,
    role: Config["role"],
    id: string,
    // Fixed here rather than per call: the reveal flag it sets is generated
    // into the key objects below and rides the request on the wire, so a
    // round's disclosure is fixed together with its key. Required rather
    // than defaulted, because a default is a disclosure a caller can reach
    // by forgetting: a revealing round run under count-only terms is the
    // substitution the mode exists to prevent.
    mode: PsiEngineMode,
    options: InProcessPsiEngineOptions = {},
  ) {
    this.library = library;
    this.id = id;
    this.mode = knownEngineMode(mode);
    this.chunkElements = options.chunkElements;
    this.maskingMemoryBudgetBytes = options.maskingMemoryBudgetBytes;
    // The secret key for this exchange, generated fresh unless a shard
    // helper's is given, held inside the library's server / client object.
    // An unresolved ("either") role creates neither; the role-guarded
    // methods below then reject.
    const key = options.secretKey;
    if (role === "starter") {
      const server = library.server!;
      this.server =
        key === undefined
          ? server.createWithNewKey(this.revealFlag)
          : server.createFromKey(key, this.revealFlag);
    } else if (role === "joiner") {
      const client = library.client!;
      this.client =
        key === undefined
          ? client.createWithNewKey(this.revealFlag)
          : client.createFromKey(key, this.revealFlag);
    }
  }

  // Refuses `operation` on an engine built for a mode outside `allowed`, as
  // this party's own fault.
  private requireMode(
    operation: string,
    ...allowed: ReadonlyArray<PsiEngineMode>
  ): void {
    if (!allowed.includes(this.mode))
      throw new Error(
        `${this.id}: ${operation} needs a PSI engine that is ${allowed.join(" or ")}; this one is ${this.mode}`,
      );
  }

  private requireServer(operation: string): PSIServer {
    if (!this.server)
      throw new Error(`${this.id}: ${operation} requires the server role`);
    return this.server;
  }

  private requireClient(operation: string): PSIClient {
    if (!this.client)
      throw new Error(`${this.id}: ${operation} requires the client role`);
    return this.client;
  }

  // Refuses `operation` before it draws a permutation dispose() would never
  // zero.
  private requireUndisposed(operation: string): void {
    if (this.disposed)
      throw new InternalConsistencyError(
        `${this.id}: ${operation} called on a disposed PSI engine`,
      );
  }

  private refuseAfterFailedRound(operation: string): void {
    if (this.failedRound === "partner")
      throw new PartnerProtocolRefusalError(
        `${this.id} protocol error: ${operation} called after the partner's input was refused`,
      );
    if (this.failedRound === "local")
      throw new InternalConsistencyError(
        `${this.id}: ${operation} called after a count-only round failed`,
      );
  }

  // Runs one step of a round. In the count-only-permuted mode, any failure
  // latches: a refusal of the partner's input or the library's failure on it
  // as the partner's, anything else as this party's. The latch discards the
  // replay and the round's setup.
  private latchingRoundFailure<T>(step: () => T): T {
    try {
      return step();
    } catch (error) {
      if (this.mode === "count-only-permuted") {
        this.latchFailedRound(
          error instanceof PartnerProtocolRefusalError ||
            isPsiLibraryFailure(error)
            ? "partner"
            : "local",
        );
      }
      throw error;
    }
  }

  private latchFailedRound(cause: "partner" | "local"): void {
    this.failedRound ??= cause;
    this.#replay?.discard();
    this.#replay = undefined;
    this.freeSetup();
  }

  // Refuses a set with a repeated value: each party's elements in a
  // count-only-permuted round are distinct, its caller putting a dummy where
  // a value repeats.
  private assertDistinctValues(
    operation: string,
    values: ReadonlyArray<string>,
  ): void {
    const distinct = new DistinctValues();
    for (const value of values) distinct.add(value);
    if (distinct.size !== values.length)
      throw new InternalConsistencyError(
        `${this.id}: ${operation} was given a repeated value`,
      );
  }

  /**
   * A fresh copy of this engine's secret key, for building a shard helper
   * that masks under it (the {@link InProcessPsiEngineOptions.secretKey}
   * option). Each call returns its own buffer, which the caller transfers or
   * zeroes. psi.js also keeps an unzeroed copy of the key bytes in a JS array
   * and in WASM temporaries, out of this code's reach. An engine with no
   * resolved role, or a disposed one, refuses.
   */
  copySecretKey(): Uint8Array {
    const holder = this.server ?? this.client;
    if (holder === undefined || this.disposed)
      throw new InternalConsistencyError(
        `${this.id}: a PSI engine with no role, or a disposed one, holds no secret key`,
      );
    return holder.getPrivateKeyBytes();
  }

  observeProcessedElements(report: PsiProcessedElementsReporter): void {
    this.onProcessed = report;
  }

  // How one operation over `total` elements is split: the measured policy,
  // held to the memory budget for a masking `operation`, unless a test set a
  // chunk size of its own.
  private rangesFor(
    total: number,
    operation?: WasmMaskingOperation,
  ): PsiChunkRange[] {
    return this.chunkElements === undefined
      ? maskingChunkRanges(total, operation, this.maskingMemoryBudgetBytes)
      : chunkRangesOfSize(total, this.chunkElements);
  }

  // Runs `maskChunk` over each range in turn, reporting the running processed
  // count BETWEEN chunks -- never after the last, whose figure is the one the
  // operation's own settle report states.
  private overChunks<T>(
    ranges: ReadonlyArray<PsiChunkRange>,
    maskChunk: (range: PsiChunkRange) => T,
  ): Array<T> {
    const results: Array<T> = [];
    for (let index = 0; index < ranges.length; index += 1) {
      const range = ranges[index]!;
      results.push(maskChunk(range));
      if (index < ranges.length - 1) this.onProcessed?.(range.end);
    }
    return results;
  }

  // One chunk's masked setup. The Raw check reads back what the call above
  // asked for: without it, a setup that is not Raw reaches the merge as an
  // absent element list and fails as a type error rather than a named
  // condition.
  private maskSetupChunk(
    server: PSIServer,
    values: ReadonlyArray<string>,
  ): { elements: Array<Uint8Array>; permutation: Array<number> } {
    const permutation: Array<number> = [];
    const setup = server.createSetupMessage(
      SETUP_FALSE_POSITIVE_RATE,
      SETUP_CLIENT_INPUT_COUNT,
      values,
      this.library.dataStructure.Raw,
      permutation,
    );
    const raw = setup.getRaw();
    if (!raw)
      throw new Error(
        `${this.id}: the PSI library returned a server setup that is not a Raw data structure`,
      );
    return { elements: raw.getEncryptedElementsList_asU8(), permutation };
  }

  createServerSetup(
    values: ReadonlyArray<string>,
  ): Promise<{ setup: Uint8Array; permutation: Array<number> }> {
    const server = this.requireServer("createServerSetup");
    this.requireMode("createServerSetup", "identifier-revealing");
    return Promise.resolve(this.maskSetup(server, values));
  }

  private maskSetup(
    server: PSIServer,
    values: ReadonlyArray<string>,
  ): { setup: Uint8Array; permutation: Array<number> } {
    const ranges = this.rangesFor(values.length, "createSetupMessage");
    // One chunk is the single call this operation has always been: the
    // library's own message goes out as it serialized it, with no element list
    // materialized beside it and no merge to reproduce its sort.
    if (ranges.length === 1) {
      const sortingPermutation: Array<number> = [];
      const setup = server.createSetupMessage(
        SETUP_FALSE_POSITIVE_RATE,
        SETUP_CLIENT_INPUT_COUNT,
        values,
        this.library.dataStructure.Raw,
        sortingPermutation,
      );
      return {
        setup: setup.serializeBinary(),
        permutation: sortingPermutation,
      };
    }
    const merged = mergeSetupChunks(
      this.overChunks(ranges, (range) => ({
        start: range.start,
        ...this.maskSetupChunk(server, values.slice(range.start, range.end)),
      })),
    );
    return {
      setup: serializeSetup(this.library, merged.elements),
      permutation: merged.permutation,
    };
  }

  createPermutedSetup(
    values: ReadonlyArray<string>,
  ): Promise<{ setup: Uint8Array; indexTable: Int32Array }> {
    return settled(() => {
      const server = this.requireServer("createPermutedSetup");
      this.requireMode("createPermutedSetup", "count-only-permuted");
      this.requireUndisposed("createPermutedSetup");
      this.assertDistinctValues("createPermutedSetup", values);
      const sigma = (this.#sigma ??= HeldPermutation.draw(values.length));
      if (sigma.size !== values.length)
        throw new InternalConsistencyError(
          `${this.id}: a count-only setup has ${String(values.length)} values where the exchange's first had ${String(sigma.size)}`,
        );
      const { setup, permutation } = this.maskSetup(server, values);
      const indexTable = new Int32Array(permutation.length);
      for (let position = 0; position < permutation.length; position += 1)
        indexTable[position] = sigma.at(permutation[position]!);
      permutation.fill(0);
      return { setup, indexTable };
    });
  }

  processClientRequest(
    requestBytes: Uint8Array,
    declaredElements?: number,
  ): Promise<Uint8Array> {
    const server = this.requireServer("processClientRequest");
    this.requireUndisposed("processClientRequest");
    const request = fromLibrary(() =>
      this.library.request.deserializeBinary(requestBytes),
    );
    // The request states the reveal flag, and the library refuses to serve a
    // request whose flag disagrees with the key this server was created
    // under -- the wire-enforced mode agreement (docs/spec/PROTOCOL.md,
    // PSI-C). Read the flag and name both modes here, rather than leave the
    // library's refusal, which the frame boundary reports as a request that
    // failed to decode.
    if (request.getRevealIntersection() !== this.revealFlag)
      throw partnerRequestModeError(this.id, this.mode);
    const elements = request.getEncryptedElementsList().length;
    if (this.mode === "count-only-permuted") {
      if (declaredElements === undefined)
        throw new InternalConsistencyError(
          `${this.id}: processClientRequest in the count-only-permuted mode needs the partner's declared record count`,
        );
      if (elements !== declaredElements)
        throw new PartnerProtocolRefusalError(
          `${this.id} protocol error: the partner's PSI request has ${String(elements)} elements for its ${String(declaredElements)} declared records`,
        );
      return Promise.resolve(this.permutedResponse(server, request, elements));
    }
    const ranges = this.rangesFor(elements, "processRequest");
    // One chunk is the single call: the partner's request is re-encrypted as
    // the library deserialized it, so nothing materializes its element list.
    if (ranges.length === 1)
      return Promise.resolve(
        fromLibrary(() => server.processRequest(request)).serializeBinary(),
      );
    const inbound = request.getEncryptedElementsList_asU8();
    const maskChunk = (range: PsiChunkRange): Array<Uint8Array> =>
      this.maskRequestChunk(server, inbound, range);
    // The response answers position by position, so each chunk goes
    // straight into the outgoing message.
    const response = buildResponse(this.library, []);
    this.overChunks(ranges, (range) =>
      appendChunkElements(response, maskChunk(range)),
    );
    return Promise.resolve(response.serializeBinary());
  }

  private maskRequestChunk(
    server: PSIServer,
    inbound: ReadonlyArray<Uint8Array>,
    range: PsiChunkRange,
  ): Array<Uint8Array> {
    return fromLibrary(() =>
      server.processRequest(
        buildRequest(
          this.library,
          inbound.slice(range.start, range.end),
          this.revealFlag,
        ),
      ),
    ).getEncryptedElementsList_asU8();
  }

  // The response in request order, then reordered under `pi` before any part
  // of it leaves the engine: slot `s` is the element at position `pi(s)`.
  private permutedResponse(
    server: PSIServer,
    request: PSIRequest,
    elements: number,
  ): Uint8Array {
    const pi = (this.#pi ??= HeldPermutation.draw(elements));
    if (pi.size !== elements)
      throw new PartnerProtocolRefusalError(
        `${this.id} protocol error: the partner's PSI request has ${String(elements)} elements where the exchange's first had ${String(pi.size)}`,
      );
    const ranges = this.rangesFor(elements, "processRequest");
    let inOrder: Array<Uint8Array>;
    if (ranges.length === 1) {
      inOrder = fromLibrary(() =>
        server.processRequest(request),
      ).getEncryptedElementsList_asU8();
    } else {
      const inbound = request.getEncryptedElementsList_asU8();
      inOrder = concatChunkElements(
        this.overChunks(ranges, (range) =>
          this.maskRequestChunk(server, inbound, range),
        ),
      );
    }
    if (inOrder.length !== elements)
      throw new InternalConsistencyError(
        `${this.id}: the PSI engine answered ${String(inOrder.length)} of a request's ${String(elements)} elements`,
      );
    const permuted = new Array<Uint8Array>(elements);
    for (let slot = 0; slot < elements; slot += 1)
      permuted[slot] = inOrder[pi.at(slot)]!;
    return serializeResponse(this.library, permuted);
  }

  createClientRequest(values: ReadonlyArray<string>): Promise<Uint8Array> {
    const client = this.requireClient("createClientRequest");
    if (this.mode === "count-only-permuted")
      this.recordPermutedRequest("createClientRequest", values);
    return Promise.resolve(this.maskRequest(client, values));
  }

  createRequestFirstPart(
    values: ReadonlyArray<string>,
    partElements: number,
  ): Promise<Uint8Array> {
    return settled(() => {
      const client = this.requireClient("createRequestFirstPart");
      this.requireMode("createRequestFirstPart", "count-only-permuted");
      if (
        !Number.isSafeInteger(partElements) ||
        partElements < 0 ||
        partElements > values.length
      )
        throw new InternalConsistencyError(
          `${this.id}: the first part of a request cannot have ${String(partElements)} of its ${String(values.length)} values`,
        );
      this.recordPermutedRequest("createRequestFirstPart", values);
      return this.maskRequest(client, values.slice(0, partElements));
    });
  }

  // A count-only-permuted receiver's request: one distinct value per record,
  // the same record count in every round.
  private recordPermutedRequest(
    operation: string,
    values: ReadonlyArray<string>,
  ): void {
    this.refuseAfterFailedRound(operation);
    this.assertDistinctValues(operation, values);
    this.receiverRecords ??= values.length;
    if (this.receiverRecords !== values.length)
      throw new InternalConsistencyError(
        `${this.id}: a count-only request has ${String(values.length)} values where the exchange's first had ${String(this.receiverRecords)}`,
      );
  }

  private maskRequest(
    client: PSIClient,
    values: ReadonlyArray<string>,
  ): Uint8Array {
    const ranges = this.rangesFor(values.length, "createRequest");
    if (ranges.length === 1)
      return client.createRequest(values).serializeBinary();
    // A request holds its elements in input order, so each chunk's masked
    // elements go straight into the outgoing message, with no list held
    // beside it to concatenate.
    const request = buildRequest(this.library, [], this.revealFlag);
    this.overChunks(ranges, (range) =>
      appendChunkElements(
        request,
        client
          .createRequest(values.slice(range.start, range.end))
          .getEncryptedElementsList_asU8(),
      ),
    );
    return request.serializeBinary();
  }

  receiveServerSetup(setupBytes: Uint8Array): Promise<void> {
    return this.receiveServerSetupPiece(setupBytes).then(() =>
      this.completeServerSetup(),
    );
  }

  receiveServerSetupPiece(piece: Uint8Array): Promise<void> {
    return settled(() =>
      this.latchingRoundFailure(() => this.takeSetupPiece(piece)),
    );
  }

  completeServerSetup(): Promise<void> {
    return settled(() => this.latchingRoundFailure(() => this.endSetup()));
  }

  discardServerSetup(): Promise<void> {
    // A discarded setup is a round that never completes, so in the
    // count-only-permuted mode it latches as an aborted round would.
    if (
      this.mode === "count-only-permuted" &&
      (this.receivingSetup !== undefined || this.heldSetup !== undefined)
    )
      this.latchFailedRound("local");
    else this.freeSetup();
    return Promise.resolve();
  }

  // A streamed match holds its own copy of the client key in engine memory,
  // freed only by its delete().
  private freeSetup(): void {
    const receiving = this.receivingSetup;
    const held = this.heldSetup;
    this.receivingSetup = undefined;
    this.heldSetup = undefined;
    this.heldSetupElements = 0;
    this.#heldIndexTable?.fill(0);
    this.#heldIndexTable = undefined;
    receiving?.match.delete();
    held?.delete();
  }

  private takeSetupPiece(piece: Uint8Array): void {
    this.refuseAfterFailedRound("receiveServerSetupPiece");
    if (this.heldSetup !== undefined)
      throw new InternalConsistencyError(
        `${this.id}: a PSI server setup piece arrived while a completed setup awaits its match`,
      );
    let receiving = this.receivingSetup;
    if (receiving === undefined) {
      const client = this.client;
      if (!client)
        throw new Error(
          `${this.id}: receiveServerSetupPiece requires the client role`,
        );
      receiving = {
        match: fromLibrary(() => client.createMatch()),
        bytes: 0,
        // The frame's length is not known to the engine, so the scan is
        // bounded by none; the library has refused a malformed piece first.
        scan:
          this.mode === "count-only-permuted"
            ? new PsiElementScan(
                "serverSetup",
                Number.MAX_SAFE_INTEGER,
                Number.MAX_SAFE_INTEGER,
              )
            : undefined,
        elements: 0,
      };
      this.receivingSetup = receiving;
    }
    const match = receiving.match;
    const scan = receiving.scan;
    this.setupStep(receiving, () => {
      match.addSetupBytes(piece);
      if (scan !== undefined) receiving.elements = scan.add(piece);
    });
    receiving.bytes += piece.byteLength;
  }

  private endSetup(): void {
    this.refuseAfterFailedRound("completeServerSetup");
    const receiving = this.receivingSetup;
    if (receiving === undefined)
      throw new InternalConsistencyError(
        `${this.id}: completeServerSetup called before any setup piece`,
      );
    const match = receiving.match;
    this.setupStep(receiving, () => match.sealSetup());
    this.receivingSetup = undefined;
    this.heldSetup = match;
    this.heldSetupElements = receiving.elements;
  }

  // A refusal frees the setup and raises a protocol error for the condition
  // the engine names (an empty setup has no Raw data structure), or else the
  // library's failure on the partner's frame.
  private setupStep(receiving: SetupInProgress, step: () => void): void {
    try {
      step();
    } catch (error) {
      this.receivingSetup = undefined;
      receiving.match.delete();
      const message = error instanceof Error ? error.message : undefined;
      if (message === ENGINE_SETUP_NOT_ASCENDING)
        throw setupNotStrictlyAscendingError(this.id);
      if (
        message === ENGINE_SETUP_NOT_RAW ||
        (message === ENGINE_SETUP_INCOMPLETE && receiving.bytes === 0)
      )
        throw setupNotRawError(this.id);
      throw markPsiLibraryFailure(error);
    }
  }

  // The client role, the mode, and the held setup each operation below requires,
  // checked in that order so a call the engine's construction rules out is refused
  // by name here, as this party's own fault, rather than deep in the library as a
  // failure on the partner's frame. The held setup is taken: one setup is matched
  // at most once.
  private beginMatch(operation: string, requiredMode: PsiEngineMode): PSIMatch {
    this.requireClient(operation);
    this.requireMode(operation, requiredMode);
    const match = this.heldSetup;
    if (match === undefined)
      throw new Error(
        `${this.id}: ${operation} called before the partner's setup completed`,
      );
    this.heldSetup = undefined;
    return match;
  }

  // Each response piece ends where the policy's element range ends if every
  // element has one length, as a conforming response's do; the engine takes a
  // cut anywhere, so only the reported count is approximate otherwise.
  // Deletes the match however it ends.
  private matchStreamed(
    match: PSIMatch,
    responseBytes: Uint8Array,
  ): PSIMatchResult {
    try {
      let responseCount: number;
      try {
        responseCount = countDeclaredPsiElements(
          responseBytes,
          "response",
          Number.MAX_SAFE_INTEGER,
        );
      } catch {
        throw new PartnerProtocolRefusalError(
          `${this.id} protocol error: malformed inbound PSI response frame`,
        );
      }
      const totalBytes = responseBytes.byteLength;
      let fed = 0;
      this.overChunks(this.rangesFor(responseCount), (range) => {
        const end =
          range.end === responseCount
            ? totalBytes
            : Math.floor((range.end * totalBytes) / responseCount);
        const piece = responseBytes.subarray(fed, end);
        fed = end;
        fromLibrary(() => match.matchResponsePiece(piece));
      });
      const result = fromLibrary(() => match.finish());
      if (result.decryptedCount !== responseCount)
        throw new InternalConsistencyError(
          `${this.id}: the PSI engine decrypted ${String(result.decryptedCount)} response elements of the ${String(responseCount)} the response holds`,
        );
      return result;
    } finally {
      match.delete();
    }
  }

  computeAssociationTable(
    responseBytes: Uint8Array,
  ): Promise<[Array<number>, Array<number>]> {
    return settled(() => this.associationTableOf(responseBytes));
  }

  private associationTableOf(
    responseBytes: Uint8Array,
  ): Promise<[Array<number>, Array<number>]> {
    const match = this.beginMatch(
      "computeAssociationTable",
      "identifier-revealing",
    );
    const table = this.matchStreamed(match, responseBytes).associationTable;
    if (table === undefined)
      throw new InternalConsistencyError(
        `${this.id}: the PSI engine's identifier-revealing match returned no association table`,
      );
    return Promise.resolve(this.inPartnerIndexOrder(table[0], table[1]));
  }

  // The streamed match's pairs, in response order, put in the library call's
  // order: partner index ascending, ties by local index. The counting sort
  // keeps response order among ties, which is local index order only if local
  // indices ascend, as checked here.
  private inPartnerIndexOrder(
    localIndices: Uint32Array,
    partnerIndices: Uint32Array,
  ): [Array<number>, Array<number>] {
    const pairs = localIndices.length;
    let largestPartner = -1;
    for (let index = 0; index < pairs; index += 1) {
      if (index > 0 && localIndices[index]! <= localIndices[index - 1]!)
        throw new InternalConsistencyError(
          `${this.id}: the PSI engine's association table is not in response order`,
        );
      largestPartner = Math.max(largestPartner, partnerIndices[index]!);
    }
    const next = new Uint32Array(largestPartner + 2);
    for (let index = 0; index < pairs; index += 1)
      next[partnerIndices[index]! + 1] += 1;
    for (let partner = 1; partner < next.length; partner += 1)
      next[partner] += next[partner - 1]!;
    const local = new Array<number>(pairs);
    const partner = new Array<number>(pairs);
    for (let index = 0; index < pairs; index += 1) {
      const at = next[partnerIndices[index]!]!;
      next[partnerIndices[index]!] = at + 1;
      local[at] = localIndices[index]!;
      partner[at] = partnerIndices[index]!;
    }
    return [local, partner];
  }

  receiveIndexTable(indexTable: Int32Array): Promise<void> {
    return settled(() =>
      this.latchingRoundFailure(() => this.takeIndexTable(indexTable)),
    );
  }

  private takeIndexTable(indexTable: Int32Array): void {
    this.requireClient("receiveIndexTable");
    this.requireMode("receiveIndexTable", "count-only-permuted");
    this.refuseAfterFailedRound("receiveIndexTable");
    if (this.heldSetup === undefined)
      throw new Error(
        `${this.id}: receiveIndexTable called before the partner's setup completed`,
      );
    if (this.#heldIndexTable !== undefined)
      throw new InternalConsistencyError(
        `${this.id}: a second index table arrived for one setup`,
      );
    const entries = indexTable.length;
    if (entries !== this.heldSetupElements)
      throw new PartnerProtocolRefusalError(
        `${this.id} protocol error: the partner's index table has ${String(entries)} entries for a setup of ${String(this.heldSetupElements)} elements`,
      );
    if (this.senderRecords !== undefined && entries !== this.senderRecords)
      throw new PartnerProtocolRefusalError(
        `${this.id} protocol error: the partner's index table has ${String(entries)} entries where the exchange's first had ${String(this.senderRecords)}`,
      );
    assertIndexTableIsPermutation(this.id, indexTable);
    this.senderRecords = entries;
    this.#heldIndexTable = indexTable.slice();
  }

  matchPermutedRound(responseBytes: Uint8Array): Promise<void> {
    return settled(() =>
      this.latchingRoundFailure(() => this.permutedRoundOf(responseBytes)),
    );
  }

  private permutedRoundOf(responseBytes: Uint8Array): void {
    this.requireClient("matchPermutedRound");
    this.requireMode("matchPermutedRound", "count-only-permuted");
    this.refuseAfterFailedRound("matchPermutedRound");
    if (this.countTaken)
      throw new InternalConsistencyError(
        `${this.id}: matchPermutedRound called after the count was taken`,
      );
    const indexTable = this.#heldIndexTable;
    const receiverRecords = this.receiverRecords;
    if (indexTable === undefined || receiverRecords === undefined)
      throw new Error(
        `${this.id}: matchPermutedRound called before the round's index table and request`,
      );
    // Before any element is matched, so the refusal does not depend on a match.
    assertResponseElementsDistinct(this.id, responseBytes);
    const match = this.beginMatch("matchPermutedRound", "count-only-permuted");
    this.#heldIndexTable = undefined;
    try {
      const result = this.matchStreamed(match, responseBytes);
      if (result.decryptedCount !== receiverRecords)
        throw new PartnerProtocolRefusalError(
          `${this.id} protocol error: the partner's PSI response has ${String(result.decryptedCount)} elements for a request of ${String(receiverRecords)}`,
        );
      const pairs = result.associationTable;
      if (pairs === undefined)
        throw new InternalConsistencyError(
          `${this.id}: the PSI engine's revealing match returned no pairs`,
        );
      const [slots, setupPositions] = pairs;
      const pseudonyms = new Int32Array(setupPositions.length);
      for (let pair = 0; pair < setupPositions.length; pair += 1)
        pseudonyms[pair] = indexTable[setupPositions[pair]!]!;
      const replay = (this.#replay ??= new PermutedCountReplay(
        receiverRecords,
        indexTable.length,
      ));
      try {
        replay.acceptRound(this.id, slots, pseudonyms);
      } finally {
        slots.fill(0);
        setupPositions.fill(0);
        pseudonyms.fill(0);
      }
    } finally {
      indexTable.fill(0);
    }
  }

  finishPermutedCount(): Promise<number> {
    return settled(() => {
      this.requireClient("finishPermutedCount");
      this.requireMode("finishPermutedCount", "count-only-permuted");
      this.refuseAfterFailedRound("finishPermutedCount");
      const replay = this.#replay;
      if (replay === undefined || this.countTaken)
        throw new InternalConsistencyError(
          `${this.id}: finishPermutedCount called with no round matched, or a second time`,
        );
      if (this.receivingSetup !== undefined || this.heldSetup !== undefined)
        throw new InternalConsistencyError(
          `${this.id}: finishPermutedCount called while a round's setup awaits its match`,
        );
      const count = replay.count;
      replay.discard();
      this.#replay = undefined;
      this.countTaken = true;
      return count;
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.#pi?.discard();
    this.#sigma?.discard();
    this.#replay?.discard();
    this.#pi = undefined;
    this.#sigma = undefined;
    this.#replay = undefined;
    this.freeSetup();
    // The server / client objects hold the secret key in engine memory, which
    // garbage collection does not reclaim; only delete() frees it.
    this.server?.delete();
    this.client?.delete();
  }
}

// `run`'s outcome as a promise, a throw included, so a caller chaining on it
// sees every refusal as a rejection.
function settled<T>(run: () => T | PromiseLike<T>): Promise<T> {
  try {
    return Promise.resolve(run());
  } catch (error) {
    return Promise.reject(error);
  }
}
