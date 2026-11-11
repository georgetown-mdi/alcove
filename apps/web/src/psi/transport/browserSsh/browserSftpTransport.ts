import {
  DEFAULT_SERVER_CONNECT_TIMEOUT_MS,
  DISPLAY_TRUNCATION_MARKER,
  DirectoryListingBoundsError,
  FrameSizeExceededError,
  InternalConsistencyError,
  MAX_DIRECTORY_ENTRIES,
  MAX_FILE_NAME_BYTES,
  MAX_LISTING_READDIR_BATCHES,
  SFTP_PUT_PROGRESS_CHUNK_BYTES,
  SFTP_STALL_DEADLINE_MS,
  TimeoutError,
  TransportOperationStalledError,
  UsageError,
  fittedCauseLink,
  redactPrivateKeyMaterial,
  withTimeout,
} from "@alcove/core";

import { SFTP_MAX_READ_BYTES, SftpClient } from "./sftp/sftpClient";
import {
  SftpFailureError,
  SftpNoSuchFileError,
  SftpSessionClosedError,
} from "./sftp/sftpErrors";
import { Buffer } from "./sshLibrary";
import { SftpOpenFlags } from "./sftp/sftpPacket";
import { connectBrowserSsh } from "./browserSshClient";

import type {
  BrowserSshConnectOptions,
  BrowserSshHostKey,
  BrowserSshSftpSession,
} from "./browserSshClient";
import type {
  FileInfo,
  FileTransportClient,
  GetOptions,
  PutOptions,
  PutSource,
} from "@alcove/core";
import type { NonExtractableEcdsaP256KeyPair } from "./nonExtractableEcdsaKey";
import type { SftpChannel } from "./sftp/sftpClient";

/**
 * A `FileTransportClient` over the browser SFTP client, so a page can run a
 * file-sync exchange on an SFTP server through its SFTP relay. Its bounds are
 * the CLI adapter's, at core's figures: docs/spec/TRANSPORT_BOUNDS.md, Browser
 * SFTP transport bounds. A dropped session is not re-dialed:
 * docs/spec/SFTP_SESSION_RECOVERY.md, The browser SFTP transport.
 */

/** What the transport uses of {@link SftpClient}. */
export type SftpOperations = Pick<
  SftpClient,
  | "open"
  | "close"
  | "read"
  | "write"
  | "opendir"
  | "readdir"
  | "remove"
  | "rename"
  | "stat"
  | "end"
>;

/** What {@link BrowserSftpTransport} needs beyond the connection config. */
export interface BrowserSftpTransportOptions {
  /** The SFTP relay's `ws:` or `wss:` url, which fixes the server. */
  relayUrl: string;
  /** The key the transport authenticates with. */
  key: NonExtractableEcdsaP256KeyPair;
  /** @internal */
  dial?: (options: BrowserSshConnectOptions) => Promise<BrowserSshSftpSession>;
  /** @internal */
  startSftp?: (channel: SftpChannel) => Promise<SftpOperations>;
  /** @internal */
  stallDeadlineMs?: number;
}

/** The connect deadline ran out before an SFTP session was established. */
export class BrowserSftpConnectTimeoutError extends TimeoutError {
  constructor(
    readonly phase: "handshake" | "protocol start",
    readonly timeoutMs: number,
  ) {
    super(
      phase === "handshake"
        ? `The SFTP server did not complete the connection within ${timeoutMs} ms, so no SFTP session was established. ` +
            "Check that the server and its SFTP relay are running, then try again."
        : `The SFTP server accepted this connection's key and then did not start SFTP within ${timeoutMs} ms, so no SFTP session was established. ` +
            "Check that the account may use SFTP on that server, then try again.",
    );
    this.name = "BrowserSftpConnectTimeoutError";
  }
}

/** An exclusive create found the file already there. */
class SftpFileExistsError extends Error {
  readonly code = "EEXIST";
  constructor(cause: Error) {
    super(cause.message, { cause });
    this.name = "SftpFileExistsError";
  }
}

