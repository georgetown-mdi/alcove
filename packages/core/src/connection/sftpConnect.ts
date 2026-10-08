// Pure helpers and constants the SFTP connect path shares across its three
// host-key verifier forms; the methods that close over session state live on
// SftpSession (./sftpSession). Host-key rationale: docs/SECURITY_DESIGN.md and
// docs/spec/CHANNEL_SECURITY.md, SFTP host-key verification.

/**
 * The host key a server presented on the SFTP channel, as observed by
 * {@link SftpSession.probeHostKeyFingerprint}. Both fields are public: the CLI
 * shows them on a first-use trust prompt and persists `fingerprint` as the pin.
 */
export interface PresentedHostKey {
  /**
   * OpenSSH SHA256 fingerprint of the presented key, e.g. `SHA256:abc...xyz`,
   * byte-identical to what `ssh-keygen -lf` prints and what
   * `connection.server.host_key_fingerprint` pins.
   */
  fingerprint: string;
  /**
   * SSH key-type string, e.g. `ssh-ed25519`, as {@link keyTypeFromBlob} returned
   * it. Unsanitized, and a partner-advertised value is only length-bounded
   * (`protocolSetup.ts`): show it only through an escaping sink.
   */
  keyType: string;
}

/**
 * View an ssh2 hostVerifier `keyBlob` as a Uint8Array over the same bytes. A
 * Buffer may view a shared pool, so the offset and length must pass through.
 *
 * @internal
 */
export const hostKeyBlob = (keyBlob: Buffer): Uint8Array<ArrayBuffer> =>
  new Uint8Array(
    keyBlob.buffer as ArrayBuffer,
    keyBlob.byteOffset,
    keyBlob.byteLength,
  );

/**
 * Deliver an ssh2 hostVerifier verdict, swallowing the throw a late call makes
 * once the handshake has torn down while the async check was pending: the
 * verdict is moot, and an escaped throw would be an unhandled rejection.
 *
 * @internal
 */
export const settleVerify = (
  verify: (permitted: boolean) => void,
  permitted: boolean,
): void => {
  try {
    verify(permitted);
  } catch {
    // swallow: see settleVerify header
  }
};

/**
 * The `ssh2-sftp-client` options `connection.providerOptions` may set for SFTP;
 * every other key is dropped with a warning. An allowlist because ssh2's
 * sensitive options (`sock`, `authHandler`, `agent`) are many and grow.
 * `algorithms` is filtered by {@link SFTP_ALGORITHMS_ALLOWED_SUBKEYS}
 * (docs/EXCHANGE_REFERENCE.md, `connection.provider_options`).
 *
 * @internal
 */
export const SFTP_PROVIDER_OPTIONS_ALLOWLIST: ReadonlySet<string> = new Set([
  "keepaliveInterval",
  "keepaliveCountMax",
  "strictVendor",
  "algorithms",
]);

/**
 * The `algorithms` sub-categories `providerOptions` may tune. `serverHostKey` is
 * excluded: it is a host-key-trust decision.
 *
 * @internal
 */
export const SFTP_ALGORITHMS_ALLOWED_SUBKEYS: ReadonlySet<string> = new Set([
  "cipher",
  "hmac",
  "kex",
  "compress",
]);
