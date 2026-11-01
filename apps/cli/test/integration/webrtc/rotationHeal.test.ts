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
} from "vitest";

import {
  deriveHistoryVerifier,
  generateSharedSecret,
  prepareForExchange,
} from "@alcove/core";
import { withCapturedLogs } from "@alcove/core/testing";

import { loadKeyFile, saveKeyFile } from "../../../src/keyFile";
import { runProtocol } from "../../../src/protocol";
import { snapshotDiagnosticSinkAndLevel } from "../../loggingTestSupport";
import { startBrokerProcess } from "../../signaling/brokerProcess";
import { firstNameTerms } from "../../support";
import { startRefusingStunServer } from "./refusingStunServer";

import type { KeyFile } from "../../../src/keyFile";
import type { EventStreamEmitter } from "../../../src/eventStream";
import type { ProtocolConnectionConfig } from "../../../src/protocol";
import type { BrokerProcess } from "../../signaling/brokerProcess";
import type { RefusingStunServer } from "./refusingStunServer";
import type { Metadata, PreparedExchange } from "@alcove/core";

/**
 * The run after one cut between the two saves of a rotation, over WebRTC: two
 * real CLI parties run a whole exchange through `runProtocol`, meeting through
 * the repository's broker, from the key files such a cut leaves. The acceptor,
 * the side that saved first, holds the next secret and the one before it; the
 * inviter holds the one before it alone, and derives its rendezvous id from it
 * (docs/spec/PROTOCOL.md, "WebRTC rendezvous peer-id derivation").
 */

snapshotDiagnosticSinkAndLevel();

const linkageColumn: Metadata[number] = {
  name: "first_name",
  type: "first_name",
  role: "linkage",
  isPayload: false,
};

function prepared(identity: string, names: string[]): PreparedExchange {
  return prepareForExchange(
    {
      metadata: [linkageColumn],
      linkageTerms: { ...firstNameTerms, identity },
    },
    identity,
    names.map((first_name) => ({ first_name })),
    ["first_name"],
  );
}

const AHEAD_WARNING_START =
  "The last run stopped before your partner saved the new shared secret";
const BEHIND_WARNING_START =
  "Your partner still had the shared secret from before your last run";

let stun: RefusingStunServer;
let broker: BrokerProcess;
let work: string;

beforeAll(async () => {
  stun = await startRefusingStunServer();
  broker = await startBrokerProcess();
}, 60_000);

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-webrtc-heal-"));
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

afterAll(async () => {
  await broker?.stop();
  await stun?.stop();
});

type Role = "inviter" | "acceptor";

function recordingEmitter(sink: Array<[string, string]>): EventStreamEmitter {
  return new Proxy({} as EventStreamEmitter, {
    get: (_target, name) =>
      name === "warning"
        ? (source: string, message: string) => sink.push([source, message])
        : () => {},
  });
}

/** Run both parties from the key files given, settling each. */
async function runBoth(keyFiles: Record<Role, KeyFile>): Promise<{
  settled: Record<Role, PromiseSettledResult<unknown>>;
  heals: Record<Role, string[]>;
}> {
  const connection = (role: Role): ProtocolConnectionConfig => ({
    channel: "webrtc",
    server: {
      host: "127.0.0.1",
      port: broker.port,
      path: broker.path,
      key: broker.key,
      secure: false,
    },
    role,
    stun: stun.iceServers.map((server) => String(server.urls)),
    options: { peerTimeoutMs: 60_000, inactivityTimeoutMs: 60_000 },
  });
  const emitted: Record<Role, Array<[string, string]>> = {
    inviter: [],
    acceptor: [],
  };
  const party = (role: Role, data: PreparedExchange) => {
    const keyFilePath = path.join(work, `${role}.key`);
    const keyFile = keyFiles[role];
    saveKeyFile(keyFilePath, keyFile);
    return runProtocol({
      connection: connection(role),
      auth: {
        sharedSecret: keyFile.sharedSecret,
        keyFilePath,
        previousSharedSecret: keyFile.previousSharedSecret,
        rotationHistory: keyFile.rotationHistory,
      },
      prepared: data,
      output: path.join(work, `${role}-out`),
      verbosity: -1,
      loggerName: `webrtc-heal-${role}`,
      fileSyncRuntime: { eventStream: recordingEmitter(emitted[role]) },
    });
  };
  // The plaintext-signaling warning and the heal's own warning are the run's
  // to print; this file reads the heal from the event stream instead.
  const [[inviter, acceptor]] = await withCapturedLogs(
    () =>
      Promise.allSettled([
        party("inviter", prepared("Inviter", ["Bob", "Carol"])),
        party("acceptor", prepared("Acceptor", ["Bob", "Dave"])),
      ]),
    (level) => level === "WARN" || level === "ERROR",
  );
  const healsOf = (role: Role) =>
    emitted[role]
      .filter(([source]) => source === "rotationHeal")
      .map(([, message]) => message);
  return {
    settled: { inviter, acceptor },
    heals: { inviter: healsOf("inviter"), acceptor: healsOf("acceptor") },
  };
}

function keyFileOf(role: Role): KeyFile {
  return loadKeyFile(path.join(work, `${role}.key`))!;
}

test("the run after a cut meets the inviter left on the secret before it, completes, and both report the heal", async () => {
  const before = generateSharedSecret();
  const retired = [{ verifier: await deriveHistoryVerifier(before) }];

  const { settled, heals } = await runBoth({
    acceptor: {
      sharedSecret: generateSharedSecret(),
      previousSharedSecret: before,
      rotationHistory: retired,
    },
    inviter: {
      sharedSecret: before,
      rotationInFlightSince: new Date().toISOString(),
    },
  });

  expect(settled.inviter.status).toBe("fulfilled");
  expect(settled.acceptor.status).toBe("fulfilled");
  expect(heals.acceptor).toHaveLength(1);
  expect(heals.acceptor[0]).toMatch(new RegExp(`^${AHEAD_WARNING_START}`));
  expect(heals.inviter).toHaveLength(1);
  expect(heals.inviter[0]).toMatch(new RegExp(`^${BEHIND_WARNING_START}`));
  const acceptor = keyFileOf("acceptor");
  const inviter = keyFileOf("inviter");
  expect(acceptor.sharedSecret).toBe(inviter.sharedSecret);
  expect(acceptor.sharedSecret).not.toBe(before);
  for (const file of [acceptor, inviter]) {
    expect(file.previousSharedSecret).toBeUndefined();
    expect(file.rotationInFlightSince).toBeUndefined();
    expect(file.rotationHistory).toEqual(retired);
  }
}, 180_000);

test("an acceptor still holding the secret before one both saved meets its partner under the current one, reports no heal, and drops it", async () => {
  const current = generateSharedSecret();

  const { settled, heals } = await runBoth({
    acceptor: {
      sharedSecret: current,
      previousSharedSecret: generateSharedSecret(),
    },
    inviter: { sharedSecret: current },
  });

  expect(settled.inviter.status).toBe("fulfilled");
  expect(settled.acceptor.status).toBe("fulfilled");
  expect(heals).toEqual({ inviter: [], acceptor: [] });
  const acceptor = keyFileOf("acceptor");
  expect(acceptor.sharedSecret).toBe(keyFileOf("inviter").sharedSecret);
  expect(acceptor.sharedSecret).not.toBe(current);
  expect(acceptor.previousSharedSecret).toBeUndefined();
}, 180_000);
