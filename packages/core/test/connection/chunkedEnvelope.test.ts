import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  CHUNKED_ENVELOPE_VERSION,
  EncryptedMessageConnection,
  MAX_AEAD_FRAME_BYTES,
  SINGLE_CALL_ENVELOPE_VERSION,
} from "../../src/connection/encryptedMessageConnection";
import {
  AEAD_CHUNK_PLAINTEXT_BYTES,
  AEAD_TAG_BYTES,
  CHUNKED_ENVELOPE_HEADER_BYTES,
  chunkAdditionalData,
  chunkIv,
} from "../../src/connection/chunkedAead";
import {
  createMessagePipe,
  type MessageConnection,
} from "../../src/connection/messageConnection";
import { ConnectionError } from "../../src/errors";
import { authenticateConnection } from "../../src/auth";
import { supportedVersions } from "../../src/kex";
import { deriveAeadKey } from "../../src/auth";
import { toBase64Url } from "../../src/utils/crypto";
import type { HandshakeRole } from "../../src/types";

// The chunk size, lowered per test so a frame of a few bytes spans several
// chunks; a test that leaves it unset runs at the real size.
const chunk = vi.hoisted(() => ({ bytes: undefined as number | undefined }));
vi.mock("../../src/connection/chunkedAead", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/connection/chunkedAead")>();
  return {
    ...actual,
    get AEAD_CHUNK_PLAINTEXT_BYTES() {
      return chunk.bytes ?? actual.AEAD_CHUNK_PLAINTEXT_BYTES;
    },
  };
});

afterEach(() => {
  chunk.bytes = undefined;
  vi.restoreAllMocks();
});

const SESSION_KEY = new Uint8Array(32).fill(0x42) as Uint8Array<ArrayBuffer>;
const V2_KEYING = {
  sessionKey: SESSION_KEY,
  negotiated: { kex: 3, protocol: 1, envelope: CHUNKED_ENVELOPE_VERSION },
};
const STRIDE = (chunkBytes: number) => chunkBytes + AEAD_TAG_BYTES;

async function pair(): Promise<
  [EncryptedMessageConnection, EncryptedMessageConnection]
> {
  const [rawA, rawB] = createMessagePipe();
  return Promise.all([
    EncryptedMessageConnection.create(rawA, V2_KEYING, "initiator"),
    EncryptedMessageConnection.create(rawB, V2_KEYING, "responder"),
  ]);
}

// A responder decorator and the raw end of its pipe, for injected frames.
async function injectable(): Promise<
  [EncryptedMessageConnection, MessageConnection]
> {
  const [rawPeer, rawLocal] = createMessagePipe();
  return [
    await EncryptedMessageConnection.create(rawLocal, V2_KEYING, "responder"),
    rawPeer,
  ];
}

// The envelopes an initiator decorator sends for `payloads`, from sequence 0.
async function envelopesFor(
  payloads: unknown[],
  role: HandshakeRole = "initiator",
): Promise<Uint8Array<ArrayBuffer>[]> {
  const sent: Uint8Array<ArrayBuffer>[] = [];
  const inner: MessageConnection = {
    send: (data) => {
      sent.push(data as Uint8Array<ArrayBuffer>);
      return Promise.resolve();
    },
    receive: () => new Promise<unknown>(() => {}),
    close: () => Promise.resolve(),
  };
  const conn = await EncryptedMessageConnection.create(inner, V2_KEYING, role);
  for (const payload of payloads) await conn.send(payload);
  return sent;
}

