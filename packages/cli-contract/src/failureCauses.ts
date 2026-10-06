// The `cause` field of the fd-3 `error` event: one row per kind in core's
// failure-cause catalog, from which both the kinds the stream can state and
// the field the CLI emits for a cause derive.

import {
  FAILURE_CAUSE_PATH_MAX_LENGTH,
  redactAndSanitizeForDisplay,
} from "@alcove/core";
import type {
  FailureCause,
  FailureCauseKind,
  FailureCauseOfKind,
  RelayRegistrarUnreachableFailure,
} from "@alcove/core";

/**
 * A counter or duration as a non-negative whole number, so a malformed value
 * (undefined, NaN, negative, fractional) never produces an out-of-contract
 * numeric field. Every numeric field the stream holds goes through it; it is
 * a robustness floor, not a sanitizer.
 */
export function toStreamCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function relayRegistrarFailureFields(
  cause: RelayRegistrarUnreachableFailure,
): RelayRegistrarUnreachableFailure {
  switch (cause.failure) {
    case "no-connection":
      return { failure: cause.failure, code: cause.code };
    case "name-not-resolved":
      return { failure: cause.failure, code: cause.code };
    case "no-answer":
      return "timedOutMs" in cause
        ? {
            failure: cause.failure,
            timedOutMs: toStreamCount(cause.timedOutMs),
          }
        : { failure: cause.failure, code: cause.code };
  }
}

/**
 * The stream field for each cause kind: the kind's facts copied one by one, so
 * nothing beyond them widens the line, a path or host escaped as the stream's
 * other free text is, and a wait floored to a whole count. Total over
 * `FailureCauseKind`, so a cause core adds fails to compile here until it has
 * a row.
 */
export const FAILURE_CAUSE_STREAM_FIELDS: {
  readonly [K in FailureCauseKind]: (
    cause: FailureCauseOfKind<K>,
  ) => FailureCauseOfKind<K>;
} = {
  "partner-never-arrived": ({ channel, waitedMs }) => ({
    kind: "partner-never-arrived",
    ...(channel !== undefined ? { channel } : {}),
    ...(waitedMs !== undefined ? { waitedMs: toStreamCount(waitedMs) } : {}),
  }),
  "folder-missing": ({ path, code }) => ({
    kind: "folder-missing",
    path: redactAndSanitizeForDisplay(path, {
      maxLength: FAILURE_CAUSE_PATH_MAX_LENGTH,
    }),
    code,
  }),
  "relay-registrar-unreachable": (cause) => ({
    kind: "relay-registrar-unreachable",
    host: redactAndSanitizeForDisplay(cause.host, {
      maxLength: FAILURE_CAUSE_PATH_MAX_LENGTH,
    }),
    port: cause.port,
    ...relayRegistrarFailureFields(cause),
  }),
};

/** Every cause kind the stream states: the keys of {@link FAILURE_CAUSE_STREAM_FIELDS}. */
export const FAILURE_CAUSE_STREAM_KINDS = Object.freeze(
  Object.keys(FAILURE_CAUSE_STREAM_FIELDS) as FailureCauseKind[],
);

/** Whether `kind` is one of {@link FAILURE_CAUSE_STREAM_KINDS}. */
export function isFailureCauseStreamKind(
  kind: unknown,
): kind is FailureCauseKind {
  return (
    typeof kind === "string" && Object.hasOwn(FAILURE_CAUSE_STREAM_FIELDS, kind)
  );
}

/**
 * The `error` event's `cause` field for `cause`, or `undefined` -- the field
 * dropped -- when its kind has no row in {@link FAILURE_CAUSE_STREAM_FIELDS}.
 * A cause read off an error's tag is typed rather than checked, so a kind this
 * build does not know reaches here and must not be called as a row.
 */
export function failureCauseStreamField(
  cause: FailureCause,
): FailureCause | undefined {
  const kind: unknown = cause.kind;
  if (!isFailureCauseStreamKind(kind)) return undefined;
  return (
    FAILURE_CAUSE_STREAM_FIELDS[kind] as (cause: FailureCause) => FailureCause
  )(cause);
}
