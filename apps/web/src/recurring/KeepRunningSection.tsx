import { useState } from "react";

import { Alert, Button } from "@mantine/core";

import { showInstallPrompt, useInstallPrompt } from "@utils/installPrompt";
import {
  storedWorkingDirectoryUsable,
  workingDirectoryGrantSupported,
} from "@psi/managed/managedWorkingDirectory";
import { isInstalledRuntime as installedRuntime } from "@utils/installedRuntime";

import { alertRoleFor } from "@theme";
import styles from "@styles/app.module.css";

import {
  INSTALL_OFFER_COPY,
  READINESS_LIMIT_NOTE,
  installOffer,
  keepRunningChecklist,
  readinessLines,
  readinessReady,
  readinessTitle,
} from "./keepRunningModel";
import { browserReadinessCheck, runReadinessCheck } from "./readinessCheck";

import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";
import type { ReadinessCheckDependencies } from "./readinessCheck";
import type { ReadinessReport } from "./keepRunningModel";

/**
 * What a scheduled exchange needs to run with nobody present, on its page: the
 * install offer (a button where the browser offered to install, the browser's
 * own route otherwise), the keep-running checklist, and a readiness check of
 * the next window that starts no run (see {@link ./readinessCheck.ts}).
 */
export function KeepRunningSection({
  record,
  isInstalledRuntime = installedRuntime,
  readinessCheck = browserReadinessCheck,
}: {
  record: ManagedExchangeRecord;
  /** Whether this page is the installed app. Defaults to
   * {@link installedRuntime}. */
  isInstalledRuntime?: () => boolean;
  /** The platform readings the readiness check makes. */
  readinessCheck?: ReadinessCheckDependencies;
}) {
  const install = useInstallPrompt();
  const [installAnswer, setInstallAnswer] = useState<"dismissed">();
  const [checking, setChecking] = useState(false);
  const [report, setReport] = useState<ReadinessReport>();
  const installed = isInstalledRuntime();
  const offer = installOffer({
    installedRuntime: installed,
    installedFromThisPage: install.installedFromThisPage,
    promptAvailable: install.available,
  });
  const checklist = keepRunningChecklist({
    installedRuntime: installed,
    folderGrantSupported: workingDirectoryGrantSupported(),
    hasWorkingFolder: storedWorkingDirectoryUsable(
      record.workingDirectoryHandle,
    ),
  });

  async function promptInstall() {
    const outcome = await showInstallPrompt();
    if (outcome === "dismissed") setInstallAnswer("dismissed");
  }

  async function check() {
    setChecking(true);
    try {
      setReport(
        await runReadinessCheck(record.workingDirectoryHandle, readinessCheck),
      );
    } finally {
      setChecking(false);
    }
  }

  const resultColor =
    report === undefined
      ? undefined
      : readinessReady(report)
        ? "green"
        : "yellow";

  return (
    <div className={styles.callout}>
      <h2 className={styles.eyebrow}>Keep it running</h2>
      <p className={styles.small}>{INSTALL_OFFER_COPY[offer]}</p>
      {offer === "button" && (
        <Button variant="default" onClick={() => void promptInstall()}>
          Install Alcove
        </Button>
      )}
      {offer === "instructions" && installAnswer === "dismissed" && (
        <p className={`${styles.small} ${styles.sub}`}>
          You closed the install prompt. Install Alcove later from your
          browser&apos;s menu.
        </p>
      )}
      <h3 className={styles.eyebrow}>For runs with nobody present</h3>
      <ul className={styles.small}>
        {checklist.map((item) => (
          <li key={item.id}>
            {item.instruction}
            {item.done !== undefined && (
              <strong>{item.done ? " Done." : " Not yet."}</strong>
            )}
          </li>
        ))}
      </ul>
      <Button
        variant="default"
        loading={checking}
        onClick={() => void check()}
        mt="xs"
      >
        Check readiness for the next window
      </Button>
      {report !== undefined && resultColor !== undefined && (
        <Alert
          color={resultColor}
          role={alertRoleFor(resultColor)}
          title={readinessTitle(report)}
          mt="sm"
        >
          <ul className={styles.small}>
            {readinessLines(report).map((line) => (
              <li key={line.id}>
                <strong>{line.ok ? "Ready: " : "Not ready: "}</strong>
                {line.message}
              </li>
            ))}
          </ul>
          <p className={`${styles.small} ${styles.sub}`}>
            {READINESS_LIMIT_NOTE}
          </p>
        </Alert>
      )}
    </div>
  );
}