// Encrypts `plaintext` (type tag included) for frame `seq` with each chunk's
// final flag and index as given, so a test can build an envelope no conforming
// sender writes.
async function craftEnvelope(
  seq: number,
  plaintext: Uint8Array,
  chunkBytes: number,
  flags: { final: (index: number, chunks: number) => boolean },
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    "raw",
    await deriveAeadKey(SESSION_KEY, "initiator-to-responder"),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const chunks = Math.max(1, Math.ceil(plaintext.length / chunkBytes));
  const parts: Uint8Array[] = [];
  for (let index = 0; index < chunks; index++)
    parts.push(
      new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: chunkIv(seq, index),
            additionalData: chunkAdditionalData(
              CHUNKED_ENVELOPE_VERSION,
              seq,
              index,
              flags.final(index, chunks),
            ),
          },
          key,
          plaintext.slice(index * chunkBytes, (index + 1) * chunkBytes),
        ),
      ),
    );
  const header = new Uint8Array(CHUNKED_ENVELOPE_HEADER_BYTES);
  header[0] = CHUNKED_ENVELOPE_VERSION;
  new DataView(header.buffer).setBigUint64(1, BigInt(seq), false);
  return concat(header, ...parts);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  ) as Uint8Array<ArrayBuffer>;
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function expectRefused(
  receive: Promise<unknown>,
  pattern: RegExp,
): Promise<ConnectionError> {
  const error = await receive.then(
    () => {
      throw new Error("expected the frame to be refused");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ConnectionError);
  expect((error as ConnectionError).kind).toBe("security");
  expect((error as ConnectionError).message).toMatch(pattern);
  return error as ConnectionError;
}

const TAG_FAILURE = /authentication tag verification failed/;

// An 11-byte payload at a chunk size of 4: a plaintext of 12 bytes, three
// chunks of 20 bytes each after the 9-byte header.
const ELEVEN = Uint8Array.from({ length: 11 }, (_, i) => i + 1);

function chunkAt(envelope: Uint8Array, index: number, chunkBytes = 4) {
  const from = CHUNKED_ENVELOPE_HEADER_BYTES + index * STRIDE(chunkBytes);
  return envelope.slice(from, from + STRIDE(chunkBytes));
}

describe("round trips", () => {
  test.each([0, 1, 2, 3, 4, 7, 8, 11, 100])(
    "a binary payload of %i bytes round-trips at a chunk size of 4",
    async (length) => {
      chunk.bytes = 4;
      const [a, b] = await pair();
      const payload = Uint8Array.from({ length }, (_, i) => (i * 7) & 0xff);
      await a.send(payload);
      expect(await b.receive()).toEqual(payload);
    },
  );

  test("JSON and binary frames interleave in both directions at a chunk size of 5", async () => {
    chunk.bytes = 5;
    const [a, b] = await pair();
    await a.send({ round: 1, values: ["x", "y"] });
    await b.send(new Uint8Array([9, 8, 7, 6, 5, 4, 3]));
    await a.send(new Uint8Array(0));
    expect(await b.receive()).toEqual({ round: 1, values: ["x", "y"] });
    expect(await a.receive()).toEqual(new Uint8Array([9, 8, 7, 6, 5, 4, 3]));
    expect(await b.receive()).toEqual(new Uint8Array(0));
  });

  test("a frame of one chunk and one byte at the real chunk size round-trips", async () => {
    const [a, b] = await pair();
    const payload = new Uint8Array(AEAD_CHUNK_PLAINTEXT_BYTES).fill(0x5a);
    await a.send(payload);
    const received = (await b.receive()) as Uint8Array;
    expect(received.length).toBe(payload.length);
    expect(received.every((byte) => byte === 0x5a)).toBe(true);
  });

  test("the payload is returned as a view of the delivered envelope, decrypted in place", async () => {
    chunk.bytes = 4;
    const [envelope] = await envelopesFor([ELEVEN]);
    const [recv, peer] = await injectable();
    await peer.send(envelope);
    const received = (await recv.receive()) as Uint8Array;
    expect(received).toEqual(ELEVEN);
    expect(received.buffer).toBe(envelope!.buffer);
  });
});

describe("tampered envelopes are refused", () => {
  async function refuse(envelope: Uint8Array, pattern = TAG_FAILURE) {
    const [recv, peer] = await injectable();
    await peer.send(envelope);
    return expectRefused(recv.receive(), pattern);
  }

  async function threeChunks() {
    chunk.bytes = 4;
    const [envelope] = await envelopesFor([ELEVEN]);
    expect(envelope!.length).toBe(CHUNKED_ENVELOPE_HEADER_BYTES + 3 * 20);
    return envelope!;
  }

  test("a dropped chunk", async () => {
    const envelope = await threeChunks();
    await refuse(
      concat(envelope.slice(0, 9), chunkAt(envelope, 0), chunkAt(envelope, 2)),
    );
  });

  test("two chunks reordered", async () => {
    const envelope = await threeChunks();
    await refuse(
      concat(
        envelope.slice(0, 9),
        chunkAt(envelope, 1),
        chunkAt(envelope, 0),
        chunkAt(envelope, 2),
      ),
    );
  });

  test("a chunk repeated in another's place", async () => {
    const envelope = await threeChunks();
    await refuse(
      concat(
        envelope.slice(0, 9),
        chunkAt(envelope, 0),
        chunkAt(envelope, 0),
        chunkAt(envelope, 2),
      ),
    );
  });

  test("a chunk repeated in addition", async () => {
    const envelope = await threeChunks();
    await refuse(concat(envelope, chunkAt(envelope, 2)));
  });

  test("an envelope cut after a whole chunk", async () => {
    const envelope = await threeChunks();
    await refuse(envelope.slice(0, 9 + 2 * 20));
  });

  test("bytes cut from within the last chunk", async () => {
    const envelope = await threeChunks();
    await refuse(envelope.slice(0, envelope.length - 3));
  });

  test("a chunk spliced in from another frame of the session, at the same index", async () => {
    chunk.bytes = 4;
    const [first, second] = await envelopesFor([ELEVEN, ELEVEN]);
    await refuse(
      concat(
        first!.slice(0, 9),
        chunkAt(first!, 0),
        chunkAt(second!, 1),
        chunkAt(first!, 2),
      ),
    );
  });

  test("a whole frame moved to another sequence number", async () => {
    chunk.bytes = 4;
    const [, second] = await envelopesFor([ELEVEN, ELEVEN]);
    const moved = second!.slice();
    new DataView(moved.buffer).setBigUint64(1, 0n, false);
    await refuse(moved);
  });

  test("a chunk from the other direction", async () => {
    chunk.bytes = 4;
    const [initiatorFrame] = await envelopesFor([ELEVEN]);
    const [responderFrame] = await envelopesFor([ELEVEN], "responder");
    await refuse(
      concat(
        initiatorFrame!.slice(0, 9),
        chunkAt(responderFrame!, 0),
        chunkAt(initiatorFrame!, 1),
        chunkAt(initiatorFrame!, 2),
      ),
    );
  });

  test("a flipped ciphertext byte in a middle chunk", async () => {
    const envelope = await threeChunks();
    envelope[9 + 20 + 2]! ^= 0x01;
    await refuse(envelope);
  });

  test("the final-chunk flag missing from the last chunk", async () => {
    chunk.bytes = 4;
    const plaintext = concat(new Uint8Array([1]), ELEVEN);
    await refuse(await craftEnvelope(0, plaintext, 4, { final: () => false }));
  });

  test("the final-chunk flag set on a chunk before the last", async () => {
    chunk.bytes = 4;
    const plaintext = concat(new Uint8Array([1]), ELEVEN);
    await refuse(
      await craftEnvelope(0, plaintext, 4, {
        final: (index, chunks) => index === 0 || index === chunks - 1,
      }),
    );
  });

  test("the crafted envelope with the flags a sender writes opens, so the two above fail on the flag alone", async () => {
    chunk.bytes = 4;
    const plaintext = concat(new Uint8Array([1]), ELEVEN);
    const [recv, peer] = await injectable();
    await peer.send(
      await craftEnvelope(0, plaintext, 4, {
        final: (index, chunks) => index === chunks - 1,
      }),
    );
    expect(await recv.receive()).toEqual(ELEVEN);
  });

  test("an envelope ending in a chunk shorter than a byte and its tag, before any decryption", async () => {
    const envelope = await threeChunks();
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    await refuse(
      concat(envelope, new Uint8Array(AEAD_TAG_BYTES)),
      /ends in a chunk too short/,
    );
    expect(decrypt).not.toHaveBeenCalled();
  });

  test("an envelope shorter than a header and one chunk of one byte", async () => {
    await refuse(
      new Uint8Array(9 + 16).fill(2),
      /^EncryptedMessageConnection: envelope is too short$/,
    );
  });

  test("a version-1 envelope byte on a version-2 connection", async () => {
    const envelope = await threeChunks();
    envelope[0] = SINGLE_CALL_ENVELOPE_VERSION;
    await refuse(envelope, /unsupported envelope version 1/);
  });

  test("a replayed frame, by its sequence number, before decryption", async () => {
    chunk.bytes = 4;
    const [envelope] = await envelopesFor([ELEVEN]);
    const [recv, peer] = await injectable();
    await peer.send(envelope!.slice());
    expect(await recv.receive()).toEqual(ELEVEN);
    await peer.send(envelope!.slice());
    await expectRefused(recv.receive(), /replay or out-of-order/);
  });
});

describe("a frame that fails at chunk k", () => {
  test("releases nothing, zeroes the plaintext already written, and latches the connection", async () => {
    chunk.bytes = 4;
    const [envelope] = await envelopesFor([ELEVEN]);
    const tampered = envelope!.slice();
    tampered[tampered.length - 1]! ^= 0x01;
    const [recv, peer] = await injectable();
    await peer.send(tampered);
    const error = await expectRefused(recv.receive(), TAG_FAILURE);
    // Chunks 0 and 1 decrypted into the envelope's bytes 9 to 16 before the
    // last chunk's tag failed.
    expect(Array.from(tampered.subarray(9, 17))).toEqual(new Array(8).fill(0));
    await expect(recv.receive()).rejects.toBe(error);
  });
});

describe("each chunk's decrypted buffer", () => {
  const prototype = ArrayBuffer.prototype as unknown as {
    transfer(length: number): ArrayBuffer;
  };

  test("is detached once it is copied into the envelope", async () => {
    chunk.bytes = 4;
    const transfer = vi.spyOn(prototype, "transfer");
    const [a, b] = await pair();
    await a.send(ELEVEN);
    expect(await b.receive()).toEqual(ELEVEN);
    expect(transfer.mock.calls).toEqual([[0], [0], [0]]);
    for (const buffer of transfer.mock.contexts)
      expect((buffer as ArrayBuffer).byteLength).toBe(0);
  });

  test("is left to the collector where the engine has no ArrayBuffer transfer", async () => {
    chunk.bytes = 4;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "transfer")!;
    delete (prototype as Partial<typeof prototype>).transfer;
    try {
      const [a, b] = await pair();
      await a.send(ELEVEN);
      expect(await b.receive()).toEqual(ELEVEN);
    } finally {
      Object.defineProperty(prototype, "transfer", descriptor);
    }
  });
});

