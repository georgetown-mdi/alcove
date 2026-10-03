import { useEffect, useMemo, useRef, useState } from "react";

import { Alert, Button, Group, Modal } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";

import { whenDiagnostic } from "@utils/diagnostics";

import {
  clearAttachment,
  discardServerJob,
  readAttachment,
} from "@psi/jobClient/consoleJobAttachment";
import {
  createFetchJobApiClient,
  createServerJobReattachDriver,
  fetchSlotOccupancy,
} from "@psi/jobClient/serverJobExchangeDriver";

import { appendSanitizedRunWarning } from "@psi/runWarnings";
import { fetchJobFolder } from "@psi/jobClient/jobFolder";

import { RecurringHandoff } from "@recurring/RecurringHandoff";
import styles from "@styles/app.module.css";

import {
  initialRun,
  runWithCompletion,
  runWithFailure,
  runWithStage,
  runWithStages,
} from "./exchangeRun";
import { failureFor } from "./useInviterExchange";

import {
  DiscardFolderList,
  discardFolderFor,
  useDiscardFolder,
} from "./discardFolder";
import {
  FailureBody,
  RunDownloads,
  RunWarningsAlert,
  recoveredExchangeHeading,
  untakenRecordConfirm,
} from "./RunSurface";
import { DiagnosticLogPanel } from "./DiagnosticLogPanel";
import { ReceiptDownload } from "./ReceiptDownload";
import { RecordDownload } from "./RecordDownload";
import { StatusPanel } from "./StatusPanel";
import { reattachedRunState } from "./reattachedRunState";
import { useJobExchangeRecordOffer } from "./useJobExchangeRecordOffer";

import type { ConsoleJobSeat } from "@psi/jobClient/consoleJobAttachment";
import type { DiscardFolder } from "./discardFolder";
import type { ExchangeRun } from "./exchangeRun";
import type { JobRunStatus } from "@psi/jobClient/serverJobExchangeDriver";
import type { ReattachedRunState } from "./RunSurface";
import type { RunFailure } from "./useInviterExchange";
import type { RunOutputs } from "@psi/runOutputs";

/**
 * The exchange the panel recovers: the job id to re-attach to and the seat that
 * heads its initial run. Read from the persisted attachment, or -- when this
 * browser holds none -- adopted from the slot-occupancy probe.
 */
interface RecoveryTarget {
  jobId: string;
  seat: ConsoleJobSeat;
}

/**
 * Resolve the exchange to recover: the persisted attachment when this browser has
 * one, else an occupancy probe of the console's single slot so a browser that
 * never started the exchange still sees it. A probe-adopted target is held in
 * component state only -- never written to storage -- until the operator acts
 * (re-attach or discard). Returns null when there is nothing to recover; the probe
 * fails safe to unoccupied, so a probe fault is treated as nothing to recover.
 */
async function resolveRecoveryTarget(
  signal: AbortSignal,
): Promise<{ target: RecoveryTarget; adoptedFromProbe: boolean } | null> {
  const stored = readAttachment();
  if (stored !== null)
    return {
      target: { jobId: stored.jobId, seat: stored.seat },
      adoptedFromProbe: false,
    };
  const occupancy = await fetchSlotOccupancy(signal);
  if (!occupancy.occupied) return null;
  return {
    target: { jobId: occupancy.id, seat: "inviter" },
    adoptedFromProbe: true,
  };
}

/**
 * The panel's lead paragraph. The default names the exchange as one the operator
 * started in this browser; the probe-adopted variant does not claim that -- the id
 * came from the slot probe, so another browser (or this one before its attachment
 * was lost) may have started it -- and drops the "you", saying "started here" so
 * "it" refers only to the exchange and "here" names the console.
 */
function recoveryLead(
  state: ReattachedRunState,
  adoptedFromProbe: boolean,
): string {
  const origin = adoptedFromProbe
    ? "an exchange started here"
    : "an exchange you started here";
  return state === "running"
    ? `This console is still running ${origin}. Watch it finish, stop it, or discard it and its files.`
    : state === "finished"
      ? `This console finished ${origin}. Download its results below, or discard it to remove its files from this console.`
      : `This console stopped ${origin} before it finished, so there are no results to download. The reason is shown below; discard it to remove its files from this console.`;
}

/** The title over the panel's discard confirm where nothing beyond the exchange
 * and its results is at stake. */
const DISCARD_CONFIRM_TITLE = "Discard this exchange?";

/** What that confirm says: the removal is console-only and irreversible, and it
 * covers a run still going. It names no artifact beyond the results, which is why
 * a record standing on this panel takes {@link untakenRecordConfirm}'s copy
 * instead. */
