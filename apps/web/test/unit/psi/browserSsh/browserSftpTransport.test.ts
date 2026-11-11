import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  DEFAULT_SERVER_CONNECT_TIMEOUT_MS,
  DirectoryListingBoundsError,
  FrameSizeExceededError,
  InternalConsistencyError,
  MAX_DIRECTORY_ENTRIES,
  MAX_FILE_NAME_BYTES,
  MAX_LISTING_READDIR_BATCHES,
  SFTP_PUT_PROGRESS_CHUNK_BYTES,
  SFTP_STALL_DEADLINE_MS,
  TransportOperationStalledError,
  UsageError,
} from "@alcove/core";

import {
  BrowserSftpConnectTimeoutError,
  BrowserSftpTransport,
} from "@psi/transport/browserSsh/browserSftpTransport";
import {
  SftpFailureError,
  SftpNoSuchFileError,
  SftpPermissionDeniedError,
  SftpSessionClosedError,
} from "@psi/transport/browserSsh/sftp/sftpErrors";
import { SFTP_MAX_READ_BYTES } from "@psi/transport/browserSsh/sftp/sftpClient";
import { SftpOpenFlags } from "@psi/transport/browserSsh/sftp/sftpPacket";

import type {
  BrowserSshConnectOptions,
  BrowserSshSftpSession,
} from "@psi/transport/browserSsh/browserSshClient";
import type { NonExtractableEcdsaP256KeyPair } from "@psi/transport/browserSsh/nonExtractableEcdsaKey";
import type { SftpNameEntry } from "@psi/transport/browserSsh/sftp/sftpPacket";
import type { SftpOperations } from "@psi/transport/browserSsh/browserSftpTransport";

type Operation = keyof SftpOperations;

interface OpenHandle {
  path: string;
  flags: number;
  directory: boolean;
  batch: number;
}

const never = <T>(): Promise<T> => new Promise<T>(() => {});

/** An in-memory SFTP server behind the operations the transport uses. */
class FakeSftp implements SftpOperations {
  readonly files = new Map<string, Uint8Array>();
  /** Operations the server never answers. */
  readonly withheld = new Set<Operation>();
  /** Each request, by operation. */
  readonly calls: Array<{ operation: Operation; args: Array<unknown> }> = [];
  /** Handles the client has closed. */
  closedHandles = 0;
  /** When set, the batches each READDIR returns, in turn, then end-of-directory. */
  batches: Array<Array<SftpNameEntry>> | undefined;
  /** When set, answers each READ in place of the file. */
  readReply:
    | ((offset: number, length: number) => Promise<Uint8Array | null>)
    | undefined;
  /** When set, answers each WRITE. */
  writeReply: (() => Promise<void>) | undefined;
  /** When set, every request rejects with it. */
  dropped: Error | undefined;

  private readonly handles = new Map<number, OpenHandle>();
  private nextHandle = 1;

