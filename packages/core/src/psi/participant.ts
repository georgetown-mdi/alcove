import * as z from "zod";

import type { AssociationTable, Config } from "../types";
import type { MessageConnection } from "../connection/messageConnection";
import {
  MAX_PSI_DECODE_ELEMENTS,
  type PsiElementBounds,
} from "../connection/frameSize";
import {
  countDeclaredPsiElements,
  PsiElementScan,
  type PsiMessageKind,
} from "../connection/psiElementScan";
import { singleIssueArray } from "../utils/singleIssueArray";
import {
  assertPartnerIndexCount,
  assertPartnerIndices,
  assertPartnerIndexTable,
} from "../utils/partnerIndices";
import {
  ConnectionError,
  InternalConsistencyError,
  PartnerProtocolRefusalError,
  RoundSetLimitError,
} from "../errors";
import { sendAbort } from "../protocolSetup";
import {
  PSI_SET_TOO_LARGE_ABORT_REASON,
  receiveAfterTerms,
} from "../partnerAbortFrame";
import { decodeIndexTable, encodeIndexTable } from "./countOnlyPermutation";
import type { CountOnlyDeclaredCounts } from "./countOnlyRounds";
import { decodePsiBinaryFrame, receivePsiBinaryFrame } from "./psiBinaryFrame";
import { InProcessPsiEngine, type PsiEngine } from "./psiEngine";
import { PsiOperationStoppedError } from "./psiWorkerEngine";
import {
  ownSetOverPartnerCeilingMessage,
  ownSetTooLargeMessage,
  psiSetByteBound,
  receivePsiSet,
  receivePsiSetInPieces,
  sendPsiSet,
  type PsiSetCapacity,
} from "./psiSetParts";
import type { RoundGroupingField } from "./roundGrouping";
import {
  receiveRoundGrouping,
  receiveRoundIndexList,
  sendRoundGrouping,
  sendRoundIndexList,
  type RoundGroupingSizeBounds,
} from "./roundTableParts";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { getLoggerForVerbosity } from "../utils/logger";

const statusCompletedMessage = z.object({
  status: z.literal("completed"),
});

const ASSOCIATION_TABLE_PARTNER_HALF = "round association table, partner half";
const ASSOCIATION_TABLE_LOCAL_HALF = "round association table, local half";
const ASSOCIATION_TABLE_GROUPING = "round association table grouping";
const ORIGINAL_INDEX_LIST = "round original-index list";
const ORIGINAL_INDEX_LIST_GROUPING = "round original-index list grouping";

// Single-pass's resolved association table, one frame.
// CONFIRMED-EXPOSED to Zod's issue-accumulation stack overflow: a partner can
// send a tuple whose inner index array holds hundreds of thousands of invalid
// (non-number) elements, and Zod overflows its call stack spreading one issue
// per element up through the inner-array and tuple frames (RangeError reproduced
// at ~130k on Zod 4.5.4). The strict parse already caught that harmlessly; the
// single-issue validators below turn it into a clean, bounded rejection instead.
// A count `.max()` is not an option: the association table is the PSI
// intersection, legitimately in the millions (MAX_FRAME_SIZE_BYTES bounds it),
// so any overflow-forestalling count bound would reject a real result. Each
// validator mirrors `z.number()` exactly via Number.isFinite (which, like
// z.number(), accepts every finite number and rejects NaN/Infinity and
// non-numbers). See utils/singleIssueArray.ts.
/** @internal */
export const associationTableMessage = z.tuple([
  singleIssueArray<number>(
    Number.isFinite,
    "must be an array of finite numbers",
  ),
  singleIssueArray<number>(
    Number.isFinite,
    "must be an array of finite numbers",
  ),
]);

/**
 * The per-round grouping exchange {@link PSIParticipant.identifyIntersection}
 * drives across the round's two position-naming frames: it asks this party
 * for its own grouping once the round's matched positions are known, and
 * hands the partner's over to be checked before the round returns
 * (docs/spec/PROTOCOL.md, The per-round grouping the two frames hold).
 */
export interface RoundGroupingExchange {
  /**
   * This party's own grouping over the positions it matched in the round, or
   * `undefined` to omit the field.
   */
  describe(
    matchedPositions: ReadonlyArray<number>,
  ): RoundGroupingField | undefined;
  /**
   * Check the partner's grouping against local state and hold it. Raises a
   * classified `protocol` error at the round on any deviation.
   *
   * @param field - The grouping as it arrived, `undefined` where the frame
   *   omitted it.
   * @param matchedPositions - The positions the frame names for the partner.
   */
  accept(
    field: RoundGroupingField | undefined,
    matchedPositions: ReadonlyArray<number>,
  ): void;
  /** What the partner's grouping list is sized against as it arrives. */
  readonly partnerSizeBounds: RoundGroupingSizeBounds;
}

