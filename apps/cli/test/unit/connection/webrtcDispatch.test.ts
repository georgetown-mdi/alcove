import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { vi, test, expect, beforeEach, afterEach } from "vitest";

import type {
  ExchangeResult,
  MessageConnection,
  PreparedExchange,
  TermsRotation,
} from "@alcove/core";
import type { KeyFile } from "../../../src/keyFile";

/**
 * `runProtocol`'s webrtc dispatch: the branch that runs the exchange over a data
 * channel instead of a shared folder.
 *
 * The wire below it is driven for real elsewhere -- two werift peers through the
 * vendored broker in test/integration/webrtc/transport.test.ts. What is only
 * observable here is what the dispatch itself decides: that it dials rather than
 * opening a file-sync connection, what it hands the rendezvous, which handshake
 * role each party takes from its configured one, and that the exchange runs
 * inside the application-layer AEAD wrap. The two parties run against
 * each other over a pair of in-memory connections, so the key exchange those
 * decisions feed is the real one.
 */

const mockState = vi.hoisted(() => ({
  /** Every rendezvous the dispatch asked for, in call order. */
  dials: [] as Array<Record<string, unknown>>,
  /** What each party asked the key exchange for, attributed to its side. */
  handshakes: [] as Array<{
    side: "inviter" | "acceptor";
    role: string;
    requestEncryption: boolean;
  }>,
  /** When set, the handshake result reports the application-layer encryption as not applied. */
  reportEncryptionOff: false,
  /** The connection each party's runExchange was handed. */
  exchangeConnections: [] as Array<unknown>,
  /** Every `log.info` line the run emitted, with its arguments joined as a console joins them. */
  logLines: [] as Array<string>,
  /** Every `log.warn` line, joined the same way. */
  warnLines: [] as Array<string>,
  /** Every WebSocket relay a run parked, none of which ever pairs. */
  parkedRelays: [] as Array<{ dial: unknown; closed: boolean }>,
  /** When set, the initiator stores and then reads the responder's abort
   * saying it could not save the next secret. */
  responderSaveFails: false,
  /** A key file path the rotated secret's save refuses. */
  unwritableKeyFilePath: undefined as string | undefined,
  /** When set, every rendezvous rejects with it. */
  dialFailure: undefined as Error | undefined,
}));

vi.mock("@openmined/psi.js", () => ({
  default: vi.fn().mockResolvedValue({}),
}));

// Keep the key exchange real: the role mapping is only meaningful if a genuine
// initiator/responder handshake completes over it. Capture the info lines (one
// of them is asserted below), silence the rest, and stub the PSI exchange, which
// would otherwise need the WASM stack and a dataset.
vi.mock("@alcove/core", async (importActual) => {
  const actual = await importActual<typeof import("@alcove/core")>();
  const { deriveNextSecret } = await import("@alcove/core/testing");
  const stubLinkageTerms = actual.getDefaultLinkageTerms("Acceptor");
  return {
    ...actual,
    getLogger: (_name: string) => ({
      info: (...parts: Array<unknown>) => {
        mockState.logLines.push(parts.map((part) => String(part)).join(" "));
      },
      warn: (...parts: Array<unknown>) => {
        mockState.warnLines.push(parts.map((part) => String(part)).join(" "));
      },
      error: () => {},
      debug: () => {},
      trace: () => {},
    }),
    authenticateConnection: vi.fn(
      async (
        connection: MessageConnection,
        params: Parameters<typeof actual.authenticateConnection>[1],
        role: Parameters<typeof actual.authenticateConnection>[2],
        requestEncryption: boolean,
        rotationState: Parameters<typeof actual.authenticateConnection>[4],
      ) => {
        // The linked pair below hands each party its own connection object, so
        // identity is what attributes a captured handshake to the side that ran
        // it -- the argument list itself has no party name.
        const side = connection === pair.inviter ? "inviter" : "acceptor";
        mockState.handshakes.push({ side, role, requestEncryption });
        const result = await actual.authenticateConnection(
          connection,
          params,
          role,
          requestEncryption,
          rotationState,
        );
        return mockState.reportEncryptionOff
          ? { ...result, applyEncryption: false }
          : result;
      },
    ),
    runExchange: vi.fn(async (...args: unknown[]) => {
      mockState.exchangeConnections.push(args[0]);
      // The real terms exchange stores the next secret through
      // `options.rotation`; a fixed responder value makes both sides agree.
      const rotation = (args[3] as { rotation?: TermsRotation }).rotation;
      if (rotation !== undefined) {
        const nextSecret = await deriveNextSecret(
          rotation.inputs.keyAgreementOutput,
          rotation.inputs.initiatorValue,
          new Uint8Array(32),
        );
        if (mockState.responderSaveFails && args[1] === "responder")
          rotation.partnerMayHoldNextSecret?.(true);
        await rotation.store(nextSecret);
        if (mockState.responderSaveFails && args[1] === "initiator")
          throw new actual.PeerAbortError(
            undefined,
            actual.NEXT_SECRET_STORE_FAILED_ABORT_REASON,
          );
      }
      return {
        associationTable: [[], []],
        intersectionCount: undefined,
        partnerTerms: stubLinkageTerms,
        matching: {
          localDeduplicate: false,
          partnerDeduplicate: false,
          cardinality: "one-to-one",
        },
        resolvedRole: "receiver",
        partnerPayload: { columns: [], rowIndices: [], rows: [] },
        recordOwedButUnbuilt: false,
      } satisfies ExchangeResult;
    }),
    describeExchangeStages: vi.fn().mockReturnValue([]),
    buildOutputTable: vi.fn().mockReturnValue({ headers: [], rows: [] }),
    assertFirstRoundWithinSetMaximum: vi.fn(
      actual.assertFirstRoundWithinSetMaximum,
    ),
  };
});

// The transport itself is stood up by its own suites; here it is replaced by a
// pair of in-memory connections so the dispatch's inputs and the handshake it
// drives are what the run depends on.
vi.mock(
  "../../../src/connection/webrtc/webrtcMessageConnection",
  async (importActual) => ({
    ...(await importActual<
      typeof import("../../../src/connection/webrtc/webrtcMessageConnection")
    >()),
    openWebRtcMessageConnection: vi.fn(
      async (options: Record<string, unknown>) => {
        mockState.dials.push(options);
        if (mockState.dialFailure !== undefined) throw mockState.dialFailure;
        return linkedConnection(options.role as "inviter" | "acceptor");
      },
    ),
  }),
);

// The rotated secret's save, real except at the one path a test names.
vi.mock("../../../src/keyFile", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/keyFile")>();
  return {
    ...actual,
    saveKeyFile: (...args: Parameters<typeof actual.saveKeyFile>) => {
      if (args[0] === mockState.unwritableKeyFilePath)
        throw new Error("EACCES: permission denied");
      actual.saveKeyFile(...args);
    },
  };
});

vi.mock(
  "../../../src/connection/webrtc/websocketRelayConnection",
  async (importActual) => ({
    ...(await importActual<
      typeof import("../../../src/connection/webrtc/websocketRelayConnection")
    >()),
    parkWebSocketRelay: vi.fn((dial: { url: string }) => {
      const record = { dial, closed: false };
      mockState.parkedRelays.push(record);
      return {
        url: dial.url,
        paired: false,
        partnerStarted: false,
        failure: undefined,
        onChange: () => () => {},
        start: () => new Promise<never>(() => {}),
        close: () => {
          record.closed = true;
        },
      };
    }),
  }),
);

// The SFTP adapter must never be constructed on this channel; importing the real
// one would also pull ssh2 into a suite that has no server.
vi.mock("../../../src/connection/ssh2SftpAdapter", () => ({
  SSH2SFTPClientAdapter: vi.fn(() => {
    throw new Error("the webrtc dispatch must not build an SFTP client");
  }),
}));

const { openWebRtcMessageConnection } =
  await import("../../../src/connection/webrtc/webrtcMessageConnection");
const { parkWebSocketRelay } =
  await import("../../../src/connection/webrtc/websocketRelayConnection");
const { runProtocol } = await import("../../../src/protocol");
const {
  webRtcDialFrom,
  WEBRTC_RENDEZVOUS_SECRET_REQUIRED,
  WEBRTC_ROLE_REQUIRED,
} = await import("../../../src/run/prepare");
const { WEBRTC_URL_REFUSED, WEBRTC_URL_EXTRAS_REFUSED } =
  await import("../../../src/connectionFromUrl");
