import { useEffect, useState } from "react";

import { getLogger } from "@alcove/core";

import { whenDiagnostic } from "@utils/diagnostics";

/**
 * The acceptor's encoded invitation, taken out of the URL fragment and kept in
 * this tab's session storage for a reload. When the copy is removed:
 * docs/SECURITY_DESIGN.md, "Invitation contents and confidentiality".
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
 * tab -- replaces it.
 */
export function useAcceptedInvitation(): string | undefined {
  const [encoded, setEncoded] = useState<string>();

  useEffect(() => {
    // No removal on cleanup: a remount reads the kept copy, the fragment gone.
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