const DEFAULT_VERBOSITY = 1;

/**
 * How far along one step of an exchange is, for a progress display. The list of
 * steps belongs to the surface showing it -- each labels its own stages with one
 * of these states -- so this enum is the shared vocabulary, not a stage model.
 */
export enum ProcessState {
  BeforeStart,
  Waiting,
  Working,
  Done,
}

/**
 * Which crypto operation a {@link PsiProgress} report describes, named by the
 * {@link PSIParticipant} method that runs it. These are the operations that mask
 * or match every element of a set, so they are the ones a long round spends its
 * minutes inside.
 *
 * One more, `countFirstRoundValues`, is no crypto operation: it is the count
 * the first-round size checks take over this party's records before this
 * party sends a set: `assertFirstRoundWithinSetMaximum` before contact, and
 * the check against the partner's stated receive ceiling after the terms
 * exchange. Its `elements` and `processed` count records, not values.
 * Its `started` and `progress` reports give the dataset's full row count as
 * `elements`; its `finished` and `failed` reports give the count of rows the
 * check actually walked, which is short of the row count when a
 * deduplicating party's growing count let it stop before the last row.
 */
export type PsiOperation =
  | "createServerSetup"
  | "processClientRequest"
  | "createClientRequest"
  | "computeAssociationTable"
  | "computeIntersectionCardinality"
  | "countFirstRoundValues";

/**
 * Where one crypto operation stands: `started` when the participant dispatched
 * it to the engine, `progress` each time the engine has finished part of the
 * set, and `finished` or `failed` when the engine settled. An operation that
 * failed did not produce a result, so a display shows no completion figure for
 * it.
 */
export type PsiProgressState = "started" | "progress" | "finished" | "failed";

/**
 * One report about a PSI crypto operation, for a progress display. Every figure
 * is a count or a duration -- how many elements the operation covers and how
 * long it ran -- never a value from either party's data, and none of it goes on
 * the wire.
 */
export interface PsiProgress {
  operation: PsiOperation;
  /**
   * How many encrypted elements the operation covers: the values it was handed,
   * for one that masks this party's own set, and the element count the frame
   * declares, for one that reads the partner's.
   */
  elements: number;
  state: PsiProgressState;
  /**
   * How many of `elements` the operation has finished masking or matching.
   * Present on `progress` alone, and always short of `elements`: the engine
   * reports between the chunks it splits a large set into, never after the
   * last one, whose figure the `finished` report states. A match reports
   * between the pieces it feeds the partner's response to the engine in.
   */
  processed?: number;
  /**
   * Wall-clock milliseconds the operation ran, measured on the monotonic clock
   * so a clock adjustment cannot make it negative. Present on `finished` and
   * `failed`, absent on `started` and `progress`.
   */
  durationMs?: number;
}

/**
 * Takes each {@link PsiProgress} report from a {@link PSIParticipant}. Called
 * synchronously from the participant's own call path, so an implementation
 * returns quickly and does not throw: a raise on a `started`, `finished`, or
 * `failed` report reaches the exchange. A raise on a `progress` report is
 * dropped instead -- that operation is already part-run and its result is
 * still to come, so a fault in a display must not abort the round.
 */
export type PsiProgressReporter = (progress: PsiProgress) => void;

/**
 * The receive ceilings a round holds PSI sets to, each the most values one
 * set may hold: `local`, this party's own, which a setup or a request it
 * receives is held to before decode; `partner`, the one the partner stated on
 * the terms exchange, which every set this party builds is held to
 * (docs/spec/PROTOCOL.md, "The receive ceiling").
 */
export interface PsiSetCeilings {
  readonly local: number;
  readonly partner: number;
}

const PROTOCOL_SET_CEILINGS: PsiSetCeilings = {
  local: MAX_PSI_DECODE_ELEMENTS,
  partner: MAX_PSI_DECODE_ELEMENTS,
};

interface SentRequest {
  readonly bytes: number;
  readonly elements: number;
}

export class PSIParticipant {
  id: string;
  config: Config;
  private log: ReturnType<typeof getLoggerForVerbosity>;
  private elementBounds: PsiElementBounds;
  private engine: PsiEngine;
  private onProgress?: PsiProgressReporter;
  private setCeilings: PsiSetCeilings;
  // The request this party sent that no response has answered yet, which
  // bounds that response (docs/spec/TRANSPORT_BOUNDS.md, PSI set parts).
  private sentRequest: SentRequest | undefined;
  // The operation now dispatched to the engine, for the mid-operation reports
  // the engine raises against it and for operationInFlight. Undefined between
  // operations.
  private runningOperation:
    { operation: PsiOperation; elements: number } | undefined;
  private stopReason: () => Error | undefined = () => undefined;
  private permutedRoundsMatched = 0;

