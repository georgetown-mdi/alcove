import {
  AuthenticationError,
  ConnectionError,
  InternalConsistencyError,
  LinkageTermsUnsatisfiableError,
  NEXT_SECRET_STORE_FAILED_ABORT_REASON,
  PeerAbortError,
  generateSharedSecret,
  getDefaultLinkageTerms,
  getLogger,
  markStatesItsOwnNextStep,
} from "@alcove/core";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  NO_STANDING_CONDITION,
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  ManagedExchangeExpiredError,
  benignRerunOutcome,
  remapLapsedRunFailure,
  rerunFailureLastRun,
  runManagedRerun,
} from "@psi/managed/managedRun";
import {
  ManagedExchangeSecretChangedError,
  markManagedExchangeRotationInFlight,
  persistManagedExchangeRotation,
  recordManagedExchangeLastRun,
} from "@psi/managed/managedExchangeStore";
import {
  ManagedInputError,
  managedInputFailureKind,
} from "@psi/managed/managedInputGuard";
import {
  ManagedRunStoppedError,
  managedWindowRunStage,
  stopWaitingManagedWindowRun,
} from "@psi/managed/managedWindowRuns";
import { ManagedExchangeLockUnavailableError } from "@psi/managed/managedExchangeLock";
import { ManagedExchangeNotRunnableError } from "@psi/managed/managedExchangeRun";
import { PartnerNoShowError } from "@psi/transport/waitForConnection";
import { PartnerSecretNotSavedError } from "@psi/partnerSecretNotSaved";
import { RotationPersistError } from "@psi/managed/managedRunRotate";

import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";

// The pure orchestration of a re-run, tested in Node for the parts that do NOT
// touch the platform (the benign-outcome classification); the full launch-from-record path
// is exercised against real Chromium in test/browser/managedRun.test.ts. Two claims
// need the run driven end to end here, against stubbed Web Locks and store writes:
// the phase boundary reported to the caller's failure classification, and the store
// writes a run whose partner never arrives makes.

// The record the run reads inside the lock. Unset, the read answers with a
// fresh default record (its own generated shared secret), not the caller's
// fixture.
const storedRecord = vi.hoisted(
  (): { value: ManagedExchangeRecord | undefined; deleted: boolean } => ({
    value: undefined,
    deleted: false,
  }),
);
vi.mock("@psi/managed/managedExchangeStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getManagedExchange: vi.fn(() =>
    Promise.resolve(
      storedRecord.deleted ? undefined : (storedRecord.value ?? record()),
    ),
  ),
  markManagedExchangeRotationInFlight: vi.fn(() => Promise.resolve()),
  persistManagedExchangeRotation: vi.fn(() => Promise.resolve()),
  recordManagedExchangeLastRun: vi.fn(() => Promise.resolve()),
}));

/** Grant the run+rotate lock immediately, so a Node test can drive the run through
 * the critical section the browser's Web Locks owns. */
