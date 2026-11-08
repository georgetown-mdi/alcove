/**
 * The directory rules of a file-sync channel (`sftp`, `filedrop`), shared by
 * the connection block (connection.ts) and the invitation endpoint
 * (invitation.ts). A directory is named either as one shared `path` or as the
 * split `inboundPath`/`outboundPath` pair. Each predicate takes `undefined`,
 * the projection of a channel with no directory, as satisfying it. Each site
 * states its own refusal message and issue order.
 */

import { pathsResolveToSameDir } from "../utils/pathCompare.js";

/** The directory fields of a file-sync connection or endpoint. */
export interface FileSyncDirectories {
  path?: string;
  inboundPath?: string;
  outboundPath?: string;
}

/**
 * The directory fields `holder` states for `channel`, or `undefined` for a
 * channel other than `sftp` and `filedrop`.
 */
export function fileSyncDirectories(
  channel: string,
  holder: FileSyncDirectories,
): FileSyncDirectories | undefined {
  if (channel !== "sftp" && channel !== "filedrop") return undefined;
  return {
    path: holder.path,
    inboundPath: holder.inboundPath,
    outboundPath: holder.outboundPath,
  };
}

/** Whether both halves of the split pair are set. */
export function namesSplitDirectories(
  dirs: FileSyncDirectories | undefined,
): boolean {
  return dirs?.inboundPath !== undefined && dirs.outboundPath !== undefined;
}

/** Whether the split pair is whole or absent: never one half alone. */
export function splitDirectoriesAreWhole(
  dirs: FileSyncDirectories | undefined,
): boolean {
  if (dirs === undefined) return true;
  return (dirs.inboundPath !== undefined) === (dirs.outboundPath !== undefined);
}

/**
 * Whether the split pair, where whole, names two directories: paths that
 * resolve to one directory ({@link pathsResolveToSameDir}, the rule each
 * channel's open applies) are one.
 */
export function splitDirectoriesDiffer(
  dirs: FileSyncDirectories | undefined,
): boolean {
  if (
    dirs === undefined ||
    dirs.inboundPath === undefined ||
    dirs.outboundPath === undefined
  )
    return true;
  return !pathsResolveToSameDir(dirs.inboundPath, dirs.outboundPath);
}

/** Whether at most one form is used: `path`, or either half of the pair. */
export function directoryFormsAreExclusive(
  dirs: FileSyncDirectories | undefined,
): boolean {
  if (dirs === undefined) return true;
  const hasPair =
    dirs.inboundPath !== undefined || dirs.outboundPath !== undefined;
  return !(dirs.path !== undefined && hasPair);
}

/**
 * Whether a `filedrop` channel names a directory in one form or the other.
 * Every other channel satisfies it: `sftp` may leave all three unset (the SFTP
 * login-home shared directory).
 */
export function filedropNamesDirectory(
  channel: string,
  dirs: FileSyncDirectories | undefined,
): boolean {
  if (channel !== "filedrop") return true;
  return dirs?.path !== undefined || namesSplitDirectories(dirs);
}
