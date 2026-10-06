import type { AcceptKitEndpoint } from "@exchange/acceptKit";
import type { FileDropEndpoint } from "@alcove/core";
import type { JobRendezvousConfig } from "@psi/jobClient/workInputClient";

/**
 * The pure model behind the console's filedrop rendezvous: what an invitation minted
 * on this console says about where the two parties meet, and why the console's
 * mounts and the exchange's file-handling choices can disagree. No React, no I/O --
 * the tested boundary for "the code points where the console will actually
 * rendezvous".
 *
 * Unlike the SFTP connection, the operator authors no directory here: the mounts are
 * the console's own provisioning ({@link JobRendezvousConfig}), so a split filedrop
 * is a fact about the machine rather than a form the operator fills. What is still
 * the operator's, and so still able to disagree with it, is the retain-mode choice a
 * split rendezvous requires.
 */

/**
 * The invitation endpoint for this console's rendezvous: the advisory locator the
 * console minted names for, in whichever form the console is provisioned -- the
 * single shared folder, or the split pair. Undefined when the console names no
 * locator, which is the state that withholds the filedrop card entirely.
 *
 * The pair is kept as THIS party authored it, not mirrored: a
 * {@link FileDropEndpoint}'s pair is defined from the inviter's side, and the
 * mirror swap belongs to the single consumer that builds a connection from an
 * endpoint. Never the absolute mount path: the console's own paths mean nothing
 * on the partner's machine, and the route that reports the provisioning does not
 * send them to the browser at all.
 */
export function filedropEndpointForRendezvous(
  rendezvous: JobRendezvousConfig | undefined,
): FileDropEndpoint | undefined {
  if (rendezvous?.configured !== true || rendezvous.locator === undefined)
    return undefined;
  if (rendezvous.split !== true)
    return { channel: "filedrop", path: rendezvous.locator };
  if (rendezvous.outboundLocator === undefined) return undefined;
  return {
    channel: "filedrop",
    inboundPath: rendezvous.locator,
    outboundPath: rendezvous.outboundLocator,
  };
}

/**
 * The same rendezvous as the partner's accept kit prints it back: folder NAMES only,
 * and only where the console has a name to print. The sheet is the one place that
 * CALLS a locator the shared folder's name, so where the locator is the mount point a
 * launcher bound the folder at, the sheet says nothing rather than asking the partner
 * to match a name that is not the folder's.
 *
 * On a split console the sheet needs both names or neither: a sheet naming one
 * folder of a two-folder rendezvous would look as though the other did not exist.
 */
export function acceptKitEndpointForRendezvous(
  rendezvous: JobRendezvousConfig | undefined,
): AcceptKitEndpoint | undefined {
  if (rendezvous?.configured !== true) return undefined;
  if (rendezvous.split !== true)
    return {
      channel: "filedrop",
      ...(rendezvous.folderName === undefined
        ? {}
        : { path: rendezvous.folderName }),
    };
  const { folderName, outboundFolderName } = rendezvous;
  return {
    channel: "filedrop",
    split: true,
    ...(folderName !== undefined && outboundFolderName !== undefined
      ? { inboundPath: folderName, outboundPath: outboundFolderName }
      : {}),
  };
}

/**
 * What the console says when a split rendezvous meets an exchange that is not in
 * retain mode. The console's own words for the rule core states on the composed
 * connection (a separate outbound directory requires `retain_files`) and the CLI
 * fast-fails on `--outbound-path`, named on the control the operator turns on rather
 * than on the config field.
 *
 * It offers no "clear the outbound directory" alternative, unlike its SFTP
 * counterpart: the two mounts are the console's provisioning, not a form field
 * the operator can empty, so retain mode is the only way out of this disagreement.
 */
export const SPLIT_RENDEZVOUS_RETAIN_REQUIREMENT =
  "This console uses separate inbound and outbound folders, " +
  "which need retain mode: nothing is deleted after it is read, so each folder " +
  'keeps what is written into it. Turn on "Keep every exchange file" under "How ' +
  'files are handled" to run a shared-folder exchange here.';

