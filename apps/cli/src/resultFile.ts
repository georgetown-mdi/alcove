import fs from "node:fs";
import path from "node:path";

import { recordFileStamp } from "./recordFile";

/** Basename stem of a result file a run names itself. */
export const DEFAULT_RESULT_BASENAME = "alcove-results";

/**
 * Whether an `OUTPUT_FILE` path names a folder rather than a file: it ends in a
 * path separator, or it is an existing directory (a symbolic link to one
 * included).
 */
export function outputNamesFolder(output: string): boolean {
  if (output.endsWith("/") || output.endsWith(path.sep)) return true;
  try {
    return fs.statSync(output).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The file a run writes its result to. A path naming a file is used as given,
 * so each run overwrites it. A path naming a folder gets a new
 * `alcove-results-<stamp>.csv` in that folder, `<stamp>` being the one the
 * run's record name has ({@link recordFileStamp}), so the result pairs with
 * its record by name (docs/spec/EXCHANGE_RECORD.md, Result file name).
 */
export function resultFilePath(output: string, createdAt: string): string {
  if (!outputNamesFolder(output)) return output;
  return path.join(
    output,
    `${DEFAULT_RESULT_BASENAME}-${recordFileStamp(createdAt)}.csv`,
  );
}