const { BROKER_ADDRESS_REFUSED, ID_TAKEN_MESSAGE } =
  await import("../../../src/connection/webrtc/brokerClient");
const { exitCodeForError } = await import("../../../src/util/exit");
const {
  FINAL_ATTEMPT_STRETCH,
  WEBRTC_ATTEMPT_MS,
  WEBRTC_BROKER_HOST_REFUSED,
  WEBRTC_BROKER_PATH_REFUSED,
} = await import("../../../src/connection/webrtc/weriftPeer");
const { loadKeyFile, saveKeyFile } = await import("../../../src/keyFile");
const {
  FINAL_FRAME_UNCONFIRMED_LINK_LOST_MESSAGE,
  FinalFrameUnconfirmedError,
} = await import("../../../src/connection/webrtc/webrtcMessageConnection");
const { failureRemedy, OLDER_KEY_FILE_NO_SHOW_REMEDY } =
  await import("../../../src/failureRemedy");
const {
  ConnectionError,
  markFailureCause,
  NEW_INVITATION_REMEDY,
  DISPLAY_TRUNCATION_MARKER,
  EncryptedMessageConnection,
  RELAY_CREDENTIAL_MAX_TTL_SECONDS,
  UsageError,
  RoundSetLimitError,
  assertFirstRoundWithinSetMaximum,
  prepareForExchange,
  deriveRelayExchangeId,
  deriveRelayKey,
  generateSharedSecret,
  getDefaultLinkageTerms,
  mintRunRelayCredential,
  sanitizeErrorForDisplay,
} = await import("@alcove/core");
const { fakeRegistrar, jsonResponse, registrationAnswer } =
  await import("../relayRegistrarFake");
const { StandardizedDataset } = await import("@alcove/core/testing");

/**
 * A pair of connections wired to each other: what one sends the other receives,
 * in order. Enough for the key exchange, which is a strict lockstep of whole
 * values.
 */
function linkedPair(): Record<"inviter" | "acceptor", MessageConnection> {
  const queues: Record<string, Array<unknown>> = { inviter: [], acceptor: [] };
  const waiters: Record<string, Array<(value: unknown) => void>> = {
    inviter: [],
    acceptor: [],
  };
  const deliver = (to: string, value: unknown): void => {
    const waiter = waiters[to].shift();
    if (waiter) waiter(value);
    else queues[to].push(value);
  };
  const side = (self: string, peer: string): MessageConnection => ({
    send: async (value: unknown) => {
      deliver(peer, value);
    },
    receive: async () => {
      const queued = queues[self].shift();
      if (queued !== undefined) return queued;
      return new Promise((resolve) => waiters[self].push(resolve));
    },
    close: async () => {},
    setInboundFrameCap: () => {},
  });
  return {
    inviter: side("inviter", "acceptor"),
    acceptor: side("acceptor", "inviter"),
  };
}

let pair: ReturnType<typeof linkedPair>;
function linkedConnection(role: "inviter" | "acceptor"): MessageConnection {
  return pair[role];
}

const minimalPrepared = {
  metadata: [],
  linkageTerms: getDefaultLinkageTerms("Inviter"),
  dataset: new StandardizedDataset([], []),
  rawRows: [],
  rowCount: 0,
} satisfies PreparedExchange;
const SECRET = generateSharedSecret();

/** The cross-app conformance fixture: each rendezvous side's key-exchange
 * handshake role and request-encryption flag, pinned once for both apps. */
