import {
  BROWSER_PSI_SET_MAX_ELEMENTS,
  BoundedInboundFrames,
  ConnectionError,
  PeerJsFrameEncoder,
  QueuedMessageConnection,
  WEBSOCKET_RELAY_PROOF_MAX_TTL_SECONDS,
  asConnectionError,
  buildWebSocketRelayProof,
  packCloseSentinel,
  parseBoundedJson,
  toFrameBytes,
} from "@alcove/core";

import { DEFAULT_PEER_CLOSE_TIMEOUT_MS } from "./waitForPeerClose";

import type {
  MessageConnection,
  RendezvousRole,
  WebSocketRelayProof,
} from "@alcove/core";
import type { PeerCloseOutcome } from "./waitForPeerClose";

/**
 * The wait for the partner's hello: the WebRTC rendezvous budget, since one
 * party may start well before the other (docs/spec/WEBRTC_TRANSPORT.md,
 * Budgets).
 */
const DEFAULT_RELAY_PAIRING_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The wait for the partner's start once the relay has paired the two
 * sockets: the WebRTC channel-open budget.
 */
const DEFAULT_RELAY_START_TIMEOUT_MS = 30 * 1000;

/** The parked-receive budget, as on the WebRTC transport. */
const DEFAULT_RELAY_INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000;

/** The send window's high and low marks, the CLI's WebRTC window
 * (docs/spec/WEBRTC_TRANSPORT.md, Outbound pacing). */
const SEND_WINDOW_BYTES = 1024 * 1024;
const SEND_WINDOW_LOW_BYTES = 256 * 1024;

/**
 * How often a send waiting on the window re-reads the socket's
 * `bufferedAmount`. A browser `WebSocket` raises no event as its buffer
 * drains, so the wait polls.
 */
const SEND_WINDOW_POLL_INTERVAL_MS = 50;

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;

const CLOSE_NORMAL = 1000;
/** The code this side closes with when it ends the socket without a clean
 * close; the relay passes any code but 1000 to the partner as 4000. */
const CLOSE_ABNORMAL = 4000;

/** The close codes the relay sends (docs/spec/WEBSOCKET_RELAY.md, Close
 * codes). */
const RelayCloseCode = {
  goingAway: 1001,
  messageTooBig: 1009,
  internalError: 1011,
  partnerEnded: 4000,
  helloMalformed: 4001,
  unexpectedMessage: 4002,
  notEnrolled: 4003,
  proofRefused: 4004,
  proofExpired: 4005,
  roleTaken: 4006,
  helloTimeout: 4007,
  relayFull: 4008,
  idle: 4009,
} as const;

/** Options for {@link openWebSocketRelayConnection}. */
export interface WebSocketRelayConnectionOptions {
  /** The relay's `wss` url, its `/relay` path included. */
  url: string;
  /** The id the exchange's relay key is enrolled under at the relay. */
  exchangeId: string;
  /** This party's rendezvous role. */
  role: RendezvousRole;
  /** The exchange's relay key, 64 lowercase hex characters. */
  relayKey: string;
  /** Cuts the wait for the partner and the clean close's wait short. */
  signal?: AbortSignal;
  /** Reports how a flushing close's wait for the partner's relayed close
   * ended, once; a non-flushing close reports nothing. */
  onCloseOutcome?: (outcome: PeerCloseOutcome) => void;
  /** Builds the socket; tests only. */
  createSocket?: (url: string) => WebSocket;
  /** The clock the proof's expiry counts from; tests only. */
  now?: () => Date;
  /** Budgets; tests only. */
  pairingTimeoutMs?: number;
  startTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  closeDrainTimeoutMs?: number;
  /** Send window bounds; tests only. */
  sendWindowBytes?: number;
  sendWindowLowBytes?: number;
  /** Builds the inbound reassembler; tests only, to lower its limits. */
  inboundFrames?: () => BoundedInboundFrames;
}

function hex(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += byte.toString(16).padStart(2, "0");
  return text;
}

