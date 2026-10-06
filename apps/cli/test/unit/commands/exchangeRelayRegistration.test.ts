import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import YAML from "yaml";
import { deriveRelayKey, relayRegistrarAuthorization } from "@alcove/core";
import type { PreparedExchange } from "@alcove/core";

import { PERSISTENCE_LOSS_EXIT_CODE } from "@alcove/cli-contract";

import { handler } from "../../../src/commands/exchange";
import { loadKeyFile, saveKeyFile } from "../../../src/keyFile";
import { runProtocol, type RunProtocolOptions } from "../../../src/protocol";
import { captureProcessExit } from "../../exitCapture";
import {
  fakeRegistrar,
  jsonResponse,
  registrationAnswer,
  type RecordedRegistrarRequest,
} from "../relayRegistrarFake";

// The exchange command's use of the relay registrar, driven through its
// handler with the exchange itself stubbed: the retry of an unconfirmed
// registration before the run dials, and the registration of the rotated key
// the run makes afterwards. relayRegistrar.test.ts covers the requests
// themselves.

const logged = vi.hoisted(() => ({ errors: [] as string[] }));

vi.mock("@alcove/core", async (importActual) => {
  const actual = await importActual<typeof import("@alcove/core")>();
  return {
    ...actual,
    getLogger: () => ({
      info: () => {},
      debug: () => {},
      trace: () => {},
      warn: () => {},
      error: (msg: string) => logged.errors.push(msg),
    }),
    prepareForExchange: vi.fn(
      () =>
        ({
          metadata: [],
          linkageTerms: {
            version: "1.0.0",
            date: "2025-01-01",
            algorithm: "psi",
            linkageStrategy: "cascade",
            output: { expectsOutput: true, shareWithPartner: false },
            deduplicate: false,
            linkageFields: [],
            linkageKeys: [],
          },
          dataset: new actual.StandardizedDataset([], []),
          rawRows: [],
          rowCount: 0,
        }) satisfies PreparedExchange,
    ),
  };
});

vi.mock("../../../src/protocol", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/protocol")>();
  return { runProtocol: vi.fn(), preflightRun: vi.fn(actual.preflightRun) };
});

vi.mock("../../../src/hostKeyTrust", () => ({
  establishHostKeyTrust: vi.fn(),
  assertHostKeyTrustCanBeEstablished: vi.fn(),
}));

const PRE_ROTATION = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ROTATED = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM";
const PENDING_SINCE = "2026-01-01T00:00:00.000Z";

const linkageTerms = {
  version: "1.0.0",
  identity: "Test Party",
  date: "2025-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

function writeConfig(connection: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      connection: {
        channel: "webrtc",
        server: { host: "peers.example.org" },
        role: "inviter",
        turn: [{ url: "turns:relay.example.org:443?transport=tcp" }],
        relay_registrar: {
          url: "https://relay.example.org:8443",
          exchange_id: "exchange-1",
        },
        ...connection,
      },
      authentication: { token_max_age_days: 30 },
      linkage_terms: linkageTerms,
    }),
  );
}

let dir: string;
let configFile: string;
let keyFile: string;
let input: string;
let exitSpy: ReturnType<typeof captureProcessExit>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-exchange-relay-"));
  configFile = path.join(dir, "alcove.yaml");
  keyFile = path.join(dir, ".alcove.key");
  input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "ssn\n123456789\n");
  logged.errors.length = 0;
  vi.mocked(runProtocol).mockReset();
  exitSpy = captureProcessExit();
  process.exitCode = undefined;
});

