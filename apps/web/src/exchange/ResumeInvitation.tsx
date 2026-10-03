import { useId, useState } from "react";

import { Alert, Button, FileButton, Group } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";

import { sanitizeErrorForDisplay } from "@alcove/core";

import { alertRoleFor } from "@theme";
import { dateTimeLabel } from "@psi/formatting";
import { loadCSVFileOffMainThread } from "@psi/workers/csvParseController";
import styles from "@styles/app.module.css";

import {
  resumedInvitation,
  usePendingInvitationRecord,
} from "./pendingInvitation";
import { InviterExchangeSection } from "./InviterExchangeSection";
import { TopBar } from "./TopBar";
import { WorkShell } from "./WorkShell";
import { timelineSteps } from "./exchangeRun";
import { useBeforeUnloadPrompt } from "./useUnloadGuard";
import { useInviterExchange } from "./useInviterExchange";

import type { AlertContent } from "@components/csvIntake";
import type { GeneratedInvitation } from "@psi/invitation";
import type { PendingInvitation } from "./pendingInvitation";

/**
 * The offer, on the inviter's file step, to wait again on an invitation this
 * tab created before a reload: the partner's link still works for as long as
 * the invitation does, so choosing the same file again listens on it. The
 * file is read here, by the delimiter it was first read by, and must have the
 * columns the invitation was created from.
 */
export function ResumeInvitationOffer({
  pending,
  onResume,
  onDiscard,
}: {
  pending: PendingInvitation;
  onResume: (invitation: GeneratedInvitation) => void;
  onDiscard: () => void;
}) {
  const headingId = useId();
  const [reading, setReading] = useState(false);
  const [alert, setAlert] = useState<AlertContent>();
  const { fileName } = pending;

  async function readChosenFile(file: File | null) {
    if (file === null) return;
    setReading(true);
    setAlert(undefined);
    try {
      const result = await loadCSVFileOffMainThread(file, {
        ...(pending.csvDelimiter !== undefined
          ? { delimiter: pending.csvDelimiter }
          : {}),
      });
      const resumed = resumedInvitation(pending, {
        rawRows: result.data,
        columns: result.meta.fields ?? [],
      });
      if (resumed === undefined) {
        setAlert({
          title: "This file's columns are not the ones the invitation uses",
          message:
            `The invitation was created from ${fileName}, and this file's ` +
            "columns differ from it. Choose that file, or discard the " +
            "invitation and create a new one.",
        });
        return;
      }
      onResume(resumed);
    } catch (error) {
      setAlert({
        title: "The file could not be read",
        message: sanitizeErrorForDisplay(error),
      });
    } finally {
      setReading(false);
    }
  }

  return (
    <section className={styles.callout} aria-labelledby={headingId}>
      <h2 id={headingId}>Your invitation is still open</h2>
      <p className={styles.small}>
        You created an invitation your partner can accept until{" "}
        <span className={styles.mono}>
          {dateTimeLabel(new Date(pending.invitation.expires))}
        </span>
        . To wait for your partner again, choose the file you created it from,{" "}
        <span className={styles.mono}>{fileName}</span>.
      </p>
      <Group>
        <FileButton
          accept=".csv,text/csv"
          onChange={(file) => void readChosenFile(file)}
          inputProps={{ "aria-label": `Choose ${fileName} again` }}
        >
          {(props) => (
            <Button {...props} loading={reading}>
              Choose the file again
            </Button>
          )}
        </FileButton>
        <Button variant="default" disabled={reading} onClick={onDiscard}>
          Discard the invitation
        </Button>
      </Group>
      <p className={styles.small}>
        Discarding it means your partner&apos;s link will not connect. You can
        then create a new invitation below.
      </p>
      {alert !== undefined && (
        <Alert
          color="red"
          role={alertRoleFor("red")}
          icon={<IconAlertCircle aria-hidden />}
          title={alert.title}
          mt="sm"
        >
          {alert.message}
        </Alert>
      )}
    </section>
  );
}

/**
 * The run on an invitation the operator chose to wait on again after a
 * reload: the inviter's share, run, and completion screens for that
 * invitation alone. Its setup steps are not restored, so leaving the run --
 * starting over, or choosing a fresh invitation -- returns to them empty.
 */
export function ResumedInvitationRun({
  invitation,
  inviterName,
  fileName,
  csvDelimiter,
  onLeave,
}: {
  invitation: GeneratedInvitation;
  inviterName: string;
  fileName: string;
  csvDelimiter?: string;
  /** Leave this run for a fresh setup. */
  onLeave: () => void;
}) {
  const {
    run,
    outputs,
    failure,
    runRecord,
    warnings,
    listeningUntil,
    tryAgain,
  } = useInviterExchange({
    invitation,
    inviterName,
    channel: "browser",
    inputSource: undefined,
    sftpConfigured: false,
    ...(csvDelimiter !== undefined ? { csvDelimiter } : {}),
  });
  usePendingInvitationRecord({
    invitation,
    context: {
      inviterName,
      fileName,
      ...(csvDelimiter !== undefined ? { csvDelimiter } : {}),
    },
    outputs,
    failure,
  });
  useBeforeUnloadPrompt(outputs === undefined && failure === undefined);

  return (
    <WorkShell
      topBar={
        <TopBar
          navLabel="Exchange progress"
          steps={timelineSteps(run)}
          transportNote="Browser"
        />
      }
    >
      <InviterExchangeSection
        invitation={invitation}
        inviterName={inviterName}
        run={run}
        outputs={outputs}
        failure={failure}
        runRecord={runRecord}
        warnings={warnings}
        partnerAcceptsByCli={false}
        serverJob={false}
        jobId={undefined}
        reattached={undefined}
        reattaching={false}
        listeningUntil={listeningUntil}
        resumableAfterReload
        resumed
        onTryAgain={tryAgain}
        onStartOver={onLeave}
        onReviewAppliedTerms={onLeave}
        onAbandon={() => undefined}
      />
    </WorkShell>
  );
}
