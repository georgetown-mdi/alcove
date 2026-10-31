import { afterEach, describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import { getDefaultLinkageTerms, runExchange } from "@alcove/core";

import {
  StandardizedDataset,
  minimalExchangeResult,
  minimalPreparedExchange,
} from "@alcove/core/testing";

import {
  openOneShotPeerConnection,
  runExchangeLifecycle,
} from "../../../src/psi/exchangeLifecycle.js";
import { beginManagedRendezvous } from "../../../src/psi/managed/managedRendezvous.js";
import { createPooledBrowserPsiEngineFactory } from "../../../src/psi/workers/psiWorkerPool.js";
import { defaultSpawnPsiCryptoWorker } from "../../../src/psi/workers/psiCryptoWorkerClient.js";
import { openPeerMessageConnection } from "../../../src/psi/transport/peerMessageConnection.js";
import { runManagedExchangeInBrowser } from "../../../src/psi/managed/managedRunDriver.js";

import type { DataConnection } from "peerjs";
import type Peer from "peerjs";

import type * as AlcoveCore from "@alcove/core";
import type { MessageConnection, PsiBackendSelection } from "@alcove/core";

import type { ManagedInputSource } from "../../../src/psi/managed/managedInputHandle.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type { RunOutputs } from "@psi/runOutputs";
import type { RunnableManagedExchangeRecord } from "../../../src/psi/managed/managedExchangeRecord.js";

/**
 * The PSI engine factory both web exchange paths run: the attended exchange and
 * the scheduled run each take it from `browserPsiEngineFactory()`, which builds
 * the pool this browser's platform and core count give over `navigator`. Every
 * boundary around `runExchange` is mocked, and the pool module is replaced by a
 * recognizable factory, so a path that builds its factory any other way (one
 * hard-coded worker, a fixed pool size) hands `runExchange` a different value.
 */

/** The factory the mocked pool module returns, compared by identity. */
const POOLED_FACTORY = vi.hoisted(() => vi.fn());

const OUTPUTS: RunOutputs = vi.hoisted(() => ({
  kind: "matched" as const,
  resultsUrl: "blob:results",
}));

vi.mock(
  "../../../src/psi/workers/psiWorkerPool.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    createPooledBrowserPsiEngineFactory: vi.fn(() => POOLED_FACTORY),
  }),
);
vi.mock("../../../src/psi/transport/peerMessageConnection.js", () => ({
  openPeerMessageConnection: vi.fn(),
}));
vi.mock("../../../src/psi/authenticateExchange.js", () => ({
  authenticateExchange: vi.fn((connection: MessageConnection) =>
    Promise.resolve({
      sessionKey: new Uint8Array(32),
      nextSecretInputs: {
        sessionKey: new Uint8Array(32),
        keyAgreementOutput: new Uint8Array(32),
        initiatorValue: new Uint8Array(32),
        expires: undefined,
      },
      applyEncryption: true,
      negotiated: { kex: 3, protocol: 1, envelope: 1 },
      connection,
    }),
  ),
}));
vi.mock("../../../src/psi/managed/managedRun.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runManagedRerun: vi.fn(
    async (
      record: unknown,
      seams: {
        acquireInput: (current: unknown) => Promise<unknown>;
        handshake: (
          input: unknown,
          mark: () => Promise<void>,
          current: unknown,
        ) => Promise<unknown>;
        dataExchange: (
          carried: unknown,
          persistNextSecret: (nextSecret: string) => Promise<void>,
        ) => Promise<unknown>;
      },
    ) => {
      const input = await seams.acquireInput(record);
      const handshake = await seams.handshake(
        input,
        () => Promise.resolve(),
        record,
      );
      const exchange = await seams.dataExchange(handshake, () =>
        Promise.resolve(),
      );
      return { exchange, lastRun: { at: 0, outcome: "succeeded" } };
    },
  ),
}));
vi.mock("../../../src/psi/managed/managedRendezvous.js", () => ({
  assertManagedRendezvousPossible: vi.fn(),
  beginManagedRendezvous: vi.fn(),
  managedRunRelayPlan: vi.fn(() =>
    Promise.resolve({ relaysLeftOut: [], websocketRelays: [] }),
  ),
}));
vi.mock(
  "../../../src/psi/managed/managedInputHandle.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    acquireValidatedManagedInput: vi.fn(() =>
      Promise.resolve({ rows: [], columns: [] }),
    ),
  }),
);
vi.mock("../../../src/psi/disclosureAccountingStore.js", () => ({
  appendDisclosureRecordToStore: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../../src/psi/unfiledDisclosureStore.js", () => ({
  noteUnfiledDisclosureRun: vi.fn(() => Promise.resolve("noted")),
}));
vi.mock(
  "../../../src/psi/managed/managedExchangeStore.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    persistManagedRunPayloadReceiveFill: vi.fn(() => Promise.resolve()),
  }),
);
vi.mock("../../../src/psi/managed/managedPreparedExchange.js", () => ({
  prepareManagedRerunExchange: vi.fn(() =>
    minimalPreparedExchange({
      linkageTerms: getDefaultLinkageTerms("Pooled factory fixture"),
    }),
  ),
}));
vi.mock("@psi/runOutputs", () => ({
  buildRunOutputs: vi.fn(() => OUTPUTS),
}));
vi.mock("@openmined/psi.js/psi_wasm_web", () => ({
  default: () => Promise.resolve({}),
}));
vi.mock("@alcove/core", async (importOriginal) => {
  const actual = await importOriginal<typeof AlcoveCore>();
  return {
    ...actual,
    assertFirstRoundWithinSetMaximum: vi.fn(() => Promise.resolve()),
    loadPsiBackend: vi.fn(() =>
      Promise.resolve({
        library: {} as PSILibrary,
        backend: "wasm",
      } satisfies PsiBackendSelection),
    ),
    runExchange: vi.fn(() =>
      Promise.resolve(
        minimalExchangeResult({
          partnerTerms: actual.getDefaultLinkageTerms("Pooled factory partner"),
        }),
      ),
    ),
    exchangeRecordFromFailure: vi.fn(() => undefined),
    exchangeRecordOwedButUnbuilt: vi.fn(() => false),
  };
});

