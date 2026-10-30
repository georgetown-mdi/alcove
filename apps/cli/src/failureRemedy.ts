// The CLI's remedy for each cause in core's failure-cause catalog: the sentence
// stating what to do, naming only the flag that applies to this run. Core's
// sentence states what happened (failureCauseSentence); this map is total over
// FailureCauseKind, so a cause core adds fails to compile here until bound.

import {
  failureCauseOf,
  relayRegistrarUnreachableRemedy,
  type FailureCause,
  type FailureCauseKind,
  type FailureCauseOfKind,
  annotate,
  annotationKey,
  annotationOf,
} from "@alcove/core";

/**
 * Which flag bounds this run's wait for the partner: `--accept-timeout` for an
 * online `alcove invite`, `--peer-timeout` for every other run.
 */
export type ArrivalWait = "exchange" | "online-invitation";

/** What a remedy needs to know about the run beyond the cause's own facts. */
export interface RemedyContext {
  readonly arrivalWait: ArrivalWait;
  /**
   * The run authenticated with a key file an earlier run or a provisioning
   * command wrote, which may be an older copy than the partner's.
   */
  readonly fromKeyFile?: boolean;
}

const DEFAULT_CONTEXT: RemedyContext = { arrivalWait: "exchange" };

/**
 * What a webrtc no-show from a key file adds: two parties on different
 * secrets derive different rendezvous ids and never meet, so an older copy of
 * the key file is reported only here (docs/CLI.md, "Out-of-sync tokens").
 */
export const OLDER_KEY_FILE_NO_SHOW_REMEDY =
  "If your partner did start, one of you may be running from an older copy " +
  "of the key file, such as one restored from a backup or copied from " +
  "another machine: run from the newest copy, or ask your partner for a new " +
  "invitation.";

const partnerNeverArrived = (
  { channel }: FailureCauseOfKind<"partner-never-arrived">,
  { arrivalWait, fromKeyFile }: RemedyContext,
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
  const remedy = `${check}, then run again; --peer-timeout sets how long to wait.`;
  return channel === "webrtc" && fromKeyFile === true
    ? `${remedy} ${OLDER_KEY_FILE_NO_SHOW_REMEDY}`
    : remedy;
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
  "relay-registrar-unreachable": (cause) => {
    switch (cause.failure) {
      case "no-connection":
        return relayRegistrarUnreachableRemedy(cause);
      case "name-not-resolved":
        return (
          "Check the registrar address in connection.relay_registrar.url and " +
          `that this computer's DNS resolves ${cause.host}, then run again.`
        );
      case "no-answer":
        return (
          "The registrar did not complete the request: check that it is " +
          "running and reachable from this network " +
          "(infra/relay/README.md, The registrar), then run again."
        );
    }
  },
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

const ARRIVAL_WAIT = annotationKey<ArrivalWait>("arrival wait");
const FROM_KEY_FILE = annotationKey<true>("run from a key file");

/**
 * Record on `err` which flag bounded this run's wait for the partner, so the
 * command boundary that renders it names that flag, and whether the run
 * authenticated with a key file ({@link RemedyContext.fromKeyFile}). Only an
 * error carrying the partner-never-arrived cause is annotated; any other
 * error is returned unchanged.
 */
export function markArrivalWait<E>(
  err: E,
  arrivalWait: ArrivalWait,
  options: { fromKeyFile?: boolean } = {},
): E {
  if (
    typeof err === "object" &&
    err !== null &&
    failureCauseOf(err)?.kind === "partner-never-arrived"
  ) {
    annotate(err, ARRIVAL_WAIT, arrivalWait);
    if (options.fromKeyFile === true) annotate(err, FROM_KEY_FILE, true);
  }
  return err;
}

function arrivalWaitOf(err: unknown): ArrivalWait {
  return annotationOf(err, ARRIVAL_WAIT) ?? "exchange";
}

/**
 * The CLI's remedy for the catalog cause `err` holds anywhere in its cause
 * chain, else `undefined`: also for a tagged kind with no row here, since a
 * cause read off an error's tag is typed rather than checked.
 */
export function failureRemedy(err: unknown): string | undefined {
  const cause = failureCauseOf(err);
  return cause === undefined || !Object.hasOwn(CLI_FAILURE_REMEDIES, cause.kind)
    ? undefined
    : remedyForCause(cause, {
        arrivalWait: arrivalWaitOf(err),
        fromKeyFile: annotationOf(err, FROM_KEY_FILE) === true,
      });
}
