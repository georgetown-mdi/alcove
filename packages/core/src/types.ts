import { z } from "zod";

/**
 * Paired arrays of matched row indices produced by PSI linkage: `[0]` contains
 * our row indices and `[1]` the partner's, so entry `i` is one matched pair.
 * `[0]` is strictly ascending, except on the "one" side of a deduplicating
 * exchange, where it is non-decreasing (the mirror case repeats `[1]`).
 * `assertMatchedPairsWellFormed` (exchange.ts) and, for a table received from
 * the partner, {@link assertPartnerIndexTable} check this. See
 * docs/spec/PROTOCOL.md#partner-supplied-index-tables-are-checked-against-local-state.
 */
export type AssociationTable = [Array<number>, Array<number>];

/**
 * Listener signature per Connection event. `error` is an asynchronous
 * transport failure; synchronous failures (send, synchronize) throw.
 */
type ConnectionEventHandler<E extends "data" | "error"> = E extends "data"
  ? (data: unknown) => void
  : (err: unknown) => void;

export type Connection = {
  on: <E extends "data" | "error">(
    event: E,
    fn: ConnectionEventHandler<E>,
    context?: undefined,
  ) => Connection;
  once: <E extends "data" | "error">(
    event: E,
    fn: ConnectionEventHandler<E>,
    context?: undefined,
  ) => Connection;
  removeListener: <E extends "data" | "error">(
    event: E,
    fn?: ConnectionEventHandler<E>,
    context?: undefined,
    once?: boolean,
  ) => Connection;
  // Resolving means only that the transport accepted the message locally, not
  // that the peer received it. The final frame survives teardown through the
  // `close` contract below. See
  // docs/COMMUNICATION.md#message-delivery-and-teardown.
  send: (data: unknown, chunked?: boolean) => void | Promise<void>;
  // Callers that need to wait for teardown MUST await the result. A clean
  // close guarantees the last frame `send` accepted reaches the peer, either
  // by a durable send plus a close that drains until the peer consumes it
  // (file-sync) or by a close that delivers buffered frames (WebRTC). An error
  // close never flushes.
  close: () => void | Promise<void>;
  // Returns and clears the most recent `error` emitted while no listener was
  // registered. There is no equivalent for `data`: a `data` event with no
  // listener is dropped, so each receive helper registers its `once("data")`
  // listener synchronously inside its Promise executor, before any await.
  takeBufferedError: () => unknown;
  // Bounds subsequent inbound frame reads to `maxBytes` in place of the
  // static cap; `undefined` restores it. Omitted by a transport bounded another
  // way (WebRTC). See
  // docs/spec/CHANNEL_SECURITY.md#single-pass-per-exchange-cap.
  setInboundFrameCap?: (maxBytes: number | undefined) => void;
  // The inbound poll interval, which a request/response wait adds to its
  // bound. Omitted by a transport that pushes frames (WebRTC).
  inboundPollIntervalMs?: () => number;
  // The partner's read-gate bound on a message file, which a PSI round checks
  // an outgoing set's file against. Omitted by a transport with no such bound.
  outboundFileSyncFrameBound?: () => number;
};

type Role = "starter" | "joiner" | "either";
export type HandshakeRole = "initiator" | "responder";

export interface Config {
  role: Role;
  verbose?: number;
}

export const AlgorithmSchema = z.enum(["psi", "psi-c"]);
export type Algorithm = z.infer<typeof AlgorithmSchema>;

export type PsiRole = "sender" | "receiver";

export const SEMANTIC_TYPES = [
  "ssn",
  "ssn4",
  "first_name",
  "last_name",
  "date_of_birth",
  "identifier",
  "phone_number",
  "email_address",
  "zip_code",
  "other",
] as const;

export type SemanticType = (typeof SEMANTIC_TYPES)[number];

export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};
