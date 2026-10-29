/**
 * The account a container runs Alcove as on a Linux host. The image runs as
 * user 1000, so a mounted folder owned by anyone else refuses its first write;
 * the options below run it as the operator instead, which the recurring-run
 * hand-offs' Linux and macOS lines, the console's one-off working-folder
 * commands, and the accept kit use.
 */

/** The container engines the commands name. */
export type ContainerEngine = "docker" | "podman";

/** The account the published image runs as unless told otherwise. */
export const IMAGE_ACCOUNT_ID = 1000;

/**
 * The `--user` value naming the operator's own account, written for the
 * operator's POSIX shell to expand: it is shown as it stands, never quoted a
 * second time.
 */
export const OPERATOR_ACCOUNT_VALUE = '"$(id -u):$(id -g)"';

/** The `--user` flag with {@link OPERATOR_ACCOUNT_VALUE}, as prose shows it. */
export const OPERATOR_USER_FLAG = `--user ${OPERATOR_ACCOUNT_VALUE}`;

/** The rootless Podman flag that maps the operator onto the image's account. */
export const PODMAN_USER_NAMESPACE_FLAG = `--userns=keep-id:uid=${IMAGE_ACCOUNT_ID},gid=${IMAGE_ACCOUNT_ID}`;

/** The argv tokens that run a container under `engine` as the operator. */
export function operatorAccountOption(engine: ContainerEngine): Array<string> {
  return engine === "podman"
    ? [PODMAN_USER_NAMESPACE_FLAG]
    : ["--user", OPERATOR_ACCOUNT_VALUE];
}
