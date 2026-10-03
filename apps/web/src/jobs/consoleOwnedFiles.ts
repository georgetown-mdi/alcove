import fs from "node:fs";
import path from "node:path";

import {
  JOB_FILE_NAMES,
  PREVIOUS_CONFIGURATION_FILE_NAME,
} from "./intentSchemas";
import { SIGNING_CERTIFICATE_FILE_NAME } from "./signingIdentity";
import { isValidJobId } from "./workdir";

/** The names the console writes into the working folder itself, none of them
 * an input: the configuration, the copy kept by saving it back, and the
 * exported signing certificate. */
export const CONSOLE_WRITTEN_NAMES: ReadonlySet<string> = new Set([
  JOB_FILE_NAMES.config,
  PREVIOUS_CONFIGURATION_FILE_NAME,
  SIGNING_CERTIFICATE_FILE_NAME,
]);

/** Whether `name`, a top-level entry of the working folder, belongs to the
 * console: a name it writes, the exchange's key file, or a job working
 * directory. */
export function isConsoleOwnedFolderName(name: string): boolean {
  return (
    CONSOLE_WRITTEN_NAMES.has(name) ||
    name === JOB_FILE_NAMES.key ||
    isValidJobId(name)
  );
}

/** Whether the file a credential locator resolved to is console-owned: its
 * first path segment under the working folder, taken from the locator and
 * from the resolved realpath (so a symlink to one is caught), is a
 * console-owned name. */
export function isConsoleOwnedFolderPath(
  folderRoot: string,
  subPath: Array<string>,
  resolvedPath: string,
): boolean {
  if (subPath.length > 0 && isConsoleOwnedFolderName(subPath[0])) return true;
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(path.resolve(folderRoot));
  } catch {
    return false;
  }
  const first = path.relative(realRoot, resolvedPath).split(path.sep)[0];
  return isConsoleOwnedFolderName(first);
}
