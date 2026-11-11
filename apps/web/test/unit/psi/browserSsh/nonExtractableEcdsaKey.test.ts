import { createPublicKey, createVerify } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  Buffer,
  SshAlgorithms,
  SshDataReader,
} from "@psi/transport/browserSsh/sshLibrary";
import {
  EcdsaP256PublicKeyAlgorithm,
  NonExtractableEcdsaP256KeyPair,
  SSH_ECDSA_P256,
  sshMpint,
} from "@psi/transport/browserSsh/nonExtractableEcdsaKey";

async function nonExtractablePair(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
}

describe("NonExtractableEcdsaP256KeyPair", () => {
  test("generates a pair whose private key is not extractable", async () => {
    const pair = await nonExtractablePair();
    await NonExtractableEcdsaP256KeyPair.fromCryptoKeyPair(pair);
    expect(pair.privateKey.extractable).toBe(false);
    for (const format of ["pkcs8", "jwk"] as const)
      await expect(
        crypto.subtle.exportKey(format, pair.privateKey),
      ).rejects.toThrow();
  });

  test("refuses a pair whose private key is extractable", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    await expect(
      NonExtractableEcdsaP256KeyPair.fromCryptoKeyPair(pair),
    ).rejects.toThrow(/must not be extractable/);
  });

  test("refuses a key on another curve", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-384" },
      false,
      ["sign", "verify"],
    );
    await expect(
      NonExtractableEcdsaP256KeyPair.fromCryptoKeyPair(pair),
    ).rejects.toThrow(/P-256/);
  });

  test("exports public parameters and no private scalar", async () => {
    const key = await NonExtractableEcdsaP256KeyPair.generate();
    const parameters = await key.exportParameters();
    expect(parameters).not.toHaveProperty("d");
    expect(parameters.curve).toEqual({
      name: "nistp256",
      oid: "1.2.840.10045.3.1.7",
    });
  });

  test("writes the RFC 5656 public-key blob and its authorized_keys line", async () => {
    const key = await NonExtractableEcdsaP256KeyPair.generate();
    const blob = await key.getPublicKeyBytes();
    const reader = new SshDataReader(blob);
    expect(reader.readString("ascii")).toBe(SSH_ECDSA_P256);
    expect(reader.readString("ascii")).toBe("nistp256");
    const point = reader.readBinary();
    expect(point.length).toBe(65);
    expect(point[0]).toBe(4);
    expect(reader.available).toBe(0);
    expect(await key.authorizedKeysLine("page")).toBe(
      `${SSH_ECDSA_P256} ${blob.toString("base64")} page`,
    );
  });

  test("signs in the SSH form (mpint r, mpint s) that an independent verifier accepts", async () => {
    const key = await NonExtractableEcdsaP256KeyPair.generate();
    const blob = await key.getPublicKeyBytes();
    const library = SshAlgorithms.publicKey.ecdsaSha2Nistp256!;
    const publicKey = library.createKeyPair();
    await publicKey.setPublicKeyBytes(blob);
    const verifier = library.createVerifier(publicKey);
    const data = Buffer.from("session identifier and request");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const signature = await key.sign(data);
      expect(await verifier.verify(data, signature)).toBe(true);
    }
  });

  test("signs through the algorithm's signer and verifies with node:crypto", async () => {
    const key = await NonExtractableEcdsaP256KeyPair.generate();
    const algorithm = new EcdsaP256PublicKeyAlgorithm();
    const data = Buffer.from("payload");
    const signature = new SshDataReader(
      await algorithm.createSigner(key).sign(data),
    );
    const r = signature.readBigInt().toBytes({ unsigned: true, length: 32 });
    const s = signature.readBigInt().toBytes({ unsigned: true, length: 32 });
    const jwk = await crypto.subtle.exportKey("jwk", key.publicCryptoKey);
    const verify = createVerify("SHA256");
    verify.update(data);
    expect(
      verify.verify(
        {
          key: createPublicKey({ key: jwk, format: "jwk" }),
          dsaEncoding: "ieee-p1363",
        },
        Buffer.concat([r, s]),
      ),
    ).toBe(true);
  });

  test("signs only with a non-extractable key pair", () => {
    const algorithm = new EcdsaP256PublicKeyAlgorithm();
    expect(() => algorithm.createSigner(algorithm.createKeyPair())).toThrow(
      TypeError,
    );
  });
});

describe("sshMpint", () => {
  test.each([
    { value: [0x01], encoded: [0, 0, 0, 1, 0x01] },
    { value: [0x00, 0x00, 0x7f], encoded: [0, 0, 0, 1, 0x7f] },
    { value: [0x80, 0x01], encoded: [0, 0, 0, 3, 0x00, 0x80, 0x01] },
    { value: [0x00, 0x00], encoded: [0, 0, 0, 0] },
  ])("encodes $value", ({ value, encoded }) => {
    expect([...sshMpint(new Uint8Array(value))]).toEqual(encoded);
  });
});
