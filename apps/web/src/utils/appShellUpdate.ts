/**
 * Registration of the app-shell service worker (`apps/web/public/serviceWorker.js`)
 * and the store behind the "an update is ready" surface.
 *
 * The worker never calls `skipWaiting()` on install, so a new deployment's code
 * sits in the `waiting` state behind the worker running this page rather than
 * swapping under it mid-exchange (the reasoning is in the worker's own header).
 * This module is the other half of that: it notices the waiting worker, publishes
 * it so the shell can say so, and applies it -- with a reload -- only when the
 * operator asks. A waiting worker that is never applied still takes over at the
 * next cold start; the prompt shortens that wait, it is not what bounds it.
 *
 * Applying is ordered so that the reload leads and the takeover follows it: the
 * message that ends the wait is posted as the page unloads, which is the first
 * moment the reload is known to be happening. A reload the operator declines at
 * the browser's own confirmation therefore costs nothing -- the page keeps its
 * code, the update keeps waiting, and the banner's Reload applies it whenever
 * the operator is ready.
 *
 * The installed app's scheduled runner also applies a waiting update between
 * runs when nothing would be lost
 * (`apps/web/src/psi/managed/managedAppUpdate.ts`), in the other order: with
 * nobody there to decline a reload, it has the worker take over first
 * ({@link takeOverWaitingAppShell}) and reloads only once the takeover has
 * landed, so the reloaded page loads under the new worker. It asks the browser
 * to look for a new deployment through {@link checkForAppShellUpdate}.
 */

/** The worker's URL. It is served from `public/`, so its scope is the origin
 * root -- which is what lets it handle navigations to every route. */
const SERVICE_WORKER_URL = "/serviceWorker.js";

/** The message that makes a waiting worker take over now. Mirrored by
 * `SKIP_WAITING_MESSAGE` in `apps/web/public/serviceWorker.js`. */
export const SKIP_WAITING_MESSAGE = "alcove-skip-waiting";

/** The message that has the worker cache every route's code, not just the
 * shell's. Mirrored by `WARM_ROUTES_MESSAGE` in
 * `apps/web/public/serviceWorker.js`. */
export const WARM_ROUTES_MESSAGE = "alcove-warm-routes";

/** The subset of `ServiceWorker` this module drives. Structural, so a test can
 * supply a plain object in place of a real worker. */
export interface ShellWorker {
  readonly state: string;
  readonly postMessage: (message: unknown) => void;
  readonly addEventListener: (
    type: "statechange",
    listener: () => void,
  ) => void;
}

/** The subset of `ServiceWorkerRegistration` this module drives. */
interface ShellRegistration {
  readonly installing: ShellWorker | null;
  readonly waiting: ShellWorker | null;
  readonly addEventListener: (
    type: "updatefound",
    listener: () => void,
  ) => void;
  readonly update: () => Promise<unknown>;
}

/** The subset of `ServiceWorkerContainer` this module drives. */
export interface ShellContainer {
  readonly controller: ShellWorker | null;
  readonly register: (
    scriptUrl: string,
    options: { scope: string; updateViaCache: "none" },
  ) => Promise<ShellRegistration>;
  readonly addEventListener: (
    type: "controllerchange",
    listener: () => void,
  ) => void;
}

let shellContainer: ShellContainer | undefined;
let registration: ShellRegistration | undefined;
/** The operator's Reload has armed the takeover for this page's unload. */
let takeoverArmed = false;
/** The scheduled runner has posted the takeover ahead of any reload. */
let takeoverPosted = false;
/** A takeover this page asked for has landed: the worker controlling the page
 * is a newer deployment than the page's own code. */
let controllerAheadOfPage = false;
/** The scheduled runner is waiting for the takeover it posted to land. */
let takeoverWaiting = false;
let publishedReady = false;
let publishedApplying = false;
let applyUpdate: (() => void) | undefined;
const listeners = new Set<() => void>();
const takeoverWaiters = new Set<() => void>();

function publish(): void {
  const ready = appShellUpdateReady();
  const applying = appShellUpdateApplying();
  if (publishedReady === ready && publishedApplying === applying) return;
  publishedReady = ready;
  publishedApplying = applying;
  for (const listener of listeners) listener();
}

/** Whether the scheduled runner is applying the update now: it has asked the
 * waiting worker to take over and is waiting for that to land. */
export function appShellUpdateApplying(): boolean {
  return takeoverWaiting;
}