  constructor(
    id: string,
    library: PSILibrary,
    config: Config,
    // Per-message caps on the encrypted-element count each inbound PSI
    // frame may declare, derived from authenticated session state (the
    // agreed key count and the two exchanged record counts; see
    // psiElementBounds in frameSize.ts) and enforced at every
    // deserializeBinary call site below. Required, not defaulted: a
    // fail-open default would silently drop the amplification guard on a
    // caller that forgot it.
    elementBounds: PsiElementBounds,
    // The crypto engine backing this participant. Defaults to an
    // in-process engine built from `library`, with the masking running on
    // the calling thread. The CLI injects a worker-backed engine so the
    // masking runs off the event-loop-owning thread; that engine holds the
    // key objects in its worker, so `library` is used only to build the
    // default.
    engine?: PsiEngine,
    // Takes a report as each crypto operation below starts and settles, for a
    // caller rendering a progress display. Omitted, no report is composed at
    // all, so a caller that shows nothing pays nothing.
    onProgress?: PsiProgressReporter,
    // The two parties' receive ceilings. Omitted, both are the protocol's
    // per-set maximum, which every set is held to whatever is given.
    setCeilings: PsiSetCeilings = PROTOCOL_SET_CEILINGS,
  ) {
    this.id = id;
    this.config = config;
    this.elementBounds = elementBounds;
    this.onProgress = onProgress;
    this.setCeilings = setCeilings;

    if (this.config.verbose === undefined) {
      this.config.verbose = DEFAULT_VERBOSITY;
    }

    this.log = getLoggerForVerbosity("participant", this.config.verbose);

    this.engine =
      engine ??
      new InProcessPsiEngine(
        library,
        this.config.role,
        this.id,
        "identifier-revealing",
      );
    // Take the engine's processed counts only where a caller is rendering
    // them, so a participant that shows nothing composes no report at all.
    if (onProgress !== undefined)
      this.engine.observeProcessedElements?.((processed) =>
        this.reportProcessed(processed),
      );
  }

  // One mid-operation report, naming the operation the participant dispatched
  // and the count the engine has reached. Best effort: the operation is already
  // part-run and its result is still to come, so a reporter that raises here is
  // dropped rather than failing the round, unlike the started and settled
  // reports below.
  private reportProcessed(processed: number): void {
    const running = this.runningOperation;
    const report = this.onProgress;
    if (running === undefined || report === undefined) return;
    try {
      report({
        operation: running.operation,
        elements: running.elements,
        state: "progress",
        processed,
      });
    } catch {
      // Dropped; the operation continues and its settle report follows.
    }
  }

  /** Whether a crypto operation is dispatched to the engine and not yet settled. */
  operationInFlight(): boolean {
    return this.runningOperation !== undefined;
  }

  /**
   * Refuse each later crypto operation once `stopReason` returns an error,
   * throwing that error instead of dispatching the operation, so a step whose
   * result can no longer be sent, such as one on a connection that has ended,
   * does not start. An operation already dispatched runs to its end unless
   * {@link stopOperationInFlight} cuts it short.
   */
  stopOperationsWhen(stopReason: () => Error | undefined): void {
    this.stopReason = stopReason;
  }

  /**
   * Ask the operation in flight to stop at its next chunk boundary, and
   * return whether it will (see {@link PsiEngine.stopInFlight}). It then fails
   * with the error {@link stopOperationsWhen} reports, where that has one.
   */
  stopOperationInFlight(): boolean {
    return this.engine.stopInFlight?.() ?? false;
  }

  /**
   * Release the crypto engine's resources (see {@link PsiEngine.dispose}). Call at
   * exchange teardown: a no-op for the default in-process engine, but the
   * worker-backed engine terminates its worker here so the process can exit.
   */
  dispose(): void {
    this.engine.dispose();
  }

  // Reject a partner-supplied PSI frame that DECLARES more encrypted
  // elements than allowed, by scanning the protobuf wire format before
  // handing the bytes to deserializeBinary -- which allocates one heap
  // object (~211 bytes, measured) per declared repeated entry. Without a
  // pre-scan, a malicious partner could pack many minimal (~2-byte)
  // repeated entries within the frame byte cap -- declaring up to
  // ~frameBytes/2 elements -- and exhaust memory (tens of GiB) inside
  // deserializeBinary itself, before any post-deserialize count could read
  // it. The ceiling is the tightest of the authenticated
  // `keyCount * recordCount` bound (both parties compute it identically
  // from authenticated session state), the absolute
  // {@link MAX_PSI_DECODE_ELEMENTS}, which binds a cascade frame whose
  // partner over-declares its record count, and, for a setup or a request,
  // which hold the partner's own set, this party's receive ceiling. The scan
  // stops as soon as the count exceeds the ceiling, so an over-declared frame
  // costs O(ceiling), not O(frame); a malformed frame is a clean protocol
  // abort too. See
  // connection/psiElementScan.ts.
  // Returns the count the frame declares, for the progress report on the
  // operation that follows: the scan stops early only above the ceiling, and
  // such a frame is rejected here, so the figure returned is the scan's own
  // count -- exact for a conforming frame, an upper bound otherwise.
  private assertInboundElementBound(
    kind: PsiMessageKind,
    bytes: Uint8Array,
    authenticatedBound: number,
  ): number {
    const ceiling = this.inboundElementCeiling(kind, authenticatedBound);
    return this.assertScanWithinCeiling(kind, ceiling, () =>
      countDeclaredPsiElements(bytes, kind, ceiling),
    );
  }

