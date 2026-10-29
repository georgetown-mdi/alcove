import { useCallback, useEffect, useRef, useState } from "react";

import {
  Alert,
  Anchor,
  Button,
  FileButton,
  Loader,
  Modal,
} from "@mantine/core";
import { Link, useNavigate } from "@tanstack/react-router";

import { alertRoleFor } from "@theme";

import {
  MAX_IMPORT_FILE_BYTES,
  ManagedImportAlreadyHeldError,
  ManagedImportChosenCopyError,
  ManagedImportLiveCopyError,
  ManagedImportStoredCopyError,
  importManagedCommandLinePair,
  importManagedExchangeFile,
} from "@psi/managed/managedExchangeImport";
import {
  deleteManagedExchange,
  listManagedExchanges,
  listManagedExchangesDiagnostic,
  openManagedExchangeDatabase,
  requestPersistentStorage,
} from "@psi/managed/managedExchangeStore";
import { MAX_KEY_FILE_IMPORT_BYTES } from "@psi/managed/managedCommandLineImport";
import { listManagedLocalState } from "@psi/managed/managedLocalState";

import { HOME_HEADLINE } from "@exchange/homeCopy";
import { Lobby } from "@exchange/Lobby";
import { PASTE_INVITATION_FIELD_ID } from "@psi/invitation";
import { RECURRING_SETUP_HREF } from "@exchange/recurringSetup";

import { AppPage } from "@components/AppPage";
import styles from "@styles/app.module.css";

import {
  MANAGED_BACKUP_SECTION_ID,
  MANAGED_SCHEDULE_SECTION_ID,
} from "./managedSectionIds";

import {
  ALREADY_HELD_IMPORT_TITLE,
  CHOSEN_COPY_IMPORT_TITLE,
  IMPORT_FAILURE_TITLE,
  LIVE_COPY_IMPORT_CONFIRM,
  LIVE_COPY_IMPORT_TITLE,
  OVERSIZE_KEY_FILE_REASON,
  STORED_COPY_IMPORT_CONFIRM,
  STORED_COPY_IMPORT_TITLE,
  UNREADABLE_IMPORT_REASON,
  alreadyHeldBackupImportReason,
  alreadyHeldImportReason,
  chosenCopyImportReason,
  importFailureReason,
  liveCopyImportReason,
  liveCopyKeepLabel,
  liveCopyReplaceLabel,
  pairImportFailureReason,
  storedCopyImportReason,
  storedCopyTakeLabel,
} from "./managedImportFailure";
import { STATE_UNREADABLE_NOTE, recoveryRows } from "./savedExchangesRecovery";
import {
  managedImportFileChoice,
  pairImportedNotice,
} from "./managedImportFiles";
import { BetweenVisitNotifications } from "./BetweenVisitNotifications";
import { loadSavedExchanges } from "./savedExchangesLoad";
import { managedImportGrantNotice } from "./managedImportGrantNotice";

import type {
  ManagedPairImportOptions,
  ManagedStoredCopy,
} from "@psi/managed/managedPairRecognition";
import type { ManagedBackupImportOptions } from "@psi/managed/managedExchangeStore";
import type { ManagedImportGrantNotice } from "./managedImportGrantNotice";
import type { ManagedImportResult } from "@psi/managed/managedExchangeImport";
import type { RecoveryRow } from "./savedExchangesRecovery";
import type { SavedExchangeRow } from "./savedExchangesModel";
import type { SavedExchangesLoad } from "./savedExchangesLoad";

/** Run the managed-exchange home load on mount and on demand, cancelling its state
 * write if the component unmounts before the reads settle. Returns the current
 * {@link SavedExchangesLoad} (or `undefined` while a read is in flight) and a
 * `reload` that re-runs the load -- the delete affordance calls it so a delete that
 * removes the offending record recovers a now-readable list to the normal surface. */
function useSavedExchangesLoad(): {
  load: SavedExchangesLoad | undefined;
  reload: () => void;
} {
  const [load, setLoad] = useState<SavedExchangesLoad>();
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    void loadSavedExchanges({
      openStore: openManagedExchangeDatabase,
      listExchanges: listManagedExchanges,
      listLocalState: listManagedLocalState,
      now: Date.now,
    }).then((result) => {
      if (live) setLoad(result);
    });
    return () => {
      live = false;
    };
  }, [nonce]);
  const reload = useCallback(() => {
    setLoad(undefined);
    setNonce((current) => current + 1);
  }, []);
  return { load, reload };
}