const interopVectors = JSON.parse(
  fs.readFileSync(
    new URL(
      "../../../../../packages/core/test/vectors/webrtc-interop-vectors.json",
      import.meta.url,
    ),
    { encoding: "utf8" },
  ),
) as {
  rendezvous: {
    sides: Array<{
      side: "inviter" | "acceptor";
      handshakeRole: string;
      requestEncryption: boolean;
    }>;
  };
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-webrtc-dispatch-"));
  pair = linkedPair();
  mockState.dials.length = 0;
  mockState.handshakes.length = 0;
  mockState.exchangeConnections.length = 0;
  mockState.reportEncryptionOff = false;
  mockState.logLines.length = 0;
  mockState.warnLines.length = 0;
  mockState.parkedRelays.length = 0;
  mockState.responderSaveFails = false;
  mockState.unwritableKeyFilePath = undefined;
  mockState.dialFailure = undefined;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

const BROKER_HOST = "peers.example.org";

function webrtcConnection(role: "inviter" | "acceptor", host = BROKER_HOST) {
  return {
    channel: "webrtc" as const,
    server: { host, port: 9000, secure: false },
    role,
    stun: ["stun:stun.example.org:3478"],
  };
}

/** Run one party end to end over the linked pair. */
function runParty(
  role: "inviter" | "acceptor",
  host = BROKER_HOST,
): Promise<unknown> {
  const keyFilePath = path.join(tmpDir, `${role}.key`);
  saveKeyFile(keyFilePath, { sharedSecret: SECRET });
  return runProtocol({
    connection: webrtcConnection(role, host),
    auth: { sharedSecret: SECRET, keyFilePath },
    prepared: minimalPrepared,
    output: path.join(tmpDir, `${role}.csv`),
    verbosity: -1,
    loggerName: "test",
  });
}

// --- the dispatch -----------------------------------------------------------

test("both parties complete an authenticated exchange over the data channel", async () => {
  await Promise.all([runParty("inviter"), runParty("acceptor")]);

  // The handshake ran for real: each side persisted a rotated token, which only
  // a completed key exchange over the paired transport can produce.
  for (const role of ["inviter", "acceptor"]) {
    const saved = JSON.parse(
      fs.readFileSync(path.join(tmpDir, `${role}.key`), "utf8"),
    ) as { sharedSecret: string };
    expect(saved.sharedSecret).not.toBe(SECRET);
  }
  expect(mockState.exchangeConnections).toHaveLength(2);
  // Each party checked its first round against the per-set maximum before
  // dialing.
  expect(vi.mocked(assertFirstRoundWithinSetMaximum)).toHaveBeenCalledTimes(2);
});

test("a run whose connection lists a WebSocket relay parks it under the derived id and closes it once WebRTC carries the exchange", async () => {
  await Promise.all(
    (["inviter", "acceptor"] as const).map((role) => {
      const keyFilePath = path.join(tmpDir, `${role}.key`);
      saveKeyFile(keyFilePath, { sharedSecret: SECRET });
      return runProtocol({
        connection: {
          ...webrtcConnection(role),
          websocketRelay: "wss://relay.example.org/relay",
        },
        auth: { sharedSecret: SECRET, keyFilePath },
        prepared: minimalPrepared,
        output: path.join(tmpDir, `${role}.csv`),
        verbosity: -1,
        loggerName: "test",
      });
    }),
  );
  expect(mockState.exchangeConnections).toHaveLength(2);
  const exchangeId = await deriveRelayExchangeId(SECRET);
  const relayKey = await deriveRelayKey(SECRET);
  expect(
    mockState.parkedRelays
      .map(({ dial }) => dial)
      .sort((a, b) =>
        String((a as { role: string }).role).localeCompare(
          String((b as { role: string }).role),
        ),
      ),
  ).toEqual(
    (["acceptor", "inviter"] as const).map((role) => ({
      url: "wss://relay.example.org/relay",
      exchangeId,
      relayKey,
      role,
    })),
  );
  expect(mockState.parkedRelays.every(({ closed }) => closed)).toBe(true);
  expect(
    mockState.logLines.filter(
      (line) => line === "the exchange runs over the WebRTC connection",
    ),
  ).toHaveLength(2);
});

test("a run whose connection lists no WebSocket relay parks none", async () => {
  await Promise.all([runParty("inviter"), runParty("acceptor")]);
  expect(vi.mocked(parkWebSocketRelay)).not.toHaveBeenCalled();
});

test("the configured role fixes the handshake role, complementary across the pair", async () => {
  await Promise.all([runParty("inviter"), runParty("acceptor")]);
  // The acceptor dials the channel and sends first, so it is the initiator; the
  // inviter listens and answers. A browser peer maps the two the same way, which
  // is what lets a CLI peer meet one.
  expect(mockState.handshakes.map((h) => h.role).sort()).toEqual([
    "initiator",
    "responder",
  ]);
});

test("both parties ask for the application-layer AEAD, and both wrap", async () => {
  await Promise.all([runParty("inviter"), runParty("acceptor")]);
  expect(mockState.handshakes).toHaveLength(2);
  expect(mockState.handshakes.every((h) => h.requestEncryption)).toBe(true);
  // The negotiated decision is what the exchange ran under: the connection
  // handed to runExchange is the AEAD decorator, not the transport itself.
  expect(mockState.exchangeConnections).toHaveLength(2);
  for (const connection of mockState.exchangeConnections) {
    expect(connection).toBeInstanceOf(EncryptedMessageConnection);
    expect([pair.inviter, pair.acceptor]).not.toContain(connection);
  }
});

test("each party's role and encryption request match the shared interop vectors", async () => {
  await Promise.all([runParty("inviter"), runParty("acceptor")]);
  // The two assertions above hold the CLI to its own reading of the pairing;
  // this one holds it to the shared cross-app vectors the web app's suite
  // asserts its own side against (apps/web/test/unit/psi/webrtcInterop.test.ts), so
  // the two apps cannot agree with themselves and disagree with each other. The
  // rest of the CLI's side of that fixture is driven in webrtcInterop.test.ts;
  // the request-encryption flag is only observable through a real handshake,
  // which this file already drives.
  const bySide = new Map(mockState.handshakes.map((h) => [h.side, h]));
  expect(bySide.size).toBe(interopVectors.rendezvous.sides.length);
  for (const side of interopVectors.rendezvous.sides)
    expect(bySide.get(side.side)).toMatchObject({
      role: side.handshakeRole,
      requestEncryption: side.requestEncryption,
    });
});

test("the rendezvous is dialed with the configured broker and ICE servers", async () => {
  await Promise.all([runParty("inviter"), runParty("acceptor")]);
  for (const dial of mockState.dials) {
    expect(dial.location).toEqual({
      host: "peers.example.org",
      port: 9000,
      path: "/",
      key: "peerjs",
      secure: false,
    });
    expect(dial.iceServers).toEqual([{ urls: ["stun:stun.example.org:3478"] }]);
    expect(dial.sharedSecret).toBe(SECRET);
  }
  expect(mockState.dials.map((d) => d.role).sort()).toEqual([
    "acceptor",
    "inviter",
  ]);
});

test("the rendezvous line names the authority dialed, not the configured text", async () => {
  // The URL parser rewrites a host before anything is dialed: it lowercases,
  // folds U+3002 onto the label separator, and deletes an ignorable such as
  // U+200B. Logging the configured text would name a server the run never
  // contacted -- and disagree with the socket's own authority check, which
  // compares against exactly this parsed form. Both are written as escapes
  // because one of the two is invisible in source.
  const host = "PEERS\u3002Example\u200B.ORG";
  await Promise.all([runParty("inviter", host), runParty("acceptor", host)]);
  const rendezvousLine = "connecting through the coordination server at";
  expect(
    mockState.logLines.filter((line) => line.startsWith(rendezvousLine)),
  ).toEqual([
    `${rendezvousLine} peers.example.org:9000`,
    `${rendezvousLine} peers.example.org:9000`,
  ]);
});

// --- a cut rotation and the run that heals it --------------------------------

test("a failed save on an inviter that cannot tell its acceptor keeps the secret the run used exits 77 and names a new invitation, and the acceptor, which kept it, exits 69", async () => {
  mockState.responderSaveFails = true;
  // The inviter takes the responder's handshake role; its key file is written
  // before the run starts, so the refusal is armed only once both are under way.
  const runs = [runParty("inviter"), runParty("acceptor")];
  mockState.unwritableKeyFilePath = path.join(tmpDir, "inviter.key");
  const [responder, initiator] = await Promise.allSettled(runs);

  // A browser acceptor keeps no previous secret, and this handshake looks the
  // same from a browser acceptor as from a CLI one.
  expect(responder.status).toBe("rejected");
  const responderReason = (responder as PromiseRejectedResult).reason as Error;
  expect(responderReason.message).toContain(
    "authentication succeeded and the shared token was rotated, but the " +
      "updated token could not be saved to ",
  );
  expect(responderReason.message).toContain(
    ` Your partner may already hold the rotated token. ${NEW_INVITATION_REMEDY}`,
  );
  expect(responderReason.message).not.toContain("kept the one this run used");
  expect(exitCodeForError(responderReason)).toBe(77);

  expect(initiator.status).toBe("rejected");
  const initiatorReason = (initiator as PromiseRejectedResult).reason as Error;
  expect(initiatorReason.message).toContain(
    "Your partner could not save the new shared secret, so the exchange " +
      "stopped. This side had already saved it to ",
  );
  expect(initiatorReason.message).toContain(
    ", and kept the secret this run used, so the next run can use that one.",
  );
  expect(exitCodeForError(initiatorReason)).toBe(69);
  const ahead = loadKeyFile(path.join(tmpDir, "acceptor.key"));
  expect(ahead?.sharedSecret).not.toBe(SECRET);
  expect(ahead?.previousSharedSecret).toBe(SECRET);
});

/** Run one party from the key file `keyFile`, saved first, over the linked pair. */
function runPartyFrom(
  role: "inviter" | "acceptor",
  keyFile: KeyFile,
  connection: Record<string, unknown> = {},
): Promise<unknown> {
  const keyFilePath = path.join(tmpDir, `${role}.key`);
  saveKeyFile(keyFilePath, keyFile);
  return runProtocol({
    connection: { ...webrtcConnection(role), ...connection },
    auth: {
      sharedSecret: keyFile.sharedSecret,
      keyFilePath,
      ...(keyFile.previousSharedSecret !== undefined && {
        previousSharedSecret: keyFile.previousSharedSecret,
      }),
      ...(keyFile.previousExpires !== undefined && {
        previousExpires: keyFile.previousExpires,
      }),
      ...(keyFile.rotationInFlightSince !== undefined && {
        rotationInFlightSince: keyFile.rotationInFlightSince,
      }),
    },
    prepared: minimalPrepared,
    output: path.join(tmpDir, `${role}.csv`),
    verbosity: -1,
    loggerName: "test",
  });
}

const AHEAD = generateSharedSecret();

test("a failed save on an inviter whose acceptor completed under its previous secret exits 69 and says the next run can use the secret this run used", async () => {
  mockState.responderSaveFails = true;
  const runs = [
    runPartyFrom("inviter", { sharedSecret: SECRET }),
    runPartyFrom("acceptor", {
      sharedSecret: AHEAD,
      previousSharedSecret: SECRET,
    }),
  ];
  mockState.unwritableKeyFilePath = path.join(tmpDir, "inviter.key");
  const [responder, initiator] = await Promise.allSettled(runs);

  expect(responder.status).toBe("rejected");
  const responderReason = (responder as PromiseRejectedResult).reason as Error;
  expect(responderReason.message).toContain(
    "Your partner saved the new token and kept the one this run used",
  );
  expect(responderReason.message).not.toContain(NEW_INVITATION_REMEDY);
  expect(exitCodeForError(responderReason)).toBe(69);

  expect(initiator.status).toBe("rejected");
  expect(exitCodeForError((initiator as PromiseRejectedResult).reason)).toBe(
    69,
  );
  // The acceptor kept the secret the inviter still holds, which the next run
  // meets it under.
  expect(loadKeyFile(path.join(tmpDir, "inviter.key"))?.sharedSecret).toBe(
    SECRET,
  );
  const ahead = loadKeyFile(path.join(tmpDir, "acceptor.key"));
  expect(ahead?.sharedSecret).not.toBe(SECRET);
  expect(ahead?.previousSharedSecret).toBe(SECRET);
});

test("an acceptor whose key file holds a previous secret waits under it too, and the run heals with an inviter left on it", async () => {
  await Promise.all([
    runPartyFrom("inviter", { sharedSecret: SECRET }),
    runPartyFrom("acceptor", {
      sharedSecret: AHEAD,
      previousSharedSecret: SECRET,
    }),
  ]);

  const acceptorDial = mockState.dials.find((dial) => dial.role === "acceptor");
  expect(acceptorDial?.sharedSecret).toBe(AHEAD);
  expect(acceptorDial?.previousSharedSecret).toBe(SECRET);
  const inviterDial = mockState.dials.find((dial) => dial.role === "inviter");
  expect(inviterDial).not.toHaveProperty("previousSharedSecret");
  expect(
    mockState.warnLines.filter((line) =>
      line.startsWith("The last run stopped before your partner saved"),
    ),
  ).toHaveLength(1);
  expect(
    mockState.warnLines.filter((line) =>
      line.startsWith("Your partner still had the shared secret"),
    ),
  ).toHaveLength(1);
  const acceptorFile = loadKeyFile(path.join(tmpDir, "acceptor.key"))!;
  const inviterFile = loadKeyFile(path.join(tmpDir, "inviter.key"))!;
  expect(acceptorFile.sharedSecret).toBe(inviterFile.sharedSecret);
  expect(acceptorFile.sharedSecret).not.toBe(SECRET);
  expect(acceptorFile.sharedSecret).not.toBe(AHEAD);
  // The stubbed exchange sends no frame after the terms exchange, so the
  // acceptor keeps the secret this run used until one confirms it.
  expect(acceptorFile.previousSharedSecret).toBe(SECRET);
  expect(inviterFile.previousSharedSecret).toBeUndefined();
});

test.each([
  ["an acceptor holding none", "acceptor", {}],
  ["an inviter holding one", "inviter", { previousSharedSecret: AHEAD }],
  [
    "an acceptor whose previous secret has expired",
    "acceptor",
    {
      previousSharedSecret: AHEAD,
      previousExpires: "2020-01-01T00:00:00.000Z",
    },
  ],
] as const)(
  "%s waits under the current secret alone",
  async (_case, role, previous) => {
    mockState.dialFailure = new ConnectionError("no partner", "transport");
    await runPartyFrom(role, { sharedSecret: SECRET, ...previous }).catch(
      () => {},
    );
    expect(mockState.dials).toHaveLength(1);
    expect(mockState.dials[0]).not.toHaveProperty("previousSharedSecret");
  },
);

test("an acceptor holding a previous secret parks a relay dialed under the derived id under that secret's id and key too, and a relay under a named id once", async () => {
  mockState.dialFailure = new ConnectionError("no partner", "transport");
  await runPartyFrom(
    "acceptor",
    { sharedSecret: AHEAD, previousSharedSecret: SECRET },
    {
      websocketRelay: "wss://relay.example.org/relay",
      invitationRelay: {
        websocket: "wss://partner-relay.example.net/relay",
        websocketExchangeId: "partner-exchange",
      },
    },
  ).catch(() => {});

  expect(mockState.parkedRelays.map(({ dial }) => dial)).toEqual([
    {
      url: "wss://relay.example.org/relay",
      exchangeId: await deriveRelayExchangeId(AHEAD),
      relayKey: await deriveRelayKey(AHEAD),
      role: "acceptor",
      afterCutRotation: true,
    },
    {
      url: "wss://partner-relay.example.net/relay",
      exchangeId: "partner-exchange",
      relayKey: await deriveRelayKey(AHEAD),
      role: "acceptor",
      afterCutRotation: true,
    },
    {
      url: "wss://relay.example.org/relay",
      exchangeId: await deriveRelayExchangeId(SECRET),
      relayKey: await deriveRelayKey(SECRET),
      role: "acceptor",
      afterCutRotation: true,
    },
  ]);
});

test.each([
  ["a key file holding a rotation-in-flight marker", true],
  ["a key file holding none", false],
] as const)(
  "an inviter from %s marks its relay dials as after a cut rotation accordingly",
  async (_case, marked) => {
    mockState.dialFailure = new ConnectionError("no partner", "transport");
    await runPartyFrom(
      "inviter",
      {
        sharedSecret: SECRET,
        ...(marked && { rotationInFlightSince: "2026-01-01T00:00:00.000Z" }),
      },
      { websocketRelay: "wss://relay.example.org/relay" },
    ).catch(() => {});
    const dials = mockState.parkedRelays.map(
      ({ dial }) => dial as Record<string, unknown>,
    );
    expect(dials).toHaveLength(1);
    if (marked) expect(dials[0]!.afterCutRotation).toBe(true);
    else expect(dials[0]).not.toHaveProperty("afterCutRotation");
  },
);

test.each([
  ["from an existing key file names", true, false],
  [
    "on the --invitation run that wrote its key file does not name",
    false,
    true,
  ],
] as const)(
  "a no-show %s an older copy of the key file",
  async (_case, namesOlderCopy, keyFileWrittenThisRun) => {
    mockState.dialFailure = markFailureCause(
      new ConnectionError("the partner did not arrive", "transport"),
      { kind: "partner-never-arrived", channel: "webrtc", waitedMs: 1_000 },
    );
    const keyFilePath = path.join(tmpDir, "no-show.key");
    saveKeyFile(keyFilePath, { sharedSecret: SECRET });
    const outcome = await Promise.allSettled([
      runProtocol({
        connection: webrtcConnection("acceptor"),
        auth: {
          sharedSecret: SECRET,
          keyFilePath,
          ...(keyFileWrittenThisRun && { keyFileWrittenThisRun }),
        },
        prepared: minimalPrepared,
        output: path.join(tmpDir, "out.csv"),
        verbosity: -1,
        loggerName: "test",
      }),
    ]);

    expect(outcome[0].status).toBe("rejected");
    const remedy = failureRemedy((outcome[0] as PromiseRejectedResult).reason);
    expect(remedy).toContain("--peer-timeout sets how long to wait.");
    if (namesOlderCopy) expect(remedy).toContain(OLDER_KEY_FILE_NO_SHOW_REMEDY);
    else expect(remedy).not.toContain(OLDER_KEY_FILE_NO_SHOW_REMEDY);
  },
);

/**
 * Trap the signal handler's `process.exit` and hand back a promise that
 * settles when it fires.
 *
 * The handler's cleanup is not awaited by the run it interrupts -- the run's
 * own cleanup returns at the once-only guard the moment either caller enters
 * it -- so the handler's exit lands on its own schedule, after `runProtocol`
 * has resolved. A case that restored the spy on that resolution alone would
 * leave the exit to reach the runner's real `process.exit` and report as an
 * unhandled rejection, at whatever tick the teardown happens to take.
 */
function captureSignalExit(): {
  exit: ReturnType<typeof vi.spyOn>;
  exited: Promise<void>;
} {
  let fired: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    fired = resolve;
  });
  const exit = vi.spyOn(process, "exit").mockImplementation((() => {
    fired();
    return undefined;
  }) as never);
  return { exit, exited };
}