/** The hello a party sends as its first message
 * (docs/spec/WEBSOCKET_RELAY.md, The hello). */
function helloFrame(exchangeId: string, proof: WebSocketRelayProof): string {
  return JSON.stringify({
    type: "hello",
    exchangeId,
    role: proof.role,
    proof: new TextDecoder().decode(proof.message),
    tag: hex(proof.tag),
  });
}

const START_FRAME = JSON.stringify({ type: "start" });

/** `bytes` as a view `WebSocket.send` takes: itself when it is backed by an
 * `ArrayBuffer`, as core's encoder makes it, else a copy. */
function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : new Uint8Array(bytes);
}

function relaySocketUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConnectionError(
      "The WebSocket relay address is not a valid URL. Check the relay address, then start the exchange again.",
      "usage",
    );
  }
  if (parsed.protocol !== "wss:")
    throw new ConnectionError(
      "The WebSocket relay address does not start with wss://. Check the relay address, then start the exchange again.",
      "usage",
    );
  // `hash` is empty for a bare trailing `#`, which the WebSocket constructor
  // also refuses; `href` keeps it, and the first `#` in `href` starts the
  // fragment.
  if (parsed.href.includes("#"))
    throw new ConnectionError(
      `The WebSocket relay address ${url} has a fragment, a part starting with #. Remove the fragment from the relay address, then start the exchange again.`,
      "usage",
    );
  return parsed.href;
}

async function buildRelayProof(
  options: WebSocketRelayConnectionOptions,
  proofTime: Date,
): Promise<WebSocketRelayProof> {
  try {
    return await buildWebSocketRelayProof({
      relayKey: options.relayKey,
      role: options.role,
      ttlSeconds: WEBSOCKET_RELAY_PROOF_MAX_TTL_SECONDS,
      now: proofTime,
    });
  } catch (err) {
    throw new ConnectionError(
      "Could not build this side's proof for the WebSocket relay from the exchange's relay key. Check that both parties use the current invitation, then start the exchange again.",
      "usage",
      { cause: err },
    );
  }
}

function openRelaySocket(
  url: string,
  options: WebSocketRelayConnectionOptions,
): WebSocket {
  try {
    return (options.createSocket ?? ((at) => new WebSocket(at)))(url);
  } catch (err) {
    throw new ConnectionError(
      `The browser refused to open a connection to the WebSocket relay at ${url}. Check the relay address, then start the exchange again.`,
      "usage",
      { cause: err },
    );
  }
}

/** A text frame the relay sends before forwarding starts. */
type RelayControlFrame = "paired" | "start";

function relayProtocolError(detail: string): ConnectionError {
  return new ConnectionError(
    `The WebSocket relay ${detail}. Start the exchange again.`,
    "protocol",
  );
}

function readRelayControlFrame(text: string): RelayControlFrame {
  let value: unknown;
  try {
    value = parseBoundedJson(text);
  } catch {
    throw relayProtocolError("sent a control message that is not JSON");
  }
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1
  ) {
    const type = (value as Record<string, unknown>).type;
    if (type === "paired" || type === "start") return type;
  }
  throw relayProtocolError("sent a control message this side does not know");
}

/**
 * The time a 4005 close's reason states, the relay's Unix second, or
 * `undefined` when the reason is not a plain decimal second a `Date` can hold.
 */
function relayClockOf(reason: string): Date | undefined {
  if (!/^(0|[1-9][0-9]{0,15})$/.test(reason)) return undefined;
  const time = new Date(Number(reason) * 1000);
  return Number.isFinite(time.getTime()) ? time : undefined;
}

/** The relay's 4005 refusal, with the relay's clock when its reason states a
 * usable time. */
class ProofExpiredRefusal extends ConnectionError {
  constructor(readonly relayClock: Date | undefined) {
    super(
      "The WebSocket relay refused this side's proof as expired: this device's clock is behind the relay's. Set this device's clock to the correct time, then start the exchange again.",
      "transport",
    );
  }
}

