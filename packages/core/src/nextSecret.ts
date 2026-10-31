import { enc, hkdfDerive, toBase64Url } from "./utils/crypto.js";

// The next shared secret, independent of the current one: each party draws a
// 32-byte value, sends it AES-KW-wrapped under a key derived from the session
// key (the initiator's in key-exchange message 3, the responder's in terms
// message 2), and both derive the next secret over the key-agreement output and
// the two values. Construction and labels: docs/spec/PROTOCOL.md
// ("Shared-secret rotation").

const INITIATOR_WRAP_LABEL = "alcove-shared-secret-wrap-v2";
const RESPONDER_WRAP_LABEL = "alcove-shared-secret-wrap-responder-v2";
const NEXT_SECRET_LABEL = "alcove-shared-secret-next-v2";

/** The byte length of each party's rotation value. */
export const ROTATION_VALUE_BYTES = 32;

/** The byte length of a wrapped rotation value: AES-KW adds 8 bytes. */
export const WRAPPED_ROTATION_VALUE_BYTES = 40;

/** The party that drew a rotation value, which names its wrapping key. */
export type RotationValueSender = "initiator" | "responder";

// A value is held as an extractable HMAC key because `wrapKey` takes a
// CryptoKey and `generateKey` is a `crypto.subtle` call; the bytes are exported
// for the next-secret derivation.
const VALUE_KEY_ALGORITHM = {
  name: "HMAC",
  hash: "SHA-256",
  length: ROTATION_VALUE_BYTES * 8,
} as const;

/** One party's rotation value, as the key that wraps it and as its bytes. */
export interface RotationValue {
  key: CryptoKey;
  bytes: Uint8Array<ArrayBuffer>;
}

/**
 * What the key exchange hands the terms exchange: the protocol version its
 * hellos selected, which both terms frames state and check, and for the
 * rotation the session key the wraps derive from, the key-agreement output,
 * the initiator's value, and the current secret's `expires`, checked at each
 * side's last point before its store. Holds key material: kept in memory and
 * never logged.
 */
export interface NextSecretInputs {
  /** `AuthResult.negotiated.protocol` (docs/spec/PROTOCOL.md, "The version
   * hello"). */
  readonly negotiatedProtocolVersion: number;
  readonly sessionKey: Uint8Array<ArrayBuffer>;
  /** The rotation input the key agreement produced: for the P-256 handshake,
   * the 32-byte `ka` block of its key-agreement derivation. */
  readonly keyAgreementOutput: Uint8Array<ArrayBuffer>;
  readonly initiatorValue: Uint8Array<ArrayBuffer>;
  readonly expires: string | undefined;
}

/** Draw a fresh rotation value with `crypto.subtle.generateKey`. */
export async function drawRotationValue(): Promise<RotationValue> {
  const key = await crypto.subtle.generateKey(VALUE_KEY_ALGORITHM, true, [
    "sign",
  ]);
  return {
    key,
    bytes: new Uint8Array(await crypto.subtle.exportKey("raw", key)),
  };
}

/**
 * A rotation value from fixed bytes.
 *
 * @internal exported only for the known-answer vectors.
 */
export async function importRotationValue(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<RotationValue> {
  const key = await crypto.subtle.importKey(
    "raw",
    bytes,
    VALUE_KEY_ALGORITHM,
    true,
    ["sign"],
  );
  return { key, bytes: Uint8Array.from(bytes) };
}

// Derived straight to a non-extractable AES-KW key holding one usage, so its
// bytes never exist in JavaScript.
async function deriveWrappingKey(
  sessionKey: Uint8Array<ArrayBuffer>,
  sender: RotationValueSender,
  usage: "wrapKey" | "unwrapKey",
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    sessionKey,
    { name: "HKDF" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: enc.encode(
        sender === "initiator" ? INITIATOR_WRAP_LABEL : RESPONDER_WRAP_LABEL,
      ),
    },
    base,
    { name: "AES-KW", length: 256 },
    false,
    [usage],
  );
}

/** Wrap `value` with AES-KW under the key `sender`'s label derives. */
export async function wrapRotationValue(
  sessionKey: Uint8Array<ArrayBuffer>,
  sender: RotationValueSender,
  value: RotationValue,
): Promise<Uint8Array<ArrayBuffer>> {
  const wrappingKey = await deriveWrappingKey(sessionKey, sender, "wrapKey");
  return new Uint8Array(
    await crypto.subtle.wrapKey("raw", value.key, wrappingKey, "AES-KW"),
  );
}

/**
 * Unwrap a value `sender` wrapped, or `undefined` when it is not 40 bytes or
 * fails AES-KW's integrity check.
 */
export async function unwrapRotationValue(
  sessionKey: Uint8Array<ArrayBuffer>,
  sender: RotationValueSender,
  wrapped: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (wrapped.length !== WRAPPED_ROTATION_VALUE_BYTES) return undefined;
  const wrappingKey = await deriveWrappingKey(sessionKey, sender, "unwrapKey");
  try {
    const key = await crypto.subtle.unwrapKey(
      "raw",
      wrapped,
      wrappingKey,
      "AES-KW",
      VALUE_KEY_ALGORITHM,
      true,
      ["sign"],
    );
    return new Uint8Array(await crypto.subtle.exportKey("raw", key));
  } catch {
    return undefined;
  }
}

/**
 * The next shared secret, base64url:
 * `HKDF(ka || N_I || N_R, "alcove-shared-secret-next-v2", 32)`.
 */
export async function deriveNextSecret(
  keyAgreementOutput: Uint8Array<ArrayBuffer>,
  initiatorValue: Uint8Array<ArrayBuffer>,
  responderValue: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const ikm = new Uint8Array(
    keyAgreementOutput.length + initiatorValue.length + responderValue.length,
  );
  ikm.set(keyAgreementOutput, 0);
  ikm.set(initiatorValue, keyAgreementOutput.length);
  ikm.set(responderValue, keyAgreementOutput.length + initiatorValue.length);
  return toBase64Url(await hkdfDerive(ikm, NEXT_SECRET_LABEL, 32));
}
