import { Buffer } from "../sshLibrary";

import {
  SFTP_VERSION,
  decodeReply,
  decodeVersion,
  encodeInit,
  encodeRequest,
} from "./sftpPacket";
import {
  SftpPacketTooLargeError,
  SftpProtocolError,
  SftpSessionClosedError,
  SftpStatusCode,
  sftpStatusError,
} from "./sftpErrors";

import type {
  SftpAttributes,
  SftpNameEntry,
  SftpReply,
  SftpRequest,
  SftpVersion,
} from "./sftpPacket";
import type { SftpOperation } from "./sftpErrors";

/**
 * The most file data the client asks for in one READ: OpenSSH's sftp-server
 * returns no more for any larger request (its `limits@openssh.com`
 * max-read-length). Basis: docs/spec/TRANSPORT_BOUNDS.md, Browser SFTP packet
 * bound.
 */
export const SFTP_MAX_READ_BYTES = 261_120;

/** A DATA reply's bytes besides its data: type, request id, data length. */
const DATA_REPLY_FRAMING_BYTES = 9;

/**
 * The longest packet the client accepts, as its length field declares it:
 * the DATA reply to the largest READ the client sends. A longer declaration
 * ends the session before any of the packet is allocated.
 */
export const SFTP_MAX_INBOUND_PACKET_LENGTH =
  SFTP_MAX_READ_BYTES + DATA_REPLY_FRAMING_BYTES;

/**
 * The longest packet the client sends, as its length field declares it:
 * OpenSSH's sftp-server ends the session on a longer one (its
 * `limits@openssh.com` max-packet-length).
 */
export const SFTP_MAX_OUTBOUND_PACKET_LENGTH = 262_144;

/** The shortest packet a server can send: a type and a request id. */
const MIN_INBOUND_PACKET_LENGTH = 5;

interface Disposable {
  dispose: () => void;
}

/**
 * The channel the client runs over: what it uses of the SSH library's
 * `SshChannel`, which `connectBrowserSsh` returns with the `sftp` subsystem
 * started on it.
 */
export interface SftpChannel {
  readonly isClosed: boolean;
  onDataReceived: (listener: (data: Uint8Array) => void) => Disposable;
  onEof: (listener: () => void) => Disposable;
  onClosed: (
    listener: (event: { readonly error?: Error }) => void,
  ) => Disposable;
  send: (data: Buffer) => Promise<void>;
  adjustWindow: (messageLength: number) => void;
  close: () => Promise<void>;
}

/** Splits channel data into packet bodies, refusing an over-long declaration. */
class PacketReassembler {
  private readonly header = new Uint8Array(4);
  private headerFilled = 0;
  private body: Uint8Array | undefined;
  private bodyFilled = 0;

  push(data: Uint8Array, onPacket: (body: Uint8Array) => void): void {
    let offset = 0;
    while (offset < data.length) {
      if (this.body === undefined) {
        const take = Math.min(4 - this.headerFilled, data.length - offset);
        this.header.set(
          data.subarray(offset, offset + take),
          this.headerFilled,
        );
        this.headerFilled += take;
        offset += take;
        if (this.headerFilled < 4) return;
        this.headerFilled = 0;
        const length = new DataView(this.header.buffer).getUint32(0);
        if (length > SFTP_MAX_INBOUND_PACKET_LENGTH)
          throw new SftpPacketTooLargeError(
            length,
            SFTP_MAX_INBOUND_PACKET_LENGTH,
          );
        if (length < MIN_INBOUND_PACKET_LENGTH)
          throw new SftpProtocolError(
            `a packet of ${length} bytes, too short for a type and request id`,
          );
        this.body = new Uint8Array(length);
        this.bodyFilled = 0;
      }
      const take = Math.min(
        this.body.length - this.bodyFilled,
        data.length - offset,
      );
      this.body.set(data.subarray(offset, offset + take), this.bodyFilled);
      this.bodyFilled += take;
      offset += take;
      if (this.bodyFilled === this.body.length) {
        const body = this.body;
        this.body = undefined;
        onPacket(body);
      }
    }
  }
}

type SuccessReply = Exclude<SftpReply, { type: "status" }>;

/** How a request's replies resolve it. */
interface ReplyHandling<T> {
  /** The value of a success reply, or `undefined` for a type the request never draws. */
  accept?: (reply: SuccessReply) => T | undefined;
  /** For a request answered by STATUS OK. */
  onOk?: () => T;
  /** For a request that STATUS EOF ends. */
  onEof?: () => T;
}

interface PendingRequest {
  /** Resolve or reject with the reply; throws a protocol error. */
  settle: (reply: SftpReply) => void;
  reject: (error: Error) => void;
}

