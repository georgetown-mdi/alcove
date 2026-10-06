import fs from "node:fs";

import {
  classifyFailure,
  isTrustBoundaryFailure,
  OperatorConfigError,
  UsageError,
  DEFAULT_MAX_DISPLAY_LENGTH,
  FAILURE_CAUSE_PATH_MAX_LENGTH,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
  failureCauseOf,
  getLogger,
  redactAndSanitizeForDisplay,
  redactAndFitUnescaped,
  statesItsOwnNextStep,
} from "@alcove/core";
import type {
  Displayable,
  EntityClusterSummary,
  ExchangeStageDefinition,
  PayloadColumnsChange,
  ResolvedMatching,
} from "@alcove/core";

import {
  EVENT_RESULT_CLUSTER_SHAPES_MAX,
  EVENT_STREAM_FD,
  EVENT_STREAM_VERSION,
  INTERNAL_FAULT_EXIT_CODE,
  PERSISTENCE_LOSS_EXIT_CODE,
  failureCauseStreamField,
  toStreamCount,
} from "@alcove/cli-contract";
import type {
  ErrorEvent,
  ErrorEventColumnsChange,
  ErrorPhase,
  ExchangeErrorCategory,
  MetricsEvent,
  ResultEvent,
  StageEndEvent,
  StageEvent,
  StagesEvent,
  StreamEvent,
  WarningEvent,
  WarningSource,
} from "@alcove/cli-contract";

import {
  exitCodeForError,
  fixedNextStep,
  installTerminalFailureReporter,
  renderFailureForOperator,
} from "./util/exit";
import { failureRemedy } from "./failureRemedy";
import { asciiSafeJsonText } from "./util/jsonLine";
import { takeLogFileLossReport } from "./util/logging";
import { termsChangeNotTakenOf } from "./termsChangeNotTaken";

const log = getLogger("event-stream");

/** Where a written result table went, for the `result` event. */
export interface ResultTableDelivery {
  /** The number of matched rows in the table. */
  matchedRows: number;
  /** The result file's absolute path; absent when it went to stdout. */
  resultPath?: string;
}

// --- Pure event construction (no file descriptor) ----------------------------

/**
 * Classify a terminal failure into one of the four {@link ExchangeErrorCategory}
 * values, the web front end's vocabulary (`apps/web/src/psi/exchangeLifecycle.ts`):
 *
 * - `output` phase -> `output`.
 * - an {@link OperatorConfigError} in any earlier phase -> `config`. That exact
 *   base type only, not any {@link UsageError}: a sibling UsageError can be
 *   partner-influenced.
 * - a trust-boundary failure ({@link isTrustBoundaryFailure} of
 *   {@link classifyFailure}, which reads past `transport`-kind wraps as the
 *   exit code does; any phase) -> `security`.
 * - everything else -> `exchange`.
 *
 * Unlike the web's `classifyExchangeFailure`, `config` here is not scoped to
 * the `prepare` phase: it has to agree with the exit code instead, and every
 * `OperatorConfigError` exits 64 (non-retryable) regardless of phase. Full
 * rationale: docs/spec/CLI_EVENTS.md (Error categories).
 */
export function classifyTerminalError(
  error: unknown,
  phase: ErrorPhase,
): ExchangeErrorCategory {
  if (phase === "output") return "output";
  if (error instanceof OperatorConfigError) return "config";
  return isTrustBoundaryFailure(classifyFailure(error))
    ? "security"
    : "exchange";
}

/** Build the one-shot stage-list event from core's stage definitions. */
export function buildStagesEvent(
  stages: ExchangeStageDefinition[],
): StagesEvent {
  return {
    v: EVENT_STREAM_VERSION,
    type: "stages",
    // A stage label derives from linkage-key names the PARTNER may have authored,
    // so redact and escape it exactly as protocol.ts does before a label reaches
    // stderr; leaving fd 3 on the escape alone would make the persisted route the
    // weaker of the two. The id is this party's own constant vocabulary from
    // describeExchangeStages, but it is echoed on the wire in the same format, so
    // it takes the same pass uniformly.
    stages: stages.map(({ id, label }) => ({
      id: redactAndSanitizeForDisplay(id),
      label: redactAndSanitizeForDisplay(label),
    })),
  };
}

