// The schema of the CLI's fd-3 event stream: the event types, their fields,
// and the stream's constants. The CLI builds and writes these events
// (apps/cli/src/eventStream.ts); docs/spec/CLI_EVENTS.md is the contract a
// supervisor reads.

import type {
  EntityClusterSummary,
  FailureCause,
  PartnerDeduplicateChange,
  PayloadColumnsChange,
  ResolvedMatching,
} from "@alcove/core";

import type { WarningSource } from "./warningSources.js";

/**
 * The fixed file descriptor the opt-in machine-readable event stream is written
 * to. Not configurable: a supervisor spawns Alcove with descriptor 3 wired to a
 * pipe it reads, so a constant is the contract. stdout (fd 1) and stderr (fd 2)
 * are untouched -- the event stream is a third channel, so a supervisor reads
 * structured events without parsing the human log or corrupting the CSV result.
 * The full contract lives in docs/spec/CLI_EVENTS.md.
 */
export const EVENT_STREAM_FD = 3;

/**
 * The schema version stamped on every emitted line (the `v` field). A small
 * integer so a supervisor can read the version from any single line without
 * tracking stream position. Bump it on any breaking change to an event's field
 * layout or the classification rules; an additive field need not bump it. See
 * docs/spec/CLI_EVENTS.md.
 */
export const EVENT_STREAM_VERSION = 1;

/**
 * The most shape entries the `result` event's `entityClusters` field holds.
 *
 * That list is the one variable-length field of this stream, and a run whose
 * clusters take thousands of distinct shapes would push the terminal event past
 * a consumer's per-line bound -- the console relay's is 1 MiB
 * (`apps/web/src/jobs/cliDriver.ts`) -- costing the run the outcome the event
 * exists to report. A wider distribution drops the field rather than truncating
 * the list, since a short list would misstate how many shapes the summary's own
 * sentence leaves unnamed. Sized well above any distribution an operator reads
 * and well below that bound.
 */
export const EVENT_RESULT_CLUSTER_SHAPES_MAX = 256;

/**
 * The closed vocabulary of event `type` values. This party owns every one of
 * these strings -- none is partner-derived -- so a consumer can switch on the
 * discriminant safely. `stages` is the one-shot stage-list event; `stage` marks
 * each stage transition; `stageEnd` reports a completed stage's wall-clock
 * duration; `warning` holds a non-fatal warning, whose own {@link WarningSource}
 * field names which notice raised it;
 * `metrics` is the one-shot operational-counter summary emitted just before the
 * terminal event; `result` and `error` are the two terminal events (exactly one
 * fires per run).
 */
export type EventType =
  "stages" | "stage" | "stageEnd" | "warning" | "metrics" | "result" | "error";

/**
 * The four terminal-error categories, lifted verbatim from the web's
 * `ExchangeErrorCategory` (apps/web/src/psi/exchangeLifecycle.ts) so a consumer
 * classifies a CLI failure exactly as it would a web one:
 * - `config`: a PREPARE-phase `OperatorConfigError` -- a fault composed
 *   solely of this party's own configuration, actionable and safe to show.
 * - `security`: a trust-boundary failure -- a `security`-kind
 *   `ConnectionError` from the authenticated key exchange (wrong secret,
 *   tamper, replay), from SFTP host-key verification (a pinned-fingerprint
 *   mismatch), or from the post-handshake AEAD layer. It must be identifiable from the terminal event
 *   alone, since an integrity failure exits 69 like a plain transport
 *   failure.
 * - `output`: the privacy-sensitive exchange already succeeded and only local
 *   result-file generation failed -- the operator must NOT re-run the exchange.
 * - `exchange`: every other failure (a transport or usage fault, or a refusal
 *   by the partner or the agreed terms).
 */
export type ExchangeErrorCategory =
  "exchange" | "output" | "security" | "config";

/**
 * The lifecycle phase a terminal error was raised in, mirroring the web's
 * `phase` argument to its classifier. `prepare` covers everything before the
 * exchange proper begins (dataset prep, connection open, handshake); `run`
 * covers the PSI exchange itself; `output` covers local result-file generation
 * after the exchange succeeded.
 */
export type ErrorPhase = "prepare" | "run" | "output";

/** A single stage in the emitted stage list, echoing the web's onStages shape. */
export interface EventStageDefinition {
  id: string;
  label: string;
}