test("a finished exchange whose last message the partner never confirmed warns the operator once", async () => {
  pair.inviter.close = async () => {
    throw new FinalFrameUnconfirmedError(
      FINAL_FRAME_UNCONFIRMED_LINK_LOST_MESSAGE,
    );
  };
  await Promise.all([runParty("inviter"), runParty("acceptor")]);
  const warning = sanitizeErrorForDisplay(
    new FinalFrameUnconfirmedError(FINAL_FRAME_UNCONFIRMED_LINK_LOST_MESSAGE),
  );
  expect(mockState.warnLines.filter((line) => line === warning)).toHaveLength(
    1,
  );
});

test("a handshake that completes without the encryption is refused and no exchange runs", async () => {
  mockState.reportEncryptionOff = true;
  const { ConnectionError } = await import("@alcove/core");
  const outcomes = await Promise.allSettled([
    runParty("inviter"),
    runParty("acceptor"),
  ]);
  for (const outcome of outcomes) {
    expect(outcome.status).toBe("rejected");
    const reason = (outcome as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(ConnectionError);
    expect(reason.kind).toBe("usage");
    expect(reason.message).toContain(
      "without the application-layer encryption",
    );
  }
  expect(mockState.exchangeConnections).toHaveLength(0);
});

test("any other close failure of a finished exchange is not raised to the operator", async () => {
  const { ConnectionError } = await import("@alcove/core");
  pair.inviter.close = async () => {
    throw new ConnectionError("the data channel did not close", "transport");
  };
  await Promise.all([runParty("inviter"), runParty("acceptor")]);
  expect(
    mockState.warnLines.some((line) =>
      line.includes("the data channel did not close"),
    ),
  ).toBe(false);
});

test("a signal during the rendezvous closes the channel it opened", async () => {
  // The interrupt handler's cleanup runs while the dial is still in flight, so
  // it finds no transport to close. Whatever the dial then returns would be left
  // standing -- a registered id and an open channel -- unless the dispatch closes
  // it itself once it has one.
  const keyFilePath = path.join(tmpDir, "signal.key");
  saveKeyFile(keyFilePath, { sharedSecret: SECRET });
  let closed = 0;
  vi.mocked(openWebRtcMessageConnection).mockImplementationOnce(async () => {
    process.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      ...pair.inviter,
      close: async () => {
        closed += 1;
      },
    };
  });
  // The signal handler exits the process on a real run; here it must return so
  // the run under test can finish.
  const { exit, exited } = captureSignalExit();
  try {
    await runProtocol({
      connection: webrtcConnection("inviter"),
      auth: { sharedSecret: SECRET, keyFilePath },
      prepared: minimalPrepared,
      output: path.join(tmpDir, "signal.csv"),
      verbosity: -1,
      loggerName: "test",
    });
    await exited;
  } finally {
    exit.mockRestore();
  }
  expect(closed).toBeGreaterThan(0);
  // And no handshake was attempted over it.
  expect(mockState.handshakes).toHaveLength(0);
});