/** Build a stage-transition event from an id and its resolved display label. */
export function buildStageEvent(id: string, label: string): StageEvent {
  return {
    v: EVENT_STREAM_VERSION,
    type: "stage",
    id: redactAndSanitizeForDisplay(id),
    label: redactAndSanitizeForDisplay(label),
  };
}

/** Build a stage-completion event from a stage id and its measured duration. */
export function buildStageEndEvent(
  id: string,
  durationMs: number,
): StageEndEvent {
  return {
    v: EVENT_STREAM_VERSION,
    type: "stageEnd",
    // The id echoes a partner-authorable stage identifier, taking the same pass
    // as the stage event's id.
    id: redactAndSanitizeForDisplay(id),
    durationMs: toStreamCount(durationMs),
  };
}

/**
 * Build a warning event from the notice that raised it and its message.
 * `source` is required rather than defaulted so a new warning site cannot
 * compile until it chooses a {@link WARNING_SOURCES} value.
 */
export function buildWarningEvent(
  source: WarningSource,
  message: string,
): WarningEvent {
  return {
    v: EVENT_STREAM_VERSION,
    type: "warning",
    // This party's own closed vocabulary, like `type` and the error `category`,
    // so it takes no escape.
    source,
    // Terms-exchange warnings can embed partner-authored column names, so
    // redact and sanitize before the text reaches the stream, at the shared
    // warning-composition budget (WARNING_MESSAGE_MAX_DISPLAY_LENGTH) rather
    // than the per-value default. Full rationale: docs/spec/CLI_EVENTS.md
    // (the `warning` message field).
    message: redactAndSanitizeForDisplay(message, {
      maxLength: WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
    }),
    unescapedMessage: redactAndFitUnescaped(
      message,
      WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
    ),
  };
}

/**
 * Build the warning an unattended run raises when it takes the payload columns
 * its partner declares without asking. `message` is the notice, already
 * escaped name by name, so it takes no second pass here. `shownColumns` are
 * the names that notice holds, each left unescaped for the consumer's own
 * display escape; `columnCount` is how many were taken.
 */
export function buildPayloadReceiveTakenEvent(
  message: Displayable,
  shownColumns: readonly string[],
  columnCount: number,
): WarningEvent {
  return {
    v: EVENT_STREAM_VERSION,
    type: "warning",
    source: "payloadReceiveTaken",
    message,
    columns: shownColumns.map((name) =>
      redactAndFitUnescaped(name, DEFAULT_MAX_DISPLAY_LENGTH),
    ),
    columnCount: toStreamCount(columnCount),
  };
}

/** Build the per-run operational-counter summary event. */
export function buildMetricsEvent(
  recordsProcessed: number,
  transportRetries: number,
  reconnects: number,
): MetricsEvent {
  return {
    v: EVENT_STREAM_VERSION,
    type: "metrics",
    recordsProcessed: toStreamCount(recordsProcessed),
    transportRetries: toStreamCount(transportRetries),
    reconnects: toStreamCount(reconnects),
  };
}

/**
 * Build the success terminal event. `count` is passed only for a count-only run
 * this party's terms entitle it to read, and its fields are omitted entirely
 * otherwise: the presence of `intersectionCount` is what a consumer keys the
 * count-only outcome off, so a zero count and an absent one must stay
 * distinguishable. The tally and its provenance travel as one argument so the
 * stream cannot hold a count without saying whose reading it is.
 *
 * `matching` is required rather than optional so no caller can emit a success
 * terminal without it: it is the only channel a consumer that reads fd 3 alone
 * has for what the agreed `deduplicate` pair resolved to.
 *
 * `entityClusters` is passed only for a run core composed a cluster summary
 * for, and is omitted entirely otherwise and where the summary holds more
 * shapes than {@link EVENT_RESULT_CLUSTER_SHAPES_MAX}.
 *
 * `table` is passed exactly when a result table was written, and is what
 * `resultWritten` is read off: the matched row count, and the result file's
 * absolute path unless it went to stdout.
 */
