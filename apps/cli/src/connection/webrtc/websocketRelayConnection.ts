import {
  BoundedInboundFrames,
  ConnectionError,
  INACTIVITY_TIMEOUT_KEY,
  PeerJsFrameEncoder,
  QueuedMessageConnection,
  WEBSOCKET_RELAY_PROOF_MAX_TTL_SECONDS,
  asConnectionError,
  buildWebSocketRelayProof,
  markStatesItsOwnNextStep,
  packCloseSentinel,
  parseBoundedJson,
  toFrameBytes,
} from "@alcove/core";

import { inactivityTimeoutGuidance } from "../timeoutGuidance";
import {
  DEFAULT_CLOSE_FLUSH_TIMEOUT_MS,
  DEFAULT_WEBRTC_INACTIVITY_TIMEOUT_MS,
  FINAL_FRAME_UNCONFIRMED_LINK_LOST_MESSAGE,
  FINAL_FRAME_UNCONFIRMED_WAIT_EXPIRED_MESSAGE,
  FinalFrameUnconfirmedError,
  SEND_WINDOW_BYTES,
  SEND_WINDOW_LOW_BYTES,
} from "./webrtcMessageConnection";
import {
  DEFAULT_CHANNEL_OPEN_TIMEOUT_MS,
  DEFAULT_RENDEZVOUS_TIMEOUT_MS,
} from "./weriftPeer";

import type { MessageConnection, RendezvousRole } from "@alcove/core";

/**
 * The CLI's transport over the WebSocket relay (docs/spec/WEBSOCKET_RELAY.md)
 * as a {@link MessageConnection}: one socket to the relay, a hello proving the
 * exchange's relay key, a start, and then the WebRTC transport's framing as
 * binary messages the relay forwards unread -- the same chunk envelopes, the
 * same bounded reassembler, the same send window, and the same close sentinel
 * (docs/spec/WEBRTC_TRANSPORT.md, Framing). It runs on Node's own WebSocket
 * client, which answers the relay's pings and sends none of its own.
 *
 * A clean close sends the sentinel and waits for the partner's close to reach
 * this socket through the relay: TCP acknowledges a message to the relay, not
 * to the partner, so that close is the one delivery signal there is (the
 * limit when both close at once: the spec's Delivery bullet). The relay forwards a party's close code 1000 as 1000, so this
 * side closes with 1000 only on a clean close and with
 * {@link RELAY_ABANDON_CLOSE_CODE} on any other end, and a partner never
 * reads a failure as delivery.
 */

/** What a relay socket is dialed with, resolved before anything is dialed. */
export interface WebSocketRelayDial {
  /** The relay's `wss://` address. */
  url: string;
  /** The exchange id the relay key is enrolled under. */
  exchangeId: string;
  /** The exchange's relay key, as 64 lowercase hex characters. */
  relayKey: string;
  role: RendezvousRole;
}

/** What a caller can vary about a relay connection. */
export interface WebSocketRelayConnectionOptions {
  /** The wait for the partner's hello to verify; the rendezvous budget. */
  rendezvousTimeoutMs?: number;
  /** The wait for the partner's start once paired; the channel-open budget. */
  channelOpenTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  closeFlushTimeoutMs?: number;
  /** Ends the dial early, closing the socket. */
  signal?: AbortSignal;
  /** Tests only. */
  socketFactory?: (url: string) => WebSocket;
  /** Tests only. */
  now?: () => Date;
  /** Tests only. */
  openTimeoutMs?: number;
  /** Tests only. */
  sendWindowBytes?: number;
  /** Tests only. */
  sendWindowLowBytes?: number;
  /** Tests only. */
  sendWindowPollMs?: number;
  /** Tests only, to lower the reassembler's limits. */
  inboundFrames?: () => BoundedInboundFrames;
}

/** Longest the socket's TCP, TLS and WebSocket handshakes may take. */
export const RELAY_OPEN_TIMEOUT_MS = 30_000;

/**
 * Longest an answering close waits for the relay to complete it, so the close
 * frame that confirms delivery to the partner leaves this host.
 */
const CLOSE_ANSWER_TIMEOUT_MS = 10_000;

/**
 * How often a send waiting on the window re-reads `bufferedAmount`, which a
 * WebSocket raises no event for.
 */
const SEND_WINDOW_POLL_MS = 10;

/**
 * The close code this side ends a pairing with on anything but a clean close.
 * The relay closes the partner with 4000 on any code but 1000.
 */
