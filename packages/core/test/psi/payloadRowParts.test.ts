import { afterEach, describe, expect, test, vi } from "vitest";

import { MAX_PAYLOAD_ENTRIES } from "../../src/config/linkageTermsSchema";
import { ConnectionError, InternalConsistencyError } from "../../src/errors";
import { joinPayloadParts } from "../../src/payloadExchange";
import {
  MATCHED_LIST_PART_HEADER_BYTES,
  matchedListParts,
  type ListPartContext,
} from "../../src/psi/matchedListParts";
import {
  NULL_VALUE_LENGTH,
  PAYLOAD_LENGTH_REFUSAL,
  PAYLOAD_ROWS_TAG,
  isWellFormedUtf8,
  payloadRowsSource,
  readPayloadPartBody,
  type PayloadRowsToSend,
} from "../../src/psi/payloadRowParts";
import { payloadBody } from "../utils/matchedListPartFrames";
import { plainPayload } from "../utils/plainPayload";

// The body of a payload part: its exact bytes, the payloads that round-trip
// through it, and every body a receiver refuses before it allocates anything
// for the part's rows (docs/spec/PROTOCOL.md, "The payload part body").

function context(remainingEntries: number): ListPartContext {
  return {
    remainingEntries,
    refuse: (detail) => new ConnectionError(detail, "protocol"),
  };
}

// The bodies of the parts `payload` is sent in, each at most `bodyBytes` long.
function sentBodies(
  payload: PayloadRowsToSend,
  bodyBytes = 1 << 20,
): Array<Uint8Array> {
  return [...matchedListParts(payloadRowsSource(payload), bodyBytes)].map(
    (part) => part.subarray(MATCHED_LIST_PART_HEADER_BYTES),
  );
}

function roundTrip(payload: PayloadRowsToSend, bodyBytes?: number) {
  let remaining = payload.rows.length;
  const parts = sentBodies(payload, bodyBytes).map((body) => {
    const part = readPayloadPartBody(body, context(remaining));
    remaining -= part.rows.length;
    return part;
  });
  return { parts, received: plainPayload(joinPayloadParts(parts)) };
}

// Little-endian bytes of `words`.
function words(values: ReadonlyArray<number>): Array<number> {
  const bytes = new Uint8Array(4 * values.length);
  const view = new DataView(bytes.buffer);
  values.forEach((value, k) => view.setUint32(4 * k, value, true));
  return [...bytes];
}

const utf8 = (text: string): Array<number> => [
  ...new TextEncoder().encode(text),
];

// What `run` returns or throws, and every allocation it makes for a part's
// rows: each Uint32Array's length, each byte copy, and each decoded string.
function allocations(run: () => unknown): {
  outcome: unknown;
  made: Array<string>;
} {
  const made: Array<string> = [];
  const real = globalThis.Uint32Array;
  globalThis.Uint32Array = new Proxy(real, {
    construct(target, args: Array<unknown>) {
      made.push(`Uint32Array(${String(args[0])})`);
      return Reflect.construct(target, args) as object;
    },
  }) as Uint32ArrayConstructor;
  const realSlice = Uint8Array.prototype.slice;
  const slice = vi
    .spyOn(Uint8Array.prototype, "slice")
    .mockImplementation(function (
      this: Uint8Array,
      start?: number,
      end?: number,
    ) {
      made.push("slice");
      return realSlice.call(this, start, end);
    });
  const decode = vi.spyOn(TextDecoder.prototype, "decode");
  let outcome: unknown;
  try {
    outcome = run();
  } catch (error) {
    outcome = error;
  } finally {
    globalThis.Uint32Array = real;
    slice.mockRestore();
  }
  for (let k = 0; k < decode.mock.calls.length; k++) made.push("decode");
  decode.mockRestore();
  return { outcome, made };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the bytes a payload part holds", () => {
  test("a row of a text value and a null, after the column names and row index", () => {
    const [body] = sentBodies({
      columns: ["id", "é"],
      rowIndices: [7],
      rows: [["P1", null]],
    });
    expect([...body]).toStrictEqual([
      ...words([PAYLOAD_ROWS_TAG, 1, 2]),
      ...words([2]),
      ...utf8("id"),
      ...words([2]),
      ...utf8("é"),
      ...words([7]),
      ...words([2]),
      ...utf8("P1"),
      ...words([NULL_VALUE_LENGTH]),
    ]);
  });

  test("a payload with no data is one part naming no column and holding no row", () => {
    expect(
      sentBodies({ columns: [], rowIndices: [], rows: [] }).map((body) => [
        ...body,
      ]),
    ).toStrictEqual([words([PAYLOAD_ROWS_TAG, 0, 0])]);
  });

  test("the test builder writes the bytes the sender writes", () => {
    const payload = {
      columns: ["a", "b"],
      rowIndices: [3, 1],
      rows: [
        ["x", ""],
        [null, "😀"],
      ],
    };
    expect([...sentBodies(payload)[0]]).toStrictEqual([
      ...payloadBody({ hasData: true, ...payload }),
    ]);
  });
});

