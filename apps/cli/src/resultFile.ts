import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  getLogger,
  keepOperatorSuppliedText,
  messageWithOperatorText,
  operatorSuppliedText,
  redactAndRenderOperatorSuppliedText,
  UsageError,
} from "@alcove/core";

import { recordFileStamp } from "@alcove/core";

/** Basename stem of the result file a run names itself. */
export const DEFAULT_RESULT_BASENAME = "alcove-results";

/**
 * The folder a run writes its files in: the `OUTPUT` folder it was given, or
 * the working directory when the result goes to stdout
 * (docs/spec/EXCHANGE_RECORD.md, Where a run's files go).
 */
export function runArtifactFolder(output: string | undefined): string {
  return output ?? ".";
}

/**
 * The file a run writes its result to: a new `alcove-results-<time>.csv` in
 * the `OUTPUT` folder, `<time>` being the stamp the run's record name has
 * ({@link recordFileStamp}), so the result pairs with its record by name
 * (docs/spec/EXCHANGE_RECORD.md, Result file name).
 */
export function resultFilePath(folder: string, createdAt: string): string {
  return path.join(
    folder,
    `${DEFAULT_RESULT_BASENAME}-${recordFileStamp(createdAt)}.csv`,
  );
}

/**
 * The path `filePath` names, with every directory on the way resolved through
 * the filesystem (symlinks, and on Windows the name's case), so two spellings
 * of one place compare equal. The part of the path that does not exist yet is
 * kept as written.
 */
function canonicalPath(filePath: string): string {
  const absolute = path.resolve(filePath);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(canonicalPath(parent), path.basename(absolute));
  }
}

function isSameOrInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/**
 * The warnings a file-drop run gets for each of its own files placed inside a
 * folder the channel shares (`path`, `inbound_path` or `outbound_path`): the
 * output folder, or the working directory when the run writes its record
 * there, and the key file. Empty on any other channel or placement.
 */
export function runFilesInSharedFolderWarnings(params: {
  connection: {
    channel: string;
    path?: string;
    inboundPath?: string;
    outboundPath?: string;
  };
  output: string | undefined;
  writeRecord: boolean;
  keyFilePath: string | undefined;
}): string[] {
  const { connection, output, writeRecord, keyFilePath } = params;
  if (connection.channel !== "filedrop") return [];
  const shared = [
    connection.path,
    connection.inboundPath,
    connection.outboundPath,
  ].filter((folder): folder is string => folder !== undefined);
  const sharedFolderHolding = (filePath: string): string | undefined => {
    const canonical = canonicalPath(filePath);
    return shared.find((folder) =>
      isSameOrInside(canonical, canonicalPath(folder)),
    );
  };
  const shown = (text: string): string =>
    redactAndRenderOperatorSuppliedText(operatorSuppliedText(text));
  const warnings: string[] = [];
  const runFolderShared =
    output !== undefined || writeRecord
      ? sharedFolderHolding(runArtifactFolder(output))
      : undefined;
  if (runFolderShared !== undefined)
    warnings.push(
      output !== undefined
        ? `the output folder ${shown(output)} is inside the shared folder ` +
            `${shown(runFolderShared)}, so anyone who can read that folder, ` +
            "your partner included, can read the result, the exchange " +
            "record and its keys. Name an output folder outside it."
        : `the working directory is inside the shared folder ` +
            `${shown(runFolderShared)}, so anyone who can read that folder, ` +
            "your partner included, can read the exchange record and its " +
            "keys written there. Run from a folder outside it, or name an " +
            "output folder outside it.",
    );
  const keyFileShared =
    keyFilePath !== undefined ? sharedFolderHolding(keyFilePath) : undefined;
  if (keyFilePath !== undefined && keyFileShared !== undefined)
    warnings.push(
      `the key file ${shown(keyFilePath)} is inside the shared folder ` +
        `${shown(keyFileShared)}, so anyone who can read that folder, your ` +
        "partner included, can read the shared secret it holds. Move it " +
        "outside the folder and pass its new path with --key-file.",
    );
  return warnings;
}

function outputFolderError(
  output: string,
  problem: string,
  remedy: string,
): UsageError {
  const message = messageWithOperatorText`the output folder ${operatorSuppliedText(
    output,
  )} ${problem}. ${remedy} Nothing was sent to your partner.`;
  return keepOperatorSuppliedText(new UsageError(message.text), message);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Make sure the run can write its files in `output` before the partner is
 * contacted: a missing folder is created (recursively, and left in place if
 * the run fails afterwards), and the folder is then shown writable by creating
 * and removing a probe file in it. Throws a {@link UsageError} (exit 64) when
 * `output` names something other than a folder, or the folder cannot be
 * checked, created or written.
 */
export function preflightOutputFolder(
  output: string,
  log: ReturnType<typeof getLogger>,
): void {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(output);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT")
      throw outputFolderError(
        output,
        `cannot be checked: ${errorText(err)}`,
        "Make the folder reachable, or name another folder as the output.",
      );
  }
  if (stat === undefined) {
    try {
      fs.mkdirSync(output, { recursive: true });
    } catch (err) {
      throw outputFolderError(
        output,
        `cannot be created: ${errorText(err)}`,
        "Create the folder, or name an existing writable folder as the output.",
      );
    }
    log.info(
      `created the output folder ${redactAndRenderOperatorSuppliedText(
        operatorSuppliedText(output),
      )} (left in place if the exchange fails)`,
    );
  } else if (!stat.isDirectory())
    throw outputFolderError(
      output,
      "is a file, not a folder",
      "The output argument names the folder the run writes its result, " +
        "record and receipt in: name a folder (for example ./).",
    );
  const probe = path.join(
    output,
    `.alcove-write-probe-${process.pid}-${crypto.randomUUID().slice(0, 8)}`,
  );
  let fd: number;
  try {
    fd = fs.openSync(
      probe,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    );
  } catch (err) {
    throw notWritable(output, err);
  }
  let writeError: unknown;
  try {
    fs.closeSync(fd);
  } catch (err) {
    writeError = err;
  }
  try {
    fs.rmSync(probe, { force: true });
  } catch (err) {
    const removal = `the check could not remove its probe file ${probe}: ${errorText(err)}`;
    throw outputFolderError(
      output,
      writeError === undefined
        ? `was checked for write access, but ${removal}`
        : `is not writable: ${errorText(writeError)}, and ${removal}`,
      `The probe file was left behind and can be deleted. Make sure the ` +
        `run's user can delete files in the folder, or name another folder ` +
        `as the output.`,
    );
  }
  if (writeError !== undefined) throw notWritable(output, writeError);
}

function notWritable(output: string, err: unknown): UsageError {
  return outputFolderError(
    output,
    `is not writable: ${errorText(err)}`,
    "Restore write access to it -- in a container, the folder's owner as " +
      "well as its permissions -- or name another folder as the output.",
  );
}
