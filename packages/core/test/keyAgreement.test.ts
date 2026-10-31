import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  computeKexKeys,
  deriveKeyAgreement,
  keyAgreementFixedInfo,
  runKex,
  supportedVersions,
  type KexCandidates,
  type KeyAgreementBlocks,
} from "../src/kex";
import { deriveNextSecret } from "../src/nextSecret";
import { historyProof } from "../src/rotationHistory";
import { createMessagePipe } from "../src/connection/messageConnection";
import { AuthenticationError } from "../src/errors";
import { toBase64Url } from "../src/utils/crypto";
import { encodeHello } from "../src/versionHello";

// The hello runKex sends by default, which these hand-rolled peers send too.
const HELLO_WIRE = toBase64Url(encodeHello(supportedVersions()));
const SUITE = String(supportedVersions().kex[0]);
import type { HandshakeRole } from "../src/types";

// The key-agreement derivation: the one HKDF call over Z, its FixedInfo layout,
// and what reaches it and what it reaches (docs/spec/PROTOCOL.md, "The
// key-agreement derivation").

const ECDH_P256 = { name: "ECDH", namedCurve: "P-256" } as const;
const GENERIC_FAILURE = "key exchange authentication failed";
const PSK_A = new Uint8Array(32).fill(0x42);
const PSK_B = new Uint8Array(32).fill(0x43);

interface Vectors {
  inputs: {
    pskHex: string;
    initiatorEphemeralPrivateHex: string;
    responderEphemeralPrivateHex: string;
    initiatorValueHex: string;
    responderValueHex: string;
  };
  derived: {
    initiatorEphemeralPublicHex: string;
    responderEphemeralPublicHex: string;
    dhSharedSecretHex: string;
    keyAgreementFixedInfoHex: string;
    keyAgreementEeHex: string;
    keyAgreementKaHex: string;
    keyAgreementHistoryInputHex: string;
  };
}

const vectors: Vectors = JSON.parse(
  readFileSync(new URL("./vectors/kex-vectors.json", import.meta.url), {
    encoding: "utf-8",
  }),
);

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
}

function toHex(u: Uint8Array): string {
  return Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");
}

const ascii = (s: string) => new TextEncoder().encode(s);

const eInitPub = fromHex(vectors.derived.initiatorEphemeralPublicHex);
const eRespPub = fromHex(vectors.derived.responderEphemeralPublicHex);
const z = fromHex(vectors.derived.dhSharedSecretHex);

// The derivation over Z as bytes, written from the spec's parameters rather
// than through kex.ts, so the module's call is checked against it.
async function hkdfOverZ(
  info: Uint8Array<ArrayBuffer>,
  lengthBits: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", z, "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(64), info },
      key,
      lengthBits,
    ),
  );
}

function importVectorPrivateKey(
  privateHex: string,
  publicPointHex: string,
): Promise<CryptoKey> {
  const point = fromHex(publicPointHex);
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: toBase64Url(fromHex(privateHex)),
      x: toBase64Url(point.slice(1, 33)),
      y: toBase64Url(point.slice(33, 65)),
    },
    ECDH_P256,
    false,
    ["deriveKey"],
  );
}