describe("a payload round-trips", () => {
  test.each([
    ["empty values", [[""], [""]]],
    ["null values", [[null], [null]]],
    ["multi-byte UTF-8", [["é"], ["€"], ["😀"], ["日本語"]]],
    ["a leading byte-order mark", [["\ufeffx"]]],
    ["a NUL and line breaks", [["a\u0000b\r\nc"]]],
  ] as Array<[string, Array<Array<string | null>>]>)("%s", (_name, rows) => {
    const payload = {
      columns: ["c"],
      rowIndices: rows.map((_, i) => i),
      rows,
    };
    expect(roundTrip(payload).received).toStrictEqual(payload);
  });

  test("a payload past one part's bytes, cut into parts and joined", () => {
    const payload = {
      columns: ["note", "code"],
      rowIndices: Array.from({ length: 50 }, (_, i) => 0xffff_ffff - i),
      rows: Array.from({ length: 50 }, (_, i) => [
        `note ${i} ${"é".repeat(i % 5)}`,
        i % 3 === 0 ? null : String(i),
      ]),
    };
    const { parts, received } = roundTrip(payload, 200);
    expect(parts.length).toBeGreaterThan(2);
    expect(received).toStrictEqual(payload);
  });

  test("the rows read keep a copy of their bytes, not the part's", () => {
    const [body] = sentBodies({
      columns: ["c"],
      rowIndices: [0],
      rows: [["value"]],
    });
    const part = readPayloadPartBody(body, context(1));
    body.fill(0);
    expect(part.rows.row(0)).toStrictEqual(["value"]);
  });

  test("a row outside the rows read is refused", () => {
    const part = readPayloadPartBody(
      sentBodies({ columns: ["c"], rowIndices: [0], rows: [["v"]] })[0],
      context(1),
    );
    expect(() => part.rows.row(1)).toThrow(InternalConsistencyError);
  });
});

describe("a payload the sender refuses before it builds a part", () => {
  test.each([
    [
      "a row of the wrong width",
      { columns: ["a", "b"], rowIndices: [0], rows: [["x"]] },
      "a payload row does not have one value per column",
    ],
    [
      "a negative row index",
      { columns: ["a"], rowIndices: [-1], rows: [["x"]] },
      "a payload row index of -1 is not an unsigned 32-bit whole number",
    ],
    [
      "a row index past 32 bits",
      { columns: ["a"], rowIndices: [2 ** 32], rows: [["x"]] },
      "a payload row index of 4294967296 is not an unsigned 32-bit whole number",
    ],
    [
      "a value holding a lone surrogate",
      { columns: ["a"], rowIndices: [0], rows: [["x\ud800"]] },
      "a payload value holds an unpaired UTF-16 surrogate, which has no UTF-8 encoding",
    ],
    [
      "a column name holding a lone surrogate",
      { columns: ["\udc00"], rowIndices: [0], rows: [["x"]] },
      "a payload value holds an unpaired UTF-16 surrogate, which has no UTF-8 encoding",
    ],
    [
      "more columns than a payload sends",
      {
        columns: Array.from(
          { length: MAX_PAYLOAD_ENTRIES + 1 },
          (_, i) => `c${i}`,
        ),
        rowIndices: [],
        rows: [],
      },
      `a payload of ${MAX_PAYLOAD_ENTRIES + 1} columns is over the ` +
        `${MAX_PAYLOAD_ENTRIES} a payload sends`,
    ],
  ] as Array<[string, PayloadRowsToSend, string]>)(
    "%s",
    (_name, payload, message) => {
      expect(() => sentBodies(payload)).toThrow(
        new InternalConsistencyError(message),
      );
    },
  );
});

