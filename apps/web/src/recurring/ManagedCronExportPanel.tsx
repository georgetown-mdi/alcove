import { useMemo, useState } from "react";

import { Alert, Anchor, Button } from "@mantine/core";

import { DisclosureSection } from "@components/DisclosureSection";
import { triggerBlobDownload } from "@components/blobDownload";

import { exportManagedCronFiles } from "@psi/managed/managedExchangeExport";
import { getManagedExchange } from "@psi/managed/managedExchangeStore";
import { readOwnRelaySetting } from "@psi/transport/ownRelaySetting";

import styles from "@styles/app.module.css";

import {
  EXPORT_LEAVES_ACCOUNTING_NOTE,
  RUN_IN_FLIGHT_EXPORT_NOTE,
  invitationRegistrarExportLine,
  managedCronExportPanelState,
  runElsewhereNotice,
  stunExportLine,
} from "./managedCronExportModel";
import { RunCommandLines } from "./RunCommandLines";
import { ScheduledRunLinesView } from "./ScheduledRunLinesView";

import type { RunnableManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";
import type { ShownScheduledRunLines } from "./managedCronExportModel";

/** The key file's custody rules, cited rather than restated here. */
const KEY_FILE_SECURITY_DOC_URL =
  "https://github.com/georgetown-mdi/alcove/blob/main/docs/SECURITY_DESIGN.md#key-file-security";

/**
 * The command-line export panel on a managed exchange's detail surface, beside the
 * backup panel and collapsed until the operator opens it: the files that run a
 * browser-run recurring exchange under `alcove exchange` and the host's own
 * scheduler (docs/MANAGED_EXCHANGE.md, "Exporting to the command line").
 *
 * Downloads `alcove.yaml` (no secret) and `.alcove.key` (a plaintext credential)
 * as two separate files rather than one archive, and writes nothing: the stored
 * exchange stays runnable here, and its backup marker is left as it was.
 */
export function ManagedCronExportPanel({
  record,
  runInFlight,
}: {
  record: RunnableManagedExchangeRecord;
  /** Whether a run of this exchange is in flight in any context this browser profile
   * can see -- the host's own run, a second tab's, or the scheduled runtime's. The
   * download stays offered, with a note ({@link RUN_IN_FLIGHT_EXPORT_NOTE}). */
  runInFlight: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // One read of the relay settings serves the panel and the download, so the
  // files name the TURN urls the panel composed with.
  const { ownRelay, state } = useMemo(() => {
    const read = readOwnRelaySetting();
    return {
      ownRelay: read,
      state: managedCronExportPanelState(record, () => read),
    };
  }, [record]);
  const invitationRegistrarLine =
    state.kind === "exportable"
      ? invitationRegistrarExportLine(state.composed.connection)
      : undefined;

  function downloadFiles() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    void exportManagedCronFiles(record.id, {
      readRecord: getManagedExchange,
      download: triggerBlobDownload,
      readOwn: () => ownRelay,
    })
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  }

  return (
    <div className={styles.callout}>
      <DisclosureSection
        label="Run this from the command line"
        summary={
          state.kind === "refused"
            ? "Not available for this exchange"
            : undefined
        }
        open={open}
        onToggle={setOpen}
        headingOrder={2}
      >
        {state.kind === "refused" ? (
          <>
            <p className={styles.small}>
              This exchange cannot run from the command line, so there is
              nothing to download here.
            </p>
            <p className={styles.small} style={{ whiteSpace: "pre-line" }}>
              {state.reason}
            </p>
          </>
        ) : (
          <>
            <p className={styles.small}>
              To run this exchange on a schedule from the command line, download
              the two files <span className={styles.mono}>alcove exchange</span>{" "}
              opens, put them in a folder on the machine that will run the
              schedule, and schedule the command there. Downloading them does
              not change the backup state above.
            </p>
            <p className={styles.calloutLead}>
              {runElsewhereNotice(state.fromAgreedSchedule)}
            </p>
            <ol className={styles.handoffSteps}>
              <li>
                <p className={styles.handoffStepLabel}>
                  Download the two files into one folder
                </p>
                <ul className={styles.small}>
                  <li>
                    <span className={styles.mono}>
                      {state.composed.config.fileName}
                    </span>{" "}
                    - the agreed terms and the connection settings, with no
                    secret.
                  </li>
                  <li>
                    <span className={styles.mono}>
                      {state.composed.key.fileName}
                    </span>{" "}
                    - this exchange&apos;s shared secret, in plain text.
                  </li>
                </ul>
                <p className={styles.small}>
                  Save the key file so only you can read it, and never send it
                  over an unencrypted channel. The command line&apos;s rules for
                  keeping its key file apply to it. See{" "}
                  <Anchor
                    inherit
                    href={KEY_FILE_SECURITY_DOC_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Key file security
                  </Anchor>
                  .
                </p>
                <p className={styles.small}>{EXPORT_LEAVES_ACCOUNTING_NOTE}</p>
                {failed && (
                  <Alert
                    role="alert"
                    color="red"
                    title="Could not export the command-line files"
                    mb="sm"
                  >
                    This export did not finish, so one or both files may be
                    missing. Check your browser&apos;s downloads and download
                    again.
                  </Alert>
                )}
                <Button mt="sm" onClick={downloadFiles} loading={busy}>
                  Download {state.composed.config.fileName} and{" "}
                  {state.composed.key.fileName}
                </Button>
                {runInFlight && (
                  <p className={styles.small}>{RUN_IN_FLIGHT_EXPORT_NOTE}</p>
                )}
              </li>
              {state.lines.kind === "withheld" ? (
                <li>
                  <p className={styles.handoffStepLabel}>Run it there</p>
                  <p className={styles.small}>{state.lines.notice}</p>
                </li>
              ) : (
                <ShownRunSteps
                  lines={state.lines}
                  fromAgreedSchedule={state.fromAgreedSchedule}
                />
              )}
            </ol>
            <h3 className={styles.handoffHeading}>Before you schedule it</h3>
            <ul className={styles.small}>
              <li>
                {stunExportLine(
                  state.composed.connection,
                  state.composed.config.fileName,
                )}
              </li>
              {invitationRegistrarLine !== undefined && (
                <li>{invitationRegistrarLine}</li>
              )}
              <li>
                {state.fromAgreedSchedule
                  ? "These files do not include the schedule you agreed on with " +
                    "your partner. On the command line, the cron entry or " +
                    "scheduled task sets the schedule" +
                    (state.lines.kind === "shown"
                      ? ", and the lines above use the agreed one"
                      : "") +
                    ". Each run waits for your partner until " +
                    "the agreed window closes, then stops."
                  : "These files do not include the schedule you agreed on with " +
                    "your partner. On the command line, the cron entry or " +
                    "scheduled task sets the schedule, so set it to the " +
                    "window your partner expects."}
              </li>
            </ul>
          </>
        )}
      </DisclosureSection>
    </div>
  );
}

/** The steps after the download where the lines are shown: put the input file
 * in the folder, run the command, and schedule it. */
function ShownRunSteps({
  lines,
  fromAgreedSchedule,
}: {
  lines: ShownScheduledRunLines;
  fromAgreedSchedule: boolean;
}) {
  return (
    <>
      <li>
        <p className={styles.handoffStepLabel}>
          Put your input file in that folder
        </p>
        <p className={styles.small}>
          The command below reads input.csv from the folder it runs in and
          writes each run&apos;s result into that folder as
          alcove-results-&lt;time&gt;.csv, with the same time as that run&apos;s
          exchange record. Name your file to match, or change the name in the
          command.
        </p>
      </li>
      <li>
        <p className={styles.handoffStepLabel}>Run it there</p>
        {lines.dockerLinesNotice !== undefined && (
          <p className={styles.small}>{lines.dockerLinesNotice}</p>
        )}
        <RunCommandLines lines={lines} ariaLabel="exchange command" />
      </li>
      <li>
        <p className={styles.handoffStepLabel}>
          {fromAgreedSchedule
            ? "Schedule it (set the folder)"
            : "Schedule it (adjust the times and the folder)"}
        </p>
        <ScheduledRunLinesView lines={lines} />
      </li>
    </>
  );
}
