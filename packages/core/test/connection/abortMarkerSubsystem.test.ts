import { afterEach, expect, test, vi } from "vitest";

import {
  AbortMarkerSubsystem,
  abortMarkerBody,
  abortMarkerName,
} from "../../src/connection/abortMarker";
import type {
  FileInfo,
  FileTransportClient,
} from "../../src/connection/fileSyncConnection";
import {
  FrameSizeExceededError,
  TransportOperationStalledError,
} from "../../src/errors";
import { fromBase64Url, toBase64Url } from "../../src/utils/crypto";
import { capReadsAtMaxBytes } from "../utils/support";

// Direct unit tests of the subsystem with injected fakes: a pass-through budget,
// a recording logger, and a client whose every method is a vi.fn(), so each
// assertion reads an argument or a return value rather than a timing outcome.

type Deps = ConstructorParameters<typeof AbortMarkerSubsystem>[0];

// Mirrored from the module-private ABORT_MARKER_WRITE_BUDGET_MS, which is also
// the decision grace period, and ABORT_MARKER_MAX_BYTES.
const WRITE_BUDGET_MS = 5000;
const MARKER_MAX_BYTES = 1024;

const TOKEN_SELF = new Uint8Array(32).fill(0x11);
const TOKEN_PEER = new Uint8Array(32).fill(0x22);
const SELF_ID = "self-id";
const PEER_ID = "peer-id";
const DIR = "/exchange";
const SELF_MARKER = abortMarkerName(SELF_ID, TOKEN_SELF);
const PEER_MARKER = abortMarkerName(PEER_ID, TOKEN_PEER);
const PEER_MARKER_BYTES = abortMarkerBody(TOKEN_PEER).length;

