import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { deriveRelayKey } from "../src/relayCredential";
import { deriveRelayRegistrarProofKey } from "../src/relayRegistrarProof";
import type { RendezvousRole } from "../src/rendezvous";
import { toHex } from "../src/utils/crypto";
import {
  buildWebSocketRelayProof,
  checkWebSocketRelayProof,
  deriveWebSocketRelayProofKey,
  parseWebSocketRelayProof,
  WEBSOCKET_RELAY_PROOF_MAX_TTL_SECONDS,
  WebSocketRelayProofRefusedError,
} from "../src/websocketRelayProof";
import type {
  WebSocketRelayProof,
  WebSocketRelayProofRefusal,
} from "../src/websocketRelayProof";

interface RelayProofVectors {
  inputs: {
    sharedSecret: string;
    madeAtSeconds: number;
    ttlSeconds: number;
    expiresAtSeconds: number;
  };
  derived: {
    relayKeyHex: string;
    proofKeyHex: string;
    registrarProofKeyHex: string;
  };
  proofs: {
    role: RendezvousRole;
    message: string;
    messageHex: string;
    tagHex: string;
  }[];
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

const vectors: RelayProofVectors = JSON.parse(
  readFileSync(
    new URL("./vectors/relay-proof-vectors.json", import.meta.url),
    "utf8",
  ),
) as RelayProofVectors;

const { inputs, derived } = vectors;
const madeAt = new Date(inputs.madeAtSeconds * 1000);
const proofKey = fromHex(derived.proofKeyHex);
const inviterVector = vectors.proofs[0];

function presented(
  vector: RelayProofVectors["proofs"][number],
): WebSocketRelayProof {
  return parseWebSocketRelayProof(
    fromHex(vector.messageHex),
    fromHex(vector.tagHex),
  );
}

async function refusalOf(
  run: () => unknown,
): Promise<WebSocketRelayProofRefusal> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(WebSocketRelayProofRefusedError);
    return (error as WebSocketRelayProofRefusedError).reason;
  }
  throw new Error("expected a refusal");
}

describe("the WebSocket relay proof key", () => {
  test("the vectors hold a proof for each rendezvous role", () => {
    expect(vectors.proofs.map(({ role }) => role)).toEqual([
      "inviter",
      "acceptor",
    ]);
  });

  test("derives the relay key and the proof key the vectors pin", async () => {
    const relayKey = await deriveRelayKey(inputs.sharedSecret);
    expect(relayKey).toBe(derived.relayKeyHex);
    expect(toHex(await deriveWebSocketRelayProofKey(relayKey))).toBe(
      derived.proofKeyHex,
    );
  });

  test("differs from the relay key and from the registrar proof key", async () => {
    const registrarProofKey = toHex(
      await deriveRelayRegistrarProofKey(derived.relayKeyHex),
    );
    expect(registrarProofKey).toBe(derived.registrarProofKeyHex);
    expect(
      new Set([derived.relayKeyHex, registrarProofKey, derived.proofKeyHex])
        .size,
    ).toBe(3);
  });

  test("refuses a relay key that is not 64 lowercase hex characters", async () => {
    await expect(
      deriveWebSocketRelayProofKey(derived.relayKeyHex.toUpperCase()),
    ).rejects.toThrow(/deriveWebSocketRelayProofKey/);
  });
});

