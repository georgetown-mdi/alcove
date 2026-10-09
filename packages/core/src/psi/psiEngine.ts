import type { Client as PSIClient } from "@openmined/psi.js/implementation/client.d.ts";
import type {
  Match as PSIMatch,
  MatchResult as PSIMatchResult,
} from "@openmined/psi.js/implementation/match.d.ts";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type { Server as PSIServer } from "@openmined/psi.js/implementation/server.d.ts";

import { countDeclaredPsiElements } from "../connection/psiElementScan";
import {
  InternalConsistencyError,
  markPsiLibraryFailure,
  PartnerProtocolRefusalError,
} from "../errors";
import { DistinctValues } from "../utils/distinctValues";
import {
  appendChunkElements,
  buildRequest,
  buildResponse,
  chunkRangesOfSize,
  mergeCountOnlyResponseChunks,
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
interface SetupInProgress {
  readonly match: PSIMatch;
  bytes: number;
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
 * - `count-only` -- the psi-c construction (docs/spec/PROTOCOL.md, PSI-C): the
 *   round resolves to the intersection cardinality alone, and the operations that
 *   would name the matches refuse.
 *
 * The mode is fixed when the engine is constructed, never chosen per call: it is
 * the library's reveal-intersection flag, which rides the receiver's request and
 * which the sender enforces agreement on, so it is a property of the round both
 * parties ran rather than a local preference.
 */
export type PsiEngineMode = "identifier-revealing" | "count-only";

// Every mode decision in the engine derives from this one test, so an engine has
// exactly two states and never a hybrid third. TypeScript does not reach a JS caller
// of the published package, which can pass a string outside PsiEngineMode; deriving
// each decision here puts any such value wholly on the count-only side -- the
// nondisclosing one -- rather than clearing the reveal flag while leaving the
// contribution filter and the sorting permutation set for `psi`.
function modeRevealsIdentifiers(mode: PsiEngineMode): boolean {
  return mode === "identifier-revealing";
}

// Names an engine's mode back from that one boolean, so a refusal reports one of the
// two states rather than echoing whatever string constructed the engine.
function modeName(revealsIdentifiers: boolean): PsiEngineMode {
  return revealsIdentifiers ? "identifier-revealing" : "count-only";
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
 * @internal
 *
 * The values a party contributes to a count-only round: those occurring
 * EXACTLY ONCE in its own dataset, in input order. Every occurrence of a
 * repeated value is dropped, not just the later ones -- an ambiguous match
 * cannot be attributed to a single record.
 *
 * Normative for psi-c (docs/spec/PROTOCOL.md, PSI-C), and not a filter the
 * library applies: its cardinality operation reports the size of the
 * MULTISET intersection, where a value repeated on both sides contributes
 * the smaller of the two multiplicities. A count-only round shows no
 * identifier that would contradict such a figure, so the filter is applied
 * here, at the point that owns the contribution, rather than left to a
 * caller.
 */
export function valuesContributedExactlyOnce(
  values: ReadonlyArray<string>,
): Array<string> {
  const distinct = new DistinctValues();
  const occurrences: Array<number> = [];
  const positions = values.map((value) => {
    const size = distinct.size;
    const position = distinct.add(value);
    if (position === size) occurrences.push(1);
    else ++occurrences[position];
    return position;
  });
  return values.filter((_value, i) => occurrences[positions[i]] === 1);
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
   *
   * A count-only engine contributes only the values occurring exactly once in
   * `values` and returns an EMPTY permutation: that round has no pairing to map
   * back to rows, and the library's permutation indexes the filtered contribution
   * rather than `values`, so it is not a correspondence a caller could use.
   */
  createServerSetup(
    values: ReadonlyArray<string>,
  ): Promise<{ setup: Uint8Array; permutation: Array<number> }>;
  /**
   * Doubly-encrypts a deserialized-from-`requestBytes` client request under the
   * server key, returning the serialized response. Server role.
   */
  processClientRequest(requestBytes: Uint8Array): Promise<Uint8Array>;
  /**
   * Encrypts this party's values once under the client key. Client role. A
   * count-only engine contributes only the values occurring exactly once in
   * `values`, and the request holds its cleared reveal flag, which the
   * partner's server enforces agreement on.
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
   * {@link computeIntersectionCardinality}. Client role. Split from the match
   * so the joiner can validate the setup as it arrives (a fail-fast before it
   * sends its own request), while the response it matches against arrives a
   * round trip later.
   */
  completeServerSetup(): Promise<void>;
  /**
   * Frees the partner's setup, whether its pieces are still arriving or it
   * awaits its match, so a round a refusal ends holds none past the refusal.
   * A no-op when no setup is held. Client role.
   */
  discardServerSetup(): Promise<void>;
  /**
   * Removes this party's encryption layer from the partner's doubly-encrypted
   * response and compares it against the setup the preceding
   * {@link completeServerSetup} holds, returning
   * `[localIndices, partnerIndices]` ordered by partner index, as the
   * library's own call orders them. Client role; throws if no setup is held.
   * Identifier-revealing mode only: a count-only engine refuses instead of
   * returning a pairing.
   */
  computeAssociationTable(
    responseBytes: Uint8Array,
  ): Promise<[Array<number>, Array<number>]>;
  /**
   * Removes this party's encryption layer from the partner's doubly-encrypted
   * response and reports the SIZE of the intersection against the setup the
   * preceding {@link completeServerSetup} holds -- no identifier, no pairing,
   * no matched position. Client role; throws if no setup is held. Count-only
   * mode only: an identifier-revealing engine refuses, so the disclosure a
   * round produces stays the one its key was created for. The streamed match
   * marks each setup element a decrypted response element equals and counts
   * the marks once the whole response is fed, so the count is the same
   * however the response is cut and never leaves the engine per piece.
   */
  computeIntersectionCardinality(responseBytes: Uint8Array): Promise<number>;
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
   * whole isolate). Terminal: no other method may be called after dispose().
   */
  dispose(): void;
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
export class InProcessPsiEngine implements PsiEngine {
  private readonly library: PSILibrary;
  private readonly id: string;
  private readonly revealsIdentifiers: boolean;
  private readonly server?: PSIServer;
  private readonly client?: PSIClient;
  // The joiner's setup from its first piece until it completes, then until
  // the match that consumes it. Undefined outside those windows. A completed
  // setup is a live library object, so the engine holds it, not its caller.
  private receivingSetup: SetupInProgress | undefined;
  private heldSetup: PSIMatch | undefined;
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
    this.revealsIdentifiers = modeRevealsIdentifiers(mode);
    this.chunkElements = options.chunkElements;
    this.maskingMemoryBudgetBytes = options.maskingMemoryBudgetBytes;
    // Generate the fresh secret key for this exchange, held inside the
    // library's server / client object. An unresolved ("either") role
    // creates neither; the role-guarded methods below then reject.
    if (role === "starter") {
      this.server = library.server!.createWithNewKey(this.revealsIdentifiers);
    } else if (role === "joiner") {
      this.client = library.client!.createWithNewKey(this.revealsIdentifiers);
    }
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
    const server = this.server;
    if (!server)
      throw new Error(`${this.id}: createServerSetup requires the server role`);
    const countOnly = !this.revealsIdentifiers;
    const contributed = countOnly
      ? valuesContributedExactlyOnce(values)
      : values;
    const ranges = this.rangesFor(contributed.length, "createSetupMessage");
    // One chunk is the single call this operation has always been: the
    // library's own message goes out as it serialized it, with no element list
    // materialized beside it and no merge to reproduce its sort.
    if (ranges.length === 1) {
      const sortingPermutation: Array<number> = [];
      const setup = server.createSetupMessage(
        SETUP_FALSE_POSITIVE_RATE,
        SETUP_CLIENT_INPUT_COUNT,
        contributed,
        this.library.dataStructure.Raw,
        sortingPermutation,
      );
      return Promise.resolve({
        setup: setup.serializeBinary(),
        permutation: countOnly ? [] : sortingPermutation,
      });
    }
    const merged = mergeSetupChunks(
      this.overChunks(ranges, (range) => ({
        start: range.start,
        ...this.maskSetupChunk(
          server,
          contributed.slice(range.start, range.end),
        ),
      })),
    );
    return Promise.resolve({
      setup: serializeSetup(this.library, merged.elements),
      permutation: countOnly ? [] : merged.permutation,
    });
  }

  processClientRequest(requestBytes: Uint8Array): Promise<Uint8Array> {
    const server = this.server;
    if (!server)
      throw new Error(
        `${this.id}: processClientRequest requires the server role`,
      );
    const request = fromLibrary(() =>
      this.library.request.deserializeBinary(requestBytes),
    );
    // The request states the reveal flag, and the library refuses to serve a
    // request whose flag disagrees with the key this server was created
    // under -- the wire-enforced mode agreement (docs/spec/PROTOCOL.md,
    // PSI-C). Read the flag and name both modes here, rather than leave the
    // library's refusal, which the frame boundary reports as a request that
    // failed to decode. Fixed literals only: the request is partner-supplied.
    if (request.getRevealIntersection() !== this.revealsIdentifiers)
      throw new Error(
        `${this.id} protocol error: the partner's PSI request ran the ` +
          `${modeName(request.getRevealIntersection())} mode, where this ` +
          `exchange runs ${modeName(this.revealsIdentifiers)}`,
      );
    const ranges = this.rangesFor(
      request.getEncryptedElementsList().length,
      "processRequest",
    );
    // One chunk is the single call: the partner's request is re-encrypted as
    // the library deserialized it, so nothing materializes its element list.
    if (ranges.length === 1)
      return Promise.resolve(
        fromLibrary(() => server.processRequest(request)).serializeBinary(),
      );
    const inbound = request.getEncryptedElementsList_asU8();
    const maskChunk = (range: PsiChunkRange): Array<Uint8Array> =>
      fromLibrary(() =>
        server.processRequest(
          buildRequest(
            this.library,
            inbound.slice(range.start, range.end),
            this.revealsIdentifiers,
          ),
        ),
      ).getEncryptedElementsList_asU8();
    // A count-only response is sorted by element bytes, so the whole masked
    // list is held to order it; an identifier-revealing one answers position
    // by position, so each chunk goes straight into the outgoing message.
    if (!this.revealsIdentifiers)
      return Promise.resolve(
        serializeResponse(
          this.library,
          mergeCountOnlyResponseChunks(this.overChunks(ranges, maskChunk)),
        ),
      );
    const response = buildResponse(this.library, []);
    this.overChunks(ranges, (range) =>
      appendChunkElements(response, maskChunk(range)),
    );
    return Promise.resolve(response.serializeBinary());
  }

  createClientRequest(values: ReadonlyArray<string>): Promise<Uint8Array> {
    const client = this.client;
    if (!client)
      throw new Error(
        `${this.id}: createClientRequest requires the client role`,
      );
    const contributed = this.revealsIdentifiers
      ? values
      : valuesContributedExactlyOnce(values);
    const ranges = this.rangesFor(contributed.length, "createRequest");
    if (ranges.length === 1)
      return Promise.resolve(
        client.createRequest(contributed).serializeBinary(),
      );
    // A request holds its elements in input order, so each chunk's masked
    // elements go straight into the outgoing message, with no list held
    // beside it to concatenate.
    const request = buildRequest(this.library, [], this.revealsIdentifiers);
    this.overChunks(ranges, (range) =>
      appendChunkElements(
        request,
        client
          .createRequest(contributed.slice(range.start, range.end))
          .getEncryptedElementsList_asU8(),
      ),
    );
    return Promise.resolve(request.serializeBinary());
  }

  receiveServerSetup(setupBytes: Uint8Array): Promise<void> {
    return this.receiveServerSetupPiece(setupBytes).then(() =>
      this.completeServerSetup(),
    );
  }

  receiveServerSetupPiece(piece: Uint8Array): Promise<void> {
    return settled(() => this.takeSetupPiece(piece));
  }

  completeServerSetup(): Promise<void> {
    return settled(() => this.endSetup());
  }

  discardServerSetup(): Promise<void> {
    this.freeSetup();
    return Promise.resolve();
  }

  // A streamed match holds its own copy of the client key in engine memory,
  // freed only by its delete().
  private freeSetup(): void {
    const receiving = this.receivingSetup;
    const held = this.heldSetup;
    this.receivingSetup = undefined;
    this.heldSetup = undefined;
    receiving?.match.delete();
    held?.delete();
  }

  private takeSetupPiece(piece: Uint8Array): void {
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
      };
      this.receivingSetup = receiving;
    }
    const match = receiving.match;
    this.setupStep(receiving, () => match.addSetupBytes(piece));
    receiving.bytes += piece.byteLength;
  }

  private endSetup(): void {
    const receiving = this.receivingSetup;
    if (receiving === undefined)
      throw new InternalConsistencyError(
        `${this.id}: completeServerSetup called before any setup piece`,
      );
    const match = receiving.match;
    this.setupStep(receiving, () => match.sealSetup());
    this.receivingSetup = undefined;
    this.heldSetup = match;
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
    if (!this.client)
      throw new Error(`${this.id}: ${operation} requires the client role`);
    if (this.revealsIdentifiers !== modeRevealsIdentifiers(requiredMode))
      throw new Error(
        `${this.id}: ${operation} requires a ${requiredMode} PSI engine; this one is ${modeName(this.revealsIdentifiers)}`,
      );
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

  computeIntersectionCardinality(responseBytes: Uint8Array): Promise<number> {
    return settled(() => this.intersectionCardinalityOf(responseBytes));
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

  private intersectionCardinalityOf(
    responseBytes: Uint8Array,
  ): Promise<number> {
    const match = this.beginMatch(
      "computeIntersectionCardinality",
      "count-only",
    );
    return Promise.resolve(
      this.matchStreamed(match, responseBytes).intersectionSize,
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
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
