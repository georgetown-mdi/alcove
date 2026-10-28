import { CopyableCode } from "@components/CopyableCode";
import styles from "@styles/app.module.css";

import type { ShownRunLines } from "./scheduledRunCommand";

/**
 * The command that runs an exchange once, shown for each operating system
 * where it differs: the Docker command for Linux and macOS, which runs as the
 * operator's own account, and the one for Windows in PowerShell, which takes
 * no account option. Where the image command is not shown, the one command
 * for an installed `alcove` reads the same in every shell.
 */
export function RunCommandLines({
  lines,
  ariaLabel,
}: {
  lines: Pick<ShownRunLines, "runCommand" | "windowsRunCommand">;
  ariaLabel: string;
}) {
  const { runCommand, windowsRunCommand } = lines;
  if (windowsRunCommand === undefined)
    return <CopyableCode code={runCommand} ariaLabel={ariaLabel} />;
  return (
    <>
      <p className={styles.small}>
        Linux/macOS, running Alcove from its Docker image:
      </p>
      <CopyableCode code={runCommand} ariaLabel={ariaLabel} />
      <p className={styles.small}>
        Windows (in PowerShell), running Alcove from its Docker image:
      </p>
      <CopyableCode
        code={windowsRunCommand}
        ariaLabel={`${ariaLabel} for Windows`}
      />
    </>
  );
}
