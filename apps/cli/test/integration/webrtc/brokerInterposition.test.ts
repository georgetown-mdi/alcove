import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";

import {
  ConnectionError,
  classifyFailure,
  firstLinkBehindTransportWraps,
  generateSharedSecret,
  prepareForExchange,
} from "@alcove/core";
import {
  AEAD_ENVELOPE_VERSION,
  classifyInboundValue,
  concatChunks,
  unpackFrame,
  withCapturedLogs,
} from "@alcove/core/testing";

import { saveKeyFile } from "../../../src/keyFile";
import { runProtocol } from "../../../src/protocol";
import { snapshotDiagnosticSinkAndLevel } from "../../loggingTestSupport";
import { firstNameTerms, waitFor } from "../../support";
import { startInterposingBroker } from "./interposingBroker";
import { startRefusingStunServer } from "./refusingStunServer";

import type { Metadata, PreparedExchange } from "@alcove/core";
import type { ProtocolConnectionConfig } from "../../../src/protocol";
import type {
  DatagramRewrite,
  DatagramSender,
  InterposingBroker,
  RelayedDatagram,
} from "./interposingBroker";
import type { RefusingStunServer } from "./refusingStunServer";

/**
 * Two real CLI parties run a whole exchange through `runProtocol` over the
 * webrtc channel, meeting through a coordination server that answers each of
 * them with a peer connection of its own and copies every data-channel datagram
 * between them ({@link startInterposingBroker}). DTLS then ends at that server
 * on both sides, so what it can read is what the application-layer AEAD wrap
 * leaves readable.
 */

// Pairings: CLI-to-CLI here; browser-to-browser in apps/web/test/browser/invitedPSI.test.ts; CLI-to-browser in apps/web `test:live-webrtc`.

const mockState = vi.hoisted(() => ({
  /** Each party's own request-encryption argument, as `runProtocol` passed it. */
  requested: [] as Array<boolean>,
  /** When set, both parties' requests are replaced with `false`. */
  forceRequestEncryptionOff: false,
}));

vi.mock("@alcove/core", async (importActual) => {
  const actual = await importActual<typeof import("@alcove/core")>();
  return {
    ...actual,
    authenticateConnection: (
      ...[
        connection,
        params,
        role,
        requestEncryption,
        rotationState,
      ]: Parameters<typeof actual.authenticateConnection>
    ) => {
      mockState.requested.push(requestEncryption);
      return actual.authenticateConnection(
        connection,
        params,
        role,
        mockState.forceRequestEncryptionOff ? false : requestEncryption,
        rotationState,
      );
    },
  };
});

snapshotDiagnosticSinkAndLevel();

/** A payload value no coordination server should ever read. */
const PAYLOAD_MARKER = "interposition-payload-7f3c9a";

const linkageColumn: Metadata[number] = {
  name: "first_name",
  type: "first_name",
  role: "linkage",
  isPayload: false,
};
const payloadColumn: Metadata[number] = {
  name: "case_note",
  type: "other",
  role: "payload",
  isPayload: true,
};

/** Discloses {@link PAYLOAD_MARKER} on a matched row. */
function inviterPrepared(): PreparedExchange {
  return prepareForExchange(
    {
      metadata: [linkageColumn, payloadColumn],
      linkageTerms: { ...firstNameTerms, identity: "Inviter" },
    },
    "Inviter",
    [
      { first_name: "Bob", case_note: PAYLOAD_MARKER },
      { first_name: "Carol", case_note: "other" },
      { first_name: "Dave", case_note: "other" },
    ],
    ["first_name", "case_note"],
  );
}

function acceptorPrepared(): PreparedExchange {
  return prepareForExchange(
    {
      metadata: [linkageColumn],
      linkageTerms: { ...firstNameTerms, identity: "Acceptor" },
    },
    "Acceptor",
    [{ first_name: "Bob" }, { first_name: "Carol" }],
    ["first_name"],
  );
}

let stun: RefusingStunServer;
let broker: InterposingBroker | undefined;
let work: string;

beforeAll(async () => {
  stun = await startRefusingStunServer();
}, 30_000);

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-interposition-"));
  mockState.requested.length = 0;
  mockState.forceRequestEncryptionOff = false;
});

afterEach(async () => {
  await broker?.stop();
  broker = undefined;
  fs.rmSync(work, { recursive: true, force: true });
});

afterAll(async () => {
  await stun?.stop();
});

/** Run both parties through the interposing server, settling each. */
async function runThroughBroker(
  rewrite?: DatagramRewrite,
): Promise<Record<DatagramSender, PromiseSettledResult<unknown>>> {
  broker = await startInterposingBroker({
    iceServers: stun.iceServers,
    ...(rewrite === undefined ? {} : { rewrite }),
  });
  const secret = generateSharedSecret();
  const connection = (role: DatagramSender): ProtocolConnectionConfig => ({
    channel: "webrtc",
    server: {
      host: broker!.location.host,
      port: broker!.location.port,
      path: broker!.location.path,
      secure: false,
    },
    role,
    stun: stun.iceServers.map((server) => String(server.urls)),
    options: { peerTimeoutMs: 60_000, inactivityTimeoutMs: 60_000 },
  });
  const party = (role: DatagramSender, prepared: PreparedExchange) => {
    const keyFilePath = path.join(work, `${role}.key`);
    saveKeyFile(keyFilePath, { sharedSecret: secret });
    return runProtocol({
      connection: connection(role),
      auth: { sharedSecret: secret, keyFilePath },
      prepared,
      output: path.join(work, `${role}-out`),
      verbosity: -1,
      loggerName: `interposition-${role}`,
    });
  };
  // The plaintext-signaling warning and a failed run's own error lines are the
  // run's to print; this file asserts on what crossed the server instead.
  const [[inviter, acceptor]] = await withCapturedLogs(
    () =>
      Promise.allSettled([
        party("inviter", inviterPrepared()),
        party("acceptor", acceptorPrepared()),
      ]),
    (level) => level === "WARN" || level === "ERROR",
  );
  return { inviter, acceptor };
}