describe("buildWebSocketRelayProof", () => {
  test.each(vectors.proofs)(
    "matches the $role vector",
    async ({ role, message, messageHex, tagHex }) => {
      const proof = await buildWebSocketRelayProof({
        relayKey: derived.relayKeyHex,
        role,
        ttlSeconds: inputs.ttlSeconds,
        now: new Date(madeAt.getTime() + 999),
      });
      expect(proof.role).toBe(role);
      expect(proof.expiresAtSeconds).toBe(inputs.expiresAtSeconds);
      expect(new TextDecoder().decode(proof.message)).toBe(message);
      expect(toHex(proof.message)).toBe(messageHex);
      expect(toHex(proof.tag)).toBe(tagHex);
    },
  );

  test.each([
    ["a role that is not a rendezvous role", { role: "relay" }],
    ["a zero ttl", { ttlSeconds: 0 }],
    [
      "a ttl over the maximum",
      { ttlSeconds: WEBSOCKET_RELAY_PROOF_MAX_TTL_SECONDS + 1 },
    ],
    ["a fractional ttl", { ttlSeconds: 1.5 }],
    ["an invalid date", { now: new Date(Number.NaN) }],
    ["a date before the epoch", { now: new Date(-1000) }],
    ["a short relay key", { relayKey: derived.relayKeyHex.slice(1) }],
  ])("refuses %s", async (_, override) => {
    await expect(
      buildWebSocketRelayProof({
        relayKey: derived.relayKeyHex,
        role: "inviter",
        ttlSeconds: 1,
        now: madeAt,
        ...(override as object),
      }),
    ).rejects.toThrow(/buildWebSocketRelayProof|deriveWebSocketRelayProofKey/);
  });
});

describe("parseWebSocketRelayProof", () => {
  test.each(vectors.proofs)("reads the $role vector", (vector) => {
    const proof = presented(vector);
    expect(proof.role).toBe(vector.role);
    expect(proof.expiresAtSeconds).toBe(inputs.expiresAtSeconds);
    expect(toHex(proof.message)).toBe(vector.messageHex);
    expect(toHex(proof.tag)).toBe(vector.tagHex);
  });

  test("copies the presented bytes", () => {
    const message = fromHex(inviterVector.messageHex);
    const tag = fromHex(inviterVector.tagHex);
    const proof = parseWebSocketRelayProof(message, tag);
    message.fill(0);
    tag.fill(0);
    expect(toHex(proof.message)).toBe(inviterVector.messageHex);
    expect(toHex(proof.tag)).toBe(inviterVector.tagHex);
  });

  const tag = fromHex(inviterVector.tagHex);
  const text = (s: string) => new TextEncoder().encode(s);
  const label = "alcove-relay-websocket-v2:hello";
  test.each<[string, unknown, unknown]>([
    ["a string message", inviterVector.message, tag],
    ["a missing message", undefined, tag],
    ["a hex tag", fromHex(inviterVector.messageHex), inviterVector.tagHex],
    ["a 31-byte tag", fromHex(inviterVector.messageHex), tag.slice(1)],
    [
      "a 33-byte tag",
      fromHex(inviterVector.messageHex),
      new Uint8Array([...tag, 0]),
    ],
    [
      "another label",
      text("alcove-relay-registrar-v2:request\ninviter\n1"),
      tag,
    ],
    ["a role that is not a rendezvous role", text(`${label}\nrelay\n1`), tag],
    ["an uppercase role", text(`${label}\nINVITER\n1`), tag],
    ["a leading zero", text(`${label}\ninviter\n01`), tag],
    ["a negative expiry", text(`${label}\ninviter\n-1`), tag],
    ["a trailing LF", text(`${label}\ninviter\n1\n`), tag],
    ["a CR LF separator", text(`${label}\r\ninviter\r\n1`), tag],
    ["a fourth field", text(`${label}\ninviter\n1\n2`), tag],
    ["a missing expiry", text(`${label}\ninviter`), tag],
    [
      "an expiry past the safe integers",
      text(`${label}\ninviter\n${"9".repeat(17)}`),
      tag,
    ],
    ["bytes that are not UTF-8", new Uint8Array([0xff, 0xfe]), tag],
    [
      "a message over the bound",
      text(`${label}\ninviter\n${"1".repeat(200)}`),
      tag,
    ],
    ["an empty message", new Uint8Array(0), tag],
  ])("refuses %s as malformed", async (_, message, presentedTag) => {
    expect(
      await refusalOf(() => parseWebSocketRelayProof(message, presentedTag)),
    ).toBe("malformed");
  });
});