interface EventBase {
  /** Schema version; see {@link EVENT_STREAM_VERSION}. */
  v: number;
  type: EventType;
}

/** The one-shot stage-list event, the CLI counterpart of the web's onStages. */
export interface StagesEvent extends EventBase {
  type: "stages";
  stages: EventStageDefinition[];
}

/** A stage-transition event, the counterpart of the web's onStage. */
export interface StageEvent extends EventBase {
  type: "stage";
  id: string;
  label: string;
}

/**
 * A stage-completion event, emitted when a protocol stage finishes, reporting
 * how long it ran. It pairs with the start-of-stage {@link StageEvent} so a
 * supervisor can attribute wall-clock to the stage named by `id`. Only a
 * completed stage is reported: a run that aborts mid-stage emits no `stageEnd`
 * for the in-flight stage, so a reported duration is always a whole stage's time.
 */
export interface StageEndEvent extends EventBase {
  type: "stageEnd";
  /** The completed stage's identifier, matching an `id` from the `stages` event. */
  id: string;
  /** Wall-clock the stage ran, in whole milliseconds; never negative. */
  durationMs: number;
}

/**
 * A non-fatal warning. `source` names which notice raised it, so a supervisor
 * classifies the warning without parsing `message`.
 */
export interface WarningEvent extends EventBase {
  type: "warning";
  source: WarningSource;
  message: string;
  /**
   * The text `message` escapes, before that escape: redacted and fitted so
   * its escaped form stays within `WARNING_MESSAGE_MAX_DISPLAY_LENGTH`, but
   * not escaped, so a consumer that escapes what it shows makes the one pass
   * the text takes. Present on every warning but `payloadReceiveTaken`,
   * whose partner text is in `columns` (`buildWarningEvent`).
   */
  unescapedMessage?: string;
  /**
   * How many diagnostic lines the `--log-file` could not take; present only
   * under `source: "logFileLoss"` (`reportLogFileLoss`).
   */
  lostLines?: number;
  /**
   * The partner's column names the message holds, as the partner declared
   * them: redacted and fitted to the per-value budget but not escaped, so a
   * consumer escapes a name where it shows it. Present only under
   * `source: "payloadReceiveTaken"` (`buildPayloadReceiveTakenEvent`).
   */
  columns?: string[];
  /**
   * How many columns the run took, more than `columns` holds where the
   * message was cut; present only beside `columns`.
   */
  columnCount?: number;
}

/**
 * The per-run operational-counter summary, emitted exactly once immediately
 * before the terminal {@link ResultEvent}/{@link ErrorEvent} (so the terminal
 * event stays last). It reports this party's dataset size and how often the
 * transport had to retry a data operation or re-establish the connection over
 * the run. Every field is this party's own non-negative integer -- none is
 * partner-derived -- so no sanitization applies. Not emitted on a signal exit,
 * which emits no terminal event either.
 */
export interface MetricsEvent extends EventBase {
  type: "metrics";
  /** This party's input record count fed into the exchange. */
  recordsProcessed: number;
  /** Transport data-operation retries over the run; 0 when none occurred. */
  transportRetries: number;
  /** Connection re-establishment attempts over the run; 0 when none occurred. */
  reconnects: number;
}

