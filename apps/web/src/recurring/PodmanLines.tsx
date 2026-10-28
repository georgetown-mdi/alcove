import { CopyableCode } from "@components/CopyableCode";
import styles from "@styles/app.module.css";

import { PODMAN_USER_NAMESPACE_FLAG } from "@psi/containerAccount";

import type { ShownRunLines } from "./scheduledRunCommand";

/**
 * The command and cron line for rootless Podman, which maps the operator onto
 * the image's account with a user namespace where Docker takes `--user`. Shown
 * after the Docker lines; renders nothing where those lines are not shown.
 */
export function PodmanLines({
  lines,
}: {
  lines: Pick<ShownRunLines, "podmanRunCommand" | "podmanCronLine">;
}) {
  const { podmanRunCommand, podmanCronLine } = lines;
  if (podmanRunCommand === undefined || podmanCronLine === undefined)
    return null;
  return (
    <>
      <p className={styles.small}>
        With rootless Podman, use these in place of the Docker command and cron
        line above. They run Alcove as you with {PODMAN_USER_NAMESPACE_FLAG}:
      </p>
      <CopyableCode
        code={podmanRunCommand}
        ariaLabel="exchange command for rootless Podman"
      />
      <CopyableCode
        code={podmanCronLine}
        ariaLabel="cron schedule line for rootless Podman"
      />
    </>
  );
}
