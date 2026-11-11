import { MAX_PSI_DECODE_ELEMENTS } from "../connection/frameSize.js";
import { RoundSetLimitError, UsageError } from "../errors.js";
import { setOverLimitError, type RoundSetScope } from "../failureCause.js";
import {
  candidateSetIsImplementedForStrategy,
  runsSinglePassLink,
} from "../linkageTermsPolicy.js";
import {
  PSI_SET_REFUSED_ABORT_REASON,
  PSI_SET_TOO_LARGE_ABORT_REASON,
} from "../partnerAbortFrame.js";
import { sendAbort } from "../protocolSetup.js";
import {
  candidatesWithinWidth,
  countOnlyWidthsOfRounds,
  type CountOnlyRoundWidths,
} from "../psi/countOnlyRounds.js";
import { RoundSetCounter, requireSingleCandidate } from "../psi/link.js";
import {
  declaredKeyWidth,
  localFanOutFactor,
  roundKeyIterable,
  termsDeclareCandidateSet,
} from "../standardization.js";
import { linkageRounds } from "../linkageKeyCondition.js";
import { yieldToEventLoop } from "../utils/eventLoop.js";

import type { LinkageRound } from "../linkageKeyCondition.js";
import type { MessageConnection } from "../connection/messageConnection.js";
import type { PreparedExchange } from "../exchange.js";
import type { PsiProgressReporter } from "../psi/participant.js";

// The first-round capacity checks: the count of the values this party's first
// round sends, held to one PSI set's maximum before contact and to the
// partner's stated receive ceiling after the terms exchange. In a
// count-only exchange every round's set is this party's declared record
// count times its width for the round, so the checks hold every round to
// that figure.

/**
 * Refuse an exchange whose first round holds more values than one PSI set can
 * hold, before anything is sent: a {@link RoundSetLimitError} tagged with the
 * `set-over-limit` cause, naming the count and the bound. Call it at the start of an exchange on any
 * channel, once {@link prepareForExchange} has returned and before the
 * connection opens.
 *
 * It counts the values the first cascade round sends under this
 * party's own within-round rule ({@link RoundSetCounter}): every distinct
 * value when its terms set `deduplicate` on a cascade, else only the values
 * exactly one record holds. A first key with a missing-field condition runs
 * as two rounds (`linkageRounds`), and both are counted. The count is taken in
 * both PSI roles, since which one this party plays is not yet known. It
 * refuses where, in both roles, a round of the first key counts over the
 * protocol's per-set maximum (`MAX_PSI_DECODE_ELEMENTS`), and on any failure
 * to count, with the failure as the refusal's cause. A
 * {@link UsageError} the round would raise in one role is left to the round
 * when the other role fits; raised in both, it is thrown as it is. The
 * partner's stated receive ceiling is checked once the terms are exchanged,
 * in the role this party resolves to, and every later round's set when it is
 * built (docs/spec/PROTOCOL.md, "The receive ceiling"). Where the round reads
 * one candidate per record, a record holding a candidate set raises the
 * round's own fan-out refusal rather than this one. A `psi` single-pass
 * exchange is not checked here: the limits it meets at the terms exchange and
 * before masking hold every set it sends
 * (docs/spec/PROTOCOL.md, "The single-pass dataset ceiling").
 *
 * Every round of a count-only (`psi-c`) exchange sends one block of this
 * party's width for the round for each of its declared records
 * (docs/spec/PSI_C.md, PSI-C), so that figure is checked for every round
 * without reading the input, refused where the widest round is over the
 * maximum in both roles. Where its terms declare a candidate set, every
 * round is then read in both roles, so a refusal over this party's own rows
 * is raised here, before contact.
 *
 * The count reports its progress through `options.onProgress`
 * ({@link FirstRoundCheckOptions}) and yields to the event loop as it goes,
 * so a display stays live through it.
 */
export async function assertFirstRoundWithinSetMaximum(
  prepared: PreparedExchange,
  options: FirstRoundCheckOptions = {},
): Promise<void> {
  const maxValues = options.maxValues ?? MAX_PSI_DECODE_ELEMENTS;
  await assertFirstRoundFits(prepared, options, [false, true], {
    exceeds: (elementCount) => elementCount > maxValues,
    tooLarge: (valueCount, scope) =>
      setOverLimitError({
        kind: "set-over-limit",
        stage: "before-contact",
        limit: "set-maximum",
        valueCount,
        limitValues: maxValues,
        scope,
      }),
    uncounted: (failure) =>
      setOverLimitError(
        { kind: "set-over-limit", stage: "before-contact", limit: "uncounted" },
        { cause: failure },
      ),
  });
  await readEveryCountOnlyRound(prepared, options);
}