test("a signal cancels a rendezvous that is still in flight", async () => {
  // The guard above can only act once the dial settles, and a rendezvous waiting
  // for a partner settles no sooner than its own budget -- ten minutes by
  // default -- so an interrupt during one would leave the broker socket and the
  // half-negotiated peer connection standing until then. The transport takes an
  // AbortSignal wired to fail-and-teardown for exactly this; what is asserted
  // here is that the run hands it one and that firing it is what ends the dial.
  const keyFilePath = path.join(tmpDir, "cancel.key");
  saveKeyFile(keyFilePath, { sharedSecret: SECRET });
  let dialSignal: AbortSignal | undefined;
  let toreDown = false;
  vi.mocked(openWebRtcMessageConnection).mockImplementationOnce(
    async (options) => {
      dialSignal = options.signal;
      // Stands in for the transport's own abort wiring: openWebRtcPeerSession
      // fails the negotiation and tears down what it built before rejecting.
      const cancelled = new Promise<MessageConnection>((_resolve, reject) => {
        // A dial handed no signal has nothing to end it, which is the defect
        // this covers; reject rather than park on it, so that case fails here
        // and now instead of spending the suite's timeout.
        if (options.signal === undefined) {
          reject(new Error("the rendezvous was handed no signal"));
          return;
        }
        options.signal.addEventListener(
          "abort",
          () => {
            toreDown = true;
            reject(new Error("the WebRTC rendezvous was cancelled"));
          },
          { once: true },
        );
      });
      process.emit("SIGINT");
      return await cancelled;
    },
  );
  const { exit, exited } = captureSignalExit();
  try {
    await runProtocol({
      connection: webrtcConnection("inviter"),
      auth: { sharedSecret: SECRET, keyFilePath },
      prepared: minimalPrepared,
      output: path.join(tmpDir, "cancel.csv"),
      verbosity: -1,
      loggerName: "test",
    });
    await exited;
  } finally {
    exit.mockRestore();
  }
  expect(dialSignal).toBeInstanceOf(AbortSignal);
  expect(dialSignal?.aborted).toBe(true);
  expect(toreDown).toBe(true);
  expect(mockState.handshakes).toHaveLength(0);
});

// --- the refusals -----------------------------------------------------------

test("a webrtc run with no shared secret is refused, naming the rendezvous", async () => {
  // The zero-setup shape: `auth: null`. The refusal has to say why the channel
  // cannot work without a secret, not report the channel as unsupported.
  await expect(
    runProtocol({
      connection: webrtcConnection("inviter"),
      auth: null,
      prepared: minimalPrepared,
      output: path.join(tmpDir, "out.csv"),
      verbosity: -1,
      loggerName: "test",
    }),
  ).rejects.toThrow(UsageError);
  expect(WEBRTC_RENDEZVOUS_SECRET_REQUIRED).toContain("shared secret");
  expect(WEBRTC_RENDEZVOUS_SECRET_REQUIRED).toContain("alcove invite");
  // Nothing was dialed: the resolution runs before the transport is touched.
  expect(mockState.dials).toHaveLength(0);
});

test("a webrtc connection with no role is refused before anything is dialed", async () => {
  const keyFilePath = path.join(tmpDir, "roleless.key");
  saveKeyFile(keyFilePath, { sharedSecret: SECRET });
  const { role: _dropped, ...roleless } = webrtcConnection("inviter");
  await expect(
    runProtocol({
      connection: roleless,
      auth: { sharedSecret: SECRET, keyFilePath },
      prepared: minimalPrepared,
      output: path.join(tmpDir, "out.csv"),
      verbosity: -1,
      loggerName: "test",
    }),
  ).rejects.toThrow(WEBRTC_ROLE_REQUIRED);
  expect(mockState.dials).toHaveLength(0);
});

test("a host the resolver admits but the authority parse refuses exits 64", async () => {
  // A host holding its own port is free of every delimiter the resolver's shape
  // refusal names, so it reaches the rendezvous line, where the authority parse
  // -- which refuses a host contributing a port, because that silently drops the
  // configured one -- is what stops it. That raise sits inside the run rather
  // than at the boundary the refusals above are decided at, and it reaches the
  // caller as a usage error only because the run's catch rethrows unmodified: a
  // wrap would exit 69 and set an unattended supervisor retrying a locator that
  // cannot resolve on any attempt.
  const error = await runParty("inviter", "peers.example.org:9000").then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(UsageError);
  expect(exitCodeForError(error)).toBe(64);
  expect((error as Error).message).toBe(BROKER_ADDRESS_REFUSED);
  expect(mockState.dials).toHaveLength(0);
});

test("a first round over the per-set maximum is refused before anything is dialed", async () => {
  // A dataset of 301 values held once each, checked against a bound of 300
  // values' frame, stands in for one past the real bound: the check's
  // arithmetic at that bound is core's to pin, and what the dispatch decides is
  // that the refusal comes before the rendezvous and exits 64.
  const names = Array.from(
    { length: 301 },
    (_unused, i) =>
      `zq${String.fromCharCode(97 + Math.floor(i / 26))}` +
      String.fromCharCode(97 + (i % 26)),
  );
  const prepared = prepareForExchange(
    {
      linkageTerms: {
        ...getDefaultLinkageTerms("Inviter"),
        linkageFields: [{ name: "firstName", type: "first_name" }],
        linkageKeys: [
          { name: "firstName", elements: [{ field: "firstName" }] },
        ],
      },
    },
    "Inviter",
    names.map((name) => ({ first_name: name })),
    ["first_name"],
  );
  const check = vi.mocked(assertFirstRoundWithinSetMaximum);
  const actual = check.getMockImplementation()!;
  check.mockImplementationOnce((checked) =>
    actual(checked, { maxValues: 300 }),
  );
  const keyFilePath = path.join(tmpDir, "inviter.key");
  saveKeyFile(keyFilePath, { sharedSecret: SECRET });
  const error = await runProtocol({
    connection: webrtcConnection("inviter"),
    auth: { sharedSecret: SECRET, keyFilePath },
    prepared,
    output: path.join(tmpDir, "inviter.csv"),
    verbosity: -1,
    loggerName: "test",
  }).then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(check).toHaveBeenCalledWith(prepared, expect.anything());
  expect(error).toBeInstanceOf(RoundSetLimitError);
  expect((error as Error).message).toMatch(/at least 301 values to send/);
  expect(exitCodeForError(error)).toBe(64);
  expect(mockState.dials).toHaveLength(0);
});

test("each refusal survives the display boundary whole", () => {
  // The remedy is the last sentence of every one of these, and the render
  // boundary truncates a link at DEFAULT_MAX_DISPLAY_LENGTH characters -- so a
  // message that grows past it loses exactly the part the operator acts on,
  // silently and only at the terminal.
  for (const message of [
    WEBRTC_RENDEZVOUS_SECRET_REQUIRED,
    WEBRTC_ROLE_REQUIRED,
    WEBRTC_URL_REFUSED,
    WEBRTC_URL_EXTRAS_REFUSED,
    ID_TAKEN_MESSAGE,
    WEBRTC_BROKER_HOST_REFUSED,
    WEBRTC_BROKER_PATH_REFUSED,
  ]) {
    expect(sanitizeErrorForDisplay(new UsageError(message))).not.toContain(
      DISPLAY_TRUNCATION_MARKER,
    );
  }
});

// --- the resolver -----------------------------------------------------------

