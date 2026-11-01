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
 * Budgets). It counts from the park, across every socket dialed after it.
 */
const DEFAULT_RELAY_PAIRING_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The wait for the partner's start once the relay has paired the two
 * sockets and this side has sent its own: the WebRTC channel-open budget.
 */
const DEFAULT_RELAY_START_TIMEOUT_MS = 30 * 1000;

/**
 * How long after a close that calls for it the next socket is dialed, before
 * the exchange begins. An arbitrary working value.
 */
const RELAY_REDIAL_INTERVAL_MS = 5 * 1000;

/**
 * How long a socket may stay connecting before it is closed and dialed
 * again. An arbitrary working value, the length of the channel-open budget.
 */
const DEFAULT_RELAY_OPEN_TIMEOUT_MS = 30 * 1000;

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

const RELAY_CLOSE_CODES: ReadonlySet<number> = new Set([
  CLOSE_NORMAL,
  ...Object.values(RelayCloseCode),
]);

/**
 * The closes before the exchange begins that are followed by a new socket:
 * the partner leaving the pairing (1000, 4000), a key the partner may enroll
 * later (4003), an earlier socket of this side still holding the role
 * (4006), and the relay's idle bound (4009).
 */
const REDIALED_RELAY_CLOSES: ReadonlySet<number> = new Set([
  CLOSE_NORMAL,
  RelayCloseCode.partnerEnded,
  RelayCloseCode.notEnrolled,
  RelayCloseCode.roleTaken,
  RelayCloseCode.idle,
]);

/** Whether a close before the exchange begins is followed by a new socket;
 * a code the relay does not send is a dropped connection, and is. */
function redialsOn(code: number): boolean {
  return REDIALED_RELAY_CLOSES.has(code) || !RELAY_CLOSE_CODES.has(code);
}

/** Options for {@link parkWebSocketRelayConnection} and
 * {@link openWebSocketRelayConnection}. */