/** The success terminal event. Exactly one terminal event fires per run. */
export interface ResultEvent extends EventBase {
  type: "result";
  /**
   * Whether this party received a matched result table. False for a one-sided
   * exchange in which this party is the helper and its agreed terms give it no
   * output -- it contributed to the match but receives no result file -- and
   * false for a count-only exchange, which produces no matched pairing for
   * anyone, in which case {@link intersectionCount} holds the outcome.
   */
  resultWritten: boolean;
  /**
   * The size of the intersection a count-only (`psi-c`) exchange reported,
   * present exactly when this party's agreed terms gave it the count and absent
   * on every other run. It is what separates the two `resultWritten: false`
   * outcomes: with the field, this party received exactly what its terms
   * promised; without it, the terms withheld the result table.
   */
  intersectionCount?: number;
  /**
   * The number of matched rows in the result table this party received,
   * present exactly when {@link resultWritten} is true.
   */
  matchedRows?: number;
  /**
   * The absolute path the result table was written to, escaped for display,
   * present when {@link resultWritten} is true and the result went to a file
   * rather than to stdout.
   */
  resultPath?: string;
  /**
   * Whether {@link intersectionCount} arrived as the partner's report rather than
   * as a figure this party computed -- true for the PSI sender seat of a
   * both-entitled count-only run, false for the receiver that computed it. Emitted
   * exactly when {@link intersectionCount} is, so a consumer reads the pair or
   * neither; absent means there was no count to qualify.
   */
  countReportedByPartner?: boolean;
  /**
   * What the two parties' agreed `deduplicate` values resolved to for this
   * party ({@link ResolvedMatching}): the pair as presented and the cardinality
   * it gives this side. Present on every successful run.
   *
   * On the stream because the human log states it at info level, which a
   * supervisor discarding stderr -- or running at a quieter level -- never
   * reads, and a console seat watching the run reads nothing else. Both
   * booleans and the closed cardinality label are this party's own values,
   * derived from terms the run boundary already parsed, so no partner free
   * text rides the field.
   */
  matching: ResolvedMatching;
  /**
   * How the entity closure grouped this party's result: the cluster count, how
   * many records of each party stand in a cluster, and the distribution of the
   * shapes those clusters take ({@link EntityClusterSummary}).
   *
   * Present on a `many-to-many` run this party holds the table of, absent under
   * every other cardinality -- whose clusters follow from the table's own shape
   * -- and absent where the distribution holds more shapes than
   * {@link EVENT_RESULT_CLUSTER_SHAPES_MAX}.
   *
   * On the stream for the reason {@link matching} is: the human log states the
   * same summary as a sentence at info level, which a supervisor reading fd 3
   * alone -- or a console seat watching the run -- never reads. Every figure is
   * one of this party's own counts over its own table, so no partner free text
   * rides the field.
   */
  entityClusters?: EntityClusterSummary;
}

/** The failure terminal event. Exactly one terminal event fires per run. */
export interface ErrorEvent extends EventBase {
  type: "error";
  category: ExchangeErrorCategory;
  /**
   * Display-safe error text, the same text stderr receives
   * (`renderFailureForOperator`).
   */
  message: string;
  /**
   * Present and `true` when {@link message} holds its own next step: read off
   * core's `alcoveRecoveryHintEmitted` tag (`errorStatesItsOwnNextStep`),
   * or set where the CLI appended `fixedNextStep`'s step to an internal
   * fault's or a partner refusal's message, or its remedy for a {@link cause}
   * (`failureRemedy`). A supervisor showing fixed copy
   * for this category shows the message instead, and adds no advisory of its
   * own; absent, it has no such assurance. Omitted rather than emitted `false`, so the field is the
   * assurance and nothing else.
   */
  recoveryHint?: true;
  /**
   * Present and `true` exactly when {@link exitCode} is
   * `INTERNAL_FAULT_EXIT_CODE` (70): a fault in Alcove itself, which a
   * retry reaches again. A supervisor offering a retry for the `exchange`
   * category withholds it here. Omitted rather than emitted `false`.
   */
  internalFault?: true;
  /**
   * The code the process exits with on this failure. Optional on the wire
   * (docs/spec/CLI_EVENTS.md): a consumer reads its absence as an emitter
   * older than the field, never as success.
   */
  exitCode: number;
  /**
   * Present when the run ended on a partner terms change it did not take on
   * (`termsChangeNotTakenOf`): how the partner's terms differ, each
   * partner-chosen name and diagnostic escaped, and whether the run wrote
   * them beside the configuration for `alcove apply`.
   */
  termsChange?: ErrorEventTermsChange;
  /**
   * The cause from core's failure-cause catalog the failure holds
   * (`failureCauseOf`), as its kind and facts: a supervisor states the cause
   * from it and names its own remedy rather than reading {@link message}.
   * Absent on a failure the catalog does not name.
   */
  cause?: FailureCause;
}

/** One direction's changed payload columns, as the `error` event states them. */
export type ErrorEventColumnsChange = PayloadColumnsChange;

/** The `error` event's {@link ErrorEvent.termsChange}. */
export interface ErrorEventTermsChange {
  proposalWritten: boolean;
  received?: ErrorEventColumnsChange;
  sent?: ErrorEventColumnsChange;
  partnerDeduplicate?: PartnerDeduplicateChange;
  otherTerms: string[];
}

export type StreamEvent =
  | StagesEvent
  | StageEvent
  | StageEndEvent
  | WarningEvent
  | MetricsEvent
  | ResultEvent
  | ErrorEvent;