interface AwaitingVersion {
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * A reply's value, or its status error. Throws a protocol error for a reply
 * the request never draws.
 */
function interpret<T>(
  reply: SftpReply,
  operation: SftpOperation,
  handling: ReplyHandling<T>,
): { value: T } | { error: Error } {
  if (reply.type === "status") {
    if (reply.code === SftpStatusCode.ok && handling.onOk)
      return { value: handling.onOk() };
    if (reply.code === SftpStatusCode.eof && handling.onEof)
      return { value: handling.onEof() };
    if (reply.code === SftpStatusCode.ok)
      throw new SftpProtocolError(`status OK for a ${operation.name}`);
    return { error: sftpStatusError(reply.code, reply.message, operation) };
  }
  const value = handling.accept?.(reply);
  if (value === undefined)
    throw new SftpProtocolError(`a ${reply.type} reply to a ${operation.name}`);
  return { value };
}

function asBuffer(packet: Uint8Array<ArrayBuffer>): Buffer {
  return Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength);
}

/**
 * An SFTP version 3 client over one channel. Requests may overlap; each
 * resolves with its reply or rejects with a named error from ./sftpErrors.ts.
 * When the channel closes, or the server sends what version 3 does not
 * allow, every outstanding request rejects, later ones reject with
 * {@link SftpSessionClosedError}, and {@link SftpClient.ended} resolves.
 */
export class SftpClient {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly reassembler = new PacketReassembler();
  private readonly subscriptions: Array<Disposable>;
  private nextId = 0;
  private serverVersion: SftpVersion | undefined;
  private awaitingVersion: AwaitingVersion | undefined;
  private endedBy: Error | undefined;
  private resolveEnded!: (error: Error) => void;

  /** Resolves, and never rejects, with the error that ended the session. */
  readonly ended: Promise<Error>;

  private constructor(private readonly channel: SftpChannel) {
    this.ended = new Promise((resolve) => (this.resolveEnded = resolve));
    this.subscriptions = [
      channel.onDataReceived((data) => this.receive(data)),
      channel.onEof(() => this.terminate(new SftpSessionClosedError())),
      channel.onClosed((event) =>
        this.terminate(
          new SftpSessionClosedError(
            event.error === undefined ? undefined : { cause: event.error },
          ),
        ),
      ),
    ];
  }

  /**
   * Start the protocol on a channel with the `sftp` subsystem running: send
   * INIT and wait for VERSION 3.
   */
  static async start(channel: SftpChannel): Promise<SftpClient> {
    const client = new SftpClient(channel);
    if (channel.isClosed) client.terminate(new SftpSessionClosedError());
    await new Promise<void>((resolve, reject) => {
      if (client.endedBy !== undefined) {
        reject(client.endedBy);
        return;
      }
      client.awaitingVersion = { resolve, reject };
      client.transmit(encodeInit());
    });
    return client;
  }

  /** The server's VERSION packet. */
  get version(): SftpVersion | undefined {
    return this.serverVersion;
  }

  /** Open a file; `flags` from `SftpOpenFlags`. Resolves with its handle. */
  async open(
    path: string,
    flags: number,
    attributes?: SftpAttributes,
  ): Promise<Uint8Array> {
    return this.call(
      { type: "open", path, flags, ...(attributes ? { attributes } : {}) },
      { name: "open", path },
      {
        accept: (reply) => (reply.type === "handle" ? reply.handle : undefined),
      },
    );
  }

  /** Close a file or directory handle. */
  async close(handle: Uint8Array): Promise<void> {
    return this.call(
      { type: "close", handle },
      { name: "close" },
      { onOk: () => undefined },
    );
  }

  /**
   * Read up to `length` bytes, at most {@link SFTP_MAX_READ_BYTES}, at
   * `offset`. Resolves with fewer bytes when the server sends fewer, and with
   * `null` at the end of the file.
   */
  async read(
    handle: Uint8Array,
    offset: number,
    length: number,
  ): Promise<Uint8Array | null> {
    if (!Number.isInteger(length) || length < 1 || length > SFTP_MAX_READ_BYTES)
      throw new RangeError(
        `An SFTP read asks for 1 to ${SFTP_MAX_READ_BYTES} bytes, not ${length}.`,
      );
    return this.call(
      { type: "read", handle, offset, length },
      { name: "read" },
      {
        accept: (reply) => {
          if (reply.type !== "data") return undefined;
          if (reply.data.length > length)
            throw new SftpProtocolError(
              `${reply.data.length} bytes of data for a read of ${length}`,
            );
          return reply.data;
        },
        onEof: () => null,
      },
    );
  }

  /** Write `data` at `offset`. */
  async write(
    handle: Uint8Array,
    offset: number,
    data: Uint8Array,
  ): Promise<void> {
    return this.call(
      { type: "write", handle, offset, data },
      { name: "write" },
      { onOk: () => undefined },
    );
  }

  /** Open a directory for listing. Resolves with its handle. */
  async opendir(path: string): Promise<Uint8Array> {
    return this.call(
      { type: "opendir", path },
      { name: "listing", path },
      {
        accept: (reply) => (reply.type === "handle" ? reply.handle : undefined),
      },
    );
  }

