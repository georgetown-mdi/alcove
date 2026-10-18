/**
 * The `alcove.yaml` and `.alcove.key` of a console webrtc exchange. The
 * console writes both into the working folder when the run starts, as
 * `alcove invite` writes them for an exchange `alcove exchange` runs later,
 * and the CLI rotates the key and records the partner's pin in them in place,
 * so the same folder runs the exchange again from the command line.
 */

import crypto from "node:crypto";
import fs from "node:fs";

import { z } from "zod";

import {
  AllowedRelaySchema,
  KeyFileSchema,
  editSensitiveYamlDocument,
  parseSensitiveJson,
  parseSensitiveYaml,
} from "@alcove/core";

import { JOB_FILE_NAMES } from "@jobContract/intentSchemas";

import { JOB_FILE_MODE, jobPathPresent, resolveWorkdirFile } from "./workdir";
import { MAX_CONFIGURATION_FILE_BYTES } from "./configLoad";
import { MAX_MOUNTED_KEY_FILE_BYTES } from "./mountedKeyFile";
import { readBoundedMountedBytes } from "./boundedMountedFile";
import { writeReplacing } from "./configHandBack";

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

/** Remove `filePath` if present, leaving the caller's own error the one
 * reported. */
function removeQuietly(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // The failure that led here is the one the caller reports.
  }
}

/** Create `filePath` owner-only, failing when anything is at the name. A file
 * this call created is removed when its write fails. */
function createOwnerOnly(filePath: string, content: Buffer): void {
  const fd = fs.openSync(filePath, "wx", JOB_FILE_MODE);
  try {
    try {
      fs.writeFileSync(fd, content);
      fs.fchmodSync(fd, JOB_FILE_MODE);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    removeQuietly(filePath);
    throw error;
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
    if (configWritten) removeQuietly(target.configPath);
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
  const key = readBoundedMountedBytes(keyPath, MAX_MOUNTED_KEY_FILE_BYTES, {
    followLink: false,
  });
  return {
    config: readConfigBytes(configPath),
    key: key.outcome === "read" ? key.bytes : undefined,
  };
}

function readConfigBytes(configPath: string): Buffer | undefined {
  const config = readBoundedMountedBytes(
    configPath,
    MAX_CONFIGURATION_FILE_BYTES,
    { followLink: false },
  );
  return config.outcome === "read" ? config.bytes : undefined;
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

const ALLOWED_RELAYS_PATH = ["connection", "allowed_relays"];

const CONFIGURATION_LABEL = "the working folder's exchange configuration";

const StatedAllowedRelaysSchema = z.array(AllowedRelaySchema).optional();

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `connection.allowed_relays` a configuration's bytes state, each entry
 * normalized by core's rule, or undefined where they state none. Null where
 * the bytes are not a YAML mapping with a `connection` mapping, or the key
 * holds anything but a list of entries.
 */
function statedAllowedRelays(config: Buffer): Array<string> | undefined | null {
  let parsed: unknown;
  try {
    parsed = parseSensitiveYaml(config.toString("utf8"), CONFIGURATION_LABEL);
  } catch {
    return null;
  }
  if (!isMapping(parsed) || !isMapping(parsed.connection)) return null;
  const stated = StatedAllowedRelaysSchema.safeParse(
    parsed.connection.allowed_relays,
  );
  return stated.success ? stated.data : null;
}

function sameAllowedRelays(
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/**
 * Set the working folder's `alcove.yaml`, whose bytes have the digest
 * `expectedConfig`, to state `allowedRelays` as its
 * `connection.allowed_relays`, removing the key where that is undefined. A
 * file already stating that list is left as it is. Every other line keeps
 * its bytes where the YAML writer allows, and the file is replaced by a new
 * owner-only file renamed over its name, so a link put there is replaced
 * rather than written through.
 *
 * @returns the digest of the bytes written, or undefined where nothing was.
 * @throws {WorkingFolderFilesRefusedError} `present` where the file's bytes
 *   are not those, `unwritable` where it is no configuration this can edit
 *   or cannot be replaced.
 */
export function setWorkingFolderAllowedRelays(
  dataRoot: string,
  expectedConfig: string,
  allowedRelays: ReadonlyArray<string> | undefined,
): string | undefined {
  const { configPath } = workingFolderExchangeFilePaths(dataRoot);
  const config = readConfigBytes(configPath);
  if (config === undefined || digestOf(config) !== expectedConfig)
    throw new WorkingFolderFilesRefusedError("present");
  const stated = statedAllowedRelays(config);
  if (stated !== null && sameAllowedRelays(stated, allowedRelays))
    return undefined;
  let edited: Buffer;
  try {
    edited = Buffer.from(
      editSensitiveYamlDocument(
        config.toString("utf8"),
        CONFIGURATION_LABEL,
        (doc) => {
          if (allowedRelays === undefined) doc.deleteIn(ALLOWED_RELAYS_PATH);
          else doc.setIn(ALLOWED_RELAYS_PATH, [...allowedRelays]);
        },
      ),
      "utf8",
    );
    writeReplacing(configPath, edited, JOB_FILE_MODE);
  } catch {
    throw new WorkingFolderFilesRefusedError("unwritable");
  }
  return digestOf(edited);
}