describe("the nonce", () => {
  test("no IV repeats across the chunks and frames of a direction, and each is the index then the sequence number", async () => {
    chunk.bytes = 4;
    const encrypt = vi.spyOn(crypto.subtle, "encrypt");
    await envelopesFor([ELEVEN, { a: "bc" }, new Uint8Array(0), ELEVEN]);
    const calls = encrypt.mock.calls.map(([params]) => params as AesGcmParams);
    const ivs = calls.map(({ iv }) =>
      Buffer.from(iv as Uint8Array).toString("hex"),
    );
    expect(new Set(ivs).size).toBe(ivs.length);
    const frames = [3, 3, 1, 3];
    const expected: string[] = [];
    frames.forEach((chunks, seq) => {
      for (let index = 0; index < chunks; index++)
        expected.push(Buffer.from(chunkIv(seq, index)).toString("hex"));
    });
    expect(ivs).toEqual(expected);
    const finals = calls.map(
      ({ additionalData }) => (additionalData as Uint8Array)[13],
    );
    expect(finals).toEqual([0, 0, 1, 0, 0, 1, 1, 0, 0, 1]);
  });

  test("the chunk index of any frame a Uint8Array can hold fits its 32 bits", () => {
    expect(
      Math.ceil(Number.MAX_SAFE_INTEGER / AEAD_CHUNK_PLAINTEXT_BYTES),
    ).toBeLessThan(2 ** 32);
  });
});