/**
 * The failure for a close the relay sent before forwarding started. Every
 * message names what happened and what to do and uses no relay-chosen text;
 * a 4005 reason is read only as a time to sign a proof on.
 */
function setupCloseError(
  event: CloseEvent,
  opened: boolean,
  paired: boolean,
): ConnectionError {
  switch (event.code) {
    case RelayCloseCode.notEnrolled:
      return new ConnectionError(
        "The WebSocket relay has no key enrolled for this exchange. Enroll the exchange at the relay's registrar, then start the exchange again.",
        "transport",
      );
    case RelayCloseCode.proofRefused:
      return new ConnectionError(
        "The WebSocket relay refused this side's proof: the key it holds for this exchange is not the one this invitation gives. Check that both parties use the current invitation, then start the exchange again.",
        "transport",
      );
    case RelayCloseCode.proofExpired:
      return new ProofExpiredRefusal(relayClockOf(event.reason));
    case RelayCloseCode.roleTaken:
      return new ConnectionError(
        "Another connection already holds this side's place at the WebSocket relay for this exchange. Close any other window running this exchange, wait five minutes, then start the exchange again.",
        "transport",
      );
    case RelayCloseCode.relayFull:
      return new ConnectionError(
        "The WebSocket relay is carrying as many exchanges as it allows. Wait a few minutes, then start the exchange again.",
        "transport",
      );
    case RelayCloseCode.internalError:
      return new ConnectionError(
        "The WebSocket relay could not check this side's proof. Wait a few minutes, then start the exchange again; if it keeps failing, tell the relay's operator.",
        "transport",
      );
    case RelayCloseCode.helloTimeout:
      return new ConnectionError(
        "The WebSocket relay closed the connection before this side's proof reached it. Check the network connection, then start the exchange again.",
        "transport",
      );
    case RelayCloseCode.helloMalformed:
    case RelayCloseCode.unexpectedMessage:
    case RelayCloseCode.messageTooBig:
      return relayProtocolError(
        `refused a message this side sent it (code ${event.code})`,
      );
    case RelayCloseCode.goingAway:
      return new ConnectionError(
        "The WebSocket relay shut down. Start the exchange again once it is back.",
        "transport",
      );
    case RelayCloseCode.idle:
      return new ConnectionError(
        "The WebSocket relay closed the connection after an hour with no message. Start the exchange again.",
        "transport",
      );
  }
  if (!opened)
    return new ConnectionError(
      "Could not connect to the WebSocket relay. Check the relay address and the network connection, then start the exchange again.",
      "transport",
    );
  if (paired)
    return new ConnectionError(
      "The exchange partner left the WebSocket relay before the exchange started. Ask your partner to start the exchange again, then start it again here.",
      "transport",
    );
  return new ConnectionError(
    "The connection to the WebSocket relay closed before the exchange partner arrived. Check the network connection, then start the exchange again.",
    "transport",
  );
}

/** The failure for a close the relay sent once forwarding had started, other
 * than the partner's clean close. */
function forwardingCloseError(event: CloseEvent): ConnectionError {
  if (event.code === RelayCloseCode.partnerEnded)
    return new ConnectionError(
      "the exchange partner's connection to the WebSocket relay ended without a clean close",
      "transport",
    );
  if (event.code === RelayCloseCode.idle)
    return new ConnectionError(
      "the WebSocket relay closed the exchange after an hour with no message either way",
      "transport",
    );
  if (event.code === RelayCloseCode.goingAway)
    return new ConnectionError(
      "the WebSocket relay shut down during the exchange",
      "transport",
    );
  return new ConnectionError(
    `the connection to the WebSocket relay closed during the exchange (code ${event.code})`,
    "transport",
  );
}