  private request<T>(
    operation: Operation,
    args: Array<unknown>,
    answer: () => T | Promise<T>,
  ): Promise<T> {
    this.calls.push({ operation, args });
    if (this.dropped) return Promise.reject(this.dropped);
    if (this.withheld.has(operation)) return never();
    try {
      return Promise.resolve(answer());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  count(operation: Operation): number {
    return this.calls.filter((call) => call.operation === operation).length;
  }

  private handle(handle: Uint8Array): OpenHandle {
    const open = this.handles.get(new DataView(handle.buffer).getUint32(0));
    if (open === undefined) throw new Error("no such handle");
    return open;
  }

  private issue(open: OpenHandle): Uint8Array {
    const id = this.nextHandle++;
    this.handles.set(id, open);
    const handle = new Uint8Array(4);
    new DataView(handle.buffer).setUint32(0, id);
    return handle;
  }

  open(path: string, flags: number): Promise<Uint8Array> {
    return this.request("open", [path, flags], () => {
      const present = this.files.has(path);
      if (flags & SftpOpenFlags.exclusive && present)
        throw new SftpFailureError("", { name: "open", path });
      if (!present && !(flags & SftpOpenFlags.create))
        throw new SftpNoSuchFileError("", { name: "open", path });
      if (!present || flags & SftpOpenFlags.truncate)
        this.files.set(path, new Uint8Array(0));
      return this.issue({ path, flags, directory: false, batch: 0 });
    });
  }

  close(handle: Uint8Array): Promise<void> {
    return this.request("close", [handle], () => {
      this.handle(handle);
      this.closedHandles += 1;
    });
  }

  read(
    handle: Uint8Array,
    offset: number,
    length: number,
  ): Promise<Uint8Array | null> {
    return this.request("read", [handle, offset, length], () => {
      if (this.readReply) return this.readReply(offset, length);
      const file = this.files.get(this.handle(handle).path) ?? new Uint8Array();
      if (offset >= file.length) return null;
      return file.slice(offset, offset + length);
    });
  }

  write(handle: Uint8Array, offset: number, data: Uint8Array): Promise<void> {
    return this.request("write", [handle, offset, data.length], () => {
      if (this.writeReply) return this.writeReply();
      const open = this.handle(handle);
      const file = this.files.get(open.path) ?? new Uint8Array();
      const at = open.flags & SftpOpenFlags.append ? file.length : offset;
      const grown = new Uint8Array(Math.max(file.length, at + data.length));
      grown.set(file);
      grown.set(data, at);
      this.files.set(open.path, grown);
    });
  }

  opendir(path: string): Promise<Uint8Array> {
    return this.request("opendir", [path], () =>
      this.issue({ path, flags: 0, directory: true, batch: 0 }),
    );
  }

  readdir(handle: Uint8Array): Promise<Array<SftpNameEntry> | null> {
    return this.request("readdir", [handle], () => {
      const open = this.handle(handle);
      const batches = this.batches ?? [
        [...this.files].map(([path, data]) =>
          entry(path.slice(path.lastIndexOf("/") + 1), data.length),
        ),
      ];
      return open.batch < batches.length ? batches[open.batch++] : null;
    });
  }

  remove(path: string): Promise<void> {
    return this.request("remove", [path], () => {
      if (!this.files.delete(path))
        throw new SftpNoSuchFileError("", { name: "removal", path });
    });
  }

  rename(oldPath: string, newPath: string): Promise<void> {
    return this.request("rename", [oldPath, newPath], () => {
      const file = this.files.get(oldPath);
      if (file === undefined)
        throw new SftpNoSuchFileError("", { name: "rename", path: oldPath });
      if (this.files.has(newPath))
        throw new SftpFailureError("", { name: "rename", path: newPath });
      this.files.delete(oldPath);
      this.files.set(newPath, file);
    });
  }

  stat(path: string): Promise<{ size: number }> {
    return this.request("stat", [path], () => {
      const file = this.files.get(path);
      if (file === undefined)
        throw new SftpNoSuchFileError("", { name: "stat", path });
      return { size: file.length };
    });
  }

  end(): Promise<void> {
    return this.request("end", [], () => {});
  }
}

function entry(filename: string, size = 0, mtime = 0): SftpNameEntry {
  return { filename, longname: "", attributes: { size, mtime } };
}

function bytes(length: number, fill = 7): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

const KEY = {} as NonExtractableEcdsaP256KeyPair;
const HOST_KEY = { algorithm: "ssh-ed25519", blob: Uint8Array.of(1, 2, 3) };
const ROOT = "/exchange";

interface Harness {
  transport: BrowserSftpTransport;
  sftp: FakeSftp;
  dials: Array<BrowserSshConnectOptions>;
  disposed: () => number;
}

function harness(
  overrides: {
    dial?: (
      options: BrowserSshConnectOptions,
    ) => Promise<BrowserSshSftpSession>;
    startSftp?: () => Promise<SftpOperations>;
  } = {},
): Harness {
  const sftp = new FakeSftp();
  const dials: Array<BrowserSshConnectOptions> = [];
  let disposals = 0;
  const transport = new BrowserSftpTransport({
    relayUrl: "wss://relay.test/sftp",
    key: KEY,
    dial:
      overrides.dial ??
      (async (options) => {
        dials.push(options);
        if (!(await options.onHostKey(HOST_KEY)))
          throw new Error("host key refused");
        return {
          channel: {} as BrowserSshSftpSession["channel"],
          hostKey: HOST_KEY,
          close: () => Promise.resolve(),
          dispose: () => {
            disposals += 1;
          },
        };
      }),
    startSftp: overrides.startSftp ?? (() => Promise.resolve(sftp)),
  });
  return { transport, sftp, dials, disposed: () => disposals };
}

const acceptingVerifier = (
  _blob: Uint8Array,
  verdict: (permitted: boolean) => void,
) => verdict(true);

const CONNECT_OPTIONS = {
  host: "sftp.example.org",
  username: "alice",
  readyTimeout: 30_000,
  hostVerifier: acceptingVerifier,
};

async function connected(): Promise<Harness> {
  const opened = harness();
  await opened.transport.connect(CONNECT_OPTIONS);
  return opened;
}

/** The rejection of `promise`, failing the case if it resolves. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

/** Whether `promise` is still pending after the microtasks run. */
async function pending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await vi.advanceTimersByTimeAsync(0);
  return !settled;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("connect", () => {
  test("dials the relay as the configured user and checks the host key with the verifier", async () => {
    const { transport, dials } = harness();
    const seen: Array<Uint8Array> = [];
    await transport.connect({
      ...CONNECT_OPTIONS,
      hostVerifier: (blob: Uint8Array, verdict: (ok: boolean) => void) => {
        seen.push(blob);
        verdict(true);
      },
    });
    expect(dials).toHaveLength(1);
    expect(dials[0]).toMatchObject({
      relayUrl: "wss://relay.test/sftp",
      username: "alice",
      key: KEY,
    });
    expect(seen).toEqual([HOST_KEY.blob]);
  });

  test("a host key the verifier refuses fails the dial", async () => {
    const { transport } = harness();
    await expect(
      transport.connect({
        ...CONNECT_OPTIONS,
        hostVerifier: (_blob: Uint8Array, verdict: (ok: boolean) => void) =>
          verdict(false),
      }),
    ).rejects.toThrow("host key refused");
  });

  test("refuses a config with no username, and a dial with no verifier", async () => {
    await expect(
      harness().transport.connect({ ...CONNECT_OPTIONS, username: undefined }),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      harness().transport.connect({
        ...CONNECT_OPTIONS,
        hostVerifier: undefined,
      }),
    ).rejects.toBeInstanceOf(InternalConsistencyError);
  });

  test("refuses a second dial, and a dial after end", async () => {
    const { transport } = await connected();
    await expect(transport.connect(CONNECT_OPTIONS)).rejects.toBeInstanceOf(
      InternalConsistencyError,
    );
    await transport.end();
    await expect(transport.connect(CONNECT_OPTIONS)).rejects.toBeInstanceOf(
      InternalConsistencyError,
    );
  });

  test.each([
    { readyTimeout: 12_000, bound: 12_000 },
    { readyTimeout: undefined, bound: DEFAULT_SERVER_CONNECT_TIMEOUT_MS },
  ])(
    "aborts a handshake still running after $bound ms",
    async ({ readyTimeout, bound }) => {
      let signal: AbortSignal | undefined;
      const { transport } = harness({
        dial: (options) => {
          signal = options.signal;
          return new Promise((_, reject) =>
            options.signal?.addEventListener("abort", () =>
              reject(options.signal?.reason as Error),
            ),
          );
        },
      });
      const connecting = failure(
        transport.connect({ ...CONNECT_OPTIONS, readyTimeout }),
      );
      await vi.advanceTimersByTimeAsync(bound - 1);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const error = await connecting;
      expect(error).toBeInstanceOf(BrowserSftpConnectTimeoutError);
      expect(error).toMatchObject({ phase: "handshake", timeoutMs: bound });
    },
  );

  test("bounds the SFTP protocol start by the same window and closes the session", async () => {
    const opened = harness({ startSftp: never });
    const connecting = failure(opened.transport.connect(CONNECT_OPTIONS));
    await vi.advanceTimersByTimeAsync(CONNECT_OPTIONS.readyTimeout - 1);
    expect(opened.disposed()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await connecting).toMatchObject({
      name: "BrowserSftpConnectTimeoutError",
      phase: "protocol start",
    });
    expect(opened.disposed()).toBe(1);
  });
});

describe("list", () => {
  test("lists every entry, with its size and its time in milliseconds, and closes the handle", async () => {
    const { transport, sftp } = await connected();
    sftp.batches = [[entry("a.json", 3, 1_700_000_000)], [entry("b.json", 4)]];
    expect(await transport.list(ROOT)).toEqual([
      { name: "a.json", size: 3, modifyTime: 1_700_000_000_000 },
      { name: "b.json", size: 4, modifyTime: 0 },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(sftp.closedHandles).toBe(1);
  });

  test(`refuses a directory of more than ${MAX_DIRECTORY_ENTRIES} entries`, async () => {
    const { transport, sftp } = await connected();
    const names = (count: number, from = 0) =>
      Array.from({ length: count }, (_, index) => entry(`f${from + index}`));
    sftp.batches = [names(MAX_DIRECTORY_ENTRIES - 1), names(1, 9_000)];
    expect(await transport.list(ROOT)).toHaveLength(MAX_DIRECTORY_ENTRIES);
    sftp.batches = [names(MAX_DIRECTORY_ENTRIES), names(1, 9_000)];
    const error = await failure(transport.list(ROOT));
    expect(error).toBeInstanceOf(DirectoryListingBoundsError);
    expect((error as Error).message).toContain(
      `more than ${MAX_DIRECTORY_ENTRIES} entries`,
    );
  });

  test(`refuses a name over ${MAX_FILE_NAME_BYTES} bytes of UTF-8`, async () => {
    const { transport, sftp } = await connected();
    // 128 two-byte characters: 128 code units, 256 bytes.
    sftp.batches = [[entry("é".repeat(127))], [entry("é".repeat(128))]];
    const error = await failure(transport.list(ROOT));
    expect(error).toBeInstanceOf(DirectoryListingBoundsError);
    expect((error as Error).message).toContain(
      `filename is 256 bytes, exceeding the maximum of ${MAX_FILE_NAME_BYTES}`,
    );
  });

  test(`stops after ${MAX_LISTING_READDIR_BATCHES} empty batches`, async () => {
    const { transport, sftp } = await connected();
    sftp.batches = Array.from(
      { length: MAX_LISTING_READDIR_BATCHES + 5 },
      () => [],
    );
    const error = await failure(transport.list(ROOT));
    expect(error).toBeInstanceOf(TransportOperationStalledError);
    expect(sftp.count("readdir")).toBe(MAX_LISTING_READDIR_BATCHES);
  });

  test(`fails a listing still unanswered after ${SFTP_STALL_DEADLINE_MS} ms`, async () => {
    const { transport, sftp } = await connected();
    sftp.withheld.add("readdir");
    const listing = failure(transport.list(ROOT));
    await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS - 1);
    expect(await pending(listing)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    const error = await listing;
    expect(error).toBeInstanceOf(TransportOperationStalledError);
    expect((error as Error).message).toBe(
      "SFTP directory listing stalled; refusing to wait on the server further",
    );
    expect(sftp.closedHandles).toBe(1);
  });

  test("closes a directory handle the server returns after the deadline", async () => {
    const { transport, sftp } = await connected();
    let answer: ((handle: Uint8Array) => void) | undefined;
    const opendir = sftp.opendir.bind(sftp);
    sftp.opendir = (path) => {
      const opened = opendir(path);
      return new Promise((resolve) => (answer = resolve)).then(() => opened);
    };
    const listing = failure(transport.list(ROOT));
    await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS);
    expect(await listing).toBeInstanceOf(TransportOperationStalledError);
    answer?.(new Uint8Array());
    await vi.advanceTimersByTimeAsync(0);
    expect(sftp.closedHandles).toBe(1);
  });
});

describe("get", () => {
  test("reads a file across several reads", async () => {
    const { transport, sftp } = await connected();
    const data = bytes(2 * SFTP_MAX_READ_BYTES + 10);
    sftp.files.set(`${ROOT}/m.json`, data);
    const read = await transport.get(`${ROOT}/m.json`, { maxBytes: 1 << 20 });
    expect(new Uint8Array(read)).toEqual(data);
    expect(sftp.count("read")).toBe(4);
  });

  test("reads a file of exactly maxBytes and refuses one byte more, asking for no more than maxBytes + 1", async () => {
    const { transport, sftp } = await connected();
    sftp.files.set(`${ROOT}/m.json`, bytes(100));
    expect(
      (await transport.get(`${ROOT}/m.json`, { maxBytes: 100 })).length,
    ).toBe(100);
    sftp.files.set(`${ROOT}/m.json`, bytes(101));
    sftp.calls.length = 0;
    const error = await failure(
      transport.get(`${ROOT}/m.json`, { maxBytes: 100 }),
    );
    expect(error).toBeInstanceOf(FrameSizeExceededError);
    expect((error as Error).message).toContain(
      "maximum frame size of 100 bytes",
    );
    const asked = sftp.calls
      .filter((call) => call.operation === "read")
      .reduce((sum, call) => sum + (call.args[2] as number), 0);
    expect(asked).toBe(101);
  });

  test("refuses a file that grows past the cap however its listing reported it", async () => {
    const { transport, sftp } = await connected();
    sftp.files.set(`${ROOT}/m.json`, bytes(1));
    sftp.readReply = (_offset, length) => Promise.resolve(bytes(length));
    const error = await failure(
      transport.get(`${ROOT}/m.json`, { maxBytes: 3 * SFTP_MAX_READ_BYTES }),
    );
    expect(error).toBeInstanceOf(FrameSizeExceededError);
    expect(sftp.count("read")).toBe(4);
  });

  test("rejects a maxBytes that is not a positive number", async () => {
    const { transport } = await connected();
    await expect(
      transport.get(`${ROOT}/m.json`, { maxBytes: 0 }),
    ).rejects.toBeInstanceOf(InternalConsistencyError);
  });

  test(`fails once the server sends no data for ${SFTP_STALL_DEADLINE_MS} ms, and a trickle does not`, async () => {
    const { transport, sftp } = await connected();
    sftp.files.set(`${ROOT}/m.json`, bytes(1));
    let reads = 0;
    sftp.readReply = async () => {
      reads += 1;
      if (reads > 3) return never();
      await new Promise((resolve) =>
        setTimeout(resolve, SFTP_STALL_DEADLINE_MS - 1),
      );
      return bytes(1);
    };
    const reading = failure(transport.get(`${ROOT}/m.json`, { maxBytes: 10 }));
    await vi.advanceTimersByTimeAsync(3 * (SFTP_STALL_DEADLINE_MS - 1));
    await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS - 1);
    expect(await pending(reading)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    const error = await reading;
    expect(error).toBeInstanceOf(TransportOperationStalledError);
    expect((error as Error).message).toBe(
      "SFTP file read stalled; refusing to wait on the server further",
    );
    expect(sftp.closedHandles).toBe(1);
  });

  test("an empty data reply is not progress", async () => {
    const { transport, sftp } = await connected();
    sftp.files.set(`${ROOT}/m.json`, bytes(1));
    sftp.readReply = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return new Uint8Array();
    };
    const reading = failure(transport.get(`${ROOT}/m.json`, { maxBytes: 10 }));
    await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS);
    expect(await reading).toBeInstanceOf(TransportOperationStalledError);
  });
});

describe("put", () => {
  test(`writes a buffer and a chunk list in ${SFTP_PUT_PROGRESS_CHUNK_BYTES}-byte writes, then closes`, async () => {
    const { transport, sftp } = await connected();
    const data = bytes(SFTP_PUT_PROGRESS_CHUNK_BYTES + 5, 3);
    await transport.put(Buffer.from(data), `${ROOT}/a.tmp`);
    expect(sftp.files.get(`${ROOT}/a.tmp`)).toEqual(data);
    expect(
      sftp.calls
        .filter((call) => call.operation === "write")
        .map((call) => call.args[2]),
    ).toEqual([SFTP_PUT_PROGRESS_CHUNK_BYTES, 5]);
    expect(sftp.closedHandles).toBe(1);

    await transport.put(
      [Uint8Array.of(1, 2), Uint8Array.of(3)],
      `${ROOT}/a.tmp`,
    );
    expect(sftp.files.get(`${ROOT}/a.tmp`)).toEqual(Uint8Array.of(1, 2, 3));
    await transport.put([Uint8Array.of(4)], `${ROOT}/a.tmp`, { flags: "a" });
    expect(sftp.files.get(`${ROOT}/a.tmp`)).toEqual(Uint8Array.of(1, 2, 3, 4));
    await transport.put(Buffer.alloc(0), `${ROOT}/ack.json`);
    expect(sftp.files.get(`${ROOT}/ack.json`)).toEqual(new Uint8Array());
  });

  test(`fails once the server acknowledges no write for ${SFTP_STALL_DEADLINE_MS} ms`, async () => {
    const { transport, sftp } = await connected();
    let writes = 0;
    sftp.writeReply = async () => {
      writes += 1;
      if (writes > 1) return never();
      await new Promise((resolve) =>
        setTimeout(resolve, SFTP_STALL_DEADLINE_MS - 1),
      );
    };
    const writing = failure(
      transport.put(
        Buffer.from(bytes(2 * SFTP_PUT_PROGRESS_CHUNK_BYTES)),
        `${ROOT}/a.tmp`,
      ),
    );
    await vi.advanceTimersByTimeAsync(2 * (SFTP_STALL_DEADLINE_MS - 1));
    expect(await pending(writing)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    const error = await writing;
    expect(error).toBeInstanceOf(TransportOperationStalledError);
    expect((error as Error).message).toBe(
      "SFTP file write stalled; refusing to wait on the server further",
    );
  });

  test("a withheld close fails the write", async () => {
    const { transport, sftp } = await connected();
    sftp.withheld.add("close");
    const writing = failure(
      transport.put(Buffer.from(bytes(4)), `${ROOT}/a.tmp`),
    );
    await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS);
    expect(await writing).toBeInstanceOf(TransportOperationStalledError);
  });
});

describe("metadata operations", () => {
  test("delete, rename and exists act on the server and report its status codes", async () => {
    const { transport, sftp } = await connected();
    sftp.files.set(`${ROOT}/a`, bytes(1));
    expect(await transport.exists(`${ROOT}/a`)).toBe(true);
    await transport.rename(`${ROOT}/a`, `${ROOT}/b`);
    expect(await transport.exists(`${ROOT}/a`)).toBe(false);
    await transport.delete(`${ROOT}/b`);
    expect(sftp.files.size).toBe(0);
    await expect(transport.delete(`${ROOT}/b`)).rejects.toMatchObject({
      code: 2,
    });
  });

  test("exists rejects on any error but a missing file", async () => {
    const { transport, sftp } = await connected();
    sftp.stat = () =>
      Promise.reject(
        new SftpPermissionDeniedError("", { name: "stat", path: "/x" }),
      );
    await expect(transport.exists("/x")).rejects.toBeInstanceOf(
      SftpPermissionDeniedError,
    );
  });

  test.each([
    { operation: "remove", run: (t: BrowserSftpTransport) => t.delete("/x") },
    {
      operation: "rename",
      run: (t: BrowserSftpTransport) => t.rename("/x", "/y"),
    },
    { operation: "stat", run: (t: BrowserSftpTransport) => t.exists("/x") },
  ] as const)(
    `a withheld $operation fails after ${SFTP_STALL_DEADLINE_MS} ms`,
    async ({ operation, run }) => {
      const { transport, sftp } = await connected();
      sftp.withheld.add(operation);
      const running = failure(run(transport));
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS - 1);
      expect(await pending(running)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(await running).toBeInstanceOf(TransportOperationStalledError);
    },
  );

  test("safeDelete never rejects", async () => {
    const opened = harness();
    await opened.transport.safeDelete("/x");
    await opened.transport.connect(CONNECT_OPTIONS);
    await opened.transport.safeDelete("/missing");
    opened.sftp.withheld.add("remove");
    const deleting = opened.transport.safeDelete("/x");
    await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS);
    await expect(deleting).resolves.toBeUndefined();
  });
});