  /** The next batch of a directory's entries, or `null` once there are none. */
  async readdir(handle: Uint8Array): Promise<Array<SftpNameEntry> | null> {
    return this.call(
      { type: "readdir", handle },
      { name: "listing" },
      {
        accept: (reply) => (reply.type === "name" ? reply.entries : undefined),
        onEof: () => null,
      },
    );
  }

  /** Remove a file. */
  async remove(path: string): Promise<void> {
    return this.call(
      { type: "remove", path },
      { name: "removal", path },
      { onOk: () => undefined },
    );
  }

  /** Rename a file; the server refuses when `newPath` exists. */
  async rename(oldPath: string, newPath: string): Promise<void> {
    return this.call(
      { type: "rename", oldPath, newPath },
      { name: "rename", path: `${oldPath} to ${newPath}` },
      { onOk: () => undefined },
    );
  }

  /** A path's attributes, following a symbolic link. */
  async stat(path: string): Promise<SftpAttributes> {
    return this.call(
      { type: "stat", path },
      { name: "stat", path },
      {
        accept: (reply) =>
          reply.type === "attrs" ? reply.attributes : undefined,
      },
    );
  }

  /** A path made absolute and canonical by the server. */
  async realpath(path: string): Promise<string> {
    return this.call(
      { type: "realpath", path },
      { name: "path lookup", path },
      {
        accept: (reply) => {
          if (reply.type !== "name") return undefined;
          if (reply.entries.length !== 1)
            throw new SftpProtocolError(
              `${reply.entries.length} names for a path lookup`,
            );
          return reply.entries[0].filename;
        },
      },
    );
  }

  /**
   * End the session: reject what is outstanding and close the channel. The
   * SSH session stays open; close it with its own `close`.
   */
  async end(): Promise<void> {
    this.terminate(new SftpSessionClosedError());
    try {
      await this.channel.close();
    } catch {
      // The channel is already closed.
    }
  }

  private call<T>(
    request: SftpRequest,
    operation: SftpOperation,
    handling: ReplyHandling<T>,
  ): Promise<T> {
    if (this.endedBy !== undefined)
      return Promise.reject(
        new SftpSessionClosedError({ cause: this.endedBy }),
      );
    const id = this.allocateId();
    const packet = encodeRequest(id, request);
    if (packet.length - 4 > SFTP_MAX_OUTBOUND_PACKET_LENGTH)
      return Promise.reject(
        new RangeError(
          `An SFTP ${request.type} request of ${packet.length - 4} bytes is over the ${SFTP_MAX_OUTBOUND_PACKET_LENGTH} a server accepts.`,
        ),
      );
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        reject,
        settle: (reply) => {
          const outcome = interpret(reply, operation, handling);
          if ("error" in outcome) reject(outcome.error);
          else resolve(outcome.value);
        },
      });
      this.transmit(packet);
    });
  }

  private allocateId(): number {
    do this.nextId = (this.nextId + 1) >>> 0;
    while (this.pending.has(this.nextId));
    return this.nextId;
  }

  private transmit(packet: Uint8Array<ArrayBuffer>): void {
    this.channel.send(asBuffer(packet)).catch((error: unknown) => {
      this.terminate(new SftpSessionClosedError({ cause: error }));
    });
  }

  private receive(data: Uint8Array): void {
    if (this.endedBy !== undefined) return;
    try {
      this.reassembler.push(data, (body) => this.dispatch(body));
    } catch (error) {
      this.fail(error);
      return;
    }
    this.channel.adjustWindow(data.length);
  }

  private dispatch(body: Uint8Array): void {
    if (this.serverVersion === undefined) {
      const version = decodeVersion(body);
      if (version.version !== SFTP_VERSION)
        throw new SftpProtocolError(
          `SFTP version ${version.version}, where this client speaks version ${SFTP_VERSION}`,
        );
      this.serverVersion = version;
      const waiting = this.awaitingVersion;
      this.awaitingVersion = undefined;
      waiting?.resolve();
      return;
    }
    const reply = decodeReply(body);
    const request = this.pending.get(reply.id);
    if (request === undefined)
      throw new SftpProtocolError(
        `a ${reply.type} reply to request ${reply.id}, which is not outstanding`,
      );
    this.pending.delete(reply.id);
    try {
      request.settle(reply);
    } catch (error) {
      request.reject(error as Error);
      throw error;
    }
  }

  /** End the session on what the server sent, and close the channel. */
  private fail(error: unknown): void {
    this.terminate(
      error instanceof Error ? error : new SftpProtocolError(String(error)),
    );
    this.channel.close().catch(() => {
      // The channel is already closed.
    });
  }

  private terminate(error: Error): void {
    if (this.endedBy !== undefined) return;
    this.endedBy = error;
    for (const subscription of this.subscriptions) subscription.dispose();
    const outstanding: Array<{ reject: (error: Error) => void }> = [
      ...this.pending.values(),
    ];
    this.pending.clear();
    if (this.awaitingVersion) outstanding.push(this.awaitingVersion);
    this.awaitingVersion = undefined;
    for (const request of outstanding) request.reject(error);
    this.resolveEnded(error);
  }
}
