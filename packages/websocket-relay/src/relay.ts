import { WebSocketServer } from "ws";

import {
  checkWebSocketRelayProof,
  deriveWebSocketRelayProofKey,
  WebSocketRelayProofRefusedError,
} from "@alcove/core/websocket-relay";

import { createFaultLatch } from "./faultLatch.ts";
import {
  PAIRED_FRAME,
  RELAY_CLOSE_WAIT_MS,
  RELAY_FAULT_REPORT_WINDOW_MS,
  RELAY_HELLO_TIMEOUT_MS,
  RELAY_MAX_MESSAGE_BYTES,
  RELAY_MAX_UNVERIFIED_SOCKETS,
  RELAY_PATH,
  RELAY_PING_INTERVAL_MS,
  RELAY_REFUSAL_CLOSE_WAIT_MS,
  RELAY_SEND_BUFFER_HIGH_BYTES,
  RELAY_SEND_BUFFER_LOW_BYTES,
  RelayCloseCode,
  RelayFrameError,
  START_FRAME,
  readClientFrame,
} from "./protocol.ts";

import type { RendezvousRole } from "@alcove/core/websocket-relay";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";

import type { RelayKeyTable } from "./keyTable.ts";
import type { RelayHello } from "./protocol.ts";

/** Why the relay has stopped reading from a party's socket. */
export type RelayHoldReason = "backpressure";

/** @internal */
export interface RelayObserver {
  held?(role: RendezvousRole, reason: RelayHoldReason): void;
  released?(role: RendezvousRole, reason: RelayHoldReason): void;
}

/** What {@link attachWebSocketRelay} needs. */
export interface WebSocketRelayOptions {
  /** Where the relay looks up each hello's relay key. */
  keyTable: RelayKeyTable;
  /**
   * Where the relay reports a fault a hello met: a key table it cannot read,
   * once when lookups start failing and again only after one has succeeded; a
   * malformed enrolled key, once a window for each exchange id; any other
   * failure to check a hello, once a window. The text is raw, for the sink to
   * escape.
   */
  reportFault: (message: string) => void;
  /** @internal */
  testing?: {
    helloTimeoutMs?: number;
    maxUnverifiedSockets?: number;
    faultReportWindowMs?: number;
    pingIntervalMs?: number;
    sendBufferHighBytes?: number;
    sendBufferLowBytes?: number;
    closeWaitMs?: number;
    refusalCloseWaitMs?: number;
    observer?: RelayObserver;
  };
}

/** A relay attached to an HTTP server. */
export interface WebSocketRelay {
  /** Stop taking sockets and close every socket held with 1001. */
  close(): void;
}

interface Party {
  socket: WebSocket;
  state: "hello" | "verifying" | "verified" | "ended";
  helloTimer: ReturnType<typeof setTimeout> | undefined;
  /** The one message a party may send behind its hello: its start. */
  pending: { data: Buffer; isBinary: boolean } | undefined;
  role: RendezvousRole | undefined;
  pairing: Pairing | undefined;
  started: boolean;
  holds: Set<RelayHoldReason>;
}

interface Pairing {
  key: string;
  parties: Partial<Record<RendezvousRole, Party>>;
  forwarding: boolean;
}

const OTHER_ROLE: Record<RendezvousRole, RendezvousRole> = {
  inviter: "acceptor",
  acceptor: "inviter",
};

// A close frame with no status code is a clean close too: a browser's
// `close()` with no arguments sends one.
const NORMAL_CLOSE_CODES = new Set([1000, 1005]);