/** The session-storage key the runner's apply leaves for the reloaded page. */
const AUTOMATIC_APPLY_NOTICE_KEY = "alcove-app-updated-before-run";

/** This tab's session storage, or `undefined` where it has none. */
function tabStorage(): Storage | undefined {
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage;
  } catch {
    return undefined;
  }
}

/** Leave a note for the reloaded page that the runner applied the update.
 * Session storage outlives the reload and stays in this tab. */
export function noteAutomaticAppShellUpdate(): void {
  try {
    tabStorage()?.setItem(AUTOMATIC_APPLY_NOTICE_KEY, "1");
  } catch {
    // A full or blocked store loses only the line after the reload.
  }
}

/** Whether the runner applied the update before this page loaded, removing the
 * note so each apply is reported once. */
export function takeAutomaticAppShellUpdateNotice(): boolean {
  try {
    const storage = tabStorage();
    if (storage?.getItem(AUTOMATIC_APPLY_NOTICE_KEY) == null) return false;
    storage.removeItem(AUTOMATIC_APPLY_NOTICE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a newer app version is ready for this page: a worker other than the
 * one controlling the page is waiting, read off the registration at the moment
 * of asking, or a takeover this page asked for has landed under code that is
 * now older than its controller. A page loaded under the newest worker is never
 * ready, however the takeover that put it there went.
 */
export function appShellUpdateReady(): boolean {
  if (controllerAheadOfPage) return true;
  const controller = shellContainer?.controller ?? null;
  const waiting = registration?.waiting ?? null;
  return controller !== null && waiting !== null && waiting !== controller;
}

/** Subscribe to {@link appShellUpdateReady} and {@link appShellUpdateApplying}
 * changes; returns the unsubscribe. */
export function subscribeAppShellUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The environment `registerAppShell` reads through, injectable so a test can
 * drive both without a browser. */
interface RegisterAppShellOptions {
  /** Reload onto newly activated code. Defaults to the page's own reload. */
  reload?: () => void;
  /** Call `listener` when this page is going away for good. Defaults to a
   * `pagehide` listener that ignores a persisted one: that is the back/forward
   * cache freezing the page, which can be restored still running this code. */
  onPageUnloading?: (listener: () => void) => void;
}

/**
 * Register the worker, watch for a newer one, and have it cache every route's
 * code. Resolves whether or not the registration succeeded, so the call site
 * can fire it and move on.
 *
 * `updateViaCache: "none"` keeps the browser's HTTP cache out of the worker
 * script's own update check, so a redeployed worker is seen on the next check.
 *
 * A newly `installed` worker is only an UPDATE when a controller is already
 * running this page; without one it is the first install.
 *
 * The route warm is asked for at registration, and again on a controller change
 * so a first install, which has no controller at registration, is not missed.
 * It is not asked for at a registration that finds a worker waiting: the
 * outgoing worker's takeover waits for a warm in flight, and the new worker
 * warms once it controls the page. Cost and rationale: the worker's
 * `SHELL_ROUTES`.
 */
export async function registerAppShell(
  container: ShellContainer,
  options: RegisterAppShellOptions = {},
): Promise<void> {
  const reload =
    options.reload ??
    (() => {
      window.location.reload();
    });
  const onPageUnloading =
    options.onPageUnloading ??
    ((listener: () => void) => {
      window.addEventListener("pagehide", (event) => {
        if (!event.persisted) listener();
      });
    });
  function warmRoutes(): void {
    container.controller?.postMessage(WARM_ROUTES_MESSAGE);
  }
  shellContainer = container;
  container.addEventListener("controllerchange", () => {
    // A page that has asked for a takeover is on its way out, on this reload or
    // a later one, so it is the wrong place to start the several megabytes a
    // warm costs; the page that replaces it warms at its own registration.
    if (takeoverArmed || takeoverPosted) {
      controllerAheadOfPage = true;
      for (const landed of takeoverWaiters) landed();
      publish();
      return;
    }
    publish();
    warmRoutes();
  });
  applyUpdate = () => {
    const waiting = registration?.waiting;
    if (waiting === null || waiting === undefined) {
      if (appShellUpdateReady()) reload();
      return;
    }
    if (!takeoverArmed) {
      takeoverArmed = true;
      // Read the waiting worker again at unload rather than closing over the one
      // above: an update declined once can be superseded by a newer one before
      // the page finally goes.
      onPageUnloading(() => {
        registration?.waiting?.postMessage(SKIP_WAITING_MESSAGE);
      });
    }
    reload();
  };
  try {
    registration = await container.register(SERVICE_WORKER_URL, {
      scope: "/",
      updateViaCache: "none",
    });
  } catch {
    // register() rejects on a network failure -- a first load that is already
    // offline, the case this feature exists for -- and on a script or security
    // error. What is lost is the offline shell, not a capability: an
    // uncontrolled page fetches everything from the network and works. This
    // degrades in silence, the way the worker's own precache does.
    return;
  }
  if (registration.waiting === null) warmRoutes();
  // A worker installed on an earlier visit and never applied is already waiting
  // by the time this runs, so there is no `updatefound` left to hear.
  registration.waiting?.addEventListener("statechange", publish);
  publish();
  registration.addEventListener("updatefound", () => {
    const installing = registration?.installing;
    if (installing === null || installing === undefined) return;
    installing.addEventListener("statechange", publish);
  });
}

/**
 * Have the waiting worker take over now, ahead of any reload, and resolve
 * whether the worker controlling this page is then newer than the page's own
 * code, so that a reload loads the new version under the new worker.
 *
 * Resolves `true` at once where a takeover this page asked for has already
 * landed, and `false`, posting nothing, where no update is ready. Resolves
 * `false` when `boundMs` passes before the takeover lands: the outgoing worker
 * holds it back while it finishes work in flight, such as a route warm. The
 * takeover is still posted, and lands when that work ends; a later call then
 * resolves `true`.
 *
 * Unlike {@link applyAppShellUpdate}, nothing here can be declined, so the
 * caller first makes sure no window would lose anything to the takeover.
 */
export function takeOverWaitingAppShell(boundMs: number): Promise<boolean> {
  if (controllerAheadOfPage) return Promise.resolve(true);
  const waiting = registration?.waiting ?? null;
  if (waiting === null || !appShellUpdateReady()) return Promise.resolve(false);
  return new Promise((resolve) => {
    const landed = () => {
      clearTimeout(timer);
      takeoverWaiters.delete(landed);
      takeoverWaiting = false;
      resolve(true);
    };
    const timer = setTimeout(() => {
      takeoverWaiters.delete(landed);
      takeoverWaiting = false;
      publish();
      resolve(false);
    }, boundMs);
    takeoverWaiters.add(landed);
    takeoverPosted = true;
    takeoverWaiting = true;
    publish();
    waiting.postMessage(SKIP_WAITING_MESSAGE);
  });
}

/**
 * Apply the waiting update: reload the page, and tell the waiting worker to
 * take over as that page unloads. The order is what makes the apply
 * recoverable -- the reload can still be stopped, by the confirmation a live
 * exchange arms (`apps/web/src/exchange/useUnloadGuard.ts`), and a stopped one
 * leaves the update waiting and this function ready to run again.
 *
 * The takeover is armed once and stays armed: an operator who declines the
 * reload and later closes the page has still asked for the update.
 *
 * When no worker is waiting but a takeover this page asked for has landed --
 * the operator declined the reload and another tab applied the update, or the
 * scheduled runner's takeover landed after it stopped waiting -- the apply is
 * a plain reload onto the activated code.
 *
 * Does nothing before `registerAppShell` has a registration, or when no update
 * is ready ({@link appShellUpdateReady}).
 */
export function applyAppShellUpdate(): void {
  applyUpdate?.();
}

/**
 * Ask the browser to fetch the worker script now and compare it with the one
 * installed. A redeployed script installs and is announced as an update the way
 * one found on a navigation is.
 *
 * Chromium checks at a navigation and not for a page that makes requests but
 * no navigation, so an installed app left open to run its schedule would
 * otherwise not see a new deployment
 * (`apps/web/test/integration/serviceWorkerUpdateCheck.test.ts`, which does
 * not wait out the browser's longer timers).
 *
 * Never rejects: a failed check, offline included, leaves things as they were.
 * Does nothing before `registerAppShell` has a registration.
 */
export async function checkForAppShellUpdate(): Promise<void> {
  try {
    await registration?.update();
  } catch {
    // Offline, or the origin failed; the next check or navigation tries again.
  }
}

/** @internal */
export function resetAppShellUpdate(): void {
  shellContainer = undefined;
  registration = undefined;
  takeoverArmed = false;
  takeoverPosted = false;
  controllerAheadOfPage = false;
  takeoverWaiting = false;
  publishedReady = false;
  publishedApplying = false;
  applyUpdate = undefined;
  listeners.clear();
  takeoverWaiters.clear();
}
