// How this party puts an exchange file under its final name: written to a temp
// name and renamed into place, or, with `publishWithoutRename` on, written to
// the final name directly. docs/spec/FILE_SYNC.md, Publishing without rename.

import { PUBLISH_WITHOUT_RENAME_KEY } from "../config/connection";
import {
  TransportPublishIndeterminateError,
  UsageError,
  errorMessage,
  statesItsOwnNextStep,
} from "../errors";
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

// How a failed rename is quoted in the refusal, following "failed". "No such
// file" is SFTP status 2 (SSH_FX_NO_SUCH_FILE) or ENOENT from a local folder;
// any other failure is quoted by its own status or code and message.
function describeRenameFailure(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (code === 2 || code === "ENOENT") return 'with "no such file"';
  const message = errorMessage(err).replace(/\.+$/, "");
  if (typeof code === "number") return `with SFTP status ${code} (${message})`;
  if (typeof code === "string" && !message.includes(code))
    return `with ${code} (${message})`;
  return `(${message})`;
}

/**
 * Renames `tempPath`, which this party has just written, to `finalPath`. A
 * terminal failure the server or folder answered with a status or error code
 * is rethrown as an error quoting it, naming the possible cause, a server that
 * does not allow renames, and ending on `guidance`. Every other failure (an
 * undetermined publish, one that already states its own next step, a dropped
 * session, a refused host key on re-dial) is rethrown as itself.
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
    const code = (err as { code?: unknown } | null | undefined)?.code;
    if (
      err instanceof TransportPublishIndeterminateError ||
      err instanceof UsageError ||
      statesItsOwnNextStep(err) ||
      (typeof code !== "number" && typeof code !== "string")
    )
      throw err;
    throw new Error(
      `${redactPrivateKeyMaterial(finalName)} could not be published: ` +
        "renaming the temporary file this party had just written failed " +
        `${describeRenameFailure(err)}. The server may not allow renames. ` +
        (guidance ?? DEFAULT_RENAME_REFUSED_GUIDANCE),
      { cause: err },
    );
  }
}