export function buildResultEvent(
  matching: ResolvedMatching,
  count?: { intersectionCount: number; reportedByPartner: boolean },
  entityClusters?: EntityClusterSummary,
  table?: ResultTableDelivery,
): ResultEvent {
  return {
    v: EVENT_STREAM_VERSION,
    type: "result",
    resultWritten: table !== undefined,
    ...(table !== undefined
      ? {
          matchedRows: toStreamCount(table.matchedRows),
          ...(table.resultPath !== undefined
            ? {
                resultPath: redactAndSanitizeForDisplay(table.resultPath, {
                  maxLength: FAILURE_CAUSE_PATH_MAX_LENGTH,
                }),
              }
            : {}),
        }
      : {}),
    // Copied field by field, so a caller's object holding anything beyond the
    // three cannot widen the emitted line past this stream's closed contract.
    matching: {
      localDeduplicate: matching.localDeduplicate,
      partnerDeduplicate: matching.partnerDeduplicate,
      cardinality: matching.cardinality,
    },
    // The one numeric field of this stream that a partner can influence (the
    // count-report leg sends the receiver's tally to the sender), so it takes
    // the same non-negative whole-number floor the metrics counters take. Core
    // bounds the reported figure to the smaller of the two exchanged record
    // counts before it gets here.
    ...(count !== undefined
      ? {
          intersectionCount: toStreamCount(count.intersectionCount),
          countReportedByPartner: count.reportedByPartner,
        }
      : {}),
    ...(entityClusters !== undefined &&
    entityClusters.shapes.length <= EVENT_RESULT_CLUSTER_SHAPES_MAX
      ? { entityClusters: copyClusterSummary(entityClusters) }
      : {}),
  };
}

/**
 * Copy a cluster summary field by field, each figure through the same
 * non-negative whole-number floor the metrics counters take. The copy is what
 * keeps a caller's object from widening the emitted line past this stream's
 * closed contract; the floor is a robustness floor, not a sanitizer, since
 * every figure is one of this party's own counts.
 */
function copyClusterSummary(
  summary: EntityClusterSummary,
): EntityClusterSummary {
  return {
    clusterCount: toStreamCount(summary.clusterCount),
    localRows: toStreamCount(summary.localRows),
    partnerRows: toStreamCount(summary.partnerRows),
    shapes: summary.shapes.map((shape) => ({
      localRows: toStreamCount(shape.localRows),
      partnerRows: toStreamCount(shape.partnerRows),
      distinctValues: toStreamCount(shape.distinctValues),
      clusters: toStreamCount(shape.clusters),
    })),
  };
}

/**
 * Whether a failure states its own next step anywhere in its cause chain
 * (core's `statesItsOwnNextStep`). The chain is walked for the reason the
 * stderr path walks it (`apps/cli/src/protocol.ts`): a wrap of such a failure
 * still states the next step it promises.
 *
 * @internal exported for testing
 */
export function errorStatesItsOwnNextStep(error: unknown): boolean {
  return statesItsOwnNextStep(error);
}

/**
 * Build the classified failure terminal event for a process that exits
 * `exitCode`, by default the code {@link exitCodeForError} classifies
 * `error` to -- the classification every command boundary whose errors vary
 * exits with.
 */
export function buildErrorEvent(
  error: unknown,
  phase: ErrorPhase,
  exitCode: number = exitCodeForError(error),
): ErrorEvent {
  return {
    v: EVENT_STREAM_VERSION,
    type: "error",
    category: classifyTerminalError(error, phase),
    // Error text can hold partner- or server-controlled bytes in its message or
    // cause chain, so route it through the display-boundary sanitizer that
    // stderr uses; the category and version fields are this party's own vocabulary.
    message: renderFailureForOperator(error),
    ...(errorStatesItsOwnNextStep(error) ||
    fixedNextStep(error) !== undefined ||
    failureRemedy(error) !== undefined
      ? { recoveryHint: true as const }
      : {}),
    ...(exitCode === INTERNAL_FAULT_EXIT_CODE
      ? { internalFault: true as const }
      : {}),
    exitCode,
    ...termsChangeFieldOf(error),
    ...causeFieldOf(error),
  };
}

