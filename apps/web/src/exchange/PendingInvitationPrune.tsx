import { useEffect } from "react";

import { getLogger } from "@alcove/core";

import { whenDiagnostic } from "@utils/diagnostics";

import { PENDING_INVITATION_STORAGE_KEY } from "./pendingInvitationKey";

const log = getLogger("PendingInvitationPrune");

function hasPendingInvitation(): boolean {
  try {
    return (
      globalThis.sessionStorage.getItem(PENDING_INVITATION_STORAGE_KEY) !== null
    );
  } catch {
    return false;
  }
}

/**
 * Removes the inviter's kept invitation at app start, on every route, where it
 * has expired or no longer reads: the expiry timer runs only while the inviter
 * screen is open. The reader is imported only when an entry exists, so a page
 * load with none fetches nothing more. Renders nothing.
 */
export function PendingInvitationPrune(): null {
  useEffect(() => {
    if (!hasPendingInvitation()) return;
    import("./pendingInvitation")
      .then(({ prunePendingInvitation }) => prunePendingInvitation(new Date()))
      .catch((error: unknown) => {
        whenDiagnostic(() =>
          log.warn("pending invitation prune failed:", error),
        );
      });
  }, []);
  return null;
}
