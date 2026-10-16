import { describe, expect, test } from "vitest";
import { v4 as uuidv4 } from "uuid";

import {
  LOCK_SUFFIX,
  ackMarkerName,
  isMessageName,
  isProtocolGrammarName,
  legacyHelloWriterId,
  parseMessageByteCount,
  parseSizedControlName,
  parseTimestampedMessageNNN,
  peerIdFromControlName,
  sizedControlName,
  type SizedControlType,
} from "../../src/connection/fileSyncNames";
import {
  MAX_MESSAGE_SEQ,
  messageFilename,
} from "../../src/connection/fileSyncMessageLoop";
import {
  abortMarkerBody,
  abortMarkerName,
} from "../../src/connection/abortMarker";
import { helloEnvelope } from "../../src/connection/fileSyncRendezvous";
import { serializeEnvelope } from "../../src/connection/controlEnvelope";

const TYPES: SizedControlType[] = ["hello", "joining", "abort"];

// The one pattern an external mover matches a sized name with.
const SIZED_NAME = /-([0-9]+)\.json$/;

describe("peerIdFromControlName", () => {
  test("recovers the id ahead of each control type", () => {
    expect(peerIdFromControlName("alice-hello-48.json", "hello")).toBe("alice");
    expect(peerIdFromControlName("bob-joining-48.json", "joining")).toBe("bob");
    expect(peerIdFromControlName("carol-abort-67.json", "abort")).toBe("carol");
  });

  test("keeps an id that holds dashes, digits and a type word whole", () => {
    expect(peerIdFromControlName("site-7-a1b2-hello-48.json", "hello")).toBe(
      "site-7-a1b2",
    );
    expect(peerIdFromControlName("x-hello-hello-48.json", "hello")).toBe(
      "x-hello",
    );
  });

  test("is undefined for a bare type, never the empty id", () => {
    for (const type of TYPES)
      expect(peerIdFromControlName(`-${type}-48.json`, type)).toBeUndefined();
  });

  test("is undefined for another type, a message, or a name with no byte count", () => {
    expect(
      peerIdFromControlName("alice-hello-48.json", "joining"),
    ).toBeUndefined();
    expect(peerIdFromControlName("alice-100.json", "hello")).toBeUndefined();
    expect(peerIdFromControlName("alice-hello.json", "hello")).toBeUndefined();
    expect(
      peerIdFromControlName("alice-hello-48.json.tmp", "hello"),
    ).toBeUndefined();
  });
});

describe("the filename grammar", () => {
  const ids = [uuidv4(), "site", "site-2", "x-hello", "abort", "a-joining-b"];

  test("a sized control name is never a message name", () => {
    for (const id of ids)
      for (const type of TYPES)
        for (const bytes of [0, 1, 48, 1024]) {
          const name = sizedControlName(id, type, bytes);
          expect(parseSizedControlName(name)).toEqual({
            id,
            type,
            byteCount: bytes,
          });
          expect(isMessageName(name)).toBe(false);
        }
  });

  test("a message name the writer builds is never a sized control name", () => {
    // An untimestamped message is written only under a UUID id; a configured
    // id, which may end in a type word, requires the timestamp.
    for (const byteCount of [0, 10, 512 * 1024 * 1024]) {
      const untimestamped = messageFilename({
        id: uuidv4(),
        timestampInFilename: false,
        byteCount,
        seq: 0,
        ts: 0,
      });
      expect(isMessageName(untimestamped)).toBe(true);
      expect(parseSizedControlName(untimestamped)).toBeUndefined();
      for (const id of ids)
        for (const seq of [0, 7, MAX_MESSAGE_SEQ]) {
          const timestamped = messageFilename({
            id,
            timestampInFilename: true,
            byteCount,
            seq,
            ts: Date.UTC(2026, 0, 2, 3, 4, 5),
          });
          expect(isMessageName(timestamped)).toBe(true);
          expect(parseSizedControlName(timestamped)).toBeUndefined();
        }
    }
  });

  test("zero-length control names have no byte count and are neither kind", () => {
    const peerHello = sizedControlName("bob", "hello", 48);
    const zeroLength = [
      `alice-bob${LOCK_SUFFIX}`,
      ackMarkerName("alice", peerHello.slice(0, -".json".length)),
      ackMarkerName("alice", "bob-20260102T030405-007-99"),
    ];
    for (const name of zeroLength) {
      expect(parseMessageByteCount(name)).toBeUndefined();
      expect(isMessageName(name)).toBe(false);
      expect(parseSizedControlName(name)).toBeUndefined();
      expect(isProtocolGrammarName(name)).toBe(true);
    }
  });

  test("every sized control name and message name matches the one mover pattern", () => {
    const names = [
      ...TYPES.map((type) => sizedControlName("x-hello", type, 48)),
      messageFilename({
        id: uuidv4(),
        timestampInFilename: false,
        byteCount: 77,
        seq: 0,
        ts: 0,
      }),
    ];
    for (const name of names)
      expect(Number(SIZED_NAME.exec(name)?.[1])).toBe(
        parseMessageByteCount(name),
      );
  });
});

describe("the names a party writes state the size of their body", () => {
  test("the hello and joining sentinel in each mode", () => {
    for (const [flags, bytes] of [
      [{ locklessRendezvous: false, retainFiles: false }, 48],
      [{ locklessRendezvous: true, retainFiles: false }, 47],
      [{ locklessRendezvous: true, retainFiles: true }, 46],
    ] as const) {
      expect(serializeEnvelope(helloEnvelope(flags)).length).toBe(bytes);
      for (const type of ["hello", "joining"] as const)
        expect(sizedControlName("alice", type, bytes)).toBe(
          `alice-${type}-${bytes}.json`,
        );
    }
  });

  test("the abort marker", () => {
    const token = new Uint8Array(32).fill(7);
    const name = abortMarkerName("alice", token);
    expect(parseSizedControlName(name)).toEqual({
      id: "alice",
      type: "abort",
      byteCount: abortMarkerBody(token).length,
    });
  });
});

describe("names an earlier version wrote, with no byte count", () => {
  test("stay protocol-grammar names, so entry refuses or sweeps them", () => {
    for (const name of [
      "alice-hello.json",
      "alice-joining.json",
      "alice-abort.json",
    ]) {
      expect(isProtocolGrammarName(name)).toBe(true);
      expect(isMessageName(name)).toBe(false);
      expect(parseSizedControlName(name)).toBeUndefined();
    }
  });

  test("a legacy hello is recognized by its writer id, never a bare one", () => {
    expect(legacyHelloWriterId("alice-hello.json")).toBe("alice");
    expect(legacyHelloWriterId("-hello.json")).toBeUndefined();
    expect(legacyHelloWriterId("alice-hello-48.json")).toBeUndefined();
  });
});

describe("parseTimestampedMessageNNN", () => {
  test("reads the counter of a timestamped message name", () => {
    const name = messageFilename({
      id: "peer",
      timestampInFilename: true,
      byteCount: 42,
      seq: 7,
      ts: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    expect(parseTimestampedMessageNNN(name)).toBe(7);
  });

  test("misreads a digit id segment of an untimestamped name as a counter", () => {
    const name = messageFilename({
      id: "site-12",
      timestampInFilename: false,
      byteCount: 42,
      seq: 0,
      ts: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    expect(name).toBe("site-12-42.json");
    expect(parseTimestampedMessageNNN(name)).toBe(12);
  });
});
