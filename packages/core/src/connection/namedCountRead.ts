// The capped read of a file-sync file whose name states its byte count: a
// hello, a message, or an abort marker (docs/spec/FILE_SYNC.md, the byte-count
// invariant).

import { FrameSizeExceededError } from "../errors";
import type { FileTransportClient } from "./fileSyncConnection";

/**
 * The refusal text for a file read past the byte count its name states.
 * `file` names the file and its directory.
 *
 * @internal
 */
export const largerThanNamedCountMessage = (
  file: string,
  byteCount: number,
): string =>
  `${file} is larger than the ${byteCount} byte(s) its name states, so it is ` +
  "not the file your partner finished writing. The run stops; inspect the " +
  "directory before retrying.";

/**
 * Reads `path` up to `byteCount`, the count its name states. The adapters
 * refuse a longer body with a {@link FrameSizeExceededError} whose text names
 * the static frame bound, so that refusal is replaced by `largerThanName()`.
 * The caller refuses a count of 0 before calling: no adapter accepts a cap of 0.
 *
 * @internal
 */
export async function getUpToNamedCount(
  client: FileTransportClient,
  path: string,
  byteCount: number,
  encoding: null | string,
  largerThanName: () => Error,
): Promise<Buffer<ArrayBufferLike>> {
  try {
    return await client.get(path, { encoding, maxBytes: byteCount });
  } catch (err) {
    if (err instanceof FrameSizeExceededError) throw largerThanName();
    throw err;
  }
}
