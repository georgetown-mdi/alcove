// The ceiling on closing a run's transport, and the notice when it is reached:
// docs/spec/WEBRTC_TRANSPORT.md#budgets.

import { TEARDOWN_LEFTOVER_FILES_CLAUSE } from "@alcove/core";

import type { ConnectionConfig } from "@alcove/core";

import { settleWithinCeiling, type CeilingOutcome } from "./util/ceiling";
import { heldResourceKinds } from "./util/exitGate";

/**
 * How long a run waits for its transport to finish closing, per channel. Each
 * value is above the sum of that channel's own teardown budgets
 * (docs/spec/WEBRTC_TRANSPORT.md#budgets, docs/spec/FILE_SYNC.md#phase-3----cleanup-and-close).
 */
export const TRANSPORT_TEARDOWN_CEILING_MS: Record<
  ConnectionConfig["channel"],
  number
> = {
  webrtc: 6 * 60_000,
  sftp: 3 * 60_000,
  filedrop: 3 * 60_000,
};

/** The teardown ceiling for `channel`; see {@link TRANSPORT_TEARDOWN_CEILING_MS}. */
export function transportTeardownCeilingMs(
  channel: ConnectionConfig["channel"],
): number {
  return TRANSPORT_TEARDOWN_CEILING_MS[channel];
}

/** How a run's transport teardown ended. */
export interface TeardownOutcome extends CeilingOutcome {
  /**
   * The resource kinds still holding the event loop when the ceiling was
   * reached; empty when the close finished.
   */
  heldBy: string[];
}

/**
 * Wait for `close` for at most `ceilingMs` ({@link settleWithinCeiling}),
 * reporting which way it ended and, where it did not finish, what was still
 * holding the event loop. An expiry is reported, not a failure; a close that
 * rejects inside the ceiling is raised to the caller.
 */
export async function closeWithinCeiling(
  ceilingMs: number,
  close: () => Promise<void>,
): Promise<TeardownOutcome> {
  const outcome = await settleWithinCeiling(ceilingMs, close);
  return { ...outcome, heldBy: outcome.finished ? [] : heldResourceKinds() };
}

/** What a run had done, and was set to do, with the files a close touches. */
export interface ExchangeFileDisposition {
  /** The run's channel; only the file-based ones have protocol files at all. */
  channel: ConnectionConfig["channel"];
  /** Whether the run keeps those files as a transcript instead of deleting them. */
  retainFiles: boolean;
  /**
   * Whether the output stage returned with the result, the exchange record,
   * the receipt and the caller's own post-exchange writes all on disk; false
   * for any run that did not write the whole set.
   */
  outputsWritten: boolean;
}

/**
 * The operator-log notice for a transport that did not finish closing inside
 * the ceiling: how long it waited, what still held the event loop, and that
 * the exit status is unchanged. It claims the outputs are on disk only when
 * `outputsWritten` is set, and a file-channel run in delete mode is told its
 * protocol files may be left in the exchange directory.
 */
export function teardownCeilingNotice(
  outcome: TeardownOutcome,
  files: ExchangeFileDisposition,
): string {
  const held =
    outcome.heldBy.length === 0
      ? "something Node does not name"
      : outcome.heldBy.join(", ");
  const leftBehind =
    files.channel === "webrtc" || files.retainFiles
      ? ""
      : ` Check the exchange directory and ${TEARDOWN_LEFTOVER_FILES_CLAUSE}; ` +
        `deleting them is the part of the close that did not finish, and ` +
        `passing --sweep-exchange-files to the next run removes them before ` +
        `it meets the partner.`;
  const onDisk = files.outputsWritten
    ? `, and everything it writes is already on disk`
    : "";
  return (
    `the transport did not finish closing within ` +
    `${Math.round(outcome.elapsedMs / 1000)}s, so this run stopped waiting ` +
    `on it; still held by: ${held}. The exchange's own outcome and exit ` +
    `status are unchanged${onDisk}.` +
    leftBehind
  );
}