async function vectorBlocks(): Promise<KeyAgreementBlocks> {
  const blocks = await deriveKeyAgreement(
    await importVectorPrivateKey(
      vectors.inputs.initiatorEphemeralPrivateHex,
      vectors.derived.initiatorEphemeralPublicHex,
    ),
    await crypto.subtle.importKey("raw", eRespPub, ECDH_P256, false, []),
    eInitPub,
    eRespPub,
  );
  if (blocks === undefined) throw new Error("key agreement failed");
  return blocks;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the FixedInfo layout", () => {
  // Each field as [name, offset, bytes]: uPartyInfo then vPartyInfo, each
  // PartyId (label || protocol name || role) then that party's share.
  const FIELDS: ReadonlyArray<[string, number, Uint8Array]> = [
    ["U label", 0, ascii("alcove-kex-v2:key-agreement")],
    ["U protocol name", 27, ascii("alcove-kex-v3:NNpsk0_P256_SHA256")],
    ["U role", 59, ascii("initiator")],
    ["U share", 68, eInitPub],
    ["V label", 133, ascii("alcove-kex-v2:key-agreement")],
    ["V protocol name", 160, ascii("alcove-kex-v3:NNpsk0_P256_SHA256")],
    ["V role", 192, ascii("responder")],
    ["V share", 201, eRespPub],
  ];

  test("is uPartyInfo || vPartyInfo, 266 bytes, every field at its fixed offset", () => {
    const fixedInfo = keyAgreementFixedInfo(eInitPub, eRespPub);
    expect(fixedInfo).toHaveLength(266);
    let end = 0;
    for (const [name, offset, bytes] of FIELDS) {
      expect(offset, name).toBe(end);
      expect(toHex(fixedInfo.slice(offset, offset + bytes.length)), name).toBe(
        toHex(bytes),
      );
      end = offset + bytes.length;
    }
    expect(end).toBe(fixedInfo.length);
    expect(toHex(fixedInfo)).toBe(vectors.derived.keyAgreementFixedInfoHex);
  });

  test("the module's blocks are the front 96 bytes of the L = 2048 derivation, deterministic across calls and roles", async () => {
    const fixedInfo = keyAgreementFixedInfo(eInitPub, eRespPub);
    const okm = await hkdfOverZ(fixedInfo, 2048);
    expect(okm).toHaveLength(256);
    const first = await vectorBlocks();
    const again = await vectorBlocks();
    const responderSide = await deriveKeyAgreement(
      await importVectorPrivateKey(
        vectors.inputs.responderEphemeralPrivateHex,
        vectors.derived.responderEphemeralPublicHex,
      ),
      await crypto.subtle.importKey("raw", eInitPub, ECDH_P256, false, []),
      eInitPub,
      eRespPub,
    );
    for (const blocks of [first, again, responderSide!]) {
      expect(toHex(blocks.ee)).toBe(toHex(okm.slice(0, 32)));
      expect(toHex(blocks.ka)).toBe(toHex(okm.slice(32, 64)));
      expect(toHex(blocks.historyInput)).toBe(toHex(okm.slice(64, 96)));
    }
    // HKDF-Expand's output is a prefix chain, so a 768-bit request gives the
    // same three blocks: the tested L changes no value a partner computes.
    expect(toHex(await hkdfOverZ(fixedInfo, 768))).toBe(
      toHex(okm.slice(0, 96)),
    );
  });

  test("a changed byte in any field, or the parties in the other order, changes every block", async () => {
    const fixedInfo = keyAgreementFixedInfo(eInitPub, eRespPub);
    const baseline = toHex((await hkdfOverZ(fixedInfo, 2048)).slice(0, 96));
    const variants: Array<[string, Uint8Array<ArrayBuffer>]> = FIELDS.map(
      ([name, offset, bytes]) => {
        const changed = Uint8Array.from(fixedInfo);
        const at = offset + bytes.length - 1;
        changed[at] = (changed[at] as number) ^ 0x01;
        return [name, changed];
      },
    );
    variants.push(["order", keyAgreementFixedInfo(eRespPub, eInitPub)]);
    for (const [name, info] of variants) {
      const blocks = (await hkdfOverZ(info, 2048)).slice(0, 96);
      for (const range of [
        [0, 32],
        [32, 64],
        [64, 96],
      ] as const) {
        expect(toHex(blocks.slice(...range)), name).not.toBe(
          baseline.slice(range[0] * 2, range[1] * 2),
        );
      }
    }
  });
});

