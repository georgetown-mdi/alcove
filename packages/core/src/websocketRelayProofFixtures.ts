// The labelled WebSocket relay proofs every reader of a presented proof is held
// to, and the refusal each must draw.
//
// Core's parse and check (./websocketRelayProof.ts) decide a proof; the relay
// (packages/websocket-relay) reads one off a party's hello and answers each
// refusal with a close code of its own. Both suites drive this one set, so a
// case the relay admits that core refuses, or answers under the wrong code,
// fails there. Test-only, published on `@alcove/core/testing` for the relay's
// suite.
//
// Each fixture holds only what a hello can: the message as text, the tag as
// bytes, and the role the party claims. The set is built at a caller's `now`,
// so a relay checking on its own clock draws the same refusals as a fixed one.

import {
  deriveRelayRegistrarProofKey,
  relayKeyBytes,
} from "./relayRegistrarProof.js";
import { hmacSha256 } from "./utils/crypto.js";
import {
  WEBSOCKET_RELAY_PROOF_MAX_TTL_SECONDS,
  buildWebSocketRelayProof,
} from "./websocketRelayProof.js";

import type { RendezvousRole } from "./rendezvousRoles.js";
import type { WebSocketRelayProofRefusal } from "./websocketRelayProof.js";

/** One presented proof and the refusal it must draw. */
export interface WebSocketRelayProofFixture {
  readonly label: string;
  /** The signed message as a hello's `proof` field holds it. */
  readonly message: string;
  readonly tag: Uint8Array<ArrayBuffer>;
  /** The role the presenting party claims. */
  readonly role: RendezvousRole;
  readonly refusedBy: WebSocketRelayProofRefusal;
}

/** What {@link webSocketRelayProofRefusalFixtures} builds the set from. */
export interface WebSocketRelayProofFixtureOptions {
  /** The relay key the reader holds for the exchange, as 64 lowercase hex characters. */
  relayKey: string;
  /** The reader's time, or a time just before it. */
  now: Date;
}

const decoder = new TextDecoder();

// Another member of the domain-separation label space (docs/spec/PROTOCOL.md),
// in place of the relay proof's own label.
const REGISTRAR_REQUEST_LABEL = "alcove-relay-registrar-v2:request";

/**
 * The refused proofs under `relayKey` at `now`: every malformed message and tag
 * a hello can hold, a proof for the other role, a proof at and past its expiry,
 * and tags the proof key does not make.
 *
 * @throws {Error} if `relayKey` is not 64 lowercase hex characters.
 */
export async function webSocketRelayProofRefusalFixtures({
  relayKey,
  now,
}: WebSocketRelayProofFixtureOptions): Promise<WebSocketRelayProofFixture[]> {
  const build = (role: RendezvousRole, at: Date) =>
    buildWebSocketRelayProof({
      relayKey,
      role,
      ttlSeconds: WEBSOCKET_RELAY_PROOF_MAX_TTL_SECONDS,
      now: at,
    });
  const inviter = await build("inviter", now);
  const acceptor = await build("acceptor", now);
  const inviterMessage = decoder.decode(inviter.message);
  const [label, , expiry] = inviterMessage.split("\n");
  const tag = inviter.tag;
  const ttlMs = WEBSOCKET_RELAY_PROOF_MAX_TTL_SECONDS * 1000;
  const atExpiry = await build("inviter", new Date(now.getTime() - ttlMs));
  const pastExpiry = await build(
    "inviter",
    new Date(now.getTime() - ttlMs - 1000),
  );
  const flipped = (index: number): Uint8Array<ArrayBuffer> => {
    const bytes = new Uint8Array(tag);
    bytes[index] ^= 0x01;
    return bytes;
  };

  const malformed = (
    what: string,
    message: string,
    presentedTag = tag,
  ): WebSocketRelayProofFixture => ({
    label: what,
    message,
    tag: presentedTag,
    role: "inviter",
    refusedBy: "malformed",
  });
  const tagMismatch = (
    what: string,
    message: string,
    presentedTag: Uint8Array<ArrayBuffer>,
    role: RendezvousRole = "inviter",
  ): WebSocketRelayProofFixture => ({
    label: what,
    message,
    tag: presentedTag,
    role,
    refusedBy: "tag-mismatch",
  });

  return [
    malformed("a 31-byte tag", inviterMessage, tag.slice(1)),
    malformed("a 33-byte tag", inviterMessage, new Uint8Array([...tag, 0])),
    malformed(
      "the registrar request's label",
      `${REGISTRAR_REQUEST_LABEL}\ninviter\n${expiry}`,
    ),
    malformed(
      "a role that is not a rendezvous role",
      `${label}\nrelay\n${expiry}`,
    ),
    malformed("an uppercase role", `${label}\nINVITER\n${expiry}`),
    malformed("a leading zero", `${label}\ninviter\n0${expiry}`),
    malformed("a negative expiry", `${label}\ninviter\n-${expiry}`),
    malformed("a trailing LF", `${inviterMessage}\n`),
    malformed("a CR LF separator", `${label}\r\ninviter\r\n${expiry}`),
    malformed("a leading BOM", `\uFEFF${inviterMessage}`),
    malformed("a fourth field", `${inviterMessage}\n1`),
    malformed("a missing expiry", `${label}\ninviter`),
    malformed(
      "an expiry past the safe integers",
      `${label}\ninviter\n${"9".repeat(17)}`,
    ),
    malformed(
      "a message over the bound",
      `${label}\ninviter\n${"1".repeat(200)}`,
    ),
    malformed("an empty message", ""),
    {
      label: "a proof made for the other role",
      message: inviterMessage,
      tag,
      role: "acceptor",
      refusedBy: "role-mismatch",
    },
    {
      label: "a proof at its expiry",
      message: decoder.decode(atExpiry.message),
      tag: atExpiry.tag,
      role: "inviter",
      refusedBy: "expired",
    },
    {
      label: "a proof past its expiry",
      message: decoder.decode(pastExpiry.message),
      tag: pastExpiry.tag,
      role: "inviter",
      refusedBy: "expired",
    },
    tagMismatch(
      "one role's tag under the other role's message",
      decoder.decode(acceptor.message),
      tag,
      "acceptor",
    ),
    ...[0, 15, 31].map((index) =>
      tagMismatch(
        `a tag with byte ${index} flipped`,
        inviterMessage,
        flipped(index),
      ),
    ),
    tagMismatch(
      "a later expiry under the original tag",
      `${label}\ninviter\n${Number(expiry) + 1}`,
      tag,
    ),
    tagMismatch(
      "a tag under the relay key itself",
      inviterMessage,
      await hmacSha256(
        relayKeyBytes("webSocketRelayProofRefusalFixtures", relayKey),
        inviter.message,
      ),
    ),
    tagMismatch(
      "a tag under the registrar proof key",
      inviterMessage,
      await hmacSha256(
        await deriveRelayRegistrarProofKey(relayKey),
        inviter.message,
      ),
    ),
  ];
}