/**
 * Open a {@link MessageConnection} to the exchange partner through the
 * WebSocket relay at `options.url` (docs/spec/WEBSOCKET_RELAY.md).
 *
 * It sends the hello with a proof under the exchange's relay key and its
 * start at once, waits for the relay to pair the partner and pass on the
 * partner's start, and resolves with the connection. Frames are encoded and
 * reassembled as on the WebRTC data channel (core's `PeerJsFrameEncoder` and
 * `BoundedInboundFrames`), and a send hands its datagrams over a window at a
 * time against the socket's `bufferedAmount`. The caller wraps the
 * connection in the key exchange and its AEAD envelope, as on WebRTC.
 *
 * A flushing close sends the close sentinel and waits for the partner's
 * close to come back through the relay, the one delivery signal on this path;
 * how the wait ended goes to `onCloseOutcome`. The partner reading this
 * side's sentinel closes its socket, and this side does the same on reading
 * the partner's. A browser `WebSocket` cannot send a ping, so a parked
 * receive is kept alive by the relay's own pings, which the browser answers.
 *
 * A proof the relay refuses as expired is signed again once, on the second
 * the refusal states as the relay's clock, over a new socket.
 *
 * @throws {ConnectionError} of kind `usage` for an address that is not a
 *         `wss` URL or has a fragment, a relay key no proof can be built
 *         from, or an address the browser refuses to open a socket to; of
 *         kind `transport` or `protocol` when the relay refuses
 *         the hello, the partner does not arrive within the budgets, or the
 *         relay sends something out of order.
 */
export async function openWebSocketRelayConnection(
  options: WebSocketRelayConnectionOptions,
): Promise<MessageConnection> {
  const url = relaySocketUrl(options.url);
  const now = options.now ?? (() => new Date());
  let relayClock: Date;
  try {
    return await dialRelay(url, options, now());
  } catch (err) {
    if (!(err instanceof ProofExpiredRefusal) || err.relayClock === undefined)
      throw err;
    relayClock = err.relayClock;
  }
  try {
    return await dialRelay(url, options, relayClock);
  } catch (err) {
    if (!(err instanceof ProofExpiredRefusal)) throw err;
    throw new ConnectionError(
      "The WebSocket relay refused this side's proof as expired twice, the second time signed on the relay's own clock. Start the exchange again, and if the relay refuses it again, check the relay and the exchange's enrollment at it.",
      "transport",
    );
  }
}

/** One socket to the relay, its hello signed at `proofTime`, up to the
 * partner's start. */
