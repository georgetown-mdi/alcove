import { describe, expect, test } from "vitest";

import { MAX_DIRECTORY_ENTRIES } from "@alcove/core";

import {
  SFTP_MAX_HANDLE_BYTES,
  decodeReply,
  decodeVersion,
  encodeInit,
  encodeRequest,
} from "@psi/transport/browserSsh/sftp/sftpPacket";
import {
  SftpNameCountOverCapError,
  SftpProtocolError,
} from "@psi/transport/browserSsh/sftp/sftpErrors";

import { NO_ATTRS, T, concat, packet, str, u32, u64 } from "./sftpWire";

/** A packet's body: what follows its length. */
function body(bytes: Uint8Array): Uint8Array {
  return bytes.subarray(4);
}

describe("encode", () => {
  test("INIT names version 3", () => {
    expect(encodeInit()).toEqual(packet(T.init, u32(3)));
  });

  test("OPEN writes every attribute it is given, in protocol order", () => {
    expect(
      encodeRequest(7, {
        type: "open",
        path: "/a",
        flags: 0x1a,
        attributes: {
          size: 2 ** 33,
          uid: 501,
          gid: 20,
          permissions: 0o644,
          atime: 1,
          mtime: 2,
        },
      }),
    ).toEqual(
      packet(
        T.open,
        u32(7),
        str("/a"),
        u32(0x1a),
        u32(0x0f),
        u64(2 ** 33),
        u32(501),
        u32(20),
        u32(0o644),
        u32(1),
        u32(2),
      ),
    );
  });

  test("encodes a path as UTF-8", () => {
    expect(encodeRequest(1, { type: "stat", path: "/é" })).toEqual(
      packet(T.stat, u32(1), str(Uint8Array.of(0x2f, 0xc3, 0xa9))),
    );
  });

  test.each([-1, 0.5, 2 ** 53])("refuses an offset of %d", (offset) => {
    expect(() =>
      encodeRequest(1, {
        type: "read",
        handle: Uint8Array.of(1),
        offset,
        length: 1,
      }),
    ).toThrow(RangeError);
  });
});

describe("decodeVersion", () => {
  test("reads the version and each extension pair", () => {
    expect(
      decodeVersion(
        body(
          packet(
            T.version,
            u32(3),
            str("posix-rename@openssh.com"),
            str("1"),
            str("statvfs@openssh.com"),
            str("2"),
          ),
        ),
      ),
    ).toEqual({
      version: 3,
      extensions: [
        { name: "posix-rename@openssh.com", data: "1" },
        { name: "statvfs@openssh.com", data: "2" },
      ],
    });
  });

  test("refuses an extension cut short", () => {
    expect(() =>
      decodeVersion(body(packet(T.version, u32(3), str("x"), u32(5)))),
    ).toThrow(SftpProtocolError);
  });
});

