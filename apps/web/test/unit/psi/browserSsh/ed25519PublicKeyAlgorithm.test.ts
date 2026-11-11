import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  Ed25519PublicKeyAlgorithm,
  SSH_ED25519,
} from "@psi/transport/browserSsh/ed25519PublicKeyAlgorithm";
import { BrowserSshVerifyOnlyError } from "@psi/transport/browserSsh/browserSshErrors";
import { Buffer } from "@psi/transport/browserSsh/sshLibrary";

function sshString(bytes: Uint8Array | string): Buffer {
  const body =
    typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

function keyBlob(publicKey: Uint8Array): Buffer {
  return Buffer.concat([sshString(SSH_ED25519), sshString(publicKey)]);
}

// RFC 8032, section 7.1, TEST 1: the empty message.
const RFC8032_PUBLIC_KEY = Buffer.from(
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  "hex",
);
const RFC8032_SIGNATURE = Buffer.from(
  "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  "hex",
);

async function verifierFor(publicKey: Uint8Array) {
  const algorithm = new Ed25519PublicKeyAlgorithm();
  const keyPair = algorithm.createKeyPair();
  await keyPair.setPublicKeyBytes(keyBlob(publicKey));
  return { algorithm, keyPair, verifier: algorithm.createVerifier(keyPair) };
}

describe("Ed25519PublicKeyAlgorithm", () => {
  test("verifies the RFC 8032 test vector", async () => {
    const { verifier } = await verifierFor(RFC8032_PUBLIC_KEY);
    expect(await verifier.verify(Buffer.alloc(0), RFC8032_SIGNATURE)).toBe(
      true,
    );
  });

  test("refuses the vector with one signature bit flipped", async () => {
    const { verifier } = await verifierFor(RFC8032_PUBLIC_KEY);
    const flipped = Buffer.from(RFC8032_SIGNATURE);
    flipped[10] = flipped[10] ^ 0x01;
    expect(await verifier.verify(Buffer.alloc(0), flipped)).toBe(false);
  });

  test("refuses a signature of the wrong length", async () => {
    const { verifier } = await verifierFor(RFC8032_PUBLIC_KEY);
    expect(
      await verifier.verify(Buffer.alloc(0), RFC8032_SIGNATURE.subarray(1)),
    ).toBe(false);
  });

  test("verifies an SSH signature blob made by node:crypto", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "jwk" }).x!;
    const data = Buffer.from("exchange hash");
    const signatureBlob = Buffer.concat([
      sshString(SSH_ED25519),
      sshString(sign(null, data, privateKey)),
    ]);
    const { algorithm, verifier } = await verifierFor(
      Buffer.from(raw, "base64url"),
    );
    const signature = algorithm.readSignatureData(signatureBlob);
    expect(await verifier.verify(data, signature)).toBe(true);
    expect(await verifier.verify(Buffer.from("other data"), signature)).toBe(
      false,
    );
  });

  test("hands back the blob it was given, as a copy", async () => {
    const blob = keyBlob(RFC8032_PUBLIC_KEY);
    const keyPair = new Ed25519PublicKeyAlgorithm().createKeyPair();
    await keyPair.setPublicKeyBytes(blob);
    const returned = await keyPair.getPublicKeyBytes();
    blob.fill(0);
    expect(returned?.equals(keyBlob(RFC8032_PUBLIC_KEY))).toBe(true);
  });

  test("refuses a key of the wrong length", async () => {
    const keyPair = new Ed25519PublicKeyAlgorithm().createKeyPair();
    await expect(
      keyPair.setPublicKeyBytes(keyBlob(RFC8032_PUBLIC_KEY.subarray(1))),
    ).rejects.toThrow(/32 bytes/);
  });

  test("refuses a 32-byte key with bytes after it", async () => {
    const keyPair = new Ed25519PublicKeyAlgorithm().createKeyPair();
    await expect(
      keyPair.setPublicKeyBytes(
        Buffer.concat([keyBlob(RFC8032_PUBLIC_KEY), Buffer.from([1, 2, 3])]),
      ),
    ).rejects.toThrow(/got 32 bytes and 3 more\.$/);
  });

  test("refuses a blob naming another algorithm", async () => {
    const keyPair = new Ed25519PublicKeyAlgorithm().createKeyPair();
    const blob = Buffer.concat([
      sshString("ssh-rsa"),
      sshString(RFC8032_PUBLIC_KEY),
    ]);
    await expect(keyPair.setPublicKeyBytes(blob)).rejects.toThrow(/ssh-rsa/);
  });

  test("refuses to sign or generate: it is verify-only", async () => {
    const algorithm = new Ed25519PublicKeyAlgorithm();
    expect(() => algorithm.createSigner(algorithm.createKeyPair())).toThrow(
      BrowserSshVerifyOnlyError,
    );
    await expect(algorithm.generateKeyPair()).rejects.toBeInstanceOf(
      BrowserSshVerifyOnlyError,
    );
    await expect(algorithm.createKeyPair().generate()).rejects.toBeInstanceOf(
      BrowserSshVerifyOnlyError,
    );
  });
});
