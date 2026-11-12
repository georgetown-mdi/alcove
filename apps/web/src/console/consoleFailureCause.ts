// The console's remedy for each cause in core's failure-cause catalog, for a
// run the console's server conducted through the command-line tool. Core's
// sentence states what happened (failureCauseSentence); this map names the
// console control or step that applies, never the CLI flag the CLI's own
// remedy names. Total over FailureCauseKind, so a cause core adds fails to
// compile here until bound.

import {
  CLEAN_DIRECTORY_RESTART_REMEDY,
  MATCHES_OVER_LIMIT_REMEDY,
  PARTNER_STOPPED_AT_MATCHING_REMEDY,
  PARTNER_STOPPED_RESPONDING_REMEDY,
  failureCauseSentence,
  relayRegistrarUnreachableRemedy,
  setOverLimitRemedy,
  singlePassOverLimitRemedy,
} from "@alcove/core";

import {
  PARTNER_STOPPED_RESPONDING_TITLE,
  PARTNER_STOP_AT_MATCHING_START_TITLE,
  tooLargeFailureTitle,
} from "@psi/managed/managedFailureCopy";
import {
  RUN_DIAGNOSTICS_HEADING,
  SWEEP_CONTROL_LABEL,
} from "@psi/runDiagnosticsModel";

import {
  CONNECTION_TUNING_HEADING,
  IGNORE_FILES_OLDER_THAN_LABEL,
  PEER_TIMEOUT_LABEL,
} from "./connectionTuningModel";
import { EXCHANGE_FILES_HEADING, PEER_ID_LABEL } from "./exchangeFilesModel";

import type {
  FailureCause,
  FailureCauseKind,
  FailureCauseOfKind,
} from "@alcove/core";

/** A catalog cause as the console states it: a title, and its remedy. */
interface ConsoleFailureRemedy {
  title: string;
  remedy: string;
}

/** What a remedy needs to know about the run beyond the cause's own facts. */
interface ConsoleRunContext {
  /** This side set a name for itself under the exchange-files card. */
  readonly thisSideNamed?: boolean;
  /** The run cleared leftover files at entry in delete mode, not retain mode. */
  readonly deleteModeSweep?: boolean;
}

const WAIT_SETTING =
  `"${PEER_TIMEOUT_LABEL}" under ${CONNECTION_TUNING_HEADING} sets how ` +
  "long to wait.";

// The clause a plain no-show on a shared folder gains when this side set a
// name: a partner that arrived second with the same name refuses this side's
// file at entry and writes nothing, so this side waits with no file to report.
const SET_NAMES_DIFFER_CLAUSE = `If both sides set a name under "${EXCHANGE_FILES_HEADING}", check that the names differ.`;

// The line a swept run's peer-wait timeout leads its remedy with, on either
// side: the second side to clear files at entry deletes the first side's, so
// the second times out at the rendezvous and the first in the key exchange.
const BOTH_SWEPT_LINE =
  "If your partner also cleared leftover files when starting, one of you " +
  "may have removed the other's files. Both of you turn off " +
  `"${SWEEP_CONTROL_LABEL}" before the next run.`;

/** The step the generic filedrop failure message ends with. */
export const SHARED_FOLDER_SYNC_STEP =
  "Check that the shared folder is in place and syncing, then try again.";

/** What a connection-borne failure usually is. */
export const TEMPORARY_CONNECTION_PROBLEM =
  "a temporary connection problem rather than an issue with your data";

// The check a run on a shared location ends with, before the retry.
const sharedLocationCheck = (
  channel: "filedrop" | "sftp" | "webrtc" | undefined,
): string =>
  channel === "filedrop"
    ? "Check that you and your partner use the same shared folder and " +
      "that it is syncing, then try again."
    : channel === "sftp"
      ? "Check that you and your partner use the same server and " +
        "folder, then try again."
      : "Check that your partner has started their side, then try again.";

const SHARED_NAME_TITLE = "Both sides may be using the same name";

const SAME_NAME_STEP =
  "The likely cause is that both sides set the same name: change " +
  `"${PEER_ID_LABEL}" under "${EXCHANGE_FILES_HEADING}" so the two names ` +
  "differ";

const SHARED_NAME_REMEDY = `${SAME_NAME_STEP}, then run again.`;

// At entry the file may instead be this side's own leftover, which the
// report beside the alert lists.
const SHARED_NAME_AT_ENTRY_REMEDY =
  `${SAME_NAME_STEP}. If instead the listed files are left over from an ` +
  "earlier run of this side, remove them after confirming no other session " +
  `is using this folder, or turn on "${SWEEP_CONTROL_LABEL}" under ` +
  `"${RUN_DIAGNOSTICS_HEADING}", then run again.`;

const NEW_INVITATION_STEP =
  "Ask your partner for a new invitation, or start over and create one for " +
  "your partner to accept.";

const IGNORED_HELLO_TITLE = "Your partner's hello file may have been ignored";

const IGNORED_HELLO_REMEDY =
  "If the file this run ignored was your partner's, raise " +
  `"${IGNORE_FILES_OLDER_THAN_LABEL}" under ${CONNECTION_TUNING_HEADING}, ` +
  `or give both sides the same "${PEER_TIMEOUT_LABEL}", then run again.`;