/** The {@link ErrorEvent.cause} field for `error`, as the fields to spread. */
function causeFieldOf(error: unknown): Pick<ErrorEvent, "cause"> {
  const cause = failureCauseOf(error);
  if (cause === undefined) return {};
  const field = failureCauseStreamField(cause);
  return field === undefined ? {} : { cause: field };
}

/**
 * The {@link ErrorEvent.termsChange} field for `error`, as the fields to
 * spread. Copied field by field, so nothing beyond the delta widens the line,
 * and every partner-chosen string is escaped as stderr's display of the same
 * change escapes it (`displayTermsChange`).
 */
function termsChangeFieldOf(error: unknown): Pick<ErrorEvent, "termsChange"> {
  const notTaken = termsChangeNotTakenOf(error);
  if (notTaken === undefined) return {};
  const { delta } = notTaken;
  const columns = (
    change: PayloadColumnsChange | undefined,
  ): ErrorEventColumnsChange | undefined =>
    change === undefined
      ? undefined
      : {
          added: change.added.map((name) => redactAndSanitizeForDisplay(name)),
          removed: change.removed.map((name) =>
            redactAndSanitizeForDisplay(name),
          ),
        };
  const received = columns(delta.received);
  const sent = columns(delta.sent);
  return {
    termsChange: {
      proposalWritten: notTaken.proposalWritten,
      ...(received !== undefined ? { received } : {}),
      ...(sent !== undefined ? { sent } : {}),
      ...(delta.partnerDeduplicate !== undefined
        ? {
            partnerDeduplicate: {
              expected: delta.partnerDeduplicate.expected,
              presented: delta.partnerDeduplicate.presented,
            },
          }
        : {}),
      otherTerms: delta.otherTerms.map((difference) =>
        redactAndSanitizeForDisplay(difference, {
          maxLength: WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
        }),
      ),
    },
  };
}

// --- Fail-closed fd-3 preflight ----------------------------------------------

/**
 * Assert that {@link EVENT_STREAM_FD} is open for writing, throwing a
 * {@link UsageError} (CLI exit 64) if it is not. Called at startup, before any
 * exchange work, when `--event-stream` is given: if the operator asked for the
 * stream but spawned the process without wiring fd 3, fail loud and early rather
 * than silently dropping every event or crashing mid-run on the first write.
 * Both an `fstat` and a zero-length write, which writes nothing, must succeed.
 * `fstat` alone passes a descriptor open only for reading, and one the
 * supervisor left closed, which the Node runtime's own event loop then holds
 * (measured on macOS and Linux). The write's error code differs across those
 * cases and platforms, so any failure is refused and none is named.
 */
export function assertEventStreamFdOpen(): void {
  try {
    fs.fstatSync(EVENT_STREAM_FD);
    fs.writeSync(EVENT_STREAM_FD, Buffer.alloc(0), 0, 0);
  } catch {
    throw new UsageError(
      `--event-stream was given but file descriptor ${EVENT_STREAM_FD} is ` +
        "not open for writing; from a shell, add 3>events.ndjson to the " +
        "command line to write the events to that file, or spawn Alcove with " +
        "that descriptor wired to the write end of a pipe your supervisor " +
        "reads; otherwise drop --event-stream. " +
        "Format: https://github.com/georgetown-mdi/alcove/blob/main/docs/" +
        "spec/CLI_EVENTS.md",
    );
  }
}

// --- fd-3 writer -------------------------------------------------------------

