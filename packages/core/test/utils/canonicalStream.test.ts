import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  computeCommitment,
  type CommitmentName,
  type CommittedPayload,
} from "../../src/records/exchangeRecord";
import { buildReceiptContent } from "../../src/records/signedReceipt";
import {
  canonicalBytes,
  canonicalString,
  CanonicalEncodingError,
  writeCanonicalBytes,
} from "../../src/utils/canonical";
import {
  canonicalBytesPastStringCap,
  canonicalHmacSha256,
} from "../../src/utils/canonicalHmac";
import { hkdfDerive, hmacSha256, toBase64Url } from "../../src/utils/crypto";

// The chunked encoder and the HMAC over it are held to the one-shot encoding:
// every chunk sequence and the buffer built from it must equal the bytes
// canonicalBytes returns, and every HMAC over that buffer must equal the HMAC
// over those bytes, so a record or receipt built either way verifies against
// the other.

type Vector =
  | { name: string; value: unknown; bytesHex: string; refuses?: undefined }
  | { name: string; value: unknown; refuses: true };

const { vectors } = JSON.parse(
  readFileSync(new URL("../vectors/canonical-vectors.json", import.meta.url), {
    encoding: "utf8",
  }),
) as { vectors: Vector[] };

const CHUNK_CODE_UNITS = 1 << 16;

/** The chunks writeCanonicalBytes writes for `value`, in order. */
function chunksOf(value: unknown): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  writeCanonicalBytes(value, (chunk) => {
    chunks.push(chunk);
  });
  return chunks;
}

