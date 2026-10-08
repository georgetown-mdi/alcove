// The schema of the CLI's fd-3 event stream. The contract a supervisor reads,
// field by field: docs/spec/CLI_EVENTS.md.

import type {
  EntityClusterSummary,
  FailureCause,
  PartnerDeduplicateChange,
  PayloadColumnsChange,
  ResolvedMatching,
} from "@alcove/core";

import type { WarningSource } from "./warningSources.js";

/**
 * The fixed descriptor the event stream is written to, beside stdout and
 * stderr. See docs/spec/CLI_EVENTS.md#file-descriptor.
 */
export const EVENT_STREAM_FD = 3;

/**
 * The schema version on every line (`v`). Bump it on a breaking change to an
 * event's fields or the classification rules; an added field need not.
 */
export const EVENT_STREAM_VERSION = 1;

/**
 * The most shapes the `result` event's `entityClusters` field lists, keeping
 * the terminal event under a consumer's per-line bound (the console relay's is
 * 1 MiB). A wider distribution drops the field; a truncated list would
 * misstate how many shapes go unnamed.
 */
export const EVENT_RESULT_CLUSTER_SHAPES_MAX = 256;

/**
 * The closed set of event `type` values, none partner-derived. `result` and
 * `error` are the terminal events. See docs/spec/CLI_EVENTS.md#event-types.
 */
export const EVENT_TYPES = [
  "stages",
  "stage",
  "stageEnd",
  "warning",
  "metrics",
  "result",
  "error",
] as const;

/** One {@link EVENT_TYPES} value; see that list. */
export type EventType = (typeof EVENT_TYPES)[number];

/** Whether `type` is one of {@link EVENT_TYPES}. */
export function isEventType(type: unknown): type is EventType {
  return (
    typeof type === "string" &&
    (EVENT_TYPES as ReadonlyArray<string>).includes(type)
  );
}

/**
 * The terminal-error categories, the same as the web app's
 * `ExchangeErrorCategory`. See docs/spec/CLI_EVENTS.md#error-categories.
 */
export type ExchangeErrorCategory =
  "exchange" | "output" | "security" | "config";

/**
 * The phase a terminal error was raised in: `prepare` up to and including the
 * handshake, `run` the PSI exchange, `output` the local result write.
 */
export type ErrorPhase = "prepare" | "run" | "output";

/** One stage in the `stages` event. */
export interface EventStageDefinition {
  id: string;
  label: string;
}

interface EventBase {
  /** Schema version; see {@link EVENT_STREAM_VERSION}. */
  v: number;
  type: EventType;
}

/** The one-shot stage list. */
export interface StagesEvent extends EventBase {
  type: "stages";
  stages: EventStageDefinition[];
}

/** A stage transition. */
export interface StageEvent extends EventBase {
  type: "stage";
  id: string;
  label: string;
}

/**
 * A completed stage's wall-clock time. A stage a run aborts in gets none. See
 * docs/spec/CLI_EVENTS.md#stageend.
 */
export interface StageEndEvent extends EventBase {
  type: "stageEnd";
  /** An `id` from the `stages` event. */
  id: string;
  /** Whole milliseconds; never negative. */
  durationMs: number;
}

/** A non-fatal warning, classified by `source`. */
export interface WarningEvent extends EventBase {
  type: "warning";
  source: WarningSource;
  message: string;
  /**
   * `message` before its display escape, redacted and fitted, for a consumer
   * that escapes what it shows. Absent on `payloadReceiveTaken`, whose partner
   * text is in `columns`.
   */
  unescapedMessage?: string;
  /** Lines the `--log-file` could not take; `logFileLoss` only. */
  lostLines?: number;
  /**
   * The partner's column names, redacted and fitted but not escaped;
   * `payloadReceiveTaken` only.
   */
  columns?: string[];
  /** Columns taken, more than `columns` lists where it was cut. */
  columnCount?: number;
}

/**
 * This party's own counters for the run, emitted once just before the
 * terminal event. See docs/spec/CLI_EVENTS.md#metrics.
 */
export interface MetricsEvent extends EventBase {
  type: "metrics";
  /** This party's input record count. */
  recordsProcessed: number;
  /** Transport data-operation retries. */
  transportRetries: number;
  /** Connection re-establishment attempts. */
  reconnects: number;
}

/** The success terminal event. See docs/spec/CLI_EVENTS.md#result. */
export interface ResultEvent extends EventBase {
  type: "result";
  /**
   * Whether this party received a matched result table: false when its terms
   * give it no output, and on a count-only exchange.
   */
  resultWritten: boolean;
  /**
   * A count-only (`psi-c`) exchange's intersection size, present exactly when
   * this party's terms gave it the count.
   */
  intersectionCount?: number;
  /** Matched rows; present exactly when {@link resultWritten} is true. */
  matchedRows?: number;
  /** The result file's absolute path, escaped; absent for stdout. */
  resultPath?: string;
  /**
   * Whether {@link intersectionCount} is the partner's report rather than this
   * party's computation; present exactly when that count is.
   */
  countReportedByPartner?: boolean;
  /**
   * What the agreed `deduplicate` values resolved to for this party. No
   * partner free text.
   */
  matching: ResolvedMatching;
  /**
   * How the entity closure grouped this party's result. Present only on a
   * `many-to-many` run whose table this party receives, within
   * {@link EVENT_RESULT_CLUSTER_SHAPES_MAX} shapes. No partner free text.
   */
  entityClusters?: EntityClusterSummary;
}

/** The failure terminal event. See docs/spec/CLI_EVENTS.md#error. */
export interface ErrorEvent extends EventBase {
  type: "error";
  category: ExchangeErrorCategory;
  /** Display-safe error text, as stderr receives it. */
  message: string;
  /**
   * `true` when {@link message} states its own next step, so a supervisor
   * shows it in place of its own copy. Never emitted `false`.
   */
  recoveryHint?: true;
  /**
   * `true` exactly when {@link exitCode} is `INTERNAL_FAULT_EXIT_CODE`; a
   * supervisor offers no retry. Never emitted `false`.
   */
  internalFault?: true;
  /**
   * The process exit code. Optional on the wire: absence means an older
   * emitter, never success.
   */
  exitCode: number;
  /**
   * How the partner's terms differ, when the run ended on a change it did not
   * take on. Partner-chosen text is escaped.
   */
  termsChange?: ErrorEventTermsChange;
  /**
   * The failure's cause from core's catalog, for a supervisor to state with
   * its own remedy. Absent when the catalog names none.
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