describe("the connection's frame bounds under version 2", () => {
  test("the envelope a frame is sent in is the frame plus the stated overhead, which never falls as the frame grows", async () => {
    chunk.bytes = 4;
    const [a] = await pair();
    let previous = 0;
    for (const length of [0, 1, 3, 4, 7, 8, 11, 12, 100]) {
      const [envelope] = await envelopesFor([new Uint8Array(length)]);
      const overhead = a.outboundFrameOverheadBytes(length);
      expect(envelope!.length - length).toBe(overhead);
      expect(overhead).toBeGreaterThanOrEqual(previous);
      previous = overhead;
    }
  });

  test("states no frame ceiling and forwards a per-exchange cap unclamped", async () => {
    const caps: Array<number | undefined> = [];
    const [, rawLocal] = createMessagePipe();
    const conn = await EncryptedMessageConnection.create(
      {
        send: (data) => rawLocal.send(data),
        receive: (timeoutMs) => rawLocal.receive(timeoutMs),
        close: () => rawLocal.close(),
        setInboundFrameCap: (maxBytes) => caps.push(maxBytes),
      },
      V2_KEYING,
      "initiator",
    );
    expect(conn.frameCeilingBytes()).toBeUndefined();
    const fiveGiB = 5 * 2 ** 30;
    conn.setInboundFrameCap(fiveGiB);
    expect(caps).toEqual([fiveGiB]);
  });
});

