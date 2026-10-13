import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ZodError } from "zod";

import {
  JOB_FILE_NAMES,
  PREVIOUS_CONFIGURATION_FILE_NAME,
} from "@jobContract/intentSchemas";

import {
  mountedUnconductedDocument,
  statesSameConfiguration,
} from "./configLoad";
import { formatFirstIssue } from "./schemaIssueMessage";
import { handBackConfigDocument } from "./handoff";
import { resolveWorkdirFile } from "./workdir";

import type {
  CONFIGURATION_CHANGED_SAVE_REFUSAL,
  JobConfigurationHandBack,
} from "@jobContract/intentSchemas";

/**
 * Handing the configuration the operator opened back into their working folder,
 * for a channel the console does not compose into a job folder (`PUT
 * /api/jobs/config`): a webrtc configuration, saved before the console runs it
 * in place or for the command line to run.
 *
 * A run's hand-off shows the operator a template to copy; this one cannot, since
 * the document's connection can hold a credential no browser receives. It is
 * written in place of the `alcove.yaml` it was opened from instead, the file
 * the command line runs, and the response states only that it was written.
 */

/**
 * Raised when the hand-back is not written. Its message reaches the operator,
 * so it states what stopped the write and what to do, and names no value from
 * the file and no container path.
 */
export class ConfigurationHandBackRefusedError extends Error {
  /** Set where the file is not the one the console opened or last saved, so
   * the browser can offer to open it again. */
  readonly reason: typeof CONFIGURATION_CHANGED_SAVE_REFUSAL | undefined;

  constructor(
    message: string,
    reason?: typeof CONFIGURATION_CHANGED_SAVE_REFUSAL,
  ) {
    super(message);
    this.name = "ConfigurationHandBackRefusedError";
    this.reason = reason;
  }
}

/** The message reaching the operator when the file could not be replaced. */
const UNWRITABLE_CONFIGURATION_MESSAGE =
  "The console could not write alcove.yaml in your working folder. Check " +
  "that the folder and the file are writable, then save again.";

/** The message reaching the operator when the file changed since it was
 * opened or last saved here, as a run that records a partner's fingerprint
 * changes it, or the console restarted since: the steps may no longer hold
 * what the file does. */
export const CONFIGURATION_CHANGED_SINCE_OPENED_MESSAGE =
  "The alcove.yaml in your working folder changed since you opened it, or " +
  "the console restarted, so your changes were not saved. Open alcove.yaml " +
  "again: that replaces the settings on these steps with what the file " +
  "holds.";

/** The message reaching the operator when an exchange is running over the
 * file. */
export const CONFIGURATION_IN_USE_MESSAGE =
  "An exchange is running over the alcove.yaml in your working folder, so " +
  "your changes were not saved. Save again once it ends.";

/**
 * Write `handBack` into the mounted configuration: re-read the file, compose
 * the edited settings over it with its connection unchanged, and replace it.
 * Returns the text written, or undefined where the file already states that
 * configuration, which is then left as it is. `consoleWritten` is the text the
 * console's own last save wrote: replacing a file holding exactly that leaves
 * the {@link PREVIOUS_CONFIGURATION_FILE_NAME} copy as it is, so the copy
 * keeps the last file the console did not write.
 *
 * @throws {ConfigurationLoadRefusedError} when the mount no longer holds a
 *   configuration this hand-back applies to (see `mountedUnconductedDocument`).
 * @throws {ConfigurationHandBackRefusedError} when the settings do not make a
 *   valid configuration, or the file could not be written.
 */
export function handBackMountedConfiguration(
  dataRoot: string,
  handBack: JobConfigurationHandBack,
  consoleWritten?: string,
): string | undefined {
  const mountedDocument = mountedUnconductedDocument(dataRoot);
  let text: string;
  try {
    text = handBackConfigDocument(handBack, mountedDocument);
  } catch (error) {
    if (error instanceof ZodError)
      throw new ConfigurationHandBackRefusedError(
        "These settings do not make a configuration Alcove can run (" +
          formatFirstIssue(error.issues) +
          "). Change them, then save again.",
      );
    throw error;
  }
  if (statesSameConfiguration(text, mountedDocument)) return undefined;
  replaceMountedConfiguration(dataRoot, text, consoleWritten);
  return text;
}

/**
 * Replace the mounted `alcove.yaml` with `text`, first copying the file as it
 * stands to {@link PREVIOUS_CONFIGURATION_FILE_NAME} in the same folder unless
 * it holds exactly `consoleWritten`: the writer keeps none of the operator's
 * comments, key order, or quoting, so the copy is what they have to recover
 * them from. A copy that cannot be written leaves the file unreplaced. An
 * `alcove.yaml` that is a link is replaced at the file it names, and the copy
 * and the replacement keep that file's permission bits.
 */
function replaceMountedConfiguration(
  dataRoot: string,
  text: string,
  consoleWritten: string | undefined,
): void {
  const filePath = resolveWorkdirFile(dataRoot, JOB_FILE_NAMES.config);
  const previousPath = resolveWorkdirFile(
    dataRoot,
    PREVIOUS_CONFIGURATION_FILE_NAME,
  );
  if (filePath === null || previousPath === null)
    throw new Error("the configuration name resolved outside the data root");
  try {
    const target = fs.realpathSync(filePath);
    const { mode, bytes } = readModeAndBytes(target);
    if (
      consoleWritten === undefined ||
      !bytes.equals(Buffer.from(consoleWritten, "utf8"))
    )
      writeReplacing(previousPath, bytes, mode);
    writeReplacing(target, text, mode);
  } catch {
    throw new ConfigurationHandBackRefusedError(
      UNWRITABLE_CONFIGURATION_MESSAGE,
    );
  }
}

/** Read a file's permission bits and contents from one open descriptor. */
function readModeAndBytes(file: string): { mode: number; bytes: Buffer } {
  const fd = fs.openSync(file, "r");
  try {
    return {
      mode: fs.fstatSync(fd).mode & 0o777,
      bytes: fs.readFileSync(fd),
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Write `content` to a new file beside `destination`, flush it, and rename it
 * over `destination`, so an interrupted write leaves what was there as it was.
 */
function writeReplacing(
  destination: string,
  content: string | Buffer,
  mode: number,
): void {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`,
  );
  let renamed = false;
  try {
    const fd = fs.openSync(temporary, "wx", mode);
    try {
      fs.writeFileSync(fd, content);
      fs.fchmodSync(fd, mode);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, destination);
    renamed = true;
  } finally {
    if (!renamed) fs.rmSync(temporary, { force: true });
  }
}