function requestPath(url: string | undefined): string {
  if (url === undefined) return "";
  const queryAt = url.search(/[?#]/);
  return queryAt === -1 ? url : url.slice(0, queryAt);
}

function refuseUpgrade(
  socket: Duplex,
  status: "404 Not Found" | "503 Service Unavailable",
): void {
  // The HTTP server detaches its own listeners from an upgrade's socket, so
  // an error here would otherwise be thrown.
  socket.on("error", () => socket.destroy());
  // Destroyed once the answer has flushed, so a client that never closes its
  // side cannot hold the socket half-open.
  socket.end(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    () => socket.destroy(),
  );
}

/**
 * Attach the WebSocket relay to `server`: it takes upgrades on
 * {@link RELAY_PATH}, pairs the two sockets whose hellos verify under one
 * exchange's relay key with opposite roles, and once both have sent a start
 * forwards each binary message to the other unread. It opens no connection of
 * its own. The wire: docs/spec/WEBSOCKET_RELAY.md.
 */
export function attachWebSocketRelay(
  server: Server,
  options: WebSocketRelayOptions,
): WebSocketRelay {
  const { keyTable, reportFault, testing = {} } = options;
  const helloTimeoutMs = testing.helloTimeoutMs ?? RELAY_HELLO_TIMEOUT_MS;
  const maxUnverifiedSockets =
    testing.maxUnverifiedSockets ?? RELAY_MAX_UNVERIFIED_SOCKETS;
  const faultReportWindowMs =
    testing.faultReportWindowMs ?? RELAY_FAULT_REPORT_WINDOW_MS;
  const pingIntervalMs = testing.pingIntervalMs ?? RELAY_PING_INTERVAL_MS;
  const highBytes = testing.sendBufferHighBytes ?? RELAY_SEND_BUFFER_HIGH_BYTES;
  const lowBytes = testing.sendBufferLowBytes ?? RELAY_SEND_BUFFER_LOW_BYTES;
  const closeWaitMs = testing.closeWaitMs ?? RELAY_CLOSE_WAIT_MS;
  const refusalCloseWaitMs =
    testing.refusalCloseWaitMs ?? RELAY_REFUSAL_CLOSE_WAIT_MS;
  const observer = testing.observer ?? {};

  // `closeTimeout` is read by the pinned `ws` but missing from @types/ws, so
  // the options are not written as a literal at the call; the relay's tests
  // hold that `ws` applies it.
  const serverOptions = {
    noServer: true,
    clientTracking: false,
    maxPayload: RELAY_MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
    closeTimeout: closeWaitMs,
  };
  const socketServer = new WebSocketServer(serverOptions);
  const parties = new Set<Party>();
  // Each socket from its upgrade until it joins a pairing or its socket
  // closes: a refused socket counts while the relay waits on its close.
  const unverified = new Set<Party>();
  const pairings = new Map<string, Pairing>();
  let keyTableFailing = false;
  // Only the operator's table can hold a malformed key, so its report is kept
  // to one a window for each exchange id; any other failure is kept to one a
  // window for the relay, since the sender chooses the exchange id.
  const malformedKeyReports = createFaultLatch(faultReportWindowMs);
  const checkFailureReports = createFaultLatch(faultReportWindowMs);

  function hold(party: Party, reason: RelayHoldReason): void {
    if (party.holds.has(reason)) return;
    if (party.holds.size === 0) party.socket.pause();
    party.holds.add(reason);
    if (party.role !== undefined) observer.held?.(party.role, reason);
  }

  function release(party: Party, reason: RelayHoldReason): void {
    if (!party.holds.delete(reason)) return;
    if (party.holds.size === 0) party.socket.resume();
    if (party.role !== undefined) observer.released?.(party.role, reason);
  }

  function partnerOf(party: Party): Party | undefined {
    if (party.pairing === undefined || party.role === undefined) return;
    return party.pairing.parties[OTHER_ROLE[party.role]];
  }

  // Ends the party's part in the relay at once, so nothing it sends later is
  // forwarded, and closes its partner with `partnerCode` behind every message
  // already queued for that partner. A pairing ends at its first close.
  function end(party: Party, partnerCode: number | undefined): void {
    if (party.state === "ended") return;
    party.state = "ended";
    clearTimeout(party.helloTimer);
    // A held socket reads nothing, the answer to its close included.
    for (const reason of [...party.holds]) release(party, reason);
    parties.delete(party);
    const pairing = party.pairing;
    if (pairing === undefined) return;
    if (pairings.get(pairing.key) === pairing) pairings.delete(pairing.key);
    const partner = partnerOf(party);
    if (partner !== undefined && partnerCode !== undefined) {
      end(partner, undefined);
      partner.socket.close(partnerCode);
    }
  }

  function closeWithin(party: Party, code: number, reason = ""): void {
    const timer = setTimeout(
      () => party.socket.terminate(),
      refusalCloseWaitMs,
    );
    timer.unref();
    party.socket.once("close", () => clearTimeout(timer));
    party.socket.close(code, reason);
  }

  function refuse(party: Party, code: number, reason = ""): void {
    if (party.state === "ended") return;
    end(party, RelayCloseCode.partnerEnded);
    closeWithin(party, code, reason);
  }

  function lookUpKey(exchangeId: string): string | undefined | null {
    try {
      const key = keyTable.lookup(exchangeId);
      keyTableFailing = false;
      return key;
    } catch (error) {
      if (!keyTableFailing) {
        keyTableFailing = true;
        reportFault(
          `${error instanceof Error ? error.message : String(error)}; ` +
            "every hello is refused until a lookup succeeds",
        );
      }
      return null;
    }
  }

  async function verify(party: Party, hello: RelayHello): Promise<void> {
    const key = lookUpKey(hello.exchangeId);
    if (key === null) return refuse(party, RelayCloseCode.internalError);
    if (key === undefined) return refuse(party, RelayCloseCode.notEnrolled);
    const now = new Date();
    try {
      await checkWebSocketRelayProof({
        proofKey: await deriveWebSocketRelayProofKey(key),
        proof: hello.proof,
        role: hello.role,
        now,
      });
    } catch (error) {
      if (!(error instanceof WebSocketRelayProofRefusedError)) {
        if (malformedKeyReports.admit(hello.exchangeId)) {
          reportFault(
            `the relay key enrolled under exchange id ${hello.exchangeId} is not 64 lowercase hex characters`,
          );
        }
        return refuse(party, RelayCloseCode.internalError);
      }
      if (error.reason === "expired") {
        const serverTime = String(Math.floor(now.getTime() / 1000));
        return refuse(party, RelayCloseCode.proofExpired, serverTime);
      }
      return refuse(party, RelayCloseCode.proofRefused);
    }
    if (party.state !== "verifying") return;
    join(party, key, hello.proof.role);
  }

  function join(party: Party, key: string, role: RendezvousRole): void {
    let pairing = pairings.get(key);
    if (pairing?.parties[role] !== undefined) {
      return refuse(party, RelayCloseCode.roleTaken);
    }
    if (pairing === undefined) {
      pairing = { key, parties: {}, forwarding: false };
      pairings.set(key, pairing);
    }
    pairing.parties[role] = party;
    party.pairing = pairing;
    party.role = role;
    party.state = "verified";
    unverified.delete(party);
    const partner = partnerOf(party);
    if (partner !== undefined) {
      partner.socket.send(PAIRED_FRAME);
      party.socket.send(PAIRED_FRAME);
      if (partner.started) party.socket.send(START_FRAME);
    }
    const pending = party.pending;
    party.pending = undefined;
    if (pending !== undefined)
      onVerifiedMessage(party, pending.data, pending.isBinary);
  }

  function forward(source: Party, destination: Party, data: Buffer): void {
    destination.socket.send(data, { binary: true }, () => {
      if (destination.socket.bufferedAmount <= lowBytes) {
        release(source, "backpressure");
      }
    });
    if (destination.socket.bufferedAmount > highBytes) {
      hold(source, "backpressure");
    }
  }

  function onVerifiedMessage(
    party: Party,
    data: Buffer,
    isBinary: boolean,
  ): void {
    const pairing = party.pairing;
    if (pairing === undefined) return;
    const partner = partnerOf(party);
    if (pairing.forwarding && partner !== undefined) {
      if (!isBinary) return refuse(party, RelayCloseCode.unexpectedMessage);
      return forward(party, partner, data);
    }
    if (isBinary || party.started) {
      return refuse(party, RelayCloseCode.unexpectedMessage);
    }
    let frame;
    try {
      frame = readClientFrame(data.toString());
    } catch (error) {
      if (!(error instanceof RelayFrameError)) throw error;
      return refuse(party, RelayCloseCode.unexpectedMessage);
    }
    if (frame.type !== "start") {
      return refuse(party, RelayCloseCode.unexpectedMessage);
    }
    party.started = true;
    if (partner === undefined) return;
    partner.socket.send(START_FRAME);
    if (partner.started) pairing.forwarding = true;
  }

  function onMessage(party: Party, data: Buffer, isBinary: boolean): void {
    switch (party.state) {
      case "hello": {
        clearTimeout(party.helloTimer);
        let frame;
        try {
          if (isBinary) throw new RelayFrameError("the hello is binary");
          frame = readClientFrame(data.toString());
        } catch (error) {
          if (!(error instanceof RelayFrameError)) throw error;
          return refuse(party, RelayCloseCode.helloMalformed);
        }
        if (frame.type !== "hello") {
          return refuse(party, RelayCloseCode.helloMalformed);
        }
        party.state = "verifying";
        verify(party, frame.hello).catch((error: unknown) => {
          if (checkFailureReports.admit("")) {
            reportFault(
              `a hello could not be checked: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          refuse(party, RelayCloseCode.internalError);
        });
        return;
      }
      case "verifying":
        if (party.pending !== undefined) {
          return refuse(party, RelayCloseCode.unexpectedMessage);
        }
        party.pending = { data, isBinary };
        return;
      case "verified":
        return onVerifiedMessage(party, data, isBinary);
      case "ended":
        return;
    }
  }

  function onConnection(socket: WebSocket): void {
    const party: Party = {
      socket,
      state: "hello",
      helloTimer: undefined,
      pending: undefined,
      role: undefined,
      pairing: undefined,
      started: false,
      holds: new Set(),
    };
    parties.add(party);
    unverified.add(party);
    party.helloTimer = setTimeout(
      () => refuse(party, RelayCloseCode.helloTimeout),
      helloTimeoutMs,
    );
    // The server's sockets keep `ws`'s default binary type, so every message
    // arrives as one Buffer.
    socket.on("message", (data, isBinary) =>
      onMessage(party, data as Buffer, isBinary),
    );
    // `ws` closes the socket itself after an error it raises, an oversized
    // message's 1009 among them; the party's part ends here so the partner is
    // closed behind what was already forwarded.
    socket.on("error", () => {
      const timer = setTimeout(() => socket.terminate(), refusalCloseWaitMs);
      timer.unref();
      socket.once("close", () => clearTimeout(timer));
      end(party, RelayCloseCode.partnerEnded);
    });
    socket.on("close", (code) => {
      unverified.delete(party);
      end(
        party,
        NORMAL_CLOSE_CODES.has(code)
          ? RelayCloseCode.normal
          : RelayCloseCode.partnerEnded,
      );
    });
  }

  const onUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    if (socket.destroyed) return;
    if (requestPath(request.url) !== RELAY_PATH) {
      return refuseUpgrade(socket, "404 Not Found");
    }
    // The pinned `ws` calls `onConnection` before `handleUpgrade` returns (the
    // relay's tests hold it to that), so the count holds every upgrade already
    // answered.
    if (unverified.size >= maxUnverifiedSockets) {
      return refuseUpgrade(socket, "503 Service Unavailable");
    }
    socketServer.handleUpgrade(request, socket, head, onConnection);
  };
  server.on("upgrade", onUpgrade);

  const pingTimer = setInterval(() => {
    for (const party of parties) party.socket.ping();
  }, pingIntervalMs);
  pingTimer.unref();

  return {
    close() {
      server.off("upgrade", onUpgrade);
      clearInterval(pingTimer);
      for (const party of [...parties]) {
        end(party, undefined);
        closeWithin(party, RelayCloseCode.goingAway);
      }
    },
  };
}