  private inboundElementCeiling(
    kind: PsiMessageKind,
    authenticatedBound: number,
  ): number {
    return Math.min(
      authenticatedBound,
      MAX_PSI_DECODE_ELEMENTS,
      kind === "response" ? MAX_PSI_DECODE_ELEMENTS : this.setCeilings.local,
    );
  }

  // The refusals of a frame `scan` cannot read or finds declaring more than
  // `ceiling` elements; returns the count it found otherwise.
  private assertScanWithinCeiling(
    kind: PsiMessageKind,
    ceiling: number,
    scan: () => number,
  ): number {
    let declared: number;
    try {
      declared = scan();
    } catch {
      throw new PartnerProtocolRefusalError(
        `${this.id} protocol error: malformed inbound PSI ${kind} frame`,
      );
    }
    if (declared > ceiling)
      throw new PartnerProtocolRefusalError(
        `${this.id} protocol error: inbound PSI ${kind} declares more than ` +
          `${ceiling} encrypted element(s)`,
      );
    return declared;
  }

  private requestAnswered(): SentRequest {
    if (this.sentRequest === undefined)
      throw new PartnerProtocolRefusalError(
        `${this.id} protocol error: inbound PSI response with no request ` +
          "of this party's awaiting one",
      );
    return this.sentRequest;
  }

  private assertResponseWithinRequest(responseBytes: Uint8Array): number {
    const request = this.requestAnswered();
    this.sentRequest = undefined;
    if (responseBytes.byteLength > request.bytes)
      throw new PartnerProtocolRefusalError(
        `${this.id} protocol error: inbound PSI response is ` +
          `${responseBytes.byteLength} bytes, over the ${request.bytes} bytes ` +
          "of the request this party sent",
      );
    return this.assertInboundElementBound(
      "response",
      responseBytes,
      request.elements,
    );
  }

  // Refuse this party's own set before building it when it holds more values
  // than any receiver admits (the cap psiSetByteBound applies) or than the
  // partner stated it can receive: the partner is parked on this set, so it
  // is sent the abort in its place.
  private async refuseOwnSetOverDecodeCap(
    conn: MessageConnection,
    elementCount: number,
  ): Promise<void> {
    const partnerCeiling = this.setCeilings.partner;
    if (elementCount <= Math.min(MAX_PSI_DECODE_ELEMENTS, partnerCeiling))
      return;
    await sendAbort(conn, [PSI_SET_TOO_LARGE_ABORT_REASON]);
    throw elementCount > MAX_PSI_DECODE_ELEMENTS
      ? new RoundSetLimitError(
          ownSetTooLargeMessage(elementCount),
          "over-set-maximum",
        )
      : new RoundSetLimitError(
          ownSetOverPartnerCeilingMessage(elementCount, partnerCeiling),
          "over-partner-ceiling",
        );
  }

  // Receive one of the round's PSI sets in its parts, joined. A request holds
  // the partner's own set: see partnerSetLimits. A response is held to the
  // request this party sent.
  private receiveRoundSet(
    conn: MessageConnection,
    kind: "request" | "response",
  ): Promise<Uint8Array> {
    if (kind === "response")
      return receivePsiSet(conn, this.id, kind, {
        bytes: this.requestAnswered().bytes,
        source: "bytes of the request this party sent",
      });
    const limits = this.partnerSetLimits(this.elementBounds.request);
    return receivePsiSet(
      conn,
      this.id,
      kind,
      limits.maxSetBytes,
      limits.capacity,
    );
  }

  // A setup or a request holds the partner's own set: it is held to the bytes
  // the authenticated element bound for its kind admits, and to this party's
  // receive ceiling, as this party's capacity rather than the protocol's.
  private partnerSetLimits(authenticatedBound: number): {
    maxSetBytes: number;
    capacity: PsiSetCapacity | undefined;
  } {
    const elementBound = Math.min(authenticatedBound, MAX_PSI_DECODE_ELEMENTS);
    const ceiling = this.setCeilings.local;
    return {
      maxSetBytes: psiSetByteBound(elementBound),
      capacity:
        ceiling < elementBound
          ? { setBytes: psiSetByteBound(ceiling), elements: ceiling }
          : undefined,
    };
  }