describe("createExclusive", () => {
  test("creates an empty file and closes it", async () => {
    const { transport, sftp } = await connected();
    await transport.createExclusive(`${ROOT}/lock.json`);
    expect(sftp.files.get(`${ROOT}/lock.json`)).toEqual(new Uint8Array());
    expect(sftp.closedHandles).toBe(1);
  });

  test("reports an existing file as EEXIST, after checking it is there", async () => {
    const { transport, sftp } = await connected();
    sftp.files.set(`${ROOT}/lock.json`, new Uint8Array());
    const error = await failure(transport.createExclusive(`${ROOT}/lock.json`));
    expect(error).toMatchObject({ code: "EEXIST" });
    expect((error as Error).cause).toBeInstanceOf(SftpFailureError);
    expect(sftp.count("stat")).toBe(1);
  });

  test("a failure with no file there is a server error, not a lock race", async () => {
    const { transport, sftp } = await connected();
    sftp.open = (path) =>
      Promise.reject(new SftpFailureError("disk full", { name: "open", path }));
    const error = await failure(transport.createExclusive(`${ROOT}/lock.json`));
    expect(error).not.toMatchObject({ code: "EEXIST" });
    expect((error as Error).message).toContain("no file is there");
  });

  test("a stat that fails too reports the open's error", async () => {
    const { transport, sftp } = await connected();
    sftp.files.set(`${ROOT}/lock.json`, new Uint8Array());
    sftp.stat = (path) =>
      Promise.reject(new SftpPermissionDeniedError("", { name: "stat", path }));
    expect(
      await failure(transport.createExclusive(`${ROOT}/lock.json`)),
    ).toBeInstanceOf(SftpFailureError);
  });

  test.each(["open", "stat", "close"] as const)(
    `a withheld %s fails it after ${SFTP_STALL_DEADLINE_MS} ms`,
    async (operation) => {
      const { transport, sftp } = await connected();
      if (operation === "stat") sftp.files.set(`${ROOT}/lock.json`, bytes(0));
      sftp.withheld.add(operation);
      const creating = failure(transport.createExclusive(`${ROOT}/lock.json`));
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS - 1);
      expect(await pending(creating)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(await creating).toBeInstanceOf(TransportOperationStalledError);
    },
  );
});

describe("the session's end", () => {
  test("end closes the session at once and later operations reject", async () => {
    const opened = await connected();
    opened.sftp.withheld.add("end");
    await opened.transport.end();
    expect(opened.disposed()).toBe(1);
    expect(opened.sftp.count("end")).toBe(1);
    await expect(opened.transport.list(ROOT)).rejects.toBeInstanceOf(
      SftpSessionClosedError,
    );
    await opened.transport.end();
    expect(opened.disposed()).toBe(1);
  });

  test("a dropped session is not re-dialed: each operation rejects with the session's error", async () => {
    const opened = await connected();
    opened.sftp.dropped = new SftpSessionClosedError();
    await expect(opened.transport.list(ROOT)).rejects.toBeInstanceOf(
      SftpSessionClosedError,
    );
    await expect(
      opened.transport.get(`${ROOT}/m.json`, { maxBytes: 10 }),
    ).rejects.toBeInstanceOf(SftpSessionClosedError);
    await expect(
      opened.transport.put(Buffer.from(bytes(1)), `${ROOT}/a.tmp`),
    ).rejects.toBeInstanceOf(SftpSessionClosedError);
    expect(opened.dials).toHaveLength(1);
  });
});
