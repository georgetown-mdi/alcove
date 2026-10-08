import { isProtocolTempName, redactAndSanitizeForDisplay } from "@alcove/core";

import {
  transportOperationStalledError,
  withSftpOperationDeadline,
} from "./sftpLivenessGuard";

/**
 * Cap on the record of unperformed cleanup deletes; overflow refuses rather
 * than evicts. This constant and the two below are derived in
 * docs/spec/CHANNEL_SECURITY.md#the-deferred-cleanup-delete-record.
 */
export const MAX_DEFERRED_CLEANUP_DELETES = 64;

/**
 * Re-issue budget for one recording of a cleanup delete, after which its file
 * is left behind.
 *
 * @internal exported for the record's own tests
 */
export const MAX_DEFERRED_CLEANUP_REISSUES = 3;

/**
 * Deadline (ms) on each drain re-issue, in place of
 * {@link ./sftpLivenessGuard.SFTP_STALL_DEADLINE_MS}, and so on the whole drain.
 */
const DEFERRED_CLEANUP_DRAIN_TIMEOUT_MS = 5_000;

// SFTP paths are POSIX-separated on the wire on any platform, so a backslash
// is an ordinary filename character here.
const remoteBasename = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);

/**
 * The record logs its refusals at debug only: they follow repeated failures to
 * reach the server, which the operations that needed it already report.
 */
interface DeferredCleanupLog {
  debug: (message: string) => void;
}

/** Constructor bundle for {@link DeferredCleanupDeletes}. */
export interface DeferredCleanupDeletesOptions {
  /**
   * Connection-per-poll mode. The default mode holds one session throughout,
   * so it records and re-issues nothing.
   */
  enabled: boolean;
  log: DeferredCleanupLog;
  /**
   * Issues one re-issued delete on the live session, rejecting unless the
   * server answers. Injected so the round trip stays in the adapter, where
   * scripts/sftp-tracked-round-trips.test.mjs and
   * scripts/sftp-operation-spans.test.mjs examine it.
   */
  issueDelete: (path: string) => Promise<void>;
  /**
   * Whether the adapter's state allows a drain now; this class checks the
   * mode and an empty record itself.
   */
  canDrain: () => boolean;
}

/**
 * The connection-per-poll record of cleanup deletes that were not performed,
 * and the single-flight drain that re-issues them:
 * docs/spec/CHANNEL_SECURITY.md#the-deferred-cleanup-delete-record.
 */
export class DeferredCleanupDeletes {
  private readonly enabled: boolean;
  private readonly log: DeferredCleanupLog;
  private readonly issueDelete: (path: string) => Promise<void>;
  private readonly canDrain: () => boolean;
  // Unperformed temp-file deletes, each with the re-issues it has left, held
  // on the entry so it cannot outlive its budget.
  private readonly budgetByPath = new Map<string, number>();
  // The running drain, which a second call joins; cleared when it settles so
  // a later re-establishment drains records made after its snapshot.
  private draining: Promise<void> | undefined;

  constructor(options: DeferredCleanupDeletesOptions) {
    this.enabled = options.enabled;
    this.log = options.log;
    this.issueDelete = options.issueDelete;
    this.canDrain = options.canDrain;
  }

  /** @internal */
  get recorded(): ReadonlyMap<string, number> {
    return this.budgetByPath;
  }

  /**
   * Record an unperformed cleanup delete of a protocol temp file for re-issue
   * once a session exists. Connection-per-poll only.
   */
  record(path: string, reissuesLeft = MAX_DEFERRED_CLEANUP_REISSUES): void {
    if (!this.enabled) return;
    if (!isProtocolTempName(remoteBasename(path))) return;
    if (reissuesLeft <= 0) {
      this.log.debug(
        `a cleanup delete was re-issued ${MAX_DEFERRED_CLEANUP_REISSUES} ` +
          `times on this SFTP connection without succeeding, so it is not ` +
          `recorded again and its file is left behind: ` +
          redactAndSanitizeForDisplay(path),
      );
      return;
    }
    // An existing entry keeps its budget, so a failed re-issue's decrement does
    // not apply to a newer recording of the same path.
    if (this.budgetByPath.has(path)) return;
    if (this.budgetByPath.size >= MAX_DEFERRED_CLEANUP_DELETES) {
      this.log.debug(
        `${MAX_DEFERRED_CLEANUP_DELETES} cleanup deletes are already recorded ` +
          `for re-issue on this SFTP connection, so this one is not recorded ` +
          `and its file is left behind: ${redactAndSanitizeForDisplay(path)}`,
      );
      return;
    }
    this.budgetByPath.set(path, reissuesLeft);
  }

  /**
   * Re-issue every recorded cleanup delete. Driven at the tail of the
   * adapter's ensureConnected(), outside the transition.
   */
  drain(): Promise<void> {
    if (this.budgetByPath.size === 0) return Promise.resolve();
    if (!this.canDrain()) return Promise.resolve();
    // Records made after a running drain's snapshot wait for the next
    // re-establishment, so no path is deleted twice concurrently.
    this.draining ??= this.runDrain().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private runDrain(): Promise<void> {
    const snapshot = [...this.budgetByPath];
    this.budgetByPath.clear();
    return Promise.all(
      snapshot.map(([path, reissuesLeft]) => this.reissue(path, reissuesLeft)),
    ).then(() => {});
  }

  /**
   * One re-issued cleanup delete, which never rejects. A failure records the
   * path again with one fewer re-issue left.
   */
  private reissue(path: string, reissuesLeft: number): Promise<void> {
    return withSftpOperationDeadline(
      this.issueDelete(path),
      DEFERRED_CLEANUP_DRAIN_TIMEOUT_MS,
      () =>
        transportOperationStalledError(
          "file delete",
          path,
          `did not complete within ${DEFERRED_CLEANUP_DRAIN_TIMEOUT_MS} ms ` +
            "(the server withheld the delete response)",
        ),
    ).then(
      () => {},
      () => {
        this.record(path, reissuesLeft - 1);
      },
    );
  }
}
