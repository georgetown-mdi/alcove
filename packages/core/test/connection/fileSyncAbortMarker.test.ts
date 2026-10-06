import { expect, test, vi } from "vitest";

import { FileSyncConnection } from "../../src/connection/fileSyncConnection";
import type { FileTransportClient } from "../../src/connection/fileSyncConnection";
import type { FileDropConnectionConfig } from "../../src/config/connection";
import {
  PeerAbortError,
  ConnectionError,
  statesItsOwnNextStep,
} from "../../src/errors";
import {
  serializeFileSyncMessage,
  MESSAGE_TYPE_OBJECT,
} from "../../src/connection/fileSyncFraming";
import {
  fromEventConnection,
  type MessageConnection,
} from "../../src/connection/messageConnection";
import type { LinkageTerms } from "../../src/config/linkageTermsSchema";
import { exchangeTerms, PROTOCOL_VERSION } from "../../src/protocolSetup";
import { sanitizeErrorForDisplay } from "../../src/utils/sanitizeErrorForDisplay";
import { toBase64Url } from "../../src/utils/crypto";
import { makeMockClient } from "../utils/support";

// Short marker-write / decision-grace budget mirrored from the production
// constant ABORT_MARKER_WRITE_BUDGET_MS (module-private), referenced here so the
// fake-timer "hung write" assertion advances past the same window the code uses.
const WRITE_BUDGET_MS = 5000;

// Mirrored from the production constant ABORT_MARKER_MAX_BYTES (module-private)
// so the boundary pair below plants markers exactly on and one byte past it.
const MARKER_MAX_BYTES = 1024;

const TOKEN_SELF = new Uint8Array(32).fill(0x11);
const TOKEN_PEER = new Uint8Array(32).fill(0x22);

const TEST_DIR = "/test";

// The in-memory transport with an op log, so a test can assert ordering (the
// marker rename completed before the transport was ended), and with writes that
// reject once end() has run, as on a real transport whose channel end()
// destroyed. Optionally delays writes (to race a missing await) or hangs them
// forever (for the write-budget tests).
function makeAbortTestClient(opts?: {
  writeDelayMs?: number;
  hangWrite?: boolean;
}): {
  client: FileTransportClient;
  files: Map<string, Buffer>;
  ops: string[];
} {
  const ops: string[] = [];
  const { client, files } = makeMockClient({
    ...opts,
    ops,
    rejectWritesAfterEnd: true,
    withBeginTeardown: true,
  });
  return { client, files, ops };
}

async function makeArmedConn(
  client: FileTransportClient,
  opts?: {
    retainFiles?: boolean;
    inactivityTimeoutMs?: number;
    arm?: boolean;
    peerId?: string;
    unexpectedFiles?: "error" | "warn" | "ignore";
  },
): Promise<FileSyncConnection> {
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 5,
    verbose: -1,
  });
  const config: FileDropConnectionConfig = {
    channel: "filedrop",
    path: TEST_DIR,
    options: {
      inactivityTimeoutMs: opts?.inactivityTimeoutMs ?? 200,
      ...(opts?.retainFiles ? { retainFiles: true } : {}),
      ...(opts?.unexpectedFiles
        ? { unexpectedFiles: opts.unexpectedFiles }
        : {}),
    },
  };
  await conn.open(config);
  // peerId is normally committed by synchronize(); the read-side tests set it
  // directly to drive poll() without a full rendezvous (mirroring the existing
  // poll() tests in fileSyncConnection.test.ts).
  if (opts?.peerId !== undefined) conn.peerId = opts.peerId;
  if (opts?.arm !== false) conn.armAbort(TOKEN_SELF, TOKEN_PEER);
  return conn;
}

const PEER_ID = "peer-test";
const peerMarkerName = `${PEER_ID}-abort.json`;
const peerMarkerPath = `${TEST_DIR}/${peerMarkerName}`;

function plantPeerMarker(
  files: Map<string, Buffer>,
  token: Uint8Array,
  name = peerMarkerName,
): void {
  files.set(
    `${TEST_DIR}/${name}`,
    Buffer.from(
      JSON.stringify({
        version: 1,
        token: toBase64Url(token as Uint8Array<ArrayBuffer>),
      }),
    ),
  );
}

