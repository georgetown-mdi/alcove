import { isWebSocketRelayRefusal } from "@alcove/core";

import {
  askSignalingCertificate,
  probeSignalingCertificate,
} from "../connection/webrtc/signalingTls";
import type {
  SignalingCertificateProbe,
  TlsEndpoint,
} from "../connection/webrtc/signalingTls";
import {
  parkWebSocketRelay,
  RELAY_CLOSE,
  UnexpectedRelayMessageError,
} from "../connection/webrtc/websocketRelayConnection";
import type {
  ParkedWebSocketRelay,
  WebSocketRelayDial,
} from "../connection/webrtc/websocketRelayConnection";

// Whether a WebSocket relay a run dials admits the run's proof, asked through
// the run's own relay transport (parkWebSocketRelay): the same derivation, the
// same hello, the same correction of an expired proof on the relay's clock.
// The relay answers an admitted hello with nothing until a partner arrives, so
// the check parks two sockets in this side's role: the relay checks the role
// only once a proof has verified, so the second hello it admits is refused as
// role taken (4006), and that refusal is the admission. Contract:
// docs/spec/CLI_DOCTOR.md, The relay check.

/** What the check found at one WebSocket relay. */
export type WebSocketRelayAnswer =
  | { outcome: "admitted" }
  | {
      outcome: "not_admitted";
      closeCode: number;
      /**
       * Present on a 4005 refusing a proof made again on the relay's clock,
       * after a first 4005 stated that clock.
       */
      proofRemadeOnRelayClock?: true;
    }
  | { outcome: "unexpected_message" }
  | {
      outcome: "not_reached";
      /** The run has environment proxying on, so no certificate was checked. */
      certificateNotChecked: boolean;
    }
  | { outcome: "certificate_not_verified" };

/**
 * Ask one WebSocket relay whether it admits the proof `dial` makes, until
 * `signal` aborts, which reports it not reached.
 */
export type WebSocketRelayAsking = (
  dial: WebSocketRelayDial,
  signal: AbortSignal,
) => Promise<WebSocketRelayAnswer>;

/** What a test can vary about {@link askWebSocketRelay}. */
export interface WebSocketRelayAskOptions {
  /** Tests only. */
  socketFactory?: (url: string) => WebSocket;
  /** Tests only. */
  certificateProbe?: SignalingCertificateProbe;
}

/** Two sockets in one role: the relay refuses the second it admits as role taken. */
const ADMISSION_SOCKETS = 2;

function tlsEndpointOf(url: string): TlsEndpoint | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const secure = parsed.protocol === "wss:";
  const port =
    parsed.port === "" ? (secure ? 443 : 80) : Number.parseInt(parsed.port);
  return { host: parsed.hostname, port, secure };
}

/**
 * The answer for a socket that closed before it opened: what the certificate
 * check says about the relay's endpoint, as a failed signaling socket is told.
 */
async function unopenedAnswer(
  url: string,
  probe: SignalingCertificateProbe,
  signal: AbortSignal,
): Promise<WebSocketRelayAnswer> {
  const endpoint = tlsEndpointOf(url);
  if (endpoint === undefined)
    return { outcome: "not_reached", certificateNotChecked: false };
  let certificate: Awaited<ReturnType<typeof askSignalingCertificate>>;
  try {
    certificate = await askSignalingCertificate(endpoint, probe, signal);
  } catch {
    certificate = undefined;
  }
  if (certificate?.kind === "verification-failed")
    return { outcome: "certificate_not_verified" };
  return {
    outcome: "not_reached",
    certificateNotChecked: certificate?.kind === "not-checked-proxied",
  };
}

/**
 * Ask the relay `dial` names whether it admits the proof a run presents: park
 * {@link ADMISSION_SOCKETS} sockets in the run's role and read the first
 * answer. A pairing, or a refusal as role taken, is an admission; a refusal of
 * the hello before that is not; a message the run's relay client does not
 * take at that point is its own answer; a socket that closes any other way, or
 * no answer before `signal` aborts, is not reached, asking the certificate
 * check first where the socket never opened. Every socket is closed before
 * this resolves.
 *
 * @throws {ConnectionError} where the run's relay client ends with a failure
 *   of its own, such as a socket it could not dial at all.
 */
export function askWebSocketRelay(
  dial: WebSocketRelayDial,
  signal: AbortSignal,
  options: WebSocketRelayAskOptions = {},
): Promise<WebSocketRelayAnswer> {
  return new Promise((resolve, reject) => {
    const parked: ParkedWebSocketRelay[] = [];
    const removeListeners: Array<() => void> = [];
    const lastClose = new Map<number, number>();
    const expiredOnce = new Set<number>();
    let concluded = false;

    function conclude(): boolean {
      if (concluded) return false;
      concluded = true;
      signal.removeEventListener("abort", onAbort);
      for (const remove of removeListeners) remove();
      for (const relay of parked) relay.close();
      return true;
    }
    function answer(value: WebSocketRelayAnswer): void {
      if (conclude()) resolve(value);
    }
    function onAbort(): void {
      answer({ outcome: "not_reached", certificateNotChecked: false });
    }
    function onSocketClose(index: number, code: number, opened: boolean) {
      if (concluded) return;
      lastClose.set(index, code);
      if (code === RELAY_CLOSE.roleTaken)
        return answer({ outcome: "admitted" });
      // The transport makes the proof again at once on the relay's clock.
      if (code === RELAY_CLOSE.proofExpired && !expiredOnce.has(index)) {
        expiredOnce.add(index);
        return;
      }
      if (isWebSocketRelayRefusal(code))
        return answer({
          outcome: "not_admitted",
          closeCode: code,
          ...(code === RELAY_CLOSE.proofExpired && {
            proofRemadeOnRelayClock: true,
          }),
        });
      if (opened)
        return answer({ outcome: "not_reached", certificateNotChecked: false });
      if (conclude())
        void unopenedAnswer(
          dial.url,
          options.certificateProbe ?? probeSignalingCertificate,
          signal,
        ).then(resolve);
    }

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    const openSocket =
      options.socketFactory ?? ((url: string) => new WebSocket(url));
    for (let index = 0; index < ADMISSION_SOCKETS; index += 1) {
      const relay = parkWebSocketRelay(dial, {
        socketFactory: (url) => {
          const socket = openSocket(url);
          let opened = false;
          socket.addEventListener("open", () => {
            opened = true;
          });
          socket.addEventListener("close", (event: CloseEvent) =>
            onSocketClose(index, event.code, opened),
          );
          return socket;
        },
      });
      parked.push(relay);
      removeListeners.push(
        relay.onChange(() => {
          if (relay.paired) return answer({ outcome: "admitted" });
          const failure = relay.failure;
          if (failure === undefined) return;
          if (failure instanceof UnexpectedRelayMessageError)
            return answer({ outcome: "unexpected_message" });
          const code = lastClose.get(index);
          if (code !== undefined && isWebSocketRelayRefusal(code))
            return answer({ outcome: "not_admitted", closeCode: code });
          if (conclude()) reject(failure);
        }),
      );
    }
  });
}