describe("decodeReply", () => {
  test("reads a STATUS with its message, and one without, as early servers send", () => {
    expect(
      decodeReply(
        body(packet(T.status, u32(4), u32(2), str("No such file"), str("en"))),
      ),
    ).toEqual({ type: "status", id: 4, code: 2, message: "No such file" });
    expect(decodeReply(body(packet(T.status, u32(4), u32(0))))).toEqual({
      type: "status",
      id: 4,
      code: 0,
      message: "",
    });
  });

  test("reads ATTRS with every field, extended pairs included", () => {
    expect(
      decodeReply(
        body(
          packet(
            T.attrs,
            u32(1),
            u32(0x8000000f),
            u64(10),
            u32(501),
            u32(20),
            u32(0o100644),
            u32(100),
            u32(200),
            u32(1),
            str("vendor@example.com"),
            str(Uint8Array.of(1, 2)),
          ),
        ),
      ),
    ).toEqual({
      type: "attrs",
      id: 1,
      attributes: {
        size: 10,
        uid: 501,
        gid: 20,
        permissions: 0o100644,
        atime: 100,
        mtime: 200,
        extended: [{ type: "vendor@example.com", data: Uint8Array.of(1, 2) }],
      },
    });
  });

  test("reads a NAME of several entries, and of none", () => {
    expect(
      decodeReply(
        body(
          packet(
            T.name,
            u32(2),
            u32(2),
            str("a"),
            str("long a"),
            NO_ATTRS,
            str("b"),
            str("long b"),
            concat(u32(0x01), u64(3)),
          ),
        ),
      ),
    ).toEqual({
      type: "name",
      id: 2,
      entries: [
        { filename: "a", longname: "long a", attributes: {} },
        { filename: "b", longname: "long b", attributes: { size: 3 } },
      ],
    });
    expect(decodeReply(body(packet(T.name, u32(2), u32(0))))).toEqual({
      type: "name",
      id: 2,
      entries: [],
    });
  });

  test(`reads a NAME of exactly ${MAX_DIRECTORY_ENTRIES} entries`, () => {
    const entry = concat(str("f"), str(""), NO_ATTRS);
    const reply = decodeReply(
      body(
        packet(
          T.name,
          u32(2),
          u32(MAX_DIRECTORY_ENTRIES),
          ...Array.from({ length: MAX_DIRECTORY_ENTRIES }, () => entry),
        ),
      ),
    );
    expect(reply.type === "name" && reply.entries).toHaveLength(
      MAX_DIRECTORY_ENTRIES,
    );
  });

  test(`refuses a NAME declaring ${MAX_DIRECTORY_ENTRIES + 1} entries from its count, reading none`, () => {
    const overCap = (reply: Uint8Array) => {
      try {
        decodeReply(body(reply));
      } catch (error) {
        return error;
      }
      throw new Error("expected a refusal");
    };
    const entry = concat(str("f"), str(""), NO_ATTRS);
    const full = overCap(
      packet(
        T.name,
        u32(2),
        u32(MAX_DIRECTORY_ENTRIES + 1),
        ...Array.from({ length: MAX_DIRECTORY_ENTRIES + 1 }, () => entry),
      ),
    );
    expect(full).toBeInstanceOf(SftpNameCountOverCapError);
    expect(full).toMatchObject({
      declaredCount: MAX_DIRECTORY_ENTRIES + 1,
      maxCount: MAX_DIRECTORY_ENTRIES,
    });
    // No entry bytes follow the count, so the refusal can only come from it.
    expect(
      overCap(packet(T.name, u32(2), u32(MAX_DIRECTORY_ENTRIES + 1))),
    ).toBeInstanceOf(SftpNameCountOverCapError);
  });

  test("accepts a handle of the longest allowed length", () => {
    const handle = new Uint8Array(SFTP_MAX_HANDLE_BYTES).fill(1);
    expect(decodeReply(body(packet(T.handle, u32(1), str(handle))))).toEqual({
      type: "handle",
      id: 1,
      handle,
    });
  });

  test.each([
    {
      case: "a handle over 256 bytes",
      bytes: packet(
        T.handle,
        u32(1),
        str(new Uint8Array(SFTP_MAX_HANDLE_BYTES + 1)),
      ),
    },
    {
      case: "a string longer than the packet",
      bytes: packet(T.data, u32(1), u32(10), Uint8Array.of(1, 2)),
    },
    {
      case: "a name count the packet cannot hold",
      bytes: packet(T.name, u32(1), u32(MAX_DIRECTORY_ENTRIES), str("a")),
    },
    {
      case: "an extended attribute count the packet cannot hold",
      bytes: packet(T.attrs, u32(1), u32(0x80000000), u32(1000)),
    },
    {
      case: "a size past 2^53",
      bytes: packet(T.attrs, u32(1), u32(0x01), u64(0), Uint8Array.of()),
      patch: (bytes: Uint8Array) => bytes.fill(0xff, 13, 21),
    },
    {
      case: "bytes past the reply's fields",
      bytes: packet(T.handle, u32(1), str(Uint8Array.of(1)), Uint8Array.of(0)),
    },
    {
      case: "a type that is not a reply",
      bytes: packet(T.version, u32(3)),
    },
    {
      case: "a request type",
      bytes: packet(T.open, u32(1)),
    },
  ])("refuses $case", ({ bytes, patch }) => {
    patch?.(bytes);
    expect(() => decodeReply(body(bytes))).toThrow(SftpProtocolError);
  });
});
