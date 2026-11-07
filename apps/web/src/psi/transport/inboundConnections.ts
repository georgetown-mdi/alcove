import { PEERJS_SERIALIZATION } from "@alcove/core";

import type { DataConnection } from "peerjs";
import type Peer from "peerjs";

/**
 * PeerJS answers every `OFFER` that reaches a registered peer and emits the
 * new connection on `connection`, and its binary connection class unpacks
 * whatever arrives on it. Only the one connection a run takes has the
 * inbound bound installed (`./boundedReassembly.ts`), so every other one is
 * closed the moment it is handed out, before its channel can open.
 */
interface InboundConnectionGuard {
  /** The one remote id a run takes a connection from; none on the acceptor,
   * which dials and takes no inbound connection. */
  readonly remoteId: string | undefined;
  /** Set once a run has taken its connection: every later one is closed. */
  taken: boolean;
  /** The wait for the run's connection, while one is waiting. */
  taker: ((conn: DataConnection) => void) | undefined;
}

const guards = new WeakMap<Peer, InboundConnectionGuard>();

/** Whether `conn` is one a run may take: from `remoteId`, of PeerJS's binary
 * class, the one the inbound bound wraps. */
function admissible(conn: DataConnection, remoteId: string | undefined) {
  return (
    remoteId !== undefined &&
    conn.peer === remoteId &&
    conn.serialization === PEERJS_SERIALIZATION
  );
}

/** Close a refused connection. Its class is chosen by the offer, so `close`
 * is not assumed to exist, and a throw from it is dropped: a refused
 * connection has nothing of the run's to report. */
function closeRefused(conn: unknown): void {
  const close = (conn as { close?: unknown } | null | undefined)?.close;
  if (typeof close !== "function") return;
  try {
    (close as () => void).call(conn);
  } catch {
    // A refused connection holds nothing of the run's.
  }
}

/**
 * Hold `peer`'s inbound connections, for the rest of its registration, to the
 * one a run takes ({@link takeInboundConnection}): every other connection is
 * closed as PeerJS hands it out -- one arriving while no run waits, one after
 * the run took its own, one whose remote id is not `remoteId`, and one whose
 * `serialization` is not `binary`. Installed once per peer, as the rendezvous
 * constructs it; `remoteId` undefined closes every inbound connection.
 *
 * @throws {Error} if `peer` already has a guard.
 */
export function guardInboundConnections(
  peer: Peer,
  remoteId: string | undefined,
): void {
  if (guards.has(peer))
    throw new Error("this peer's inbound connections are already guarded");
  const guard: InboundConnectionGuard = {
    remoteId,
    taken: false,
    taker: undefined,
  };
  guards.set(peer, guard);
  peer.on("connection", (conn: DataConnection) => {
    const taker = guard.taker;
    if (taker !== undefined && !guard.taken && admissible(conn, remoteId)) {
      guard.taken = true;
      guard.taker = undefined;
      taker(conn);
      return;
    }
    closeRefused(conn);
  });
}

/**
 * Wait for the connection `peer`'s guard admits ({@link
 * guardInboundConnections}), handing it to `onConnection` once. Returns the
 * function that stops the wait.
 *
 * @throws {Error} if `peer` has no guard, or a wait is already registered.
 */
export function takeInboundConnection(
  peer: Peer,
  onConnection: (conn: DataConnection) => void,
): () => void {
  const guard = guards.get(peer);
  if (guard === undefined)
    throw new Error(
      "this peer's inbound connections are not guarded, so no connection is " +
        "taken from it",
    );
  if (guard.taker !== undefined)
    throw new Error("a connection is already being waited for on this peer");
  guard.taker = onConnection;
  return () => {
    if (guard.taker === onConnection) guard.taker = undefined;
  };
}