/**
 * The app's home route at `/`: the management interface is the home only once a
 * recurring exchange exists here, so this reads the store and routes on the outcome,
 * inline with no URL redirect. It holds an explicit loading state while the read
 * settles, then: a `ready` store with one or more rows renders the list surface; an
 * empty `ready` store renders the quick (invite/accept) path, so a first-run visitor
 * lands on the one-off flow rather than an empty list; an `unavailable` store (this
 * browser cannot store recurring exchanges) likewise renders the quick path, with no
 * scary banner on landing; a `failed` store (it opened but its records cannot be read)
 * renders the read-failed surface, never the quick path -- records likely exist, and
 * silently showing the lobby would hide that.
 *
 * The canonical always-list route is `/saved` ({@link SavedExchanges}); a visitor
 * whose browser was evicted lands here on the quick path, and the quick path links to
 * `/saved` so the empty state's restore-from-backup affordance stays discoverable.
 */
export function SavedExchangesHome() {
  const { load, reload } = useSavedExchangesLoad();

  if (load === undefined)
    return (
      <AppPage>
        <main className={styles.lobby}>
          <DelayedLoader />
        </main>
      </AppPage>
    );
  if (
    load.kind === "unavailable" ||
    (load.kind === "ready" && load.rows.length === 0)
  )
    return <Lobby />;
  return <SavedExchangesSurface load={load} reload={reload} />;
}

/** How long a store read runs before its loader shows: a read that settles
 * sooner renders the page with no loader flashing before it. */
const LOADER_DELAY_MS = 200;

/** The loading indicator for a store read, named for assistive technology
 * and shown only once the read has run past {@link LOADER_DELAY_MS}. */
function DelayedLoader() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), LOADER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  if (!shown) return null;
  return <Loader role="status" aria-label="Loading" />;
}

/**
 * The managed-exchange list, the canonical always-list route at `/saved`. It lists the
 * recurring exchanges stored in this browser -- label, side, a one-line last-run
 * status, the schedule's due-ness where one is agreed on, and the derived backup state
 * -- each with a run action that opens the attended re-run surface, above a standing
 * entry into the quick (invite/accept) path.
 *
 * Unlike the home route, it renders the full surface unconditionally: the loading
 * state, then the exchanges, the designed empty state, the read-failed state, or --
 * when the store cannot be opened at all (private mode with storage blocked, an engine
 * without IndexedDB) -- the degrade message. This keeps eviction recovery discoverable:
 * a first-run visitor is routed to the quick path at `/`, and the quick path links here
 * so the restore-from-backup affordance in the empty state stays reachable.
 *
 * The empty state is a designed first-run surface, not a blank list: it explains what a
 * managed exchange is and offers creating one, accepting a recurring invitation, and a
 * standing import affordance -- a wholesale eviction erases the evidence anything
 * existed, so restore-from-backup lives here rather than only behind a detected loss
 * (see docs/MANAGED_EXCHANGE.md, "Eviction recovery is the import flow").
 *
 * Each row joins its record to the local sibling state, for its backup marker.
 */
export function SavedExchanges() {
  const { load, reload } = useSavedExchangesLoad();

  if (load?.kind === "unavailable") return <StorageUnavailable />;

  return <SavedExchangesSurface load={load} reload={reload} />;
}

/** The list surface itself: the loading loader, the exchanges, the designed empty
 * state, or the read-failed state, inside the shared page frame. Its prop type
 * excludes the `unavailable` case -- both routes intercept that ahead of it (the home
 * route to the quick path, the list route to its degrade message), so the surface never
 * receives it. */
function SavedExchangesSurface({
  load,
  reload,
}: {
  load: Exclude<SavedExchangesLoad, { kind: "unavailable" }> | undefined;
  reload: () => void;
}) {
  return (
    <AppPage>
      <main className={`${styles.lobby} ${styles.lobbyFullWidth}`}>
        <p className={styles.siteHeadline}>{HOME_HEADLINE}</p>
        <h1 className={styles.savedListTitle}>Recurring exchanges</h1>
        {load === undefined ? (
          <DelayedLoader />
        ) : load.kind === "failed" ? (
          <SavedExchangesFailed reload={reload} />
        ) : load.rows.length === 0 ? (
          <SavedExchangesEmpty />
        ) : (
          <SavedExchangesList rows={load.rows} reload={reload} />
        )}
      </main>
    </AppPage>
  );
}

/** The populated run list: a row per stored exchange with a run/open action and the
 * always-available remove, above a create entry into the invite/configure flow
 * (where saving as recurring is offered once the exchange completes) beside an
 * entry to the lobby's invitation field, the one-off quick-path alternative, and
 * the import every list state offers. Removing a row calls `reload`,
 * so the list reflects the removal without a page navigation. */