/** The handshake and protocol-start bound: the dial's `readyTimeout`. */
function connectTimeoutMs(readyTimeout: unknown): number {
  return typeof readyTimeout === "number" &&
    Number.isFinite(readyTimeout) &&
    readyTimeout > 0
    ? readyTimeout
    : DEFAULT_SERVER_CONNECT_TIMEOUT_MS;
}

const utf8Encoder = new TextEncoder();

function stalledError(
  operation: string,
  path: string,
  detail: string,
): TransportOperationStalledError {
  return new TransportOperationStalledError(
    `SFTP ${operation} stalled; refusing to wait on the server further`,
    {
      details: [
        fittedCauseLink(`how the ${operation} stalled: `, detail),
        fittedCauseLink(`stalled ${operation} path: `, path),
      ],
    },
  );
}

function directoryTooLargeError(dirPath: string): DirectoryListingBoundsError {
  return new DirectoryListingBoundsError(
    `the shared folder contains more than ${MAX_DIRECTORY_ENTRIES} entries; ` +
      `refusing to enumerate it to avoid an unbounded memory allocation`,
    { details: [fittedCauseLink("directory: ", dirPath)] },
  );
}

function filenameTooLongError(
  dirPath: string,
  name: string,
  nameBytes: number,
): DirectoryListingBoundsError {
  // Redacted before the marker is appended, so a planted BEGIN marker in the
  // slice cannot consume it.
  const shown = `${redactPrivateKeyMaterial(name.slice(0, 64))}${DISPLAY_TRUNCATION_MARKER}`;
  return new DirectoryListingBoundsError(
    `the shared folder contains an entry whose filename is ${nameBytes} ` +
      `bytes, exceeding the maximum of ${MAX_FILE_NAME_BYTES}; refusing to ` +
      `process it`,
    {
      details: [
        fittedCauseLink("directory: ", dirPath),
        `entry name: ${shown}`,
      ],
    },
  );
}

function frameSizeExceededError(
  path: string,
  maxBytes: number,
): FrameSizeExceededError {
  return new FrameSizeExceededError(
    `an inbound file exceeds the maximum frame size of ${maxBytes} bytes; ` +
      `refusing to read it into memory`,
    { details: [fittedCauseLink("inbound file: ", path)] },
  );
}

/**
 * A deadline over an operation, or, re-armed on each sign of progress, an idle
 * window. It only races: the request it abandons can still settle.
 */
class OperationClock {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private fire!: (error: Error) => void;
  private readonly expired: Promise<never>;

  constructor(
    private readonly ms: number,
    private readonly makeError: () => Error,
  ) {
    this.expired = new Promise<never>((_, reject) => (this.fire = reject));
    this.expired.catch(() => {});
    this.arm();
  }

  arm(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fire(this.makeError()), this.ms);
  }

  race<T>(work: Promise<T>): Promise<T> {
    work.catch(() => {});
    return Promise.race([work, this.expired]);
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}

/** Close a handle without waiting on the reply, which a server can withhold. */
function closeQuietly(sftp: SftpOperations, handle: Uint8Array): void {
  sftp.close(handle).catch(() => {});
}

/**
 * Open under `clock`; a handle the server returns after the clock expired is
 * closed rather than left open on the server.
 */
async function openUnder(
  clock: OperationClock,
  opening: Promise<Uint8Array>,
  sftp: SftpOperations,
): Promise<Uint8Array> {
  let abandoned = false;
  opening.then(
    (handle) => {
      if (abandoned) closeQuietly(sftp, handle);
    },
    () => {},
  );
  try {
    return await clock.race(opening);
  } catch (error) {
    abandoned = true;
    throw error;
  }
}

async function drain(
  source: NodeJS.ReadableStream,
): Promise<Array<Uint8Array>> {
  const parts: Array<Uint8Array> = [];
  for await (const chunk of source as AsyncIterable<Uint8Array | string>)
    parts.push(typeof chunk === "string" ? utf8Encoder.encode(chunk) : chunk);
  return parts;
}

/**
 * The browser SFTP file transport. One session per instance: a dial after
 * {@link BrowserSftpTransport.end}, or over a live session, is refused.
 */