test("an omitted server block resolves to the PeerJS defaults, over TLS", () => {
  const { options } = webRtcDialFrom(
    {
      channel: "webrtc",
      server: { host: "peers.example.org" },
      role: "inviter",
    },
    SECRET,
  );
  // Each default is the one a PeerJS client applies to the same omission, except
  // `secure`, which a browser takes from its page and the CLI cannot.
  expect(options.location).toEqual({
    host: "peers.example.org",
    port: 443,
    path: "/",
    key: "peerjs",
    secure: true,
  });
});

test("allowed_relays decides the TURN urls the dial lists, and the ones a failure names as left out", () => {
  const credential = {
    username: "1:alcove",
    credential: "placeholder-not-a-secret",
    expiresAt: new Date(1000),
  };
  const connection = {
    channel: "webrtc" as const,
    server: { host: "peers.example.org" },
    role: "acceptor" as const,
    invitationRelay: {
      turn: [
        "turns:left-out.example.org:443?transport=tcp",
        "turn:kept.example.org:3478",
      ],
    },
  };
  const { options } = webRtcDialFrom(
    { ...connection, allowedRelays: ["kept.example.org:3478"] },
    SECRET,
    credential,
  );
  expect(options.iceServers?.map((server) => server.urls)).toEqual([
    "turn:kept.example.org:3478",
  ]);
  expect(options.relaysLeftOut).toEqual([
    "turns:left-out.example.org:443?transport=tcp",
  ]);

  const unset = webRtcDialFrom(connection, SECRET, credential).options;
  expect(unset.iceServers?.map((server) => server.urls)).toEqual(
    connection.invitationRelay.turn,
  );
  expect(unset).not.toHaveProperty("relaysLeftOut");
  expect(unset).not.toHaveProperty("webSocketRelaysLeftOut");
  expect(
    webRtcDialFrom(
      {
        ...connection,
        websocketRelay: "wss://left-out.example.org/relay",
        allowedRelays: ["kept.example.org:3478"],
      },
      SECRET,
      credential,
    ).options.webSocketRelaysLeftOut,
  ).toEqual(["wss://left-out.example.org/relay"]);
});

test("a run whose every TURN url allowed_relays leaves out continues, naming them", () => {
  const credential = {
    username: "1:alcove",
    credential: "placeholder-not-a-secret",
    expiresAt: new Date(1000),
  };
  const turn = [{ url: "turn:relay.example.org" }];
  const base = {
    channel: "webrtc" as const,
    server: { host: "peers.example.org" },
    role: "acceptor" as const,
    turn,
    allowedRelays: ["other.example.org"],
  };
  const emptied = webRtcDialFrom(base, SECRET, credential).options;
  expect(emptied.iceServers ?? []).toEqual([]);
  expect(emptied.relaysLeftOut).toEqual([turn[0].url]);
  const withStun = webRtcDialFrom(
    { ...base, stun: ["stun:stun.example.org:3478"] },
    SECRET,
    credential,
  ).options;
  expect(withStun.iceServers).toEqual([
    { urls: ["stun:stun.example.org:3478"] },
  ]);
  expect(withStun.relaysLeftOut).toEqual([turn[0].url]);
});

test("a plaintext broker resolves to the plaintext default port", () => {
  const { options } = webRtcDialFrom(
    {
      channel: "webrtc",
      server: { host: "127.0.0.1", secure: false },
      role: "acceptor",
    },
    SECRET,
  );
  expect(options.location.port).toBe(80);
  expect(options.location.secure).toBe(false);
});

test("port 0 is refused rather than dialed", () => {
  // The connection schema admits it as a legal port number; nothing listens on
  // it, so dialing would report a connect failure instead of the misconfiguration.
  expect(() =>
    webRtcDialFrom(
      {
        channel: "webrtc",
        server: { host: "peers.example.org", port: 0 },
        role: "inviter",
      },
      SECRET,
    ),
  ).toThrow(UsageError);
});

test("a server path that could move the signaling socket is refused", () => {
  // Measured against Node's URL parser and WebSocket: concatenated into the
  // address, `@attacker.example` makes the configured host the userinfo of the
  // partner's, so the socket is dialed at the partner's host while the config --
  // and the run's own "rendezvousing through the signaling server at ..." line --
  // still name the legitimate broker. The path is partner-supplied on the
  // primary route: an offline accept builds the connection from the invitation's
  // endpoint, whose schema bounds `path` only by length.
  for (const serverPath of [
    "@attacker.example",
    "peerjs",
    "",
    "/api?x=1",
    "/api#f",
    "/api\\x",
    "/api ",
  ]) {
    expect(() =>
      webRtcDialFrom(
        {
          channel: "webrtc",
          server: { host: "peers.example.org", path: serverPath },
          role: "inviter",
        },
        SECRET,
      ),
    ).toThrow(WEBRTC_BROKER_PATH_REFUSED);
  }
});

test("a server host that could move the signaling socket is refused", () => {
  for (const host of [
    "broker.example:443@attacker.example",
    "peers.example.org/x",
    "peers.example.org?x",
    "peers.example.org#f",
    "peers.example.org\\x",
    "peers example org",
  ]) {
    expect(() =>
      webRtcDialFrom(
        {
          channel: "webrtc",
          server: { host },
          role: "inviter",
        },
        SECRET,
      ),
    ).toThrow(WEBRTC_BROKER_HOST_REFUSED);
  }
});

test("a mounted broker path still resolves", () => {
  // The refusals above bound the shape without costing the field its purpose: a
  // deployment mounted under a sub-path is what `path` is for.
  const { options } = webRtcDialFrom(
    {
      channel: "webrtc",
      server: { host: "peers.example.org", path: "/psi/signal" },
      role: "inviter",
    },
    SECRET,
  );
  expect(options.location.path).toBe("/psi/signal");
});

test("an injected path fails the run before anything is dialed", async () => {
  const keyFilePath = path.join(tmpDir, "injected.key");
  saveKeyFile(keyFilePath, { sharedSecret: SECRET });
  await expect(
    runProtocol({
      connection: {
        ...webrtcConnection("inviter"),
        server: {
          host: "peers.example.org",
          port: 9000,
          secure: false,
          path: "@attacker.example",
        },
      },
      auth: { sharedSecret: SECRET, keyFilePath },
      prepared: minimalPrepared,
      output: path.join(tmpDir, "injected.csv"),
      verbosity: -1,
      loggerName: "test",
    }),
  ).rejects.toThrow(UsageError);
  expect(mockState.dials).toHaveLength(0);
});

test("peer_timeout_ms bounds the rendezvous and inactivity_timeout_ms the open channel", () => {
  // The partner's arrival and a present partner's silence are separate
  // settings, each reaching only its own wait.
  const { options } = webRtcDialFrom(
    {
      channel: "webrtc",
      server: { host: "peers.example.org" },
      role: "inviter",
      options: { peerTimeoutMs: 90_000, inactivityTimeoutMs: 45_000 },
    },
    SECRET,
  );
  expect(options.rendezvousTimeoutMs).toBe(90_000);
  expect(options.inactivityTimeoutMs).toBe(45_000);
});

test("either setting alone leaves the other wait on the transport default", () => {
  const arrivalOnly = webRtcDialFrom(
    {
      channel: "webrtc",
      server: { host: "peers.example.org" },
      role: "inviter",
      options: { peerTimeoutMs: 90_000 },
    },
    SECRET,
  ).options;
  expect(arrivalOnly.rendezvousTimeoutMs).toBe(90_000);
  expect(arrivalOnly).not.toHaveProperty("inactivityTimeoutMs");
  const silenceOnly = webRtcDialFrom(
    {
      channel: "webrtc",
      server: { host: "peers.example.org" },
      role: "inviter",
      options: { inactivityTimeoutMs: 45_000 },
    },
    SECRET,
  ).options;
  expect(silenceOnly.inactivityTimeoutMs).toBe(45_000);
  expect(silenceOnly).not.toHaveProperty("rendezvousTimeoutMs");
});

test("no setting reaches the channel-open budget", () => {
  // Once both descriptions are exchanged the partner is present, so a channel
  // that does not open is a network path failure held to the transport's
  // fixed ceiling, whatever the two waits around it are set to.
  for (const options of [
    {},
    { peerTimeoutMs: 7 * 24 * 60 * 60 * 1000 },
    { inactivityTimeoutMs: 7 * 24 * 60 * 60 * 1000 },
    { peerTimeoutMs: 1_000, inactivityTimeoutMs: 1_000 },
  ])
    expect(
      webRtcDialFrom(
        {
          channel: "webrtc",
          server: { host: "peers.example.org" },
          role: "acceptor",
          options,
        },
        SECRET,
      ).options,
    ).not.toHaveProperty("channelOpenTimeoutMs");
});