// Plants a peer marker that would verify, padded with insignificant JSON
// whitespace to occupy exactly `size` bytes in the listing, so a test can sit on
// the pre-get() cap rather than well above it.
function plantPaddedPeerMarker(files: Map<string, Buffer>, size: number): void {
  const body = JSON.stringify({ version: 1, token: toBase64Url(TOKEN_PEER) });
  const padding = size - body.length;
  if (padding < 0)
    throw new Error(`a verifying marker cannot fit in ${size} bytes`);
  files.set(
    peerMarkerPath,
    Buffer.from(`${body.slice(0, -1)}${" ".repeat(padding)}}`),
  );
}

function nextError(conn: FileSyncConnection, ms = 1000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    conn.once("error", resolve);
    const t = setTimeout(
      () => reject(new Error("no error emitted within timeout")),
      ms,
    );
    if (typeof t.unref === "function") t.unref();
  });
}

// Polls for `ms` and returns every error emitted in that window (expected empty
// for the ignore paths). Stops the poller before returning.
async function pollAndCollectErrors(
  conn: FileSyncConnection,
  ms = 60,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  conn.on("error", (e) => errors.push(e));
  conn.start();
  await new Promise((r) => setTimeout(r, ms));
  conn.stop();
  return errors;
}

// Drives the bridge fail() path: emitting "error" on the connection while the
// fromEventConnection bridge is listening runs QueuedMessageConnection.fail(),
// which fire-and-forgets conn.close() -- exactly the teardown that races a
// marker write issued from the orchestrator's catch. Returns the bridge so the
// caller can close() it (the doCleanup analogue).
function driveFault(conn: FileSyncConnection, err: ConnectionError) {
  const mc = fromEventConnection(conn);
  conn.emit("error", err);
  return mc;
}

const markerName = (conn: FileSyncConnection) => `${conn.id}-abort.json`;
const markerPath = (conn: FileSyncConnection) =>
  `${TEST_DIR}/${markerName(conn)}`;

// --- organic fault writes the marker, before ending the transport ------------

for (const retainFiles of [false, true]) {
  const mode = retainFiles ? "retain" : "delete";
  test(
    `organic fault in ${mode} mode writes the abort marker and the write ` +
      `completes before the transport is ended (the tight teardown window)`,
    async () => {
      const { client, files, ops } = makeAbortTestClient({ writeDelayMs: 20 });
      const conn = await makeArmedConn(client, { retainFiles });

      // 1. A connection-originated fault fire-and-forgets close() (parks on the
      //    abort decision) BEFORE the error reaches the orchestrator's catch.
      const mc = driveFault(
        conn,
        new ConnectionError("synthetic transport fault", "transport"),
      );

      // 2. The catch's single gated trigger.
      await conn.writeAbortMarker().catch(() => {});

      // 3. doCleanup: seal (a no-op now) then close the layers.
      conn.sealAbort();
      await mc.close();
      await conn.close();

      // The marker landed, with this party's self token in the envelope.
      const body = files.get(markerPath(conn));
      expect(body).toBeDefined();
      expect(JSON.parse(body!.toString())).toEqual({
        version: 1,
        token: toBase64Url(TOKEN_SELF),
      });

      // Assert WHICH resolution ran: the abort rename is in the op log (the
      // "write" decision fired), and it completed strictly before end() -- so a
      // forgotten-trigger or an end()-before-await regression is not green.
      const renameIdx = ops.indexOf(`rename:${markerName(conn)}`);
      const endIdx = ops.indexOf("end");
      expect(renameIdx).toBeGreaterThanOrEqual(0);
      expect(endIdx).toBeGreaterThanOrEqual(0);
      expect(renameIdx).toBeLessThan(endIdx);
    },
  );
}

// --- teardown signal: exempt the teardown re-dial from the reconnection cap ---

