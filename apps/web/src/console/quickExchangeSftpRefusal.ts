import { SFTP_URL_DIRECTORY_REFUSAL } from "@jobContract/jobCreateRefusal";

import type { AlertContent } from "@components/csvIntake";
import type { SftpConnectionProjection } from "@jobs/jobManager";
import type { ZeroSetupSftpRefusalReason } from "@jobContract/jobCreateRefusal";

/**
 * The copy for a quick exchange refused over its saved SFTP connection, in the
 * parts both places that state it compose: the quick-exchange step before the
 * run, and the failure after job create refuses one.
 */
interface QuickExchangeSftpRefusalCopy {
  title: string;
  /** What is wrong with the saved connection, as one sentence. */
  problem: string;
  /** What to change once the connection's edit form is open, completing a
   * sentence that names Edit connection. */
  change: string;
}

/** The copy for the refusal `reason` names. */
export function quickExchangeSftpRefusalCopy(
  reason: ZeroSetupSftpRefusalReason,
): QuickExchangeSftpRefusalCopy {
  return reason === SFTP_URL_DIRECTORY_REFUSAL
    ? {
        title: "The saved SFTP connection's remote directory cannot be used",
        problem:
          "A quick exchange's remote directory must be a directory under / " +
          "with no . or .. parts.",
        change: "enter a directory like /exchange/in.",
      }
    : {
        title: "The saved SFTP connection holds more than one fingerprint",
        problem:
          "The saved SFTP connection holds more than one server identity " +
          "fingerprint, and a quick exchange pins one.",
        change: "keep only the fingerprint the server presents now.",
      };
}

/**
 * The refusal the quick-exchange step states over the saved connection, or
 * undefined when a quick exchange runs it. Read from the token the console
 * computed with job create's own check, so the step and the run agree.
 */
export function quickExchangeSftpRefusal(
  connection: SftpConnectionProjection | null | undefined,
): AlertContent | undefined {
  const reason = connection?.zeroSetupRefusal;
  if (reason === undefined) return undefined;
  const copy = quickExchangeSftpRefusalCopy(reason);
  return {
    title: copy.title,
    message: `${copy.problem} Choose Edit connection and ${copy.change}`,
  };
}