function SavedExchangesList({
  rows,
  reload,
}: {
  rows: Array<SavedExchangeRow>;
  reload: () => void;
}) {
  const navigate = useNavigate();

  return (
    <>
      <ul className={styles.savedList}>
        {rows.map((row) => (
          <li key={row.id} className={styles.savedRow}>
            <div className={styles.savedRowMain}>
              <span className={styles.savedRowLabel}>
                {row.label === "" ? "(unnamed exchange)" : row.label}
              </span>
              <span className={`${styles.small} ${styles.sub}`}>
                {row.sideLabel} - {row.status}
              </span>
              <ScheduleLines row={row} />
              {row.relayRegistrationLine !== undefined && (
                <span className={`${styles.small} ${styles.sub}`}>
                  {row.relayRegistrationLine}
                </span>
              )}
              <BackupLine row={row} />
            </div>
            <div className={styles.savedRowActions}>
              <Button
                variant={runnableRow(row) ? "filled" : "subtle"}
                onClick={() =>
                  void navigate({
                    to: "/saved/$id",
                    params: { id: row.id },
                  })
                }
              >
                {runnableRow(row) ? "Run" : "Open"}
              </Button>
              <DeleteExchangeButton
                id={row.id}
                label={row.label}
                backedUp={row.backup.kind === "backed-up"}
                configurationOnly={row.configurationOnly}
                onDeleted={reload}
              />
            </div>
          </li>
        ))}
      </ul>
      <BetweenVisitNotifications />
      <div className={styles.savedListActions}>
        <Button component="a" href={RECURRING_SETUP_HREF} variant="default">
          Set up a recurring exchange
        </Button>
        <Button
          component={Link}
          to="/quick"
          hash={PASTE_INVITATION_FIELD_ID}
          variant="default"
        >
          Accept an invitation
        </Button>
      </div>
      <p className={`${styles.sub} ${styles.small}`}>
        Need a one-off instead?{" "}
        <Anchor inherit component={Link} to="/quick">
          Start or accept a one-time exchange
        </Anchor>{" "}
        without saving it here.
      </p>
      <p className={`${styles.sub} ${styles.small}`}>
        If you can&apos;t connect to your partner, your IT team can give you a
        relay server address to enter in{" "}
        <Anchor inherit component={Link} to="/relay">
          relay settings
        </Anchor>
        .
      </p>
      <ImportExchangeFile />
    </>
  );
}

/** The store-unavailable degrade: when the managed store cannot be opened at all
 * (private mode with storage blocked, an engine without IndexedDB), the list route
 * cannot list anything, so it hands the operator the quick path -- they can still run
 * a one-off exchange -- rather than erroring. */
function StorageUnavailable() {
  return (
    <AppPage>
      <main className={styles.lobby}>
        <p className={styles.siteHeadline}>{HOME_HEADLINE}</p>
        <h1 className={styles.savedListTitle}>Recurring exchanges</h1>
        <p className={styles.sub}>
          This browser cannot store recurring exchanges - private browsing may
          be blocking storage, or this browser does not support it. You can
          still run a one-off exchange.
        </p>
        <p>
          <Button component={Link} to="/quick">
            Set up or accept a one-off exchange
          </Button>
        </p>
      </main>
    </AppPage>
  );
}

/** Whether the row's exchange runs in this browser, which is what decides
 * between the Run and Open actions: a configuration-only record runs on the
 * command line, so it opens instead. */
function runnableRow(row: SavedExchangeRow): boolean {
  return !row.configurationOnly;
}

/** The per-row schedule lines, for a row whose record holds an agreed
 * schedule: where the recurrence stands, quietly, and -- once the record's
 * consecutive-miss count reaches the escalation threshold -- the coordination
 * line, the one state here an operator acts on, with a link to the exchange's
 * run schedule where the steps to compare schedules are. A row with no
 * schedule renders nothing.
 *
 * The coordination line takes the caution treatment, matching the yellow Alert
 * the exchange's own surface uses for the same state, rather than the failure
 * red (docs/notes/managed-exchange-design.md, "Repeated misses surface, they
 * do not auto-pause"). */
function ScheduleLines({ row }: { row: SavedExchangeRow }) {
  if (row.schedule === undefined) return null;
  return (
    <>
      <span className={`${styles.small} ${styles.sub}`}>
        {row.schedule.dueLine}
      </span>
      {row.schedule.miss !== undefined && (
        <span className={`${styles.small} ${styles.savedRowMiss}`}>
          <strong>{row.schedule.miss.lead}</strong> {row.schedule.miss.detail}{" "}
          <Anchor
            inherit
            renderRoot={(props) => (
              <Link
                {...props}
                to="/saved/$id"
                params={{ id: row.id }}
                hash={MANAGED_SCHEDULE_SECTION_ID}
              />
            )}
          >
            Compare schedules
          </Anchor>
        </span>
      )}
    </>
  );
}

/** The per-row backup line: a quiet "backed up as of <date>" when a current export
 * exists, or, when none does, a link to the exchange's backup panel. A
 * configuration-only row shows no backup line at all: it holds no secret for a
 * backup to be of. */