const vectors = JSON.parse(
  readFileSync(
    new URL("../vectors/aead-chunked-envelope-vectors.json", import.meta.url),
    "utf8",
  ),
) as {
  sessionKeyHex: string;
  envelopeVersion: number;
  chunkPlaintextBytes: number;
  vectors: Array<{
    name: string;
    role: HandshakeRole;
    sequence: number;
    chunkBytes: number;
    payloadType: "json" | "binary";
    payloadJson?: unknown;
    payloadHex?: string;
    payloadPatternBytes?: number;
    envelopeBytes: number;
    envelopeHex?: string;
    envelopeSha256?: string;
    envelopeTailHex?: string;
  }>;
};

function patternPayload(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length) as Uint8Array<ArrayBuffer>;
  for (let i = 0; i < length; i++) out[i] = i % 251;
  return out;
}

describe("the known-answer vectors", () => {
  test("are keyed by this file's session key, at version 2 and the real chunk size", () => {
    expect(vectors.sessionKeyHex).toBe(
      Buffer.from(SESSION_KEY).toString("hex"),
    );
    expect(vectors.envelopeVersion).toBe(CHUNKED_ENVELOPE_VERSION);
    expect(vectors.chunkPlaintextBytes).toBe(AEAD_CHUNK_PLAINTEXT_BYTES);
  });

  test.each(vectors.vectors)(
    "$name: the decorator sends the pinned envelope and opens it",
    async (vector) => {
      chunk.bytes = vector.chunkBytes;
      const payload =
        vector.payloadType === "json"
          ? vector.payloadJson
          : vector.payloadPatternBytes !== undefined
            ? patternPayload(vector.payloadPatternBytes)
            : Uint8Array.from(Buffer.from(vector.payloadHex!, "hex"));
      let captured: Uint8Array<ArrayBuffer> | undefined;
      const sender = await EncryptedMessageConnection.create(
        {
          send: (data) => {
            captured = data as Uint8Array<ArrayBuffer>;
            return Promise.resolve();
          },
          receive: () => new Promise<unknown>(() => {}),
          close: () => Promise.resolve(),
        },
        V2_KEYING,
        vector.role,
      );
      (sender as unknown as { sendSeq: number }).sendSeq = vector.sequence;
      await sender.send(payload);
      expect(captured!.length).toBe(vector.envelopeBytes);
      if (vector.envelopeHex !== undefined)
        expect(Buffer.from(captured!).toString("hex")).toBe(vector.envelopeHex);
      else {
        expect(createHash("sha256").update(captured!).digest("hex")).toBe(
          vector.envelopeSha256,
        );
        expect(Buffer.from(captured!.subarray(-32)).toString("hex")).toBe(
          vector.envelopeTailHex,
        );
      }

      const [rawPeer, rawLocal] = createMessagePipe();
      const receiver = await EncryptedMessageConnection.create(
        rawLocal,
        V2_KEYING,
        vector.role === "initiator" ? "responder" : "initiator",
      );
      (receiver as unknown as { recvSeq: number }).recvSeq =
        vector.sequence - 1;
      await rawPeer.send(captured);
      const received = await receiver.receive();
      if (payload instanceof Uint8Array)
        expect(Buffer.from(received as Uint8Array).equals(payload)).toBe(true);
      else expect(received).toEqual(payload);
    },
  );
});