test("teardown is signaled to the transport before the marker write's put, and at close()", async () => {
  // A session-holding transport that bounds its mid-exchange reconnections caps the
  // number of re-dials; a teardown re-dial (the abort-marker write, the drain) must
  // be EXEMPT so the fast-fail marker still lands even when a capping server just
  // spent the budget. The write signals beginTeardown BEFORE issuing its put -- the
  // race-proof guarantee, because a catch-path write can run before close() sets
  // the flag -- and close() signals it too, for the terminal-frame drain.
  const { client, ops } = makeAbortTestClient();
  const conn = await makeArmedConn(client);

  await conn.writeAbortMarker().catch(() => {});
  const beginIdx = ops.indexOf("beginTeardown");
  const putIdx = ops.findIndex((o) => o.startsWith("put-start:"));
  expect(beginIdx).toBeGreaterThanOrEqual(0);
  expect(putIdx).toBeGreaterThanOrEqual(0);
  expect(beginIdx).toBeLessThan(putIdx);

  // A clean close (no fault, no marker) still signals teardown at its top.
  const { client: cleanClient, ops: cleanOps } = makeAbortTestClient();
  const cleanConn = await makeArmedConn(cleanClient);
  cleanConn.sealAbort();
  await cleanConn.close();
  expect(cleanOps).toContain("beginTeardown");
});

// --- echo path: a PeerAbortError must NOT trigger a marker write -------------

test("the echo path seals without writing a marker (the waiting party does not echo)", async () => {
  const { client, files, ops } = makeAbortTestClient({ writeDelayMs: 20 });
  const conn = await makeArmedConn(client);

  // The read side raised a verified PeerAbortError; the bridge
  // fire-and-forgets close(), which parks on the decision.
  const mc = driveFault(conn, new PeerAbortError());

  // The catch gate sees a PeerAbortError (errIsPeerAbort) and does NOT write.
  // doCleanup seals; close() proceeds promptly with no marker.
  conn.sealAbort();
  await mc.close();
  await conn.close();

  expect(files.has(markerPath(conn))).toBe(false);
  expect(ops.some((o) => o.startsWith("rename:"))).toBe(false);
});

// --- clean completion: seal, no marker, no grace delay -----------------------

test("clean completion seals the decision and closes without writing a marker", async () => {
  const { client, files } = makeAbortTestClient();
  const conn = await makeArmedConn(client);

  // No fault, so no fire-and-forget close(). doCleanup seals first, then closes.
  conn.sealAbort();
  await conn.close();

  expect(files.has(markerPath(conn))).toBe(false);
});

test("close() stops polling before it waits on the abort decision", async () => {
  const { client, files } = makeAbortTestClient();
  const conn = await makeArmedConn(client, { peerId: PEER_ID });
  conn.start();
  await new Promise((r) => setTimeout(r, 20));

  const closed = conn.close();
  // Let a poll already in flight when close() began finish.
  await new Promise((r) => setTimeout(r, 20));
  const body = serializeFileSyncMessage(
    MESSAGE_TYPE_OBJECT,
    0,
    Buffer.from(JSON.stringify({ late: true })),
  );
  const messagePath = `${TEST_DIR}/${PEER_ID}-${body.length}.json`;
  files.set(messagePath, body);
  await new Promise((r) => setTimeout(r, 50));

  expect(files.has(messagePath)).toBe(true);
  conn.sealAbort();
  await closed;
});

// --- short write budget: a hung write is abandoned, teardown still finishes ---

test("a hung marker write is abandoned within the short budget without hanging teardown", async () => {
  vi.useFakeTimers();
  try {
    const { client, files } = makeAbortTestClient({ hangWrite: true });
    // A 1-hour peer timeout: the marker write must NOT inherit it -- its own
    // few-second budget must win, which is the whole point of the short bound on
    // the local-FS/filedrop adapter (no per-op transport bound of its own).
    const conn = await makeArmedConn(client, {
      inactivityTimeoutMs: 60 * 60 * 1000,
    });

    const writeOutcome = conn.writeAbortMarker().then(
      () => "resolved",
      () => "rejected",
    );
    await vi.advanceTimersByTimeAsync(WRITE_BUDGET_MS + 50);
    expect(await writeOutcome).toBe("rejected");
    expect(files.has(markerPath(conn))).toBe(false);

    // close() (parked awaiting the now-rejected write) still completes.
    const closed = conn.close().then(() => "closed");
    await vi.advanceTimersByTimeAsync(WRITE_BUDGET_MS + 50);
    expect(await closed).toBe("closed");
  } finally {
    vi.useRealTimers();
  }
});