/** The result CSV a party wrote under its output folder. */
async function resultOf(role: DatagramSender): Promise<string> {
  const folder = path.join(work, `${role}-out`);
  let result: string | undefined;
  await waitFor(
    () => {
      const name = fs
        .readdirSync(folder)
        .find((entry) => entry.startsWith("alcove-results-"));
      if (name === undefined) return false;
      result = fs.readFileSync(path.join(folder, name), "utf8");
      return result.length > 0;
    },
    { timeoutMs: 5_000, what: `the ${role}'s result` },
  );
  return result!;
}

/** One application frame a party sent, reassembled from its datagrams. */
interface SentFrame {
  from: DatagramSender;
  value: unknown;
}

/** Reassemble the relayed datagrams into the application frames they carry. */
function applicationFrames(
  relayed: ReadonlyArray<RelayedDatagram>,
): Array<SentFrame> {
  const frames: Array<SentFrame> = [];
  const pending = new Map<string, Array<Uint8Array>>();
  for (const { from, bytes } of relayed) {
    const inbound = classifyInboundValue(unpackFrame(Uint8Array.from(bytes)));
    if (inbound.kind === "close") continue;
    if (inbound.kind === "data") {
      frames.push({ from, value: inbound.value });
      continue;
    }
    const key = `${from}:${inbound.messageId}`;
    const parts = pending.get(key) ?? [];
    parts[inbound.index] = inbound.data;
    pending.set(key, parts);
    if (parts.filter((part) => part !== undefined).length === inbound.total) {
      pending.delete(key);
      frames.push({ from, value: unpackFrame(concatChunks(parts)) });
    }
  }
  return frames;
}

function isKexMessage(value: unknown): boolean {
  return typeof value === "object" && value !== null && "kexMsg" in value;
}

function isAeadEnvelope(value: unknown): boolean {
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : undefined;
  return bytes !== undefined && bytes[0] === AEAD_ENVELOPE_VERSION;
}

function relayedMarker(relayed: ReadonlyArray<RelayedDatagram>): number {
  const marker = Buffer.from(PAYLOAD_MARKER, "utf8");
  return relayed.filter((datagram) => datagram.bytes.includes(marker)).length;
}

test("with the request forced off on both parties, each run is refused and no payload crosses the server", async () => {
  mockState.forceRequestEncryptionOff = true;
  const settled = await runThroughBroker();
  for (const party of [settled.inviter, settled.acceptor]) {
    expect(party.status).toBe("rejected");
    const reason = (party as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(ConnectionError);
    expect(reason.kind).toBe("usage");
    expect(reason.message).toContain(
      "without the application-layer encryption",
    );
  }
  // Each party asked for the wrap; only the override above withdrew it.
  expect(mockState.requested).toEqual([true, true]);
  expect(relayedMarker(broker!.relayed())).toBe(0);
}, 120_000);

test("on the CLI's own path, no frame after the key exchange crosses the server outside an envelope", async () => {
  const settled = await runThroughBroker();
  expect(settled.inviter.status).toBe("fulfilled");
  expect(settled.acceptor.status).toBe("fulfilled");
  expect(mockState.requested).toEqual([true, true]);
  expect(await resultOf("acceptor")).toContain(PAYLOAD_MARKER);

  expect(relayedMarker(broker!.relayed())).toBe(0);
  const frames = applicationFrames(broker!.relayed());
  for (const from of ["inviter", "acceptor"] as const) {
    const sent = frames.filter((frame) => frame.from === from);
    const kexCount = sent.findIndex((frame) => !isKexMessage(frame.value));
    expect(kexCount).toBeGreaterThan(0);
    const afterKex = sent.slice(kexCount);
    expect(afterKex.length).toBeGreaterThan(0);
    expect(afterKex.every((frame) => isAeadEnvelope(frame.value))).toBe(true);
  }
}, 120_000);

test("an envelope the server alters ends the receiving party's run as a security failure", async () => {
  let altered = false;
  const flipLastByteOfFirstAcceptorEnvelope: DatagramRewrite = (
    from,
    bytes,
  ) => {
    if (altered || from !== "acceptor") return bytes;
    const inbound = classifyInboundValue(unpackFrame(Uint8Array.from(bytes)));
    if (inbound.kind !== "data" || !isAeadEnvelope(inbound.value)) return bytes;
    altered = true;
    // An unchunked binary frame ends with the envelope's own last byte, which
    // is the GCM tag's.
    const copy = Buffer.from(bytes);
    copy[copy.length - 1] ^= 0x01;
    return copy;
  };
  const settled = await runThroughBroker(flipLastByteOfFirstAcceptorEnvelope);
  expect(altered).toBe(true);
  expect(settled.inviter.status).toBe("rejected");
  const reason = (settled.inviter as PromiseRejectedResult).reason as unknown;
  const link = firstLinkBehindTransportWraps(reason);
  expect(link).toBeInstanceOf(ConnectionError);
  expect((link as ConnectionError).kind).toBe("security");
  expect(classifyFailure(reason)).toBe("trust-check-failed");
  expect(settled.acceptor.status).toBe("rejected");
  expect(relayedMarker(broker!.relayed())).toBe(0);
}, 120_000);