export interface WebSocketRelayConnectionOptions {
  /** The relay's `wss` url, its `/relay` path included. */
  url: string;
  /** The id the exchange's relay key is enrolled under at the relay. */
  exchangeId: string;
  /** This party's rendezvous role. */
  role: RendezvousRole;
  /** The exchange's relay key, 64 lowercase hex characters. */
  relayKey: string;
  /** The run's record shows a run that stopped between the two saves of a
   * rotation: it holds a previous secret the run offers, or a
   * rotation-in-flight marker. A relay refusing this side's proof may then
   * hold the key of the secret only one side saved. */
  afterCutRotation?: boolean;
  /** Ends the wait for the partner, closing the socket, and cuts the clean
   * close's wait short. */
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
  openTimeoutMs?: number;
  redialIntervalMs?: number;
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
  // fragment. The message names the origin alone: the address can come from
  // the partner's invitation, and its path, query and fragment are free text.
  if (parsed.href.includes("#"))
    throw new ConnectionError(
      `The WebSocket relay address for ${parsed.origin} has a fragment, a part starting with #. Remove the fragment from the relay address, then start the exchange again.`,
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
      `The browser refused to open a connection to the WebSocket relay at ${new URL(url).origin}. Check the relay address, then start the exchange again.`,
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

function couldNotConnectError(): ConnectionError {
  return new ConnectionError(
    "Could not connect to the WebSocket relay. Check the relay address and the network connection, then start the exchange again.",
    "transport",
  );
}

/**
 * The failure for a close the relay sent before forwarding started. Every
 * message names what happened and what to do and uses no relay-chosen text;
 * a 4005 reason is read only as a time to sign a proof on. After a cut
 * rotation a refused proof is the state docs/spec/WEBSOCKET_RELAY.md, "A
 * one-sided allocation", describes, so it names no step that changes a key or
 * a secret.
 */
function setupCloseError(
  event: CloseEvent,
  opened: boolean,
  paired: boolean,
  afterCutRotation: boolean,
): ConnectionError {
  switch (event.code) {
    case RelayCloseCode.notEnrolled:
      return new ConnectionError(
        "The WebSocket relay has no key enrolled for this exchange. Enroll the exchange at the relay's registrar, then start the exchange again.",
        "transport",
      );
    case RelayCloseCode.proofRefused:
      if (afterCutRotation)
        return new ConnectionError(
          "The WebSocket relay refused this side's proof: the key it holds for this exchange is not the one this device's secret gives. A run stopped before both of you saved a new secret, so the key may be the one your partner's secret gives, and the exchange can still reach your partner over WebRTC or another relay. If the next run does not reach them either, reconnect with a new invitation.",
          "transport",
        );
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
  if (!opened) return couldNotConnectError();
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
 * A socket to the WebSocket relay with its hello sent and this side's start
 * held until {@link ParkedWebSocketRelayConnection.start}: what
 * {@link parkWebSocketRelayConnection} returns.
 */
export interface ParkedWebSocketRelayConnection {
  /** The relay address it was parked with. */
  readonly url: string;
  /** Whether the relay has paired this side with its partner on the socket
   * it holds. */
  readonly paired: boolean;
  /** Whether the partner's start has reached this side on that pairing. */
  readonly partnerStarted: boolean;
  /** Why the relay ended before the exchange began on it, once it has. It
   * stays undefined after {@link close}. */
  readonly failure: ConnectionError | undefined;
  /**
   * Call `listener` after each change of `paired`, `partnerStarted` or
   * `failure`, until {@link close}. Returns the call that removes it.
   */
  onChange: (listener: () => void) => () => void;
  /**
   * Send this side's start, behind the hello on a socket that has not opened
   * yet and on every socket dialed after it, and resolve with the connection
   * once the partner's start has arrived. Each call returns the same promise.
   *
   * @throws {ConnectionError} the relay's {@link failure}, or of kind
   *         `closed` after {@link close}.
   */
  start: () => Promise<MessageConnection>;
  /**
   * Stop dialing and close the socket: with 1000 while this side's start has
   * not been sent on it, and with 4000 once it has, since a partner that has
   * read the start may hold a started connection that must not take the
   * close for delivery. Does nothing once {@link start} has resolved, as the
   * connection then owns the socket, or once the relay has failed.
   */
  close: () => void;
}

/**
 * Dial the WebSocket relay at `options.url` and send the hello with a proof
 * under the exchange's relay key, holding this side's start until
 * {@link ParkedWebSocketRelayConnection.start} (docs/spec/WEBSOCKET_RELAY.md,
 * The web application's client).
 *
 * Until the exchange begins, a close the spec lists is followed by a new
 * socket {@link RELAY_REDIAL_INTERVAL_MS} later, while the pairing wait
 * lasts. A proof the relay refuses as expired is signed again once, on the
 * second the refusal states as the relay's clock, and so is every later
 * proof. It never throws: an address or relay key it refuses is its
 * {@link ParkedWebSocketRelayConnection.failure}, of kind `usage`.
 */
export function parkWebSocketRelayConnection(
  options: WebSocketRelayConnectionOptions,
): ParkedWebSocketRelayConnection {
  return new ParkedRelay(options);
}

/**
 * Open a {@link MessageConnection} to the exchange partner through the
 * WebSocket relay at `options.url` (docs/spec/WEBSOCKET_RELAY.md):
 * {@link parkWebSocketRelayConnection} with the start sent at once.
 *
 * It resolves once the relay has paired the partner and passed on the
 * partner's start. Frames are encoded and reassembled as on the WebRTC data
 * channel (core's `PeerJsFrameEncoder` and `BoundedInboundFrames`), and a
 * send hands its datagrams over a window at a time against the socket's
 * `bufferedAmount`. The caller wraps the connection in the key exchange and
 * its AEAD envelope, as on WebRTC.
 *
 * A flushing close sends the close sentinel and waits for the partner's
 * close to come back through the relay, the one delivery signal on this path;
 * how the wait ended goes to `onCloseOutcome`. The partner reading this
 * side's sentinel closes its socket, and this side does the same on reading
 * the partner's. A browser `WebSocket` cannot send a ping, so a parked
 * receive is kept alive by the relay's own pings, which the browser answers.
 *
 * @throws {ConnectionError} of kind `usage` for an address that is not a
 *         `wss` URL or has a fragment, a relay key no proof can be built
 *         from, or an address the browser refuses to open a socket to; of
 *         kind `transport` or `protocol` when the relay refuses
 *         the hello, the partner does not arrive within the budgets, or the
 *         relay sends something out of order.
 */
export function openWebSocketRelayConnection(
  options: WebSocketRelayConnectionOptions,
): Promise<MessageConnection> {
  return parkWebSocketRelayConnection(options).start();
}

function proofExpiredTwiceError(): ConnectionError {
  return new ConnectionError(
    "The WebSocket relay refused this side's proof as expired twice, the second time signed on the relay's own clock. Start the exchange again, and if the relay refuses it again, check the relay and the exchange's enrollment at it.",
    "transport",
  );
}

/** One socket of a {@link ParkedRelay}, from its dial until it closes or the
 * exchange begins on it. */
interface RelaySocket {
  readonly socket: WebSocket;
  /** `connecting` until it opens and sends its hello. */
  phase: "connecting" | "awaiting-pair" | "paired";
  startSent: boolean;
  /** The wait for the socket to open, then for the partner's start. */
  timer: ReturnType<typeof setTimeout> | undefined;
  // Replaced once forwarding starts, inside the handler that begins the
  // exchange, so no message falls between the two.
  onMessage: (event: MessageEvent) => void;
  onClose: (event: CloseEvent) => void;
  /** Clears the timer and removes every listener on the socket. */
  detach: () => void;
}

class ParkedRelay implements ParkedWebSocketRelayConnection {
  readonly url: string;
  paired = false;
  partnerStarted = false;
  failure: ConnectionError | undefined;

  private state: "dialing" | "open" | "failed" | "closed" = "dialing";
  private readonly socketUrl: string;
  private startRequested = false;
  private starting:
    | {
        promise: Promise<MessageConnection>;
        resolve: (connection: MessageConnection) => void;
        reject: (error: ConnectionError) => void;
      }
    | undefined;
  private current: RelaySocket | undefined;
  private lastSetupError: ConnectionError | undefined;
  private pairingWaitEnded = false;
  /** The relay's clock less this device's, once a 4005 has stated it. */
  private relayClockOffsetMs: number | undefined;
  private pairingTimer: ReturnType<typeof setTimeout> | undefined;
  private redialTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly onAbort = (): void => this.fail(setupCancelled());

  constructor(private readonly options: WebSocketRelayConnectionOptions) {
    this.url = options.url;
    let socketUrl = "";
    try {
      socketUrl = relaySocketUrl(options.url);
    } catch (err) {
      this.fail(asConnectionError(err, "usage"));
    }
    this.socketUrl = socketUrl;
    if (this.state !== "dialing") return;
    if (options.signal?.aborted) {
      this.fail(setupCancelled());
      return;
    }
    options.signal?.addEventListener("abort", this.onAbort, { once: true });
    this.pairingTimer = setTimeout(
      () => this.onPairingWaitEnd(),
      this.pairingTimeoutMs(),
    );
    void this.dialSocket();
  }

  readonly onChange = (listener: () => void): (() => void) => {
    if (this.state === "closed") return () => {};
    const call = (): void => listener();
    this.listeners.add(call);
    return () => this.listeners.delete(call);
  };

  readonly start = (): Promise<MessageConnection> => {
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
    else if (this.state === "closed") reject(setupCancelled());
    else {
      this.startRequested = true;
      const current = this.current;
      if (current !== undefined && current.phase !== "connecting")
        this.sendStart(current);
    }
    return promise;
  };

  readonly close = (): void => {
    if (this.state !== "dialing") return;
    this.state = "closed";
    this.listeners.clear();
    this.teardown(
      this.current?.startSent === true ? CLOSE_ABNORMAL : CLOSE_NORMAL,
    );
    this.paired = false;
    this.partnerStarted = false;
    this.starting?.reject(setupCancelled());
  };

  private pairingTimeoutMs(): number {
    return this.options.pairingTimeoutMs ?? DEFAULT_RELAY_PAIRING_TIMEOUT_MS;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private async dialSocket(): Promise<void> {
    const now = (this.options.now ?? (() => new Date()))();
    let proof: WebSocketRelayProof;
    try {
      proof = await buildRelayProof(
        this.options,
        new Date(now.getTime() + (this.relayClockOffsetMs ?? 0)),
      );
    } catch (err) {
      this.fail(asConnectionError(err, "usage"));
      return;
    }
    if (this.state !== "dialing") return;
    const hello = helloFrame(this.options.exchangeId, proof);
    let socket: WebSocket;
    try {
      socket = openRelaySocket(this.socketUrl, this.options);
    } catch (err) {
      this.fail(asConnectionError(err, "usage"));
      return;
    }
    socket.binaryType = "arraybuffer";
    const onOpen = (): void => this.onOpen(current, hello);
    // Error events carry nothing a close event does not; the close that
    // follows each one decides.
    const dispatchMessage = (event: MessageEvent): void =>
      current.onMessage(event);
    const dispatchClose = (event: CloseEvent): void => current.onClose(event);
    const current: RelaySocket = {
      socket,
      phase: "connecting",
      startSent: false,
      timer: setTimeout(
        () => this.onOpenExpired(current),
        this.options.openTimeoutMs ?? DEFAULT_RELAY_OPEN_TIMEOUT_MS,
      ),
      onMessage: (event) => this.onSetupMessage(current, event),
      onClose: (event) => this.onSetupClose(current, event),
      detach: () => {
        clearTimeout(current.timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("message", dispatchMessage);
        socket.removeEventListener("close", dispatchClose);
      },
    };
    this.current = current;
    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", dispatchMessage);
    socket.addEventListener("close", dispatchClose);
  }

  private onOpen(current: RelaySocket, hello: string): void {
    clearTimeout(current.timer);
    current.timer = undefined;
    current.phase = "awaiting-pair";
    current.socket.send(hello);
    if (this.startRequested) this.sendStart(current);
  }

  private onOpenExpired(current: RelaySocket): void {
    current.detach();
    this.current = undefined;
    current.socket.close(CLOSE_ABNORMAL);
    this.redial(couldNotConnectError());
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
          new ConnectionError(
            "The exchange partner reached the WebSocket relay but did not start the exchange. Ask your partner to start the exchange again, then start it again here.",
            "transport",
          ),
        ),
      this.options.startTimeoutMs ?? DEFAULT_RELAY_START_TIMEOUT_MS,
    );
  }

  private onSetupMessage(current: RelaySocket, event: MessageEvent): void {
    if (typeof event.data !== "string") {
      this.fail(
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
      this.fail(asConnectionError(err, "protocol"));
      return;
    }
    if (frame === "paired") {
      if (current.phase === "paired") {
        this.fail(relayProtocolError("paired this side twice"));
        return;
      }
      current.phase = "paired";
      this.paired = true;
      this.lastSetupError = undefined;
      if (current.startSent) this.armStartWait(current);
      this.notify();
      return;
    }
    if (current.phase !== "paired") {
      this.fail(
        relayProtocolError("passed on the partner's start before pairing"),
      );
      return;
    }
    if (this.partnerStarted) {
      this.fail(relayProtocolError("passed on the partner's start twice"));
      return;
    }
    this.partnerStarted = true;
    if (current.startSent) this.open(current);
    this.notify();
  }

  private onSetupClose(current: RelaySocket, event: CloseEvent): void {
    current.detach();
    this.current = undefined;
    const wasPaired = this.paired;
    this.paired = false;
    this.partnerStarted = false;
    const error = setupCloseError(
      event,
      current.phase !== "connecting",
      current.phase === "paired",
      this.options.afterCutRotation === true,
    );
    if (error instanceof ProofExpiredRefusal) {
      if (this.relayClockOffsetMs !== undefined)
        this.fail(proofExpiredTwiceError());
      else if (error.relayClock === undefined) this.fail(error);
      else {
        const now = (this.options.now ?? (() => new Date()))();
        this.relayClockOffsetMs = error.relayClock.getTime() - now.getTime();
        if (this.pairingWaitEnded) this.fail(error);
        else void this.dialSocket();
      }
      return;
    }
    if (!redialsOn(event.code)) {
      this.fail(error);
      return;
    }
    this.redial(error);
    if (wasPaired && this.state === "dialing") this.notify();
  }

  private redial(error: ConnectionError): void {
    this.lastSetupError = error;
    if (this.pairingWaitEnded) {
      this.fail(error);
      return;
    }
    this.redialTimer = setTimeout(() => {
      this.redialTimer = undefined;
      void this.dialSocket();
    }, this.options.redialIntervalMs ?? RELAY_REDIAL_INTERVAL_MS);
  }

  /** A pairing already formed outlives the wait; anything short of one ends
   * on the partner not arriving, or on the last close dialed again on. */
  private onPairingWaitEnd(): void {
    this.pairingWaitEnded = true;
    if (this.state !== "dialing" || this.paired) return;
    if (this.current?.phase !== "awaiting-pair") {
      this.fail(this.lastSetupError ?? couldNotConnectError());
      return;
    }
    const minutes = Math.max(1, Math.round(this.pairingTimeoutMs() / 60_000));
    this.fail(
      new ConnectionError(
        `The exchange partner did not reach the WebSocket relay within ${minutes} minute${minutes === 1 ? "" : "s"}. Check that your partner has started the exchange with the same relay, then start it again.`,
        "transport",
      ),
    );
  }

  private open(current: RelaySocket): void {
    this.state = "open";
    this.clearTimers();
    clearTimeout(current.timer);
    this.current = undefined;
    const forwarding = forwardingConnection(current.socket, this.options);
    current.onMessage = forwarding.onMessage;
    current.onClose = forwarding.onClose;
    this.starting?.resolve(forwarding.connection);
  }

  private fail(error: ConnectionError): void {
    if (this.state !== "dialing") return;
    this.state = "failed";
    this.failure = error;
    this.teardown(CLOSE_ABNORMAL);
    this.paired = false;
    this.partnerStarted = false;
    this.starting?.reject(error);
    this.notify();
  }

  private clearTimers(): void {
    clearTimeout(this.pairingTimer);
    clearTimeout(this.redialTimer);
    this.options.signal?.removeEventListener("abort", this.onAbort);
  }

  private teardown(code: number): void {
    this.clearTimers();
    const current = this.current;
    this.current = undefined;
    if (current === undefined) return;
    current.detach();
    if (
      current.socket.readyState === SOCKET_OPEN ||
      current.socket.readyState === SOCKET_CONNECTING
    )
      current.socket.close(code);
  }
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
