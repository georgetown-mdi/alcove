import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  SFTP_MAX_INBOUND_PACKET_LENGTH,
  SFTP_MAX_OUTBOUND_PACKET_LENGTH,
  SFTP_MAX_READ_BYTES,
  SftpClient,
} from "@psi/transport/browserSsh/sftp/sftpClient";
import {
  SftpFailureError,
  SftpNoSuchFileError,
  SftpOperationUnsupportedError,
  SftpPacketTooLargeError,
  SftpPermissionDeniedError,
  SftpProtocolError,
  SftpSessionClosedError,
  SftpStatusError,
} from "@psi/transport/browserSsh/sftp/sftpErrors";
import { SftpOpenFlags } from "@psi/transport/browserSsh/sftp/sftpPacket";

import {
  NO_ATTRS,
  T,
  concat,
  dataPacket,
  handlePacket,
  packet,
  statusPacket,
  str,
  u32,
  u64,
  versionPacket,
} from "./sftpWire";
import { FakeSftpChannel } from "./fakeSftpChannel";

import type { SftpClient as SftpClientType } from "@psi/transport/browserSsh/sftp/sftpClient";

const HANDLE = Uint8Array.of(0, 0, 0, 7);

/** Unhandled rejections seen while a case runs. */
let unhandled: Array<unknown>;
const recordUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", recordUnhandled);
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.off("unhandledRejection", recordUnhandled);
  expect(unhandled).toEqual([]);
});

async function startClient(): Promise<{
  channel: FakeSftpChannel;
  client: SftpClientType;
}> {
  const channel = new FakeSftpChannel();
  const starting = SftpClient.start(channel);
  channel.deliver(versionPacket(3));
  const client = await starting;
  channel.sent.length = 0;
  return { channel, client };
}

