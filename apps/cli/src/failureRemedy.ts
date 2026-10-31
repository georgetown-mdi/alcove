// The CLI's remedy for each cause in core's failure-cause catalog: the sentence
// stating what to do, naming only the flag that applies to this run. Core's
// sentence states what happened (failureCauseSentence); this map is total over
// FailureCauseKind, so a cause core adds fails to compile here until bound.
// Also the steps for states only the CLI reaches, an online setup that stopped
// with its key file saved and no configuration written
// (keyFileSavedConfigNotWrittenRemedy), or before it saved its key file
// (keyFileNotSavedRemedy).

import {
  failureCauseOf,
  NEW_INVITATION_REMEDY,
  operatorSuppliedText,
  redactAndRenderOperatorSuppliedText,
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

// The remedy for a partner that never arrived while a file with this side's
// name appeared: the wait was not the problem, so it names no timeout flag.
// Worded as the start-up refusal of such a file words it.
const SHARED_PEER_ID_REMEDY =
  "The likely cause is that both parties set the same peer_id: set a " +
  "different peer_id on one side, changing its text rather than only its " +
  "% fields, then run again.";

const partnerNeverArrived = (
  { channel, sharedName }: FailureCauseOfKind<"partner-never-arrived">,
  { arrivalWait, fromKeyFile }: RemedyContext,
): string => {
  if (sharedName === true) return SHARED_PEER_ID_REMEDY;
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

/**
 * The configuration an online `alcove invite` or `alcove accept` sets up: its
 * path, and whether the run keeps one already there (an accept that reconciled
 * it) rather than writing its own.
 */
export interface OnlineSetupConfiguration {
  readonly configPath: string;
  readonly kept: boolean;
}

/**
 * An online invite or accept that saved its rotated key file at `keyPath` and
 * then ended without writing a configuration, so the configuration is the one
 * it kept, or none.
 */
export interface KeyFileSavedConfigNotWritten extends OnlineSetupConfiguration {
  readonly keyPath: string;
  /**
   * The configuration step ran and failed to write the configuration, which
   * only a setup that keeps none writes; false where the run ended before that
   * step or the configuration is kept.
   */
  readonly configWriteFailed: boolean;
}

/**
 * How a run ended: on a failure, whose message or fixed next step states a step
 * of its own or not, or on a signal.
 */
export type RunEnding =
  | { readonly kind: "failed"; readonly errorStatesItsStep: boolean }
  | { readonly kind: "interrupted" };

/**
 * The step for `state` on a run that ended as `ending`. With no configuration
 * on disk, the online commands refuse the key file left behind, so it is
 * deleted before a new invitation; with a kept one, `alcove exchange` runs
 * from both files, and stops at the terms on a partner whose deduplicate
 * differs from the acceptance record this run did not refresh, printing the
 * `alcove apply` command that takes the new value on. A failure that states its own step keeps it, and gets only the key file's
 * part.
 */
export function keyFileSavedConfigNotWrittenRemedy(
  state: KeyFileSavedConfigNotWritten,
  ending: RunEnding,
): string {
  const key = redactAndRenderOperatorSuppliedText(
    operatorSuppliedText(state.keyPath),
  );
  const config = redactAndRenderOperatorSuppliedText(
    operatorSuppliedText(state.configPath),
  );
  const stopped = ending.kind === "interrupted" ? "was interrupted" : "stopped";
  const errorStep = ending.kind === "failed" && ending.errorStatesItsStep;
  if (!state.kept) {
    const happened = state.configWriteFailed
      ? `The key file ${key} was saved, but writing the configuration ${config} failed (logged above), and then the run ${stopped}.`
      : `The key file ${key} was saved, but the run ${stopped} before it wrote the configuration ${config}.`;
    const deleteKey = `Delete ${key} before you start again.`;
    return errorStep
      ? `${happened} ${deleteKey}`
      : `${happened} ${deleteKey} ${NEW_INVITATION_REMEDY}`;
  }
  const happened = `The key file ${key} was saved and the configuration ${config} kept before the run ${stopped}.`;
  return errorStep
    ? `${happened} If you accept a new invitation, delete ${key} first.`
    : `${happened} Run 'alcove exchange' again. If it stops because your ` +
        `partner's deduplicate differs from the one ${config} records, run ` +
        "the 'alcove apply' command it prints, then 'alcove exchange' again. " +
        "If it fails to authenticate or never meets your partner, ask your " +
        `partner for a new invitation, and delete ${key} before you accept it.`;
}

/**
 * The step for an online invite or accept that ended before this side saved
 * its key file, where its partner may have saved the next secret. Both online
 * commands refuse a key file already there, a setup keeping its configuration
 * included, so the run left none to retry with.
 */
export function keyFileNotSavedRemedy(ending: RunEnding): string {
  const stopped = ending.kind === "interrupted" ? "was interrupted" : "stopped";
  const happened = `The run ${stopped} before this side saved its key file, and your partner may already have saved the next shared secret.`;
  return ending.kind === "failed" && ending.errorStatesItsStep
    ? `${happened} The next run needs a new invitation.`
    : `${happened} ${NEW_INVITATION_REMEDY}`;
}

const KEY_FILE_SAVED_CONFIG_NOT_WRITTEN =
  annotationKey<KeyFileSavedConfigNotWritten>(
    "key file saved, configuration not written",
  );

/**
 * Record `state` on `err`, so the command boundary that renders it states
 * {@link keyFileSavedConfigNotWrittenRemedy}. An error that is not an object is
 * returned unchanged.
 */
export function markKeyFileSavedConfigNotWritten<E>(
  err: E,
  state: KeyFileSavedConfigNotWritten,
): E {
  if (typeof err === "object" && err !== null)
    annotate(err, KEY_FILE_SAVED_CONFIG_NOT_WRITTEN, state);
  return err;
}

/**
 * What {@link markKeyFileSavedConfigNotWritten} recorded on `err` or the nearest
 * link of its cause chain, else `undefined`.
 */
export function keyFileSavedConfigNotWrittenOf(
  err: unknown,
): KeyFileSavedConfigNotWritten | undefined {
  return annotationOf(err, KEY_FILE_SAVED_CONFIG_NOT_WRITTEN);
}
