import type { AppUpdateHolder } from "@utils/appUpdateHolder";

/** What each holder of a waiting update is, and how to release it, as the
 * update banner states it. */
export const UPDATE_HOLD_TEXT: Readonly<Record<AppUpdateHolder, string>> = {
  run: "An exchange is running. The update waits until it ends.",
  file: "A page has an invitation or a file open. Finish with it or leave the page.",
  results: "A page shows results. Save what you need, then leave the page.",
  edits: "A change is not saved. Save it or leave the page.",
};

/** The waiting-update banner's text before its Reload button: what holds the
 * update back and how to release each, then the reload. */
export function updateReadyText(
  holders: ReadonlyArray<AppUpdateHolder>,
): string {
  return [
    ...holders.map((holder) => UPDATE_HOLD_TEXT[holder]),
    holders.length > 0 ? "Then reload to use it." : "Reload to use it.",
    "It replaces the app's code; your saved exchanges stay in this browser.",
  ].join(" ");
}

/** The line the reloaded page shows once after the scheduled runner applied
 * an update. */
export const AUTOMATIC_UPDATE_APPLIED_TEXT =
  "Alcove updated to a new version before a scheduled run.";
