import { isConsoleBuild } from "@utils/clientConfig";

/**
 * The file-step assurance line on the hosted build. It shows before a channel
 * is chosen, and a save-file flow leaves the encrypting to the command-line
 * tool on the operator's machine, so it names no place the encrypting happens.
 */
export const HOSTED_FILE_ASSURANCE =
  "Your file is never uploaded to our servers. What is sent to your partner " +
  "is encrypted first.";

/**
 * The file-assurance line for a console surface that reads input from the
 * mounted work directory. {@link fileAssuranceLine} does not resolve to it:
 * each mounted-input surface opts in, since the lobby and the receipt verifier
 * never read from that directory.
 */
export const APPLIANCE_FILE_ASSURANCE =
  "Files are read from your working folder on this console; your browser " +
  "does not upload them.";

/**
 * The file-assurance line, or none where the server receives files: no
 * unverified claim is substituted.
 */
export function fileAssuranceLine(
  serverReceivesFiles: boolean,
): string | undefined {
  return serverReceivesFiles ? undefined : HOSTED_FILE_ASSURANCE;
}

/**
 * The file-assurance line for this build; the server receives files exactly on
 * the console ({@link isConsoleBuild}).
 */
export const FILE_ASSURANCE_LINE = fileAssuranceLine(isConsoleBuild());
