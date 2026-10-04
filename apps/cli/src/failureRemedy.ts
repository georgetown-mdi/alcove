// The CLI's remedy for each cause in core's failure-cause catalog: the sentence
// stating what to do, naming only the flag that applies to this run. Core's
// sentence states what happened (failureCauseSentence); this map is total over
// FailureCauseKind, so a cause core adds fails to compile here until bound.

import {
  failureCauseOf,
  type FailureCause,
  type FailureCauseKind,
  type FailureCauseOfKind,
} from "@alcove/core";

/**
 * Which flag bounds this run's wait for the partner: `--accept-timeout` for an
 * online `alcove invite`, `--peer-timeout` for every other run.
 */
export type ArrivalWait = "exchange" | "online-invitation";

/** What a remedy needs to know about the run beyond the cause's own facts. */
export interface RemedyContext {
  readonly arrivalWait: ArrivalWait;
}

const DEFAULT_CONTEXT: RemedyContext = { arrivalWait: "exchange" };

const partnerNeverArrived = (
  { channel }: FailureCauseOfKind<"partner-never-arrived">,
  { arrivalWait }: RemedyContext,
): string => {
  if (arrivalWait === "online-invitation")
    return (
      "Run alcove invite again and have your partner accept the new " +
      "invitation while it waits; --accept-timeout sets how long to wait."
    );
  const check =
    channel === "filedrop"
      ? "Check that you and your partner use the same folder and that it is syncing"
      : channel === "sftp"
        ? "Check that you and your partner use the same server and folder"
        : "Check that your partner has started their side";
  return `${check}, then run again; --peer-timeout sets how long to wait.`;
};

/**
 * The remedy sentence for each cause kind, given the cause and the run.
 *
 * @internal exported for testing
 */
export const CLI_FAILURE_REMEDIES: {
  readonly [K in FailureCauseKind]: (
    cause: FailureCauseOfKind<K>,
    context: RemedyContext,
  ) => string;
} = {
  "partner-never-arrived": partnerNeverArrived,
  "folder-missing": ({ code }) =>
    code === "ENOENT"
      ? "Create or mount the folder, or correct its path, then run again."
      : "Correct the path so it names a folder, then run again.",
};

/** The CLI's remedy sentence for `cause` on a run described by `context`. */
export function remedyForCause(
  cause: FailureCause,
  context: RemedyContext = DEFAULT_CONTEXT,
): string {
  return (
    CLI_FAILURE_REMEDIES[cause.kind] as (
      c: FailureCause,
      ctx: RemedyContext,
    ) => string
  )(cause, context);
}

const ARRIVAL_WAIT_TAG = "alcoveArrivalWait";

/**
 * Record on `err` which flag bounded this run's wait for the partner, so the
 * command boundary that renders it names that flag. A non-object is returned
 * unchanged.
 */
export function markArrivalWait<E>(err: E, arrivalWait: ArrivalWait): E {
  if (typeof err === "object" && err !== null)
    Object.assign(err, { [ARRIVAL_WAIT_TAG]: arrivalWait });
  return err;
}

function arrivalWaitOf(err: unknown): ArrivalWait {
  const tagged =
    typeof err === "object" && err !== null
      ? (err as Record<string, unknown>)[ARRIVAL_WAIT_TAG]
      : undefined;
  return tagged === "online-invitation" ? tagged : "exchange";
}

/**
 * The CLI's remedy for the catalog cause `err` holds anywhere in its cause
 * chain, else `undefined`.
 */
export function failureRemedy(err: unknown): string | undefined {
  const cause = failureCauseOf(err);
  return cause === undefined
    ? undefined
    : remedyForCause(cause, { arrivalWait: arrivalWaitOf(err) });
}
