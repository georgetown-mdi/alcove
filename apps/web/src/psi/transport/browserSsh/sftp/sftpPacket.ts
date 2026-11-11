import { SftpProtocolError } from "./sftpErrors";

/**
 * The SFTP version 3 wire codec (draft-ietf-secsh-filexfer-02): the requests
 * the file transport sends and the replies they draw. A packet is a `uint32`
 * length, then that many bytes: a type byte, a request id (none on INIT and
 * VERSION), and the fields.
 */

/** The protocol version the client speaks. */
export const SFTP_VERSION = 3;

/** Packet type numbers. */
export const SftpPacketType = {
  init: 1,
  version: 2,
  open: 3,
  close: 4,
  read: 5,
  write: 6,
  opendir: 11,
  readdir: 12,
  remove: 13,
  realpath: 16,
  stat: 17,
  rename: 18,
  status: 101,
  handle: 102,
  data: 103,
  name: 104,
  attrs: 105,
} as const;

/** `SSH_FXF_*` flags for OPEN. */
export const SftpOpenFlags = {
  read: 0x01,
  write: 0x02,
  append: 0x04,
  create: 0x08,
  truncate: 0x10,
  exclusive: 0x20,
} as const;

const ATTR_SIZE = 0x01;
const ATTR_UIDGID = 0x02;
const ATTR_PERMISSIONS = 0x04;
const ATTR_ACMODTIME = 0x08;
const ATTR_EXTENDED = 0x80000000;

/** The longest handle a server may send (draft-ietf-secsh-filexfer-02, 6.2). */
export const SFTP_MAX_HANDLE_BYTES = 256;

/** File attributes; each field is present only when the server sent it. */
export interface SftpAttributes {
  size?: number;
  uid?: number;
  gid?: number;
  permissions?: number;
  /** Seconds since the epoch. */
  atime?: number;
  /** Seconds since the epoch. */
  mtime?: number;
  extended?: Array<{ type: string; data: Uint8Array }>;
}

/** One entry of a NAME reply. */
export interface SftpNameEntry {
  filename: string;
  /** The server's `ls -l` style line; its format is not specified. */
  longname: string;
  attributes: SftpAttributes;
}

/** A request, as the client sends it. */
export type SftpRequest =
  | {
      type: "open";
      path: string;
      flags: number;
      attributes?: SftpAttributes;
    }
  | { type: "close"; handle: Uint8Array }
  | { type: "read"; handle: Uint8Array; offset: number; length: number }
  | { type: "write"; handle: Uint8Array; offset: number; data: Uint8Array }
  | { type: "opendir"; path: string }
  | { type: "readdir"; handle: Uint8Array }
  | { type: "remove"; path: string }
  | { type: "rename"; oldPath: string; newPath: string }
  | { type: "stat"; path: string }
  | { type: "realpath"; path: string };

/** A reply to a request, as the client reads it. */
export type SftpReply =
  | { type: "status"; id: number; code: number; message: string }
  | { type: "handle"; id: number; handle: Uint8Array }
  | { type: "data"; id: number; data: Uint8Array }
  | { type: "name"; id: number; entries: Array<SftpNameEntry> }
  | { type: "attrs"; id: number; attributes: SftpAttributes };

/** The server's VERSION packet. */
export interface SftpVersion {
  version: number;
  extensions: Array<{ name: string; data: string }>;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

class PacketWriter {
  private readonly parts: Array<Uint8Array> = [];
  private length = 0;

  private push(part: Uint8Array): void {
    this.parts.push(part);
    this.length += part.length;
  }

  byte(value: number): this {
    this.push(Uint8Array.of(value));
    return this;
  }

  uint32(value: number): this {
    const part = new Uint8Array(4);
    new DataView(part.buffer).setUint32(0, value);
    this.push(part);
    return this;
  }

  uint64(value: number): this {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError(
        `An SFTP offset or size must be a whole number of bytes, not ${value}.`,
      );
    const part = new Uint8Array(8);
    new DataView(part.buffer).setBigUint64(0, BigInt(value));
    this.push(part);
    return this;
  }

  string(value: string | Uint8Array): this {
    const bytes = typeof value === "string" ? utf8Encoder.encode(value) : value;
    this.uint32(bytes.length);
    this.push(bytes);
    return this;
  }

  /** Writes uid with gid and atime with mtime, each only as a pair; never extended pairs. */
  attributes(attributes: SftpAttributes = {}): this {
    const { size, uid, gid, permissions, atime, mtime } = attributes;
    let flags = 0;
    if (size !== undefined) flags |= ATTR_SIZE;
    if (uid !== undefined && gid !== undefined) flags |= ATTR_UIDGID;
    if (permissions !== undefined) flags |= ATTR_PERMISSIONS;
    if (atime !== undefined && mtime !== undefined) flags |= ATTR_ACMODTIME;
    this.uint32(flags);
    if (size !== undefined) this.uint64(size);
    if (uid !== undefined && gid !== undefined) this.uint32(uid).uint32(gid);
    if (permissions !== undefined) this.uint32(permissions);
    if (atime !== undefined && mtime !== undefined)
      this.uint32(atime).uint32(mtime);
    return this;
  }