/**
 * Why this console's rendezvous cannot be used with the exchange's file-handling
 * choices as they stand -- a split rendezvous needs retain mode -- or undefined when
 * the two agree.
 *
 * The mounts and the retain choice are decided in different places and change
 * independently, so the precondition is re-asked wherever the two are known together:
 * at both Create gates, ahead of the invitation mint, and at the acceptor's launch.
 * Without that, retain mode left off reaches the run as a refused job, and on the
 * invite path only after a partner-facing accept kit was already minted for a
 * rendezvous the run will not conduct.
 */
export function splitRendezvousRetainProblem(
  rendezvous: JobRendezvousConfig | undefined,
  retainFiles: boolean,
): string | undefined {
  if (rendezvous?.split !== true || retainFiles) return undefined;
  return SPLIT_RENDEZVOUS_RETAIN_REQUIREMENT;
}

/**
 * What the console says where the operator picks the shared-directory transport on
 * a console whose rendezvous holds its own working folder -- the single-mount
 * layout. The partner's sync tool keeps that whole folder in step, so the notice
 * names what leaves this machine and how to give the shared folder a mount of its
 * own. Warn and guide: the run is the operator's to start either way.
 */
export const SHARED_FOLDER_EXPOSURE_NOTICE =
  "This console's shared folder is the folder holding your files. Whoever " +
  "syncs it gets your input, configuration and results. Give the shared " +
  "folder its own mount: add these lines to your docker run command, before " +
  "the image name, and restart the console.";

/** The mount point {@link SHARED_FOLDER_MOUNT_FLAGS} binds the shared folder at:
 * outside the single-mount layout's own mount, so the two do not nest. */
const SHARED_FOLDER_MOUNT_POINT = "/shared";

/** The placeholder name {@link SHARED_FOLDER_MOUNT_FLAGS} gives the shared folder,
 * which {@link SHARED_FOLDER_MOUNT_HINT} tells the operator to replace. */
const SHARED_FOLDER_PLACEHOLDER = "shared-folder";

/**
 * The docker flags that give the shared folder its own mount, each line ending in
 * a shell continuation so the block drops in above the image name of a
 * multi-line `docker run`. The folder's name is set explicitly because the mount
 * point is named for the container's layout, and without the name an invitation
 * would hand the partner the mount point's.
 */
export const SHARED_FOLDER_MOUNT_FLAGS = [
  `--env JOB_RENDEZVOUS_DIR=${SHARED_FOLDER_MOUNT_POINT}`,
  `--env JOB_RENDEZVOUS_NAME=${SHARED_FOLDER_PLACEHOLDER}`,
  `-v "/path/to/${SHARED_FOLDER_PLACEHOLDER}":${SHARED_FOLDER_MOUNT_POINT}`,
]
  .map((line) => `${line} \\`)
  .join("\n");

/** The line under {@link SHARED_FOLDER_MOUNT_FLAGS} saying what to replace in it. */
export const SHARED_FOLDER_MOUNT_HINT =
  `Replace ${SHARED_FOLDER_PLACEHOLDER} with the name you and your partner ` +
  "know the folder by, and the path with where that folder is on this machine.";

/** The shared-folder notice's facts, or undefined where it is not raised. */
interface SharedFolderExposure {
  /** The name this console gives the shared folder -- what an invitation from
   * it hands the partner -- when it has one. */
  folderName?: string;
}

/**
 * Whether the shared-folder notice is raised for this console's rendezvous, and
 * the folder name it states. Raised where the report says a rendezvous leg holds
 * the working folder, the uncertain verdict included: the report's own fail-safe
 * direction, since what could not be ruled out is what the notice is about.
 */
export function sharedFolderExposure(
  rendezvous: JobRendezvousConfig | undefined,
): SharedFolderExposure | undefined {
  if (rendezvous?.configured !== true || rendezvous.sharesDataRoot !== true)
    return undefined;
  return rendezvous.folderName === undefined
    ? {}
    : { folderName: rendezvous.folderName };
}