describe("checkWebSocketRelayProof", () => {
  test.each(vectors.proofs)(
    "accepts the $role vector before its expiry",
    async (vector) => {
      await expect(
        checkWebSocketRelayProof({
          proofKey,
          proof: presented(vector),
          role: vector.role,
          now: new Date(inputs.expiresAtSeconds * 1000 - 1),
        }),
      ).resolves.toBeUndefined();
    },
  );

  test("accepts a proof it built under a key it derived", async () => {
    const proof = await buildWebSocketRelayProof({
      relayKey: derived.relayKeyHex,
      role: "acceptor",
      ttlSeconds: WEBSOCKET_RELAY_PROOF_MAX_TTL_SECONDS,
      now: madeAt,
    });
    await expect(
      checkWebSocketRelayProof({
        proofKey: await deriveWebSocketRelayProofKey(derived.relayKeyHex),
        proof: parseWebSocketRelayProof(proof.message, proof.tag),
        role: "acceptor",
        now: madeAt,
      }),
    ).resolves.toBeUndefined();
  });

  test("refuses a proof at and after its expiry", async () => {
    for (const nowSeconds of [
      inputs.expiresAtSeconds,
      inputs.expiresAtSeconds + 1,
    ]) {
      expect(
        await refusalOf(() =>
          checkWebSocketRelayProof({
            proofKey,
            proof: presented(inviterVector),
            role: "inviter",
            now: new Date(nowSeconds * 1000),
          }),
        ),
      ).toBe("expired");
    }
  });

  test("refuses a proof made for the other role", async () => {
    expect(
      await refusalOf(() =>
        checkWebSocketRelayProof({
          proofKey,
          proof: presented(inviterVector),
          role: "acceptor",
          now: madeAt,
        }),
      ),
    ).toBe("role-mismatch");
  });

  test("refuses one role's tag under the other role's message", async () => {
    const proof = parseWebSocketRelayProof(
      fromHex(vectors.proofs[1].messageHex),
      fromHex(inviterVector.tagHex),
    );
    expect(
      await refusalOf(() =>
        checkWebSocketRelayProof({
          proofKey,
          proof,
          role: "acceptor",
          now: madeAt,
        }),
      ),
    ).toBe("tag-mismatch");
  });

  test.each([0, 15, 31])("refuses a tag with byte %i flipped", async (i) => {
    const tag = fromHex(inviterVector.tagHex);
    tag[i] ^= 0x01;
    expect(
      await refusalOf(() =>
        checkWebSocketRelayProof({
          proofKey,
          proof: parseWebSocketRelayProof(
            fromHex(inviterVector.messageHex),
            tag,
          ),
          role: "inviter",
          now: madeAt,
        }),
      ),
    ).toBe("tag-mismatch");
  });

  test("refuses a later expiry under the original tag", async () => {
    const message = new TextEncoder().encode(
      `alcove-relay-websocket-v2:hello\ninviter\n${inputs.expiresAtSeconds + 1}`,
    );
    expect(
      await refusalOf(() =>
        checkWebSocketRelayProof({
          proofKey,
          proof: parseWebSocketRelayProof(
            message,
            fromHex(inviterVector.tagHex),
          ),
          role: "inviter",
          now: madeAt,
        }),
      ),
    ).toBe("tag-mismatch");
  });

  test("refuses a proof under the relay key or the registrar proof key", async () => {
    for (const keyHex of [derived.relayKeyHex, derived.registrarProofKeyHex]) {
      expect(
        await refusalOf(() =>
          checkWebSocketRelayProof({
            proofKey: fromHex(keyHex),
            proof: presented(inviterVector),
            role: "inviter",
            now: madeAt,
          }),
        ),
      ).toBe("tag-mismatch");
    }
  });

  test.each([
    ["a proof key that is not 32 bytes", { proofKey: proofKey.slice(1) }],
    ["an invalid date", { now: new Date(Number.NaN) }],
  ])("throws on %s as a caller fault", async (_, override) => {
    await expect(
      checkWebSocketRelayProof({
        proofKey,
        proof: presented(inviterVector),
        role: "inviter",
        now: madeAt,
        ...override,
      }),
    ).rejects.toThrow(/checkWebSocketRelayProof/);
  });
});
