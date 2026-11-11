import { Buffer, PublicKeyAlgorithm, SshDataReader } from "./sshLibrary";
import { BrowserSshVerifyOnlyError } from "./browserSshErrors";

import type { KeyPair, Signer, Verifier } from "./sshLibrary";

/** The SSH name of the Ed25519 host-key and signature algorithm (RFC 8709). */
export const SSH_ED25519 = "ssh-ed25519";

const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

/**
 * An `ssh-ed25519` public key: a server's host key, read from its SSH blob
 * (`string "ssh-ed25519"`, `string key`) and imported into WebCrypto for
 * verification only.
 */
export class Ed25519PublicKey implements KeyPair {
  readonly keyAlgorithmName = SSH_ED25519;
  readonly hasPrivateKey = false;
  comment: string | null = null;
  #blob: Buffer | null = null;
  #key: CryptoKey | null = null;

  get hasPublicKey(): boolean {
    return this.#key !== null;
  }

  /** @internal The imported WebCrypto verification key. */
  get cryptoKey(): CryptoKey | null {
    return this.#key;
  }

  async setPublicKeyBytes(keyBytes: Buffer): Promise<void> {
    const reader = new SshDataReader(keyBytes);
    const algorithm = reader.readString("ascii");
    if (algorithm !== SSH_ED25519)
      throw new Error(`Expected an ${SSH_ED25519} key; got ${algorithm}.`);
    const key = reader.readBinary();
    if (key.length !== ED25519_PUBLIC_KEY_BYTES || reader.available !== 0)
      throw new Error(
        `An ${SSH_ED25519} key is ${ED25519_PUBLIC_KEY_BYTES} bytes with nothing after it; got ${key.length} bytes${reader.available === 0 ? "" : ` and ${reader.available} more`}.`,
      );
    this.#key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(key),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    // A copy: the library hands over a view of a packet buffer it reuses.
    this.#blob = Buffer.from(keyBytes);
  }

  getPublicKeyBytes(): Promise<Buffer | null> {
    return Promise.resolve(this.#blob);
  }

  generate(): Promise<void> {
    return Promise.reject(new BrowserSshVerifyOnlyError(SSH_ED25519));
  }

  importParameters(_parameters: object): Promise<void> {
    return Promise.reject(new BrowserSshVerifyOnlyError(SSH_ED25519));
  }

  exportParameters(): Promise<never> {
    return Promise.reject(new BrowserSshVerifyOnlyError(SSH_ED25519));
  }

  dispose(): void {}
}

class Ed25519Verifier implements Verifier {
  readonly digestLength = ED25519_SIGNATURE_BYTES;
  constructor(private readonly key: CryptoKey) {}

  async verify(data: Buffer, signature: Buffer): Promise<boolean> {
    if (signature.length !== ED25519_SIGNATURE_BYTES) return false;
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      this.key,
      new Uint8Array(signature),
      new Uint8Array(data),
    );
  }

  dispose(): void {}
}

/**
 * `ssh-ed25519` for host-key verification on WebCrypto's Ed25519, which the
 * SSH library does not provide. Verify-only: the client never signs with it.
 */
export class Ed25519PublicKeyAlgorithm extends PublicKeyAlgorithm {
  constructor() {
    super(SSH_ED25519, SSH_ED25519, "SHA2-512");
  }

  createKeyPair(): KeyPair {
    return new Ed25519PublicKey();
  }

  generateKeyPair(): Promise<KeyPair> {
    return Promise.reject(new BrowserSshVerifyOnlyError(SSH_ED25519));
  }

  createSigner(_keyPair: KeyPair): Signer {
    throw new BrowserSshVerifyOnlyError(SSH_ED25519);
  }

  createVerifier(keyPair: KeyPair): Verifier {
    if (!(keyPair instanceof Ed25519PublicKey) || keyPair.cryptoKey === null)
      throw new TypeError(`An ${SSH_ED25519} public key is required.`);
    return new Ed25519Verifier(keyPair.cryptoKey);
  }
}
