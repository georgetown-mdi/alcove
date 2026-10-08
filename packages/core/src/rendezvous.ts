import { hkdfDerive, fromBase64Url, toHex } from "./utils/crypto.js";
import { SHARED_SECRET_REGEX } from "./config/connection.js";
import { InternalConsistencyError } from "./errors.js";
import type { HandshakeRole } from "./types.js";

/**
 * The two roles in a WebRTC rendezvous, each the suffix of one derived peer id
 * ({@link deriveRendezvousPeerId}). Frozen so a plain-JS caller cannot widen the
 * set that function's runtime guard checks.
 */
export const RENDEZVOUS_ROLES = Object.freeze(["inviter", "acceptor"] as const);

/** A rendezvous role; one of the fixed {@link RENDEZVOUS_ROLES}. */
export type RendezvousRole = (typeof RENDEZVOUS_ROLES)[number];

/**
 * The handshake role a rendezvous side takes: the acceptor dials and sends
 * first (initiator), the inviter listens (responder). Every party, CLI or
 * browser, resolves its role through this one rule; the conformance vectors
 * pin it (docs/spec/PROTOCOL.md#webrtc-rendezvous-peer-id-derivation).
 *
 * @throws {InternalConsistencyError} if `role` is not a known rendezvous role.
 */
export function handshakeRoleForRendezvousRole(
  role: RendezvousRole,
): HandshakeRole {
  if (role === "acceptor") return "initiator";
  if (role === "inviter") return "responder";
  throw new InternalConsistencyError(
    `handshakeRoleForRendezvousRole: unknown role ${JSON.stringify(role)}; ` +
      `expected one of ${RENDEZVOUS_ROLES.map((r) => JSON.stringify(r)).join(", ")}`,
  );
}

/** Derived peer id length in bytes before hex encoding: UUID-scale entropy. */
const PEER_ID_BYTES = 16;

/**
 * HKDF info prefix for the peer-id derivation, completed by the role. The whole
 * construction is a cross-implementation contract between the CLI and the web
 * app: change it in every implementation at once and bump the version
 * (docs/spec/PROTOCOL.md#webrtc-rendezvous-peer-id-derivation).
 */
const PEER_ID_INFO_PREFIX = "alcove-webrtc-peerid-v2:";

/**
 * Derive the PeerJS peer id for one rendezvous `role` from the invitation's
 * shared secret. The inviter listens on the `"inviter"` id; the acceptor dials
 * it and registers under the `"acceptor"` id. Lowercase hex because the PeerJS
 * client refuses some ids a base64url string can produce.
 *
 * @param sharedSecret  The invitation's base64url-encoded 32-byte shared secret,
 *                      matching {@link SHARED_SECRET_REGEX}.
 * @param role          The rendezvous role; one of {@link RENDEZVOUS_ROLES}.
 * @throws {Error} if `sharedSecret` is not a base64url-encoded 32-byte value, or
 *                 if `role` is not a known rendezvous role.
 */
export async function deriveRendezvousPeerId(
  sharedSecret: string,
  role: RendezvousRole,
): Promise<string> {
  if (!SHARED_SECRET_REGEX.test(sharedSecret)) {
    throw new InternalConsistencyError(
      "deriveRendezvousPeerId: sharedSecret must be a base64url-encoded " +
        "32-byte value matching SHARED_SECRET_REGEX",
    );
  }
  // For an untyped caller: an unknown role derives an id the peer never dials.
  if (!(RENDEZVOUS_ROLES as readonly string[]).includes(role)) {
    throw new InternalConsistencyError(
      `deriveRendezvousPeerId: unknown role ${JSON.stringify(role)}; ` +
        `expected one of ${RENDEZVOUS_ROLES.map((r) => JSON.stringify(r)).join(", ")}`,
    );
  }
  const ikm = fromBase64Url(sharedSecret);
  const bytes = await hkdfDerive(
    ikm,
    `${PEER_ID_INFO_PREFIX}${role}`,
    PEER_ID_BYTES,
  );
  return toHex(bytes);
}

/**
 * URL delimiters refused anywhere in a signaling `host`; none appears in a
 * hostname or an IP literal.
 */
const HOST_AUTHORITY_DELIMITERS = /[@/?#\\]|\s/;

/**
 * {@link HOST_AUTHORITY_DELIMITERS} less `/`, refused anywhere in a signaling
 * `path`. A leading `/` is required separately.
 */
const PATH_AUTHORITY_DELIMITERS = /[@?#\\]|\s/;

/** The half of a signaling location a refusal names. */
export type SignalingLocationField = "host" | "path";

/**
 * Which field of a partner-supplied signaling location could move the address
 * a rendezvous dials, or `undefined` when neither does; `host` is reported
 * first. The rule is the union of what moves the CLI's URL-API assembly and the
 * browser's string concatenation (docs/spec/WEBRTC_TRANSPORT.md#broker-socket).
 */
export function authorityMovingSignalingField(location: {
  host: string;
  path: string;
}): SignalingLocationField | undefined {
  if (HOST_AUTHORITY_DELIMITERS.test(location.host)) return "host";
  if (
    !location.path.startsWith("/") ||
    PATH_AUTHORITY_DELIMITERS.test(location.path)
  )
    return "path";
  return undefined;
}
