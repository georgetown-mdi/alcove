import { CopyableCode } from "@components/CopyableCode";
import styles from "@styles/app.module.css";

import {
  EXCHANGE_FOLDER_PLACEHOLDER,
  INSTALLED_ALCOVE_PLACEHOLDER,
} from "./scheduledRunCommand";

import type { ScheduledRunLines } from "./managedCronExportModel";

/**
 * The schedule lines of a managed exchange's command-line export: the image's
 * cron and Task Scheduler lines where every path can be mounted, the cron line
 * for an installed Alcove, and what to set and check in them. The caller
 * renders it only where the installed line is shown, since every other line is
 * withheld with it.
 */
export function ScheduledRunLinesView({
  lines,
  installedCronLine,
}: {
  lines: ScheduledRunLines;
  installedCronLine: string;
}) {
  const dockerShown = lines.dockerCronLine !== undefined;
  return (
    <>
      {lines.dockerCronLine !== undefined && (
        <>
          <p className={styles.small}>
            cron (Linux/macOS), {lines.schedule}, running Alcove from its Docker
            image:
          </p>
          <CopyableCode
            code={lines.dockerCronLine}
            ariaLabel="cron schedule line"
          />
        </>
      )}
      {lines.dockerTaskSchedulerLine !== undefined && (
        <>
          <p className={styles.small}>
            Windows Task Scheduler, {lines.schedule}, running Alcove from its
            Docker image:
          </p>
          <CopyableCode
            code={lines.dockerTaskSchedulerLine}
            ariaLabel="Windows Task Scheduler command"
          />
        </>
      )}
      <p className={styles.small}>
        {dockerShown
          ? "If Alcove is installed on the scheduling machine rather than run " +
            "from its image, cron runs it from the exchange folder:"
          : `cron (Linux/macOS), ${lines.schedule}, running an installed ` +
            "Alcove from the exchange folder:"}
      </p>
      <CopyableCode
        code={installedCronLine}
        ariaLabel="cron schedule line for an installed Alcove"
      />
      <p className={styles.small}>
        Set {EXCHANGE_FOLDER_PLACEHOLDER} to the folder you saved the files in,
        and {INSTALLED_ALCOVE_PLACEHOLDER} to where Alcove is installed. Each
        run adds to exchange.log in that folder.
        {dockerShown &&
          " A scheduled job does not use your shell's PATH, so check that " +
            "/usr/bin/docker is where Docker is installed (command -v docker)."}
      </p>
      {lines.scheduleNote !== undefined && (
        <p className={styles.small}>{lines.scheduleNote}</p>
      )}
      {lines.bindPathsCaveat !== undefined && (
        <p className={styles.small}>{lines.bindPathsCaveat}</p>
      )}
    </>
  );
}