function concatenated(parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** A deterministic PRNG (mulberry32), so a failing shape reproduces. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const STRING_ALPHABET = [
  "a",
  "Z",
  "0",
  " ",
  '"',
  "\\",
  "/",
  "\n",
  "\u0000",
  "\u001f",
  "\u007f",
  "é",
  " ",
  "中",
  "￿",
  "",
  "\u{1f600}",
  "\u{10ffff}",
];

const NUMBERS = [
  0,
  -0,
  1,
  -1,
  0.1,
  -1.5,
  2.5e-10,
  1e-7,
  123456789.125,
  5e-324,
  4503599627370495.5,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
];

function randomString(random: () => number, maxLength: number): string {
  const length = Math.floor(random() * (maxLength + 1));
  let text = "";
  for (let at = 0; at < length; at++)
    text += STRING_ALPHABET[Math.floor(random() * STRING_ALPHABET.length)];
  return text;
}

function randomValue(random: () => number, depth: number): unknown {
  const pick = Math.floor(random() * (depth > 0 ? 7 : 5));
  switch (pick) {
    case 0:
      return null;
    case 1:
      return random() < 0.5;
    case 2:
      return NUMBERS[Math.floor(random() * NUMBERS.length)];
    case 3:
      return Math.floor((random() - 0.5) * 2 ** 40) / 2 ** 7;
    case 4:
      return randomString(random, 12);
    case 5:
      return Array.from({ length: Math.floor(random() * 5) }, () =>
        randomValue(random, depth - 1),
      );
    default: {
      const members: Record<string, unknown> = {};
      const count = Math.floor(random() * 5);
      for (let at = 0; at < count; at++)
        members[randomString(random, 4)] = randomValue(random, depth - 1);
      return members;
    }
  }
}

function payloadOf(rowCount: number, cell: (row: number) => string | null) {
  return {
    columns: ["id", "name", "note"],
    rows: Array.from({ length: rowCount }, (_unused, row) => [
      String(row),
      cell(row),
      row % 7 === 0 ? null : "x",
    ]),
  } satisfies CommittedPayload;
}

const SHAPES: Array<{ name: string; value: unknown }> = [
  { name: "a top-level string", value: "a\u0000\u{1f600}" },
  { name: "a top-level number", value: -0 },
  { name: "a top-level null", value: null },
  { name: "a top-level boolean", value: false },
  { name: "an empty array", value: [] },
  { name: "an empty object", value: {} },
  { name: "nested empty containers", value: [[], {}, [[]], { a: [] }] },
  {
    name: "deep nesting",
    value: { a: [{ b: [{ c: [[[{ d: null }]]] }] }] },
  },
  { name: "numbers in their edge forms", value: NUMBERS },
  {
    name: "keys whose UTF-16 and code-point orders differ",
    value: {
      "": 1,
      "\u{1f600}": 2,
      "￿": 3,
      é: 4,
      a: 5,
      B: 6,
      "": 7,
      "\u0000": 8,
      aa: 9,
      "a\u0000": 10,
    },
  },
  {
    name: "a null-prototype object",
    value: Object.assign(Object.create(null) as object, { z: 1, a: [2] }),
  },
  { name: "escaped characters", value: ['"\\/\b\f\n\r\t\u0001 '] },
  {
    name: "a committed-payload shape",
    value: { domain: "d", data: payloadOf(3, (row) => `é${row}`) },
  },
];

describe("writeCanonicalBytes: the chunks concatenate to canonicalBytes", () => {
  test.each(vectors.filter((vector) => !vector.refuses))(
    "vector $name",
    (vector) => {
      if (vector.refuses) throw new Error("unreachable");
      const streamed = concatenated(chunksOf(vector.value));
      expect(toHex(streamed)).toBe(vector.bytesHex);
    },
  );

  test.each(SHAPES)("$name", ({ value }) => {
    expect(toHex(concatenated(chunksOf(value)))).toBe(
      toHex(canonicalBytes(value)),
    );
  });

  test("500 seeded random values", () => {
    const random = seededRandom(0x5eed);
    for (let at = 0; at < 500; at++) {
      const value = randomValue(random, 4);
      expect(toHex(concatenated(chunksOf(value)))).toBe(
        toHex(canonicalBytes(value)),
      );
    }
  });
});

describe("writeCanonicalBytes: content longer than one chunk", () => {
  const multibytePayload = payloadOf(
    20_000,
    (row) => `${"é中\u{1f600}".repeat(row % 5)}${row}`,
  );
  const flatNumbers = Array.from({ length: 100_000 }, (_unused, at) => at);
  const manyMembers = Object.fromEntries(
    Array.from({ length: 20_000 }, (_unused, at) => [`k${at}`, [at, "é"]]),
  );

  test.each([
    { name: "a payload of multi-byte cells", value: multibytePayload },
    { name: "a flat array of numbers", value: flatNumbers },
    { name: "an object of many members", value: manyMembers },
    {
      name: "an association-table shape",
      value: { domain: "d", data: [flatNumbers, flatNumbers] },
    },
  ])("$name splits into several chunks of whole characters", ({ value }) => {
    const chunks = chunksOf(value);
    expect(chunks.length).toBeGreaterThan(2);
    const strictDecoder = new TextDecoder("utf-8", { fatal: true });
    for (const chunk of chunks)
      expect(() => strictDecoder.decode(chunk)).not.toThrow();
    for (const chunk of chunks.slice(0, -1))
      expect(chunk.length).toBeGreaterThanOrEqual(CHUNK_CODE_UNITS);
    expect(toHex(concatenated(chunks))).toBe(toHex(canonicalBytes(value)));
  });

  test("a primitive longer than a chunk stays whole", () => {
    const long = "\u{1f600}".repeat(CHUNK_CODE_UNITS);
    const chunks = chunksOf(["a", long, "b"]);
    expect(new TextDecoder().decode(chunks[0])).toBe(`["a","${long}"`);
    expect(toHex(concatenated(chunks))).toBe(
      toHex(canonicalBytes(["a", long, "b"])),
    );
  });
});

describe("writeCanonicalBytes: refusals", () => {
  test.each(vectors.filter((vector) => vector.refuses))(
    "vector $name is refused before any write, with canonicalString's message",
    (vector) => {
      let expected: unknown;
      try {
        canonicalString(vector.value);
      } catch (error) {
        expected = error;
      }
      expect(expected).toBeInstanceOf(CanonicalEncodingError);
      let writes = 0;
      expect(() =>
        writeCanonicalBytes(vector.value, () => {
          writes++;
        }),
      ).toThrow((expected as Error).message);
      expect(writes).toBe(0);
    },
  );

  test("an out-of-domain value after many rows is refused before any write", () => {
    const rows: unknown[] = Array.from({ length: 50_000 }, (_unused, at) => [
      String(at),
    ]);
    rows.push([undefined]);
    let writes = 0;
    expect(() =>
      writeCanonicalBytes({ rows }, () => {
        writes++;
      }),
    ).toThrow(/\$\.rows\[50000\]\[0\]: unsupported value of type undefined/);
    expect(writes).toBe(0);
  });

  test("an error while encoding is a CanonicalEncodingError", () => {
    const trap = new Error("trap");
    const hostile = new Proxy(
      { a: 1 },
      {
        get(target, property) {
          if (property === "toJSON") return undefined;
          if (property === "a") throw trap;
          return Reflect.get(target, property);
        },
      },
    );
    let caught: unknown;
    try {
      chunksOf({ hostile });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CanonicalEncodingError);
    expect((caught as Error).cause).toBe(trap);
  });

  test("an error write throws reaches the caller unconverted", () => {
    const own = new Error("consumer");
    let caught: unknown;
    try {
      writeCanonicalBytes(
        Array.from({ length: 50_000 }, () => 1),
        () => {
          throw own;
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(own);
  });
});

describe("canonicalBytesPastStringCap equals canonicalBytes", () => {
  // 2-, 3- and 4-byte UTF-8 (the last a surrogate pair in UTF-16).
  const WIDE = ["\u00e9", "\u4e2d", "\u{1f600}"];
  // A filler string whose length moves the chunk boundary across the
  // elements after it, one code unit at a time.
  const boundaryCases = Array.from({ length: 24 }, (_unused, shift) => [
    "a".repeat(CHUNK_CODE_UNITS - 20 + shift),
    ...WIDE,
    `${WIDE.join("")}x`,
    `x${WIDE.join("")}`,
    ...WIDE.map((wide) => wide.repeat(3)),
  ]);

  test("chunk boundaries fall beside each width of character", () => {
    const strictDecoder = new TextDecoder("utf-8", { fatal: true });
    const before = new Set<string>();
    const after = new Set<string>();
    for (const value of boundaryCases) {
      const texts = chunksOf(value).map((chunk) => strictDecoder.decode(chunk));
      for (let at = 1; at < texts.length; at++) {
        const ending = [...texts[at - 1].slice(0, -1)].at(-1) ?? "";
        const starting = [...texts[at].slice(2)][0] ?? "";
        if (WIDE.includes(ending)) before.add(ending);
        if (WIDE.includes(starting)) after.add(starting);
      }
    }
    expect([...before].sort()).toEqual([...WIDE].sort());
    expect([...after].sort()).toEqual([...WIDE].sort());
  });

  test.each(boundaryCases.map((value, shift) => ({ shift, value })))(
    "multi-byte characters beside a chunk boundary, shift $shift",
    ({ value }) => {
      expect(toHex(canonicalBytesPastStringCap(value))).toBe(
        toHex(canonicalBytes(value)),
      );
    },
  );

  test("each width of character across several buffer growths", () => {
    // Rows whose widths differ, so the growth points land at varying
    // offsets within the characters' encodings.
    const value = payloadOf(30_000, (row) =>
      WIDE[row % 3].repeat(1 + (row % 11)),
    );
    const bytes = canonicalBytesPastStringCap(value);
    expect(bytes.length).toBeGreaterThan(8 * CHUNK_CODE_UNITS);
    expect(toHex(bytes)).toBe(toHex(canonicalBytes(value)));
  });

  test.each([
    ...vectors.filter((vector) => !vector.refuses),
    ...SHAPES.map(({ name, value }) => ({ name, value, bytesHex: undefined })),
  ])("$name", ({ value }) => {
    expect(toHex(canonicalBytesPastStringCap(value))).toBe(
      toHex(canonicalBytes(value)),
    );
  });

  test("a value outside the domain is refused", () => {
    expect(() => canonicalBytesPastStringCap({ a: undefined })).toThrow(
      CanonicalEncodingError,
    );
  });
});

describe("canonicalHmacSha256 equals the WebCrypto HMAC over canonicalBytes", () => {
  const keys = [1, 16, 32, 63, 64, 65, 200].map((length) =>
    Uint8Array.from({ length }, (_unused, at) => (at * 31 + length) & 0xff),
  );
  const values = [
    ...SHAPES.map(({ value }) => value),
    payloadOf(20_000, (row) => `\u00e9${row}\u{1f600}\u4e2d`),
    [
      "a".repeat(CHUNK_CODE_UNITS - 2),
      "\u{1f600}",
      "\u4e2d".repeat(CHUNK_CODE_UNITS),
      "\u00e9",
    ],
    vectors.filter((vector) => !vector.refuses).map((vector) => vector.value),
  ];

  test.each(keys.map((key) => ({ length: key.length, key })))(
    "under a key of $length bytes",
    async ({ key }) => {
      for (const value of values)
        expect(await canonicalHmacSha256(key, value)).toEqual(
          await hmacSha256(key, canonicalBytes(value)),
        );
    },
  );

  test("a value outside the domain is refused", async () => {
    await expect(
      canonicalHmacSha256(keys[3], { a: undefined }),
    ).rejects.toThrow(CanonicalEncodingError);
  });
});

describe("the record commitments and receipt payload MACs keep their values", () => {
  // The constructions as docs/spec/EXCHANGE_RECORD.md states them, computed
  // over the one-shot encoding: HMAC-SHA-256(salt, canonical {domain, data})
  // for a commitment; HMAC-SHA-256 under an HKDF key per direction over the
  // canonical committed payload for a receipt.
  const salt = Uint8Array.from({ length: 32 }, (_unused, at) => at + 1);
  const payload = payloadOf(5_000, (row) => `名前${row}`);
  const domains: Record<CommitmentName, string> = {
    associationTable: "alcove-commit-association-table/v2",
    localPayloadSent: "alcove-commit-payload-sent/v2",
    partnerPayloadReceived: "alcove-commit-payload-received/v2",
  };
  const associationTable = [
    Array.from({ length: 5_000 }, (_unused, at) => at),
    Array.from({ length: 5_000 }, (_unused, at) => at >> 3),
  ];

  test.each(Object.entries(domains) as Array<[CommitmentName, string]>)(
    "the %s commitment",
    async (name, domain) => {
      const data = name === "associationTable" ? associationTable : payload;
      expect(await computeCommitment(name, salt, data)).toEqual(
        await hmacSha256(salt, canonicalBytes({ domain, data })),
      );
    },
  );

  test("both directional payload MACs", async () => {
    const sessionKey = Uint8Array.from(
      { length: 32 },
      (_unused, at) => 255 - at,
    );
    const received = payloadOf(40, (row) => `r${row}`);
    const content = await buildReceiptContent(
      "initiator",
      "dGVybXM",
      payload,
      received,
      "YmluZGVy",
      sessionKey,
    );
    const label = "alcove-signed-receipt-payload-v2";
    const expectedMac = async (direction: string, data: CommittedPayload) =>
      toBase64Url(
        await hmacSha256(
          await hkdfDerive(sessionKey, `${label}:${direction}`, 32),
          canonicalBytes(data),
        ),
      );
    expect(content.initiatorToResponderPayload).toBe(
      await expectedMac("initiator-to-responder", payload),
    );
    expect(content.responderToInitiatorPayload).toBe(
      await expectedMac("responder-to-initiator", received),
    );
  });
});
