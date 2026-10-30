import { CopyableCode } from "@components/CopyableCode";
import styles from "@styles/app.module.css";

import { PASTED_TEXT_ESCAPING_NOTE } from "@recurring/scheduledRunCommand";
import { PODMAN_USER_NAMESPACE_FLAG } from "@psi/containerAccount";
import { RunCommandLines } from "@recurring/RunCommandLines";

import type { WorkingFolderCommandLines as Lines } from "@psi/dockerRunCommand";

/**
 * A one-off command over the working folder, for each shell: the Docker
 * command for Linux and macOS and the PowerShell one for Windows
 * ({@link RunCommandLines}), then the rootless Podman one.
 */
export function WorkingFolderCommandLines({
  command,
  ariaLabel,
}: {
  command: Lines;
  ariaLabel: string;
}) {
  return (
    <div>
      <RunCommandLines lines={command} ariaLabel={ariaLabel} />
      <p className={styles.small}>
        The Linux and macOS command runs as your own account, as{" "}
        <code>start-alcove.sh</code> runs the console. If the console runs as
        the account built into the image (started with <code>docker run</code>{" "}
        and no <code>--user</code>, or with <code>start-alcove.sh</code> from a
        root login), leave out <code>--user</code> so this command writes files
        as the console does.
      </p>
      <p className={styles.small}>
        With rootless Podman, use this in place of the Linux/macOS command. It
        runs Alcove as you with {PODMAN_USER_NAMESPACE_FLAG}:
      </p>
      <CopyableCode
        code={command.podmanRunCommand}
        ariaLabel={`${ariaLabel} for rootless Podman`}
      />
      <p className={styles.small}>{PASTED_TEXT_ESCAPING_NOTE}</p>
    </div>
  );
}
