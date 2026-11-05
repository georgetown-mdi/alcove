/** Every {@link AppUpdateHolder}, in the order the app states them. */
export const APP_UPDATE_HOLDERS = ["run", "file", "results", "edits"] as const;

/**
 * What holds a waiting app update back, grouped by what releases it: an
 * exchange running, a page with an invitation or a file open, results on
 * screen, and an unsaved change. Read by the update banner, and stored on a
 * managed record by a scheduled run the update was held back for
 * (`apps/web/src/utils/appShellUpdateHold.ts`).
 */
export type AppUpdateHolder = (typeof APP_UPDATE_HOLDERS)[number];

/** `holders` without repeats, in {@link APP_UPDATE_HOLDERS} order. */
export function orderedAppUpdateHolders(
  holders: Iterable<AppUpdateHolder>,
): Array<AppUpdateHolder> {
  const named = new Set(holders);
  return APP_UPDATE_HOLDERS.filter((holder) => named.has(holder));
}