const mockedRunExchange = vi.mocked(runExchange);
const mockedPooledFactory = vi.mocked(createPooledBrowserPsiEngineFactory);
const mockedRendezvous = vi.mocked(beginManagedRendezvous);

class FakeConn extends EventEmitter {
  close = vi.fn();
}

class FakePeer extends EventEmitter {
  disconnect = vi.fn();
  destroy = vi.fn();
}

/** A message connection that closes at once; the mocked exchange never reads it. */
function inertConnection(): MessageConnection {
  return {
    close: vi.fn(() => Promise.resolve()),
    receive: vi.fn(),
    send: vi.fn(),
  };
}

/** What `runExchange` was handed as its engine factory, on its one call. */
function engineFactoryOfTheOneRun(): unknown {
  expect(mockedRunExchange).toHaveBeenCalledTimes(1);
  return mockedRunExchange.mock.calls[0][3].psiEngineFactory;
}

/** The pool is built once per run, over the real worker spawner and the
 * browser's own `navigator`. */
function expectOnePoolOverNavigator(): void {
  expect(mockedPooledFactory).toHaveBeenCalledTimes(1);
  expect(mockedPooledFactory).toHaveBeenCalledWith(
    defaultSpawnPsiCryptoWorker,
    navigator,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("the PSI engine factory of a web exchange", () => {
  test("the attended exchange runs the pooled factory over navigator", async () => {
    vi.mocked(openPeerMessageConnection).mockResolvedValue(inertConnection());

    await runExchangeLifecycle({
      acquire: async (context) => ({
        ...(await openOneShotPeerConnection(
          new FakePeer() as unknown as Peer,
          new FakeConn() as unknown as DataConnection,
          context,
        )),
        psi: Promise.resolve({} as PSILibrary),
        prepared: {
          metadata: [],
          linkageTerms: getDefaultLinkageTerms("Pooled factory fixture"),
          dataset: new StandardizedDataset([], []),
          rawRows: [],
          rowCount: 0,
        },
      }),
      exchangeRole: "initiator",
      signal: new AbortController().signal,
      sharedSecret: "test-shared-secret",
      expires: "2999-01-01T00:00:00.000Z",
      onStages: vi.fn(),
      onStage: vi.fn(),
      onResult: vi.fn(),
      onError: vi.fn(),
      onWarning: vi.fn(),
      onResolvedMatching: vi.fn(),
      generateOutput: vi.fn(() => ({
        kind: "matched",
        resultsUrl: "blob:results",
        record: {
          recordUrl: "blob:record",
          recordFileName: "alcove-record.json",
          keysUrl: "blob:keys",
          keysFileName: "alcove-record.keys.json",
        },
      })),
    });

    expectOnePoolOverNavigator();
    expect(engineFactoryOfTheOneRun()).toBe(POOLED_FACTORY);
  });

  test("the scheduled run runs the pooled factory over navigator", async () => {
    vi.mocked(openPeerMessageConnection).mockResolvedValue(inertConnection());
    mockedRendezvous.mockResolvedValue({
      side: "acceptor",
      peer: new FakePeer() as unknown as Peer,
      conn: new FakeConn() as unknown as DataConnection,
    });

    await runManagedExchangeInBrowser({
      record: {
        id: "record-under-test",
        side: "acceptor",
        sharedSecret: "stored-secret",
        exchangeFile: {},
      } as unknown as RunnableManagedExchangeRecord,
      source: {} as unknown as ManagedInputSource,
      signal: new AbortController().signal,
      urls: { create: () => "blob:artifact", revoke: () => {} },
    });

    expectOnePoolOverNavigator();
    expect(engineFactoryOfTheOneRun()).toBe(POOLED_FACTORY);
  });
});