export const RELAY_ABANDON_CLOSE_CODE = 4000;

const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSED = 3;

/** The relay's close codes: docs/spec/WEBSOCKET_RELAY.md, Close codes. */
const RELAY_CLOSE = {
  normal: 1000,
  goingAway: 1001,
  tooBig: 1009,
  uncheckable: 1011,
  partnerAbnormal: 4000,
  malformedHello: 4001,
  unexpected: 4002,
  notEnrolled: 4003,
  proofRefused: 4004,
  proofExpired: 4005,
  roleTaken: 4006,
  helloTimeout: 4007,
  full: 4008,
  idle: 4009,
} as const;

/**
 * The hello frame a party sends first: its role, the exchange id its relay key
 * is enrolled under, and a proof of that key made at `now`
 * (docs/spec/WEBSOCKET_RELAY.md, The hello).
 *
 * @internal exported for testing
 */
export async function webSocketRelayHello(
  dial: WebSocketRelayDial,
  now: Date,
): Promise<string> {
  const proof = await buildWebSocketRelayProof({
    relayKey: dial.relayKey,
    role: dial.role,
    ttlSeconds: WEBSOCKET_RELAY_PROOF_MAX_TTL_SECONDS,
    now,
  });
  return JSON.stringify({
    type: "hello",
    exchangeId: dial.exchangeId,
    role: dial.role,
    proof: new TextDecoder().decode(proof.message),
    tag: Buffer.from(proof.tag).toString("hex"),
  });
}

const START_FRAME = JSON.stringify({ type: "start" });

/** A refusal of an expired proof, holding the relay's clock. */
class ProofExpiredRefusal extends ConnectionError {
  constructor(
    message: string,
    readonly relayNowSeconds: number | undefined,
  ) {
    super(message, "transport");
  }
}

function withNextStep(message: string, kind: "transport" | "protocol") {
  return markStatesItsOwnNextStep(new ConnectionError(message, kind));
}

/**
 * The failure a relay close before the exchange starts becomes, stating what
 * the code means and what to do.
 *
 * @internal exported for testing
 */
export function relayRefusalError(
  url: string,
  code: number,
  reason: string,
): ConnectionError {
  const relay = `the WebSocket relay at ${url}`;
  switch (code) {
    case RELAY_CLOSE.notEnrolled:
      return withNextStep(
        `${relay} holds no key for this exchange. Enroll the exchange at the ` +
          "relay's registrar with 'alcove enroll-relay', and run the exchange " +
          "again.",
        "transport",
      );
    case RELAY_CLOSE.proofRefused:
      return withNextStep(
        `${relay} holds a key for this exchange other than the one this ` +
          "side's shared secret derives. Register the current key with " +
          "'alcove enroll-relay --replace-relay-key', and run the exchange " +
          "again.",
        "transport",
      );
    case RELAY_CLOSE.proofExpired:
      return markStatesItsOwnNextStep(
        new ProofExpiredRefusal(
          `${relay} refused this side's proof as expired, so this computer's ` +
            "clock and the relay's differ by more than five minutes. Correct " +
            "this computer's clock, and run the exchange again.",
          /^(0|[1-9][0-9]{0,15})$/.test(reason) ? Number(reason) : undefined,
        ),
      );
    case RELAY_CLOSE.roleTaken:
      return withNextStep(
        `${relay} already holds a connection in this side's role for this ` +
          "exchange, from your partner if both of you set the same " +
          "connection.role, or from an earlier run of this side. Check that " +
          "your connection.role differs from your partner's, and run the " +
          "exchange again.",
        "transport",
      );
    case RELAY_CLOSE.full:
      return withNextStep(
        `${relay} is serving as many exchanges as it allows. Run the ` +
          "exchange again later.",
        "transport",
      );
    case RELAY_CLOSE.uncheckable:
      return withNextStep(
        `${relay} could not check this side's proof. Ask the relay's ` +
          "operator to check its key table, and run the exchange again.",
        "transport",
      );
    case RELAY_CLOSE.goingAway:
      return withNextStep(
        `${relay} shut down. Run the exchange again once it is back.`,
        "transport",
      );
    case RELAY_CLOSE.normal:
    case RELAY_CLOSE.partnerAbnormal:
      return withNextStep(
        "the exchange partner left the WebSocket relay before the exchange " +
          "started. Agree a time with your partner, and run the exchange " +
          "again.",
        "transport",
      );
    case RELAY_CLOSE.idle:
      return withNextStep(
        `${relay} closed the connection because nothing crossed it within ` +
          "its idle limit. Agree a time with your partner, and run the " +
          "exchange again.",
        "transport",
      );
    case RELAY_CLOSE.tooBig:
    case RELAY_CLOSE.malformedHello:
    case RELAY_CLOSE.unexpected:
    case RELAY_CLOSE.helloTimeout:
      return withNextStep(
        `${relay} refused a message this side sent (close code ${code}). ` +
          "Check that connection.websocket_relay names an Alcove WebSocket " +
          "relay.",
        "protocol",
      );
    default:
      return withNextStep(
        `the connection to ${relay} closed before the exchange started ` +
          `(close code ${code}). Check that this computer can reach the ` +
          "relay and that connection.websocket_relay names its address and " +
          "path, and run the exchange again.",
        "transport",
      );
  }
}

