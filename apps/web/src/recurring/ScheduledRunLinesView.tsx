import { CopyableCode } from "@components/CopyableCode";
import styles from "@styles/app.module.css";

import {
  CRONTAB_ACCOUNT_NOTE,
  CRON_PERCENT_NOTE,
  EXCHANGE_FOLDER_PLACEHOLDER,
  FOLDER_OWNED_BY_IMAGE_ACCOUNT_NOTE,
  INSTALLED_ALCOVE_PLACEHOLDER,
  PASTED_TEXT_ESCAPING_NOTE,
} from "./scheduledRunCommand";
import { PodmanLines } from "./PodmanLines";

import type { ShownScheduledRunLines } from "./managedCronExportModel";

/**
 * The schedule lines of a managed exchange's command-line export: the image's
 * cron and Task Scheduler lines where every path can be mounted, the cron line
 * for an installed Alcove, and what to set and check in them.
 */
export function ScheduledRunLinesView({
  lines,
}: {
  lines: ShownScheduledRunLines;
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
            Windows Task Scheduler (in PowerShell), {lines.schedule}, running
            Alcove from its Docker image:
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
        code={lines.installedCronLine}
        ariaLabel="cron schedule line for an installed Alcove"
      />
      <p className={styles.small}>
        Set {EXCHANGE_FOLDER_PLACEHOLDER} to the folder you saved the files in,
        and {INSTALLED_ALCOVE_PLACEHOLDER} to where Alcove is installed. Each
        run adds to exchange.log in that folder. {PASTED_TEXT_ESCAPING_NOTE}{" "}
        {CRON_PERCENT_NOTE} {CRONTAB_ACCOUNT_NOTE}
        {dockerShown &&
          " A scheduled job does not use your shell's PATH, so check that " +
            "/usr/bin/docker is where Docker is installed (command -v docker). " +
            FOLDER_OWNED_BY_IMAGE_ACCOUNT_NOTE}
      </p>
      <PodmanLines lines={lines} />
      {lines.scheduleNote !== undefined && (
        <p className={styles.small}>{lines.scheduleNote}</p>
      )}
      {lines.bindPathsCaveat !== undefined && (
        <p className={styles.small}>{lines.bindPathsCaveat}</p>
      )}
    </>
  );
}