/** Let the client's sends run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

describe("SftpClient start", () => {
  test("sends INIT version 3 and resolves on VERSION 3, keeping its extensions", async () => {
    const channel = new FakeSftpChannel();
    const starting = SftpClient.start(channel);
    expect(channel.sent).toEqual([
      Uint8Array.of(0, 0, 0, 5, T.init, 0, 0, 0, 3),
    ]);
    channel.deliver(versionPacket(3, [["limits@openssh.com", "1"]]));
    const client = await starting;
    expect(client.version).toEqual({
      version: 3,
      extensions: [{ name: "limits@openssh.com", data: "1" }],
    });
  });

  test.each([
    { case: "a later version", reply: versionPacket(4) },
    { case: "a reply before VERSION", reply: statusPacket(1, 0) },
  ])("refuses $case and closes the channel", async ({ reply }) => {
    const channel = new FakeSftpChannel();
    const starting = SftpClient.start(channel);
    channel.deliver(reply);
    expect(await failure(starting)).toBeInstanceOf(SftpProtocolError);
    expect(channel.closeCalls).toBe(1);
    expect(channel.listenerCount).toBe(0);
  });

  test("rejects when the channel closes before VERSION", async () => {
    const channel = new FakeSftpChannel();
    const starting = SftpClient.start(channel);
    channel.closeFromServer();
    expect(await failure(starting)).toBeInstanceOf(SftpSessionClosedError);
  });

  test("rejects on a channel already closed, sending nothing", async () => {
    const channel = new FakeSftpChannel();
    channel.isClosed = true;
    expect(await failure(SftpClient.start(channel))).toBeInstanceOf(
      SftpSessionClosedError,
    );
    expect(channel.sent).toEqual([]);
  });
});

describe("SftpClient requests", () => {
  const cases: Array<{
    name: string;
    call: (client: SftpClientType) => Promise<unknown>;
    request: Uint8Array;
    reply: Uint8Array;
    value: unknown;
  }> = [
    {
      name: "open",
      call: (client) =>
        client.open(
          "/srv/a.json",
          SftpOpenFlags.write | SftpOpenFlags.create | SftpOpenFlags.exclusive,
          { permissions: 0o600 },
        ),
      request: packet(
        T.open,
        u32(1),
        str("/srv/a.json"),
        u32(0x2a),
        u32(0x04),
        u32(0o600),
      ),
      reply: handlePacket(1, HANDLE),
      value: HANDLE,
    },
    {
      name: "close",
      call: (client) => client.close(HANDLE),
      request: packet(T.close, u32(1), str(HANDLE)),
      reply: statusPacket(1, 0, "Success"),
      value: undefined,
    },
    {
      name: "read",
      call: (client) => client.read(HANDLE, 2 ** 40, 4),
      request: packet(T.read, u32(1), str(HANDLE), u64(2 ** 40), u32(4)),
      reply: dataPacket(1, Uint8Array.of(1, 2, 3)),
      value: Uint8Array.of(1, 2, 3),
    },
    {
      name: "write",
      call: (client) => client.write(HANDLE, 65_536, Uint8Array.of(9, 8)),
      request: packet(
        T.write,
        u32(1),
        str(HANDLE),
        u64(65_536),
        str(Uint8Array.of(9, 8)),
      ),
      reply: statusPacket(1, 0),
      value: undefined,
    },
    {
      name: "opendir",
      call: (client) => client.opendir("/srv"),
      request: packet(T.opendir, u32(1), str("/srv")),
      reply: handlePacket(1, HANDLE),
      value: HANDLE,
    },
    {
      name: "readdir",
      call: (client) => client.readdir(HANDLE),
      request: packet(T.readdir, u32(1), str(HANDLE)),
      reply: packet(
        T.name,
        u32(1),
        u32(1),
        str("a.json"),
        str("-rw------- 1 u g 2 Jan 1 00:00 a.json"),
        u32(0x01),
        u64(2),
      ),
      value: [
        {
          filename: "a.json",
          longname: "-rw------- 1 u g 2 Jan 1 00:00 a.json",
          attributes: { size: 2 },
        },
      ],
    },
    {
      name: "remove",
      call: (client) => client.remove("/srv/a.json"),
      request: packet(T.remove, u32(1), str("/srv/a.json")),
      reply: statusPacket(1, 0),
      value: undefined,
    },
    {
      name: "rename",
      call: (client) => client.rename("/srv/a.tmp", "/srv/a.json"),
      request: packet(T.rename, u32(1), str("/srv/a.tmp"), str("/srv/a.json")),
      reply: statusPacket(1, 0),
      value: undefined,
    },
    {
      name: "stat",
      call: (client) => client.stat("/srv/a.json"),
      request: packet(T.stat, u32(1), str("/srv/a.json")),
      reply: packet(T.attrs, u32(1), u32(0x05), u64(12), u32(0o100600)),
      value: { size: 12, permissions: 0o100600 },
    },
    {
      name: "realpath",
      call: (client) => client.realpath("."),
      request: packet(T.realpath, u32(1), str(".")),
      reply: packet(T.name, u32(1), u32(1), str("/home/u"), str(""), NO_ATTRS),
      value: "/home/u",
    },
  ];

  test.each(cases)(
    "$name sends its request and resolves with the reply",
    async ({ call, request, reply, value }) => {
      const { channel, client } = await startClient();
      const pending = call(client);
      await settle();
      expect(channel.sent).toEqual([request]);
      channel.deliver(reply);
      expect(await pending).toEqual(value);
    },
  );

  test.each([
    {
      name: "read",
      call: (client: SftpClientType) => client.read(HANDLE, 0, 8),
    },
    {
      name: "readdir",
      call: (client: SftpClientType) => client.readdir(HANDLE),
    },
  ])("$name resolves null at EOF", async ({ call }) => {
    const { channel, client } = await startClient();
    const pending = call(client);
    channel.deliver(statusPacket(1, 1, "End of file"));
    expect(await pending).toBeNull();
  });

  test.each([
    { code: 2, named: SftpNoSuchFileError },
    { code: 3, named: SftpPermissionDeniedError },
    { code: 4, named: SftpFailureError },
    { code: 8, named: SftpOperationUnsupportedError },
    { code: 5, named: SftpStatusError },
    { code: 1, named: SftpStatusError },
  ])(
    "status $code rejects with $named.name and the session continues",
    async ({ code, named }) => {
      const { channel, client } = await startClient();
      const refused = client.stat("/srv/x");
      channel.deliver(statusPacket(1, code, "server text"));
      const error = await failure(refused);
      expect(error).toBeInstanceOf(named);
      expect(error).toMatchObject({
        code,
        serverMessage: "server text",
        operation: { name: "stat", path: "/srv/x" },
      });
      const next = client.remove("/srv/y");
      channel.deliver(statusPacket(2, 0));
      await expect(next).resolves.toBeUndefined();
    },
  );

  test("matches overlapping requests to replies by id, in any order", async () => {
    const { channel, client } = await startClient();
    const first = client.stat("/a");
    const second = client.stat("/b");
    channel.deliver(
      packet(T.attrs, u32(2), u32(0x01), u64(2)),
      packet(T.attrs, u32(1), u32(0x01), u64(1)),
    );
    expect(await first).toEqual({ size: 1 });
    expect(await second).toEqual({ size: 2 });
  });

  test("refuses a read past the largest it sends, sending nothing", async () => {
    const { channel, client } = await startClient();
    await expect(
      client.read(HANDLE, 0, SFTP_MAX_READ_BYTES + 1),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(client.read(HANDLE, 0, 0)).rejects.toBeInstanceOf(RangeError);
    expect(channel.sent).toEqual([]);
  });

  test("refuses a request over the packet length a server accepts, sending nothing", async () => {
    const { channel, client } = await startClient();
    await expect(
      client.write(HANDLE, 0, new Uint8Array(SFTP_MAX_OUTBOUND_PACKET_LENGTH)),
    ).rejects.toBeInstanceOf(RangeError);
    await settle();
    expect(channel.sent).toEqual([]);
  });
});

describe("SftpClient packet reassembly", () => {
  test("reads a packet delivered one byte at a time", async () => {
    const { channel, client } = await startClient();
    const pending = client.read(HANDLE, 0, 3);
    for (const byte of dataPacket(1, Uint8Array.of(1, 2, 3)))
      channel.deliver(Uint8Array.of(byte));
    expect(await pending).toEqual(Uint8Array.of(1, 2, 3));
  });

  test("reads several packets packed into one data event", async () => {
    const { channel, client } = await startClient();
    const reads = [1, 2, 3].map(() => client.read(HANDLE, 0, 1));
    const packed = concat(
      dataPacket(1, Uint8Array.of(1)),
      dataPacket(2, Uint8Array.of(2)),
      dataPacket(3, Uint8Array.of(3)),
    );
    channel.deliver(packed.subarray(0, 20), packed.subarray(20));
    expect(await Promise.all(reads)).toEqual([
      Uint8Array.of(1),
      Uint8Array.of(2),
      Uint8Array.of(3),
    ]);
  });

  test("returns each data event's length to the channel window", async () => {
    const { channel, client } = await startClient();
    channel.adjusted.length = 0;
    const pending = client.read(HANDLE, 0, 3);
    const reply = dataPacket(1, Uint8Array.of(1, 2, 3));
    channel.deliver(reply.subarray(0, 6), reply.subarray(6));
    await pending;
    expect(channel.adjusted).toEqual([6, reply.length - 6]);
  });

  test("accepts a DATA reply to the largest read, the cap's own length", async () => {
    const { channel, client } = await startClient();
    const pending = client.read(HANDLE, 0, SFTP_MAX_READ_BYTES);
    const reply = dataPacket(1, new Uint8Array(SFTP_MAX_READ_BYTES).fill(5));
    expect(new DataView(reply.buffer).getUint32(0)).toBe(
      SFTP_MAX_INBOUND_PACKET_LENGTH,
    );
    channel.deliver(reply);
    expect((await pending)?.length).toBe(SFTP_MAX_READ_BYTES);
  });

  test.each([SFTP_MAX_INBOUND_PACKET_LENGTH + 1, 0xffffffff])(
    "refuses a declared length of %i on its four length bytes alone",
    async (declared) => {
      const { channel, client } = await startClient();
      channel.adjusted.length = 0;
      const pending = client.read(HANDLE, 0, 8);
      channel.deliver(u32(declared));
      const error = await failure(pending);
      expect(error).toBeInstanceOf(SftpPacketTooLargeError);
      expect(error).toMatchObject({
        declaredLength: declared,
        maxLength: SFTP_MAX_INBOUND_PACKET_LENGTH,
      });
      expect(await client.ended).toBe(error);
      expect(channel.closeCalls).toBe(1);
      expect(channel.adjusted).toEqual([]);
    },
  );
});

describe("SftpClient refusals that end the session", () => {
  test("refuses a reply to an id never sent", async () => {
    const { channel, client } = await startClient();
    const outstanding = client.stat("/a");
    channel.deliver(statusPacket(9, 0));
    const error = await failure(outstanding);
    expect(error).toBeInstanceOf(SftpProtocolError);
    expect((error as SftpProtocolError).detail).toMatch(/request 9/);
    expect(await client.ended).toBe(error);
    expect(channel.closeCalls).toBe(1);
  });

  test("refuses a second reply to an id already answered", async () => {
    const { channel, client } = await startClient();
    const answered = client.remove("/a");
    const outstanding = client.stat("/b");
    channel.deliver(statusPacket(1, 0));
    await expect(answered).resolves.toBeUndefined();
    channel.deliver(statusPacket(1, 0));
    expect(await failure(outstanding)).toBeInstanceOf(SftpProtocolError);
    const later = await failure(client.stat("/c"));
    expect(later).toBeInstanceOf(SftpSessionClosedError);
    expect((later as Error).cause).toBeInstanceOf(SftpProtocolError);
  });

  test.each([
    {
      case: "a reply type the request never draws",
      call: (client: SftpClientType) => client.close(HANDLE),
      reply: handlePacket(1, HANDLE),
    },
    {
      case: "status OK where a handle is due",
      call: (client: SftpClientType) => client.open("/a", SftpOpenFlags.read),
      reply: statusPacket(1, 0),
    },
    {
      case: "more data than the read asked for",
      call: (client: SftpClientType) => client.read(HANDLE, 0, 2),
      reply: dataPacket(1, Uint8Array.of(1, 2, 3)),
    },
    {
      case: "a path lookup answered with two names",
      call: (client: SftpClientType) => client.realpath("."),
      reply: packet(
        T.name,
        u32(1),
        u32(2),
        str("/a"),
        str(""),
        NO_ATTRS,
        str("/b"),
        str(""),
        NO_ATTRS,
      ),
    },
    {
      case: "a packet too short for a type and id",
      call: (client: SftpClientType) => client.stat("/a"),
      reply: concat(u32(4), Uint8Array.of(T.status, 0, 0, 0)),
    },
    {
      case: "a malformed reply",
      call: (client: SftpClientType) => client.stat("/a"),
      reply: packet(T.attrs, u32(1), u32(0x01), u32(0)),
    },
  ])("refuses $case", async ({ call, reply }) => {
    const { channel, client } = await startClient();
    const pending = call(client);
    const bystander = client.stat("/other");
    channel.deliver(reply);
    const error = await failure(pending);
    expect(error).toBeInstanceOf(SftpProtocolError);
    expect(await failure(bystander)).toBe(error);
    expect(channel.closeCalls).toBe(1);
  });

  test("ignores data after the session has ended", async () => {
    const { channel, client } = await startClient();
    channel.deliver(statusPacket(9, 0));
    await client.ended;
    channel.adjusted.length = 0;
    channel.deliver(statusPacket(1, 0));
    expect(channel.adjusted).toEqual([]);
  });
});

describe("SftpClient close and failure", () => {
  test("rejects every outstanding request when the channel closes, and every later one", async () => {
    const { channel, client } = await startClient();
    const outstanding = [client.stat("/a"), client.read(HANDLE, 0, 8)];
    const cause = new Error("session dropped");
    channel.closeFromServer(cause);
    for (const request of outstanding) {
      const error = await failure(request);
      expect(error).toBeInstanceOf(SftpSessionClosedError);
      expect((error as Error).cause).toBe(cause);
    }
    const ended = await client.ended;
    expect(ended).toBeInstanceOf(SftpSessionClosedError);
    const later = await failure(client.remove("/b"));
    expect(later).toBeInstanceOf(SftpSessionClosedError);
    expect((later as Error).cause).toBe(ended);
    expect(channel.listenerCount).toBe(0);
  });

  test("ends the session on the server's EOF", async () => {
    const { channel, client } = await startClient();
    const outstanding = client.stat("/a");
    channel.sendEof();
    expect(await failure(outstanding)).toBeInstanceOf(SftpSessionClosedError);
  });

  test("ends the session when a send fails", async () => {
    const { channel, client } = await startClient();
    const cause = new Error("channel disposed");
    channel.sendFailure = cause;
    const error = await failure(client.stat("/a"));
    expect(error).toBeInstanceOf(SftpSessionClosedError);
    expect((error as Error).cause).toBe(cause);
    expect(await client.ended).toBe(error);
  });

  test("end rejects what is outstanding and closes the channel", async () => {
    const { channel, client } = await startClient();
    const outstanding = client.stat("/a");
    await client.end();
    expect(await failure(outstanding)).toBeInstanceOf(SftpSessionClosedError);
    expect(channel.closeCalls).toBe(1);
  });

  test("leaves no unhandled rejection when the channel closes with nothing outstanding", async () => {
    const { channel, client } = await startClient();
    channel.closeFromServer(new Error("gone"));
    expect(await client.ended).toBeInstanceOf(SftpSessionClosedError);
  });
});
