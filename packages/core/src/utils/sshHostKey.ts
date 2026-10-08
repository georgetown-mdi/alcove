import { sha256, bytesEqual } from "./crypto.js";

/**
 * The longest host-key type returned verbatim, in bytes; the same bound the
 * partner's advertised key type is parsed under (`protocolSetup.ts`).
 */
const MAX_KEY_TYPE_BYTES = 64;

/**
 * Source bytes a placeholder encodes: 24 bytes give 48 hex digits, a
 * 58-character placeholder within {@link MAX_KEY_TYPE_BYTES}.
 */
const PLACEHOLDER_SOURCE_BYTES = 24;

/** What a blob holding no readable type at all yields. */
const UNREADABLE_KEY_TYPE = "(unknown)";

/** Whether a byte is in the verbatim charset `[A-Za-z0-9._@-]`. */
function isAcceptedKeyTypeByte(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) || // A-Z
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    byte === 0x2e || // .
    byte === 0x5f || // _
    byte === 0x40 || // @
    byte === 0x2d // -
  );
}

/** The type when every byte is accepted and the length is within bound. */
function acceptedKeyType(typeBytes: Uint8Array): string | undefined {
  if (typeBytes.length > MAX_KEY_TYPE_BYTES) return undefined;
  let type = "";
  for (const byte of typeBytes) {
    if (!isAcceptedKeyTypeByte(byte)) return undefined;
    type += String.fromCharCode(byte);
  }
  return type;
}

/**
 * `(unknown:<hex>)` for a rejected type, encoding its first
 * {@link PLACEHOLDER_SOURCE_BYTES} bytes so rejected types that differ there
 * stay distinguishable. See
 * docs/spec/CHANNEL_SECURITY.md#sftp-host-key-verification.
 */
function placeholderKeyType(typeBytes: Uint8Array): string {
  let hex = "";
  for (const byte of typeBytes.subarray(0, PLACEHOLDER_SOURCE_BYTES))
    hex += byte.toString(16).padStart(2, "0");
  return `(unknown:${hex})`;
}

/**
 * The key type, the blob's first length-prefixed string, bounded for display:
 * verbatim when it is at most {@link MAX_KEY_TYPE_BYTES} bytes in the accepted
 * charset, a {@link placeholderKeyType} otherwise, and `"(unknown)"` rather
 * than a throw when the blob has no readable type. See
 * docs/spec/CHANNEL_SECURITY.md#sftp-host-key-verification.
 */
function keyTypeFromBlob(blob: Uint8Array): string {
  if (blob.length < 4) return UNREADABLE_KEY_TYPE;
  // `>>> 0` keeps a first byte >= 0x80 from making `typeLen` negative and
  // slipping past the bound check below.
  const typeLen =
    (((blob[0] as number) << 24) |
      ((blob[1] as number) << 16) |
      ((blob[2] as number) << 8) |
      (blob[3] as number)) >>>
    0;
  if (typeLen === 0 || typeLen > blob.length - 4) return UNREADABLE_KEY_TYPE;
  const typeBytes = blob.subarray(4, 4 + typeLen);
  return acceptedKeyType(typeBytes) ?? placeholderKeyType(typeBytes);
}

/** Unpadded standard base64, the encoding OpenSSH fingerprints use. */
function toBase64Unpadded(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary).replace(/=+$/, "");
}

function fromBase64Unpadded(b64: string): Uint8Array {
  const binStr = atob(b64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++)
    bytes[i] = binStr.charCodeAt(i) as number;
  return bytes;
}

/**
 * The OpenSSH SHA256 fingerprint of a raw host-key blob, as `ssh-keygen -lf`
 * prints it. See docs/spec/CHANNEL_SECURITY.md#sftp-host-key-verification.
 *
 * @param keyBlob - raw blob from ssh2's `hostVerifier`; `hostHash` must not be
 *   set, since it makes ssh2 pass a pre-hashed key.
 */
export async function computeHostKeyFingerprint(
  keyBlob: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const digest = await sha256(keyBlob);
  return "SHA256:" + toBase64Unpadded(digest);
}

/**
 * The first pin in `pins` that the raw host-key blob matches, returned
 * verbatim, or `undefined`. A pin `atob` cannot decode is skipped. See
 * docs/spec/CHANNEL_SECURITY.md#sftp-host-key-verification.
 *
 * @param keyBlob - raw host-key blob from ssh2's `hostVerifier`
 * @param pins - pinned fingerprints in OpenSSH SHA256 format
 */
export async function matchHostKeyFingerprint(
  keyBlob: Uint8Array<ArrayBuffer>,
  pins: readonly string[],
): Promise<string | undefined> {
  const digest = await sha256(keyBlob);
  for (const pin of pins) {
    let pinBytes: Uint8Array;
    try {
      pinBytes = fromBase64Unpadded(pin.slice("SHA256:".length));
    } catch {
      continue;
    }
    if (
      bytesEqual(
        digest as Uint8Array<ArrayBuffer>,
        pinBytes as Uint8Array<ArrayBuffer>,
      )
    )
      return pin;
  }
  return undefined;
}

/**
 * @internal The bounded key type, for operator-facing messages.
 */
export { keyTypeFromBlob };
