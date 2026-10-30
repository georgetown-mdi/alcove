// A one-sided rotation healed on the next run, and a stale key file refused,
// over a real file-drop connection and a real key exchange: only the PSI
// exchange is mocked, standing in for the terms exchange's store order
// (docs/spec/PROTOCOL.md, "The rotation at the terms exchange").

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { HandshakeRole, TermsRotation } from "@alcove/core";

const mockState = vi.hoisted(() => ({
  warnings: [] as string[],
  // How the mocked exchange ends: `complete` stores on both sides in the store
  // order and confirms on the initiator; `cut` stores on the initiator only
  // and ends both runs, as a lost `proceed` does.
  mode: "complete" as "complete" | "cut",
  dropFails: false,
  initiatorStored: undefined as (() => void) | undefined,
  responderStored: undefined as (() => void) | undefined,
  initiatorStoredAt: Promise.resolve() as Promise<void>,
  responderStoredAt: Promise.resolve() as Promise<void>,
}));

// The confirmation write, real unless a case makes it fail.
vi.mock("../../src/keyFile", async (importActual) => {
  const actual = await importActual<typeof import("../../src/keyFile")>();
  return {
    ...actual,
    dropPreviousSecret: (
      ...args: Parameters<typeof actual.dropPreviousSecret>
    ) => {
      if (mockState.dropFails) throw new Error("EACCES: permission denied");
      actual.dropPreviousSecret(...args);
    },
  };
});

vi.mock("@openmined/psi.js", () => ({
  default: vi.fn().mockResolvedValue({}),
}));

vi.mock("@alcove/core", async (importActual) => {
  const actual = await importActual<typeof import("@alcove/core")>();
  const { deriveNextSecret } = await import("@alcove/core/testing");
  const runExchange = async (
    _conn: unknown,
    role: HandshakeRole,
    _prepared: unknown,
    options: { rotation?: TermsRotation },
  ): Promise<unknown> => {
    const rotation = options.rotation!;
    const { keyAgreementOutput, initiatorValue } = rotation.inputs;
    const nextSecret = await deriveNextSecret(
      keyAgreementOutput,
      initiatorValue,
      new Uint8Array(32),
    );
    if (role === "initiator") {
      await rotation.store(nextSecret);
      mockState.initiatorStored?.();
      if (mockState.mode === "cut")
        throw new actual.ConnectionError("the partner went away", "transport");
      await mockState.responderStoredAt;
      await rotation.partnerStored?.();
    } else {
      rotation.partnerMayHoldNextSecret?.(true);
      await mockState.initiatorStoredAt;
      if (mockState.mode === "cut")
        throw new actual.ConnectionError("the partner went away", "transport");
      await rotation.store(nextSecret);
      mockState.responderStored?.();
    }
    return {
      associationTable: [[], []],
      partnerPayload: {},
      matching: {
        localDeduplicate: false,
        partnerDeduplicate: false,
        cardinality: "one-to-one",
      },
    };
  };
  return {
    ...actual,
    getLogger: () => ({
      info: () => {},
      warn: (msg: string, ...args: unknown[]) => {
        mockState.warnings.push([msg, ...args.map(String)].join(" "));
      },
      error: () => {},
      debug: () => {},
      trace: () => {},
    }),
    runExchange,
    exchangeRecordFromFailure: vi.fn().mockReturnValue(undefined),
    exchangeRecordOwedButUnbuilt: vi.fn().mockReturnValue(false),
    describeExchangeStages: vi.fn().mockReturnValue([]),
    buildOutputTable: vi.fn().mockReturnValue({ headers: [], rows: [] }),
  };
});

import {
  deriveHistoryVerifier,
  LocalCopyBehindError,
  PartnerCopyBehindError,
} from "@alcove/core";
import { minimalPreparedExchange } from "@alcove/core/testing";

import { loadKeyFile, saveKeyFile, type KeyFile } from "../../src/keyFile";
import { runProtocol } from "../../src/protocol";
import type { EventStreamEmitter } from "../../src/eventStream";
import { exitCodeForError } from "../../src/util/exit";

// 32 zero bytes, and 32 0x01 bytes, in base64url.
const SECRET_X = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SECRET_Y = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

const PEER_BUDGET_MS = 15_000;
const OPTIONS = {
  pollIntervalMs: 1,
  peerTimeoutMs: PEER_BUDGET_MS,
  inactivityTimeoutMs: PEER_BUDGET_MS,
};

const AHEAD_WARNING_START =
  "The last run stopped before your partner saved the new shared secret";
const BEHIND_WARNING_START =
  "Your partner still had the shared secret from before your last run";

let tmpDir: string;
let dropDir: string;
let keyFileA: string;
let keyFileB: string;

