import { getLogger } from "@alcove/core";

import { openPeerMessageConnection } from "./peerMessageConnection";

import type { DataConnection } from "peerjs";
import type { MessageConnection } from "@alcove/core";
import type Peer from "peerjs";
import type { PeerCloseOutcome } from "./waitForPeerClose";

const log = getLogger("runConnection");

/**
 * The open connection a run exchanges over, whichever transport opened it,
 * and the release of what that transport holds beside it. The owner wraps
 * `connection` in the key exchange, closes it (or the wrapper over it), and
 * calls `release`, in the order its own teardown needs.
 */
export interface RunConnection {
  /** The open connection to the partner, before the key exchange wraps it. */
  readonly connection: MessageConnection;
  /**
   * Free what the transport holds beside `connection`, leaving `connection`
   * open. On the PeerJS path that is the broker registration, freed with
   * `disconnect`. A WebSocket relay connection holds nothing beside its
   * socket, which `connection` owns. A throw is logged by the caller.
   */
  readonly release: () => void;
}

/** What {@link openPeerRunConnection} takes beside the peer and its channel. */
export interface PeerRunConnectionOptions {
  /** Cuts the clean close's wait for the peer short, and, with
   * `closeChannelOnAbort`, the open itself. */
  signal: AbortSignal;
  /** Reports how a flushing close's wait for the peer ended, once. */
  onCloseOutcome: (outcome: PeerCloseOutcome) => void;
  /** Disconnect from the broker on the first inbound frame, keeping the data
   * channel open for the exchange. */
  dropBrokerOnFirstFrame?: boolean;
  /** Close the channel at once when `signal` aborts while it opens, and
   * refuse to open on a signal already aborted. Without it an abort waits for
   * the open to settle. */
  closeChannelOnAbort?: boolean;
}

/**
 * Open the {@link MessageConnection} over a PeerJS data channel the
 * rendezvous produced, as a {@link RunConnection}. Its `release` disconnects
 * the peer and never destroys it: `destroy()` goes through the abrupt
 * `RTCPeerConnection.close()`, which discards buffered outbound data and
 * would drop the final frame a flushing close may still have in flight.
 *
 * Atomic: when the open fails or is aborted, the channel is closed and the
 * peer disconnected before the promise rejects.
 */
export async function openPeerRunConnection(
  peer: Peer,
  conn: DataConnection,
  options: PeerRunConnectionOptions,
): Promise<RunConnection> {
  const { signal, onCloseOutcome } = options;
  const dropBrokerOnFirstFrame = options.dropBrokerOnFirstFrame === true;
  const closeChannelOnAbort = options.closeChannelOnAbort === true;

  // Fires from a PeerJS listener no caller can catch, and a failed early
  // disconnect must not fail the exchange: `release` disconnects again.
  const dropBroker = () => {
    try {
      peer.disconnect();
    } catch (err) {
      log.error("early broker disconnect failed:", err);
    }
  };
  const release = () => {
    if (dropBrokerOnFirstFrame) conn.off("data", dropBroker);
    peer.disconnect();
  };

  let abandoned = false;
  const abandon = () => {
    if (abandoned) return;
    abandoned = true;
    if (dropBrokerOnFirstFrame) conn.off("data", dropBroker);
    try {
      conn.close();
    } catch (err) {
      log.error("closing a channel that did not open failed:", err);
    }
    try {
      peer.disconnect();
    } catch (err) {
      log.error(
        "disconnecting the peer of a channel that did not open failed:",
        err,
      );
    }
  };

  if (closeChannelOnAbort && signal.aborted) {
    abandon();
    throw new Error("opening the connection to the other party was aborted");
  }
  if (closeChannelOnAbort) signal.addEventListener("abort", abandon);
  if (dropBrokerOnFirstFrame) conn.once("data", dropBroker);
  try {
    const connection = await openPeerMessageConnection(conn, {
      onCloseOutcome,
      signal,
    });
    return { connection, release };
  } catch (error) {
    abandon();
    throw error;
  } finally {
    if (closeChannelOnAbort) signal.removeEventListener("abort", abandon);
  }
}