// --- read side: detect and verify a peer abort marker ------------------------

test("a valid peer abort marker raises a terminal PeerAbortError, never delivered as a message", async () => {
  const { client, files } = makeAbortTestClient();
  const conn = await makeArmedConn(client, { peerId: PEER_ID });
  plantPeerMarker(files, TOKEN_PEER);

  const data: unknown[] = [];
  conn.on("data", (d) => data.push(d));
  const errP = nextError(conn);
  conn.start();
  const err = await errP;
  conn.stop();

  expect(err).toBeInstanceOf(PeerAbortError);
  // Additive grammar: the marker is a control file (non-numeric terminal), so it
  // is never routed as a message.
  expect(data).toHaveLength(0);
});

test("a partner's abort frame waiting beside its marker fails the run with the frame's cause", async () => {
  const { client, files } = makeAbortTestClient();
  const conn = await makeArmedConn(client, { peerId: PEER_ID });
  plantPeerMarker(files, TOKEN_PEER);
  const frame = Buffer.from(
    JSON.stringify({
      linkageTerms: { identity: "Party B" },
      decision: "abort",
      abortReasons: ["partner record count out of range"],
      protocolVersion: PROTOCOL_VERSION,
    }),
  );
  const body = serializeFileSyncMessage(MESSAGE_TYPE_OBJECT, 0, frame);
  files.set(`${TEST_DIR}/${PEER_ID}-${body.length}.json`, body);

  // This party's own terms send is not under test: a delete-mode send waits
  // for the partner to consume the file, and no partner runs here. The
  // poller starts at that send, as it would once the terms are written.
  const bridged = fromEventConnection(conn);
  const mc: MessageConnection = {
    send: async () => {
      conn.start();
    },
    receive: (timeoutMs) => bridged.receive(timeoutMs),
    close: () => bridged.close(),
  };
  const terms = { identity: "Party A" } as unknown as LinkageTerms;
  const err = await exchangeTerms(mc, "initiator", terms, 1).catch(
    (e: unknown) => e,
  );
  conn.sealAbort();
  await mc.close();

  expect(err).not.toBeInstanceOf(PeerAbortError);
  const rendered = sanitizeErrorForDisplay(err);
  expect(rendered).toContain(
    "Your partner stopped the exchange at the linkage terms",
  );
  expect(rendered).toContain("partner record count out of range");
  expect(rendered).not.toContain(new PeerAbortError().message);
});

test("an absent marker leaves the poll loop unchanged (no error)", async () => {
  const { client } = makeAbortTestClient();
  const conn = await makeArmedConn(client, { peerId: PEER_ID });
  const errors = await pollAndCollectErrors(conn);
  expect(errors).toHaveLength(0);
});

test("an oversized planted marker is refused at the pre-get() size check and never read", async () => {
  const { client, files, ops } = makeAbortTestClient();
  const conn = await makeArmedConn(client, { peerId: PEER_ID });
  // Larger than ABORT_MARKER_MAX_BYTES (1 KiB), even though it would otherwise
  // verify: the listed-size gate must refuse it before any get().
  const huge = Buffer.alloc(2048, 0x20);
  Buffer.from(
    JSON.stringify({ version: 1, token: toBase64Url(TOKEN_PEER) }),
  ).copy(huge);
  files.set(peerMarkerPath, huge);

  const errors = await pollAndCollectErrors(conn);
  expect(errors).toHaveLength(0);
  expect(ops.some((o) => o === `get:${peerMarkerName}`)).toBe(false);
});