function makeClient(
  overrides: Partial<FileTransportClient> = {},
): FileTransportClient {
  return {
    connect: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
    list: vi.fn(async () => []),
    get: vi.fn(async () => Buffer.alloc(0)),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    safeDelete: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    createExclusive: vi.fn(async () => {}),
    exists: vi.fn(async () => false),
    beginTeardown: vi.fn(),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<Deps> = {}) {
  const debug = vi.fn();
  const stalledError = vi.fn(
    (operation: string, budgetMs: number) =>
      new TransportOperationStalledError(`${operation} (${budgetMs} ms)`),
  );
  const deps: Deps = {
    log: () => ({ debug }) as unknown as ReturnType<Deps["log"]>,
    role: () => "sender",
    runBudgeted: (op) => op,
    stalledError,
    ...overrides,
  };
  return { deps, debug, stalledError };
}

function armed(
  client: FileTransportClient,
  opts: {
    writeDir?: string | null;
    deps?: Partial<Deps>;
    writeWithoutRenaming?: boolean;
  } = {},
) {
  const made = makeDeps(opts.deps);
  const subsystem = new AbortMarkerSubsystem(made.deps);
  subsystem.arm(
    TOKEN_SELF,
    TOKEN_PEER,
    SELF_ID,
    opts.writeDir === null ? undefined : (opts.writeDir ?? DIR),
    client,
    opts.writeWithoutRenaming,
  );
  return { subsystem, ...made };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("a new subsystem is unarmed and undecided, and seal() on it does not throw", () => {
  const subsystem = new AbortMarkerSubsystem(makeDeps().deps);
  expect(subsystem.armed).toBe(false);
  expect(subsystem.decisionResolved).toBe(false);
  expect(subsystem.pendingWrite).toBeUndefined();
  expect(() => subsystem.seal()).not.toThrow();
  expect(subsystem.decisionResolved).toBe(true);
});

test("arm() leaves the decision unresolved and seal() latches it", () => {
  const { subsystem } = armed(makeClient());
  expect(subsystem.armed).toBe(true);
  expect(subsystem.decisionResolved).toBe(false);
  subsystem.seal();
  expect(subsystem.decisionResolved).toBe(true);
});

test("clear() disarms and resets every piece of abort state", async () => {
  const { subsystem } = armed(makeClient());
  await subsystem.writeMarker();
  expect(subsystem.decisionResolved).toBe(true);
  expect(subsystem.pendingWrite).toBeDefined();

  subsystem.clear();
  expect(subsystem.armed).toBe(false);
  expect(subsystem.decisionResolved).toBe(false);
  expect(subsystem.pendingWrite).toBeUndefined();
});

test("awaitDecisionOrGrace resolves with the seal decision, cancels the grace timer, and never reports a timeout", async () => {
  vi.useFakeTimers();
  const { subsystem } = armed(makeClient());
  subsystem.seal();
  const outcome = subsystem.awaitDecisionOrGrace();
  // Advancing past the grace period would turn a missing or unresolved
  // decision into "timeout"; the resolved seal must win regardless.
  await vi.advanceTimersByTimeAsync(WRITE_BUDGET_MS + 1);
  expect(await outcome).toBe("seal");
  expect(vi.getTimerCount()).toBe(0);
});

test("awaitDecisionOrGrace clears its grace timer as soon as it lands", async () => {
  vi.useFakeTimers();
  const { subsystem } = armed(makeClient());
  const outcome = subsystem.awaitDecisionOrGrace();
  expect(vi.getTimerCount()).toBe(1);
  subsystem.seal();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(await outcome).toBe("seal");
});

test("awaitDecisionOrGrace resolves with the write decision once writeMarker() pre-empts the seal", async () => {
  vi.useFakeTimers();
  const { subsystem } = armed(makeClient());
  const outcome = subsystem.awaitDecisionOrGrace();
  await subsystem.writeMarker();
  subsystem.seal();
  await vi.advanceTimersByTimeAsync(WRITE_BUDGET_MS + 1);
  expect(await outcome).toBe("write");
});

test("awaitDecisionOrGrace on an unarmed subsystem resolves as sealed without waiting", async () => {
  vi.useFakeTimers();
  const subsystem = new AbortMarkerSubsystem(makeDeps().deps);
  const outcome = subsystem.awaitDecisionOrGrace();
  await vi.advanceTimersByTimeAsync(WRITE_BUDGET_MS + 1);
  expect(await outcome).toBe("seal");
});

test("awaitDecisionOrGrace reports an undecided wait as a timeout exactly at the grace period", async () => {
  vi.useFakeTimers();
  const { subsystem } = armed(makeClient());
  const settled = vi.fn();
  void subsystem.awaitDecisionOrGrace().then(settled);
  await vi.advanceTimersByTimeAsync(WRITE_BUDGET_MS - 1);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toHaveBeenCalledWith("timeout");
});

test("awaitDecisionOrGrace unrefs its grace timer so it cannot hold the process open", () => {
  const unref = vi.fn();
  vi.spyOn(globalThis, "setTimeout").mockImplementation(
    () => ({ unref }) as unknown as ReturnType<typeof setTimeout>,
  );
  vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
  const { subsystem } = armed(makeClient());
  void subsystem.awaitDecisionOrGrace();
  expect(unref).toHaveBeenCalledOnce();
});

test("writeMarker puts the envelope to a temp file, renames it into place, and logs the write", async () => {
  const client = makeClient();
  const { subsystem, debug } = armed(client);
  await subsystem.writeMarker();

  expect(client.beginTeardown).toHaveBeenCalledOnce();
  expect(client.put).toHaveBeenCalledOnce();
  const [body, tempPath, options] = vi.mocked(client.put).mock.calls[0];
  expect(tempPath).toMatch(
    /^\/exchange\/temp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/,
  );
  expect(options).toEqual({ flags: "w", encoding: "utf-8" });
  expect(Buffer.isBuffer(body)).toBe(true);
  expect(JSON.parse((body as Buffer).toString("utf-8"))).toEqual({
    version: 1,
    token: toBase64Url(TOKEN_SELF),
  });
  // The final name states the byte count of the body written under it.
  const finalName = `${SELF_ID}-abort-${(body as Buffer).length}.json`;
  expect(finalName).toBe(SELF_MARKER);
  expect(client.rename).toHaveBeenCalledWith(tempPath, `${DIR}/${finalName}`);
  expect(debug).toHaveBeenCalledWith(
    `[sender] wrote abort marker ${finalName}`,
  );
});

test("writeMarker logs through the logger current at the write, not the one at construction", async () => {
  const client = makeClient();
  const constructionDebug = vi.fn();
  const writeDebug = vi.fn();
  let current = constructionDebug;
  const { subsystem } = armed(client, {
    deps: {
      log: () => ({ debug: current }) as unknown as ReturnType<Deps["log"]>,
    },
  });
  current = writeDebug;
  await subsystem.writeMarker();
  expect(constructionDebug).not.toHaveBeenCalled();
  expect(writeDebug).toHaveBeenCalledWith(
    `[sender] wrote abort marker ${SELF_MARKER}`,
  );
});

test("writeMarker with an empty directory keeps the temp and final paths relative to the login directory", async () => {
  const client = makeClient();
  const { subsystem } = armed(client, { writeDir: "" });
  await subsystem.writeMarker();

  const tempPath = vi.mocked(client.put).mock.calls[0][1];
  expect(tempPath).toMatch(
    /^temp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/,
  );
  expect(client.rename).toHaveBeenCalledWith(tempPath, SELF_MARKER);
});

test("writeMarker on a transport without beginTeardown still gets the marker", async () => {
  const client = makeClient({ beginTeardown: undefined });
  const { subsystem } = armed(client);
  await expect(subsystem.writeMarker()).resolves.toBeUndefined();
  expect(client.rename).toHaveBeenCalledOnce();
});

test("writeMarker is memoized: every caller gets the same promise and the write runs once", async () => {
  const client = makeClient();
  const { subsystem } = armed(client);
  const first = subsystem.writeMarker();
  const second = subsystem.writeMarker();
  expect(second).toBe(first);
  expect(subsystem.pendingWrite).toBe(first);
  await first;
  expect(subsystem.writeMarker()).toBe(first);
  expect(client.put).toHaveBeenCalledOnce();
});

test("writeMarker with no outbound directory resolves without touching the transport", async () => {
  const client = makeClient();
  const { subsystem } = armed(client, { writeDir: null });
  await expect(subsystem.writeMarker()).resolves.toBeUndefined();
  expect(client.beginTeardown).not.toHaveBeenCalled();
  expect(client.put).not.toHaveBeenCalled();
  expect(client.rename).not.toHaveBeenCalled();
});

test("writeMarker on a stalled put rejects with the budget error naming the temp path", async () => {
  const client = makeClient();
  const { subsystem, stalledError } = armed(client, {
    deps: {
      runBudgeted: (_op, _budgetMs, makeError) => Promise.reject(makeError()),
    },
  });
  const rejection = await subsystem.writeMarker().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(TransportOperationStalledError);
  const tempPath = vi.mocked(client.put).mock.calls[0][1];
  expect(stalledError).toHaveBeenCalledWith(
    `abort marker write to ${tempPath}`,
    WRITE_BUDGET_MS,
  );
  expect(rejection).toBe(stalledError.mock.results[0].value);
});

test("writeMarker on a stalled rename rejects with the budget error naming the final path", async () => {
  const client = makeClient();
  const budgets: number[] = [];
  const { subsystem, stalledError, debug } = armed(client, {
    deps: {
      runBudgeted: (op, budgetMs, makeError) => {
        budgets.push(budgetMs);
        return budgets.length === 1 ? op : Promise.reject(makeError());
      },
    },
  });
  const rejection = await subsystem.writeMarker().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(budgets).toEqual([WRITE_BUDGET_MS, WRITE_BUDGET_MS]);
  expect(rejection).toBeInstanceOf(TransportOperationStalledError);
  expect(stalledError).toHaveBeenCalledWith(
    `abort marker rename to ${DIR}/${SELF_MARKER}`,
    WRITE_BUDGET_MS,
  );
  expect(rejection).toBe(stalledError.mock.results[0].value);
  expect(debug).not.toHaveBeenCalled();
});

test("writeMarker with writeWithoutRenaming puts straight to the final path with the write options and issues no rename", async () => {
  const client = makeClient();
  const { subsystem, debug } = armed(client, { writeWithoutRenaming: true });
  await subsystem.writeMarker();

  const finalPath = `${DIR}/${SELF_MARKER}`;
  expect(client.put).toHaveBeenCalledOnce();
  expect(vi.mocked(client.put).mock.calls[0][1]).toBe(finalPath);
  expect(vi.mocked(client.put).mock.calls[0][2]).toStrictEqual({
    flags: "w",
    encoding: "utf-8",
  });
  expect(client.rename).not.toHaveBeenCalled();
  expect(debug).toHaveBeenCalledWith(
    `[sender] wrote abort marker ${SELF_MARKER}`,
  );
});

test("writeMarker with writeWithoutRenaming on a stalled put rejects with the budget error naming the final path", async () => {
  const client = makeClient();
  const { subsystem, stalledError, debug } = armed(client, {
    writeWithoutRenaming: true,
    deps: {
      runBudgeted: (_op, _budgetMs, makeError) => Promise.reject(makeError()),
    },
  });
  const rejection = await subsystem.writeMarker().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(TransportOperationStalledError);
  expect(stalledError).toHaveBeenCalledWith(
    `abort marker write to ${DIR}/${SELF_MARKER}`,
    WRITE_BUDGET_MS,
  );
  expect(rejection).toBe(stalledError.mock.results[0].value);
  expect(client.rename).not.toHaveBeenCalled();
  expect(debug).not.toHaveBeenCalled();
});

const listing = (size: number, name = PEER_MARKER): FileInfo[] => [
  { name, modifyTime: 0, size },
];
const envelope = (token: unknown, version: unknown = 1) =>
  Buffer.from(JSON.stringify({ version, token }));

test("verifyPeerMarker on an unarmed subsystem returns false without reading", async () => {
  const client = makeClient({
    get: vi.fn(async () => envelope(toBase64Url(TOKEN_PEER))),
  });
  const subsystem = new AbortMarkerSubsystem(makeDeps().deps);
  expect(
    await subsystem.verifyPeerMarker(
      client,
      listing(PEER_MARKER_BYTES),
      DIR,
      PEER_ID,
    ),
  ).toBe(false);
  expect(client.get).not.toHaveBeenCalled();
});

test("verifyPeerMarker reads a verifying marker from the inbound directory capped at its name's byte count", async () => {
  const client = makeClient({
    get: vi.fn(async () => envelope(toBase64Url(TOKEN_PEER))),
  });
  const { subsystem } = armed(client);
  expect(
    await subsystem.verifyPeerMarker(
      client,
      listing(PEER_MARKER_BYTES),
      DIR,
      PEER_ID,
    ),
  ).toBe(true);
  expect(client.get).toHaveBeenCalledWith(`${DIR}/${PEER_MARKER}`, {
    encoding: "utf-8",
    maxBytes: PEER_MARKER_BYTES,
  });
});

test("verifyPeerMarker refuses a body served past its name's byte count, reading no more than that count", async () => {
  // Listed at the count its name states, but the server serves more: a file
  // that grew after listing, or a listing that under-reports its size.
  const body = Buffer.from(
    `${envelope(toBase64Url(TOKEN_PEER)).toString()}${" ".repeat(512)}`,
  );
  const client = makeClient({ get: vi.fn(async () => body) });
  const reads = capReadsAtMaxBytes(client);
  const { subsystem } = armed(client);

  await expect(
    subsystem.verifyPeerMarker(
      client,
      listing(PEER_MARKER_BYTES),
      DIR,
      PEER_ID,
    ),
  ).rejects.toBeInstanceOf(FrameSizeExceededError);
  expect(reads).toEqual([{ name: PEER_MARKER, maxBytes: PEER_MARKER_BYTES }]);
});

test("verifyPeerMarker on a listing without the peer's marker returns false without reading", async () => {
  const client = makeClient({
    get: vi.fn(async () => envelope(toBase64Url(TOKEN_PEER))),
  });
  const { subsystem } = armed(client);
  expect(
    await subsystem.verifyPeerMarker(
      client,
      listing(PEER_MARKER_BYTES, abortMarkerName("other", TOKEN_PEER)),
      DIR,
      PEER_ID,
    ),
  ).toBe(false);
  expect(client.get).not.toHaveBeenCalled();
});

test("verifyPeerMarker does not look for the peer's marker under another byte count", async () => {
  // A marker holding the peer token, padded with JSON whitespace and named
  // for its own length: everything but the exact name agrees.
  const padded = Buffer.from(
    `${envelope(toBase64Url(TOKEN_PEER)).toString()} `,
  );
  const client = makeClient({ get: vi.fn(async () => padded) });
  const { subsystem } = armed(client);
  expect(
    await subsystem.verifyPeerMarker(
      client,
      listing(padded.length, `${PEER_ID}-abort-${padded.length}.json`),
      DIR,
      PEER_ID,
    ),
  ).toBe(false);
  expect(client.get).not.toHaveBeenCalled();
});

test.each([
  ["smaller", -1],
  ["larger", 1],
])(
  "verifyPeerMarker does not verify a marker listed %s than its name's byte count, and does not read it",
  async (_label, delta) => {
    const client = makeClient({
      get: vi.fn(async () => envelope(toBase64Url(TOKEN_PEER))),
    });
    const { subsystem } = armed(client);
    expect(
      await subsystem.verifyPeerMarker(
        client,
        listing(PEER_MARKER_BYTES + delta),
        DIR,
        PEER_ID,
      ),
    ).toBe(false);
    expect(client.get).not.toHaveBeenCalled();
  },
);

test("verifyPeerMarker does not verify a read body longer than its name's byte count", async () => {
  // The listing agrees with the name; the body read holds the peer token and
  // parses, but is one byte past the count the name states.
  const client = makeClient({
    get: vi.fn(async () =>
      Buffer.from(`${envelope(toBase64Url(TOKEN_PEER)).toString()} `),
    ),
  });
  const { subsystem } = armed(client);
  expect(
    await subsystem.verifyPeerMarker(
      client,
      listing(PEER_MARKER_BYTES),
      DIR,
      PEER_ID,
    ),
  ).toBe(false);
  expect(client.get).toHaveBeenCalledOnce();
});

test("verifyPeerMarker logs and refuses an oversized listing", async () => {
  const client = makeClient();
  const { subsystem, debug } = armed(client);
  expect(
    await subsystem.verifyPeerMarker(
      client,
      listing(MARKER_MAX_BYTES + 1),
      DIR,
      PEER_ID,
    ),
  ).toBe(false);
  expect(client.get).not.toHaveBeenCalled();
  expect(debug).toHaveBeenCalledWith(
    `[sender] ignoring oversized abort marker ${PEER_MARKER} ` +
      `(${MARKER_MAX_BYTES + 1} bytes)`,
  );
});

// The cap is the largest size not refused as oversized: paired with the case
// above, this pins the comparison as strictly-greater. A listing on the cap is
// still not read, since it is not the byte count the name states.
test("verifyPeerMarker does not treat a listing at exactly the cap as oversized", async () => {
  const client = makeClient();
  const { subsystem, debug } = armed(client);
  expect(
    await subsystem.verifyPeerMarker(
      client,
      listing(MARKER_MAX_BYTES),
      DIR,
      PEER_ID,
    ),
  ).toBe(false);
  expect(client.get).not.toHaveBeenCalled();
  expect(debug).not.toHaveBeenCalled();
});

test("verifyPeerMarker on a failed read returns false rather than throwing", async () => {
  const client = makeClient({
    get: vi.fn(async () => {
      throw new Error("read failed");
    }),
  });
  const { subsystem } = armed(client);
  expect(
    await subsystem.verifyPeerMarker(
      client,
      listing(PEER_MARKER_BYTES),
      DIR,
      PEER_ID,
    ),
  ).toBe(false);
});

test.each([
  ["a stalled read", () => new TransportOperationStalledError("get (60 ms)")],
  ["an over-cap read", () => new FrameSizeExceededError("over the cap")],
])(
  "verifyPeerMarker rethrows %s rather than ignoring it",
  async (_label, makeError) => {
    const thrown = makeError();
    const client = makeClient({
      get: vi.fn(async () => {
        throw thrown;
      }),
    });
    const { subsystem } = armed(client);
    await expect(
      subsystem.verifyPeerMarker(
        client,
        listing(PEER_MARKER_BYTES),
        DIR,
        PEER_ID,
      ),
    ).rejects.toBe(thrown);
  },
);

test("verifyPeerMarker refuses a non-string token even when its digits decode to the peer token", async () => {
  // A JSON number whose decimal digits are valid base64url: without the type
  // check, the decoder coerces it and the bytes match.
  const numericToken = 123412341234;
  const peerToken = fromBase64Url(String(numericToken));
  const stringBody = envelope(String(numericToken));
  // The numeric form spaced out to the string form's length, so the marker's
  // byte count admits both and only the type check tells them apart.
  const numericBody = Buffer.from(`{"version":1,"token": ${numericToken} }`);
  expect(numericBody.length).toBe(stringBody.length);
  const client = makeClient({
    get: vi.fn(async () => numericBody),
  });
  const subsystem = new AbortMarkerSubsystem(makeDeps().deps);
  subsystem.arm(TOKEN_SELF, peerToken, SELF_ID, DIR, client);
  const markerListing = listing(
    stringBody.length,
    abortMarkerName(PEER_ID, peerToken),
  );
  expect(
    await subsystem.verifyPeerMarker(client, markerListing, DIR, PEER_ID),
  ).toBe(false);

  vi.mocked(client.get).mockResolvedValue(stringBody);
  expect(
    await subsystem.verifyPeerMarker(client, markerListing, DIR, PEER_ID),
  ).toBe(true);
});