  // A failure after some parts reached the engine frees the partial setup
  // there; a failure to free it does not replace the original error. Returns
  // the setup's element count.
  private async receiveServerSetupInParts(
    conn: MessageConnection,
  ): Promise<number> {
    try {
      return await this.receiveServerSetupPieces(conn);
    } catch (error) {
      await this.engine.discardServerSetup().catch(() => undefined);
      throw error;
    }
  }

  // Receive the partner's setup in its parts and hand each part to the engine
  // as it arrives, so the setup is never joined: each part is checked as
  // receivePsiSetInPieces checks it and element-scanned before it reaches the
  // engine, so the engine never holds more elements than the scan admits, and
  // the setup completes only once its last part has passed both.
  private async receiveServerSetupPieces(
    conn: MessageConnection,
  ): Promise<number> {
    const limits = this.partnerSetLimits(this.elementBounds.setup);
    const ceiling = this.inboundElementCeiling(
      "serverSetup",
      this.elementBounds.setup,
    );
    let scan: PsiElementScan | undefined;
    await receivePsiSetInPieces(
      conn,
      this.id,
      "serverSetup",
      limits.maxSetBytes,
      limits.capacity,
      async (piece, setBytes) => {
        const setupScan = (scan ??= new PsiElementScan(
          "serverSetup",
          ceiling,
          setBytes,
        ));
        this.assertScanWithinCeiling("serverSetup", ceiling, () =>
          setupScan.add(piece),
        );
        await decodePsiBinaryFrame(this.id, "serverSetup", () =>
          this.engine.receiveServerSetupPiece(piece),
        );
      },
    );
    if (scan === undefined)
      throw new InternalConsistencyError(
        `${this.id}: a PSI setup was received with no part`,
      );
    const completedScan = scan;
    const elements = this.assertScanWithinCeiling("serverSetup", ceiling, () =>
      completedScan.end(),
    );
    await decodePsiBinaryFrame(this.id, "serverSetup", () =>
      this.engine.completeServerSetup(),
    );
    return elements;
  }

  // Report one crypto operation's element count and duration around the engine
  // call that runs it, for a caller rendering a progress display. The timing is
  // taken here, on the participant's own thread, rather than inside the engine:
  // a worker-backed engine runs each chunk of the masking inside a blocking
  // library call, so the elapsed figure a display ticks against has to come
  // from the thread that is free. The engine's own mid-operation counts are
  // reported against the operation named here (see reportProcessed).
  private async reportProgress<T>(
    operation: PsiOperation,
    elements: number,
    run: () => Promise<T>,
  ): Promise<T> {
    const stop = this.stopReason();
    if (stop !== undefined) throw stop;
    const report = this.onProgress;
    if (report === undefined) return this.runTracked(operation, elements, run);
    report({ operation, elements, state: "started" });
    const startedAt = performance.now();
    const durationMs = (): number =>
      Math.max(0, Math.round(performance.now() - startedAt));
    let result: T;
    try {
      result = await this.runTracked(operation, elements, run);
    } catch (error) {
      report({
        operation,
        elements,
        state: "failed",
        durationMs: durationMs(),
      });
      throw error;
    }
    // Outside the try: a reporter that raises on this report must not also
    // relabel the operation that already completed as failed.
    report({
      operation,
      elements,
      state: "finished",
      durationMs: durationMs(),
    });
    return result;
  }

  private async runTracked<T>(
    operation: PsiOperation,
    elements: number,
    run: () => Promise<T>,
  ): Promise<T> {
    this.runningOperation = { operation, elements };
    try {
      return await run();
    } catch (error) {
      if (error instanceof PsiOperationStoppedError)
        throw this.stopReason() ?? error;
      throw error;
    } finally {
      this.runningOperation = undefined;
    }
  }

  // Building-block PSI steps used by the single-pass strategy
  // (linkViaSinglePassPSI in link.ts). Unlike identifyIntersection below, which
  // runs the whole back-and-forth itself, single-pass calls these one at a time
  // and sequences the exchange on its own. Each wraps the underlying PSI library,
  // keeping the secret key and the library's server/client objects private to this
  // class; callers see only raw bytes and lists of indices.

  /**
   * Encrypts this party's values once under the server key, returning the
   * serialized setup message and a "permutation" -- a lookup that undoes the
   * reordering the library does internally. The library sorts the values before
   * encrypting; entry i of the lookup gives the original input position of the
   * value now in sorted slot i, so a match reported in sorted terms can be traced
   * back to the row it came from. Requires the `"starter"` role.
   */
  public async createServerSetup(values: ReadonlyArray<string>): Promise<{
    setup: Uint8Array;
    permutation: Array<number>;
  }> {
    return this.reportProgress("createServerSetup", values.length, () =>
      this.engine.createServerSetup(values),
    );
  }

