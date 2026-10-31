import {
  parseBoundedJson,
  parseWebSocketRelayProof,
  RENDEZVOUS_ROLES,
} from "@alcove/core/websocket-relay";

import { QUEUED_MESSAGE_OVERHEAD_BYTES } from "./forwarding.ts";

import type {
  RendezvousRole,
  WebSocketRelayProof,
} from "@alcove/core/websocket-relay";

// The relay's wire: the request path, the frames a party and the relay send
// each other, the close codes, and the bounds, each stated in
// docs/spec/WEBSOCKET_RELAY.md.

/** The request path a party opens its relay socket on. */
export const RELAY_PATH = "/relay";

/**
 * The largest message the relay takes from a party, in bytes: the
 * 16,300-byte chunk the framing splits a frame at, plus the 58 bytes its
 * widest chunk envelope adds, rounded up to 16 KiB.
 */
export const RELAY_MAX_MESSAGE_BYTES = 16_384;

/** A destination's send buffer, in bytes, above which the relay stops reading
 * from the source. */
export const RELAY_SEND_BUFFER_HIGH_BYTES = 1024 * 1024;

/** A destination's send buffer, in bytes, at or below which the relay reads
 * from the source again. */
export const RELAY_SEND_BUFFER_LOW_BYTES = 256 * 1024;

/** The smallest frame the relay parses from a party: a masked client frame
 * with no payload, two header bytes and a four-byte mask. */
const MIN_FRAME_BYTES = 6;

/** Node's read size and a TCP socket's read high-water mark, in bytes. */
const READ_BYTES = 64 * 1024;

/**
 * The most memory, in bytes, the relay holds for one party's queue and its
 * source. The larger case is a held source that then closes: the relay
 * forwards the queue from the read that crossed the high mark and the
 * read-ahead the paused source held, a 64 KiB read and a 64 KiB high-water
 * buffer. So the queue holds three reads of frames, each frame at least
 * {@link MIN_FRAME_BYTES} and counted with its payload, its frame header and
 * {@link QUEUED_MESSAGE_OVERHEAD_BYTES}, over the high mark and one whole
 * message; the read-ahead is held as one buffer while it is read.
 */
export const RELAY_QUEUED_BOUND_BYTES =
  RELAY_SEND_BUFFER_HIGH_BYTES +
  RELAY_MAX_MESSAGE_BYTES +
  3 * READ_BYTES +
  (Math.floor((3 * READ_BYTES) / MIN_FRAME_BYTES) + 1) *
    QUEUED_MESSAGE_OVERHEAD_BYTES +
  2 * READ_BYTES;

/** How long (ms) a socket may stay open before its hello arrives. */
export const RELAY_HELLO_TIMEOUT_MS = 10_000;

/**
 * The most pairings the relay holds at once, a pairing counting from its
 * first verified hello until every socket it admitted has closed, the close
 * wait included: coturn's 40 concurrent allocations at two an
 * exchange (docs/notes/webrtc-relay-deployment.md, Quotas against one
 * exchange).
 */
export const RELAY_MAX_PAIRINGS = 20;

/**
 * The most sockets the relay holds whose hello has not verified, each counted
 * from its upgrade until its hello verifies or its socket closes; an upgrade
 * above it is refused with 503. Four times {@link RELAY_MAX_PAIRINGS}: two
 * hellos a pairing, twice over.
 */
export const RELAY_MAX_UNVERIFIED_SOCKETS = 4 * RELAY_MAX_PAIRINGS;

/**
 * The window (ms) in which the relay reports a fault a hello met at most once:
 * the signaling broker's diagnostics window (`DIAGNOSTIC_RATE_LIMIT_WINDOW_MS`).
 */
export const RELAY_FAULT_REPORT_WINDOW_MS = 60_000;

/** How often (ms) the relay pings each socket it holds. */
export const RELAY_PING_INTERVAL_MS = 30_000;

/** How long (ms) a close the relay forwards may wait behind the messages
 * queued ahead of it before the socket is dropped. */
export const RELAY_CLOSE_WAIT_MS = 300_000;

/** How long (ms) a socket the relay refuses has to answer the close before it
 * is dropped. */
export const RELAY_REFUSAL_CLOSE_WAIT_MS = 10_000;

/** The bytes a second the relay forwards from each party of a pairing:
 * coturn's `max-bps`. */
export const RELAY_PAIRING_BYTES_PER_SECOND = 2_000_000;

/** The bytes a party may send at once after a pause in its sending: one
 * second at {@link RELAY_PAIRING_BYTES_PER_SECOND}. */
export const RELAY_PAIRING_BURST_BYTES = 2_000_000;

/**
 * How long (ms) a pairing may pass no message either way before the relay
 * closes it: the one-hour parked-receive budget plus the five-minute close
 * drain budget, so a party's own budget expires first.
 */
