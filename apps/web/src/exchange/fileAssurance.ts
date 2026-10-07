import { isConsoleBuild } from "@utils/clientConfig";

/**
 * The browser-only file-processing claim, true only where the deployment never
 * sends the file anywhere.
 */
export const BROWSER_ONLY_FILE_ASSURANCE =
  "Your file is processed entirely in your browser and it is never " +
  "uploaded to our server.";

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
  return serverReceivesFiles ? undefined : BROWSER_ONLY_FILE_ASSURANCE;
}

/**
 * The file-assurance line for this build; the server receives files exactly on
 * the console ({@link isConsoleBuild}).
 */
export const FILE_ASSURANCE_LINE = fileAssuranceLine(isConsoleBuild());
