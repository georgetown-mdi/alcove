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

const relayRegistrarUnreachable = ({
  host,
  port,
  failure,
}: FailureCauseOfKind<"relay-registrar-unreachable">): string => {
  switch (failure) {
    case "no-connection":
      return (
        `This computer needs outbound access to ${host} on TCP port ${port}: ` +
        "if this network allows only some ports out, have that port opened " +
        "or run from a network that allows it."
      );
    case "name-not-resolved":
      return (
        "Check the registrar address in connection.relay_registrar.url and " +
        `that this computer's DNS resolves ${host}, then run again.`
      );
    case "no-answer":
      return (
        "The registrar did not complete the " +
        "request: check that it is running and reachable from this network " +
        "(infra/relay/README.md, The registrar), then run again."
      );
  }
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
  "relay-registrar-unreachable": relayRegistrarUnreachable,
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
 * command boundary that renders it names that flag. Only an error carrying the
 * partner-never-arrived cause is tagged; any other error, and one that cannot
 * take the property (frozen, sealed), is returned unchanged.
 */
export function markArrivalWait<E>(err: E, arrivalWait: ArrivalWait): E {
  if (
    typeof err === "object" &&
    err !== null &&
    failureCauseOf(err)?.kind === "partner-never-arrived"
  )
    Reflect.defineProperty(err, ARRIVAL_WAIT_TAG, {
      value: arrivalWait,
      configurable: true,
      enumerable: true,
      writable: true,
    });
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