describe("the negotiation", () => {
  const SECRET = toBase64Url(new Uint8Array(32).fill(0x24));

  async function negotiate(responderEnvelopes: number[]) {
    const [a, b] = createMessagePipe();
    const [initiator, responder] = await Promise.all([
      authenticateConnection(
        a,
        { sharedSecret: SECRET },
        "initiator",
        true,
        { history: [] },
        supportedVersions(),
      ),
      authenticateConnection(
        b,
        { sharedSecret: SECRET },
        "responder",
        true,
        { history: [] },
        { ...supportedVersions(), envelope: responderEnvelopes },
      ),
    ]);
    const [sending, receiving] = await Promise.all([
      EncryptedMessageConnection.create(a, initiator, "initiator"),
      EncryptedMessageConnection.create(b, responder, "responder"),
    ]);
    return { initiator, responder, sending, receiving, b };
  }

  test("this build offers envelope versions 1 and 2", () => {
    expect(supportedVersions().envelope).toEqual([
      SINGLE_CALL_ENVELOPE_VERSION,
      CHUNKED_ENVELOPE_VERSION,
    ]);
  });

  test("two parties on this build select version 2 and send chunked envelopes", async () => {
    const { initiator, responder, sending, receiving } = await negotiate(
      supportedVersions().envelope as number[],
    );
    expect(initiator.negotiated.envelope).toBe(CHUNKED_ENVELOPE_VERSION);
    expect(responder.negotiated.envelope).toBe(CHUNKED_ENVELOPE_VERSION);
    expect(sending.envelopeVersion).toBe(CHUNKED_ENVELOPE_VERSION);
    expect(receiving.envelopeVersion).toBe(CHUNKED_ENVELOPE_VERSION);
    expect(sending.frameCeilingBytes()).toBeUndefined();
    const encrypt = vi.spyOn(crypto.subtle, "encrypt");
    await sending.send(new Uint8Array([1, 2, 3]));
    expect(
      (encrypt.mock.calls[0]![0] as AesGcmParams).additionalData,
    ).toBeDefined();
    expect(await receiving.receive()).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("a partner on an earlier build, offering version 1 alone, selects version 1 with this build, and the frame limit returns", async () => {
    const { initiator, responder, sending, receiving } = await negotiate([
      SINGLE_CALL_ENVELOPE_VERSION,
    ]);
    expect(initiator.negotiated.envelope).toBe(SINGLE_CALL_ENVELOPE_VERSION);
    expect(responder.negotiated.envelope).toBe(SINGLE_CALL_ENVELOPE_VERSION);
    expect(sending.envelopeVersion).toBe(SINGLE_CALL_ENVELOPE_VERSION);
    expect(receiving.envelopeVersion).toBe(SINGLE_CALL_ENVELOPE_VERSION);
    expect(sending.frameCeilingBytes()).toBe(MAX_AEAD_FRAME_BYTES);
    const encrypt = vi.spyOn(crypto.subtle, "encrypt");
    await sending.send({ ok: true });
    const params = encrypt.mock.calls[0]![0] as AesGcmParams;
    expect(params.additionalData).toBeUndefined();
    expect(Buffer.from(params.iv as Uint8Array).toString("hex")).toBe(
      "000000000000000000000000",
    );
    expect(await receiving.receive()).toEqual({ ok: true });
  });
});
