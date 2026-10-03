import { useEffect, useId, useState } from "react";

import { Alert, Button, FileButton, Group } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";

import { alertRoleFor } from "@theme";
import { dateTimeLabel } from "@psi/formatting";
import styles from "@styles/app.module.css";

import {
  MAX_TIMER_MS,
  clearPendingInvitation,
  resumeFromChosenFile,
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
 * file must have the columns, in order, and the number of rows of the file
 * the invitation was created from. When the invitation expires, the offer
 * removes the kept entry and gives way to a sentence saying so.
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
  const [expired, setExpired] = useState(false);
  const { fileName } = pending;
  const { expires } = pending.invitation;

  useEffect(() => {
    const remainingMs = Date.parse(expires) - Date.now();
    if (remainingMs > MAX_TIMER_MS) return;
    const timer = setTimeout(
      () => {
        clearPendingInvitation();
        setExpired(true);
      },
      Math.max(0, remainingMs),
    );
    return () => clearTimeout(timer);
  }, [expires]);

  async function readChosenFile(file: File | null) {
    if (file === null) return;
    setReading(true);
    setAlert(undefined);
    try {
      const outcome = await resumeFromChosenFile(pending, file);
      if (outcome.kind === "resumed") {
        onResume(outcome.invitation);
        return;
      }
      if (outcome.kind === "expired") {
        setExpired(true);
        return;
      }
      setAlert(
        outcome.kind === "unreadable"
          ? {
              title: "The file could not be read",
              message:
                "Alcove could not read this file as a CSV. Choose " +
                `${fileName}, the file the invitation was created from, or ` +
                "discard the invitation and create a new one.",
            }
          : {
              title: "This file does not match the invitation",
              message:
                `The invitation was created from ${fileName}, and this ` +
                "file's columns or number of rows differ from it. Choose " +
                "the file with the same columns, in the same order, and the " +
                "same number of rows, or discard the invitation and create " +
                "a new one.",
            },
      );
    } finally {
      setReading(false);
    }
  }

  if (expired)
    return (
      <p className={styles.callout} role="status">
        Your earlier invitation has expired, so your partner&apos;s link will
        not connect. Create a new invitation below.
      </p>
    );

  return (
    <section className={styles.callout} aria-labelledby={headingId}>
      <h2 id={headingId}>Your invitation is still open</h2>
      <p className={styles.small}>
        You created an invitation your partner can accept until{" "}
        <span className={styles.mono}>
          {dateTimeLabel(new Date(pending.invitation.expires))}
        </span>
        . To wait for your partner again, choose the file you created it from,{" "}
        <span className={styles.mono}>{fileName}</span>. It must have the same
        columns, in the same order, and the same number of rows.
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
