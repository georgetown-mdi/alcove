// Regenerates aead-chunked-envelope-vectors.json: the known-answer vectors for
// envelope version 2, the chunked AEAD envelope. Run from the repo root:
//
//   node packages/core/test/vectors/generate-aead-chunked-envelope-vectors.mjs
//   npm run format
//
// The oracle is Node's crypto.hkdfSync + createCipheriv, a different code path
// than the decorator's crypto.subtle, so chunkedEnvelope.test.ts pins the
// decorator against a separate implementation. Layout, nonce and additional
// data: docs/spec/CHANNEL_SECURITY.md, "The chunked envelope, version 2".

import { createCipheriv, createHash, hkdfSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENVELOPE_VERSION = 2;
const CHUNK_PLAINTEXT_BYTES = 16_777_216;
const TYPE_JSON = 0;
const TYPE_BINARY = 1;
const INFO_PREFIX = "alcove-aead-v2:";
const SESSION_KEY = Buffer.alloc(32, 0x42);
const SALT = Buffer.alloc(32, 0x00);

const toHex = (bytes) => Buffer.from(bytes).toString("hex");

function deriveKey(context) {
  return Buffer.from(
    hkdfSync("sha256", SESSION_KEY, SALT, INFO_PREFIX + context, 32),
  );
}

function chunkIv(sequence, index) {
  const iv = Buffer.alloc(12);
  iv.writeUInt32BE(index, 0);
  iv.writeBigUInt64BE(BigInt(sequence), 4);
  return iv;
}

function chunkAad(sequence, index, final) {
  const aad = Buffer.alloc(14);
  aad[0] = ENVELOPE_VERSION;
  aad.writeBigUInt64BE(BigInt(sequence), 1);
  aad.writeUInt32BE(index, 9);
  aad[13] = final ? 1 : 0;
  return aad;
}

// The payload a pattern vector holds: `length` bytes, byte i being i % 251.
function patternPayload(length) {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = i % 251;
  return out;
}

function payloadOf(spec) {
  if (spec.payloadType === "json")
    return Buffer.from(JSON.stringify(spec.payloadJson), "utf-8");
  if (spec.payloadPatternBytes !== undefined)
    return patternPayload(spec.payloadPatternBytes);
  return Buffer.from(spec.payloadHex, "hex");
}

function encrypt(spec) {
  const key = deriveKey(spec.context);
  const typeTag = spec.payloadType === "binary" ? TYPE_BINARY : TYPE_JSON;
  const plaintext = Buffer.concat([Buffer.from([typeTag]), payloadOf(spec)]);
  const chunks = Math.max(1, Math.ceil(plaintext.length / spec.chunkBytes));
  const header = Buffer.alloc(9);
  header[0] = ENVELOPE_VERSION;
  header.writeBigUInt64BE(BigInt(spec.sequence), 1);
  const parts = [header];
  for (let index = 0; index < chunks; index++) {
    const cipher = createCipheriv(
      "aes-256-gcm",
      key,
      chunkIv(spec.sequence, index),
    );
    cipher.setAAD(chunkAad(spec.sequence, index, index === chunks - 1));
    parts.push(
      cipher.update(
        plaintext.subarray(
          index * spec.chunkBytes,
          Math.min(plaintext.length, (index + 1) * spec.chunkBytes),
        ),
      ),
      cipher.final(),
      cipher.getAuthTag(),
    );
  }
  const envelope = Buffer.concat(parts);
  const out = {
    name: spec.name,
    description: spec.description,
    role: spec.role,
    context: spec.context,
    sequence: spec.sequence,
    chunkBytes: spec.chunkBytes,
    chunks,
    payloadType: spec.payloadType,
  };
  if (spec.payloadType === "json") out.payloadJson = spec.payloadJson;
  else if (spec.payloadPatternBytes !== undefined)
    out.payloadPatternBytes = spec.payloadPatternBytes;
  else out.payloadHex = spec.payloadHex;
  out.envelopeBytes = envelope.length;
  if (spec.digestOnly) {
    out.envelopeSha256 = createHash("sha256").update(envelope).digest("hex");
    out.envelopeTailHex = toHex(envelope.subarray(envelope.length - 32));
  } else out.envelopeHex = toHex(envelope);
  return out;
}

const specs = [
  {
    name: "json-initiator-seq0",
    description:
      "JSON object payload (type tag 0) from the initiator at sequence 0: one chunk, flagged final.",
    role: "initiator",
    context: "initiator-to-responder",
    sequence: 0,
    chunkBytes: CHUNK_PLAINTEXT_BYTES,
    payloadType: "json",
    payloadJson: { hello: "world", n: 42 },
  },
  {
    name: "binary-responder-seq1",
    description:
      "Uint8Array payload (type tag 1) from the responder at sequence 1, under the other directional key: one chunk.",
    role: "responder",
    context: "responder-to-initiator",
    sequence: 1,
    chunkBytes: CHUNK_PLAINTEXT_BYTES,
    payloadType: "binary",
    payloadHex: "deadbeef",
  },
  {
    name: "binary-initiator-seq7-exact-chunks",
    description:
      "An 11-byte Uint8Array at a chunk size of 4: a plaintext of 12 bytes, three full chunks with no empty fourth.",
    role: "initiator",
    context: "initiator-to-responder",
    sequence: 7,
    chunkBytes: 4,
    payloadType: "binary",
    payloadHex: "000102030405060708090a",
  },
  {
    name: "json-initiator-seq4328719365-short-last-chunk",
    description:
      "A JSON object at a chunk size of 5 and sequence 0x0102030405, so the sequence number shows in each IV and the last chunk is short.",
    role: "initiator",
    context: "initiator-to-responder",
    sequence: 4328719365,
    chunkBytes: 5,
    payloadType: "json",
    payloadJson: { ack: true, round: 3 },
  },
  {
    name: "binary-initiator-seq2-one-chunk-and-one-byte",
    description:
      "A Uint8Array of 16,777,216 bytes, byte i being i % 251, at the real chunk size: a plaintext of one chunk and one byte, recorded by the SHA-256 of the envelope and its last 32 bytes.",
    role: "initiator",
    context: "initiator-to-responder",
    sequence: 2,
    chunkBytes: CHUNK_PLAINTEXT_BYTES,
    payloadType: "binary",
    payloadPatternBytes: CHUNK_PLAINTEXT_BYTES,
    digestOnly: true,
  },
];

const doc = {
  description:
    "Known-answer vectors for envelope version 2, the chunked AEAD envelope of EncryptedMessageConnection. Each vector fixes (sessionKey, role, sequence, chunk size, plaintext) and records the exact envelope: version || seq || chunk_0 || ... || chunk_(n-1), each chunk AES-256-GCM ciphertext || 16-byte tag under IV_k and AAD_k below. The construction is specified in docs/spec/CHANNEL_SECURITY.md, 'The chunked envelope, version 2'. Regenerate with generate-aead-chunked-envelope-vectors.mjs in this directory.",
  cipher: "AES-256-GCM",
  sessionKeyHex: toHex(SESSION_KEY),
  envelopeVersion: ENVELOPE_VERSION,
  chunkPlaintextBytes: CHUNK_PLAINTEXT_BYTES,
  envelopeLayout:
    "version (1 byte) || seq (8 bytes, big-endian) || chunks; the plaintext type_tag || payload is cut into chunks of chunkBytes bytes, the last 1 to chunkBytes bytes.",
  ivLayout: "12 bytes: uint32_be(chunk index) || uint64_be(seq).",
  additionalDataLayout:
    "14 bytes: version || uint64_be(seq) || uint32_be(chunk index) || final (0x01 on the last chunk, else 0x00).",
  keyDerivation: {
    function: "HKDF-SHA-256",
    saltHex: toHex(SALT),
    infoPrefix: INFO_PREFIX,
    note: "info = infoPrefix + context; the initiator sends under context 'initiator-to-responder'.",
  },
  patternPayload:
    "payloadPatternBytes N stands for N bytes, byte i being i % 251.",
  typeTags: { json: TYPE_JSON, binary: TYPE_BINARY },
  vectors: specs.map(encrypt),
};

const outPath = fileURLToPath(
  new URL("./aead-chunked-envelope-vectors.json", import.meta.url),
);
writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${doc.vectors.length} vectors to ${outPath}`);