/** The failure a relay close after the exchange has started becomes. */
function relayDropError(code: number): ConnectionError {
  switch (code) {
    case RELAY_CLOSE.partnerAbnormal:
      return new ConnectionError(
        "the exchange partner's connection to the WebSocket relay ended " +
          "without a clean close",
        "transport",
      );
    case RELAY_CLOSE.idle:
      return new ConnectionError(
        "the WebSocket relay closed the connection because nothing crossed " +
          "it within its idle limit",
        "transport",
      );
    case RELAY_CLOSE.goingAway:
      return new ConnectionError("the WebSocket relay shut down", "transport");
    default:
      return new ConnectionError(
        `the connection to the WebSocket relay was lost (close code ${code})`,
        "transport",
      );
  }
}

/** The relay control frame a text message holds, or undefined for any other. */
function controlFrameType(text: string): "paired" | "start" | undefined {
  let value: unknown;
  try {
    value = parseBoundedJson(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "type") return undefined;
  const { type } = value as { type: unknown };
  return type === "paired" || type === "start" ? type : undefined;
}

/**
 * Dial the relay, send the hello and the start, and resolve with the
 * {@link MessageConnection} once the relay has paired this side with its
 * partner and passed on the partner's start. A proof the relay refuses as
 * expired is made again once on the relay's clock, which its refusal states.
 *
 * @throws {ConnectionError} if the relay cannot be reached, refuses the hello,
 *   or the partner does not arrive or start within its budget.
 */
export async function openWebSocketRelayMessageConnection(
  dial: WebSocketRelayDial,
  options: WebSocketRelayConnectionOptions = {},
): Promise<MessageConnection> {
  const now = options.now ?? (() => new Date());
  try {
    return await dialRelayOnce(dial, options, now());
  } catch (err) {
    if (
      !(err instanceof ProofExpiredRefusal) ||
      err.relayNowSeconds === undefined
    )
      throw err;
    const relayNow = new Date(err.relayNowSeconds * 1000);
    if (Number.isNaN(relayNow.getTime())) throw err;
    try {
      return await dialRelayOnce(dial, options, relayNow);
    } catch (retryErr) {
      if (retryErr instanceof ProofExpiredRefusal)
        throw proofExpiredOnRelayClockError(dial.url);
      throw retryErr;
    }
  }
}

/**
 * The failure a second expired refusal becomes: that proof was made on the
 * relay's own clock, so this computer's clock is not the cause.
 */
function proofExpiredOnRelayClockError(url: string): ConnectionError {
  return withNextStep(
    `the WebSocket relay at ${url} refused this side's proof as expired ` +
      "twice, the second time with a proof made on the relay's own clock. " +
      "Run the exchange again, and if the relay refuses it the same way, " +
      "check the relay and the exchange's enrollment at its registrar.",
    "transport",
  );
}

type RelayPhase =
  "connecting" | "awaiting-pair" | "awaiting-start" | "open" | "refused";

async function dialRelayOnce(
  dial: WebSocketRelayDial,
  options: WebSocketRelayConnectionOptions,
  proofTime: Date,
): Promise<MessageConnection> {
  const hello = await webSocketRelayHello(dial, proofTime);
  const { signal } = options;
  const cancelled = (): ConnectionError =>
    new ConnectionError(
      "the connection to the WebSocket relay was stopped",
      "closed",
    );
  if (signal?.aborted) throw cancelled();

  return new Promise<MessageConnection>((resolve, reject) => {
    const socket = (options.socketFactory ?? ((url) => new WebSocket(url)))(
      dial.url,
    );
    socket.binaryType = "arraybuffer";
    let phase: RelayPhase = "connecting";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forwarding: RelayForwarding | undefined;

    const arm = (ms: number, onExpiry: () => ConnectionError): void => {
      clearTimeout(timer);
      timer = setTimeout(() => abandon(onExpiry()), ms);
    };

    const onAbort = (): void => abandon(cancelled());

    function detachDial(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    function abandon(error: ConnectionError): void {
      if (phase === "open" || phase === "refused") return;
      phase = "refused";
      detachDial();
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.close(RELAY_ABANDON_CLOSE_CODE);
      reject(error);
    }

    function onOpen(): void {
      if (phase !== "connecting") return;
      phase = "awaiting-pair";
      socket.send(hello);
      socket.send(START_FRAME);
      arm(options.rendezvousTimeoutMs ?? DEFAULT_RENDEZVOUS_TIMEOUT_MS, () =>
        withNextStep(
          "the exchange partner did not reach the WebSocket relay at " +
            `${dial.url} in time. Agree a time with your partner, and run ` +
            "the exchange again.",
          "transport",
        ),
      );
    }

    function onMessage(event: MessageEvent): void {
      if (phase === "open") {
        forwarding?.onMessage(event.data);
        return;
      }
      const type =
        typeof event.data === "string"
          ? controlFrameType(event.data)
          : undefined;
      if (phase === "awaiting-pair" && type === "paired") {
        phase = "awaiting-start";
        arm(
          options.channelOpenTimeoutMs ?? DEFAULT_CHANNEL_OPEN_TIMEOUT_MS,
          () =>
            withNextStep(
              "the exchange partner reached the WebSocket relay at " +
                `${dial.url} but did not start the exchange in time. Run ` +
                "the exchange again.",
              "transport",
            ),
        );
        return;
      }
      if (phase === "awaiting-start" && type === "start") {
        phase = "open";
        detachDial();
        socket.removeEventListener("close", onClose);
        resolve(
          relayMessageConnection(socket, options, (created) => {
            forwarding = created;
          }),
        );
        return;
      }
      abandon(
        withNextStep(
          `the WebSocket relay at ${dial.url} sent a message this side does ` +
            "not take at that point. Check that connection.websocket_relay " +
            "names an Alcove WebSocket relay.",
          "protocol",
        ),
      );
    }

    function onClose(event: CloseEvent): void {
      if (phase === "open" || phase === "refused") return;
      phase = "refused";
      detachDial();
      reject(relayRefusalError(dial.url, event.code, event.reason));
    }

    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    arm(options.openTimeoutMs ?? RELAY_OPEN_TIMEOUT_MS, () =>
      withNextStep(
        `the WebSocket relay at ${dial.url} did not answer in time. Check ` +
          "that this computer can reach it and that " +
          "connection.websocket_relay names its address and path, and run " +
          "the exchange again.",
        "transport",
      ),
    );
  });
}

/** The forwarding phase's handler for the socket's inbound messages. */
interface RelayForwarding {
  onMessage: (data: unknown) => void;
}

/**
 * Wrap a socket the relay has started as a {@link MessageConnection}. The
 * inbound handler is installed before this returns, so a message the relay
 * forwards directly behind the partner's start is queued rather than lost.
 */
function relayMessageConnection(
  socket: WebSocket,
  options: WebSocketRelayConnectionOptions,
  install: (forwarding: RelayForwarding) => void,
): MessageConnection {
  const closeFlushTimeoutMs =
    options.closeFlushTimeoutMs ?? DEFAULT_CLOSE_FLUSH_TIMEOUT_MS;
  const sendWindowBytes = options.sendWindowBytes ?? SEND_WINDOW_BYTES;
  const sendWindowLowBytes =
    options.sendWindowLowBytes ?? SEND_WINDOW_LOW_BYTES;
  const sendWindowPollMs = options.sendWindowPollMs ?? SEND_WINDOW_POLL_MS;

  return new QueuedMessageConnection(
    (controls) => {
      const encoder = new PeerJsFrameEncoder();
      const bounds = options.inboundFrames?.() ?? new BoundedInboundFrames();
      let peerCloseRead = false;
      let sentinelSent = false;
      let sendStopped = false;
      let tearingDown = false;
      let sendQueue: Promise<void> = Promise.resolve();
      let closeCode: number | undefined;
      const closeWaiters: Array<(code: number) => void> = [];

      const socketOpen = (): boolean => socket.readyState === WEBSOCKET_OPEN;
      const sendable = (): boolean => !sendStopped && socketOpen();
      const sendCut = (): ConnectionError =>
        new ConnectionError(
          "the connection to the exchange partner closed before a message " +
            "could be sent",
          "transport",
        );

      const sendFrame = async (data: unknown): Promise<void> => {
        for (const datagram of encoder.encode(data)) {
          if (socket.bufferedAmount >= sendWindowBytes) {
            while (socket.bufferedAmount > sendWindowLowBytes) {
              if (!sendable()) throw sendCut();
              await new Promise((wake) => setTimeout(wake, sendWindowPollMs));
            }
          }
          if (!sendable()) throw sendCut();
          socket.send(Buffer.from(datagram));
        }
      };

      const closed = (ms: number): Promise<number | undefined> => {
        if (closeCode !== undefined) return Promise.resolve(closeCode);
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve(undefined), ms);
          closeWaiters.push((code) => {
            clearTimeout(timer);
            resolve(code);
          });
        });
      };

      socket.addEventListener("close", (event: CloseEvent) => {
        closeCode = event.code;
        for (const wake of closeWaiters.splice(0)) wake(event.code);
        if (tearingDown) return;
        if (event.code === RELAY_CLOSE.normal)
          controls.finish(
            new ConnectionError("peer connection closed", "transport"),
          );
        else controls.fail(relayDropError(event.code));
      });

      install({
        onMessage: (data) => {
          let outcome;
          try {
            outcome = bounds.accept(toFrameBytes(data));
          } catch (err) {
            controls.fail(asConnectionError(err, "protocol"));
            return;
          }
          if (outcome.kind === "pending") return;
          if (outcome.kind === "close") {
            peerCloseRead = true;
            // Both sides are in a clean close, each waiting on the other's
            // close, so this side closes now; the wait in `close` then ends
            // on the relay's answer.
            if (sentinelSent && socketOpen()) socket.close(RELAY_CLOSE.normal);
            // `finish`: the sentinel follows every frame the partner sent, so
            // a frame still queued here is drained before the close.
            controls.finish(
              new ConnectionError("peer connection closed", "transport"),
            );
            return;
          }
          controls.deliver(outcome.value);
        },
      });

      return {
        outboundWebRtcFrameBound: () => bounds.limits.maxFrameBytes,
        send: (data) => {
          const frame = sendQueue.then(() => sendFrame(data));
          sendQueue = frame.catch(() => {});
          return frame;
        },
        close: async (closeOptions) => {
          tearingDown = true;
          if (closeOptions?.flush && socketOpen()) {
            const deadline = Date.now() + closeFlushTimeoutMs;
            await Promise.race([
              sendQueue,
              closed(Math.max(0, deadline - Date.now())),
            ]);
            sendStopped = true;
            if (socketOpen()) {
              socket.send(Buffer.from(packCloseSentinel()));
              sentinelSent = true;
            }
            const code = socketOpen()
              ? await closed(Math.max(0, deadline - Date.now()))
              : closeCode;
            if (code === RELAY_CLOSE.normal) return;
            if (socket.readyState !== WEBSOCKET_CLOSED)
              socket.close(RELAY_ABANDON_CLOSE_CODE);
            throw new FinalFrameUnconfirmedError(
              code === undefined
                ? FINAL_FRAME_UNCONFIRMED_WAIT_EXPIRED_MESSAGE
                : FINAL_FRAME_UNCONFIRMED_LINK_LOST_MESSAGE,
            );
          }
          sendStopped = true;
          if (socket.readyState === WEBSOCKET_CLOSED) return;
          if (peerCloseRead || closeOptions?.flush) {
            socket.close(RELAY_CLOSE.normal);
            await closed(CLOSE_ANSWER_TIMEOUT_MS);
            return;
          }
          socket.close(RELAY_ABANDON_CLOSE_CODE);
        },
      };
    },
    {
      inactivityTimeoutMs:
        options.inactivityTimeoutMs ?? DEFAULT_WEBRTC_INACTIVITY_TIMEOUT_MS,
      inactivityHint: inactivityTimeoutGuidance,
      inactivityTimeoutSetting: INACTIVITY_TIMEOUT_KEY,
    },
  );
}