  /**
   * Doubly-encrypts the partner's request under the server key, returning the
   * serialized response. Requires the `"starter"` role.
   */
  public async processClientRequest(
    requestBytes: Uint8Array,
  ): Promise<Uint8Array> {
    const elements = this.assertInboundElementBound(
      "request",
      requestBytes,
      this.elementBounds.request,
    );
    return this.reportProgress("processClientRequest", elements, () =>
      decodePsiBinaryFrame(this.id, "request", () =>
        this.engine.processClientRequest(requestBytes),
      ),
    );
  }

  /**
   * Encrypts this party's set once under the client key, returning the serialized
   * request. Requires the `"joiner"` role.
   */
  public async createClientRequest(
    values: ReadonlyArray<string>,
  ): Promise<Uint8Array> {
    if (this.sentRequest !== undefined)
      throw new InternalConsistencyError(
        `${this.id}: a PSI request was created while this party's previous ` +
          "request had no response",
      );
    const request = await this.reportProgress(
      "createClientRequest",
      values.length,
      () => this.engine.createClientRequest(values),
    );
    this.sentRequest = {
      bytes: request.byteLength,
      elements: countDeclaredPsiElements(
        request,
        "request",
        Number.MAX_SAFE_INTEGER,
      ),
    };
    return request;
  }

  /**
   * Finishes the match for this party: removes its own encryption layer from the
   * partner's doubly-encrypted response and compares it against the partner's
   * setup, returning the list of value matches. Each pair is `[index among this
   * party's distinct values, index among the partner's values]`. WARNING: these
   * index de-duplicated VALUES, not data rows -- the cascade replay (link.ts) is
   * what turns them into record pairs. The partner's index is in the library's
   * internal sorted order; map it back to input order with the permutation from
   * {@link createServerSetup}. Requires the `"joiner"` role.
   */
  public async computeValueMatches(
    setupBytes: Uint8Array,
    responseBytes: Uint8Array,
  ): Promise<[Array<number>, Array<number>]> {
    await this.receiveServerSetup(setupBytes);
    return this.computeAssociationTable(responseBytes);
  }

  // The single-pass setup, which arrives whole inside its message: the
  // host-side element-count guard, then the engine takes, checks and holds
  // it. The guard runs here, above the engine boundary, so the engine only
  // ever reads an already-bounded frame.
  private receiveServerSetup(setupBytes: Uint8Array): Promise<void> {
    this.assertInboundElementBound(
      "serverSetup",
      setupBytes,
      this.elementBounds.setup,
    );
    return decodePsiBinaryFrame(this.id, "serverSetup", () =>
      this.engine.receiveServerSetup(setupBytes),
    );
  }

  private computeAssociationTable(
    responseBytes: Uint8Array,
  ): Promise<[Array<number>, Array<number>]> {
    const elements = this.assertResponseWithinRequest(responseBytes);
    return this.reportProgress("computeAssociationTable", elements, () =>
      decodePsiBinaryFrame(this.id, "response", () =>
        this.engine.computeAssociationTable(responseBytes),
      ),
    );
  }

  /**
   * Runs one round of the count-only construction over every agreed key
   * (docs/spec/PROTOCOL.md, PSI-C, The frames of one round): the sender's
   * setup and index table, the receiver's request, the sender's permuted
   * response. `set` has one element per record of this party, the receiver's
   * in its request order. Each partner set is held to the record count
   * `declared` states for it, and a refusal is a protocol error raised before
   * the round goes on. The round returns nothing on either party: the
   * receiver's engine keeps its pairs, and {@link finishPermutedCount}
   * returns the count after the last round. Requires a participant whose
   * engine was built `count-only-permuted`.
   */
  public async countPermutedRound(
    conn: MessageConnection,
    set: ReadonlyArray<string>,
    declared: CountOnlyDeclaredCounts,
  ): Promise<void> {
    const isSender = this.config.role === "starter";
    const ownRecords = isSender
      ? declared.senderRecords
      : declared.receiverRecords;
    if (set.length !== ownRecords)
      throw new InternalConsistencyError(
        `${this.id}: a count-only round set has ${String(set.length)} elements for ${String(ownRecords)} declared records`,
      );
    if (isSender) await this.sendPermutedRound(conn, set, declared);
    else await this.receivePermutedRound(conn, set, declared);
  }

