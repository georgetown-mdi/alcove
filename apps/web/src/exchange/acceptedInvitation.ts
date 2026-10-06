import { useEffect, useState } from "react";

import { getLogger } from "@alcove/core";

import { whenDiagnostic } from "@utils/diagnostics";

/**
 * Where the acceptor's encoded invitation lives once the page has read it. The
 * deep link carries it in the URL fragment; the page takes it from there, removes
 * it from the address bar and the history entry, and keeps one copy in this tab's
 * session storage so a reload lands on the same invitation. That copy is removed
 * when the screen is left, when the invitation is refused, and when the exchange
 * completes (see docs/SECURITY_DESIGN.md, "Invitation contents and
 * confidentiality").
 */

const log = getLogger("acceptedInvitation");

/** The session-storage key the acceptor's invitation is kept under. */
export const ACCEPTED_INVITATION_STORAGE_KEY = "alcove-accepted-invitation";

function storage(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

/** Keep `encoded` for a reload of this tab, best-effort: a storage failure is
 * dev-logged and a reload then finds no invitation. */
function keepAcceptedInvitation(encoded: string): void {
  try {
    storage()?.setItem(ACCEPTED_INVITATION_STORAGE_KEY, encoded);
  } catch (error) {
    whenDiagnostic(() => log.warn("accepted invitation write failed:", error));
  }
}

/** Remove the tab's kept invitation, if any. */
export function forgetAcceptedInvitation(): void {
  try {
    storage()?.removeItem(ACCEPTED_INVITATION_STORAGE_KEY);
  } catch (error) {
    whenDiagnostic(() =>
      log.warn("accepted invitation removal failed:", error),
    );
  }
}

function keptAcceptedInvitation(): string {
  try {
    return storage()?.getItem(ACCEPTED_INVITATION_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

/** The fragment of the current address, without its `#`. */
function addressFragment(): string {
  return window.location.hash.replace(/^#/, "");
}

/**
 * Take the invitation out of the address: keep it for a reload, then rewrite the
 * current history entry without the fragment. `replaceState` keeps the entry's
 * state, so the router's index and the step-history marker are untouched.
 */
function takeFromAddress(encoded: string): void {
  keepAcceptedInvitation(encoded);
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname + window.location.search,
  );
}

/**
 * The encoded invitation the acceptor screen works on: `undefined` until the
 * address has been read, then the fragment's token, or the tab's kept copy where
 * the address holds none (a reload), or `""` where neither does. A fragment
 * arriving later -- a second invitation pasted into the address bar of the same
 * tab -- replaces it. The fragment is cleared from the address each time it is
 * read, and the kept copy is removed when the screen unmounts.
 */
export function useAcceptedInvitation(): string | undefined {
  const [encoded, setEncoded] = useState<string>();

  useEffect(() => {
    // Keeps the copy as it clears the fragment, with no removal on cleanup: a
    // remount of this effect (React's development double-mount) then reads the
    // copy rather than the address it already cleared.
    const fromAddress = addressFragment();
    if (fromAddress !== "") {
      takeFromAddress(fromAddress);
      setEncoded(fromAddress);
    } else {
      setEncoded(keptAcceptedInvitation());
    }

    function handleHashChange() {
      const arrived = addressFragment();
      if (arrived === "") return;
      takeFromAddress(arrived);
      setEncoded(arrived);
    }
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  useEffect(() => {
    if (encoded === undefined || encoded === "") return;
    keepAcceptedInvitation(encoded);
    return () => forgetAcceptedInvitation();
  }, [encoded]);

  return encoded;
}