describe("each block reaches only its consumer", () => {
  async function consumers(blocks: KeyAgreementBlocks) {
    const keys = await computeKexKeys(
      PSK_A,
      new Uint8Array(0),
      eInitPub,
      eRespPub,
      blocks.ee,
      false,
      false,
    );
    return {
      session: toHex(keys.sessionKey),
      confirm: toHex(keys.confirmKey),
      next: await deriveNextSecret(
        blocks.ka,
        fromHex(vectors.inputs.initiatorValueHex),
        fromHex(vectors.inputs.responderValueHex),
      ),
      proof: toHex(
        await historyProof(new Uint8Array(32).fill(5), "responder", {
          initiatorShare: eInitPub,
          responderShare: eRespPub,
          historyInput: blocks.historyInput,
        }),
      ),
    };
  }

  test("replacing one block changes the outputs of that block's consumer and no other", async () => {
    const blocks = await vectorBlocks();
    const baseline = await consumers(blocks);
    const other = new Uint8Array(32).fill(0xa5);
    const cases: Array<[keyof KeyAgreementBlocks, string[]]> = [
      ["ee", ["session", "confirm"]],
      ["ka", ["next"]],
      ["historyInput", ["proof"]],
    ];
    for (const [block, changes] of cases) {
      const outputs = await consumers({ ...blocks, [block]: other });
      for (const key of Object.keys(baseline) as Array<keyof typeof baseline>) {
        if (changes.includes(key))
          expect(outputs[key], `${block} -> ${key}`).not.toBe(baseline[key]);
        else expect(outputs[key], `${block} -> ${key}`).toBe(baseline[key]);
      }
    }
  });
});

