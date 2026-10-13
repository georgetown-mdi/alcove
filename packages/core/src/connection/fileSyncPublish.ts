// How this party puts an exchange file under its final name: written to a temp
// name and renamed into place, or, with `publishWithoutRename` on, written to
// the final name directly. docs/spec/FILE_SYNC.md, Publishing without rename.

import { PUBLISH_WITHOUT_RENAME_KEY } from "../config/connection";
import { TransportPublishIndeterminateError } from "../errors";
import { redactPrivateKeyMaterial } from "../utils/sanitizeErrorForDisplay";
import type { FileTransportClient } from "./fileSyncConnection";

/**
 * The sentence a refused rename ends on when the caller supplies none: the
 * remedy, naming the configuration key. It follows "The server may not allow
 * renames."
 */
export const DEFAULT_RENAME_REFUSED_GUIDANCE =
  `If it does not, set ${PUBLISH_WITHOUT_RENAME_KEY}: true in the ` +
  "connection options and run again.";

// A server that refuses renames answers with "no such file": SFTP status 2
// (SSH_FX_NO_SUCH_FILE), or ENOENT from a local folder. A source that really
// vanished gets the same answer, so the message built from it hedges.
function isNoSuchFileError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === 2 || code === "ENOENT";
}

/**
 * Renames `tempPath`, which this party has just written, to `finalPath`. A
 * "no such file" answer is rethrown as an error naming the likely cause, a
 * server that does not allow renames, and ending on `guidance`.
 *
 * @internal
 */
export async function renameOwnTemp(
  client: FileTransportClient,
  tempPath: string,
  finalPath: string,
  finalName: string,
  guidance: string | undefined,
): Promise<void> {
  try {
    await client.rename(tempPath, finalPath);
  } catch (err: unknown) {
    if (
      err instanceof TransportPublishIndeterminateError ||
      !isNoSuchFileError(err)
    )
      throw err;
    throw new Error(
      `${redactPrivateKeyMaterial(finalName)} could not be published: ` +
        "renaming the temporary file this party had just written failed " +
        'with "no such file". The server may not allow renames. ' +
        (guidance ?? DEFAULT_RENAME_REFUSED_GUIDANCE),
      { cause: err },
    );
  }
}