export const DISCARD_CONFIRM_BODY =
  "Discarding removes this exchange and any results from this console, and " +
  "stops it if it is still running. This cannot be undone -- download anything " +
  "you need first.";

/** The heading over a folder a restart left behind. */
export const LEFTOVER_FOLDER_HEADING =
  "Files from an exchange before a restart";

/**
 * A folder an exchange this browser started left behind when the console
 * restarted: the console no longer runs or serves that exchange, and its files
 * stay on disk until the operator chooses. Keep forgets the folder here and
 * leaves it where it is; Discard deletes it, behind a confirm naming what it
 * holds. `onDiscard` resolves false when the folder was not deleted.
 */
function LeftoverFolderNotice({
  folder,
  onKeep,
  onDiscard,
}: {
  folder: DiscardFolder;
  onKeep: () => void;
  onDiscard: () => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardFailed, setDiscardFailed] = useState(false);
  function discard() {
    if (discarding) return;
    setDiscarding(true);
    setDiscardFailed(false);
    void onDiscard().then((deleted) => {
      setDiscarding(false);
      if (deleted) return;
      setConfirming(false);
      setDiscardFailed(true);
    });
  }
  return (
    <section className={styles.callout} aria-label={LEFTOVER_FOLDER_HEADING}>
      <h2 style={{ marginTop: 0 }}>{LEFTOVER_FOLDER_HEADING}</h2>
      <p className={styles.small}>
        The console restarted and no longer holds an exchange you started here.
        Its files are still in the folder <code>{folder.name}</code> in the
        console&apos;s working directory, and this console can no longer show or
        download them. Keep the folder to copy files out of it yourself, or
        discard it.
      </p>
      {discardFailed && (
        <Alert
          color="red"
          icon={<IconAlertCircle aria-hidden />}
          title="The folder was not deleted"
          mt="md"
        >
          The console could not delete the folder <code>{folder.name}</code>.
          You can delete it yourself from the console&apos;s working directory.
        </Alert>
      )}
      <Group mt="md">
        <Button variant="default" onClick={onKeep}>
          Keep the folder
        </Button>
        <Button
          color="red"
          variant="light"
          loading={discarding}
          aria-haspopup="dialog"
          onClick={() => setConfirming(true)}
        >
          Discard the folder
        </Button>
      </Group>
      <Modal
        opened={confirming}
        onClose={() => setConfirming(false)}
        title="Delete this folder?"
        centered
        transitionProps={{ duration: 0 }}
      >
        <DiscardFolderList folder={folder} />
        <p>This cannot be undone.</p>
        <Group mt="md">
          <Button variant="default" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            color="red"
            variant="light"
            loading={discarding}
            onClick={discard}
          >
            Discard the folder
          </Button>
        </Group>
      </Modal>
    </section>
  );
}

/**
 * The console's strand-recovery surface: a self-contained way back to the one
 * exchange the console holds, mounted on an idle console entry and the console
 * lobby. It is NOT a job list and NOT accept-later -- there is exactly one
 * exchange, named by this browser's stored attachment or, failing that, by the
 * console's single-slot occupancy.
 *
 * On mount it resolves the exchange to recover -- the persisted attachment when
 * this browser holds one, else an occupancy probe of the console's single slot
 * (`GET /api/jobs/slot`) so a browser that never started it still finds it --
 * then probes `GET /api/jobs/:id`. Nothing to recover renders nothing. A
 * probe-adopted id is held in state only, never persisted, until the operator
 * acts (re-attach or discard). A CONFIRMED-gone id (an HTTP 404: deleted, or a
 * restart forgot it) whose folder is still on disk renders the leftover-folder
 * notice, which deletes nothing until the operator chooses Discard; a gone id
 * with no folder, or with a folder holding none of the run's files, clears any
 * stored record and renders nothing. A transient/unreachable probe (a network
 * error or non-404 fault) renders nothing but LEAVES the record intact, so a
 * blip never destroys the way back to a live exchange. A live id renders the
 * panel: one of three headings -- still running, finished, or stopped
 * (failed/cancelled) -- the run's non-fatal warnings, the re-attached run's
 * timeline (replayed through the same run-state fold the hooks use), the
 * console download hrefs on a finished run only, the collapsed "run this on a
 * schedule" graduation hand-off on any run that is not stopped (self-gated away
 * when the hand-off is unavailable), "Stop this exchange" while running, and
 * "Discard" (behind a confirm, since it is an irreversible removal of
 * console-only data -- naming the exchange record instead of the results where
 * the run may have left one standing) always.
 *
 * Unmounting the panel aborts only its own stream consumption -- it has no
 * cancel intent, so the console's run keeps going and the panel is the way back
 * on the next visit. Only Discard (and the consoles' deliberate-leave paths)
 * cancel or delete. The re-attached outputs are console ENDPOINT hrefs, so the
 * panel creates no object URLs and there is nothing to revoke.
 */