function BackupLine({ row }: { row: SavedExchangeRow }) {
  if (row.backup.kind === "not-applicable") return null;
  if (row.backup.kind === "backed-up")
    return (
      <span className={`${styles.small} ${styles.statusLineOk}`}>
        Backed up as of {row.backup.asOf}
      </span>
    );
  return (
    <span className={styles.small}>
      <Anchor
        inherit
        renderRoot={(props) => (
          <Link
            {...props}
            to="/saved/$id"
            params={{ id: row.id }}
            hash={MANAGED_BACKUP_SECTION_ID}
          />
        )}
      >
        Not backed up - back up now
      </Anchor>
    </span>
  );
}

/** The always-available per-row delete: a primary action with one simple confirm.
 * The confirm names the exchange, names what the delete takes with it that the
 * operator may still want -- the accounting of disclosures, and any results a
 * scheduled run left for them -- and states a custody note for an exported
 * backup file the delete leaves behind (the row's backed-up state). Deletion
 * removes everything the
 * browser holds for the exchange in one step ({@link deleteManagedExchange}),
 * local and unilateral, so the confirm says the partner is not notified.
 * Exported so the per-exchange detail surface reuses this one confirm component. */
export function DeleteExchangeButton({
  id,
  label,
  backedUp,
  configurationOnly = false,
  unopenable = false,
  onDeleted,
}: {
  id: string;
  label: string;
  /** Whether part of the exchange's saved state cannot be read, so its page
   * cannot load: the confirm then says its accounting goes with it unread,
   * rather than to export it first. */
  unopenable?: boolean;
  /** Whether a backup was exported for this exchange (the custody note shows only
   * then; a never-exported exchange has nothing under the operator's custody). */
  backedUp: boolean;
  /** Whether this exchange is configuration only -- imported from a command-line
   * configuration, holding no secret and no history of runs here. What the delete
   * takes is then the settings alone, and what it leaves is the exchange itself,
   * running from the machine that holds its key file. */
  configurationOnly?: boolean;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const named = label === "" ? "this exchange" : `"${label}"`;

  function confirmDelete() {
    setDeleting(true);
    setDeleteFailed(false);
    void (async () => {
      try {
        await deleteManagedExchange(id);
        onDeleted();
        setConfirming(false);
      } catch {
        // A rejected delete (transaction abort, quota, a blocked open) leaves the
        // row standing: keep the modal open and report the failure so the operator
        // can retry rather than the row silently vanishing from confirm.
        setDeleteFailed(true);
      } finally {
        setDeleting(false);
      }
    })();
  }

  return (
    <>
      <Button
        variant="subtle"
        color="red"
        disabled={deleting}
        onClick={() => {
          setDeleteFailed(false);
          setConfirming(true);
        }}
      >
        Remove
      </Button>
      <Modal
        opened={confirming}
        onClose={() => setConfirming(false)}
        title="Remove from this browser"
        centered
        transitionProps={{ duration: 0 }}
      >
        {configurationOnly ? (
          <>
            <p>
              Remove {named}? This removes the settings this browser holds for
              it. It cannot be undone here.
            </p>
            <p className={`${styles.small} ${styles.sub}`}>
              The exchange itself runs from the alcove.yaml and .alcove.key on
              the machine you run it from. Removing it here changes nothing
              there, and your partner is not notified.
            </p>
          </>
        ) : (
          <>
            {unopenable ? (
              <p>
                Remove {named}? This removes everything this browser holds for
                it - the terms, the shared secret, its run history, its
                accounting of disclosures, and any results a scheduled run left
                here - in one step. It cannot be undone here. Part of its saved
                state cannot be read, so its accounting of disclosures cannot be
                read or exported, and is removed with the exchange.
              </p>
            ) : (
              <p>
                Remove {named}? This removes everything this browser holds for
                it - the terms, the shared secret, its run history, its
                accounting of disclosures, and any results a scheduled run left
                here for you to download - in one step. It cannot be undone
                here. Download those results and export the accounting first if
                you need to keep them.
              </p>
            )}
            <p className={`${styles.small} ${styles.sub}`}>
              This only removes your copy: your partner is not notified, and
              their own copy stands until they remove it or you re-invite.
            </p>
          </>
        )}
        {backedUp && (
          <p className={`${styles.small} ${styles.sub}`}>
            A backup file you exported stays in your custody - delete it
            yourself if you no longer want it. It remains a credential until the
            partnership rotates past it.
          </p>
        )}
        {deleteFailed && (
          <Alert
            role="alert"
            color="red"
            title="That exchange could not be removed"
            mb="sm"
          >
            Removing it from this browser failed. Nothing was removed; try
            again.
          </Alert>
        )}
        <div className={styles.savedRowActions} style={{ marginTop: "1rem" }}>
          <Button variant="default" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            color="red"
            variant="light"
            loading={deleting}
            onClick={confirmDelete}
          >
            Remove
          </Button>
        </div>
      </Modal>
    </>
  );
}

/** The first-run empty state: a designed surface, not a blank list. It explains what a
 * managed exchange is, offers creating one in the invite flow and accepting a recurring
 * invitation, and includes the standing import affordance for post-eviction recovery. A
 * wholesale eviction cannot be told from a first visit, so the import is offered here
 * standing rather than behind a detected loss. */
function SavedExchangesEmpty() {
  return (
    <>
      <p className={styles.sub}>
        A recurring exchange is a saved partnership with someone you exchange
        with again and again: its terms and a rotating shared secret are stored
        in this browser, so you can run it without a new invitation each time.
        You have none saved yet.
      </p>
      <p>
        <Button component="a" href={RECURRING_SETUP_HREF}>
          Set up a recurring exchange
        </Button>
      </p>
      <p className={`${styles.sub} ${styles.small}`}>
        Were you sent a recurring invitation?{" "}
        <Anchor inherit component={Link} to="/accept">
          Accept it
        </Anchor>{" "}
        and choose &quot;Save as a recurring exchange&quot; to save it here.
      </p>
      <ImportExchangeFile />
    </>
  );
}

/** The read-failed surface: the list opened but its records could not be read,
 * so the normal list ({@link listManagedExchanges}) rejects wholesale on the one
 * offending record. This surface adds a recovery listing built from a separate
 * diagnostic read ({@link listManagedExchangesDiagnostic}) that never rejects
 * wholesale: each stored entry appears with its label and side/date when
 * parseable, noted where part of its saved state is not, or "Unreadable
 * record" when the record itself is not, each with the same one-step
 * delete-by-key. A fresh import lands from this state, the store's reconciliation
 * skipping the entry it cannot parse, but it does not mend the list while that
 * record stands: the restore-from-backup affordance is a way straight to a run
 * surface, not the repair. */
function SavedExchangesFailed({ reload }: { reload: () => void }) {
  return (
    <>
      <p className={styles.sub}>
        Your recurring exchanges could not be read from this browser. One or
        more stored records is unreadable - likely from an old app version.
        Remove the record below to recover the rest, or import a backup file.
      </p>
      <RecoveryListing reload={reload} />
      <ImportExchangeFile />
    </>
  );
}

/** The recovery listing on the read-failed surface: the diagnostic read's
 * per-entry result, each row with the one-step delete-by-key. It loads on mount
 * from the diagnostic read (which never rejects wholesale), so an unreadable
 * record is identifiable and discardable even when the normal list cannot load.
 * A delete calls `reload`, which re-runs the whole load. If the diagnostic read
 * itself fails (the store's own failure, not a single bad record), the listing
 * is simply omitted and the restore affordance below still stands. */
function RecoveryListing({ reload }: { reload: () => void }) {
  const [rows, setRows] = useState<Array<RecoveryRow>>();
  useEffect(() => {
    let live = true;
    void listManagedExchangesDiagnostic()
      .then((entries) => {
        if (live) setRows(recoveryRows(entries));
      })
      .catch(() => {
        if (live) setRows([]);
      });
    return () => {
      live = false;
    };
  }, []);

  if (rows === undefined) return <Loader />;
  if (rows.length === 0) return null;

  return (
    <ul className={styles.savedList}>
      {rows.map((row) => (
        <li key={row.id} className={styles.savedRow}>
          <div className={styles.savedRowMain}>
            <span className={styles.savedRowLabel}>{row.label}</span>
            {!row.unreadable && (
              <span className={`${styles.small} ${styles.sub}`}>
                {row.sideLabel}
                {row.lastRunAt !== undefined
                  ? ` - last run ${row.lastRunAt}`
                  : ""}
              </span>
            )}
            {row.stateUnreadable && (
              <span className={`${styles.small} ${styles.sub}`}>
                {STATE_UNREADABLE_NOTE}
              </span>
            )}
          </div>
          <DeleteExchangeButton
            id={row.id}
            label={row.deleteLabel}
            backedUp={row.backedUp}
            unopenable={row.unreadable || row.stateUnreadable}
            onDeleted={reload}
          />
        </li>
      ))}
    </ul>
  );
}

/** What the import affordance shows when nothing was imported: the alert's color,
 * its heading, and the reason under it. */
interface ImportFailureAlert {
  color: "red" | "yellow";
  title: string;
  reason: string;
}

/** Which alert an import failure is shown as. The refusal the store raises is
 * about an exchange this browser holds rather than about the file, so it names the
 * exchange under its own heading; everything else is the file's own failure and is
 * shown as one. */
function importFailureAlert(error: unknown): ImportFailureAlert {
  if (error instanceof ManagedImportChosenCopyError)
    return {
      color: "yellow",
      title: CHOSEN_COPY_IMPORT_TITLE,
      reason: chosenCopyImportReason(error.reason, "backup"),
    };
  if (error instanceof ManagedImportAlreadyHeldError)
    return {
      color: "yellow",
      title: ALREADY_HELD_IMPORT_TITLE,
      reason: alreadyHeldBackupImportReason(error.label, error.stateUnreadable),
    };
  return {
    color: "red",
    title: IMPORT_FAILURE_TITLE,
    reason: importFailureReason(error),
  };
}

/** Which alert an alcove.yaml imported with its `.alcove.key` is refused with.
 * The store's refusals name an exchange this browser holds, each under its
 * own heading, in words that speak of the two files rather than a backup;
 * everything else is the files' own failure ({@link pairImportFailureReason}). */
function pairImportFailureAlert(error: unknown): ImportFailureAlert {
  if (error instanceof ManagedImportChosenCopyError)
    return {
      color: "yellow",
      title: CHOSEN_COPY_IMPORT_TITLE,
      reason: chosenCopyImportReason(error.reason, "files"),
    };
  if (error instanceof ManagedImportAlreadyHeldError)
    return {
      color: "yellow",
      title: ALREADY_HELD_IMPORT_TITLE,
      reason: alreadyHeldImportReason(error.label, error.stateUnreadable),
    };
  return {
    color: "red",
    title: IMPORT_FAILURE_TITLE,
    reason: pairImportFailureReason(error),
  };
}

/** The file type the import control offers in the file chooser beside its
 * own: the `.alcove.key` a configuration is imported with. */
const KEY_FILE_ACCEPT = ".key";

/** The files the import takes, and which of them runs the exchange here. */
const IMPORT_FILE_CHOICES =
  "Choose a backup file (.json) or an alcove.yaml. Add its .alcove.key to " +
  "run the exchange here.";

/** The note the import gives on choosing the key file: in the same selection
 * as its `alcove.yaml`, which is the only way the import pairs them, and
 * under a name starting with a dot, which file choosers hide by default. */
const KEY_FILE_CHOOSER_NOTE =
  "Choose both files at once. The key file's name starts with a dot, so " +
  "your file chooser may hide it.";

/** The standing import affordance, shared by every list state -- empty,
 * populated, and read-failed -- so all render one markup. It takes either file
 * the operator may hold:
 * the backup this app exports, and the `alcove.yaml` the command line runs,
 * which lands as a configuration-only exchange -- or, chosen with the
 * `.alcove.key` beside it, as one that runs here. The file decides which, not
 * the control ({@link importManagedExchangeFile}). A successful import puts the
 * operator on the imported exchange's own surface, so it is a way forward even
 * when the list read itself cannot be mended. A backup is reconciled against
 * the one exchange it holds, not against the list: one already here refuses,
 * and those that may be it -- the same agreed terms and side -- are named
 * together, and the operator replaces one of them with the backup, keeps
 * them, or adds the backup beside them all ({@link liveCopyImportReason}). A
 * pair whose secret no stored exchange holds is asked about the same way: the
 * operator completes a configuration-only exchange with the files, replaces
 * one that runs here, adds them as a new exchange, or cancels
 * ({@link storedCopyImportReason}).
 *
 * A file the import will not take is refused with the reason its failure has
 * ({@link importFailureReason}): a configuration this app cannot hold says what
 * it holds and what to remove, a document the artifact schema rejects can be a
 * newer build's export, which the operator cannot see from the file, while bytes
 * that do not parse at all leave only the file itself to check.
 *
 * An import that could not bring the source's working folder stops here
 * with that notice and a button onward, rather than taking the operator
 * straight to the exchange ({@link managedImportGrantNotice}): the folder is
 * what they have to choose again, and the notice is only read where it is
 * shown. A pair import stops the same way to say the exchange now runs
 * here, to name the settings it keeps without a control, and to name the
 * relay urls this browser's relay settings stand in for
 * ({@link pairImportedNotice}). An import with nothing to say goes
 * straight through. */
function ImportExchangeFile() {
  const {
    onFiles,
    outcome,
    importing,
    answerLiveCopy,
    answerStoredCopy,
    dismiss,
  } = useImportFile({
    maxBytes: MAX_IMPORT_FILE_BYTES,
    oversizeReason: UNREADABLE_IMPORT_REASON,
    importFile: (source, answer) =>
      importManagedExchangeFile(source, undefined, answer),
    failureAlert: importFailureAlert,
  });

  return (
    <div className={styles.importSection}>
      <p className={styles.calloutLead}>Import an exchange.</p>
      <p className={styles.small}>{IMPORT_FILE_CHOICES}</p>
      <p className={`${styles.small} ${styles.sub}`}>{KEY_FILE_CHOOSER_NOTE}</p>
      <ImportOutcomeAlerts
        outcome={outcome}
        onAnswerLiveCopy={answerLiveCopy}
        onAnswerStoredCopy={answerStoredCopy}
        onDismiss={dismiss}
      />
      <FileButton
        accept={`application/json,.json,application/yaml,.yaml,.yml,${KEY_FILE_ACCEPT}`}
        multiple
        onChange={onFiles}
        disabled={importing}
      >
        {(props) => (
          <Button mt="sm" variant="default" loading={importing} {...props}>
            Import a file
          </Button>
        )}
      </FileButton>
    </div>
  );
}

/** What an import control shows once a file has been tried: a notice with the
 * way onward, or the refusal. */
interface ImportOutcome {
  grantNotice?: { id: string; notice: ManagedImportGrantNotice };
  failure?: ImportFailureAlert;
  /** The listed exchanges a backup may be a copy of, and the file to replace
   * one of them with, or import beside them all, on the operator's word. */
  liveCopy?: {
    copies: ReadonlyArray<ManagedStoredCopy>;
    file: File;
  };
  /** The stored exchanges a pair may belong to, and the two files to take
   * into one of them, or install beside them all, on the operator's word. */
  storedCopy?: {
    copies: ReadonlyArray<ManagedStoredCopy>;
    configurationFile: File;
    keyFile: File;
  };
}

/** A refusal under the heading every file refusal takes. */
function fileRefusal(reason: string): ImportOutcome {
  return {
    failure: { color: "red", title: IMPORT_FAILURE_TITLE, reason },
  };
}

/** Read the chosen files and go to the imported exchange, or hold the notice or
 * refusal the control shows instead. A backup that may be a copy of listed
 * exchanges is held with their names until the operator answers: replacing
 * one or adding it beside all of them imports the file again with that
 * answer, and keeping them imports nothing. A pair that may belong to a stored
 * exchange is held the same way until the operator takes it into one, adds it
 * beside them all, or dismisses it. One file goes through `importFile`; a
 * configuration with its key file through {@link importManagedCommandLinePair},
 * whichever control took them. A file over its cap -- `maxBytes` for the one
 * file or the configuration, the key file's own for the key -- is refused with
 * its reason before any file is read. While one import is in flight the
 * control is withheld and a further pick is ignored, so one pick of a pair
 * cannot race a second into installing the same secret twice. */
function useImportFile({
  maxBytes,
  oversizeReason,
  importFile,
  failureAlert,
}: {
  maxBytes: number;
  oversizeReason: string;
  importFile: (
    source: string,
    answer?: ManagedBackupImportOptions,
  ) => Promise<ManagedImportResult>;
  failureAlert: (error: unknown) => ImportFailureAlert;
}): {
  onFiles: (files: Array<File>) => void;
  outcome: ImportOutcome;
  importing: boolean;
  answerLiveCopy: (answer: ManagedBackupImportOptions) => void;
  answerStoredCopy: (answer: ManagedPairImportOptions) => void;
  dismiss: () => void;
} {
  const navigate = useNavigate();
  const [outcome, setOutcome] = useState<ImportOutcome>({});
  const [importing, setImporting] = useState(false);
  // The state renders the withheld control; the ref refuses a pick that lands
  // before that render does.
  const inFlight = useRef(false);

  function onFiles(files: Array<File>) {
    if (inFlight.current) return;
    const choice = managedImportFileChoice(files);
    if (choice === undefined) return;
    setOutcome({});
    if (choice.kind === "refused") {
      setOutcome(fileRefusal(choice.reason));
      return;
    }
    const primaryFile =
      choice.kind === "one" ? choice.file : choice.configurationFile;
    const keyFile = choice.kind === "pair" ? choice.keyFile : undefined;
    // Cap each file before reading it: every file here is a small operator-held
    // document, so an over-cap one is refused rather than read into memory ahead
    // of the bounded parse.
    if (primaryFile.size > maxBytes) {
      setOutcome(fileRefusal(oversizeReason));
      return;
    }
    if (keyFile !== undefined && keyFile.size > MAX_KEY_FILE_IMPORT_BYTES) {
      setOutcome(fileRefusal(OVERSIZE_KEY_FILE_REASON));
      return;
    }
    runImport(primaryFile, keyFile);
  }

  function runImport(
    primaryFile: File,
    keyFile: File | undefined,
    backupAnswer: ManagedBackupImportOptions = {},
    pairAnswer: ManagedPairImportOptions = {},
  ) {
    const refused =
      keyFile === undefined ? failureAlert : pairImportFailureAlert;
    inFlight.current = true;
    setImporting(true);
    void (async () => {
      try {
        const source = await primaryFile.text();
        const keySource =
          keyFile === undefined ? undefined : await keyFile.text();
        // Best-effort persistence on the imported record's origin, the same request
        // a create makes; a denied grant does not fail the import.
        void requestPersistentStorage();
        const { record, missingGrants, droppedTurnUrls, unreadKeyFileFields } =
          keySource === undefined
            ? await importFile(source, backupAnswer)
            : await importManagedCommandLinePair(
                source,
                keySource,
                undefined,
                pairAnswer,
              );
        const notice =
          keySource === undefined
            ? managedImportGrantNotice(missingGrants)
            : pairImportedNotice(record, {
                turnUrls: droppedTurnUrls,
                keyFileFields: unreadKeyFileFields,
              });
        if (notice !== undefined) {
          setOutcome({ grantNotice: { id: record.id, notice } });
          return;
        }
        await navigate({ to: "/saved/$id", params: { id: record.id } });
      } catch (error) {
        if (error instanceof ManagedImportLiveCopyError)
          setOutcome({ liveCopy: { copies: error.copies, file: primaryFile } });
        else if (
          error instanceof ManagedImportStoredCopyError &&
          keyFile !== undefined
        )
          setOutcome({
            storedCopy: {
              copies: error.copies,
              configurationFile: primaryFile,
              keyFile,
            },
          });
        else setOutcome({ failure: refused(error) });
      } finally {
        inFlight.current = false;
        setImporting(false);
      }
    })();
  }

  function answerLiveCopy(answer: ManagedBackupImportOptions) {
    const { liveCopy } = outcome;
    if (liveCopy === undefined || inFlight.current) return;
    setOutcome({});
    runImport(liveCopy.file, undefined, answer);
  }

  function answerStoredCopy(answer: ManagedPairImportOptions) {
    const { storedCopy } = outcome;
    if (storedCopy === undefined || inFlight.current) return;
    setOutcome({});
    runImport(storedCopy.configurationFile, storedCopy.keyFile, {}, answer);
  }

  return {
    onFiles,
    outcome,
    importing,
    answerLiveCopy,
    answerStoredCopy,
    dismiss: () => setOutcome({}),
  };
}

/** The alerts an import control shows under its lead: the grant notice with its
 * button onward, the question a possible copy of a listed exchange asks, and the
 * refusal. */
function ImportOutcomeAlerts({
  outcome,
  onAnswerLiveCopy,
  onAnswerStoredCopy,
  onDismiss,
}: {
  outcome: ImportOutcome;
  onAnswerLiveCopy: (answer: ManagedBackupImportOptions) => void;
  onAnswerStoredCopy: (answer: ManagedPairImportOptions) => void;
  onDismiss: () => void;
}) {
  const navigate = useNavigate();
  const { grantNotice, failure, liveCopy, storedCopy } = outcome;
  const liveCopyLabels = liveCopy?.copies.map(({ label }) => label) ?? [];
  return (
    <>
      {storedCopy !== undefined && (
        <Alert color="yellow" title={STORED_COPY_IMPORT_TITLE} mb="sm">
          <p className={styles.small}>
            {storedCopyImportReason(storedCopy.copies)}
          </p>
          <div className={styles.savedRowActions}>
            {storedCopy.copies.map(({ id }, index) => (
              <Button
                key={id}
                variant="default"
                onClick={() => onAnswerStoredCopy({ into: id })}
              >
                {storedCopyTakeLabel(storedCopy.copies, index)}
              </Button>
            ))}
            <Button
              variant="default"
              onClick={() =>
                onAnswerStoredCopy({
                  besideIds: storedCopy.copies.map(({ id }) => id),
                })
              }
            >
              {STORED_COPY_IMPORT_CONFIRM}
            </Button>
            <Button variant="subtle" onClick={onDismiss}>
              Cancel
            </Button>
          </div>
        </Alert>
      )}
      {liveCopy !== undefined && (
        <Alert color="yellow" title={LIVE_COPY_IMPORT_TITLE} mb="sm">
          <p className={styles.small}>
            {liveCopyImportReason(liveCopy.copies)}
          </p>
          <div className={styles.savedRowActions}>
            {liveCopy.copies.map(({ id }, index) => (
              <Button
                key={id}
                variant="default"
                onClick={() => onAnswerLiveCopy({ into: id })}
              >
                {liveCopyReplaceLabel(liveCopyLabels, index)}
              </Button>
            ))}
            <Button variant="default" onClick={onDismiss}>
              {liveCopyKeepLabel(liveCopy.copies.length)}
            </Button>
            <Button
              variant="subtle"
              onClick={() =>
                onAnswerLiveCopy({
                  besideIds: liveCopy.copies.map(({ id }) => id),
                })
              }
            >
              {LIVE_COPY_IMPORT_CONFIRM}
            </Button>
          </div>
        </Alert>
      )}
      {grantNotice !== undefined && (
        <Alert color="yellow" title={grantNotice.notice.title} mb="sm">
          <p className={styles.small}>{grantNotice.notice.lead}</p>
          <ul className={styles.small}>
            {grantNotice.notice.consequences.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <Button
            mt="sm"
            onClick={() =>
              void navigate({
                to: "/saved/$id",
                params: { id: grantNotice.id },
              })
            }
          >
            Open this exchange
          </Button>
        </Alert>
      )}
      {failure !== undefined && (
        <Alert
          color={failure.color}
          role={alertRoleFor(failure.color)}
          title={failure.title}
          mb="sm"
        >
          {failure.reason}
        </Alert>
      )}
    </>
  );
}
