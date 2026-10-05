import { useLayoutEffect, useSyncExternalStore } from "react";

/**
 * The browser's offer to install this app, held so a page can show its own
 * install button.
 *
 * Only Chromium-based browsers fire `beforeinstallprompt`, once per page load
 * and as early as the page qualifies, so {@link captureInstallPrompt} is
 * attached at startup (`client.tsx`) rather than by the component that shows
 * the button: a listener added when that component mounts would miss an event
 * that already fired. Where the event never fires, no button is shown and the
 * page gives the browser's own instructions instead.
 *
 * The offer is held, and the browser's own install banner suppressed, only
 * when it arrives while a page showing the button is mounted
 * ({@link useHoldsInstallOffer}). An offer arriving on any other page is left
 * to the browser and not held, so a button page opened later gives the
 * browser's own instructions: a browser may refuse a prompt on an offer it has
 * already shown.
 */

/** The non-standard event Chromium fires when the page can be installed. The
 * DOM lib does not type it. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<unknown>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** What answering the install prompt came to: `unavailable` where no offer
 * was held, or the browser refused to show it. */
export type InstallPromptOutcome = "accepted" | "dismissed" | "unavailable";

/** The install state a page reads. */
export interface InstallPromptState {
  /** Whether the browser's install offer is held, so a button can show it. */
  available: boolean;
  /** Whether the app was installed while this page was open. */
  installedFromThisPage: boolean;
}

const NO_OFFER: InstallPromptState = {
  available: false,
  installedFromThisPage: false,
};

let heldOffer: BeforeInstallPromptEvent | undefined;
let state: InstallPromptState = NO_OFFER;
const listeners = new Set<() => void>();
let mountedButtonPages = 0;
const capturedTargets = new WeakSet<EventTarget>();

function setState(next: InstallPromptState): void {
  state = next;
  for (const listener of listeners) listener();
}

function isInstallPromptEvent(event: Event): event is BeforeInstallPromptEvent {
  return (
    typeof (event as Partial<BeforeInstallPromptEvent>).prompt === "function"
  );
}

/**
 * Start holding the install offer `target` receives. Safe to call more than
 * once for the same target. While a page showing the install button is
 * mounted, the offer is held with `preventDefault` so that page decides when to
 * show it; otherwise it is left to the browser and any earlier offer dropped.
 */
export function captureInstallPrompt(target: EventTarget): void {
  if (capturedTargets.has(target)) return;
  capturedTargets.add(target);
  target.addEventListener("beforeinstallprompt", (event) => {
    if (!isInstallPromptEvent(event)) return;
    if (mountedButtonPages === 0) {
      heldOffer = undefined;
      setState({ ...state, available: false });
      return;
    }
    event.preventDefault();
    heldOffer = event;
    setState({ ...state, available: true });
  });
  target.addEventListener("appinstalled", () => {
    heldOffer = undefined;
    setState({ available: false, installedFromThisPage: true });
  });
}

/**
 * Show the browser's install prompt. The held offer is spent whatever the
 * answer, since the browser allows one prompt per offer; a later offer arrives
 * as a fresh event.
 */
export async function showInstallPrompt(): Promise<InstallPromptOutcome> {
  const offer = heldOffer;
  if (offer === undefined) return "unavailable";
  heldOffer = undefined;
  setState({ ...state, available: false });
  try {
    await offer.prompt();
    const { outcome } = await offer.userChoice;
    return outcome;
  } catch {
    return "unavailable";
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Count the caller as a page showing the install button until the returned
 * function is called: an offer arriving meanwhile is held for it.
 */
export function holdInstallOffer(): () => void {
  mountedButtonPages += 1;
  return () => {
    mountedButtonPages -= 1;
  };
}

/** Called by a component that shows the install button, so an offer arriving
 * while it is mounted is held for it ({@link holdInstallOffer}). */
export function useHoldsInstallOffer(): void {
  useLayoutEffect(() => holdInstallOffer(), []);
}

/** The install state, re-rendering when an offer arrives, is spent, or the
 * app is installed. Server rendering reads no offer. */
export function useInstallPrompt(): InstallPromptState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => NO_OFFER,
  );
}

/** @internal */
export function resetInstallPromptForTest(): void {
  heldOffer = undefined;
  setState(NO_OFFER);
}
