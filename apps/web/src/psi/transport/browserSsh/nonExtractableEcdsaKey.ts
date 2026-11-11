import {
  Buffer,
  PublicKeyAlgorithm,
  SshAlgorithms,
  SshBigInt,
} from "./sshLibrary";

import type { ECParameters, KeyPair, Signer, Verifier } from "./sshLibrary";

/** The SSH name of ECDSA on P-256 with SHA-256 (RFC 5656). */
export const SSH_ECDSA_P256 = "ecdsa-sha2-nistp256";
const CURVE_NAME = "nistp256";
const CURVE_OID = "1.2.840.10045.3.1.7";
const COORDINATE_BYTES = 32;
const UNCOMPRESSED_POINT_BYTES = 1 + 2 * COORDINATE_BYTES;
const ECDSA_P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN_PARAMS = { name: "ECDSA", hash: "SHA-256" } as const;

function sshString(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

function concat(parts: ReadonlyArray<Uint8Array>): Buffer {
  return Buffer.concat(parts.map((part) => Buffer.from(part)));
}

/**
 * An unsigned big-endian integer as an SSH `mpint` (RFC 4251, section 5).
 *
 * @internal exported for testing
 */
export function sshMpint(unsigned: Uint8Array): Uint8Array {
  let start = 0;
  while (start < unsigned.length && unsigned[start] === 0) start += 1;
  const magnitude = unsigned.subarray(start);
  const body =
    magnitude.length > 0 && magnitude[0] & 0x80
      ? new Uint8Array([0, ...magnitude])
      : magnitude;
  return sshString(body);
}

/** A new WebCrypto ECDSA P-256 pair whose private key is not extractable. */
export async function generateNonExtractableEcdsaP256CryptoKeyPair(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(ECDSA_P256, false, ["sign", "verify"]);
}

/**
 * The client's ECDSA P-256 key, held as a WebCrypto key pair whose private
 * key is not extractable. It signs only through `crypto.subtle.sign`, and no
 * method returns or exports the private key.
 */
export class NonExtractableEcdsaP256KeyPair implements KeyPair {
  readonly keyAlgorithmName = SSH_ECDSA_P256;
  readonly hasPublicKey = true;
  readonly hasPrivateKey = true;
  comment: string | null = null;
  readonly #privateKey: CryptoKey;
  readonly #publicKey: CryptoKey;
  readonly #point: Uint8Array;

  private constructor(
    privateKey: CryptoKey,
    publicKey: CryptoKey,
    point: Uint8Array,
  ) {
    this.#privateKey = privateKey;
    this.#publicKey = publicKey;
    this.#point = point;
  }

  /** A new pair, generated with its private key not extractable. */
  static async generate(): Promise<NonExtractableEcdsaP256KeyPair> {
    return await NonExtractableEcdsaP256KeyPair.fromCryptoKeyPair(
      await generateNonExtractableEcdsaP256CryptoKeyPair(),
    );
  }

  /** Wrap an existing P-256 pair; refuses one whose private key is extractable. */
  static async fromCryptoKeyPair(
    pair: CryptoKeyPair,
  ): Promise<NonExtractableEcdsaP256KeyPair> {
    const { privateKey, publicKey } = pair;
    if (privateKey.extractable)
      throw new Error("The client key's private key must not be extractable.");
    const algorithm = privateKey.algorithm as EcKeyAlgorithm;
    if (algorithm.name !== "ECDSA" || algorithm.namedCurve !== "P-256")
      throw new Error("The client key must be an ECDSA P-256 key.");
    const point = new Uint8Array(
      await crypto.subtle.exportKey("raw", publicKey),
    );
    if (point.length !== UNCOMPRESSED_POINT_BYTES || point[0] !== 4)
      throw new Error("Unexpected P-256 public key encoding.");
    return new NonExtractableEcdsaP256KeyPair(privateKey, publicKey, point);
  }

  /** @internal The public half, for verification. */
  get publicCryptoKey(): CryptoKey {
    return this.#publicKey;
  }

  /** The SSH public-key blob: `string name`, `string curve`, `string Q`. */
  getPublicKeyBytes(): Promise<Buffer> {
    const encoder = new TextEncoder();
    return Promise.resolve(
      concat([
        sshString(encoder.encode(SSH_ECDSA_P256)),
        sshString(encoder.encode(CURVE_NAME)),
        sshString(this.#point),
      ]),
    );
  }

  /** The `authorized_keys` line a server operator adds for this key. */
  async authorizedKeysLine(comment?: string): Promise<string> {
    const blob = (await this.getPublicKeyBytes()).toString("base64");
    return comment === undefined
      ? `${SSH_ECDSA_P256} ${blob}`
      : `${SSH_ECDSA_P256} ${blob} ${comment}`;
  }

  /** An SSH ECDSA signature body (`mpint r`, `mpint s`) over `data`. */
  async sign(data: Uint8Array): Promise<Buffer> {
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        SIGN_PARAMS,
        this.#privateKey,
        new Uint8Array(data),
      ),
    );
    return concat([
      sshMpint(raw.subarray(0, COORDINATE_BYTES)),
      sshMpint(raw.subarray(COORDINATE_BYTES)),
    ]);
  }

  /** The public parameters only; a non-extractable key has no `d` to give. */
  exportParameters(): Promise<ECParameters> {
    const x = Buffer.from(this.#point.subarray(1, 1 + COORDINATE_BYTES));
    const y = Buffer.from(this.#point.subarray(1 + COORDINATE_BYTES));
    return Promise.resolve({
      curve: { name: CURVE_NAME, oid: CURVE_OID },
      x: SshBigInt.fromBytes(x, { unsigned: true }),
      y: SshBigInt.fromBytes(y, { unsigned: true }),
    });
  }

  setPublicKeyBytes(): Promise<void> {
    return Promise.reject(
      new Error("A non-extractable key pair is built from its CryptoKeyPair."),
    );
  }

  generate(): Promise<void> {
    return Promise.reject(
      new Error("Use NonExtractableEcdsaP256KeyPair.generate()."),
    );
  }

  importParameters(_parameters: object): Promise<void> {
    return Promise.reject(
      new Error("A non-extractable key pair cannot import parameters."),
    );
  }

  dispose(): void {}
}

class NonExtractableSigner implements Signer {
  readonly digestLength = 2 * (4 + 1 + COORDINATE_BYTES);
  constructor(private readonly keyPair: NonExtractableEcdsaP256KeyPair) {}
  sign(data: Buffer): Promise<Buffer> {
    return this.keyPair.sign(data);
  }
  dispose(): void {}
}

/**
 * `ecdsa-sha2-nistp256`: signs with a {@link NonExtractableEcdsaP256KeyPair}
 * and verifies a server's P-256 host key through the SSH library's own
 * WebCrypto ECDSA, so it replaces the library's entry for this name.
 */
export class EcdsaP256PublicKeyAlgorithm extends PublicKeyAlgorithm {
  readonly #library: PublicKeyAlgorithm;

  constructor() {
    super(SSH_ECDSA_P256, SSH_ECDSA_P256, "SHA2-256");
    const library = SshAlgorithms.publicKey.ecdsaSha2Nistp256;
    if (library === null)
      throw new Error("The SSH library provides no ecdsa-sha2-nistp256.");
    this.#library = library;
  }

  createKeyPair(): KeyPair {
    return this.#library.createKeyPair();
  }

  generateKeyPair(): Promise<KeyPair> {
    return NonExtractableEcdsaP256KeyPair.generate();
  }

  createSigner(keyPair: KeyPair): Signer {
    if (!(keyPair instanceof NonExtractableEcdsaP256KeyPair))
      throw new TypeError(
        "The client key must be a non-extractable P-256 key.",
      );
    return new NonExtractableSigner(keyPair);
  }

  createVerifier(keyPair: KeyPair): Verifier {
    if (keyPair instanceof NonExtractableEcdsaP256KeyPair)
      throw new TypeError("The client key is not a server host key.");
    return this.#library.createVerifier(keyPair);
  }
}