function resetStoreOrder(): void {
  mockState.initiatorStoredAt = new Promise<void>((resolve) => {
    mockState.initiatorStored = resolve;
  });
  mockState.responderStoredAt = new Promise<void>((resolve) => {
    mockState.responderStored = resolve;
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-rotation-heal-"));
  dropDir = path.join(tmpDir, "drop");
  fs.mkdirSync(dropDir);
  keyFileA = path.join(tmpDir, "a.key");
  keyFileB = path.join(tmpDir, "b.key");
  mockState.warnings.length = 0;
  mockState.mode = "complete";
  mockState.dropFails = false;
  resetStoreOrder();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** The warnings each party's run emitted on its event stream. */
type Emitted = Record<"a" | "b", Array<[string, string]>>;

function recordingEmitter(sink: Array<[string, string]>): EventStreamEmitter {
  return new Proxy({} as EventStreamEmitter, {
    get: (_target, name) =>
      name === "warning"
        ? (source: string, message: string) => sink.push([source, message])
        : () => {},
  });
}

/**
 * Run both parties from their key files, the responder first: `initiator`
 * names which of the two takes the initiator's role.
 */
async function runBoth(initiator: "a" | "b"): Promise<{
  a: PromiseSettledResult<unknown>;
  b: PromiseSettledResult<unknown>;
  emitted: Emitted;
}> {
  resetStoreOrder();
  fs.rmSync(dropDir, { recursive: true, force: true });
  fs.mkdirSync(dropDir);
  const emitted: Emitted = { a: [], b: [] };
  const run = (party: "a" | "b") => {
    const keyFilePath = party === "a" ? keyFileA : keyFileB;
    const keyFile = loadKeyFile(keyFilePath)!;
    return runProtocol({
      connection: { channel: "filedrop", path: dropDir, options: OPTIONS },
      auth: {
        sharedSecret: keyFile.sharedSecret,
        expires: keyFile.expires,
        keyFilePath,
        previousSharedSecret: keyFile.previousSharedSecret,
        previousExpires: keyFile.previousExpires,
        rotationHistory: keyFile.rotationHistory,
      },
      prepared: minimalPreparedExchange(),
      output: undefined,
      verbosity: -1,
      loggerName: `test-${party}`,
      fileSyncRuntime: { eventStream: recordingEmitter(emitted[party]) },
    });
  };
  const responder = initiator === "a" ? "b" : "a";
  const second = run(responder);
  await waitForHello();
  const first = run(initiator);
  const settled = await Promise.allSettled(
    initiator === "a" ? [first, second] : [second, first],
  );
  return { a: settled[0], b: settled[1], emitted };
}

async function waitForHello(): Promise<void> {
  const deadline = Date.now() + PEER_BUDGET_MS;
  while (!fs.readdirSync(dropDir).some((n) => /-hello-\d+\.json$/.test(n))) {
    if (Date.now() > deadline) throw new Error("no hello appeared");
    await new Promise((r) => setTimeout(r, 1));
  }
}

function heals(emitted: Array<[string, string]>): string[] {
  return emitted
    .filter(([source]) => source === "rotationHeal")
    .map(([, message]) => message);
}

/** A key file left as the cut run leaves the side that stored first. */
function expectAheadOf(file: KeyFile | undefined, previous: string): void {
  expect(file?.sharedSecret).not.toBe(previous);
  expect(file?.previousSharedSecret).toBe(previous);
}

test("a run cut after the initiator's store leaves it ahead, holding the secret the run used as its previous one", async () => {
  saveKeyFile(keyFileA, { sharedSecret: SECRET_X });
  saveKeyFile(keyFileB, { sharedSecret: SECRET_X });
  mockState.mode = "cut";

  const { a, b } = await runBoth("a");

  expect(a.status).toBe("rejected");
  expect(b.status).toBe("rejected");
  const ahead = loadKeyFile(keyFileA);
  expectAheadOf(ahead, SECRET_X);
  expect(ahead?.rotationHistory).toEqual([
    { verifier: await deriveHistoryVerifier(SECRET_X) },
  ]);
  const behind = loadKeyFile(keyFileB);
  expect(behind?.sharedSecret).toBe(SECRET_X);
  expect(behind?.previousSharedSecret).toBeUndefined();
  expect(behind?.rotationInFlightSince).toBeDefined();
}, 30_000);

test.each([
  ["the side that was ahead initiates", "a"],
  ["the side that was behind initiates", "b"],
] as const)(
  "the next run heals a cut run when %s: both report it, and both end on one secret with no previous secret",
  async (_case, initiator) => {
    saveKeyFile(keyFileA, { sharedSecret: SECRET_X });
    saveKeyFile(keyFileB, { sharedSecret: SECRET_X });
    mockState.mode = "cut";
    await runBoth("a");
    expectAheadOf(loadKeyFile(keyFileA), SECRET_X);
    mockState.mode = "complete";

    const { a, b, emitted } = await runBoth(initiator);

    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");
    expect(heals(emitted.a)).toHaveLength(1);
    expect(heals(emitted.a)[0]).toMatch(new RegExp(`^${AHEAD_WARNING_START}`));
    expect(heals(emitted.b)).toHaveLength(1);
    expect(heals(emitted.b)[0]).toMatch(new RegExp(`^${BEHIND_WARNING_START}`));
    expect(
      mockState.warnings.filter((w) => w.startsWith(AHEAD_WARNING_START)),
    ).toHaveLength(1);
    const fileA = loadKeyFile(keyFileA)!;
    const fileB = loadKeyFile(keyFileB)!;
    expect(fileA.sharedSecret).toBe(fileB.sharedSecret);
    expect(fileA.sharedSecret).not.toBe(SECRET_X);
    for (const file of [fileA, fileB]) {
      expect(file.previousSharedSecret).toBeUndefined();
      expect(file.previousExpires).toBeUndefined();
      expect(file.rotationInFlightSince).toBeUndefined();
    }
    // The secret the cut run stored on one side alone is never added: both
    // histories hold the one secret the two sides retired.
    const retired = [{ verifier: await deriveHistoryVerifier(SECRET_X) }];
    expect(fileA.rotationHistory).toEqual(retired);
    expect(fileB.rotationHistory).toEqual(retired);
  },
  30_000,
);

test("a run whose initiator stopped before the responder's frame confirmed it runs as usual next time, and drops the previous secret", async () => {
  // Both stored the next secret; the initiator still holds the one before it.
  saveKeyFile(keyFileA, {
    sharedSecret: SECRET_Y,
    previousSharedSecret: SECRET_X,
  });
  saveKeyFile(keyFileB, { sharedSecret: SECRET_Y });

  const { a, b, emitted } = await runBoth("b");

  expect(a.status).toBe("fulfilled");
  expect(b.status).toBe("fulfilled");
  expect(heals(emitted.a)).toEqual([]);
  expect(heals(emitted.b)).toEqual([]);
  const fileA = loadKeyFile(keyFileA)!;
  const fileB = loadKeyFile(keyFileB)!;
  expect(fileA.sharedSecret).toBe(fileB.sharedSecret);
  expect(fileA.previousSharedSecret).toBeUndefined();
  expect(fileB.previousSharedSecret).toBeUndefined();
}, 30_000);

test("a completed run leaves no previous secret on either side", async () => {
  saveKeyFile(keyFileA, { sharedSecret: SECRET_X });
  saveKeyFile(keyFileB, { sharedSecret: SECRET_X });

  const { a, b, emitted } = await runBoth("a");

  expect(a.status).toBe("fulfilled");
  expect(b.status).toBe("fulfilled");
  expect([...heals(emitted.a), ...heals(emitted.b)]).toEqual([]);
  for (const keyFilePath of [keyFileA, keyFileB]) {
    const file = loadKeyFile(keyFilePath)!;
    expect(file.sharedSecret).not.toBe(SECRET_X);
    expect(file.previousSharedSecret).toBeUndefined();
  }
}, 30_000);

test("a confirmation write that fails ends the initiator's run with exit 69, keeping its previous secret", async () => {
  saveKeyFile(keyFileA, { sharedSecret: SECRET_X });
  saveKeyFile(keyFileB, { sharedSecret: SECRET_X });
  mockState.dropFails = true;

  const { a } = await runBoth("a");

  expect(a.status).toBe("rejected");
  const reason = (a as PromiseRejectedResult).reason as Error;
  expect(reason.message).toContain(
    "both sides saved the new shared secret, but removing the secret before " +
      "it failed in ",
  );
  expect(exitCodeForError(reason)).toBe(69);
  expectAheadOf(loadKeyFile(keyFileA), SECRET_X);
  expect(loadKeyFile(keyFileB)?.sharedSecret).toBe(
    loadKeyFile(keyFileA)?.sharedSecret,
  );
}, 30_000);

test("a stale key file restored from backup is refused with exit 65 naming the recovery, and its partner fails with exit 77", async () => {
  // A rotated past X; B runs from a copy of X restored from backup.
  saveKeyFile(keyFileA, {
    sharedSecret: SECRET_Y,
    rotationHistory: [{ verifier: await deriveHistoryVerifier(SECRET_X) }],
  });
  saveKeyFile(keyFileB, { sharedSecret: SECRET_X });

  const { a, b } = await runBoth("a");

  expect(b.status).toBe("rejected");
  const stale = (b as PromiseRejectedResult).reason as Error;
  expect(stale).toBeInstanceOf(LocalCopyBehindError);
  expect(stale.message).toContain(
    "This copy of the exchange is older than the one on the other side.",
  );
  expect(stale.message).toContain("ask your partner for a new invitation");
  expect(exitCodeForError(stale)).toBe(65);
  expect(a.status).toBe("rejected");
  const current = (a as PromiseRejectedResult).reason as Error;
  expect(current).toBeInstanceOf(PartnerCopyBehindError);
  expect(exitCodeForError(current)).toBe(77);
  // Neither side changed its key file.
  expect(loadKeyFile(keyFileA)?.sharedSecret).toBe(SECRET_Y);
  expect(loadKeyFile(keyFileB)?.sharedSecret).toBe(SECRET_X);
}, 30_000);