describe("a body refused before anything is allocated for its rows", () => {
  const prefix = (rows: number, columns: number) =>
    words([PAYLOAD_ROWS_TAG, rows, columns]);
  const name = [...words([1]), ...utf8("c")];

  test.each([
    [
      "shorter than its prefix",
      words([PAYLOAD_ROWS_TAG, 1]),
      1,
      PAYLOAD_LENGTH_REFUSAL,
    ],
    [
      "of a word list's tag",
      [...words([1, 1, 1]), ...name],
      1,
      "is not a list of the kind awaited",
    ],
    [
      "of more rows than the list has still to send",
      [...prefix(3, 1), ...name],
      2,
      "runs past the list's declared entries",
    ],
    [
      "naming more columns than a payload sends",
      prefix(0, MAX_PAYLOAD_ENTRIES + 1),
      0,
      `names more than ${MAX_PAYLOAD_ENTRIES} columns`,
    ],
    [
      "holding rows but naming no column",
      [...prefix(1, 0), ...words([0])],
      1,
      "names no column",
    ],
    [
      "declaring a value length past the frame's end",
      [...prefix(1, 1), ...name, ...words([0, 0xffff_fff0]), ...utf8("x")],
      1,
      PAYLOAD_LENGTH_REFUSAL,
    ],
    [
      "declaring a value length one past the frame's end",
      [...prefix(1, 1), ...name, ...words([0, 2]), ...utf8("x")],
      1,
      PAYLOAD_LENGTH_REFUSAL,
    ],
    [
      "declaring a column name length past the frame's end",
      [...prefix(0, 1), ...words([0xffff_fff0])],
      0,
      PAYLOAD_LENGTH_REFUSAL,
    ],
    [
      "cut inside a value's length",
      [...prefix(1, 1), ...name, ...words([0]), 1, 0],
      1,
      PAYLOAD_LENGTH_REFUSAL,
    ],
    [
      "stating the most rows a count can hold",
      [...prefix(0xffff_ffff, 1), ...name, ...words([0])],
      0xffff_ffff,
      PAYLOAD_LENGTH_REFUSAL,
    ],
    [
      "holding bytes past its last value",
      [...prefix(1, 1), ...name, ...words([0, 0]), 0],
      1,
      PAYLOAD_LENGTH_REFUSAL,
    ],
    [
      "holding a value that is not UTF-8",
      [...prefix(1, 1), ...name, ...words([0, 3]), 0xed, 0xa0, 0x80],
      1,
      "holds a value that is not UTF-8 text",
    ],
    [
      "naming an empty column",
      [...prefix(0, 1), ...words([0])],
      0,
      "names a column outside 1 to 256 characters",
    ],
    [
      "naming a null column",
      [...prefix(0, 1), ...words([NULL_VALUE_LENGTH])],
      0,
      "names a column outside 1 to 256 characters",
    ],
    [
      "naming a column longer than any name's bytes",
      [...prefix(0, 1), ...words([769]), ...new Array<number>(769).fill(0x61)],
      0,
      "names a column outside 1 to 256 characters",
    ],
  ] as Array<[string, Array<number>, number, string]>)(
    "%s",
    (_name, bytes, remaining, detail) => {
      const { outcome, made } = allocations(() =>
        readPayloadPartBody(Uint8Array.from(bytes), context(remaining)),
      );
      expect(outcome).toBeInstanceOf(ConnectionError);
      expect((outcome as Error).message).toBe(detail);
      expect(made).toStrictEqual([]);
    },
  );

  test("a column name over the character bound is refused before any row is", () => {
    const { outcome, made } = allocations(() =>
      readPayloadPartBody(
        Uint8Array.from([
          ...words([PAYLOAD_ROWS_TAG, 1, 1, 257]),
          ...new Array<number>(257).fill(0x61),
          ...words([0, 0]),
        ]),
        context(1),
      ),
    );
    expect((outcome as Error).message).toBe(
      "names a column outside 1 to 256 characters",
    );
    expect(made).toStrictEqual(["decode"]);
  });

  test("a body whose lengths match its bytes allocates only what its rows hold", () => {
    const body = Uint8Array.from([
      ...words([PAYLOAD_ROWS_TAG, 2, 1]),
      ...words([1]),
      ...utf8("c"),
      ...words([4, 9]),
      ...words([1]),
      ...utf8("x"),
      ...words([NULL_VALUE_LENGTH]),
    ]);
    const { outcome, made } = allocations(() =>
      readPayloadPartBody(body, context(2)),
    );
    expect(outcome).not.toBeInstanceOf(Error);
    expect(made).toStrictEqual([
      "Uint32Array(2)",
      "slice",
      "Uint32Array(2)",
      "decode",
    ]);
  });
});

describe("the UTF-8 check", () => {
  const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const decodes = (bytes: Uint8Array): boolean => {
    try {
      strict.decode(bytes);
      return true;
    } catch {
      return false;
    }
  };

  test.each([
    [[0x41], true],
    [[0xc2, 0x80], true],
    [[0xc1, 0xbf], false],
    [[0xe0, 0x9f, 0x80], false],
    [[0xe0, 0xa0, 0x80], true],
    [[0xed, 0x9f, 0xbf], true],
    [[0xed, 0xa0, 0x80], false],
    [[0xef, 0xbb, 0xbf], true],
    [[0xf0, 0x8f, 0xbf, 0xbf], false],
    [[0xf0, 0x90, 0x80, 0x80], true],
    [[0xf4, 0x8f, 0xbf, 0xbf], true],
    [[0xf4, 0x90, 0x80, 0x80], false],
    [[0xf5, 0x80, 0x80, 0x80], false],
    [[0x80], false],
    [[0xe2, 0x82], false],
    [[0xe2, 0x41, 0xac], false],
  ])("%j is well-formed: %s", (bytes, expected) => {
    const array = Uint8Array.from(bytes);
    expect(isWellFormedUtf8(array, 0, array.length)).toBe(expected);
    expect(decodes(array)).toBe(expected);
  });

  test("agrees with a strict decoder on random bytes", () => {
    let seed = 0x2545f491;
    const next = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    const alphabet = [
      0x00, 0x41, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xc2, 0xdf,
      0xe0, 0xe1, 0xed, 0xef, 0xf0, 0xf1, 0xf4, 0xf5, 0xff,
    ];
    for (let trial = 0; trial < 20_000; trial++) {
      const bytes = Uint8Array.from(
        { length: 1 + (next() % 6) },
        () => alphabet[next() % alphabet.length],
      );
      expect(isWellFormedUtf8(bytes, 0, bytes.length)).toBe(decodes(bytes));
    }
  });
});
