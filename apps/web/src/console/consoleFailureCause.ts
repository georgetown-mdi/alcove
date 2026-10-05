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

const WAIT_SETTING =
  `"${PEER_TIMEOUT_LABEL}" under ${CONNECTION_TUNING_HEADING} sets how ` +
  "long to wait.";

/**
 * The title and remedy for each cause kind.
 *
 * @internal exported for testing
 */
export const CONSOLE_FAILURE_REMEDIES: {
  readonly [K in FailureCauseKind]: (
    cause: FailureCauseOfKind<K>,
  ) => ConsoleFailureRemedy;
} = {
  "partner-never-arrived": ({ channel }) => ({
    title: "Your partner did not arrive",
    remedy:
      (channel === "filedrop"
        ? "Check that you and your partner use the same shared folder and " +
          "that it is syncing, then try again. "
        : channel === "sftp"
          ? "Check that you and your partner use the same server and " +
            "folder, then try again. "
          : "Check that your partner has started their side, then try " +
            "again. ") + WAIT_SETTING,
  }),
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
export function consoleFailureForCause(cause: FailureCause): {
  title: string;
  message: string;
} {
  const { title, remedy } = (
    CONSOLE_FAILURE_REMEDIES[cause.kind] as (
      c: FailureCause,
    ) => ConsoleFailureRemedy
  )(cause);
  return { title, message: `${failureCauseSentence(cause)} ${remedy}` };
}