/**
 * What {@link assertFirstRoundWithinSetMaximum} takes beyond the prepared
 * exchange.
 */
export interface FirstRoundCheckOptions {
  /**
   * Takes `countFirstRoundValues` reports (`PsiProgress`) as the count
   * starts, as it goes, and as it settles, once for each round and role it
   * counts in, and for each round and role of a count-only exchange whose
   * terms declare a candidate set, every one of which is read.
   * An input whose records cannot reach the bound is not counted, so it
   * reports nothing unless it is read as a count-only candidate set. Called
   * as a {@link PsiProgressReporter} is: a raise on a `progress` report is
   * dropped, and any other reaches the caller. The settle report's
   * `elements` is the number of rows the count walked, not the dataset's row
   * count, so it is short of the started report's
   * `elements` when a deduplicating party's growing count stopped early.
   */
  onProgress?: PsiProgressReporter;
  /** The most values one PSI set holds; lowered only by tests. */
  maxValues?: number;
  /** The least time between two progress reports; lowered only by tests. */
  progressIntervalMs?: number;
  /**
   * Stops the count at its next yield to the event loop: the check rejects
   * with `signal.reason` and reports nothing further, not even a settle.
   */
  signal?: AbortSignal;
}

// Hold this party's first round, and in a count-only exchange every round, to
// the lesser of the partner's stated receive ceiling and one PSI set's
// maximum, after the terms exchange and before this party builds a set:
// counted as the start-of-exchange check counts, in the role this party
// resolved to. Every refusal sends the partner an abort before it propagates,
// its reason stating only that the set was too large or that it was refused.
export async function assertFirstRoundWithinPartnerCeiling(
  conn: MessageConnection,
  input: Pick<PreparedExchange, "linkageTerms" | "dataset" | "rowCount">,
  isReceiver: boolean,
  partnerReceiveCeiling: number,
  onProgress: PsiProgressReporter | undefined,
): Promise<void> {
  const options: FirstRoundCheckOptions = { onProgress };
  const ceiling = Math.min(partnerReceiveCeiling, MAX_PSI_DECODE_ELEMENTS);
  try {
    await assertFirstRoundFits(input, options, [isReceiver], {
      exceeds: (elementCount) => elementCount > ceiling,
      tooLarge: (valueCount, scope) =>
        setOverLimitError({
          kind: "set-over-limit",
          stage: "after-terms",
          ...(valueCount > MAX_PSI_DECODE_ELEMENTS
            ? ({
                limit: "set-maximum",
                limitValues: MAX_PSI_DECODE_ELEMENTS,
              } as const)
            : ({ limit: "partner-ceiling", limitValues: ceiling } as const)),
          valueCount,
          scope,
        }),
      uncounted: (failure) =>
        setOverLimitError(
          { kind: "set-over-limit", stage: "after-terms", limit: "uncounted" },
          { cause: failure },
        ),
    });
  } catch (err) {
    await sendAbort(conn, [
      err instanceof RoundSetLimitError && err.reason !== "uncounted"
        ? PSI_SET_TOO_LARGE_ABORT_REASON
        : PSI_SET_REFUSED_ABORT_REASON,
    ]);
    throw err;
  }
}

// How often the count reads the clock, in records, and the least time between
// two of its progress reports, each of which yields to the event loop so a
// display on the same thread can draw it.
const FIRST_ROUND_COUNT_CLOCK_RECORDS = 1024;
const FIRST_ROUND_COUNT_PROGRESS_MS = 250;