async function dialRelay(
  url: string,
  options: WebSocketRelayConnectionOptions,
  proofTime: Date,
): Promise<MessageConnection> {
  if (options.signal?.aborted) throw setupCancelled();
  const proof = await buildRelayProof(options, proofTime);
  if (options.signal?.aborted) throw setupCancelled();
  const hello = helloFrame(options.exchangeId, proof);
  const socket = openRelaySocket(url, options);
  socket.binaryType = "arraybuffer";

  return new Promise<MessageConnection>((resolve, reject) => {
    let opened = false;
    let paired = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Replaced once forwarding starts, from inside the message handler that
    // reads the partner's start, so no message falls between the two.
    let onMessage: (event: MessageEvent) => void;
    let onClose: (event: CloseEvent) => void;

    const arm = (ms: number, error: () => ConnectionError) => {
      clearTimeout(timer);
      timer = setTimeout(() => failSetup(error()), ms);
    };
    const detachSetup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const failSetup = (error: ConnectionError) => {
      if (settled) return;
      settled = true;
      detachSetup();
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", dispatchMessage);
      socket.removeEventListener("close", dispatchClose);
      if (
        socket.readyState === SOCKET_OPEN ||
        socket.readyState === SOCKET_CONNECTING
      )
        socket.close(CLOSE_ABNORMAL);
      reject(error);
    };
    const onAbort = () => failSetup(setupCancelled());
    const onOpen = () => {
      opened = true;
      socket.send(hello);
      socket.send(START_FRAME);
    };

    onMessage = (event) => {
      if (typeof event.data !== "string") {
        failSetup(
          relayProtocolError(
            "passed on exchange data before both parties had started",
          ),
        );
        return;
      }
      let frame: RelayControlFrame;
      try {
        frame = readRelayControlFrame(event.data);
      } catch (err) {
        failSetup(asConnectionError(err, "protocol"));
        return;
      }
      if (frame === "paired") {
        if (paired) {
          failSetup(relayProtocolError("paired this side twice"));
          return;
        }
        paired = true;
        arm(
          options.startTimeoutMs ?? DEFAULT_RELAY_START_TIMEOUT_MS,
          () =>
            new ConnectionError(
              "The exchange partner reached the WebSocket relay but did not start the exchange. Ask your partner to start the exchange again, then start it again here.",
              "transport",
            ),
        );
        return;
      }
      if (!paired) {
        failSetup(
          relayProtocolError("passed on the partner's start before pairing"),
        );
        return;
      }
      settled = true;
      detachSetup();
      socket.removeEventListener("open", onOpen);
      const forwarding = forwardingConnection(socket, options);
      onMessage = forwarding.onMessage;
      onClose = forwarding.onClose;
      resolve(forwarding.connection);
    };
    onClose = (event) => failSetup(setupCloseError(event, opened, paired));
    // Error events carry nothing a close event does not; the close that
    // follows each one decides.
    const dispatchMessage = (event: MessageEvent) => onMessage(event);
    const dispatchClose = (event: CloseEvent) => onClose(event);

    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", dispatchMessage);
    socket.addEventListener("close", dispatchClose);
    options.signal?.addEventListener("abort", onAbort);
    const pairingTimeoutMs =
      options.pairingTimeoutMs ?? DEFAULT_RELAY_PAIRING_TIMEOUT_MS;
    const pairingMinutes = Math.max(1, Math.round(pairingTimeoutMs / 60_000));
    arm(
      pairingTimeoutMs,
      () =>
        new ConnectionError(
          `The exchange partner did not reach the WebSocket relay within ${pairingMinutes} minute${pairingMinutes === 1 ? "" : "s"}. Check that your partner has started the exchange with the same relay, then start it again.`,
          "transport",
        ),
    );
  });
}

function setupCancelled(): ConnectionError {
  return new ConnectionError(
    "the connection to the WebSocket relay was cancelled",
    "closed",
  );
}

/**
 * The connection over a socket whose pairing has started: the send window,
 * the bounded inbound path, and the close.
 */