export function RecoveredExchangePanel() {
  // undefined = probing (render nothing); null = nothing to recover (render
  // nothing); a target = a live re-attachment to render.
  const [attachment, setAttachment] = useState<RecoveryTarget | null>();
  // True when the target's id came from the slot-occupancy probe rather than this
  // browser's own stored attachment, which selects the neutral lead copy.
  const [adoptedFromProbe, setAdoptedFromProbe] = useState(false);
  const [run, setRun] = useState<ExchangeRun>();
  const [outputs, setOutputs] = useState<RunOutputs>();
  const [failure, setFailure] = useState<RunFailure>();
  // The re-attached run's non-fatal warnings, each escaped at this display
  // boundary. The SSE replay is full-history, so a warning the exchange raised
  // before this browser attached arrives here too -- which is the whole point on
  // a seat that may never have seen the launch.
  const [warnings, setWarnings] = useState<Array<string>>([]);
  // The probe's initial read of the run status, so a re-attached terminal run
  // heads correctly -- finished-successful or stopped -- immediately rather than
  // flashing "still running" until the replay lands.
  const [initialStatus, setInitialStatus] = useState<JobRunStatus>("running");
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  // A folder a restart left behind for the stored exchange, shown until the
  // operator keeps or discards it.
  const [leftover, setLeftover] = useState<DiscardFolder>();

  const client = useMemo(() => createFetchJobApiClient(), []);
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    const aborted = () => controller.signal.aborted;
    void (async () => {
      const resolved = await resolveRecoveryTarget(controller.signal);
      if (aborted()) return;
      if (resolved === null) {
        setAttachment(null);
        return;
      }
      const { target, adoptedFromProbe: fromProbe } = resolved;
      const status = await client.fetchJobStatus(
        target.jobId,
        controller.signal,
      );
      if (aborted()) return;
      if (status.kind === "gone") {
        // A CONFIRMED 404: the exchange is not on the console (deleted, or a
        // restart forgot it). A folder still on disk is the operator's to keep
        // or discard; an unanswered folder ask leaves the stored record for the
        // next visit to ask again.
        const folder = await fetchJobFolder(target.jobId, controller.signal);
        if (aborted()) return;
        if (folder.kind === "present" && !folder.live) {
          const keepable = discardFolderFor(target.jobId, folder);
          if (keepable !== undefined) setLeftover(keepable);
          else clearAttachment();
          setAttachment(null);
          return;
        }
        if (folder.kind === "absent") clearAttachment();
        setAttachment(null);
        return;
      }
      if (status.kind === "unreachable") {
        // A transient unreachability, NOT a confirmed removal: render nothing but
        // LEAVE any record intact so the next mount can recover a still-live
        // exchange rather than the blip destroying the way back to it.
        setAttachment(null);
        return;
      }
      setInitialStatus(status.status);
      setRun(initialRun(target.seat));
      setAdoptedFromProbe(fromProbe);
      setAttachment(target);
      const driver = createServerJobReattachDriver(target.jobId, client);
      await driver.run({
        signal: controller.signal,
        onStages: (stages) =>
          setRun((current) =>
            current ? runWithStages(current, stages) : current,
          ),
        onStage: (stageId) =>
          setRun((current) =>
            current ? runWithStage(current, stageId, new Date()) : current,
          ),
        onResult: (generated) => {
          setOutputs(generated);
          setRun((current) =>
            current ? runWithCompletion(current, new Date()) : current,
          );
        },
        onWarning: (message) =>
          setWarnings((current) => appendSanitizedRunWarning(current, message)),
        onError: ({ category, error }) => {
          whenDiagnostic(() => console.error(error));
          setFailure(failureFor(category, error));
          setRun((current) => (current ? runWithFailure(current) : current));
        },
      });
    })();
    return () => {
      controller.abort();
    };
  }, [client]);

  // Stop halts the console's run without removing its files (a graceful cancel);
  // the re-attached stream then delivers the cancelled terminal and the panel
  // settles. Discard is the explicit disk-remover.
  function stop() {
    if (attachment == null) return;
    void client.cancelJob(attachment.jobId).catch((error) => {
      whenDiagnostic(() => console.error(error));
    });
  }

  function discard() {
    if (attachment == null || discarding) return;
    setDiscarding(true);
    // Stop watching the stream (no cancel intent) while the discard's own
    // cancel/poll/DELETE runs; then the panel renders nothing.
    abortRef.current?.abort();
    void discardServerJob(client, attachment.jobId).then(() =>
      setAttachment(null),
    );
  }

  // Three distinct renders. A delivered terminal wins over the probe's initial
  // reading; before the replay lands, that reading drives the heading so a
  // re-attached terminal run never flashes the wrong copy. `stopped` (failed or
  // cancelled -- including this panel's own Stop) must NOT promise downloads:
  // there is no result, so the copy points at the failure alert and Discard.
  //
  // Derived above the nothing-to-recover return because the record ask below is a
  // hook and cannot sit behind one.
  const runState = reattachedRunState({
    failed: failure !== undefined,
    hasOutputs: outputs !== undefined,
    status: initialStatus,
  });
  const stopped = runState === "stopped";
  const running = runState === "running";

  // Where the re-attached run's exchange record stands. A run that disclosed and
  // then stopped is exactly the `stopped` render, which promises no downloads at
  // all -- so without this the panel would offer that run's record nowhere while
  // its own Discard removes it.
  const recordOffer = useJobExchangeRecordOffer(
    attachment?.jobId,
    !running && outputs?.record === undefined,
  );
  // Discard is this panel's only destructive control and it removes the workdir
  // the record sits in, so where that ask found (or could not rule out) a record,
  // the confirm says which artifact is at stake instead of the generic wording
  // below, which names only the exchange and its results.
  const recordConfirm = untakenRecordConfirm(recordOffer);
  const discardFolder = useDiscardFolder(attachment?.jobId, !running);

  if (leftover !== undefined)
    return (
      <LeftoverFolderNotice
        folder={leftover}
        onKeep={() => {
          clearAttachment();
          setLeftover(undefined);
        }}
        onDiscard={async () => {
          try {
            await client.deleteJob(leftover.name);
          } catch (error) {
            whenDiagnostic(() => console.error(error));
            return false;
          }
          clearAttachment();
          setLeftover(undefined);
          return true;
        }}
      />
    );

  if (attachment == null || run === undefined) return null;

  return (
    <section className={styles.callout} aria-label="Recovered exchange">
      <h2 style={{ marginTop: 0 }}>{recoveredExchangeHeading(runState)}</h2>
      <p className={styles.small}>{recoveryLead(runState, adoptedFromProbe)}</p>
      {failure !== undefined && (
        <Alert
          color="red"
          icon={<IconAlertCircle aria-hidden />}
          title={failure.title}
          mb="md"
        >
          <FailureBody failure={failure} />
        </Alert>
      )}
      <RunWarningsAlert warnings={warnings} />
      <StatusPanel
        run={run}
        done={outputs !== undefined}
        halted={failure !== undefined}
      />
      {outputs !== undefined && <RunDownloads outputs={outputs} heading="h3" />}
      <RecordDownload offer={recordOffer} />
      <ReceiptDownload jobId={attachment.jobId} settled={!running} />
      {/* Available for as long as the console holds the job, collapsed
          throughout on this compact panel -- the run seats' rule, less the
          expanded completion render this panel has no room for. A stopped
          (failed or cancelled) run has nothing to graduate. */}
      <DiagnosticLogPanel jobId={attachment.jobId} settled={!running} />
      {!stopped && <RecurringHandoff jobId={attachment.jobId} collapsible />}
      <Group mt="md">
        {running && (
          <Button variant="default" onClick={stop}>
            Stop this exchange
          </Button>
        )}
        <Button
          color="red"
          variant="light"
          loading={discarding}
          onClick={() => setConfirming(true)}
        >
          Discard
        </Button>
      </Group>
      <Modal
        opened={confirming}
        onClose={() => setConfirming(false)}
        title={recordConfirm?.title ?? DISCARD_CONFIRM_TITLE}
        centered
        transitionProps={{ duration: 0 }}
      >
        <p>{recordConfirm?.body ?? DISCARD_CONFIRM_BODY}</p>
        {discardFolder !== undefined && (
          <DiscardFolderList folder={discardFolder} />
        )}
        <Group mt="md">
          <Button variant="default" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            color="red"
            variant="light"
            loading={discarding}
            onClick={discard}
          >
            Discard
          </Button>
        </Group>
      </Modal>
    </section>
  );
}