const MINTING_RELAY = { turn: ["turns:relay.example:443?transport=tcp"] };

/** The expiry, in epoch seconds, a minted TURN username leads with. */
function mintedExpirySeconds(servers: Array<{ username?: string }>): number {
  const [turn] = servers.filter((server) => server.username !== undefined);
  return Number(turn.username?.split(":")[0]);
}

test("a minting run dials each later connection attempt with a fresh credential", async () => {
  const startedAt = Date.now();
  const credential = await mintRunRelayCredential(SECRET, new Date(startedAt));
  const { options } = webRtcDialFrom(
    {
      channel: "webrtc",
      server: { host: "peers.example.org" },
      role: "acceptor",
      invitationRelay: MINTING_RELAY,
      options: { peerTimeoutMs: 2 * RELAY_CREDENTIAL_MAX_TTL_SECONDS * 1000 },
    },
    SECRET,
    credential,
  );
  const nextAttemptAt = startedAt + WEBRTC_ATTEMPT_MS;
  vi.useFakeTimers({ toFake: ["Date"], now: nextAttemptAt });
  let next: { iceServers: Array<{ username?: string }>; notice: string };
  try {
    next = (await options.attemptIceServers?.({
      kind: "partner-not-connected",
      waitedMs: WEBRTC_ATTEMPT_MS,
    })) ?? {
      iceServers: [],
      notice: "",
    };
  } finally {
    vi.useRealTimers();
  }
  expect(mintedExpirySeconds(next.iceServers)).toBe(
    Math.floor(nextAttemptAt / 1000) + RELAY_CREDENTIAL_MAX_TTL_SECONDS,
  );
  expect(mintedExpirySeconds(next.iceServers) * 1000).toBeGreaterThan(
    credential.expiresAt.getTime(),
  );
  expect(next.notice).toContain(
    `expires at ${new Date(mintedExpirySeconds(next.iceServers) * 1000).toISOString()}`,
  );
  expect(next.notice).toContain(`within ${WEBRTC_ATTEMPT_MS / 60_000} minutes`);
  // Minting logs nothing: the notice is the wait's to log as the attempt starts.
  expect(
    mockState.logLines.some((line) =>
      line.includes("starts with a new relay credential"),
    ),
  ).toBe(false);
});

test("an attempt, the last one stretched included, runs at most a quarter of the relay credential's lifetime", () => {
  expect(WEBRTC_ATTEMPT_MS * FINAL_ATTEMPT_STRETCH).toBeLessThanOrEqual(
    (RELAY_CREDENTIAL_MAX_TTL_SECONDS * 1000) / 4,
  );
});

test("a run presenting no minted credential mints nothing per attempt", () => {
  const { options } = webRtcDialFrom(
    {
      channel: "webrtc",
      server: { host: "peers.example.org" },
      role: "acceptor",
      options: { peerTimeoutMs: 2 * RELAY_CREDENTIAL_MAX_TTL_SECONDS * 1000 },
    },
    SECRET,
  );
  expect(options).not.toHaveProperty("attemptIceServers");
});

test("an unset options block leaves all three transport defaults in place", () => {
  const { options } = webRtcDialFrom(
    {
      channel: "webrtc",
      server: { host: "peers.example.org" },
      role: "inviter",
    },
    SECRET,
  );
  expect(options.inactivityTimeoutMs).toBeUndefined();
  expect(options.rendezvousTimeoutMs).toBeUndefined();
  expect(options.channelOpenTimeoutMs).toBeUndefined();
});

// --- the invitation relay's registrar ---------------------------------------

const INVITATION_REGISTRAR = "https://default-relay.example.net";

const OWN_TURN_URL = "turns:own-relay.example.org:443?transport=tcp";

const INVITATION_TURN_URL = "turns:default-relay.example.net:443?transport=tcp";

/** Run the pair, the acceptor's connection naming an invitation relay with a
 * registrar and, with `ownTurn`, that `turn` entry of its own, against a
 * registrar that answers with `answers`. With `invitationWebSocket` the
 * invitation relay names that WebSocket relay url too, with
 * `invitationWebSocketExchangeId` beside it, and `allowedRelays` sets the
 * acceptor's setting. */
async function runPairEnrollingAt(
  answers: Response[],
  {
    ownTurn,
    invitationWebSocket,
    invitationWebSocketExchangeId,
    allowedRelays,
  }: {
    ownTurn?: { url: string; username?: string; credential?: string };
    invitationWebSocket?: string;
    invitationWebSocketExchangeId?: string;
    allowedRelays?: string[];
  } = {},
) {
  const registrar = fakeRegistrar(answers);
  const acceptorDialsAtEachRequest: number[] = [];
  vi.stubGlobal("fetch", (async (...args: Parameters<typeof fetch>) => {
    acceptorDialsAtEachRequest.push(
      mockState.dials.filter((dial) => dial.role === "acceptor").length,
    );
    return registrar.fetch(...args);
  }) as typeof fetch);
  const keyFilePath = path.join(tmpDir, "acceptor.key");
  saveKeyFile(keyFilePath, { sharedSecret: SECRET });
  try {
    await Promise.all([
      runParty("inviter"),
      runProtocol({
        connection: {
          ...webrtcConnection("acceptor"),
          ...(ownTurn !== undefined && { turn: [ownTurn] }),
          ...(allowedRelays !== undefined && { allowedRelays }),
          invitationRelay: {
            turn: [INVITATION_TURN_URL],
            ...(invitationWebSocket !== undefined && {
              websocket: invitationWebSocket,
            }),
            ...(invitationWebSocketExchangeId !== undefined && {
              websocketExchangeId: invitationWebSocketExchangeId,
            }),
            registrar: INVITATION_REGISTRAR,
          },
        },
        auth: { sharedSecret: SECRET, keyFilePath },
        prepared: minimalPrepared,
        output: path.join(tmpDir, "acceptor.csv"),
        verbosity: -1,
        loggerName: "test",
      }),
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
  return { requests: registrar.requests, acceptorDialsAtEachRequest };
}

test("a run whose invitation relay names a registrar enrolls there once, without a token, before it dials", async () => {
  const { requests, acceptorDialsAtEachRequest } = await runPairEnrollingAt([
    registrationAnswer(null, "2026-01-01T01:10:00Z"),
  ]);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    url: `${INVITATION_REGISTRAR}/exchanges/${await deriveRelayExchangeId(SECRET)}`,
    method: "POST",
    authorization: null,
  });
  expect(JSON.parse(requests[0]!.body)).toEqual({
    key: await deriveRelayKey(SECRET),
    maxAgeDays: null,
  });
  expect(acceptorDialsAtEachRequest).toEqual([0]);
  const acceptorDial = mockState.dials.find((dial) => dial.role === "acceptor");
  expect(
    (acceptorDial?.iceServers as Array<{ urls: unknown }>).map(
      ({ urls }) => urls,
    ),
  ).toContain("turns:default-relay.example.net:443?transport=tcp");
  expect(
    mockState.logLines.some((line) =>
      line.includes(
        `the relay registrar at ${INVITATION_REGISTRAR} that your partner's ` +
          "invitation names enrolled this exchange, until 2026-01-01T01:10:00Z",
      ),
    ),
  ).toBe(true);
  expect(
    mockState.logLines.some((line) =>
      line.endsWith(
        "The run presents it to, and allocates its relay on, the first " +
          "TURN server your partner's invitation named, at " +
          "turns:default-relay.example.net:443?transport=tcp.",
      ),
    ),
  ).toBe(true);
});

test("a run whose own url-only turn entry names the invitation's url enrolls at its registrar", async () => {
  const { requests, acceptorDialsAtEachRequest } = await runPairEnrollingAt(
    [registrationAnswer(null, "2026-01-01T01:10:00Z")],
    { ownTurn: { url: INVITATION_TURN_URL } },
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    url: `${INVITATION_REGISTRAR}/exchanges/${await deriveRelayExchangeId(SECRET)}`,
    method: "POST",
    authorization: null,
  });
  expect(acceptorDialsAtEachRequest).toEqual([0]);
  expect(
    mockState.logLines.some((line) =>
      line.startsWith(
        "the relay registrar that your partner's invitation names was not",
      ),
    ),
  ).toBe(false);
});