/**
 * Serialize and flush events to {@link EVENT_STREAM_FD} as NDJSON: one JSON
 * object per line, each write a single synchronous `writeSync` so a supervisor
 * reading incrementally never observes a partial line, and no line interleaves
 * with another. A `writeSync` to a pipe can return a short count under back
 * pressure, so the whole buffer is drained in a loop rather than trusting one
 * call. A write failure is swallowed after the connection has been marked broken:
 * a supervisor that closed its read end must not crash the exchange, and the
 * absence of further events plus the exit code is a defined supervisor signal
 * (see docs/spec/CLI_EVENTS.md).
 *
 * The terminal event ends the stream. A consumer may stop reading at it, so an
 * event raised afterwards -- by the transport teardown that follows it, or by
 * anything added beside that -- is refused here rather than written where
 * nobody is bound to look. What the refused event had to say reaches the
 * operator through the log call beside its own site; the debug line here names
 * only which type was dropped.
 */
class EventStreamWriter {
  private broken = false;
  private terminated = false;

  /** Whether this run's terminal event has been raised. */
  get terminalEventRaised(): boolean {
    return this.terminated;
  }

  /** Serialize `event` to one NDJSON line and flush it to fd 3. */
  emit(event: StreamEvent): void {
    if (this.broken) return;
    if (this.terminated) {
      log.debug(
        `a ${event.type} event was raised after this run's terminal event ` +
          "and was not written to the machine-interface stream",
      );
      return;
    }
    if (event.type === "result" || event.type === "error")
      this.terminated = true;
    // Two fields hold text no escape has touched (a warning's
    // `unescapedMessage`, a fill warning's `columns`), so the line is encoded
    // to printable ASCII rather than left to `JSON.stringify` alone.
    const line = asciiSafeJsonText(JSON.stringify(event)) + "\n";
    const buf = Buffer.from(line, "utf8");
    let offset = 0;
    try {
      while (offset < buf.length)
        offset += fs.writeSync(
          EVENT_STREAM_FD,
          buf,
          offset,
          buf.length - offset,
        );
    } catch {
      // The supervisor's read end is gone (EPIPE) or the descriptor is otherwise
      // wedged. Mark the stream broken so no later event retries the write, and
      // do not throw back into the exchange -- the human log on stderr and the
      // exit code remain the authoritative outcome.
      this.broken = true;
    }
  }
}

/**
 * The emitter runProtocol drives: a pure event-construction layer plus the
 * fd-3 writer. Constructed only when `--event-stream` is active (after the
 * fail-closed preflight), so when the flag is absent no writer exists and
 * nothing is ever written to fd 3.
 */
export interface EventStreamEmitter {
  stages(stages: ExchangeStageDefinition[]): void;
  stage(id: string, label: string): void;
  stageEnd(id: string, durationMs: number): void;
  warning(source: WarningSource, message: string): void;
  payloadReceiveTaken(
    message: Displayable,
    shownColumns: readonly string[],
    columnCount: number,
  ): void;
  logFileLoss(message: string, lostLines: number): void;
  metrics(
    recordsProcessed: number,
    transportRetries: number,
    reconnects: number,
  ): void;
  result(
    matching: ResolvedMatching,
    count?: { intersectionCount: number; reportedByPartner: boolean },
    entityClusters?: EntityClusterSummary,
    table?: ResultTableDelivery,
  ): void;
  error(error: unknown, phase: ErrorPhase): void;
}

/**
 * Build an {@link EventStreamEmitter} backed by an {@link EventStreamWriter}.
 * Each method constructs its event through the pure builder above and flushes
 * it, so the construction logic stays testable without a live descriptor.
 *
 * Module-private, with {@link openEventStream} its only caller: see the fusion
 * property recorded there.
 */
function createEventStreamEmitter(
  writer: EventStreamWriter,
): EventStreamEmitter {
  return {
    stages: (stages) => writer.emit(buildStagesEvent(stages)),
    stage: (id, label) => writer.emit(buildStageEvent(id, label)),
    stageEnd: (id, durationMs) =>
      writer.emit(buildStageEndEvent(id, durationMs)),
    warning: (source, message) =>
      writer.emit(buildWarningEvent(source, message)),
    payloadReceiveTaken: (message, shownColumns, columnCount) =>
      writer.emit(
        buildPayloadReceiveTakenEvent(message, shownColumns, columnCount),
      ),
    logFileLoss: (message, lostLines) =>
      writer.emit({ ...buildWarningEvent("logFileLoss", message), lostLines }),
    metrics: (recordsProcessed, transportRetries, reconnects) =>
      writer.emit(
        buildMetricsEvent(recordsProcessed, transportRetries, reconnects),
      ),
    result: (matching, count, entityClusters, table) =>
      writer.emit(buildResultEvent(matching, count, entityClusters, table)),
    error: (error, phase) => writer.emit(buildErrorEvent(error, phase)),
  };
}

