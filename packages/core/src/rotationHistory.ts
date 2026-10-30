import type { HandshakeRole } from "./types.js";
import {
  bytesEqual,
  fromBase64Url,
  hkdfDerive,
  hmacSha256,
  toBase64Url,
} from "./utils/crypto.js";

// The rotation history: a verifier per retired secret, and the proofs and
// behind notices the key exchange makes under them when no secret matches.
// Construction and labels: docs/spec/PROTOCOL.md ("The rotation history").

/**
 * The derivations of the `alcove-rotation-history-v2:` label family. Frozen
 * so the label-space test reads the set the code derives under.
 */
export const ROTATION_HISTORY_DERIVATIONS = Object.freeze([
  "verifier",
  "proof-initiator",
  "proof-responder",
  "notice-initiator",
  "notice-responder",
] as const);

type RotationHistoryDerivation = (typeof ROTATION_HISTORY_DERIVATIONS)[number];

/** The most verifiers a handshake checks: the newest ones. */
export const ROTATION_HISTORY_MAX_ENTRIES = 64;

/** The byte length of a history verifier. */
export const HISTORY_VERIFIER_BYTES = 32;

/** The largest count a behind notice may state: a 32-bit unsigned integer. */
export const BEHIND_NOTICE_MAX_COUNT = 0xffff_ffff;

/** One retired secret's entry in the rotation history. */
export interface RotationHistoryEntry {
  /** The verifier of the retired secret, base64url, 32 bytes. */
  verifier: string;
  /** The retired secret's own `expires`, after which the entry is dropped. */
  expires?: string;
}

function historyLabel(derivation: RotationHistoryDerivation): string {
  return `alcove-rotation-history-v2:${derivation}`;
}

/**
 * The history verifier of a 32-byte secret:
 * `HKDF(secret, "alcove-rotation-history-v2:verifier", 32)`.
 */
export async function historyVerifierBytes(
  secret: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return hkdfDerive(secret, historyLabel("verifier"), HISTORY_VERIFIER_BYTES);
}

/** The history verifier of a base64url shared secret, base64url. */
export async function deriveHistoryVerifier(
  sharedSecret: string,
): Promise<string> {
  return toBase64Url(await historyVerifierBytes(fromBase64Url(sharedSecret)));
}

/** The two ephemeral shares of one handshake, as sent, and its `dh`. */
export interface HandshakeShares {
  initiatorShare: Uint8Array<ArrayBuffer>;
  responderShare: Uint8Array<ArrayBuffer>;
  dh: Uint8Array<ArrayBuffer>;
}

function concat(
  ...parts: Array<Uint8Array<ArrayBuffer>>
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function historyMac(
  verifier: Uint8Array<ArrayBuffer>,
  derivation: RotationHistoryDerivation,
  shares: HandshakeShares,
  prefix: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await hkdfDerive(
    concat(verifier, shares.dh),
    historyLabel(derivation),
    32,
  );
  return hmacSha256(
    key,
    concat(prefix, shares.initiatorShare, shares.responderShare),
  );
}

/**
 * The history proof `sender` makes under the verifier of its own current
 * secret: `HMAC(HKDF(verifier || dh, proof label), e_I || e_R)`.
 */
export async function historyProof(
  verifier: Uint8Array<ArrayBuffer>,
  sender: HandshakeRole,
  shares: HandshakeShares,
): Promise<Uint8Array<ArrayBuffer>> {
  return historyMac(
    verifier,
    sender === "initiator" ? "proof-initiator" : "proof-responder",
    shares,
    new Uint8Array(0),
  );
}

function countBytes(count: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, count);
  return out;
}

/**
 * The behind notice `sender` makes under the verifier of the peer's secret,
 * stating `count`: `HMAC(HKDF(verifier || dh, notice label), u32(count) ||
 * e_I || e_R)`.
 */
export async function behindNotice(
  verifier: Uint8Array<ArrayBuffer>,
  sender: HandshakeRole,
  count: number,
  shares: HandshakeShares,
): Promise<Uint8Array<ArrayBuffer>> {
  return historyMac(
    verifier,
    sender === "initiator" ? "notice-initiator" : "notice-responder",
    shares,
    countBytes(count),
  );
}

/**
 * A history as the handshake checks it: newest first, with `undefined` in the
 * place of an entry that is not checked, so each later position still counts
 * rotations.
 */
export type CheckedHistory = ReadonlyArray<Uint8Array<ArrayBuffer> | undefined>;

/**
 * The position, counted from 1 at the newest, of the first verifier in
 * `history` under which `proof` is `sender`'s proof, or `undefined`. Every
 * entry is checked whatever matches, so the work is the history's length.
 */
export async function matchHistoryProof(
  history: CheckedHistory,
  proof: Uint8Array<ArrayBuffer>,
  sender: HandshakeRole,
  shares: HandshakeShares,
): Promise<number | undefined> {
  let position: number | undefined;
  for (const [index, verifier] of history.entries()) {
    if (verifier === undefined) continue;
    const matches = bytesEqual(
      proof,
      await historyProof(verifier, sender, shares),
    );
    if (matches && position === undefined) position = index + 1;
  }
  return position;
}
