// The CLI's remedy for each cause in core's failure-cause catalog: the sentence
// stating what to do, naming only the flag that applies to this run. Core's
// sentence states what happened (failureCauseSentence); this map is total over
// FailureCauseKind, so a cause core adds fails to compile here until bound.
// Also the steps for states only the CLI reaches: what a run left its key file
// holding when it failed or was interrupted (keyFileStateStep), the failure of
// a write to the key file (keyFileWriteFailure), and the lines the failure site
// logs beside a failure (bothSweptStep, missingReceiptWarning).

import {
  failureCauseOf,
  keepOperatorSuppliedText,
  markStatesItsOwnNextStep,
  messageWithOperatorText,
  NEW_INVITATION_REMEDY,
  operatorSuppliedText,
  PARTNER_STOPPED_RESPONDING_REMEDY,
  redactAndRenderOperatorSuppliedText,
  relayRegistrarUnreachableRemedy,
  IGNORE_FILES_OLDER_THAN_KEY,
  type FailureCause,
  type FailureCauseKind,
  type FailureCauseOfKind,
  type MessageWithOperatorText,
  annotate,
  annotationKey,
  annotationOf,
} from "@alcove/core";

import { raiseInactivityLimit } from "./connection/timeoutGuidance";
import { OUT_OF_SYNC_TOKENS_DOC_URL } from "./docLinks";

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
  "different peer_id on one side, changing its text rather than only " +
  "fields such as %Y or %K, then run again.";

const IGNORED_HELLO_REMEDY =
  "If the file this run ignored was your partner's, raise " +
  `${IGNORE_FILES_OLDER_THAN_KEY} (or --ignore-files-older-than), or give ` +
  "both sides the same peer_timeout_ms, then run again.";

const partnerNeverArrived = (
  {
    channel,
    sharedName,
    ignoredHello,
  }: FailureCauseOfKind<"partner-never-arrived">,
  { arrivalWait, fromKeyFile }: RemedyContext,
): string => {
  if (sharedName === true)
    return ignoredHello === undefined
      ? SHARED_PEER_ID_REMEDY
      : `${SHARED_PEER_ID_REMEDY} ${IGNORED_HELLO_REMEDY}`;
  if (ignoredHello !== undefined) return IGNORED_HELLO_REMEDY;
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
      case "no-answer":
        return relayRegistrarUnreachableRemedy(cause);
      case "name-not-resolved":
        return (
          "Check the registrar address in connection.relay_registrar.url and " +
          `that this computer's DNS resolves ${cause.host}, then run again.`
        );
    }
  },
  "partner-stopped-responding": () => PARTNER_STOPPED_RESPONDING_REMEDY,
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
 * The step for an online setup whose configuration step found a file at its
 * configuration path that appeared after the conflict check, and refused to
 * overwrite it. Every message on that path states this step: the refusal
 * itself, the completion summary, and the step of a run that then stops
 * ({@link keyFileSavedConfigNotWrittenRemedy}).
 */
export function configAppearedLateStep(
  configPath: string,
): MessageWithOperatorText {
  const config = operatorSuppliedText(configPath);
  return messageWithOperatorText`Move the file at ${config} elsewhere, then recreate ${config} to match your connection and linkage settings and run 'alcove exchange'.`;
}

/** {@link configAppearedLateStep} as a log line shows it. */
export function configAppearedLateStepShown(configPath: string): string {
  return configAppearedLateStep(configPath)
    .spans.map((span) =>
      span.operatorSupplied
        ? redactAndRenderOperatorSuppliedText(operatorSuppliedText(span.text))
        : span.text,
    )
    .join("");
}

const CONFIG_APPEARED_LATE = annotationKey<true>(
  "a file appeared at the configuration path",
);

/**
 * Mark `err` as the configuration step's refusal of a file that appeared at
 * the configuration path, whose step is {@link configAppearedLateStep}.
 */
export function markConfigAppearedLate<E extends object>(err: E): E {
  return annotate(err, CONFIG_APPEARED_LATE, true);
}

/** Whether {@link markConfigAppearedLate} marked `err`. */
export function isConfigAppearedLate(err: unknown): boolean {
  return annotationOf(err, CONFIG_APPEARED_LATE) === true;
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
  /**
   * That failure was a file that appeared at the configuration path
   * ({@link isConfigAppearedLate}).
   */
  readonly configAppearedLate?: boolean;
}

