/**
 * The `alcove.yaml` and `.alcove.key` a webrtc run leaves in the working
 * folder, where `alcove invite` writes them on the command line, so a later
 * `alcove exchange` in that folder continues the exchange. As on the command
 * line they are written once the handshake has succeeded, never over a file
 * already there: until then the run's pair lives in its own workdir, so a run
 * that fails before the handshake leaves nothing in the working folder.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { JOB_FILE_NAMES } from "@jobContract/intentSchemas";

import { JOB_FILE_MODE, jobPathPresent, resolveWorkdirFile } from "./workdir";

/** The paths of an exchange's configuration and key file. */
export interface ExchangeFilePaths {
  configPath: string;
  keyPath: string;
}

/**
 * Thrown when the run's files cannot go into the working folder: `present`
 * when an `alcove.yaml` or `.alcove.key` is already there, `unwritable` when
 * the folder refused the write. `heldByConsoleExchange` says the files there
 * are the ones an earlier exchange on this console wrote. Nothing is left
 * behind.
 */
export class WorkingFolderFilesRefusedError extends Error {
  readonly fault: "present" | "unwritable";
  readonly heldByConsoleExchange: boolean;
  constructor(fault: "present" | "unwritable", heldByConsoleExchange = false) {
    super(
      fault === "present"
        ? "the working folder already holds an exchange configuration"
        : "the exchange configuration could not be written to the working folder",
    );
    this.name = "WorkingFolderFilesRefusedError";
    this.fault = fault;
    this.heldByConsoleExchange = heldByConsoleExchange;
  }
}

/** The working folder's `alcove.yaml` and `.alcove.key` paths. */
export function workingFolderExchangeFilePaths(
  dataRoot: string,
): ExchangeFilePaths {
  const configPath = resolveWorkdirFile(dataRoot, JOB_FILE_NAMES.config);
  const keyPath = resolveWorkdirFile(dataRoot, JOB_FILE_NAMES.key);
  if (configPath === null || keyPath === null)
    throw new Error("an exchange file name resolved outside the data root");
  return { configPath, keyPath };
}

/** Which of the working folder's two exchange file names are taken, by
 * anything, a link included. */
export function workingFolderExchangeFilesPresent(dataRoot: string): {
  config: boolean;
  key: boolean;
} {
  const { configPath, keyPath } = workingFolderExchangeFilePaths(dataRoot);
  return { config: jobPathPresent(configPath), key: jobPathPresent(keyPath) };
}

/** Create `filePath` owner-only, failing when anything is at the name. */
function createOwnerOnly(filePath: string, content: Buffer): void {
  const fd = fs.openSync(filePath, "wx", JOB_FILE_MODE);
  try {
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, JOB_FILE_MODE);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Copy the run's `source` pair into the working folder as `alcove.yaml` and
 * `.alcove.key`, each owner-only and created only where nothing is at the
 * name. Where the second create fails the first file is removed.
 *
 * @throws {WorkingFolderFilesRefusedError} when either name is taken or the
 *   folder cannot be written.
 */
export function writeWorkingFolderExchangeFiles(
  dataRoot: string,
  source: ExchangeFilePaths,
): ExchangeFilePaths {
  const target = workingFolderExchangeFilePaths(dataRoot);
  let configWritten = false;
  try {
    const keyContent = fs.readFileSync(source.keyPath);
    createOwnerOnly(target.configPath, fs.readFileSync(source.configPath));
    configWritten = true;
    createOwnerOnly(target.keyPath, keyContent);
  } catch (error) {
    if (configWritten) fs.rmSync(target.configPath, { force: true });
    throw new WorkingFolderFilesRefusedError(
      (error as NodeJS.ErrnoException).code === "EEXIST"
        ? "present"
        : "unwritable",
    );
  }
  return target;
}

/** Replace the regular file at `filePath` with `content`, owner-only, through
 * a new file renamed over it. A name holding anything but a regular file, or
 * nothing, is left as it is. */
function replaceRegularFile(filePath: string, content: Buffer): void {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (stats === undefined || !stats.isFile()) return;
  if (fs.readFileSync(filePath).equals(content)) return;
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    createOwnerOnly(temporaryPath, content);
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

/** The bytes of `filePath`, or undefined when nothing is there. */
function readIfPresent(filePath: string): Buffer | undefined {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Bring the working-folder pair a run wrote up to date with the run's own
 * `source` pair, which the CLI goes on writing after the handshake: the
 * partner's pinned certificate, and the key file's later markers. A file no
 * longer in the working folder is not written again, and a source file
 * removed with its run's folder is not copied.
 */
export function refreshWorkingFolderExchangeFiles(
  source: ExchangeFilePaths,
  target: ExchangeFilePaths,
): void {
  for (const [from, to] of [
    [source.configPath, target.configPath],
    [source.keyPath, target.keyPath],
  ] as const) {
    const content = readIfPresent(from);
    if (content !== undefined) replaceRegularFile(to, content);
  }
}
