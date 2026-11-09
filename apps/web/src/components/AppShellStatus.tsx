import { useEffect, useState, useSyncExternalStore } from "react";

import { Alert, Button, VisuallyHidden } from "@mantine/core";

import {
  appShellUpdateApplying,
  appShellUpdateReady,
  applyAppShellUpdate,
  subscribeAppShellUpdate,
  takeAutomaticAppShellUpdateNotice,
} from "@utils/appShellUpdate";
import { readAppUpdateHolders } from "@psi/managed/managedAppUpdate";

import {
  AUTOMATIC_UPDATE_APPLIED_TEXT,
  updateReadyText,
} from "./appShellUpdateCopy";
import { useDeferredAnnouncement } from "./useDeferredAnnouncement";
import { useOnlineStatus } from "./useOnlineStatus";

import type { AppUpdateHolder } from "@utils/appUpdateHolder";

/** The offline strip's title, and what the shell's polite region announces for
 * it -- the strip's body stays in reading order. */
const OFFLINE_TITLE = "You are offline";

/** The waiting-update strip's title, announced the same way. */
const UPDATE_READY_TITLE = "A new version of Alcove is ready";

/** The strip's title while the scheduled runner applies the update. */
const UPDATE_APPLYING_TITLE = "Alcove is updating";

/** How often the strip reads what holds the update back, which another window
 * can change with no event here. An arbitrary working value. */
const UPDATE_HOLD_REFRESH_MS = 5_000;

/** Whether a newer app version is installed and waiting. Always `false` on the
 * server, which registers no worker. */
function useAppShellUpdateReady(): boolean {
  return useSyncExternalStore(
    subscribeAppShellUpdate,
    appShellUpdateReady,
    () => false,
  );
}

/** Whether the scheduled runner is applying the update now. */
function useAppShellUpdateApplying(): boolean {
  return useSyncExternalStore(
    subscribeAppShellUpdate,
    appShellUpdateApplying,
    () => false,
  );
}

/** What holds the waiting update back, read again every
 * {@link UPDATE_HOLD_REFRESH_MS} while `reading`. */
function useAppUpdateHolders(reading: boolean): ReadonlyArray<AppUpdateHolder> {
  const [holders, setHolders] = useState<ReadonlyArray<AppUpdateHolder>>([]);
  useEffect(() => {
    if (!reading) return;
    let current = true;
    const read = () => {
      void readAppUpdateHolders().then((found) => {
        if (current) setHolders(found.holders);
      });
    };
    read();
    const timer = setInterval(read, UPDATE_HOLD_REFRESH_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [reading]);
  return reading ? holders : [];
}

/** Whether the scheduled runner applied an update just before this page
 * loaded. Read once per page, after hydration. */
let automaticApplyNotice: boolean | undefined;
function useAutomaticApplyNotice(): [boolean, () => void] {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    automaticApplyNotice ??= takeAutomaticAppShellUpdateNotice();
    setShown(automaticApplyNotice);
  }, []);
  return [
    shown,
    () => {
      automaticApplyNotice = false;
      setShown(false);
    },
  ];
}

/**
 * The shell-wide status strip: what the app cannot do right now, above whatever
 * route is rendering.
 *
 * OFFLINE. The app shell and the recurring-exchange list are served from the
 * service worker's cache and read the browser's own store, so they render with
 * no network -- but an exchange is a live two-party session and cannot. Stating
 * it once at the shell keeps the warning off the surfaces that still work and
 * names the action that cannot run, rather than letting it fail when the
 * operator presses it.
 *
 * UPDATE READY. A new deployment's worker waits rather than swapping code under
 * a running page, so applying it is an explicit reload, or the scheduled
 * runner's own apply. The strip names what holds the update back and how to
 * release it, and states when the runner is applying it. See
 * `apps/web/src/utils/appShellUpdate.ts`.
 *
 * UPDATED. A page the runner reloaded onto an update states that once.
 *
 * ANNOUNCING. The polite region lives as long as the shell, holding nothing in
 * the ordinary case, so a strip that appears mid-session reaches an assistive
 * technology as a change to a region it is already observing rather than as a
 * freshly inserted node. Each Alert takes `role="presentation"` to displace the
 * Alert's live-region default, which would announce the same strip a second
 * time.
 *
 * Nothing is shown when the browser is online and no update is waiting, which is
 * the ordinary case.
 */
export function AppShellStatus() {
  const online = useOnlineStatus();
  const updateReady = useAppShellUpdateReady();
  const applying = useAppShellUpdateApplying();
  const holders = useAppUpdateHolders(updateReady && !applying);
  const [updated, dismissUpdated] = useAutomaticApplyNotice();
  const updateTitle = applying ? UPDATE_APPLYING_TITLE : UPDATE_READY_TITLE;
  const announcement = useDeferredAnnouncement(
    [
      online ? "" : OFFLINE_TITLE,
      updateReady || applying ? updateTitle : "",
      updated ? AUTOMATIC_UPDATE_APPLIED_TEXT : "",
    ]
      .filter((sentence) => sentence !== "")
      .join(". "),
  );

  return (
    <>
      <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </VisuallyHidden>
      {!online && (
        <Alert
          color="warn"
          variant="light"
          radius={0}
          role="presentation"
          title={OFFLINE_TITLE}
        >
          Your recurring exchanges and their details are stored in this browser
          and open without a connection. Running an exchange does need one - it
          takes you and your partner online at the same time.
        </Alert>
      )}
      {applying && (
        <Alert
          color="info"
          variant="light"
          radius={0}
          role="presentation"
          title={UPDATE_APPLYING_TITLE}
        >
          The page reloads in a moment.
        </Alert>
      )}
      {updateReady && !applying && (
        <Alert
          color="info"
          variant="light"
          radius={0}
          role="presentation"
          title={UPDATE_READY_TITLE}
        >
          {updateReadyText(holders)}{" "}
          <Button
            size="compact-sm"
            variant="default"
            onClick={applyAppShellUpdate}
          >
            Reload
          </Button>
        </Alert>
      )}
      {updated && (
        <Alert
          color="info"
          variant="light"
          radius={0}
          role="presentation"
          withCloseButton
          closeButtonLabel="Dismiss"
          onClose={dismissUpdated}
          title={AUTOMATIC_UPDATE_APPLIED_TEXT}
        />
      )}
    </>
  );
}