  private async sendPermutedRound(
    conn: MessageConnection,
    set: ReadonlyArray<string>,
    declared: CountOnlyDeclaredCounts,
  ): Promise<void> {
    await this.refuseOwnSetOverDecodeCap(conn, set.length);
    const { setup, indexTable } = await this.reportProgress(
      "createServerSetup",
      set.length,
      () => this.engine.createPermutedSetup(set),
    );
    await sendPsiSet(conn, setup);
    await conn.send(encodeIndexTable(indexTable));

    const request = await this.receiveRoundSet(conn, "request");
    const elements = this.assertInboundElementBound(
      "request",
      request,
      this.elementBounds.request,
    );
    if (elements !== declared.receiverRecords)
      throw new PartnerProtocolRefusalError(
        `${this.id} protocol error: the partner's PSI request has ${String(elements)} elements for its ${String(declared.receiverRecords)} declared records`,
      );
    const response = await this.reportProgress(
      "processClientRequest",
      elements,
      () =>
        decodePsiBinaryFrame(this.id, "request", () =>
          this.engine.processClientRequest(request, declared.receiverRecords),
        ),
    );
    await sendPsiSet(conn, response);
  }

  private async receivePermutedRound(
    conn: MessageConnection,
    set: ReadonlyArray<string>,
    declared: CountOnlyDeclaredCounts,
  ): Promise<void> {
    const setupElements = await this.receiveServerSetupInParts(conn);
    try {
      if (setupElements !== declared.senderRecords)
        throw new PartnerProtocolRefusalError(
          `${this.id} protocol error: the partner's PSI setup has ${String(setupElements)} elements for its ${String(declared.senderRecords)} declared records`,
        );
      const frame = await receivePsiBinaryFrame(conn, this.id, "index table");
      await this.engine.receiveIndexTable(
        decodeIndexTable(this.id, frame, declared.senderRecords),
      );
    } catch (error) {
      await this.engine.discardServerSetup().catch(() => undefined);
      throw error;
    }

    await this.refuseOwnSetOverDecodeCap(conn, set.length);
    const request = await this.createClientRequest(set);
    await sendPsiSet(conn, request);

    const response = await this.receiveRoundSet(conn, "response");
    const elements = this.assertResponseWithinRequest(response);
    await this.reportProgress("computeIntersectionCardinality", elements, () =>
      decodePsiBinaryFrame(this.id, "response", () =>
        this.engine.matchPermutedRound(response),
      ),
    );
    this.permutedRoundsMatched += 1;
  }

  /**
   * The count over every round {@link countPermutedRound} matched, from the
   * receiver's engine. Refused as an internal fault unless exactly `rounds`
   * rounds were matched, so an exchange ended before its last round yields no
   * count. Receiver only.
   */
  public async finishPermutedCount(rounds: number): Promise<number> {
    if (this.config.role !== "joiner")
      throw new InternalConsistencyError(
        `${this.id}: only the receiver holds a count-only count`,
      );
    if (this.permutedRoundsMatched !== rounds)
      throw new InternalConsistencyError(
        `${this.id}: the count was asked for after ${String(this.permutedRoundsMatched)} of the exchange's ${String(rounds)} count-only rounds`,
      );
    return this.engine.finishPermutedCount();
  }