const partnerNeverArrived = (
  {
    channel,
    sharedName,
    ignoredHello,
  }: FailureCauseOfKind<"partner-never-arrived">,
  { thisSideNamed, deleteModeSweep }: ConsoleRunContext,
): ConsoleFailureRemedy => {
  if (sharedName === true)
    return {
      title: SHARED_NAME_TITLE,
      remedy:
        ignoredHello === undefined
          ? SHARED_NAME_REMEDY
          : `${SHARED_NAME_REMEDY} ${IGNORED_HELLO_REMEDY}`,
    };
  if (ignoredHello !== undefined)
    return { title: IGNORED_HELLO_TITLE, remedy: IGNORED_HELLO_REMEDY };
  const check = `${sharedLocationCheck(channel)} `;
  const names =
    thisSideNamed === true && channel !== "webrtc"
      ? `${SET_NAMES_DIFFER_CLAUSE} `
      : "";
  const swept =
    deleteModeSweep === true && channel !== "webrtc"
      ? `${BOTH_SWEPT_LINE} `
      : "";
  return {
    title: "Your partner did not arrive",
    remedy: swept + check + names + WAIT_SETTING,
  };
};

/**
 * The title and remedy for each cause kind; `undefined` binds a kind whose
 * failure the console states in other copy of its own.
 */
const CONSOLE_FAILURE_REMEDIES: {
  readonly [K in FailureCauseKind]:
    | ((
        cause: FailureCauseOfKind<K>,
        context: ConsoleRunContext,
      ) => ConsoleFailureRemedy)
    | undefined;
} = {
  "partner-never-arrived": partnerNeverArrived,
  "folder-missing": ({ code }) => ({
    title: "The shared folder is not available",
    remedy:
      code === "ENOENT"
        ? "Check that the shared folder is mounted into the console and " +
          "still in place, then try again."
        : "Check that the shared folder is mounted into the console as a " +
          "folder rather than a file, then try again.",
  }),
  "relay-registrar-unreachable": (cause) => ({
    title: "The relay registrar could not be reached",
    remedy: relayRegistrarUnreachableRemedy(cause),
  }),
  "partner-stopped-responding": () => ({
    title: PARTNER_STOPPED_RESPONDING_TITLE,
    remedy: PARTNER_STOPPED_RESPONDING_REMEDY,
  }),
  "set-over-limit": (cause) => ({
    title: tooLargeFailureTitle(
      cause.limit === "uncounted"
        ? { setUncounted: true }
        : cause.limit === "partner-ceiling"
          ? { tooLargeBound: "partner-ceiling" }
          : {},
    ),
    remedy: setOverLimitRemedy(cause),
  }),
  "single-pass-over-limit": (cause) => ({
    title:
      cause.limit === "distinct-values"
        ? tooLargeFailureTitle({})
        : "This exchange is too large for single-pass linkage",
    remedy: singlePassOverLimitRemedy(cause),
  }),
  "matches-over-limit": () => ({
    title: "This exchange found more matches than it can send",
    remedy: MATCHES_OVER_LIMIT_REMEDY,
  }),
  "shared-secret-unusable": ({ problem }) => ({
    title:
      problem === "expired"
        ? "This invitation can no longer be used"
        : "This invitation's shared secret is not valid",
    remedy: NEW_INVITATION_STEP,
  }),
  "partner-stopped-at-matching": () => ({
    title: PARTNER_STOP_AT_MATCHING_START_TITLE,
    remedy: PARTNER_STOPPED_AT_MATCHING_REMEDY,
  }),
  "message-write-unconfirmed": () => ({
    title: "A message may or may not have reached your partner",
    remedy: CLEAN_DIRECTORY_RESTART_REMEDY,
  }),
  "shared-name-at-entry": () => ({
    title: SHARED_NAME_TITLE,
    remedy: SHARED_NAME_AT_ENTRY_REMEDY,
  }),
  // The swept case is consoleSweptHandshakeTimeout's; any other run takes the
  // generic failure copy with the CLI's report.
  "key-exchange-timed-out": undefined,
};

/**
 * The console's account of a run that failed on `cause`: core's sentence
 * stating what happened, followed by the console's remedy; `undefined` for a
 * kind {@link CONSOLE_FAILURE_REMEDIES} binds to none.
 */
export function consoleFailureForCause(
  cause: FailureCause,
  context: ConsoleRunContext = {},
):
  | {
      title: string;
      message: string;
    }
  | undefined {
  const remedyFor = CONSOLE_FAILURE_REMEDIES[cause.kind] as
    | ((c: FailureCause, ctx: ConsoleRunContext) => ConsoleFailureRemedy)
    | undefined;
  if (remedyFor === undefined) return undefined;
  const { title, remedy } = remedyFor(cause, context);
  return { title, message: `${failureCauseSentence(cause)} ${remedy}` };
}

/**
 * The console's account of a key-exchange handshake timeout on a filedrop or
 * SFTP run that cleared leftover files in delete mode, recognized by the
 * event's catalog cause, `cause`; undefined for any other failure or run. The
 * side that entered first in a both-swept collision gets the line here.
 */
export function consoleSweptHandshakeTimeout(
  cause: FailureCause | undefined,
  {
    channel,
    deleteModeSweep,
  }: {
    readonly channel: string | undefined;
    readonly deleteModeSweep: boolean;
  },
): { title: string; message: string } | undefined {
  if (
    !deleteModeSweep ||
    (channel !== "filedrop" && channel !== "sftp") ||
    cause?.kind !== "key-exchange-timed-out"
  )
    return undefined;
  // The partner had already reached the shared location, so the step names
  // syncing or the connection, not the location.
  const step =
    channel === "filedrop"
      ? "Otherwise, check that the shared folder is in place and syncing, then try again."
      : `Otherwise this is usually ${TEMPORARY_CONNECTION_PROBLEM}, so try again.`;
  return {
    title: "Your partner did not answer",
    message: `Your partner did not answer in time. ${BOTH_SWEPT_LINE} ${step}`,
  };
}