afterEach(() => {
  exitSpy.mockRestore();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

function useRegistrar(answers: Response[]): RecordedRegistrarRequest[] {
  const registrar = fakeRegistrar(answers);
  vi.stubGlobal("fetch", registrar.fetch);
  return registrar.requests;
}

function runHandler(): Promise<void> {
  return handler({
    _: [],
    $0: "alcove",
    input,
    "config-file": configFile,
    "key-file": keyFile,
    "log-level": "silent",
  } as unknown as Arguments);
}

/** A stubbed run that rotates the key file as the key exchange does. */
function rotateLikeTheKeyExchange(options: RunProtocolOptions): void {
  saveKeyFile(keyFile, {
    sharedSecret: ROTATED,
    ...(options.auth?.relayRegistrationFollows === true && {
      relayRegistrationPendingSince: new Date().toISOString(),
    }),
  });
}

async function expectSignedWithPreRotationKey(
  request: RecordedRegistrarRequest,
): Promise<void> {
  const timestamp = /ts=(\d+),/.exec(request.authorization ?? "")?.[1];
  expect(timestamp).toBeDefined();
  expect(request.authorization).toBe(
    await relayRegistrarAuthorization({
      relayKey: await deriveRelayKey(PRE_ROTATION),
      method: "PUT",
      exchangeId: "exchange-1",
      body: request.body,
      now: new Date(Number(timestamp) * 1000),
    }),
  );
  expect(JSON.parse(request.body)).toEqual({
    key: await deriveRelayKey(ROTATED),
    maxAgeDays: 30,
  });
}

test("an unconfirmed registration the registrar refuses stops the run with 77 before it dials", async () => {
  writeConfig();
  saveKeyFile(keyFile, {
    sharedSecret: PRE_ROTATION,
    relayRegistrationPendingSince: PENDING_SINCE,
  });
  const requests = useRegistrar([
    jsonResponse(409, { error: "the proof does not verify" }),
  ]);
  await expect(runHandler()).rejects.toThrow("exit:77");
  expect(runProtocol).not.toHaveBeenCalled();
  expect(requests).toHaveLength(1);
  expect(requests[0]!.authorization).toMatch(/^Alcove-Relay-Proof /);
  expect(loadKeyFile(keyFile)).toEqual({
    sharedSecret: PRE_ROTATION,
    relayRegistrationPendingSince: PENDING_SINCE,
  });
});

test("an unconfirmed registration the registrar confirms is cleared, and the run dials", async () => {
  writeConfig();
  saveKeyFile(keyFile, {
    sharedSecret: PRE_ROTATION,
    relayRegistrationPendingSince: PENDING_SINCE,
  });
  const requests = useRegistrar([registrationAnswer()]);
  let keyFileAtDial: unknown;
  vi.mocked(runProtocol).mockImplementationOnce(async () => {
    keyFileAtDial = loadKeyFile(keyFile);
    return { outcome: "completed" };
  });
  await runHandler();
  expect(keyFileAtDial).toEqual({ sharedSecret: PRE_ROTATION });
  expect(JSON.parse(requests[0]!.body).key).toBe(
    await deriveRelayKey(PRE_ROTATION),
  );
  expect(exitSpy).not.toHaveBeenCalled();
});

test("after the run, the rotated key is registered signed with the pre-rotation key", async () => {
  writeConfig();
  saveKeyFile(keyFile, { sharedSecret: PRE_ROTATION });
  const requests = useRegistrar([registrationAnswer()]);
  vi.mocked(runProtocol).mockImplementationOnce(async (options) => {
    expect(options.auth?.relayRegistrationFollows).toBe(true);
    rotateLikeTheKeyExchange(options);
    await options.fileSyncRuntime?.onRemoteFollowUp?.();
    return { outcome: "completed" };
  });
  await runHandler();
  expect(requests).toHaveLength(1);
  await expectSignedWithPreRotationKey(requests[0]!);
  expect(loadKeyFile(keyFile)).toEqual({ sharedSecret: ROTATED });
  expect(process.exitCode).toBeUndefined();
});

test("a refused registration after a completed run reports 73, keeps the rotated secret, and leaves the retry pending", async () => {
  writeConfig();
  saveKeyFile(keyFile, { sharedSecret: PRE_ROTATION });
  useRegistrar([jsonResponse(409, { error: "not enrolled" })]);
  vi.mocked(runProtocol).mockImplementationOnce(async (options) => {
    rotateLikeTheKeyExchange(options);
    await options.fileSyncRuntime?.onRemoteFollowUp?.();
    return { outcome: "completed" };
  });
  await runHandler();
  expect(process.exitCode).toBe(PERSISTENCE_LOSS_EXIT_CODE);
  const after = loadKeyFile(keyFile);
  expect(after?.sharedSecret).toBe(ROTATED);
  expect(after?.relayRegistrationPendingSince).toBeDefined();
  expect(
    logged.errors.some((m) =>
      m.includes("alcove enroll-relay --replace-relay-key"),
    ),
  ).toBe(true);
});

test("a run that fails after rotating still registers the rotated key", async () => {
  writeConfig();
  saveKeyFile(keyFile, { sharedSecret: PRE_ROTATION });
  const requests = useRegistrar([registrationAnswer()]);
  vi.mocked(runProtocol).mockImplementationOnce(async (options) => {
    rotateLikeTheKeyExchange(options);
    throw Object.assign(new Error("partner went away"), { exitCode: 69 });
  });
  await expect(runHandler()).rejects.toThrow("exit:69");
  expect(requests).toHaveLength(1);
  await expectSignedWithPreRotationKey(requests[0]!);
  expect(loadKeyFile(keyFile)).toEqual({ sharedSecret: ROTATED });
});

test("a run relaying through the invitation's relay registers nothing", async () => {
  writeConfig({
    invitation_relay: { turn: ["turns:partner.example.org:443"] },
  });
  saveKeyFile(keyFile, {
    sharedSecret: PRE_ROTATION,
    relayRegistrationPendingSince: PENDING_SINCE,
  });
  const requests = useRegistrar([]);
  vi.mocked(runProtocol).mockImplementationOnce(async (options) => {
    expect(options.auth?.relayRegistrationFollows).toBeUndefined();
    expect(options.fileSyncRuntime?.onOutputComplete).toBeUndefined();
    expect(options.fileSyncRuntime?.onRemoteFollowUp).toBeUndefined();
    rotateLikeTheKeyExchange(options);
    return { outcome: "completed" };
  });
  await runHandler();
  expect(requests).toHaveLength(0);
});