// A count-only exchange's rounds, each `declaredRecords` times this party's
// width for the round, held to the bound in each of `roles`: refused where,
// in every role counted, the widest round is over it, naming the size of the
// role that sends the most so the refusal never understates the run.
function assertCountOnlyRoundsFit(
  declaredRecords: number,
  widths: ReadonlyArray<CountOnlyRoundWidths>,
  roles: ReadonlyArray<boolean>,
  bound: {
    exceeds: (elementCount: number) => boolean;
    tooLarge: (elementCount: number, scope: RoundSetScope) => Error;
  },
): void {
  let most = 0;
  let scope: RoundSetScope = "every-key";
  for (const isReceiver of roles) {
    const roleWidths = widths.map((width) =>
      isReceiver ? width.receiverWidth : width.senderWidth,
    );
    const widest = Math.max(1, ...roleWidths);
    const size = declaredRecords * widest;
    if (!bound.exceeds(size)) return;
    if (size <= most) continue;
    most = size;
    scope = roleWidths.every((width) => width === widest)
      ? "every-key"
      : "widest-key";
  }
  throw bound.tooLarge(most, scope);
}

/**
 * Under count-only terms declaring a candidate set, read every round of every
 * key in both PSI roles before the connection opens, so a refusal building a
 * round's candidates -- a fuzzy exceedance, a record wider than its block --
 * is raised in front of this party's operator rather than ending a run its
 * partner has joined (docs/spec/PSI_C.md, Candidate sets under count-only).
 * Each round and role read reports as the first-round count does
 * (`countFirstRoundValues`, {@link FirstRoundCheckOptions}).
 */
async function readEveryCountOnlyRound(
  prepared: Pick<PreparedExchange, "linkageTerms" | "dataset" | "rowCount">,
  options: FirstRoundCheckOptions,
): Promise<void> {
  const { linkageTerms, dataset, rowCount } = prepared;
  if (
    linkageTerms.algorithm !== "psi-c" ||
    !termsDeclareCandidateSet(linkageTerms)
  )
    return;
  const report = options.onProgress;
  const progressIntervalMs =
    options.progressIntervalMs ?? FIRST_ROUND_COUNT_PROGRESS_MS;
  const rounds = linkageRounds(linkageTerms.linkageKeys);
  const widths = countOnlyWidthsOfRounds(linkageTerms);
  for (const isReceiver of [true, false])
    for (const [index, round] of rounds.entries()) {
      const width = isReceiver
        ? widths[index]!.receiverWidth
        : widths[index]!.senderWidth;
      report?.({
        operation: "countFirstRoundValues",
        elements: rowCount,
        state: "started",
      });
      const startedAt = performance.now();
      let row = 0;
      const settled = (state: "finished" | "failed"): void =>
        report?.({
          operation: "countFirstRoundValues",
          elements: row,
          state,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        });
      try {
        let lastReportAt = performance.now();
        const records = roundKeyIterable(
          round,
          dataset,
          rowCount,
          isReceiver,
          false,
        );
        for (const candidates of records) {
          candidatesWithinWidth(candidates, width);
          if (++row % FIRST_ROUND_COUNT_CLOCK_RECORDS !== 0) continue;
          if (performance.now() - lastReportAt >= progressIntervalMs) {
            try {
              report?.({
                operation: "countFirstRoundValues",
                elements: rowCount,
                state: "progress",
                processed: row,
              });
            } catch {
              // Dropped; the read continues and its settle report follows.
            }
            lastReportAt = performance.now();
          }
          await yieldToEventLoop();
          options.signal?.throwIfAborted();
        }
      } catch (failure) {
        if (!(options.signal?.aborted && failure === options.signal.reason))
          settled("failed");
        throw failure;
      }
      settled("finished");
    }
}

