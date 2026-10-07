/**
 * The pure model behind a managed re-run's completion surface. A successful run
 * rotates the secret, so the previous backup is stale at that moment and the
 * surface offers "download updated backup" as the final step
 * (docs/notes/managed-exchange-design.md, Moment-anchored backup surfaces).
 */

/** The refreshed-backup export the host injects. Without one the surface shows
 * the deferred affordance rather than an active one. */
export interface ManagedBackupExportHook {
  /** Hand the operator a backup of the just-rotated secret. On rejection the
   * host reports the failure without claiming the backup was taken. */
  downloadUpdatedBackup: () => Promise<void>;
}

/** `"deferred"` names the refresh as not yet available rather than implying it
 * can be taken. */
type ManagedBackupAffordance = "offer-refresh" | "deferred";

/** What the completion surface renders after a successful re-run. */
interface ManagedRerunCompletion {
  backupAffordance: ManagedBackupAffordance;
  /** Present only when {@link backupAffordance} is `"offer-refresh"`. */
  backupHook?: ManagedBackupExportHook;
}

/**
 * The completion surface for a successful re-run: `"offer-refresh"` when a hook
 * is supplied, else `"deferred"`. A completed run always just rotated the secret,
 * so there is no "already backed up" case.
 */
export function managedRerunCompletion(
  backupHook?: ManagedBackupExportHook,
): ManagedRerunCompletion {
  if (backupHook === undefined) return { backupAffordance: "deferred" };
  return { backupAffordance: "offer-refresh", backupHook };
}
