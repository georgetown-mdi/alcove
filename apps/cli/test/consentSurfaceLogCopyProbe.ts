import logLibrary from "loglevel";

import { consentSurfaceSink } from "../src/invitationDisplay";
import { configureLogging } from "../src/util/logging";

/**
 * Renders one consent line on the prompt stream under the `--log-file` named
 * by the first argument, then exits. Run as a child process so its stderr is a
 * descriptor the test chose and the log file is opened by the real sink, which
 * is how a log file that is stderr itself is told apart.
 */

const logFile = process.argv[2];
const line = process.argv[3];
if (logFile === undefined || line === undefined)
  throw new Error("usage: consentSurfaceLogCopyProbe <log-file> <line>");

const { log, close } = configureLogging({
  logLevel: logLibrary.levels.INFO,
  logFile,
  name: "consent-probe",
});
try {
  consentSurfaceSink({ log, logFile, toPromptStream: true })(line);
} finally {
  close();
}