/**
 * How a run ended: on a failure, whose message or fixed next step states a step
 * of its own or not, or on a signal. `authenticationFailed` marks a failure
 * that began the key exchange and failed to authenticate (exit 77).
 */
export type RunEnding =
  | {
      readonly kind: "failed";
      readonly errorStatesItsStep: boolean;
      readonly authenticationFailed?: boolean;
    }
  | { readonly kind: "interrupted" };

/**
 * The step for `state` on a run that ended as `ending`. With no configuration
 * on disk, the online commands refuse the key file left behind, so it is
 * deleted before a new invitation; with a kept one, `alcove exchange` runs
 * from both files, and stops at the terms on a partner whose deduplicate
 * differs from the acceptance record this run did not refresh, printing the
 * `alcove apply` command that takes the new value on. A failure that states its own step keeps it, and gets only the key file's
 * part. Where a file appeared at the configuration path, the step is
 * {@link configAppearedLateStep}, the one the refusal itself states.
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
  if (!state.kept && state.configAppearedLate === true)
    return (
      `The key file ${key} was saved, but a file appeared at ${config} ` +
      `after the initial conflict check, so the configuration was not ` +
      `written, and then the run ${stopped}. ` +
      configAppearedLateStepShown(state.configPath)
    );
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

/**
 * Where a run's rotation left the two parties, read from how far it got in the
 * store order (docs/spec/PROTOCOL.md, "The rotation at the terms exchange"):
 * - `unchanged`: neither side can have stored the next secret.
 * - `partner-may-lead`: this side, the responder, holds the secret the run
 *   authenticated with, and the initiator may hold the next one.
 * - `partner-may-lag`: this side, the initiator, stored the next secret, and
 *   the responder may not have.
 * - `both-stored`: both sides hold the next secret.
 */
export type RotationStanding =
  "unchanged" | "partner-may-lead" | "partner-may-lag" | "both-stored";

/** What a run left its key file holding when it ended. */
export interface RunKeyFileState {
  readonly standing: RotationStanding;
  /** The run is an online `alcove invite` or `alcove accept`. */
  readonly onlineSetup: boolean;
  /**
   * The online setup saved its key file and wrote no configuration, whose step
   * ({@link keyFileSavedConfigNotWrittenRemedy}) replaces every other.
   */
  readonly keyFileSavedConfigNotWritten?: KeyFileSavedConfigNotWritten;
}

const AUTHENTICATION_FAILED_STEP =
  "Authentication failed, and a retry with this key file fails the same " +
  `way. ${NEW_INVITATION_REMEDY} If the SFTP server's host key is not the ` +
  "pinned one, confirm the server's key with its administrator and pin " +
  "that key instead.";

/**
 * The line stating what `state` leaves the two parties holding on a run that
 * ended as `ending`, or `undefined` where there is nothing to state: a run that
 * rotated nobody leaves the existing secret valid on both sides. The failure
 * site and the signal handler both state it through here. Where the failure
 * states its own step, the line states the secret's state without prescribing
 * one.
 */
export function keyFileStateStep(
  state: RunKeyFileState,
  ending: RunEnding,
): string | undefined {
  if (state.keyFileSavedConfigNotWritten !== undefined)
    return keyFileSavedConfigNotWrittenRemedy(
      state.keyFileSavedConfigNotWritten,
      ending,
    );
  const interrupted = ending.kind === "interrupted";
  const retryRuledOut = ending.kind === "failed" && ending.errorStatesItsStep;
  const saved =
    "The shared secret was already rotated and saved before " +
    `${interrupted ? "the exchange was interrupted" : "this error"}.`;
  const behind =
    "This side had not saved the next shared secret when " +
    `${interrupted ? "the exchange was interrupted" : "this error occurred"}, ` +
    "and your partner may already have saved it";
  switch (state.standing) {
    case "unchanged":
      return ending.kind === "failed" && ending.authenticationFailed === true
        ? AUTHENTICATION_FAILED_STEP
        : undefined;
    case "partner-may-lead":
      if (state.onlineSetup) return keyFileNotSavedRemedy(ending);
      return retryRuledOut
        ? `${behind}, so the next run may need a new invitation from your ` +
            "partner."
        : `${behind}. Retry the exchange with the existing key file; if ` +
            "authentication fails on retry, ask your partner for a new " +
            "invitation.";
    case "partner-may-lag":
    case "both-stored":
      // No line beneath a step that rules out a retry: a responder's partner
      // stored too, and an initiator does not track the responder's first
      // frame after `proceed`, which shows the responder stored, so a line
      // would name a new invitation a retry may not need.
      if (retryRuledOut) return undefined;
      return state.standing === "partner-may-lag"
        ? `${saved} Retry the exchange with the same key file; if ` +
            "authentication fails on retry, ask your partner for a new " +
            "invitation."
        : `${saved} Your partner saved it too, so retry the exchange with ` +
            "the same key file.";
  }
}