function forwardingConnection(
  socket: WebSocket,
  options: WebSocketRelayConnectionOptions,
): {
  connection: MessageConnection;
  onMessage: (event: MessageEvent) => void;
  onClose: (event: CloseEvent) => void;
} {
  const sendWindowBytes = options.sendWindowBytes ?? SEND_WINDOW_BYTES;
  const sendWindowLowBytes =
    options.sendWindowLowBytes ?? SEND_WINDOW_LOW_BYTES;
  const closeDrainTimeoutMs =
    options.closeDrainTimeoutMs ?? DEFAULT_PEER_CLOSE_TIMEOUT_MS;
  let onMessage: (event: MessageEvent) => void = () => {};
  let onClose: (event: CloseEvent) => void = () => {};

  const connection = new QueuedMessageConnection(
    (controls) => {
      const encoder = new PeerJsFrameEncoder();
      const bounds = options.inboundFrames?.() ?? new BoundedInboundFrames();
      let peerCloseRead = false;
      let sendStopped = false;
      let sendQueue: Promise<void> = Promise.resolve();
      let wakeSend: (() => void) | undefined;
      // Set while a flushing close waits for the partner's relayed close.
      let settleCloseWait: ((outcome: PeerCloseOutcome) => void) | undefined;

      const socketOpen = () => socket.readyState === SOCKET_OPEN;
      const sendable = () => !sendStopped && socketOpen();
      const sendCut = () =>
        new ConnectionError(
          "the connection to the exchange partner closed before a message could be sent",
          "transport",
        );
      const waitForWindow = () =>
        new Promise<void>((resolve) => {
          const poll = setTimeout(done, SEND_WINDOW_POLL_INTERVAL_MS);
          wakeSend = done;
          function done(): void {
            clearTimeout(poll);
            wakeSend = undefined;
            resolve();
          }
        });

      const sendFrame = async (data: unknown): Promise<void> => {
        for (const datagram of encoder.encode(data)) {
          if (socket.bufferedAmount >= sendWindowBytes) {
            while (socket.bufferedAmount > sendWindowLowBytes) {
              if (!sendable()) throw sendCut();
              await waitForWindow();
            }
          }
          if (!sendable()) throw sendCut();
          socket.send(ownedBytes(datagram));
        }
      };

      onMessage = (event) => {
        if (typeof event.data === "string") {
          settleCloseWait?.("peer-gone");
          controls.fail(
            relayProtocolError(
              "sent a control message after the exchange started",
            ),
          );
          return;
        }
        let outcome;
        try {
          outcome = bounds.accept(toFrameBytes(event.data));
        } catch (err) {
          settleCloseWait?.("peer-gone");
          controls.fail(asConnectionError(err, "protocol"));
          return;
        }
        if (outcome.kind === "pending") return;
        if (outcome.kind === "close") {
          peerCloseRead = true;
          settleCloseWait?.("peer-closed");
          // `finish`: the sentinel follows every frame the partner sent, so a
          // final frame may still be queued and is drained first.
          controls.finish(
            new ConnectionError("peer connection closed", "transport"),
          );
          return;
        }
        controls.deliver(outcome.value);
      };
      onClose = (event) => {
        settleCloseWait?.(
          event.code === CLOSE_NORMAL ? "peer-closed" : "peer-gone",
        );
        if (event.code === CLOSE_NORMAL)
          controls.finish(
            new ConnectionError("peer connection closed", "transport"),
          );
        else controls.fail(forwardingCloseError(event));
      };

      const waitForRelayedClose = () =>
        new Promise<PeerCloseOutcome>((resolve) => {
          const signal = options.signal;
          if (signal?.aborted) {
            resolve("run-aborted");
            return;
          }
          const settle = (outcome: PeerCloseOutcome) => {
            if (settleCloseWait !== settle) return;
            settleCloseWait = undefined;
            clearTimeout(ceiling);
            signal?.removeEventListener("abort", onAbort);
            resolve(outcome);
          };
          const onAbort = () => settle("run-aborted");
          const ceiling = setTimeout(
            () => settle("ceiling"),
            closeDrainTimeoutMs,
          );
          settleCloseWait = settle;
          signal?.addEventListener("abort", onAbort);
          try {
            socket.send(ownedBytes(packCloseSentinel()));
          } catch {
            settle("peer-gone");
          }
        });

      return {
        outboundWebRtcFrameBound: () => bounds.limits.maxFrameBytes,
        inboundPsiSetElementCeiling: () => BROWSER_PSI_SET_MAX_ELEMENTS,
        send: (data) => {
          const frame = sendQueue.then(() => sendFrame(data));
          sendQueue = frame.catch(() => {});
          return frame;
        },
        close: async (closeOptions) => {
          sendStopped = true;
          wakeSend?.();
          if (closeOptions?.flush && socketOpen()) {
            await sendQueue;
            const outcome = socketOpen()
              ? await waitForRelayedClose()
              : "peer-gone";
            options.onCloseOutcome?.(outcome);
            socket.close(
              outcome === "peer-closed" ? CLOSE_NORMAL : CLOSE_ABNORMAL,
            );
            return;
          }
          // Having read the partner's sentinel, the clean close is what the
          // partner's own close waits for.
          socket.close(peerCloseRead ? CLOSE_NORMAL : CLOSE_ABNORMAL);
        },
      };
    },
    {
      inactivityTimeoutMs:
        options.inactivityTimeoutMs ?? DEFAULT_RELAY_INACTIVITY_TIMEOUT_MS,
    },
  );
  return {
    connection,
    onMessage: (event) => onMessage(event),
    onClose: (event) => onClose(event),
  };
}