export class BrowserSftpTransport implements FileTransportClient {
  private session:
    { ssh: BrowserSshSftpSession; sftp: SftpOperations } | undefined;
  private ended = false;
  private readonly stallDeadlineMs: number;
  private readonly dial: NonNullable<BrowserSftpTransportOptions["dial"]>;
  private readonly startSftp: NonNullable<
    BrowserSftpTransportOptions["startSftp"]
  >;

  constructor(private readonly options: BrowserSftpTransportOptions) {
    this.stallDeadlineMs = options.stallDeadlineMs ?? SFTP_STALL_DEADLINE_MS;
    this.dial = options.dial ?? connectBrowserSsh;
    this.startSftp =
      options.startSftp ?? ((channel) => SftpClient.start(channel));
  }

  /**
   * Dial the relay, check the host key with `options.hostVerifier` (the
   * file-sync connection's pin check), authenticate and start SFTP. The
   * server is the relay's; `host`, `port` and any password or private key in
   * `options` are not read. The handshake and the protocol start are each
   * bounded by `options.readyTimeout`.
   */
  async connect(options: Record<string, unknown>): Promise<void> {
    if (this.ended || this.session !== undefined)
      throw new InternalConsistencyError(
        "BrowserSftpTransport.connect: one session per transport; build a new one to dial again",
      );
    const username = options["username"];
    if (typeof username !== "string" || username === "")
      throw new UsageError(
        "The SFTP connection names no username. Set the account to sign in as.",
      );
    const hostVerifier = options["hostVerifier"];
    if (typeof hostVerifier !== "function")
      throw new InternalConsistencyError(
        "BrowserSftpTransport.connect: no hostVerifier, so the server's host key cannot be checked",
      );
    const verify = hostVerifier as (
      keyBlob: Uint8Array,
      verdict: (permitted: boolean) => void,
    ) => void;
    const timeoutMs = connectTimeoutMs(options["readyTimeout"]);

    const handshake = new AbortController();
    const timer = setTimeout(
      () =>
        handshake.abort(
          new BrowserSftpConnectTimeoutError("handshake", timeoutMs),
        ),
      timeoutMs,
    );
    let ssh: BrowserSshSftpSession;
    try {
      ssh = await this.dial({
        relayUrl: this.options.relayUrl,
        username,
        key: this.options.key,
        onHostKey: (hostKey: BrowserSshHostKey) =>
          new Promise<boolean>((resolve) => verify(hostKey.blob, resolve)),
        signal: handshake.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    let sftp: SftpOperations;
    try {
      sftp = await withTimeout(this.startSftp(ssh.channel), timeoutMs, "");
    } catch (error) {
      ssh.dispose();
      throw error instanceof TimeoutError
        ? new BrowserSftpConnectTimeoutError("protocol start", timeoutMs)
        : error;
    }
    if (this.endedDuringDial()) {
      ssh.dispose();
      throw new SftpSessionClosedError();
    }
    this.session = { ssh, sftp };
  }

  // A method, so the check is not narrowed away across the dial's awaits.
  private endedDuringDial(): boolean {
    return this.ended;
  }

  /**
   * End the session at once, without waiting on the server: outstanding
   * requests reject and the relay socket closes.
   */
  end(): Promise<void> {
    this.ended = true;
    const session = this.session;
    this.session = undefined;
    if (session !== undefined) {
      void session.sftp.end();
      session.ssh.dispose();
    }
    return Promise.resolve();
  }

  /**
   * Every entry of `path`, read one READDIR batch at a time. Refused past
   * {@link MAX_DIRECTORY_ENTRIES} entries, a name over
   * {@link MAX_FILE_NAME_BYTES} bytes, {@link MAX_LISTING_READDIR_BATCHES}
   * round-trips, or the stall deadline over the whole listing.
   */
  async list(path: string): Promise<Array<FileInfo>> {
    const sftp = this.live();
    const ms = this.stallDeadlineMs;
    const deadline = new OperationClock(ms, () =>
      stalledError(
        "directory listing",
        path,
        `did not complete within ${ms} ms (the server withheld a ` +
          `directory-read response)`,
      ),
    );
    let handle: Uint8Array | undefined;
    try {
      handle = await openUnder(deadline, sftp.opendir(path), sftp);
      const entries: Array<FileInfo> = [];
      for (let batches = 1; ; batches++) {
        if (batches > MAX_LISTING_READDIR_BATCHES)
          throw stalledError(
            "directory listing",
            path,
            `made no progress over ${MAX_LISTING_READDIR_BATCHES} readdir ` +
              `round-trips without reaching end-of-directory`,
          );
        const batch = await deadline.race(sftp.readdir(handle));
        if (batch === null) return entries;
        // The entry count first, then the name length, as the CLI adapters do.
        for (const entry of batch) {
          if (entries.length >= MAX_DIRECTORY_ENTRIES)
            throw directoryTooLargeError(path);
          const nameBytes = utf8Encoder.encode(entry.filename).length;
          if (nameBytes > MAX_FILE_NAME_BYTES)
            throw filenameTooLongError(path, entry.filename, nameBytes);
          entries.push({
            name: entry.filename,
            modifyTime: (entry.attributes.mtime ?? 0) * 1000,
            size: entry.attributes.size ?? 0,
          });
        }
      }
    } finally {
      deadline.stop();
      if (handle !== undefined) closeQuietly(sftp, handle);
    }
  }

  /**
   * The file at `path`, refused once it holds more than `options.maxBytes`
   * bytes whatever its listed size, with at most `maxBytes` bytes held. Fails
   * when the server sends no data for the stall deadline.
   */
  async get(
    path: string,
    options: GetOptions,
  ): Promise<Buffer<ArrayBufferLike>> {
    const { maxBytes } = options;
    if (!(Number.isFinite(maxBytes) && maxBytes > 0))
      throw new InternalConsistencyError(
        `BrowserSftpTransport.get: maxBytes must be a positive finite number, got ${String(maxBytes)}`,
      );
    const sftp = this.live();
    const ms = this.stallDeadlineMs;
    const idle = new OperationClock(ms, () =>
      stalledError(
        "file read",
        path,
        `received no data for ${ms} ms (the server withheld the transfer)`,
      ),
    );
    let handle: Uint8Array | undefined;
    try {
      handle = await openUnder(idle, sftp.open(path, SftpOpenFlags.read), sftp);
      const chunks: Array<Uint8Array> = [];
      let total = 0;
      for (;;) {
        // One byte past the cap is asked for, to see whether the file has more.
        const length = Math.min(SFTP_MAX_READ_BYTES, maxBytes - total + 1);
        const data = await idle.race(sftp.read(handle, total, length));
        if (data === null) break;
        if (data.length === 0) continue;
        total += data.length;
        if (total > maxBytes) throw frameSizeExceededError(path, maxBytes);
        chunks.push(data);
        idle.arm();
      }
      return Buffer.concat(chunks);
    } finally {
      idle.stop();
      if (handle !== undefined) closeQuietly(sftp, handle);
    }
  }

  /**
   * Write `src` to `dest`, truncating it, or appending with `flags: "a"`, in
   * {@link SFTP_PUT_PROGRESS_CHUNK_BYTES} chunks. Fails when the server
   * acknowledges no chunk, or the close, for the stall deadline.
   */
  async put(src: PutSource, dest: string, options?: PutOptions): Promise<void> {
    const sftp = this.live();
    const parts: ReadonlyArray<Uint8Array> =
      src instanceof Uint8Array
        ? [src]
        : Array.isArray(src)
          ? src
          : await drain(src);
    const flags =
      SftpOpenFlags.write |
      SftpOpenFlags.create |
      (options?.flags === "a" ? SftpOpenFlags.append : SftpOpenFlags.truncate);
    const ms = this.stallDeadlineMs;
    const idle = new OperationClock(ms, () =>
      stalledError(
        "file write",
        dest,
        `made no upload progress for ${ms} ms (the server withheld write ` +
          `acknowledgement)`,
      ),
    );
    let handle: Uint8Array | undefined;
    try {
      handle = await openUnder(idle, sftp.open(dest, flags), sftp);
      idle.arm();
      let offset = 0;
      for (const part of parts) {
        for (
          let start = 0;
          start < part.length;
          start += SFTP_PUT_PROGRESS_CHUNK_BYTES
        ) {
          const chunk = part.subarray(
            start,
            start + SFTP_PUT_PROGRESS_CHUNK_BYTES,
          );
          await idle.race(sftp.write(handle, offset, chunk));
          offset += chunk.length;
          idle.arm();
        }
      }
      const written = handle;
      handle = undefined;
      // The close reports whether the server stored the data.
      await idle.race(sftp.close(written));
    } finally {
      idle.stop();
      if (handle !== undefined) closeQuietly(sftp, handle);
    }
  }

  /** Remove `path`; a missing file rejects with SFTP status 2. */
  async delete(path: string): Promise<void> {
    const sftp = this.live();
    await this.roundTrip("file delete", path, "delete", sftp.remove(path));
  }

  /** Remove `path`, never rejecting. */
  async safeDelete(path: string): Promise<void> {
    const session = this.session;
    if (session === undefined) return;
    await this.roundTrip(
      "file delete",
      path,
      "delete",
      session.sftp.remove(path),
    ).catch(() => {});
  }

  /** Rename `fromPath`; the server refuses when `toPath` exists. */
  async rename(fromPath: string, toPath: string): Promise<void> {
    const sftp = this.live();
    await this.roundTrip(
      "file rename",
      fromPath,
      "rename",
      sftp.rename(fromPath, toPath),
    );
  }

  /**
   * Create an empty file at `path`, refused with `code` `EEXIST` when one is
   * there. SFTP version 3 reports an existing file as the generic failure
   * status, so that status is followed by a STAT to tell the two apart.
   */
  async createExclusive(path: string): Promise<void> {
    const sftp = this.live();
    const ms = this.stallDeadlineMs;
    const deadline = new OperationClock(ms, () =>
      stalledError(
        "exclusive create",
        path,
        `did not complete within ${ms} ms (the server withheld the open, ` +
          `existence-check, or close response)`,
      ),
    );
    try {
      let handle: Uint8Array;
      try {
        handle = await openUnder(
          deadline,
          sftp.open(
            path,
            SftpOpenFlags.write |
              SftpOpenFlags.create |
              SftpOpenFlags.exclusive,
          ),
          sftp,
        );
      } catch (error) {
        if (!(error instanceof SftpFailureError)) throw error;
        const present = await deadline.race(sftp.stat(path)).then(
          () => true,
          (statError: unknown) => {
            if (statError instanceof SftpNoSuchFileError) return false;
            if (statError instanceof TransportOperationStalledError)
              throw statError;
            throw error;
          },
        );
        if (present) throw new SftpFileExistsError(error);
        throw new Error(
          "The SFTP server could not create the lock file, and no file is " +
            "there, so the cause is on the server rather than a race with the " +
            "partner. Ask the server's administrator what the server logged " +
            "(for example a full disk or a quota), then try again.",
          { cause: error },
        );
      }
      await deadline.race(sftp.close(handle));
    } finally {
      deadline.stop();
    }
  }

  /** Whether anything is at `remotePath`; any error but a missing file rejects. */
  async exists(remotePath: string): Promise<boolean> {
    const sftp = this.live();
    return this.roundTrip(
      "existence check",
      remotePath,
      "stat",
      sftp.stat(remotePath),
    ).then(
      () => true,
      (error: unknown) => {
        if (error instanceof SftpNoSuchFileError) return false;
        throw error;
      },
    );
  }

  private live(): SftpOperations {
    if (this.session === undefined) throw new SftpSessionClosedError();
    return this.session.sftp;
  }

  private roundTrip<T>(
    operation: string,
    path: string,
    response: string,
    request: Promise<T>,
  ): Promise<T> {
    const ms = this.stallDeadlineMs;
    const deadline = new OperationClock(ms, () =>
      stalledError(
        operation,
        path,
        `did not complete within ${ms} ms (the server withheld the ` +
          `${response} response)`,
      ),
    );
    return deadline.race(request).finally(() => deadline.stop());
  }
}