/**
 * Which write to the key file failed during a run, and so what its failure
 * states:
 * - `rotation-mark`: recording the key exchange as in flight, before it began.
 * - `first-store`: the initiator's save of the next secret, which comes first.
 *   A directory flush that fails after the rename leaves the next secret in
 *   this side's key file beside the secret the run used, which the next run
 *   heals where it can (`nextRunCanHeal`); the authentication-failure
 *   fallback, and over WebRTC the next run's no-show remedy, cover a state it
 *   cannot.
 * - `responder-store`: the responder's save, where its initiator kept the
 *   secret this run used, so the next run heals.
 * - `responder-store-no-heal`: the responder's save, where it cannot heal.
 * - `previous-drop`: removing the secret before the new one, once both saved.
 * - `partner-store`: the partner's save, which failed after this side saved,
 *   where this side kept the secret this run used.
 * - `partner-store-no-heal`: the same, where the next run cannot heal.
 */
export type KeyFileWriteFailureKind =
  | "rotation-mark"
  | "first-store"
  | "responder-store"
  | "responder-store-no-heal"
  | "previous-drop"
  | "partner-store"
  | "partner-store-no-heal";

const PARTNER_STORE_PREAMBLE =
  "Your partner could not save the new shared secret, so the exchange " +
  "stopped. This side had already saved it to ";

const RESPONDER_STORE_PREAMBLE =
  "authentication succeeded and the shared token was rotated, but the " +
  "updated token could not be saved to ";

// The text ahead of the key file path, and the text after it and after the
// write's own failure where there is one.
const KEY_FILE_WRITE_FAILURES: {
  readonly [K in KeyFileWriteFailureKind]: {
    readonly preamble: string;
    readonly step: string;
  };
} = {
  "rotation-mark": {
    preamble:
      "the key exchange did not start because it could not be recorded in " +
      "the key file at ",
    step:
      " The shared secret is unchanged, though the key file may still " +
      "record this attempt; fix the key file's location or permissions and " +
      "run the exchange again.",
  },
  "first-store": {
    preamble:
      "authentication succeeded, but the next shared secret could not be " +
      "saved to ",
    step:
      " Your partner did not save it. Fix the key file's location or " +
      "permissions, then run the same command again; if authentication " +
      "fails on that run, ask your partner for a new invitation.",
  },
  "responder-store": {
    preamble: RESPONDER_STORE_PREAMBLE,
    step:
      " Your partner saved the new token and kept the one this run used, so " +
      "the next run can use that one. Fix the key file's location or " +
      "permissions, then run the same command again; if authentication " +
      "fails on that run or it never meets your partner, ask your partner " +
      "for a new invitation.",
  },
  "responder-store-no-heal": {
    preamble: RESPONDER_STORE_PREAMBLE,
    step: ` Your partner may already hold the rotated token. ${NEW_INVITATION_REMEDY}`,
  },
  "previous-drop": {
    preamble:
      "both sides saved the new shared secret, but removing the secret " +
      "before it failed in ",
    step:
      ". The exchange stopped. Fix the key file's location or permissions, " +
      "then run the same command again.",
  },
  "partner-store": {
    preamble: PARTNER_STORE_PREAMBLE,
    step:
      ", and kept the secret this run used, so the next run can use that " +
      "one. Run the exchange again once your partner has fixed what stopped " +
      "their save. If authentication then fails, or the run never meets " +
      "your partner, you and your partner hold different secrets. " +
      `${NEW_INVITATION_REMEDY} See ${OUT_OF_SYNC_TOKENS_DOC_URL} for how.`,
  },
  "partner-store-no-heal": {
    preamble: PARTNER_STORE_PREAMBLE,
    step:
      ", so you and your partner now hold different secrets, and running " +
      `the exchange again cannot reconnect you. ${NEW_INVITATION_REMEDY} ` +
      `See ${OUT_OF_SYNC_TOKENS_DOC_URL} for how.`,
  },
};

