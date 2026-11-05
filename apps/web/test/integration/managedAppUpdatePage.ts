import {
  APP_UPDATE_TAKEOVER_WAIT_MS,
  applyWaitingAppUpdateBetweenRuns,
} from "@psi/managed/managedAppUpdate";
import { appShellUpdateReady, registerAppShell } from "@utils/appShellUpdate";

// The page serviceWorkerUpdateCheck.test.ts bundles and serves: the app's own
// registration and its scheduled runner's between-runs apply, with nothing
// else of the app around them.

/** What the page exposes to the test driving it. */
export interface ManagedAppUpdatePage {
  /** Settles once the app's registration has run. */
  registered: Promise<void>;
  updateReady: () => boolean;
  /** The apply the scheduled runner makes before a window's first attempt. */
  applyBetweenRuns: () => Promise<boolean>;
  /** How long that apply waits for a takeover to land. */
  takeoverWaitMs: number;
  /** When this document was loaded, which a reload changes. */
  loadedAt: number;
}

declare global {
  interface Window {
    managedAppUpdatePage: ManagedAppUpdatePage;
  }
}

window.managedAppUpdatePage = {
  registered: registerAppShell(navigator.serviceWorker),
  updateReady: appShellUpdateReady,
  applyBetweenRuns: () =>
    applyWaitingAppUpdateBetweenRuns().then(
      (outcome) => outcome.kind === "applying",
    ),
  takeoverWaitMs: APP_UPDATE_TAKEOVER_WAIT_MS,
  loadedAt: performance.timeOrigin,
};
