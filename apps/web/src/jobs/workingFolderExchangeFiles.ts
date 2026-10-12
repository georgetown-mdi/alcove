/**
 * The `alcove.yaml` and `.alcove.key` of a console webrtc exchange. The
 * console writes both into the working folder when the run starts, as
 * `alcove invite` writes them for an exchange `alcove exchange` runs later,
 * and the CLI rotates the key and records the partner's pin in them in place,
 * so the same folder runs the exchange again from the command line.
 */

import crypto from "node:crypto";
import fs from "node:fs";

import { KeyFileSchema, parseSensitiveJson } from "@alcove/core";

import { JOB_FILE_NAMES } from "@jobContract/intentSchemas";

import { JOB_FILE_MODE, jobPathPresent, resolveWorkdirFile } from "./workdir";
import { MAX_CONFIGURATION_FILE_BYTES } from "./configLoad";
import { MAX_MOUNTED_KEY_FILE_BYTES } from "./mountedKeyFile";
import { readBoundedMountedBytes } from "./boundedMountedFile";

/** The paths of an exchange's configuration and key file. */
export interface ExchangeFilePaths {
  configPath: string;
  keyPath: string;
}

/** A sha256 digest of each file's bytes, so no secret is kept. */
export interface ExchangeFileDigests {
  config: string;
  key: string;
}

/**
 * What identifies an invitation: a digest of its original shared secret, so
 * the console keeps no secret past the run that used it.
 */
export function invitationIdOf(sharedSecret: string): string {
  return crypto.createHash("sha256").update(sharedSecret).digest("hex");
}

function digestOf(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Thrown when a webrtc run cannot write its files into the working folder:
 * `present` when an `alcove.yaml` or `.alcove.key` is already there,
 * `unwritable` when the folder refused the write. `heldByConsoleExchange` says
 * both files are there with the bytes an earlier exchange on this console
 * left. Nothing is left behind.
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

/** Whether either of the working folder's two exchange file names is taken,
 * by anything, a link included. */
export function workingFolderExchangeFilesPresent(dataRoot: string): boolean {
  const { configPath, keyPath } = workingFolderExchangeFilePaths(dataRoot);
  return jobPathPresent(configPath) || jobPathPresent(keyPath);
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
 * Write `documents` into the working folder as `alcove.yaml` and
 * `.alcove.key`, each owner-only and created only where nothing is at the
 * name, a link included. Where the key file cannot be created the
 * configuration just written is removed.
 *
 * @returns the digests of the bytes written.
 * @throws {WorkingFolderFilesRefusedError} when either name is taken or the
 *   folder cannot be written.
 */
export function createWorkingFolderExchangeFiles(
  dataRoot: string,
  documents: { config: string; key: string },
): ExchangeFileDigests {
  const target = workingFolderExchangeFilePaths(dataRoot);
  const config = Buffer.from(documents.config, "utf8");
  const key = Buffer.from(documents.key, "utf8");
  let configWritten = false;
  try {
    createOwnerOnly(target.configPath, config);
    configWritten = true;
    createOwnerOnly(target.keyPath, key);
  } catch (error) {
    if (configWritten) fs.rmSync(target.configPath, { force: true });
    throw new WorkingFolderFilesRefusedError(
      (error as NodeJS.ErrnoException).code === "EEXIST"
        ? "present"
        : "unwritable",
    );
  }
  return { config: digestOf(config), key: digestOf(key) };
}

/**
 * The working folder's pair on disk: each file's bytes where a regular
 * file within its size bound is at the name, read without following a link,
 * else undefined.
 */
export function readWorkingFolderExchangeFiles(dataRoot: string): {
  config: Buffer | undefined;
  key: Buffer | undefined;
} {
  const { configPath, keyPath } = workingFolderExchangeFilePaths(dataRoot);
  const config = readBoundedMountedBytes(
    configPath,
    MAX_CONFIGURATION_FILE_BYTES,
    { followLink: false },
  );
  const key = readBoundedMountedBytes(keyPath, MAX_MOUNTED_KEY_FILE_BYTES, {
    followLink: false,
  });
  return {
    config: config.outcome === "read" ? config.bytes : undefined,
    key: key.outcome === "read" ? key.bytes : undefined,
  };
}

/** The digests of the working folder's pair on disk, or undefined
 * unless both files are there ({@link readWorkingFolderExchangeFiles}). */
export function workingFolderExchangeFileDigests(
  dataRoot: string,
): ExchangeFileDigests | undefined {
  const files = readWorkingFolderExchangeFiles(dataRoot);
  return files.config !== undefined && files.key !== undefined
    ? { config: digestOf(files.config), key: digestOf(files.key) }
    : undefined;
}

/**
 * Whether the working folder's pair is the one `expected` describes: the
 * configuration's bytes match `expected.config`, and the key file's bytes
 * match `expected.key` or the file holds the original secret of the
 * invitation `invitation` identifies.
 */
export function workingFolderExchangeFilesMatch(
  dataRoot: string,
  expected: ExchangeFileDigests,
  invitation: string,
): boolean {
  const files = readWorkingFolderExchangeFiles(dataRoot);
  if (files.config === undefined || files.key === undefined) return false;
  if (digestOf(files.config) !== expected.config) return false;
  return (
    digestOf(files.key) === expected.key ||
    keyFileHoldsSecretOf(files.key, invitation)
  );
}

function keyFileHoldsSecretOf(key: Buffer, invitation: string): boolean {
  let parsed: unknown;
  try {
    parsed = parseSensitiveJson(key.toString("utf8"), "key file");
  } catch {
    return false;
  }
  const keyFile = KeyFileSchema.safeParse(parsed);
  return (
    keyFile.success && invitationIdOf(keyFile.data.sharedSecret) === invitation
  );
}

/**
 * Remove the working folder's pair only when both files still have exactly
 * the bytes `written` describes; anything else is left as it is.
 *
 * @returns whether the pair was removed.
 */
export function removeUnchangedWorkingFolderExchangeFiles(
  dataRoot: string,
  written: ExchangeFileDigests,
): boolean {
  const current = workingFolderExchangeFileDigests(dataRoot);
  if (
    current === undefined ||
    current.config !== written.config ||
    current.key !== written.key
  )
    return false;
  const { configPath, keyPath } = workingFolderExchangeFilePaths(dataRoot);
  fs.rmSync(keyPath, { force: true });
  fs.rmSync(configPath, { force: true });
  return true;
}