/**
 * The failure of the `kind` write to the key file at `keyFilePath`: what
 * happened, the path marked as operator-supplied text, the write's own
 * failure `reason` where there is one, and the step, marked as stating its
 * own next step so no rotation line prints beneath it.
 */
export function keyFileWriteFailure(
  kind: KeyFileWriteFailureKind,
  keyFilePath: string,
  reason?: string,
): Error {
  const { preamble, step } = KEY_FILE_WRITE_FAILURES[kind];
  const after = reason === undefined ? step : `: ${reason}${step}`;
  const message = messageWithOperatorText`${preamble}${operatorSuppliedText(
    keyFilePath,
  )}${after}`;
  return markStatesItsOwnNextStep(
    keepOperatorSuppliedText(new Error(message.text), message),
  );
}

/**
 * Guidance for a run that swept the shared folder at entry and then timed out
 * waiting for the partner, the result of both sides sweeping at once. Both
 * sides get the same text and action, so recovery needs no contact. Only a
 * clean delete-mode sweep reaches it, since it says the folder is empty:
 * docs/EXCHANGE_REFERENCE.md#directory-exclusivity.
 */
export const BOTH_SWEPT_GUIDANCE =
  "Both sides appear to have cleared the folder at the same time, removing " +
  "each other's files. The folder should be empty now. Run the exchange " +
  "again on both sides, without --sweep-exchange-files.";

/** What the failure site knows of a failed run for {@link bothSweptStep}. */
export interface SweptRunFacts {
  /** The file-sync run swept the shared folder at entry in delete mode. */
  readonly deleteModeSweep: boolean;
  /**
   * The run then timed out waiting for the partner, at the rendezvous or the
   * key exchange. A sweep that failed part-way raises its own error instead.
   */
  readonly peerWaitTimedOut: boolean;
}

/**
 * The line the failure site logs beside a peer-wait timeout on a run that
 * swept the folder first ({@link BOTH_SWEPT_GUIDANCE}), else `undefined`.
 */
export function bothSweptStep(run: SweptRunFacts): string | undefined {
  return run.deleteModeSweep && run.peerWaitTimedOut
    ? BOTH_SWEPT_GUIDANCE
    : undefined;
}

/** What the failure site knows of a failed run for {@link missingReceiptWarning}. */
export interface SignedRunFacts {
  /** This side configured a signed receipt for the exchange. */
  readonly receiptConfigured: boolean;
  /** The exchange itself completed, so the failure came after it. */
  readonly exchangeComplete: boolean;
  /**
   * The failure is a receipt verification refusal, a security failure its own
   * message reports.
   */
  readonly receiptRefused: boolean;
  /** The failure is this party's own local configuration refusal. */
  readonly localConfigRefused: boolean;
}

/**
 * The warning the failure site logs for a run that configured a signed receipt
 * and failed before the receipt swap completed with no complaint of its own
 * about the receipt, else `undefined`. A partner presenting no signing
 * certificate is refused at the terms exchange as a receipt verification
 * failure, so what is left is a drop during the swap.
 */
export function missingReceiptWarning(run: SignedRunFacts): string | undefined {
  if (
    !run.receiptConfigured ||
    run.exchangeComplete ||
    run.receiptRefused ||
    run.localConfigRefused
  )
    return undefined;
  return (
    "A signed receipt was configured for this exchange, but no receipt " +
    "reached this side before the exchange ended and the receipt swap " +
    "did not complete. A partner that presents no signing certificate " +
    "is refused earlier, at the authenticated setup step, so check the " +
    "transport and the peer's own logs rather than the partner's " +
    "signing configuration. If the peer was still working when the " +
    `exchange ended, ${raiseInactivityLimit(false)}.`
  );
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