test("a marker listed at exactly the size cap is read and verified", async () => {
  const { client, files, ops } = makeAbortTestClient();
  const conn = await makeArmedConn(client, { peerId: PEER_ID });
  // The cap is the largest ACCEPTED size, so a marker sitting on it must still
  // be read: paired with the one-byte-over case below, this pins the comparison
  // as strictly-greater rather than greater-or-equal.
  plantPaddedPeerMarker(files, MARKER_MAX_BYTES);

  const errors = await pollAndCollectErrors(conn);
  expect(ops).toContain(`get:${peerMarkerName}`);
  expect(errors[0]).toBeInstanceOf(PeerAbortError);
});

test("a marker listed one byte over the size cap is refused before any get()", async () => {
  const { client, files, ops } = makeAbortTestClient();
  const conn = await makeArmedConn(client, { peerId: PEER_ID });
  plantPaddedPeerMarker(files, MARKER_MAX_BYTES + 1);

  const errors = await pollAndCollectErrors(conn);
  expect(errors).toHaveLength(0);
  expect(ops).not.toContain(`get:${peerMarkerName}`);
});

test("a malformed (non-JSON / wrong-version) marker is ignored", async () => {
  const { client, files } = makeAbortTestClient();
  const conn = await makeArmedConn(client, { peerId: PEER_ID });
  files.set(peerMarkerPath, Buffer.from("}{ not json"));
  expect(await pollAndCollectErrors(conn)).toHaveLength(0);

  files.set(
    peerMarkerPath,
    Buffer.from(JSON.stringify({ version: 2, token: toBase64Url(TOKEN_PEER) })),
  );
  expect(await pollAndCollectErrors(conn)).toHaveLength(0);
});

// --- reflection: a captured marker renamed to the other name does not validate

test("a self-role token presented as the peer marker does not validate (reflection)", async () => {
  // A `<self>-abort.json` captured and renamed to `<peerId>-abort.json`
  // holds the self-role token; the reader expects the peer-role token, so
  // it rejects.
  const { client, files } = makeAbortTestClient();
  const conn = await makeArmedConn(client, { peerId: PEER_ID });
  plantPeerMarker(files, TOKEN_SELF);
  expect(await pollAndCollectErrors(conn)).toHaveLength(0);
});

test("a token from a different session does not validate (no cross-session replay)", async () => {
  const { client, files } = makeAbortTestClient();
  const conn = await makeArmedConn(client, { peerId: PEER_ID });
  // A token unrelated to either armed token (a different session's ephemeral
  // key would produce exactly such an unrelated value).
  plantPeerMarker(files, new Uint8Array(32).fill(0x5a));
  expect(await pollAndCollectErrors(conn)).toHaveLength(0);
});

// --- unarmed window ----------------------------------------------------------

test("an unarmed reader recognizes (does not error on) a peer abort name but does not verify it", async () => {
  const { client, files } = makeAbortTestClient();
  // Not armed (no session key yet), strictest unexpected-files policy.
  const conn = await makeArmedConn(client, {
    peerId: PEER_ID,
    arm: false,
    unexpectedFiles: "error",
  });
  plantPeerMarker(files, TOKEN_PEER);
  // Recognized by exact name -> not an unexpected_files error; and unverified
  // (no key) -> no PeerAbortError either.
  const errors = await pollAndCollectErrors(conn);
  expect(errors).toHaveLength(0);
});

test("a foreign <other>-abort.json is not exempted and still hits the unexpected-files policy", async () => {
  const { client, files } = makeAbortTestClient();
  const conn = await makeArmedConn(client, {
    peerId: PEER_ID,
    unexpectedFiles: "error",
  });
  // An id that is neither self nor peer: exact-name recognition does not exempt
  // it, so the strict policy fires.
  files.set(
    `${TEST_DIR}/attacker-abort.json`,
    Buffer.from(JSON.stringify({ version: 1, token: toBase64Url(TOKEN_PEER) })),
  );
  const errors = await pollAndCollectErrors(conn);
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.every((e) => !(e instanceof PeerAbortError))).toBe(true);
});

// --- message suppression hook ------------------------------------------------

test("PeerAbortError states its own next step so the CLI suppresses the generic advisory", () => {
  // runProtocol reads this to skip the generic "retry without re-inviting"
  // advisory, leaving only the definitive message.
  expect(statesItsOwnNextStep(new PeerAbortError())).toBe(true);
});