  /**
   * Returns an association table with elements [localIndices, partnerIndices]
   *
   * @param grouping - The round's per-round grouping exchange, where the
   *   caller resolves a candidate set. Omitted, neither frame sends a grouping
   *   nor admits one, so both keep the shape the single-valued cascade puts on
   *   the wire and accept exactly what it accepts.
   */
  public async identifyIntersection(
    conn: MessageConnection,
    set: Array<string>,
    grouping?: RoundGroupingExchange,
  ): Promise<AssociationTable> {
    if (this.config.role === "starter") {
      await this.refuseOwnSetOverDecodeCap(conn, set.length);
      const { setup, permutation } = await this.createServerSetup(set);

      this.log.debug(
        `${this.id}: starting identify-intersection protocol; sending server ` +
          " data encrypted by server",
      );
      await sendPsiSet(conn, setup);

      this.log.debug(`${this.id}: waiting for client request`);

      const clientRequest = await this.receiveRoundSet(conn, "request");
      this.log.debug(`${this.id}: received client data encrypted by client`);

      const serverResponse = await this.processClientRequest(clientRequest);

      this.log.debug(
        `${this.id}: sending client data encrypted by both server and client`,
      );

      await sendPsiSet(conn, serverResponse);

      // The partner sends its own half first, then ours, then its grouping
      // where the caller states one of its own: a round without a grouping
      // neither sends nor accepts one. Our half may not repeat a position, so
      // the table holds at most one pair per element we encrypted.
      const partnerIndices = await receiveRoundIndexList(
        conn,
        this.id,
        ASSOCIATION_TABLE_PARTNER_HALF,
        permutation.length,
        this.elementBounds.request,
      );
      const localIndices = await receiveRoundIndexList(
        conn,
        this.id,
        ASSOCIATION_TABLE_LOCAL_HALF,
        partnerIndices.length,
        permutation.length,
      );
      const partnerGrouping = grouping
        ? await receiveRoundGrouping(
            conn,
            this.id,
            ASSOCIATION_TABLE_GROUPING,
            partnerIndices.length,
            grouping.partnerSizeBounds,
          )
        : undefined;
      this.log.debug(`${this.id}: received association table`);

      // The round's matches, as computed by the partner: our half indexes the
      // set we just encrypted (so `permutation` bounds it exactly), the partner
      // half indexes the set it encrypted (bounded by the element count its
      // masked set may declare -- authenticated session state, since it is
      // derived from the agreed key count and the exchanged record counts). Both
      // are checked before the remap below turns our half into this party's
      // matched set for the round.
      assertPartnerIndexTable(
        this.id,
        {
          what: "the round's association table, local half",
          indices: localIndices,
          exclusiveBound: permutation.length,
        },
        {
          what: "the round's association table, partner half",
          indices: partnerIndices,
          exclusiveBound: this.elementBounds.request,
        },
      );

      // Checked before it drives the sweep, and before this party's own
      // grouping goes out, so a deviating round aborts at the round rather
      // than after the last one.
      grouping?.accept(partnerGrouping, partnerIndices);

      for (let i = 0; i < localIndices.length; ++i) {
        localIndices[i] = permutation[localIndices[i]];
      }

      this.log.debug(`${this.id}: sending my original indices`);
      const localGrouping = grouping?.describe(localIndices);
      await sendRoundIndexList(conn, localIndices);
      if (grouping) await sendRoundGrouping(conn, localGrouping);

      this.log.debug(`${this.id}: waiting for status completed`);
      await receiveAfterTerms(conn, statusCompletedMessage);

      return [localIndices, partnerIndices];
    } else {
      this.log.debug(`${this.id}: starting identify-intersection protocol`);

      this.log.debug(`${this.id}: receiving server data encrypted by server`);

      // Validate and hold the server setup as it arrives -- a fail-fast before
      // we send our own request -- while the response we match it against
      // arrives a round trip later.
      await this.receiveServerSetupInParts(conn);

      await this.refuseOwnSetOverDecodeCap(conn, set.length);
      const clientRequest = await this.createClientRequest(set);

      this.log.debug(`${this.id}: sending client data encrypted by client`);

      await sendPsiSet(conn, clientRequest);

      const serverResponse = await this.receiveRoundSet(conn, "response");
      this.log.debug(
        `${this.id}: receiving server data encrypted by both by server and ` +
          "client",
      );

      // Association table: indices into client data mapped to the (likely permuted)
      // indices given by the server, matched against the setup held above.
      const associationTable =
        await this.computeAssociationTable(serverResponse);
      const localIndices = associationTable[0];

      this.log.debug(
        `${this.id}: sending association table with permuted server indices`,
      );

      const localGrouping = grouping?.describe(localIndices);
      await sendRoundIndexList(conn, associationTable[0]);
      await sendRoundIndexList(conn, associationTable[1]);
      if (grouping) await sendRoundGrouping(conn, localGrouping);

      // Send-before-refusal: a part of the partner's original-index list or
      // grouping refused on its header or body is reported only after the
      // acknowledgement, so a malformed list does not strand the partner.
      // Each entry indexes the set the partner encrypted, bounded by
      // authenticated session state.
      let partnerIndices: Array<number> = [];
      let partnerGrouping: RoundGroupingField | undefined;
      let partRefusal: ConnectionError | undefined;
      try {
        partnerIndices = await receiveRoundIndexList(
          conn,
          this.id,
          ORIGINAL_INDEX_LIST,
          localIndices.length,
          this.elementBounds.setup,
        );
        if (grouping)
          partnerGrouping = await receiveRoundGrouping(
            conn,
            this.id,
            ORIGINAL_INDEX_LIST_GROUPING,
            partnerIndices.length,
            grouping.partnerSizeBounds,
          );
      } catch (error) {
        if (!(error instanceof ConnectionError) || error.kind !== "protocol")
          throw error;
        partRefusal = error;
      }
      this.log.debug(`${this.id}: received original server indices`);

      this.log.debug(`${this.id}: sending status completed`);
      await conn.send({ status: "completed" });
      if (partRefusal !== undefined) throw partRefusal;

      assertPartnerIndexCount(
        this.id,
        "the partner's original-index list",
        partnerIndices.length,
        localIndices.length,
      );
      assertPartnerIndices(
        this.id,
        "the partner's original-index list",
        partnerIndices,
        this.elementBounds.setup,
      );
      grouping?.accept(partnerGrouping, partnerIndices);

      return [localIndices, partnerIndices];
    }
  }
}
