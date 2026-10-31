import { WebSocketServer } from "ws";

import {
  checkWebSocketRelayProof,
  deriveWebSocketRelayProofKey,
  WebSocketRelayProofRefusedError,
} from "@alcove/core/websocket-relay";

import { createFaultLatch } from "./faultLatch.ts";
import { pongWithinWindow, sendWithinWindow } from "./forwarding.ts";
import {
  PAIRED_FRAME,
  RELAY_CLOSE_WAIT_MS,
  RELAY_FAULT_REPORT_WINDOW_MS,
  RELAY_HELLO_TIMEOUT_MS,
  RELAY_IDLE_TIMEOUT_MS,
  RELAY_MAX_MESSAGE_BYTES,
  RELAY_MAX_PAIRINGS,
  RELAY_MAX_UNVERIFIED_SOCKETS,
  RELAY_PAIRING_BURST_BYTES,
  RELAY_PAIRING_BYTES_PER_SECOND,
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

/** Why the relay has stopped reading from a party's socket: its partner's
 * send buffer is full, or it has sent above the pairing's byte rate. */
export type RelayHoldReason = "backpressure" | "rate";

/** @internal */
export interface RelayObserver {
  held?(role: RendezvousRole, reason: RelayHoldReason, key?: string): void;
  released?(role: RendezvousRole, reason: RelayHoldReason, key?: string): void;
  forwarded?(key: string, from: RendezvousRole, data: Buffer): void;
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
    maxPairings?: number;
    bytesPerSecond?: number;
    burstBytes?: number;
    idleTimeoutMs?: number;
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
  /** Whether this party's socket is counted in its pairing's `openSockets`. */
  counted: boolean;
  started: boolean;
  holds: Set<RelayHoldReason>;
  /** The bytes this party may still send at once, as of `tokensAt`. */
  tokens: number;
  tokensAt: number;
  rateTimer: ReturnType<typeof setTimeout> | undefined;
}

interface Pairing {
  key: string;
  parties: Partial<Record<RendezvousRole, Party>>;
  forwarding: boolean;
  /** The sockets this pairing admitted that have not yet closed. */
  openSockets: number;
  /** When a message last crossed the pairing either way. */
  activeAt: number;
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
  const maxPairings = testing.maxPairings ?? RELAY_MAX_PAIRINGS;
  const bytesPerSecond =
    testing.bytesPerSecond ?? RELAY_PAIRING_BYTES_PER_SECOND;
  const burstBytes = testing.burstBytes ?? RELAY_PAIRING_BURST_BYTES;
  const idleTimeoutMs = testing.idleTimeoutMs ?? RELAY_IDLE_TIMEOUT_MS;
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
    autoPong: false,
  };
  const socketServer = new WebSocketServer(serverOptions);
  const parties = new Set<Party>();
  // Each socket from its upgrade until it joins a pairing or its socket
  // closes: a refused socket counts while the relay waits on its close.
  const unverified = new Set<Party>();
  const pairings = new Map<string, Pairing>();
  // Pairings that still hold an open socket, which outlive `pairings` entries:
  // a closed side's partner can stay open for the close wait.
  const pairingsHoldingSockets = new Set<Pairing>();
  // The latest pairing each key started, while it holds an open socket.
  const latestPairings = new Map<string, Pairing>();
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
    if (party.role !== undefined)
      observer.held?.(party.role, reason, party.pairing?.key);
  }

  function release(party: Party, reason: RelayHoldReason): void {
    if (!party.holds.delete(reason)) return;
    if (party.holds.size === 0) party.socket.resume();
    if (party.role !== undefined)
      observer.released?.(party.role, reason, party.pairing?.key);
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
    clearTimeout(party.rateTimer);
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

  // Takes the party's socket out of its pairing's count, once: at its close, or
  // earlier when a new pairing under the key supersedes the party's pairing.
  function uncount(party: Party): void {
    const pairing = party.pairing;
    if (pairing === undefined || !party.counted) return;
    party.counted = false;
    pairing.openSockets -= 1;
    if (pairing.openSockets > 0) return;
    pairingsHoldingSockets.delete(pairing);
    if (latestPairings.get(pairing.key) === pairing) {
      latestPairings.delete(pairing.key);
    }
  }

  // Terminates the sockets an ended pairing still holds, so a key holds at
  // most one pairing's sockets and a pair reconnecting is admitted at once.
  function supersede(pairing: Pairing): void {
    for (const party of Object.values(pairing.parties)) {
      if (party === undefined || !party.counted) continue;
      uncount(party);
      party.socket.terminate();
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
      const earlier = latestPairings.get(key);
      if (earlier !== undefined) supersede(earlier);
      if (pairingsHoldingSockets.size >= maxPairings) {
        return refuse(party, RelayCloseCode.relayFull);
      }
      pairing = {
        key,
        parties: {},
        forwarding: false,
        openSockets: 0,
        activeAt: performance.now(),
      };
      pairings.set(key, pairing);
      pairingsHoldingSockets.add(pairing);
      latestPairings.set(key, pairing);
    }
    pairing.openSockets += 1;
    party.counted = true;
    pairing.activeAt = performance.now();
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

  function refill(party: Party): void {
    const now = performance.now();
    party.tokens = Math.min(
      burstBytes,
      party.tokens + ((now - party.tokensAt) * bytesPerSecond) / 1000,
    );
    party.tokensAt = now;
  }

  function scheduleRepayment(party: Party): void {
    party.rateTimer = setTimeout(
      () => {
        party.rateTimer = undefined;
        refill(party);
        if (party.tokens < 0) return scheduleRepayment(party);
        release(party, "rate");
      },
      Math.ceil((-party.tokens * 1000) / bytesPerSecond),
    );
  }

  // A token bucket per party: a message is forwarded as it arrives, and a
  // party that has sent past its bucket is not read again until the rate has
  // paid the excess back.
  function charge(party: Party, bytes: number): void {
    refill(party);
    party.tokens -= bytes;
    if (party.tokens < 0 && party.rateTimer === undefined) {
      hold(party, "rate");
      scheduleRepayment(party);
    }
  }

  function forward(source: Party, destination: Party, data: Buffer): void {
    sendWithinWindow(
      destination.socket,
      data,
      { highBytes, lowBytes },
      () => hold(source, "backpressure"),
      () => release(source, "backpressure"),
    );
    charge(source, data.length);
  }

  function closeIdlePairings(): void {
    const now = performance.now();
    for (const pairing of [...pairings.values()]) {
      if (now - pairing.activeAt < idleTimeoutMs) continue;
      for (const party of Object.values(pairing.parties)) {
        if (party === undefined || party.state === "ended") continue;
        end(party, undefined);
        closeWithin(party, RelayCloseCode.idle);
      }
    }
  }

  function onVerifiedMessage(
    party: Party,
    data: Buffer,
    isBinary: boolean,
  ): void {
    const pairing = party.pairing;
    if (pairing === undefined) return;
    pairing.activeAt = performance.now();
    const partner = partnerOf(party);
    if (pairing.forwarding && partner !== undefined) {
      if (!isBinary) return refuse(party, RelayCloseCode.unexpectedMessage);
      if (party.role !== undefined)
        observer.forwarded?.(pairing.key, party.role, data);
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
      counted: false,
      started: false,
      holds: new Set(),
      tokens: burstBytes,
      tokensAt: performance.now(),
      rateTimer: undefined,
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
    // A ping is answered only while the queue toward its sender is under the high mark.
    socket.on("ping", (data: Buffer) =>
      pongWithinWindow(socket, data, { highBytes, lowBytes }, () => {
        const partner = partnerOf(party);
        if (partner !== undefined) release(partner, "backpressure");
      }),
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
      uncount(party);
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

  // The idle bound is checked at each ping, so it closes a pairing up to one
  // ping interval late.
  const pingTimer = setInterval(() => {
    closeIdlePairings();
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
