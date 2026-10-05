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

import { recordFileStamp } from "./recordFile";

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
    throw outputFolderError(
      output,
      `is not writable: ${errorText(err)}`,
      "Restore write access to it -- in a container, the folder's owner as " +
        "well as its permissions -- or name another folder as the output.",
    );
  }
  fs.closeSync(fd);
  fs.rmSync(probe, { force: true });
}
