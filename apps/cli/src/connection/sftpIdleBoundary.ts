// How a connection-per-poll idle boundary is classified: pure lookup tables,
// each exhaustive over its key type, from an idle-release outcome to the two
// readings of a session boundary. Model:
// docs/notes/sftp-adapter-state-machine.md#the-boundary-machine.
import type { IdleBoundaryOutcome } from "./sftpAdapterLedger";

/**
 * How the session's last completed boundary was reached. `deliberatelyReleased`:
 * the idle release ended the session. `releasedOverEndedTransport`: the release
 * closed over a transport already ended, such as a partner-side drop, so the
 * absence is the release's but the loss is not. `notReleased`: anything else.
 */
export type SessionBoundary =
  "deliberatelyReleased" | "releasedOverEndedTransport" | "notReleased";

/**
 * The two separate questions a boundary answers: a release over a partner's
 * drop took the session, but the loss is the partner's and is counted and
 * warned.
 */
export interface SessionBoundaryReadings {
  /**
   * Whether the session is absent because this adapter's release took it (see
   * SSH2SFTPClientAdapter.idleReleaseLeftNoSession). No transition may leave it
   * set over a live session (SSH2SFTPClientAdapter.runTransition).
   */
  readonly releaseTookTheSession: boolean;
  /**
   * Whether the loss was this adapter's own doing, and so exempt from the
   * reconnect counters, the mid-exchange budget and the operator warning (see
   * SSH2SFTPClientAdapter.recordIdleBoundaryOutcome).
   */
  readonly lossWasDeliberate: boolean;
}

/** Both readings for each boundary. */
export const SESSION_BOUNDARY_READINGS: Record<
  SessionBoundary,
  SessionBoundaryReadings
> = {
  deliberatelyReleased: {
    releaseTookTheSession: true,
    lossWasDeliberate: true,
  },
  releasedOverEndedTransport: {
    releaseTookTheSession: true,
    lossWasDeliberate: false,
  },
  notReleased: { releaseTookTheSession: false, lossWasDeliberate: false },
};

/**
 * The session boundary each idle-boundary outcome leaves, or `unchanged` where
 * the standing reading is not the release's to move. `forced` is `unchanged`
 * even though it closed the session: the entry classification already recorded
 * who ended the transport, which keeps a forced-closed partner drop charged to
 * the partner.
 */
export const IDLE_BOUNDARY_SESSION_READING: Record<
  IdleBoundaryOutcome,
  SessionBoundary | "unchanged"
> = {
  skipped: "unchanged",
  held: "unchanged",
  declined: "unchanged",
  alreadyEnded: "unchanged",
  noSession: "notReleased",
  closedByPeer: "notReleased",
  releasedOverEndedTransport: "releasedOverEndedTransport",
  released: "deliberatelyReleased",
  forced: "unchanged",
  didNotClose: "notReleased",
  destroyDidNotClear: "unchanged",
};

/**
 * Whether an idle-boundary outcome ended the session's generation, which
 * decides whether it charges a loss at all.
 */
export const IDLE_BOUNDARY_ENDS_THE_GENERATION: Record<
  IdleBoundaryOutcome,
  boolean
> = {
  skipped: false,
  held: false,
  declined: false,
  alreadyEnded: false,
  noSession: true,
  closedByPeer: true,
  releasedOverEndedTransport: true,
  released: true,
  forced: true,
  didNotClose: false,
  destroyDidNotClear: false,
};

/** {@link IDLE_BOUNDARY_SESSION_READING} as a lookup. */
export function idleBoundarySessionReading(
  outcome: IdleBoundaryOutcome,
): SessionBoundary | "unchanged" {
  return IDLE_BOUNDARY_SESSION_READING[outcome];
}
