// The console's remedy for each cause in core's failure-cause catalog, for a
// run the console's server conducted through the command-line tool. Core's
// sentence states what happened (failureCauseSentence); this map names the
// console control or step that applies, never the CLI flag the CLI's own
// remedy names. Total over FailureCauseKind, so a cause core adds fails to
// compile here until bound.

import {
  failureCauseSentence,
  relayRegistrarUnreachableRemedy,
} from "@alcove/core";

import {
  CONNECTION_TUNING_HEADING,
  PEER_TIMEOUT_LABEL,
} from "./connectionTuningModel";
import { EXCHANGE_FILES_HEADING, PEER_ID_LABEL } from "./exchangeFilesModel";

import type {
  FailureCause,
  FailureCauseKind,
  FailureCauseOfKind,
} from "@alcove/core";

/** A catalog cause as the console states it: a title, and its remedy. */
export interface ConsoleFailureRemedy {
  title: string;
  remedy: string;
}

/** What a remedy needs to know about the run beyond the cause's own facts. */
export interface ConsoleRunContext {
  /** This side set a name for itself under the exchange-files card. */
  readonly thisSideNamed?: boolean;
}

const WAIT_SETTING =
  `"${PEER_TIMEOUT_LABEL}" under ${CONNECTION_TUNING_HEADING} sets how ` +
  "long to wait.";

// The clause a plain no-show on a shared folder gains when this side set a
// name: a partner that arrived second with the same name refuses this side's
// file at entry and writes nothing, so this side waits with no file to report.
const SET_NAMES_DIFFER_CLAUSE = `If both sides set a name under "${EXCHANGE_FILES_HEADING}", check that the names differ.`;

const SHARED_NAME_TITLE = "Both sides may be using the same name";

const SHARED_NAME_REMEDY =
  "The likely cause is that both sides set the same name: change " +
  `"${PEER_ID_LABEL}" under "${EXCHANGE_FILES_HEADING}" so the two names ` +
  "differ, then run again.";

const partnerNeverArrived = (
  { channel, sharedName }: FailureCauseOfKind<"partner-never-arrived">,
  { thisSideNamed }: ConsoleRunContext,
): ConsoleFailureRemedy => {
  if (sharedName === true)
    return { title: SHARED_NAME_TITLE, remedy: SHARED_NAME_REMEDY };
  const check =
    channel === "filedrop"
      ? "Check that you and your partner use the same shared folder and " +
        "that it is syncing, then try again. "
      : channel === "sftp"
        ? "Check that you and your partner use the same server and " +
          "folder, then try again. "
        : "Check that your partner has started their side, then try again. ";
  const names =
    thisSideNamed === true && channel !== "webrtc"
      ? `${SET_NAMES_DIFFER_CLAUSE} `
      : "";
  return {
    title: "Your partner did not arrive",
    remedy: check + names + WAIT_SETTING,
  };
};

/**
 * The title and remedy for each cause kind.
 *
 * @internal exported for testing
 */
export const CONSOLE_FAILURE_REMEDIES: {
  readonly [K in FailureCauseKind]: (
    cause: FailureCauseOfKind<K>,
    context: ConsoleRunContext,
  ) => ConsoleFailureRemedy;
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
};

/**
 * The console's account of a run that failed on `cause`: core's sentence
 * stating what happened, followed by the console's remedy.
 */
export function consoleFailureForCause(
  cause: FailureCause,
  context: ConsoleRunContext = {},
): {
  title: string;
  message: string;
} {
  const { title, remedy } = (
    CONSOLE_FAILURE_REMEDIES[cause.kind] as (
      c: FailureCause,
      ctx: ConsoleRunContext,
    ) => ConsoleFailureRemedy
  )(cause, context);
  return { title, message: `${failureCauseSentence(cause)} ${remedy}` };
}