test("a run whose own turn entry names the invitation's url with a static pair contacts no invitation registrar and says why", async () => {
  const { requests } = await runPairEnrollingAt([], {
    ownTurn: {
      url: INVITATION_TURN_URL,
      username: "operator",
      credential: "own-secret",
    },
  });
  expect(requests).toHaveLength(0);
  expect(mockState.logLines).toContain(
    "the relay registrar that your partner's invitation names was not " +
      "contacted, because this run presents your own turn entry's " +
      `credential to the relay it allocates on, at ${INVITATION_TURN_URL}`,
  );
});

test("a run with a turn entry of its own contacts no invitation registrar and says why", async () => {
  const { requests } = await runPairEnrollingAt([], {
    ownTurn: { url: OWN_TURN_URL },
  });
  expect(requests).toHaveLength(0);
  expect(mockState.logLines).toContain(
    "the relay registrar that your partner's invitation names was not " +
      "contacted, because this run allocates its relay on a relay the " +
      `invitation did not name, at ${OWN_TURN_URL}`,
  );
  expect(
    mockState.logLines.some((line) => line.includes(INVITATION_REGISTRAR)),
  ).toBe(false);
  expect(
    mockState.logLines.some((line) =>
      line.endsWith(
        "The run presents it to, and allocates its relay on, your own TURN " +
          `server at ${OWN_TURN_URL}. The other urls listed, ` +
          "turns:default-relay.example.net:443?transport=tcp, are " +
          "configured to take the credential, and the run does not contact " +
          "them.",
      ),
    ),
  ).toBe(true);
  const acceptorDial = mockState.dials.find((dial) => dial.role === "acceptor");
  expect(
    (acceptorDial?.iceServers as Array<{ urls: unknown }>).map(
      ({ urls }) => urls,
    ),
  ).toEqual(
    expect.arrayContaining([
      OWN_TURN_URL,
      "turns:default-relay.example.net:443?transport=tcp",
    ]),
  );
});

test("a run dialing the invitation's WebSocket relay, allocating on its own turn entry, enrolls at the invitation registrar once", async () => {
  const { requests, acceptorDialsAtEachRequest } = await runPairEnrollingAt(
    [registrationAnswer(null, "2026-01-01T01:10:00Z")],
    {
      ownTurn: { url: OWN_TURN_URL },
      invitationWebSocket: "wss://default-relay.example.net/relay",
    },
  );
  expect(requests).toHaveLength(1);
  expect(acceptorDialsAtEachRequest).toEqual([0]);
  expect(
    mockState.logLines.some((line) =>
      line.startsWith(
        "the relay registrar that your partner's invitation names was not",
      ),
    ),
  ).toBe(false);
});

test("a run proving to the invitation's WebSocket relay under the inviter's own id, on no TURN relay, contacts no invitation registrar and says why", async () => {
  const { requests } = await runPairEnrollingAt([], {
    invitationWebSocket: "wss://ws-relay.example.net/relay",
    invitationWebSocketExchangeId: "inviter-id",
    allowedRelays: ["ws-relay.example.net"],
  });
  expect(requests).toHaveLength(0);
  expect(mockState.logLines).toContain(
    "the relay registrar that your partner's invitation names was not " +
      "contacted, because this run allocates on no TURN relay, and proves " +
      "to the invitation's WebSocket relay under the exchange id your " +
      "partner enrolled there",
  );
});

test("a run whose own turn entry is left out by allowed_relays, with no WebSocket relay kept, states no WebSocket reason", async () => {
  const { requests } = await runPairEnrollingAt([], {
    ownTurn: { url: INVITATION_TURN_URL },
    allowedRelays: ["unrelated.example.org"],
  });
  expect(requests).toHaveLength(0);
  expect(
    mockState.logLines.some((line) =>
      line.includes("proves to the invitation's WebSocket relay"),
    ),
  ).toBe(false);
});

test("a run listing the invitation's WebSocket relay url, allocating on the invitation's TURN url, enrolls once", async () => {
  const { requests } = await runPairEnrollingAt(
    [registrationAnswer(null, "2026-01-01T01:10:00Z")],
    { invitationWebSocket: "wss://default-relay.example.net/relay" },
  );
  expect(requests).toHaveLength(1);
});

test("a refused enrollment is warned about and the run goes on to dial", async () => {
  const { requests } = await runPairEnrollingAt([
    jsonResponse(409, { error: "the exchange holds another key" }),
  ]);
  expect(requests).toHaveLength(1);
  expect(mockState.dials.map((dial) => dial.role).sort()).toEqual([
    "acceptor",
    "inviter",
  ]);
  expect(mockState.warnLines).toContain(
    `the relay registrar at ${INVITATION_REGISTRAR} that your partner's ` +
      "invitation names did not enroll this exchange (HTTP 409: the exchange " +
      "holds another key). The run continues with its other relays, and " +
      "that relay takes it only if your partner enrolled the exchange there.",
  );
});

test("a run whose invitation relay names no registrar enrolls nowhere", async () => {
  const registrar = fakeRegistrar([]);
  vi.stubGlobal("fetch", registrar.fetch);
  try {
    await Promise.all([runParty("inviter"), runParty("acceptor")]);
  } finally {
    vi.unstubAllGlobals();
  }
  expect(registrar.requests).toHaveLength(0);
});

test("an acceptor holding a previous secret enrolls the key and derived id of both secrets at the invitation registrar", async () => {
  mockState.dialFailure = new ConnectionError("no partner", "transport");
  const registrar = fakeRegistrar([
    registrationAnswer(null, "2026-01-01T01:10:00Z"),
    registrationAnswer(null, "2026-01-01T01:10:00Z"),
  ]);
  vi.stubGlobal("fetch", registrar.fetch);
  try {
    await runPartyFrom(
      "acceptor",
      { sharedSecret: AHEAD, previousSharedSecret: SECRET },
      {
        invitationRelay: {
          turn: [INVITATION_TURN_URL],
          registrar: INVITATION_REGISTRAR,
        },
      },
    ).catch(() => {});
  } finally {
    vi.unstubAllGlobals();
  }
  const enrolled = registrar.requests.map((request) => ({
    url: request.url,
    key: (JSON.parse(request.body) as { key: string }).key,
  }));
  expect(enrolled).toEqual(
    expect.arrayContaining(
      await Promise.all(
        [AHEAD, SECRET].map(async (secret) => ({
          url: `${INVITATION_REGISTRAR}/exchanges/${await deriveRelayExchangeId(secret)}`,
          key: await deriveRelayKey(secret),
        })),
      ),
    ),
  );
  expect(enrolled).toHaveLength(2);
});

test("each enrollment line of an acceptor holding a previous secret names the secret it enrolled", async () => {
  mockState.dialFailure = new ConnectionError("no partner", "transport");
  const previousUrl = `${INVITATION_REGISTRAR}/exchanges/${await deriveRelayExchangeId(SECRET)}`;
  vi.stubGlobal("fetch", (async (input: string | URL | Request) =>
    String(input) === previousUrl
      ? jsonResponse(409, { error: "held" })
      : registrationAnswer(
          null,
          "2026-01-01T01:10:00Z",
        )) as typeof globalThis.fetch);
  try {
    await runPartyFrom(
      "acceptor",
      { sharedSecret: AHEAD, previousSharedSecret: SECRET },
      {
        invitationRelay: {
          turn: [INVITATION_TURN_URL],
          registrar: INVITATION_REGISTRAR,
        },
      },
    ).catch(() => {});
  } finally {
    vi.unstubAllGlobals();
  }
  expect(mockState.logLines).toContain(
    `for the current shared secret, the relay registrar at ` +
      `${INVITATION_REGISTRAR} that your partner's invitation names enrolled ` +
      "this exchange, until 2026-01-01T01:10:00Z",
  );
  expect(mockState.warnLines).toContain(
    "for the shared secret from before a run that stopped partway, the " +
      `relay registrar at ${INVITATION_REGISTRAR} that your partner's ` +
      "invitation names did not enroll this exchange (HTTP 409: held). The " +
      "run continues with its other relays, and that relay takes it only if " +
      "your partner enrolled the exchange there.",
  );
});
