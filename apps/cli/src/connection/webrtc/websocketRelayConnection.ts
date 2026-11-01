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
 * The CLI's transport over the WebSocket relay (docs/spec/WEBSOCKET_RELAY.md,
 * The command-line client) as a {@link MessageConnection}: one socket to the
 * relay at a time, a hello proving the exchange's relay key, a start the caller
 * may hold back until the run chooses the relay, and then the WebRTC
 * transport's framing as binary messages the relay forwards unread -- the same
 * chunk envelopes, the same bounded reassembler, the same send window, and the
 * same close sentinel (docs/spec/WEBRTC_TRANSPORT.md, Framing). It runs on
 * Node's own WebSocket client, which answers the relay's pings and sends none
 * of its own.
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
  /**
   * The run's key file shows a run that stopped between the two saves of a
   * rotation: it holds a previous secret, or a rotation-in-flight marker. A
   * relay refusing this side's proof may then hold the key of the secret only
   * the partner saved, or only this side did.
   */
  afterCutRotation?: boolean;
}

/** What a caller can vary about a relay connection. */
export interface WebSocketRelayConnectionOptions {
  /**
   * How long the relay may take to pair this side with its partner, counted
   * from the first dial across every socket after it; the rendezvous budget.
   */
  rendezvousTimeoutMs?: number;
  /**
   * The wait for the partner's start once the relay has paired this side and
   * this side has sent its own; the channel-open budget.
   */
  channelOpenTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  closeFlushTimeoutMs?: number;
  /** Ends the dial early, closing the socket. */
  signal?: AbortSignal;
  /** Tests, and the relay check, which watches each socket's close through it. */
  socketFactory?: (url: string) => WebSocket;
  /** Tests only. */
  now?: () => Date;
  /** Tests only. */
  openTimeoutMs?: number;
  /** Tests only. */
  redialIntervalMs?: number;
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
 * How long a relay that has not started waits before it dials again after a
 * close that calls for it (docs/spec/WEBSOCKET_RELAY.md, The command-line
 * client). An arbitrary working value.
 */
export const RELAY_REDIAL_INTERVAL_MS = 5_000;

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
const WEBSOCKET_CLOSING = 2;
const WEBSOCKET_CLOSED = 3;

/** The relay's close codes: docs/spec/WEBSOCKET_RELAY.md, Close codes. */
export const RELAY_CLOSE = {
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
  queueLimit: 4010,
} as const;

const RELAY_CLOSE_CODES: ReadonlySet<number> = new Set(
  Object.values(RELAY_CLOSE),
);

/**
 * The relay's close codes after which a relay that has not started dials
 * again: the partner may enroll the key later (4003), an earlier socket of
 * this side may still hold the role (4006), the partner left the pairing
 * (1000, 4000), or the pairing sat idle (4009).
 */
const REDIALED_RELAY_CLOSES: ReadonlySet<number> = new Set([
  RELAY_CLOSE.normal,
  RELAY_CLOSE.partnerAbnormal,
  RELAY_CLOSE.notEnrolled,
  RELAY_CLOSE.roleTaken,
  RELAY_CLOSE.idle,
]);

/** Whether a close before the start is dialed again on; any code the relay does not send is a drop. */
function redialsOn(code: number): boolean {
  return REDIALED_RELAY_CLOSES.has(code) || !RELAY_CLOSE_CODES.has(code);
}

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

/**
 * The failure a message the relay sends before the exchange starts becomes,
 * where this side does not take that message at that point.
 */
export class UnexpectedRelayMessageError extends ConnectionError {}

function withNextStep(message: string, kind: "transport" | "protocol") {
  return markStatesItsOwnNextStep(new ConnectionError(message, kind));
}

/**
 * The failure a relay close before the exchange starts becomes, stating what
 * the code means and what to do. After a cut rotation
 * ({@link WebSocketRelayDial.afterCutRotation}) a refused proof is the state
 * docs/spec/WEBSOCKET_RELAY.md, "A one-sided allocation", describes, where
 * replacing the relay key would refuse the partner instead.
 *
 * @internal exported for testing
 */
export function relayRefusalError(
  url: string,
  code: number,
  reason: string,
  afterCutRotation = false,
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
      if (afterCutRotation)
        return withNextStep(
          `${relay} holds a key for this exchange other than the one this ` +
            "side's shared secret derives. A run stopped before both of you " +
            "saved a new shared secret, so the key may be the one your " +
            "partner's secret derives: leave it in place, since the exchange " +
            "can still meet over WebRTC or another relay. If no run meets " +
            "your partner, ask your partner for a new invitation.",
          "transport",
        );
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
          "started. Agree on a time with your partner, and run the exchange " +
          "again.",
        "transport",
      );
    case RELAY_CLOSE.idle:
      return withNextStep(
        `${relay} closed the connection because nothing crossed it within ` +
          "its idle limit. Agree on a time with your partner, and run the " +
          "exchange again.",
        "transport",
      );
    case RELAY_CLOSE.queueLimit:
      return withNextStep(
        `${relay} ended the exchange because the exchange partner stopped ` +
          "receiving. Run the exchange again.",
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
    case RELAY_CLOSE.queueLimit:
      return new ConnectionError(
        "the WebSocket relay ended the exchange because the exchange " +
          "partner stopped receiving",
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
 * A relay socket held with its hello sent and this side's start held back
 * until {@link ParkedWebSocketRelay.start}: what {@link parkWebSocketRelay}
 * returns.
 */
export interface ParkedWebSocketRelay {
  /** The relay's address. */
  readonly url: string;
  /** Whether the relay has paired this side with its partner on the socket held now. */
  readonly paired: boolean;
  /** Whether the partner's start has reached this side on that pairing. */
  readonly partnerStarted: boolean;
  /**
   * Why the relay ended before the exchange started on it, once it has. It
   * stays undefined after {@link close}.
   */
  readonly failure: ConnectionError | undefined;
  /**
   * Call `listener` after each change of `paired`, `partnerStarted` or
   * `failure`, until {@link close}. Returns the call that removes it.
   */
  onChange(listener: () => void): () => void;
  /**
   * Send this side's start, behind the hello on a socket that has not opened
   * yet and on every socket dialed after it, and resolve with the connection
   * once the partner's start has arrived. Each call returns the same promise.
   *
   * @throws {ConnectionError} with the relay's {@link failure}, or of kind
   *   `closed` after {@link close}.
   */
  start(): Promise<MessageConnection>;
  /**
   * Stop dialing and close the socket: with 1000 while this side's start has
   * not been sent on it, and with {@link RELAY_ABANDON_CLOSE_CODE} once it
   * has, since a partner that has read the start may hold a connection that
   * must not take the close for delivery. Does nothing once {@link start} has
   * resolved, as the connection then owns the socket.
   */
  close(): void;
}

/**
 * Dial the relay and send the hello, holding this side's start until
 * {@link ParkedWebSocketRelay.start}. Until the exchange begins, a
 * close the spec lists (docs/spec/WEBSOCKET_RELAY.md, The command-line
 * client) is followed by a new socket {@link RELAY_REDIAL_INTERVAL_MS} later,
 * while the rendezvous budget lasts. A proof the relay refuses as expired is
 * made again once on the relay's clock, which its refusal states, and every
 * later proof on that clock too.
 */
export function parkWebSocketRelay(
  dial: WebSocketRelayDial,
  options: WebSocketRelayConnectionOptions = {},
): ParkedWebSocketRelay {
  return new ParkedRelay(dial, options);
}

/**
 * Dial the relay, send the hello and the start, and resolve with the
 * {@link MessageConnection} once the relay has paired this side with its
 * partner and passed on the partner's start: {@link parkWebSocketRelay} with
 * the start sent at once.
 *
 * @throws {ConnectionError} if the relay cannot be reached, refuses the hello,
 *   or the partner does not arrive or start within its budget.
 */
export function openWebSocketRelayMessageConnection(
  dial: WebSocketRelayDial,
  options: WebSocketRelayConnectionOptions = {},
): Promise<MessageConnection> {
  return parkWebSocketRelay(dial, options).start();
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

/** One socket of a {@link ParkedRelay}, from its dial until it closes or starts. */
interface RelaySocket {
  socket: WebSocket;
  /** `connecting` until it opens and sends its hello. */
  phase: "connecting" | "awaiting-pair" | "paired";
  startSent: boolean;
  /** The wait for the socket to open, then for the partner's start. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Set once the exchange has started, to take every later message. */
  forwarding: RelayForwarding | undefined;
  /** Clears the timer and removes the open and close listeners. */
  detachSetup: () => void;
  /** {@link detachSetup}, and removes the message listener too. */
  detach: () => void;
}

const cancelledError = (): ConnectionError =>
  new ConnectionError(
    "the connection to the WebSocket relay was stopped",
    "closed",
  );

class ParkedRelay implements ParkedWebSocketRelay {
  readonly url: string;
  paired = false;
  partnerStarted = false;
  failure: ConnectionError | undefined;

  private state: "dialing" | "open" | "failed" | "closed" = "dialing";
  private startRequested = false;
  private starting:
    | {
        promise: Promise<MessageConnection>;
        resolve: (connection: MessageConnection) => void;
        reject: (error: ConnectionError) => void;
      }
    | undefined;
  private current: RelaySocket | undefined;
  private lastRefusal: ConnectionError | undefined;
  private rendezvousEnded = false;
  private clockCorrected = false;
  private clockOffsetMs = 0;
  private readonly rendezvousTimer: ReturnType<typeof setTimeout>;
  private redialTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly onAbort = (): void => this.fail(cancelledError());

  constructor(
    private readonly dial: WebSocketRelayDial,
    private readonly options: WebSocketRelayConnectionOptions,
  ) {
    this.url = dial.url;
    this.rendezvousTimer = setTimeout(
      () => this.onRendezvousEnd(),
      options.rendezvousTimeoutMs ?? DEFAULT_RENDEZVOUS_TIMEOUT_MS,
    );
    const { signal } = options;
    if (signal?.aborted) {
      this.fail(cancelledError());
      return;
    }
    signal?.addEventListener("abort", this.onAbort, { once: true });
    void this.dialSocket();
  }

  onChange(listener: () => void): () => void {
    if (this.state === "closed") return () => {};
    const call = (): void => listener();
    this.listeners.add(call);
    return () => this.listeners.delete(call);
  }

  start(): Promise<MessageConnection> {
    if (this.starting !== undefined) return this.starting.promise;
    let resolve!: (connection: MessageConnection) => void;
    let reject!: (error: ConnectionError) => void;
    const promise = new Promise<MessageConnection>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.starting = { promise, resolve, reject };
    if (this.state === "failed" && this.failure !== undefined)
      reject(this.failure);
    else if (this.state === "closed") reject(cancelledError());
    else {
      this.startRequested = true;
      const current = this.current;
      if (current !== undefined && current.phase !== "connecting")
        this.sendStart(current);
    }
    return promise;
  }

  close(): void {
    if (this.state !== "dialing") return;
    this.state = "closed";
    this.listeners.clear();
    this.teardown(
      this.current?.startSent === true
        ? RELAY_ABANDON_CLOSE_CODE
        : RELAY_CLOSE.normal,
    );
    this.paired = false;
    this.partnerStarted = false;
    this.starting?.reject(cancelledError());
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private async dialSocket(): Promise<void> {
    let hello: string;
    try {
      const now = (this.options.now ?? (() => new Date()))();
      hello = await webSocketRelayHello(
        this.dial,
        new Date(now.getTime() + this.clockOffsetMs),
      );
    } catch (err) {
      this.fail(asConnectionError(err, "transport"));
      return;
    }
    if (this.state !== "dialing") return;
    let socket: WebSocket;
    try {
      socket = (this.options.socketFactory ?? ((url) => new WebSocket(url)))(
        this.url,
      );
    } catch (err) {
      this.fail(asConnectionError(err, "transport"));
      return;
    }
    socket.binaryType = "arraybuffer";
    const onOpen = (): void => this.onOpen(current, hello);
    const onMessage = (event: MessageEvent): void => {
      if (current.forwarding !== undefined)
        current.forwarding.onMessage(event.data);
      else this.onMessage(current, event);
    };
    const onClose = (event: CloseEvent): void => this.onClose(current, event);
    const current: RelaySocket = {
      socket,
      phase: "connecting",
      startSent: false,
      timer: setTimeout(
        () => this.onOpenExpired(current),
        this.options.openTimeoutMs ?? RELAY_OPEN_TIMEOUT_MS,
      ),
      forwarding: undefined,
      detachSetup: () => {
        clearTimeout(current.timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("close", onClose);
      },
      detach: () => {
        current.detachSetup();
        socket.removeEventListener("message", onMessage);
      },
    };
    this.current = current;
    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
  }

  private onOpen(current: RelaySocket, hello: string): void {
    clearTimeout(current.timer);
    current.phase = "awaiting-pair";
    current.socket.send(hello);
    if (this.startRequested) this.sendStart(current);
  }

  private sendStart(current: RelaySocket): void {
    if (current.startSent) return;
    current.startSent = true;
    current.socket.send(START_FRAME);
    if (current.phase !== "paired") return;
    if (this.partnerStarted) this.open(current);
    else this.armStartWait(current);
  }

  private armStartWait(current: RelaySocket): void {
    clearTimeout(current.timer);
    current.timer = setTimeout(
      () =>
        this.fail(
          withNextStep(
            "the exchange partner reached the WebSocket relay at " +
              `${this.url} but did not start the exchange in time. Run ` +
              "the exchange again.",
            "transport",
          ),
        ),
      this.options.channelOpenTimeoutMs ?? DEFAULT_CHANNEL_OPEN_TIMEOUT_MS,
    );
  }

  private onMessage(current: RelaySocket, event: MessageEvent): void {
    const type =
      typeof event.data === "string" ? controlFrameType(event.data) : undefined;
    if (current.phase === "awaiting-pair" && type === "paired") {
      current.phase = "paired";
      this.paired = true;
      this.lastRefusal = undefined;
      if (current.startSent) this.armStartWait(current);
      this.notify();
      return;
    }
    if (
      current.phase === "paired" &&
      type === "start" &&
      !this.partnerStarted
    ) {
      this.partnerStarted = true;
      if (current.startSent) this.open(current);
      this.notify();
      return;
    }
    this.fail(
      markStatesItsOwnNextStep(
        new UnexpectedRelayMessageError(
          `the WebSocket relay at ${this.url} sent a message this side does ` +
            "not take at that point. Check that connection.websocket_relay " +
            "names an Alcove WebSocket relay.",
          "protocol",
        ),
      ),
    );
  }

  private onClose(current: RelaySocket, event: CloseEvent): void {
    current.detach();
    this.current = undefined;
    const wasPaired = this.paired;
    this.paired = false;
    this.partnerStarted = false;
    const refusal = relayRefusalError(
      this.url,
      event.code,
      event.reason,
      this.dial.afterCutRotation === true,
    );
    if (refusal instanceof ProofExpiredRefusal) {
      const relayNowMs =
        refusal.relayNowSeconds === undefined
          ? Number.NaN
          : new Date(refusal.relayNowSeconds * 1000).getTime();
      if (this.clockCorrected) {
        this.fail(proofExpiredOnRelayClockError(this.url));
      } else if (Number.isNaN(relayNowMs)) {
        this.fail(refusal);
      } else {
        this.clockCorrected = true;
        const now = (this.options.now ?? (() => new Date()))();
        this.clockOffsetMs = relayNowMs - now.getTime();
        void this.dialSocket();
      }
      return;
    }
    if (!redialsOn(event.code)) {
      this.fail(refusal);
      return;
    }
    this.redial(refusal);
    if (wasPaired && this.state === "dialing") this.notify();
  }

  private onOpenExpired(current: RelaySocket): void {
    current.detach();
    this.current = undefined;
    current.socket.close(RELAY_ABANDON_CLOSE_CODE);
    this.redial(relayNotAnsweredError(this.url));
  }

  private redial(refusal: ConnectionError): void {
    this.lastRefusal = refusal;
    if (this.rendezvousEnded) {
      this.fail(refusal);
      return;
    }
    this.redialTimer = setTimeout(() => {
      this.redialTimer = undefined;
      void this.dialSocket();
    }, this.options.redialIntervalMs ?? RELAY_REDIAL_INTERVAL_MS);
  }

  private onRendezvousEnd(): void {
    this.rendezvousEnded = true;
    if (this.state !== "dialing" || this.paired) return;
    const current = this.current;
    this.fail(
      current?.phase === "awaiting-pair"
        ? withNextStep(
            "the exchange partner did not reach the WebSocket relay at " +
              `${this.url} in time. Agree on a time with your partner, and run ` +
              "the exchange again.",
            "transport",
          )
        : (this.lastRefusal ?? relayNotAnsweredError(this.url)),
    );
  }

  private open(current: RelaySocket): void {
    this.state = "open";
    this.teardownTimers();
    current.detachSetup();
    this.current = undefined;
    const connection = relayMessageConnection(
      current.socket,
      this.options,
      (forwarding) => {
        current.forwarding = forwarding;
      },
    );
    this.starting?.resolve(connection);
  }

  private fail(error: ConnectionError): void {
    if (this.state !== "dialing") return;
    this.state = "failed";
    this.failure = error;
    this.teardown(RELAY_ABANDON_CLOSE_CODE);
    this.paired = false;
    this.partnerStarted = false;
    this.starting?.reject(error);
    this.notify();
  }

  private teardownTimers(): void {
    clearTimeout(this.rendezvousTimer);
    clearTimeout(this.redialTimer);
    this.options.signal?.removeEventListener("abort", this.onAbort);
  }

  private teardown(code: number): void {
    this.teardownTimers();
    const current = this.current;
    this.current = undefined;
    if (current === undefined) return;
    current.detach();
    if (current.socket.readyState < WEBSOCKET_CLOSING)
      current.socket.close(code);
  }
}

/** The failure a relay socket that does not open in time becomes. */
function relayNotAnsweredError(url: string): ConnectionError {
  return withNextStep(
    `the WebSocket relay at ${url} did not answer in time. Check that this ` +
      "computer can reach it and that connection.websocket_relay names its " +
      "address and path, and run the exchange again.",
    "transport",
  );
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