// The first-round count both checks above share, in each of `roles` (whether
// this party counts as the PSI receiver) until one fits every round of the
// first key. `exceeds` is the check's bound on a set of that many values,
// `tooLarge` its refusal on the values a round over the bound sends (in a
// count-only exchange the most of any role counted, else the fewest) and the
// rounds that figure covers, `uncounted` its refusal when the count fails
// other than with a refusal the round would raise.
async function assertFirstRoundFits(
  prepared: Pick<PreparedExchange, "linkageTerms" | "dataset" | "rowCount">,
  options: FirstRoundCheckOptions,
  roles: ReadonlyArray<boolean>,
  bound: {
    exceeds: (elementCount: number) => boolean;
    tooLarge: (elementCount: number, scope: RoundSetScope) => Error;
    uncounted: (failure: unknown) => Error;
  },
): Promise<void> {
  const { linkageTerms, dataset, rowCount } = prepared;
  if (linkageTerms.algorithm === "psi-c") {
    assertCountOnlyRoundsFit(
      rowCount * localFanOutFactor(dataset.declaresFanOut),
      countOnlyWidthsOfRounds(linkageTerms),
      roles,
      bound,
    );
    return;
  }
  if (runsSinglePassLink(linkageTerms)) return;
  const rounds = linkageRounds(linkageTerms.linkageKeys);
  const firstRound = rounds.at(0);
  if (firstRound === undefined) return;
  // A key with a missing-field condition runs as two rounds, and in either
  // role this party builds it for every record in one of them, so a role fits
  // only where every round of the first key does.
  const firstKeyRounds = rounds.filter(
    (round) => round.keyIndex === firstRound.keyIndex,
  );
  const { key } = firstRound;
  // Every row contributes at most the key's declared width of candidates, so
  // a dataset whose rows cannot reach the count is not read at all.
  const candidateCeiling =
    rowCount *
    declaredKeyWidth(key, 0) *
    localFanOutFactor(dataset.declaresFanOut);
  if (!bound.exceeds(candidateCeiling)) return;
  // The round's single-candidate rule, applied here so a candidate set the
  // round would refuse raises the round's refusal, which names the cause,
  // rather than this check's.
  const readsSingleCandidate = !candidateSetIsImplementedForStrategy(
    linkageTerms.linkageStrategy,
  );
  // This party's own term decides whether it keeps a value several of its
  // records hold.
  const keepsDuplicates = linkageTerms.deduplicate;
  const report = options.onProgress;
  const progressIntervalMs =
    options.progressIntervalMs ?? FIRST_ROUND_COUNT_PROGRESS_MS;
  const settled = (
    state: "finished" | "failed",
    startedAt: number,
    walked: number,
  ): void =>
    report?.({
      operation: "countFirstRoundValues",
      elements: walked,
      state,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    });
  // A refusal the round would raise is a refusal in that role, left to the
  // round when the other role fits, since this party may not play it. Any
  // other failure to count, a resource limit among them, refuses at once.
  // Where the size only grows, the count stops once it is over the bound, and
  // the refusal names that size as the least the round sends.
  const roundSetSize = async (
    round: LinkageRound,
    isReceiver: boolean,
  ): Promise<number | UsageError> => {
    report?.({
      operation: "countFirstRoundValues",
      elements: rowCount,
      state: "started",
    });
    const startedAt = performance.now();
    let size: number;
    let row = 0;
    try {
      await yieldToEventLoop();
      options.signal?.throwIfAborted();
      let lastReportAt = performance.now();
      const counter = new RoundSetCounter(keepsDuplicates);
      const records = roundKeyIterable(
        round,
        dataset,
        rowCount,
        isReceiver,
        false,
      );
      for (const candidates of records) {
        counter.add(
          row,
          readsSingleCandidate
            ? requireSingleCandidate(candidates)
            : candidates,
        );
        ++row;
        if (row % FIRST_ROUND_COUNT_CLOCK_RECORDS !== 0) continue;
        if (counter.sizeOnlyGrows && bound.exceeds(counter.size)) break;
        if (performance.now() - lastReportAt < progressIntervalMs) continue;
        try {
          report?.({
            operation: "countFirstRoundValues",
            elements: rowCount,
            state: "progress",
            processed: row,
          });
        } catch {
          // Dropped; the count continues and its settle report follows.
        }
        await yieldToEventLoop();
        options.signal?.throwIfAborted();
        lastReportAt = performance.now();
      }
      size = counter.size;
    } catch (failure) {
      if (options.signal?.aborted && failure === options.signal.reason)
        throw failure;
      settled("failed", startedAt, row);
      if (failure instanceof UsageError) return failure;
      throw bound.uncounted(failure);
    }
    settled("finished", startedAt, row);
    return size;
  };
  const counted: Array<number> = [];
  const refusals: Array<UsageError> = [];
  for (const isReceiver of roles) {
    let refused: number | UsageError | undefined;
    for (const round of firstKeyRounds) {
      const size = await roundSetSize(round, isReceiver);
      if (typeof size === "number" && !bound.exceeds(size)) continue;
      refused = size;
      break;
    }
    if (refused === undefined) return;
    if (typeof refused === "number") counted.push(refused);
    else refusals.push(refused);
  }
  if (refusals.length > 0) throw refusals[0];
  throw bound.tooLarge(Math.min(...counted), "first-key");
}
