/**
 * Writing a webrtc run's `alcove.yaml` and `.alcove.key` into the working
 * folder, where `alcove invite` writes them on the command line, so a later
 * `alcove exchange` in that folder continues the exchange. Neither file may
 * already be there, as on the command line, apart from the pair a retry of the
 * same invitation finds: a key file holding exactly this run's secret.
 */

import fs from "node:fs";

import { JOB_FILE_NAMES } from "@jobContract/intentSchemas";

import { JOB_FILE_MODE, jobPathPresent, resolveWorkdirFile } from "./workdir";
import { MAX_MOUNTED_KEY_FILE_BYTES } from "./mountedKeyFile";
import { readBoundedMountedFile } from "./boundedMountedFile";

/**
 * Thrown when the run's files cannot go into the working folder: `present`
 * when an `alcove.yaml` or `.alcove.key` another exchange wrote is there,
 * `unwritable` when the folder refused the write. Nothing is left behind.
 */
export class WorkingFolderFilesRefusedError extends Error {
  readonly fault: "present" | "unwritable";
  constructor(fault: "present" | "unwritable") {
    super(
      fault === "present"
        ? "the working folder already holds an exchange configuration"
        : "the exchange configuration could not be written to the working folder",
    );
    this.name = "WorkingFolderFilesRefusedError";
    this.fault = fault;
  }
}

/** Create `filePath` owner-only, failing when anything is at the name. */
function createOwnerOnly(filePath: string, content: string): void {
  const fd = fs.openSync(filePath, "wx", JOB_FILE_MODE);
  try {
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, JOB_FILE_MODE);
  } finally {
    fs.closeSync(fd);
  }
}

/** Whether the key file at `keyPath` holds exactly `keyDocument`. */
function holdsKeyDocument(keyPath: string, keyDocument: string): boolean {
  const read = readBoundedMountedFile(keyPath, MAX_MOUNTED_KEY_FILE_BYTES);
  return read.outcome === "read" && read.source === keyDocument;
}

/**
 * Write `configDocument` and `keyDocument` as the working folder's
 * `alcove.yaml` and `.alcove.key`, each owner-only and created only where
 * nothing is at the name. A key file already holding `keyDocument` is this
 * invitation's own, from an earlier attempt: it is kept, with the
 * `alcove.yaml` beside it, or a new one where that was removed.
 *
 * @throws {WorkingFolderFilesRefusedError} when either name is taken by
 *   another exchange's file, or the folder cannot be written.
 */
export function writeWorkingFolderExchangeFiles(
  dataRoot: string,
  configDocument: string,
  keyDocument: string,
): { configPath: string; keyPath: string } {
  const configPath = resolveWorkdirFile(dataRoot, JOB_FILE_NAMES.config);
  const keyPath = resolveWorkdirFile(dataRoot, JOB_FILE_NAMES.key);
  if (configPath === null || keyPath === null)
    throw new Error("an exchange file name resolved outside the data root");

  const keyRetained =
    jobPathPresent(keyPath) && holdsKeyDocument(keyPath, keyDocument);
  if (keyRetained && jobPathPresent(configPath)) return { configPath, keyPath };
  if (!keyRetained && (jobPathPresent(configPath) || jobPathPresent(keyPath)))
    throw new WorkingFolderFilesRefusedError("present");

  let configWritten = false;
  try {
    createOwnerOnly(configPath, configDocument);
    configWritten = true;
    if (!keyRetained) createOwnerOnly(keyPath, keyDocument);
  } catch (error) {
    if (configWritten) fs.rmSync(configPath, { force: true });
    throw new WorkingFolderFilesRefusedError(
      (error as NodeJS.ErrnoException).code === "EEXIST"
        ? "present"
        : "unwritable",
    );
  }
  return { configPath, keyPath };
}