export const RELAY_IDLE_TIMEOUT_MS = 3_900_000;

/** The close codes the relay sends. */
export const RelayCloseCode = Object.freeze({
  /** The partner closed normally. */
  normal: 1000,
  /** The relay is shutting down. */
  goingAway: 1001,
  /** A message above {@link RELAY_MAX_MESSAGE_BYTES}. */
  messageTooBig: 1009,
  /**
   * The relay could not check the hello: its key table could not be read, the
   * key enrolled under the exchange id is not 64 lowercase hex characters, or
   * the check failed in some other way.
   */
  internalError: 1011,
  /** The partner's socket ended without a normal close. */
  partnerEnded: 4000,
  /** The first message was not a well-formed hello. */
  helloMalformed: 4001,
  /** A message the relay does not take at that point. */
  unexpectedMessage: 4002,
  /** No relay key is enrolled under the hello's exchange id. */
  notEnrolled: 4003,
  /** The proof does not verify under the exchange's relay key. */
  proofRefused: 4004,
  /** The proof's expiry has passed; the reason is the relay's Unix second. */
  proofExpired: 4005,
  /** Another socket holds the role under the exchange's relay key. */
  roleTaken: 4006,
  /** No hello arrived within {@link RELAY_HELLO_TIMEOUT_MS}. */
  helloTimeout: 4007,
  /** The relay holds {@link RELAY_MAX_PAIRINGS} pairings already. */
  relayFull: 4008,
  /** No message crossed the pairing within {@link RELAY_IDLE_TIMEOUT_MS}. */
  idle: 4009,
});

/** The text frame the relay sends both parties once both hellos verified. */
export const PAIRED_FRAME = '{"type":"paired"}';

/** The text frame a party sends to start forwarding, and the relay sends a
 * party when its partner has sent it. */
export const START_FRAME = '{"type":"start"}';

/** A party's hello, read but not yet checked. */
export interface RelayHello {
  /** The id the exchange's relay key is enrolled under. */
  exchangeId: string;
  /** The role the party claims. */
  role: RendezvousRole;
  /** The proof the hello presents, parsed but not checked. */
  proof: WebSocketRelayProof;
}

/** A text frame a party sends. */
export type RelayClientFrame =
  { type: "hello"; hello: RelayHello } | { type: "start" };

/** A text frame that is not one a party may send. */
export class RelayFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayFrameError";
  }
}

// The registrar's exchange id alphabet (infra/relay/README.md, Per-exchange
// keys).
const EXCHANGE_ID_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,127}$/;
const TAG_PATTERN = /^[0-9a-f]{64}$/;
const HELLO_KEYS = ["type", "exchangeId", "role", "proof", "tag"];

const encoder = new TextEncoder();

function isRole(value: unknown): value is RendezvousRole {
  return (RENDEZVOUS_ROLES as ReadonlyArray<unknown>).includes(value);
}

function hasExactKeys(value: object, keys: ReadonlyArray<string>): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Read a text frame a party sent: a hello or a start. The frame is parsed
 * through core's bounded JSON parse and held to exactly the keys its type
 * names.
 *
 * @throws {RelayFrameError} for anything else, including a hello whose proof
 *   does not parse.
 */
export function readClientFrame(text: string): RelayClientFrame {
  let value: unknown;
  try {
    value = parseBoundedJson(text);
  } catch {
    throw new RelayFrameError("the frame is not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RelayFrameError("the frame is not a JSON object");
  }
  const frame = value as Record<string, unknown>;
  if (frame.type === "start" && hasExactKeys(frame, ["type"])) {
    return { type: "start" };
  }
  if (frame.type !== "hello" || !hasExactKeys(frame, HELLO_KEYS)) {
    throw new RelayFrameError("the frame is neither a hello nor a start");
  }
  const { exchangeId, role, proof, tag } = frame;
  if (typeof exchangeId !== "string" || !EXCHANGE_ID_PATTERN.test(exchangeId)) {
    throw new RelayFrameError("the hello's exchange id is not a valid id");
  }
  if (!isRole(role)) {
    throw new RelayFrameError("the hello's role is not a rendezvous role");
  }
  if (typeof proof !== "string") {
    throw new RelayFrameError("the hello's proof is not a string");
  }
  if (typeof tag !== "string" || !TAG_PATTERN.test(tag)) {
    throw new RelayFrameError("the hello's tag is not 64 lowercase hex");
  }
  try {
    return {
      type: "hello",
      hello: {
        exchangeId,
        role,
        proof: parseWebSocketRelayProof(encoder.encode(proof), hexBytes(tag)),
      },
    };
  } catch {
    throw new RelayFrameError("the hello's proof is malformed");
  }
}