describe("Z reaches only the one derivation, through deriveKey", () => {
  interface SideRecord {
    ecdhDeriveBits: number;
    ecdhDeriveKey: Array<{ derivedType: string; extractable: boolean }>;
    derivationCalls: Array<{
      hash: string;
      salt: string;
      info: string;
      length: number;
    }>;
    ephemeralUsages: string[][];
  }

  function algorithmName(algorithm: unknown): string {
    return typeof algorithm === "string"
      ? algorithm
      : (algorithm as { name: string }).name;
  }

  function hexOf(source: BufferSource): string {
    return toHex(
      ArrayBuffer.isView(source)
        ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
        : new Uint8Array(source),
    );
  }

  // Records each side's crypto.subtle calls on Z through an async context the
  // side's handshake runs in, then restores the platform.
  async function recordHandshake(
    initiator: { psk: Uint8Array<ArrayBuffer>; candidates?: KexCandidates },
    responder: { psk: Uint8Array<ArrayBuffer>; candidates?: KexCandidates },
  ) {
    const side = new AsyncLocalStorage<HandshakeRole>();
    const fresh = (): SideRecord => ({
      ecdhDeriveBits: 0,
      ecdhDeriveKey: [],
      derivationCalls: [],
      ephemeralUsages: [],
    });
    const records = { initiator: fresh(), responder: fresh() };
    const sharedSecretKeys = new WeakSet<CryptoKey>();
    const subtle = crypto.subtle;
    const deriveBits = subtle.deriveBits.bind(subtle);
    const deriveKey = subtle.deriveKey.bind(subtle);
    const generateKey = subtle.generateKey.bind(subtle);
    vi.spyOn(subtle, "deriveBits").mockImplementation(
      (algorithm, baseKey, length) => {
        const role = side.getStore();
        if (role !== undefined) {
          if (algorithmName(algorithm) === "ECDH")
            records[role].ecdhDeriveBits++;
          if (sharedSecretKeys.has(baseKey)) {
            const params = algorithm as HkdfParams;
            records[role].derivationCalls.push({
              hash: algorithmName(params.hash),
              salt: hexOf(params.salt),
              info: hexOf(params.info),
              length: length ?? 0,
            });
          }
        }
        return deriveBits(algorithm, baseKey, length);
      },
    );
    vi.spyOn(subtle, "deriveKey").mockImplementation(
      async (algorithm, baseKey, derivedType, extractable, usages) => {
        const key = await deriveKey(
          algorithm,
          baseKey,
          derivedType,
          extractable,
          usages,
        );
        const role = side.getStore();
        if (role !== undefined && algorithmName(algorithm) === "ECDH") {
          records[role].ecdhDeriveKey.push({
            derivedType: algorithmName(derivedType),
            extractable: key.extractable,
          });
          sharedSecretKeys.add(key);
        }
        return key;
      },
    );
    vi.spyOn(subtle, "generateKey").mockImplementation(((
      algorithm: AlgorithmIdentifier,
      extractable: boolean,
      usages: KeyUsage[],
    ) => {
      const role = side.getStore();
      if (role !== undefined && algorithmName(algorithm) === "ECDH")
        records[role].ephemeralUsages.push([...usages]);
      return generateKey(algorithm, extractable, usages);
    }) as never);

    const [a, b] = createMessagePipe();
    const outcomes = await Promise.allSettled([
      side.run("initiator", () =>
        runKex(a, "initiator", initiator.psk, false, initiator.candidates),
      ),
      side.run("responder", () =>
        runKex(b, "responder", responder.psk, false, responder.candidates),
      ),
    ]);
    vi.restoreAllMocks();
    return { records, outcomes };
  }

  const CASES = [
    {
      name: "a matching secret",
      initiator: { psk: PSK_A },
      responder: { psk: PSK_A },
      completes: true,
    },
    {
      name: "a match under the previous secret",
      initiator: { psk: PSK_B, candidates: { previous: PSK_A, history: [] } },
      responder: { psk: PSK_A },
      completes: true,
    },
    {
      name: "the no-match abort",
      initiator: { psk: PSK_A },
      responder: { psk: PSK_B },
      completes: false,
    },
  ];

  for (const c of CASES) {
    test(`each side derives Z once into a non-extractable HKDF key and runs one derivation at the stated parameters: ${c.name}`, async () => {
      const { records, outcomes } = await recordHandshake(
        c.initiator,
        c.responder,
      );
      for (const outcome of outcomes)
        expect(outcome.status).toBe(c.completes ? "fulfilled" : "rejected");
      for (const role of ["initiator", "responder"] as const) {
        const record = records[role];
        expect(record.ecdhDeriveBits, role).toBe(0);
        expect(record.ecdhDeriveKey, role).toEqual([
          { derivedType: "HKDF", extractable: false },
        ]);
        expect(record.ephemeralUsages, role).toEqual([["deriveKey"]]);
        expect(record.derivationCalls, role).toHaveLength(1);
        const [call] = record.derivationCalls;
        expect(call!.hash).toBe("SHA-256");
        expect(call!.salt).toBe(toHex(new Uint8Array(64)));
        expect(call!.length).toBe(2048);
        expect(call!.info).toHaveLength(266 * 2);
      }
      // Both sides bind the same FixedInfo: the same shares in role order.
      expect(records.initiator.derivationCalls[0]!.info).toBe(
        records.responder.derivationCalls[0]!.info,
      );
    });
  }

  test("an ephemeral private key with the deriveKey usage alone refuses deriveBits", async () => {
    const pair = await crypto.subtle.generateKey(ECDH_P256, false, [
      "deriveKey",
    ]);
    const peer = await crypto.subtle.generateKey(ECDH_P256, false, [
      "deriveKey",
    ]);
    await expect(
      crypto.subtle.deriveBits(
        { name: "ECDH", public: peer.publicKey },
        pair.privateKey,
        256,
      ),
    ).rejects.toMatchObject({ name: "InvalidAccessError" });
  });
});