function stubGrantingWebLocks(): void {
  vi.stubGlobal("navigator", {
    locks: {
      request: (
        _name: string,
        _options: unknown,
        critical: (lock: object) => Promise<unknown>,
      ) => critical({}),
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(recordManagedExchangeLastRun).mockReset();
  vi.mocked(persistManagedExchangeRotation).mockReset();
  vi.mocked(markManagedExchangeRotationInFlight).mockReset();
  storedRecord.value = undefined;
  storedRecord.deleted = false;
});

/** A fixed secret per call site, so two records built from {@link record} differ
 * only where a test says they do. */
const HELD_SECRET = generateSharedSecret();

function record(
  overrides: Partial<ManagedExchangeRecord> = {},
): ManagedExchangeRecord {
  return {
    schemaVersion: MANAGED_EXCHANGE_SCHEMA_VERSION,
    id: "record-under-test",
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    standingCondition: NO_STANDING_CONDITION,
    ...overrides,
  };
}

/** A data exchange that stores `nextSecret` through the run's rotation write,
 * as core's terms exchange does before any payload round, then yields what
 * `exchange` does. */
function rotatingExchange<T>(
  exchange: () => Promise<T>,
  nextSecret: string = generateSharedSecret(),
): (
  carried: string,
  persistNextSecret: (nextSecret: string) => Promise<void>,
) => Promise<T> {
  return async (_carried, persistNextSecret) => {
    await persistNextSecret(nextSecret);
    return exchange();
  };
}

/** Seams that fail loudly if reached: a run refused before the input is read
 * must never touch them. */
const unreachableSeams = {
  acquireInput: () => {
    throw new Error("acquireInput must not run for a lapsed record");
  },
  handshake: () => {
    throw new Error("handshake must not run for a lapsed record");
  },
  dataExchange: () => {
    throw new Error("dataExchange must not run for a lapsed record");
  },
};

describe("runManagedRerun: pre-connection expiry of the stored record", () => {
  const NOW = Date.parse("2026-07-14T12:00:00.000Z");
  const LAPSED = "2026-07-01T00:00:00.000Z";
  const IN_FORCE = "2026-08-01T00:00:00.000Z";

  test("a stored record that has lapsed refuses before the input, the rendezvous, or the marker", async () => {
    // The caller's copy was read before the record was re-installed with an
    // earlier bound: the bound the run enforces is the stored one.
    stubGrantingWebLocks();
    storedRecord.value = record({ expires: LAPSED });

    const error = await runManagedRerun(
      record({ expires: IN_FORCE }),
      unreachableSeams,
      { now: () => NOW },
    ).then(
      () => {
        throw new Error("the run should have rejected as expired");
      },
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ManagedExchangeExpiredError);
    expect((error as ManagedExchangeExpiredError).expires).toBe(LAPSED);
    expect(benignRerunOutcome(error, false)).toBe("expired");
    expect(markManagedExchangeRotationInFlight).not.toHaveBeenCalled();
    expect(recordManagedExchangeLastRun).not.toHaveBeenCalled();
  });

  test("a caller's copy that has lapsed runs when the stored record has rotated past it", async () => {
    stubGrantingWebLocks();
    storedRecord.value = record({ expires: IN_FORCE });
    let handshakeRan = false;

    const result = await runManagedRerun(
      record({ expires: LAPSED }),
      {
        acquireInput: () => Promise.resolve("rows"),
        handshake: () => {
          handshakeRan = true;
          return Promise.resolve("carried");
        },
        dataExchange: rotatingExchange(() => Promise.resolve("exchanged")),
      },
      { now: () => NOW },
    );

    expect(handshakeRan).toBe(true);
    expect(result.exchange).toBe("exchanged");
  });

  test("a record with no bound is not short-circuited by the expiry check", async () => {
    stubGrantingWebLocks();
    const error = await runManagedRerun(record(), unreachableSeams).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).not.toBeInstanceOf(ManagedExchangeExpiredError);
    expect((error as Error).message).toBe(
      "acquireInput must not run for a lapsed record",
    );
  });
});

describe("runManagedRerun: the phase boundary reported to the caller", () => {
  test("the caller learns the boundary before the data exchange runs", async () => {
    // The value the surface classifies a failure against: without this report a
    // classifier would have to take the record's own bookkeeping for the phase,
    // which is a best-effort write about whichever run last managed to stamp it.
    stubGrantingWebLocks();
    let boundaryReported = false;
    let reportedWhenExchangeRan: boolean | undefined;

    const result = await runManagedRerun(
      record(),
      {
        acquireInput: () => Promise.resolve("rows"),
        handshake: () => Promise.resolve("carried"),
        dataExchange: rotatingExchange(() => {
          reportedWhenExchangeRan = boundaryReported;
          return Promise.resolve("exchanged");
        }),
      },
      {
        onDataExchangeStart: () => {
          boundaryReported = true;
        },
      },
    );

    expect(reportedWhenExchangeRan).toBe(true);
    expect(result.exchange).toBe("exchanged");
  });

  test("a failure before the data exchange leaves the boundary unreported", async () => {
    // The phase every state whose copy says nothing left this device rests on: a
    // run that never reached the data exchange must not be treated as one that did.
    stubGrantingWebLocks();
    let boundaryReported = false;

    await expect(
      runManagedRerun(
        record(),
        {
          acquireInput: () => Promise.resolve("rows"),
          handshake: () =>
            Promise.reject(new PartnerNoShowError("nobody arrived")),
          dataExchange: () => {
            throw new Error("the data exchange must not run");
          },
        },
        {
          onDataExchangeStart: () => {
            boundaryReported = true;
          },
        },
      ),
    ).rejects.toBeInstanceOf(PartnerNoShowError);

    expect(boundaryReported).toBe(false);
  });
});

describe("runManagedRerun: a partner who never arrives", () => {
  test("never reaches the rotation write, so the stored secret stands", async () => {
    // The invariant the carried-forward standing condition leans on: a condition
    // is cleared by a rotation write or the operator's own act, and a no-show
    // raises before the terms exchange derives a next secret. The rotation persist is
    // the only writer of `sharedSecret` and `expires`, so a run that never calls it
    // leaves both as the store holds them; the no-show stamp is its whole write.
    stubGrantingWebLocks();
    const at = Date.parse("2026-07-14T12:00:00.000Z");
    storedRecord.value = record({ sharedSecret: HELD_SECRET });

    await expect(
      runManagedRerun(
        record(),
        {
          acquireInput: () => Promise.resolve("rows"),
          handshake: () =>
            Promise.reject(new PartnerNoShowError("nobody arrived")),
          dataExchange: () => {
            throw new Error("the data exchange must not run on a no-show");
          },
        },
        { now: () => at },
      ),
    ).rejects.toBeInstanceOf(PartnerNoShowError);

    expect(persistManagedExchangeRotation).not.toHaveBeenCalled();
    expect(vi.mocked(recordManagedExchangeLastRun).mock.calls).toEqual([
      [
        "record-under-test",
        { at: new Date(at).toISOString(), outcome: "missed" },
        at,
        // Stamped only over the secret the run read inside the lock.
        HELD_SECRET,
      ],
    ]);
  });
});

describe("runManagedRerun: a partner that could not save the next secret", () => {
  const at = Date.parse("2026-07-14T12:00:00.000Z");
  const storeFailure = () =>
    new PeerAbortError(undefined, NEXT_SECRET_STORE_FAILED_ABORT_REASON);

  /** Run a record of `side` whose data exchange stores the next secret when
   * `stores`, then reads `abort` as the partner's first frame past the terms
   * exchange; resolves to the run's rejection and the failure kinds it
   * stamped. */
  async function runEndingIn(
    side: "inviter" | "acceptor",
    stores: boolean,
    abort: unknown,
  ): Promise<{ error: unknown; failureKinds: Array<unknown> }> {
    stubGrantingWebLocks();
    storedRecord.value = record({ side });
    const error = await runManagedRerun(
      record({ side }),
      {
        acquireInput: () => Promise.resolve("rows"),
        handshake: () => Promise.resolve("carried"),
        dataExchange: async (_carried, persistNextSecret) => {
          if (stores) await persistNextSecret(generateSharedSecret());
          throw abort;
        },
      },
      { now: () => at },
    ).then(
      () => {
        throw new Error("the run should have rejected");
      },
      (reason: unknown) => reason,
    );
    const failureKinds = vi
      .mocked(recordManagedExchangeLastRun)
      .mock.calls.map(([, lastRun]) => lastRun.failureKind);
    return { error, failureKinds };
  }

  test("an initiator that stored records it as its own kind and raises the error naming it", async () => {
    const abort = storeFailure();
    const { error, failureKinds } = await runEndingIn("acceptor", true, abort);
    expect(error).toBeInstanceOf(PartnerSecretNotSavedError);
    expect((error as Error).cause).toBe(abort);
    expect(failureKinds).toEqual(["partner-storage"]);
    expect(benignRerunOutcome(error, true)).toBe("partner-storage");
  });

  test.each([
    ["a responder that stored", "inviter", true, storeFailure()],
    ["an initiator that stored nothing", "acceptor", false, storeFailure()],
    [
      "an initiator that stored, for another abort",
      "acceptor",
      true,
      new PeerAbortError(),
    ],
  ] as const)(
    "%s keeps the partner's abort and its transport record",
    async (_case, side, stores, abort) => {
      const { error, failureKinds } = await runEndingIn(side, stores, abort);
      expect(error).toBe(abort);
      expect(failureKinds).toEqual(["transport"]);
    },
  );
});

describe("runManagedRerun: a stop asked before the handshake", () => {
  test("a failure of the run's own that follows is raised and stamped as with no stop, not as a cancel", async () => {
    stubGrantingWebLocks();
    const at = Date.parse("2026-07-14T12:00:00.000Z");
    storedRecord.value = record({ sharedSecret: HELD_SECRET });
    const stop = new AbortController();
    const unreadable = new Error("the folder could not be read");

    await expect(
      runManagedRerun(
        record(),
        {
          acquireInput: () => {
            expect(stopWaitingManagedWindowRun("record-under-test")).toBe(
              "stopped",
            );
            return Promise.reject(unreadable);
          },
          handshake: () => {
            throw new Error("the handshake must not run");
          },
          dataExchange: () => {
            throw new Error("the data exchange must not run");
          },
        },
        { now: () => at, stop, aborted: () => stop.signal.aborted },
      ),
    ).rejects.toBe(unreadable);

    expect(stop.signal.aborted).toBe(true);
    expect(vi.mocked(recordManagedExchangeLastRun).mock.calls).toEqual([
      [
        "record-under-test",
        {
          at: new Date(at).toISOString(),
          outcome: "failed",
          failureKind: "transport",
        },
        at,
        HELD_SECRET,
      ],
    ]);
  });
});

describe.each([
  ["inviter", true],
  ["acceptor", false],
] as const)(
  "runManagedRerun: the start of the key exchange, as the %s",
  (side, writesMarker) => {
    test("moves the run past every later stop, which it then refuses, and the run completes", async () => {
      stubGrantingWebLocks();
      storedRecord.value = record({ side });
      const stop = new AbortController();
      const stages: Array<string | undefined> = [];
      const refusals: Array<string | undefined> = [];

      const result = await runManagedRerun(
        record({ side }),
        {
          acquireInput: () => Promise.resolve("rows"),
          handshake: async (_input, beginKeyExchange) => {
            stages.push(managedWindowRunStage("record-under-test"));
            await beginKeyExchange();
            stages.push(managedWindowRunStage("record-under-test"));
            refusals.push(stopWaitingManagedWindowRun("record-under-test"));
            return "carried";
          },
          dataExchange: rotatingExchange(() => {
            refusals.push(stopWaitingManagedWindowRun("record-under-test"));
            return Promise.resolve("exchanged");
          }),
        },
        { stop },
      );

      expect(stages).toEqual(["waiting", "exchanging"]);
      expect(refusals).toEqual(["exchanging", "exchanging"]);
      expect(stop.signal.aborted).toBe(false);
      expect(result.lastRun.outcome).toBe("succeeded");
      expect(persistManagedExchangeRotation).toHaveBeenCalledTimes(1);
    });

    test(`${writesMarker ? "writes" : "writes no"} rotation-in-flight marker`, async () => {
      stubGrantingWebLocks();
      storedRecord.value = record({ side });

      await runManagedRerun(record({ side }), {
        acquireInput: () => Promise.resolve("rows"),
        handshake: async (_input, beginKeyExchange) => {
          await beginKeyExchange();
          return "carried";
        },
        dataExchange: rotatingExchange(() => Promise.resolve("exchanged")),
      });

      expect(markManagedExchangeRotationInFlight).toHaveBeenCalledTimes(
        writesMarker ? 1 : 0,
      );
    });

    test("is refused where a stop came first, ending the run with nothing written", async () => {
      stubGrantingWebLocks();
      storedRecord.value = record({ side });
      const stop = new AbortController();
      let keyExchange = false;

      const error = await runManagedRerun(
        record({ side }),
        {
          acquireInput: () => Promise.resolve("rows"),
          handshake: async (_input, beginKeyExchange) => {
            expect(stopWaitingManagedWindowRun("record-under-test")).toBe(
              "stopped",
            );
            await beginKeyExchange();
            keyExchange = true;
            return "carried";
          },
          dataExchange: () => {
            throw new Error("the data exchange must not run");
          },
        },
        { stop },
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ManagedRunStoppedError);
      expect(keyExchange).toBe(false);
      expect(markManagedExchangeRotationInFlight).not.toHaveBeenCalled();
      expect(persistManagedExchangeRotation).not.toHaveBeenCalled();
      expect(recordManagedExchangeLastRun).not.toHaveBeenCalled();
    });
  },
);

describe("runManagedRerun: the record a run uses", () => {
  test("a later run on a copy read before a rotation authenticates with the rotated secret", async () => {
    // Two runs launched from one copy of the record, as a window's attempts are
    // when the copy was read before the first of them ran: the first rotates, and
    // the second must authenticate with what the first stored.
    stubGrantingWebLocks();
    const heldCopy = record({ sharedSecret: HELD_SECRET });
    storedRecord.value = heldCopy;
    const rotatedSecret = generateSharedSecret();
    vi.mocked(persistManagedExchangeRotation).mockImplementationOnce(
      (_id, _expected, rotation) => {
        const rotated = runnableManagedExchangeOrRefuse({
          ...heldCopy,
          sharedSecret: rotation.sharedSecret,
        });
        storedRecord.value = rotated;
        return Promise.resolve(rotated);
      },
    );
    const authenticatedWith: Array<string> = [];
    const runFromHeldCopy = () =>
      runManagedRerun(heldCopy, {
        acquireInput: () => Promise.resolve("rows"),
        handshake: (_input, _mark, current) => {
          authenticatedWith.push(current.sharedSecret);
          return Promise.resolve("carried");
        },
        dataExchange: rotatingExchange(
          () => Promise.resolve("exchanged"),
          rotatedSecret,
        ),
      });

    await runFromHeldCopy();
    await runFromHeldCopy();

    expect(authenticatedWith).toEqual([HELD_SECRET, rotatedSecret]);
  });

  test("the input is checked against the terms and policy the store holds", async () => {
    stubGrantingWebLocks();
    const edited = record({ sharedSecret: HELD_SECRET, tokenMaxAgeDays: 30 });
    storedRecord.value = edited;
    let inputCheckedAgainst: ManagedExchangeRecord | undefined;

    await runManagedRerun(record({ tokenMaxAgeDays: 90 }), {
      acquireInput: (current) => {
        inputCheckedAgainst = current;
        return Promise.resolve("rows");
      },
      handshake: () => Promise.resolve("carried"),
      dataExchange: rotatingExchange(() => Promise.resolve("exchanged")),
    });

    expect(inputCheckedAgainst).toBe(edited);
  });

  test("a record deleted before the lock is granted refuses before the input is read", async () => {
    stubGrantingWebLocks();
    storedRecord.deleted = true;
    let inputRead = false;

    await expect(
      runManagedRerun(record(), {
        acquireInput: () => {
          inputRead = true;
          return Promise.resolve("rows");
        },
        handshake: () => {
          throw new Error("the handshake must not run for a deleted record");
        },
        dataExchange: () => {
          throw new Error(
            "the data exchange must not run for a deleted record",
          );
        },
      }),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof ManagedExchangeNotRunnableError &&
        error.cause instanceof Error &&
        error.cause.message === "no managed exchange with id record-under-test",
    );

    expect(inputRead).toBe(false);
  });

  test("a record holding a configuration only refuses before the input is read", async () => {
    stubGrantingWebLocks();
    storedRecord.value = record({ sharedSecret: undefined, side: undefined });
    let inputRead = false;

    await expect(
      runManagedRerun(record(), {
        acquireInput: () => {
          inputRead = true;
          return Promise.resolve("rows");
        },
        handshake: () => {
          throw new Error("the handshake must not run without a secret");
        },
        dataExchange: () => {
          throw new Error("the data exchange must not run without a secret");
        },
      }),
    ).rejects.toBeInstanceOf(ManagedExchangeNotRunnableError);

    expect(inputRead).toBe(false);
  });

  test("a record holding a configuration only is recorded as a local refusal, not a transport failure", async () => {
    stubGrantingWebLocks();
    storedRecord.value = record({ sharedSecret: undefined, side: undefined });

    const error = await runManagedRerun(record(), unreachableSeams).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(benignRerunOutcome(error, false)).toBe("custody-unreadable");
    expect(recordManagedExchangeLastRun).toHaveBeenCalledTimes(1);
    const [, lastRun] = vi.mocked(recordManagedExchangeLastRun).mock.calls[0];
    expect(lastRun).toMatchObject({
      outcome: "failed",
      failureKind: "custody-unreadable",
    });
  });
});

describe("benignRerunOutcome", () => {
  test("classifies the benign pre-connection states", () => {
    expect(
      benignRerunOutcome(
        new ManagedExchangeExpiredError("2026-07-01T00:00:00Z"),
        false,
      ),
    ).toBe("expired");
    expect(
      benignRerunOutcome(
        new ManagedInputError({ reason: "acquire", cause: new Error("x") }),
        false,
      ),
    ).toBe("input");
    expect(
      benignRerunOutcome(new ManagedExchangeLockUnavailableError("id"), false),
    ).toBe("already-running");
    expect(
      benignRerunOutcome(
        new ManagedExchangeNotRunnableError("id", new Error("invalid")),
        false,
      ),
    ).toBe("custody-unreadable");
  });

  test("a partner who never arrived is the benign missed state", () => {
    expect(
      benignRerunOutcome(new PartnerNoShowError("nobody came"), false),
    ).toBe("missed");
  });

  test("a no-show past the data-exchange boundary is not a benign outcome", () => {
    // This classification follows the same phase guard as its bookkeeping
    // counterpart (rerunFailureLastRun records "transport" for this same shape), so
    // the two cannot disagree about a disclosure. The rendezvous raises the no-show
    // only from a wait that never opened a channel; past the boundary it is no
    // longer the state whose copy says nothing left this device, so it falls
    // through to the caller's generic transport path.
    expect(
      benignRerunOutcome(new PartnerNoShowError("nobody came"), true),
    ).toBeUndefined();
  });

  test("an input rejection past the data-exchange boundary is not a benign outcome", () => {
    // The input guard's own column grading raises the same non-disclosure outcome
    // core's refusal does, so it follows the same boundary guard rather than
    // reaching the surface's "nothing left this device" copy on the strength of
    // the error's type. The guard runs before any connection.
    expect(
      benignRerunOutcome(
        new ManagedInputError({
          reason: "columns",
          unsatisfied: [{ name: "ssn", type: "ssn" }],
          singleColumn: false,
        }),
        true,
      ),
    ).toBeUndefined();
    expect(
      benignRerunOutcome(
        new ManagedInputError({ reason: "acquire", cause: new Error("x") }),
        true,
      ),
    ).toBeUndefined();
  });

  test("a linkage shortfall past the data-exchange boundary is not a benign outcome", () => {
    // The same guard, for the same reason: the shortfall state's copy tells the
    // operator the run stopped before connecting and nothing left this device, and
    // core raises it from the pre-connection prepare -- past the boundary that
    // claim cannot be made, whatever raised it.
    expect(
      benignRerunOutcome(
        new LinkageTermsUnsatisfiableError("refused at the run boundary"),
        true,
      ),
    ).toBeUndefined();
  });

  test("a handshake/storage/transport failure is not a benign pre-connection state", () => {
    expect(
      benignRerunOutcome(new Error("connection dropped"), false),
    ).toBeUndefined();
    expect(
      benignRerunOutcome(new RotationPersistError(0, new Error("db")), false),
    ).toBeUndefined();
  });
});

describe("rerunFailureLastRun: the runner's failure bookkeeping", () => {
  const AT = Date.parse("2026-07-14T12:00:00.000Z");

  test("a security-kind failure before the data exchange records an auth-kind failed run", () => {
    // The handshake failing closed provably precedes any payload, so the disclosure
    // copy can accurately say nothing was disclosed.
    const lastRun = rerunFailureLastRun(
      new ConnectionError("key exchange authentication failed", "security"),
      AT,
      false,
      false,
    );
    expect(lastRun).toEqual({
      at: new Date(AT).toISOString(),
      outcome: "failed",
      failureKind: "auth",
    });
  });

  test("a security-kind failure behind a transport wrap records auth the same way", () => {
    const lastRun = rerunFailureLastRun(
      new ConnectionError("the message send failed", "transport", {
        cause: new AuthenticationError("key exchange authentication failed"),
      }),
      AT,
      false,
      false,
    );
    expect(lastRun).toEqual({
      at: new Date(AT).toISOString(),
      outcome: "failed",
      failureKind: "auth",
    });
  });

  test("a peer abort holding a security-kind cause is not unwrapped to auth", () => {
    const lastRun = rerunFailureLastRun(
      new PeerAbortError({
        cause: new ConnectionError("integrity check failed", "security"),
      }),
      AT,
      false,
      false,
    );
    expect(lastRun).toEqual({
      at: new Date(AT).toISOString(),
      outcome: "failed",
      failureKind: "transport",
    });
  });

  test("a security-kind failure after the data exchange began records transport, not auth", () => {
    // Core's EncryptedMessageConnection can raise a security-kind error on a tampered
    // frame mid-data-exchange; past the phase boundary that is not the pre-disclosure
    // handshake failure, so it records "transport" (the neither-way disclosure bucket)
    // rather than the nothing-disclosed "auth".
    const lastRun = rerunFailureLastRun(
      new ConnectionError("frame tampered mid-exchange", "security"),
      AT,
      false,
      true,
    );
    expect(lastRun).toEqual({
      at: new Date(AT).toISOString(),
      outcome: "failed",
      failureKind: "transport",
    });
  });

  test("any other run failure records a transport-kind failed run", () => {
    expect(
      rerunFailureLastRun(new Error("channel dropped"), AT, false, false),
    ).toEqual({
      at: new Date(AT).toISOString(),
      outcome: "failed",
      failureKind: "transport",
    });
  });

  test("a partner who never arrived records the benign missed outcome", () => {
    // The write this whole path exists for: a no-show is its own outcome, not the
    // transport fault a fall-through would file it as. No failureKind rides along --
    // the outcome is the whole account, and the read side keys off it alone.
    expect(
      rerunFailureLastRun(
        new PartnerNoShowError("timed out waiting for the other party"),
        AT,
        false,
        false,
      ),
    ).toEqual({ at: new Date(AT).toISOString(), outcome: "missed" });
  });

  test("a no-show outranks the abort probe", () => {
    // The rendezvous raises the no-show only on a wait that spent its whole budget,
    // which an abort cannot manufacture -- an aborted wait rejects through its own
    // path. So a cancel landing while this run unwinds must not overwrite the one
    // thing the run did establish: the partner was not there.
    expect(
      rerunFailureLastRun(
        new PartnerNoShowError("timed out waiting for the other party"),
        AT,
        true,
        false,
      ),
    ).toEqual({ at: new Date(AT).toISOString(), outcome: "missed" });
  });

  test("a no-show past the data-exchange boundary records transport, not missed", () => {
    // The "missed" outcome is what the disclosure copy reads to say nothing left
    // this device, so it follows the same phase guard as the auth tier: past
    // the boundary it cannot make that claim.
    expect(
      rerunFailureLastRun(
        new PartnerNoShowError("timed out waiting for the other party"),
        AT,
        false,
        true,
      ),
    ).toEqual({
      at: new Date(AT).toISOString(),
      outcome: "failed",
      failureKind: "transport",
    });
  });

  test("a cancel past the data-exchange boundary still records cancelled", () => {
    // The cancel that cuts a stalled payload exchange: the run's connection is
    // closed under it, so the failure that arrives is the transport's own close
    // -- but the operator stopped this run, and that is what the record states.
    const lastRun = rerunFailureLastRun(
      new ConnectionError("connection closed", "closed"),
      AT,
      true,
      true,
    );
    expect(lastRun).toEqual({
      at: new Date(AT).toISOString(),
      outcome: "failed",
      failureKind: "cancelled",
    });
  });

  test("a cancelled run records cancelled, even when the error looks like a trust failure", () => {
    // Teardown on an operator abort can provoke a security-shaped error; the
    // abort probe wins so the bookkeeping reads cancelled, not auth.
    const lastRun = rerunFailureLastRun(
      new ConnectionError("closed mid-handshake", "security"),
      AT,
      true,
      false,
    );
    expect(lastRun?.failureKind).toBe("cancelled");
  });

  test("failures whose bookkeeping is owned elsewhere or absent by design record nothing", () => {
    // Input and storage: recorded best-effort inside the critical section.
    expect(
      rerunFailureLastRun(
        new ManagedInputError({ reason: "acquire", cause: new Error("x") }),
        AT,
        false,
        false,
      ),
    ).toBeUndefined();
    expect(
      rerunFailureLastRun(
        new RotationPersistError(AT, new Error("db")),
        AT,
        false,
        false,
      ),
    ).toBeUndefined();
    // Expiry and lock-unavailable: no run began; a lapse is held by `expires`.
    expect(
      rerunFailureLastRun(
        new ManagedExchangeExpiredError("2026-07-01T00:00:00.000Z"),
        AT,
        false,
        false,
      ),
    ).toBeUndefined();
    expect(
      rerunFailureLastRun(
        new ManagedExchangeLockUnavailableError("id"),
        AT,
        false,
        false,
      ),
    ).toBeUndefined();
  });
});

describe("remapLapsedRunFailure: a bound that lapses mid-run", () => {
  const NOW = Date.parse("2026-07-14T12:00:00.000Z");

  /** Core's expiry errors have the recovery-hint mark (preserved across the
   * security re-wrap). */
  function taggedExpiryError(): Error {
    return markStatesItsOwnNextStep(
      new Error("shared secret expired during the key-exchange round-trip"),
    );
  }

  test("a marked handshake failure on a now-lapsed record re-maps to the benign expiry error", () => {
    const remapped = remapLapsedRunFailure(
      taggedExpiryError(),
      { expires: "2026-07-14T11:59:00.000Z" },
      NOW,
    );
    expect(remapped).toBeInstanceOf(ManagedExchangeExpiredError);
    expect(remapped?.expires).toBe("2026-07-14T11:59:00.000Z");
  });

  test("a marked failure with a still-live bound does not re-map", () => {
    expect(
      remapLapsedRunFailure(
        taggedExpiryError(),
        { expires: "2026-08-01T00:00:00.000Z" },
        NOW,
      ),
    ).toBeUndefined();
  });

  test("an unmarked trust failure never re-maps, even on a lapsed record", () => {
    expect(
      remapLapsedRunFailure(
        new ConnectionError("key exchange authentication failed", "security"),
        { expires: "2026-07-14T11:59:00.000Z" },
        NOW,
      ),
    ).toBeUndefined();
  });

  test("an internal fault on a lapsed record is not re-mapped to the expiry", () => {
    // Core's single-pass reply-cap safety check raises a marked
    // InternalConsistencyError mid-data-exchange -- so a bound that lapses
    // during a long run satisfies the mark and the lapse alike, unlike the
    // handshake-time expiry the re-map exists for. Re-mapping it would report a
    // defect in Alcove as a benign expiry and offer a fresh invitation, which
    // cannot fix it.
    expect(
      remapLapsedRunFailure(
        markStatesItsOwnNextStep(
          new InternalConsistencyError(
            "server: single-pass built a reply above the byte cap both parties " +
              "derive from their declared sizes; report it with this message.",
          ),
        ),
        { expires: "2026-07-14T11:59:00.000Z" },
        NOW,
      ),
    ).toBeUndefined();
  });

  test("a record with no bound never re-maps", () => {
    expect(remapLapsedRunFailure(taggedExpiryError(), {}, NOW)).toBeUndefined();
  });
});

describe("a run refused for terms this file cannot satisfy", () => {
  const AT = Date.parse("2026-07-14T12:00:00.000Z");
  const refusal = () =>
    new LinkageTermsUnsatisfiableError(
      "this input cannot satisfy every linkage key the agreed terms declare",
    );

  test("is a benign pre-connection state of its own, not a transport drop", () => {
    // It comes out of the pre-connection prepare, so no connection was attempted --
    // and it is held apart from the acquisition failure, which putting the file back
    // clears: this one reproduces on every run from the same file, so the surface it
    // reaches must not offer the run again as though it might pass.
    expect(benignRerunOutcome(refusal(), false)).toBe("terms-shortfall");
  });

  test("the input guard's own column rejection reaches the same state, live and recorded", () => {
    // The guard grades ahead of the prepare, on the same rule, so its rejection and
    // core's refusal are one state rather than two the surface must reconcile. The
    // kind the critical section stamps for it comes from the same classifier, so a
    // revisit cannot read a state the live launch never showed.
    const columns = new ManagedInputError({
      reason: "columns",
      unsatisfied: [],
      singleColumn: false,
    });
    expect(benignRerunOutcome(columns, false)).toBe("terms-shortfall");
    expect(managedInputFailureKind(columns.rejection)).toBe("terms-shortfall");
    // An acquisition failure stays the retryable input state.
    const acquire = new ManagedInputError({
      reason: "acquire",
      cause: new Error("gone"),
    });
    expect(benignRerunOutcome(acquire, false)).toBe("input");
    expect(managedInputFailureKind(acquire.rejection)).toBe("input");
  });

  test("records its own tier, not the transport drop and not the input problem", () => {
    // The transport tier is retried in place and the input tier is re-picked in
    // place; this refusal reproduces on every run from the same file, so either
    // would send the next visit after a remedy that refuses identically.
    expect(rerunFailureLastRun(refusal(), AT, false, false)).toEqual({
      at: new Date(AT).toISOString(),
      outcome: "failed",
      failureKind: "terms-shortfall",
    });
  });

  test("a linkage refusal after the data exchange began records transport, not terms-shortfall", () => {
    // The "terms-shortfall" tier's copy tells the operator nothing left this device,
    // which only the phase boundary can prove. Core raises this refusal inside the
    // pre-connection prepare today; this pins that the tier depends on the boundary
    // rather than on where the refusal happens to be raised, so a later call site
    // past the boundary falls through to the neither-way transport bucket.
    expect(rerunFailureLastRun(refusal(), AT, false, true)).toEqual({
      at: new Date(AT).toISOString(),
      outcome: "failed",
      failureKind: "transport",
    });
  });

  test("keeps the terms-shortfall tier even on a cancelled run", () => {
    // The refusal is a deterministic local state read before the connection, so
    // it is not a teardown-provoked error the cancellation could explain.
    expect(rerunFailureLastRun(refusal(), AT, true, false)?.failureKind).toBe(
      "terms-shortfall",
    );
  });
});

describe("runManagedRerun: a store write that fails", () => {
  // The rejection an IndexedDB transaction abort gives a store write.
  const storeAbort = () =>
    new DOMException("the transaction was aborted", "AbortError");

  /** Seams for a run that reaches the data exchange, beginning the key
   * exchange the way the real handshake does. */
  function completingSeams(): Parameters<
    typeof runManagedRerun<string, string, string>
  >[1] {
    return {
      acquireInput: () => Promise.resolve("rows"),
      handshake: async (_input, beginKeyExchange) => {
        await beginKeyExchange();
        return "carried";
      },
      dataExchange: rotatingExchange(() => Promise.resolve("exchanged")),
    };
  }

  test("the success stamp: the run keeps its results and says the stamp was not saved", async () => {
    stubGrantingWebLocks();
    vi.mocked(recordManagedExchangeLastRun).mockRejectedValueOnce(storeAbort());

    const warn = vi
      .spyOn(getLogger("managedExchangeRun"), "warn")
      .mockImplementation(() => undefined);

    const result = await runManagedRerun(record(), completingSeams());

    expect(result.exchange).toBe("exchanged");
    expect(result.lastRun.outcome).toBe("succeeded");
    expect(result.lastRunSaved).toBe(false);
    expect(result.lastRunNotSavedReason).toBe(
      "the browser aborted the storage write",
    );
    expect(warn).toHaveBeenCalledWith(
      `managed exchange ${record().id}: the success stamp was not saved (AbortError: the transaction was aborted)`,
    );
    warn.mockRestore();
    // Only the success stamp was attempted: the run is not restated as failed.
    expect(recordManagedExchangeLastRun).toHaveBeenCalledTimes(1);
    expect(persistManagedExchangeRotation).toHaveBeenCalledTimes(1);
  });

  test("a success stamp the store takes says so", async () => {
    stubGrantingWebLocks();

    const result = await runManagedRerun(record(), completingSeams());

    expect(result.lastRunSaved).toBe(true);
    expect(result.lastRunNotSavedReason).toBeUndefined();
  });

  test("the input stamp: the input rejection still reaches the caller", async () => {
    stubGrantingWebLocks();
    vi.mocked(recordManagedExchangeLastRun).mockRejectedValue(storeAbort());
    const inputFailure = new ManagedInputError({
      reason: "acquire",
      cause: new Error("the entry was not found"),
    });

    await expect(
      runManagedRerun(record(), {
        ...unreachableSeams,
        acquireInput: () => Promise.reject(inputFailure),
      }),
    ).rejects.toBe(inputFailure);
  });

  test("the rotation-in-flight marker: the run stops before rotating, and its failure stamp is attempted", async () => {
    stubGrantingWebLocks();
    const markerFailure = storeAbort();
    vi.mocked(markManagedExchangeRotationInFlight).mockRejectedValueOnce(
      markerFailure,
    );
    let dataExchangeRan = false;

    await expect(
      runManagedRerun(record(), {
        ...completingSeams(),
        dataExchange: () => {
          dataExchangeRan = true;
          return Promise.resolve("exchanged");
        },
      }),
    ).rejects.toBe(markerFailure);

    expect(persistManagedExchangeRotation).not.toHaveBeenCalled();
    expect(dataExchangeRan).toBe(false);
    expect(recordManagedExchangeLastRun).toHaveBeenCalledTimes(1);
  });

  test("the rotation persist: the storage failure reaches the caller and is stamped", async () => {
    stubGrantingWebLocks();
    vi.mocked(persistManagedExchangeRotation).mockRejectedValueOnce(
      storeAbort(),
    );

    await expect(
      runManagedRerun(record(), completingSeams()),
    ).rejects.toBeInstanceOf(RotationPersistError);

    const [, lastRun] = vi.mocked(recordManagedExchangeLastRun).mock.calls[0];
    expect(lastRun).toMatchObject({
      outcome: "failed",
      failureKind: "storage",
    });
  });

  test("the rotation persist refused over a replaced secret stops the run before the data exchange and stamps nothing", async () => {
    // A safety check: every write that replaces the secret takes the lock
    // the run holds, so the refusal is not expected to fire.
    stubGrantingWebLocks();
    const changed = new ManagedExchangeSecretChangedError("record-under-test");
    vi.mocked(persistManagedExchangeRotation).mockRejectedValueOnce(changed);
    let payloadRan = false;

    const error = await runManagedRerun(record(), {
      ...completingSeams(),
      dataExchange: rotatingExchange(() => {
        payloadRan = true;
        return Promise.resolve("exchanged");
      }),
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBe(changed);
    expect(payloadRan).toBe(false);
    expect(recordManagedExchangeLastRun).not.toHaveBeenCalled();
    expect(
      rerunFailureLastRun(error, Date.now(), false, false),
    ).toBeUndefined();
  });

  test("the rotation persist names the secret the run read inside the lock", async () => {
    stubGrantingWebLocks();
    const stored = record({ sharedSecret: HELD_SECRET });
    storedRecord.value = stored;

    await runManagedRerun(stored, completingSeams());

    expect(vi.mocked(persistManagedExchangeRotation).mock.calls[0]?.[1]).toBe(
      HELD_SECRET,
    );
  });

  test("the failure stamp after a dropped exchange, made once the lock released, is made only over the secret the rotation stored", async () => {
    stubGrantingWebLocks();
    storedRecord.value = record({ sharedSecret: HELD_SECRET });
    const rotatedSecret = generateSharedSecret();

    await runManagedRerun(storedRecord.value, {
      acquireInput: () => Promise.resolve("rows"),
      handshake: () => Promise.resolve("carried"),
      dataExchange: rotatingExchange(
        () => Promise.reject(new Error("the partner's connection dropped")),
        rotatedSecret,
      ),
    }).catch(() => undefined);

    const stamps = vi.mocked(recordManagedExchangeLastRun).mock.calls;
    expect(stamps).toHaveLength(1);
    expect(stamps[0]?.[3]).toBe(rotatedSecret);
  });

  test("the failure stamp after a terms exchange that ended before the store is made over the secret the run read", async () => {
    stubGrantingWebLocks();
    storedRecord.value = record({ sharedSecret: HELD_SECRET });

    await runManagedRerun(storedRecord.value, {
      acquireInput: () => Promise.resolve("rows"),
      handshake: () => Promise.resolve("carried"),
      dataExchange: () =>
        Promise.reject(new Error("the partner refused the terms")),
    }).catch(() => undefined);

    expect(persistManagedExchangeRotation).not.toHaveBeenCalled();
    const stamps = vi.mocked(recordManagedExchangeLastRun).mock.calls;
    expect(stamps).toHaveLength(1);
    expect(stamps[0]?.[3]).toBe(HELD_SECRET);
  });

  test("the storage stamp after a failed persist: the storage failure still reaches the caller", async () => {
    stubGrantingWebLocks();
    vi.mocked(persistManagedExchangeRotation).mockRejectedValueOnce(
      storeAbort(),
    );
    vi.mocked(recordManagedExchangeLastRun).mockRejectedValue(storeAbort());

    await expect(
      runManagedRerun(record(), completingSeams()),
    ).rejects.toBeInstanceOf(RotationPersistError);
  });

  test("the failure stamp after a dropped connection: the drop still reaches the caller", async () => {
    stubGrantingWebLocks();
    vi.mocked(recordManagedExchangeLastRun).mockRejectedValue(storeAbort());
    const drop = new ConnectionError("the data channel closed", "closed");

    await expect(
      runManagedRerun(record(), {
        ...completingSeams(),
        dataExchange: () => Promise.reject(drop),
      }),
    ).rejects.toBe(drop);
    expect(recordManagedExchangeLastRun).toHaveBeenCalledTimes(1);
  });
});