/**
 * Open the run's machine-interface stream: run the fail-closed fd-3 preflight
 * and build the emitter when `--event-stream` is active, or return `undefined`
 * when it is not -- in which case no writer exists and nothing is ever written
 * to fd 3.
 *
 * Fused here because two callers open the stream: `runProtocol`, and the
 * online bootstrap, which reports persistence losses of its own (see
 * {@link reportPersistenceLoss}). The writer and the emitter factory are
 * module-private, so no route to a writer exists that can skip the preflight.
 *
 * An opened stream is also what the exit boundary reports to
 * (`installTerminalFailureReporter`, `./util/exit`): a failure that reaches
 * the boundary before this run's terminal event becomes that event, with the
 * code the process exits with, after any `--log-file` loss report. One the
 * lifecycle already reported is not reported again.
 */
export function openEventStream(
  enabled: boolean | undefined,
): EventStreamEmitter | undefined {
  if (enabled !== true) return undefined;
  assertEventStreamFdOpen();
  const writer = new EventStreamWriter();
  const emitter = createEventStreamEmitter(writer);
  installTerminalFailureReporter((error, exitCode) => {
    if (writer.terminalEventRaised) return;
    reportLogFileLoss(emitter);
    writer.emit(buildErrorEvent(error, "prepare", exitCode));
  });
  return emitter;
}

// --- Persistence loss on a completed run -------------------------------------

/**
 * Report a persistence failure the completed exchange survives, on both machine
 * channels at once: the fd-3 `warning` event (when the stream is open), under
 * the `persistenceLoss` source this function stamps for every caller, and
 * {@link PERSISTENCE_LOSS_EXIT_CODE}. Every non-fatal loss goes through here, so
 * a new one cannot land on one channel and miss the other, and no other warning
 * source reaches the stream beside that exit code. The one loss that is
 * not survivable -- a result file that could not be written -- reports as the
 * terminal `error` event instead, at the same exit code: `runProtocol` stamps
 * it at that write, so a partner-shaped fault elsewhere in the same output
 * stage is not mistaken for a local write loss. The post-output persistence
 * that loss skips still reports through here, so that one warning stands
 * beside a terminal `error` rather than a `result`.
 *
 * `notice` is this party's own prose naming what was lost and what the operator
 * should do; the cause stays on the human log beside this call, escaped once
 * there rather than double-escaped here (see docs/spec/CLI_EVENTS.md,
 * Persistence loss).
 *
 * `process.exitCode` rather than `process.exit`, so the rest of the run's own
 * persistence still happens and still reports what it loses, and a signal
 * handler's `process.exit` is never raced.
 */
export function reportPersistenceLoss(
  notice: string,
  eventStream: EventStreamEmitter | undefined,
): void {
  eventStream?.warning("persistenceLoss", notice);
  process.exitCode = PERSISTENCE_LOSS_EXIT_CODE;
}

/**
 * Report the diagnostic lines the `--log-file` could not write: one summary
 * line on stderr and, when the stream is open, one `warning` event under the
 * `logFileLoss` source with the count in `lostLines`. A run calls it once,
 * before its terminal event; nothing is reported when no line was lost. The
 * exit code is left alone: the log is housekeeping, not an artifact the run
 * owes.
 */
export function reportLogFileLoss(
  eventStream: EventStreamEmitter | undefined,
): void {
  const report = takeLogFileLossReport();
  if (report !== undefined)
    eventStream?.logFileLoss(report.notice, report.lostLines);
}