describe("the all-zero check on the derived blocks", () => {
  // Makes every ECDH deriveKey yield an HKDF key over a zero Z, the result an
  // identity point would give if importKey ever admitted one.
  function stubZeroSharedSecret(): void {
    const deriveKey = crypto.subtle.deriveKey.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "deriveKey").mockImplementation(((
      algorithm: AlgorithmIdentifier,
      ...rest: [CryptoKey, AlgorithmIdentifier, boolean, KeyUsage[]]
    ) => {
      if ((algorithm as { name?: string }).name !== "ECDH")
        return deriveKey(algorithm, ...rest);
      return crypto.subtle.importKey("raw", new Uint8Array(32), "HKDF", false, [
        "deriveBits",
      ]);
    }) as never);
  }

  async function freshShare(): Promise<string> {
    const pair = await crypto.subtle.generateKey(ECDH_P256, true, [
      "deriveKey",
    ]);
    return toBase64Url(
      new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    );
  }

  test("the initiator fails with the generic error and a bare abort, sending no tag", async () => {
    stubZeroSharedSecret();
    const [a, b] = createMessagePipe();
    const initiator = runKex(a, "initiator", PSK_A, false);
    initiator.catch(() => {});
    expect(((await b.receive()) as { kexMsg: string }).kexMsg).toBe("1");
    await b.send({
      kexMsg: "2",
      hello: HELLO_WIRE,
      e: await freshShare(),
      confirm: toBase64Url(new Uint8Array(32)),
      previousConfirm: toBase64Url(new Uint8Array(32)),
      historyProof: toBase64Url(new Uint8Array(32)),
      reqEnc: false,
    });
    const err = await initiator.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as Error).message).toBe(GENERIC_FAILURE);
    expect(await b.receive()).toEqual({ kexMsg: "abort" });
  });

  test("the responder fails with the generic error and a bare abort in place of message 2", async () => {
    stubZeroSharedSecret();
    const [a, b] = createMessagePipe();
    const responder = runKex(b, "responder", PSK_A, false);
    responder.catch(() => {});
    await a.send({
      kexMsg: "1",
      hello: HELLO_WIRE,
      e: { [SUITE]: await freshShare() },
      reqEnc: false,
    });
    const err = await responder.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as Error).message).toBe(GENERIC_FAILURE);
    expect(await a.receive()).toEqual({ kexMsg: "abort" });
  });
});

describe("which failures of deriveKeyAgreement are the peer's", () => {
  const LOCAL_FAULT = new Error("provider refused the parameter");

  async function ownPair(): Promise<{
    privateKey: CryptoKey;
    share: Uint8Array<ArrayBuffer>;
  }> {
    const pair = await crypto.subtle.generateKey(ECDH_P256, false, [
      "deriveKey",
    ]);
    return {
      privateKey: pair.privateKey,
      share: new Uint8Array(
        await crypto.subtle.exportKey("raw", pair.publicKey),
      ),
    };
  }

  async function agree(): Promise<KeyAgreementBlocks | undefined> {
    const mine = await ownPair();
    const peer = await ownPair();
    return deriveKeyAgreement(
      mine.privateKey,
      await crypto.subtle.importKey("raw", peer.share, ECDH_P256, false, []),
      mine.share,
      peer.share,
    );
  }

  test("a peer key the ECDH derivation refuses yields undefined", async () => {
    const mine = await ownPair();
    const otherCurve = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-384" },
      false,
      ["deriveKey"],
    );
    expect(
      await deriveKeyAgreement(
        mine.privateKey,
        otherCurve.publicKey,
        mine.share,
        mine.share,
      ),
    ).toBeUndefined();
  });

  test("a fault in an HKDF deriveBits call rejects with that fault", async () => {
    const deriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "deriveBits").mockImplementation(((
      algorithm: AlgorithmIdentifier,
      ...rest: [CryptoKey, number?]
    ) => {
      if ((algorithm as { name?: string }).name === "HKDF")
        return Promise.reject(LOCAL_FAULT);
      return deriveBits(algorithm, ...rest);
    }) as never);
    await expect(agree()).rejects.toBe(LOCAL_FAULT);
  });

  test("a fault importing the zero key rejects with that fault", async () => {
    const importKey = crypto.subtle.importKey.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "importKey").mockImplementation(((
      format: "raw",
      keyData: BufferSource,
      algorithm: AlgorithmIdentifier,
      ...rest: [boolean, KeyUsage[]]
    ) => {
      if ((algorithm as { name?: string }).name === "HKDF")
        return Promise.reject(LOCAL_FAULT);
      return importKey(format, keyData, algorithm as never, ...rest);
    }) as never);
    await expect(agree()).rejects.toBe(LOCAL_FAULT);
  });
});