  /** The packet: its length, then its bytes. */
  finish(): Uint8Array<ArrayBuffer> {
    const packet = new Uint8Array(4 + this.length);
    new DataView(packet.buffer).setUint32(0, this.length);
    let offset = 4;
    for (const part of this.parts) {
      packet.set(part, offset);
      offset += part.length;
    }
    return packet;
  }
}

/** The INIT packet. */
export function encodeInit(): Uint8Array<ArrayBuffer> {
  return new PacketWriter()
    .byte(SftpPacketType.init)
    .uint32(SFTP_VERSION)
    .finish();
}

/** A request's packet, with its id. */
export function encodeRequest(
  id: number,
  request: SftpRequest,
): Uint8Array<ArrayBuffer> {
  const writer = new PacketWriter()
    .byte(SftpPacketType[request.type])
    .uint32(id);
  switch (request.type) {
    case "open":
      writer
        .string(request.path)
        .uint32(request.flags)
        .attributes(request.attributes);
      break;
    case "close":
    case "readdir":
      writer.string(request.handle);
      break;
    case "read":
      writer
        .string(request.handle)
        .uint64(request.offset)
        .uint32(request.length);
      break;
    case "write":
      writer.string(request.handle).uint64(request.offset).string(request.data);
      break;
    case "opendir":
    case "remove":
    case "stat":
    case "realpath":
      writer.string(request.path);
      break;
    case "rename":
      writer.string(request.oldPath).string(request.newPath);
      break;
  }
  return writer.finish();
}

class PacketReader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly body: Uint8Array) {
    this.view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  }

  get remaining(): number {
    return this.body.length - this.offset;
  }

  private need(count: number, what: string): void {
    if (this.remaining < count)
      throw new SftpProtocolError(`a packet ends inside its ${what}`);
  }

  byte(what: string): number {
    this.need(1, what);
    return this.body[this.offset++];
  }

  uint32(what: string): number {
    this.need(4, what);
    const value = this.view.getUint32(this.offset);
    this.offset += 4;
    return value;
  }

  uint64(what: string): number {
    this.need(8, what);
    const value = this.view.getBigUint64(this.offset);
    this.offset += 8;
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new SftpProtocolError(`its ${what} is past 2^53`);
    return Number(value);
  }

  bytes(what: string): Uint8Array {
    const length = this.uint32(`${what} length`);
    this.need(length, what);
    const value = this.body.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  string(what: string): string {
    return utf8Decoder.decode(this.bytes(what));
  }

  attributes(): SftpAttributes {
    const flags = this.uint32("attribute flags");
    const attributes: SftpAttributes = {};
    if (flags & ATTR_SIZE) attributes.size = this.uint64("size");
    if (flags & ATTR_UIDGID) {
      attributes.uid = this.uint32("uid");
      attributes.gid = this.uint32("gid");
    }
    if (flags & ATTR_PERMISSIONS)
      attributes.permissions = this.uint32("permissions");
    if (flags & ATTR_ACMODTIME) {
      attributes.atime = this.uint32("atime");
      attributes.mtime = this.uint32("mtime");
    }
    if (flags & ATTR_EXTENDED) {
      const count = this.countOf(8, "extended attribute count");
      attributes.extended = [];
      for (let index = 0; index < count; index++)
        attributes.extended.push({
          type: this.string("extended attribute type"),
          data: this.bytes("extended attribute data"),
        });
    }
    return attributes;
  }

  /** A count of items each at least `minimumBytes`, refused past what is left. */
  countOf(minimumBytes: number, what: string): number {
    const count = this.uint32(what);
    if (count * minimumBytes > this.remaining)
      throw new SftpProtocolError(
        `its ${what} of ${count} overruns the packet`,
      );
    return count;
  }

  end(what: string): void {
    if (this.remaining !== 0)
      throw new SftpProtocolError(
        `a ${what} reply has ${this.remaining} bytes past its fields`,
      );
  }
}

/** Read the first packet's body, which must be VERSION. */
export function decodeVersion(body: Uint8Array): SftpVersion {
  const reader = new PacketReader(body);
  const type = reader.byte("type");
  if (type !== SftpPacketType.version)
    throw new SftpProtocolError(`packet type ${type} before VERSION`);
  const version = reader.uint32("version");
  const extensions: SftpVersion["extensions"] = [];
  while (reader.remaining > 0)
    extensions.push({
      name: reader.string("extension name"),
      data: reader.string("extension data"),
    });
  return { version, extensions };
}

/** Read a reply's body, any packet after VERSION; its byte fields are views of `body`. */
export function decodeReply(body: Uint8Array): SftpReply {
  const reader = new PacketReader(body);
  const type = reader.byte("type");
  const id = reader.uint32("request id");
  let reply: SftpReply;
  switch (type) {
    case SftpPacketType.status: {
      const code = reader.uint32("status code");
      // Version 3 servers predating the message field end the packet here.
      const message =
        reader.remaining === 0 ? "" : reader.string("status message");
      if (reader.remaining > 0) reader.string("status language tag");
      reply = { type: "status", id, code, message };
      break;
    }
    case SftpPacketType.handle: {
      const handle = reader.bytes("handle");
      if (handle.length > SFTP_MAX_HANDLE_BYTES)
        throw new SftpProtocolError(
          `a handle of ${handle.length} bytes, over ${SFTP_MAX_HANDLE_BYTES}`,
        );
      reply = { type: "handle", id, handle };
      break;
    }
    case SftpPacketType.data:
      reply = { type: "data", id, data: reader.bytes("data") };
      break;
    case SftpPacketType.name: {
      const count = reader.countOf(12, "name count");
      const entries: Array<SftpNameEntry> = [];
      for (let index = 0; index < count; index++)
        entries.push({
          filename: reader.string("filename"),
          longname: reader.string("longname"),
          attributes: reader.attributes(),
        });
      reply = { type: "name", id, entries };
      break;
    }
    case SftpPacketType.attrs:
      reply = { type: "attrs", id, attributes: reader.attributes() };
      break;
    default:
      throw new SftpProtocolError(`packet type ${type}, which is not a reply`);
  }
  reader.end(reply.type);
  return reply;
}
