/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  deriveAcceptedLinkageTerms,
  generateSharedSecret,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@alcove/core";
import { validateCompatibility } from "@alcove/core/testing";

import {
  ManagedExchangeLockUnavailableError,
  withManagedExchangeLock,
} from "@psi/managed/managedExchangeLock";
import {
  applyManagedTermsProposal,
  managedTermsProposalFor,
} from "@psi/managed/managedTermsProposal";
import {
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
  persistManagedExchangeRelayRegistrar,
  persistManagedExchangeTermsChange,
  persistManagedRunPayloadReceiveFill,
  persistManagedRunTermsChange,
} from "@psi/managed/managedExchangeStore";
import {
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  enrollManagedRelayRegistrar,
  stopManagedRelayRegistration,
} from "@psi/managed/managedRelayRegistration";
import {
  getManagedLocalState,
  markManagedExchangeImported,
  recordManagedExchangeTermsProposal,
} from "@psi/managed/managedLocalState";
import {
  managedWindowRunStage,
  stopWaitingManagedWindowRun,
} from "@psi/managed/managedWindowRuns";
import { reinviteManagedExchange } from "@psi/managed/managedReinviteDriver";
import { runManagedExchange } from "@psi/managed/managedExchangeRun";
import { runManagedRerun } from "@psi/managed/managedRun";

import type { LinkageTerms, RelayRegistrar } from "@alcove/core";
import type {
  ManagedExchangeRecord,
  NewManagedExchange,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { ManagedRunRecordExpectation } from "@psi/managed/managedExchangeStore";

// A run holds the exchange's lock. The terms writes take none, so each is
// usable while a run is in flight, and the run's own terms writes compare the
// stored terms with those it read at the lock, so an operator's write made
// during the run is what the record holds after it. The re-invite, relay
// enrollment and its stop take the lock, and are refused while a run holds it.
// The exports and the terms update's make, apply and column save are pinned
// usable during a run in their own suites.

const NOW = new Date("2026-10-25T12:00:00.000Z");

const LINKAGE_COLUMNS = ["first_name", "last_name", "dob", "ssn"];

const REGISTRAR: RelayRegistrar = {
  url: "https://relay-one.example.org:8443",
  exchangeId: "riverbend-q3",
};

function newExchange(
  overrides: Partial<NewManagedExchange> = {},
): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: {
        channel: "webrtc",
        host: "signaling.example.org",
        port: 3000,
        path: "/api/",
      },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

/** Hold the exchange's run lock as a run in flight does, for `during`. */
async function whileRunHolds(
  id: string,
  during: () => Promise<void>,
): Promise<void> {
  let granted!: () => void;
  const holding = new Promise<void>((resolve) => {
    granted = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = withManagedExchangeLock(id, async () => {
    granted();
    await released;
  });
  await holding;
  try {
    await during();
  } finally {
    release();
    await run;
  }
}

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  await clearManagedExchanges();
});

// Agency A invited Agency B and sends `notes`; B's stored terms do not yet
// state the list it receives, which B's run fills from A's declared terms.
const aTerms: LinkageTerms = {
  ...getDefaultLinkageTerms("Agency A", inferMetadata(LINKAGE_COLUMNS, [])),
  payload: { send: [{ name: "notes" }] },
};
const partnerTerms: LinkageTerms = {
  ...aTerms,
  payload: { send: [{ name: "notes" }, { name: "county" }] },
};

async function acceptorRecord(): Promise<RunnableManagedExchangeRecord> {
  const { payload: _payload, ...terms } = deriveAcceptedLinkageTerms(
    aTerms,
    "Agency B",
  );
  return runnableManagedExchangeOrRefuse(
    await createManagedExchange(
      newExchange({
        side: "acceptor",
        exchangeFile: composeManagedExchangeFile({
          connection: { channel: "webrtc", host: "signaling.example.org" },
          linkageTerms: terms,
        }),
      }),
    ),
  );
}

describe("an operator's terms write while a run holds the lock", () => {
  /** Run the exchange with `dataExchange` given what the run driver compares
   * its terms writes with: the terms read at the lock. */
  function runWithExpectation(
    record: RunnableManagedExchangeRecord,
    dataExchange: (expected: ManagedRunRecordExpectation) => Promise<void>,
  ) {
    let lockedTerms: LinkageTerms | undefined;
    return runManagedExchange({
      record,
      runStartedAtMs: NOW.getTime(),
      acquireInput: () => Promise.resolve(undefined),
      handshake: async (_input, markRotationInFlight, current) => {
        lockedTerms = current.exchangeFile.linkageTerms;
        await markRotationInFlight();
        return { rotatedSecret: generateSharedSecret(), handshake: "carried" };
      },
      dataExchange: async () => {
        if (lockedTerms === undefined) throw new Error("no terms were read");
        await dataExchange({ id: record.id, linkageTerms: lockedTerms });
        return "exchanged";
      },
    });
  }

  test("an apply landing before the receive fill is kept, and the run completes", async () => {
    const record = await acceptorRecord();
    let applied: ManagedExchangeRecord | undefined;
    let filled: ManagedExchangeRecord | undefined;

    const result = await runWithExpectation(record, async (expected) => {
      applied = await persistManagedExchangeTermsChange(record.id, {
        scope: "apply",
        partnerTerms,
      });
      filled = await persistManagedRunPayloadReceiveFill(expected, ["notes"]);
    });

    expect(result.lastRun.outcome).toBe("succeeded");
    expect(filled).toBeUndefined();
    const stored = await getManagedExchange(record.id);
    expect(stored?.exchangeFile.linkageTerms).toEqual(
      applied?.exchangeFile.linkageTerms,
    );
  });

  test("an apply landing after the receive fill is kept over the run's later terms write, and the run completes", async () => {
    const record = await acceptorRecord();
    let applied: ManagedExchangeRecord | undefined;
    let takenOn: ManagedExchangeRecord | undefined;

    const result = await runWithExpectation(record, async (expected) => {
      const filled = await persistManagedRunPayloadReceiveFill(expected, [
        "notes",
      ]);
      expect(filled?.exchangeFile.linkageTerms.payload?.receive).toEqual([
        { name: "notes" },
      ]);
      const afterFill = {
        ...expected,
        linkageTerms: filled!.exchangeFile.linkageTerms,
      };
      applied = await persistManagedExchangeTermsChange(record.id, {
        scope: "apply",
        partnerTerms,
      });
      takenOn = await persistManagedRunTermsChange(afterFill, {
        scope: "run",
        adoptedTerms: deriveAcceptedLinkageTerms(aTerms, "Agency B"),
        partnerTerms: aTerms,
      });
    });

    expect(result.lastRun.outcome).toBe("succeeded");
    expect(takenOn).toBeUndefined();
    const stored = await getManagedExchange(record.id);
    expect(stored?.exchangeFile.linkageTerms).toEqual(
      applied?.exchangeFile.linkageTerms,
    );
  });
});

describe("the kept proposal's apply while a run holds the lock", () => {
  test("applies the partner's terms and drops the proposal", async () => {
    const record = await acceptorRecord();
    const proposal = managedTermsProposalFor(
      {
        delta: validateCompatibility(
          record.exchangeFile.linkageTerms,
          partnerTerms,
        ).delta,
        partnerTerms,
      },
      NOW,
    );
    await recordManagedExchangeTermsProposal(record.id, proposal);

    await whileRunHolds(record.id, async () => {
      const applied = await applyManagedTermsProposal(
        record.id,
        proposal.proposedAt,
      );
      expect(
        applied.exchangeFile.linkageTerms.payload?.receive?.map(
          ({ name }) => name,
        ),
      ).toEqual(["notes", "county"]);
    });

    expect((await getManagedLocalState(record.id))?.termsProposal).toBe(
      undefined,
    );
  });
});

describe("the writes that take the run lock while a run holds it", () => {
  /** An exchange enrolled at its registrar, with backup and import markers
   * in its local-state entry, which a re-invite would drop. */
  async function enrolledExchange(): Promise<RunnableManagedExchangeRecord> {
    const created = await createManagedExchange(newExchange());
    await markManagedExchangeImported(created.id, NOW.toISOString());
    return await persistManagedExchangeRelayRegistrar(
      created.id,
      REGISTRAR,
      created.sharedSecret,
    );
  }

  /** Attempt the re-invite, an enrollment and stopping registration, each as
   * its control does without a stop, expecting each refused; returns the
   * registrar requests they made. */
  async function attemptLockedWrites(id: string): Promise<Array<string>> {
    const asked: Array<string> = [];
    const env = {
      fetch: ((input: string | URL | Request) => {
        asked.push(String(input));
        return Promise.reject(new TypeError("no request expected"));
      }) as typeof globalThis.fetch,
    };
    await expect(reinviteManagedExchange(id)).rejects.toBeInstanceOf(
      ManagedExchangeLockUnavailableError,
    );
    await expect(
      enrollManagedRelayRegistrar(
        {
          id,
          registrar: REGISTRAR,
          ownerToken: "owner-token-for-this-test-only",
        },
        {
          withLock: withManagedExchangeLock,
          getRecord: getManagedExchange,
          persistRegistrar: persistManagedExchangeRelayRegistrar,
          env,
        },
      ),
    ).rejects.toBeInstanceOf(ManagedExchangeLockUnavailableError);
    await expect(stopManagedRelayRegistration(id)).rejects.toBeInstanceOf(
      ManagedExchangeLockUnavailableError,
    );
    return asked;
  }

  test("a re-invite, an enrollment and stopping registration are each refused, and write nothing", async () => {
    const enrolled = await enrolledExchange();
    const localBefore = await getManagedLocalState(enrolled.id);
    expect(localBefore?.imported).toBeDefined();

    let asked: Array<string> = [];
    await whileRunHolds(enrolled.id, async () => {
      asked = await attemptLockedWrites(enrolled.id);
    });

    expect(asked).toEqual([]);
    expect(await getManagedExchange(enrolled.id)).toEqual(enrolled);
    expect(await getManagedLocalState(enrolled.id)).toEqual(localBefore);
  });

  test("each is refused by a run of this window waiting for its partner, which goes on waiting", async () => {
    const enrolled = await enrolledExchange();
    const localBefore = await getManagedLocalState(enrolled.id);
    const stop = new AbortController();
    let waiting!: () => void;
    const listed = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const run = runManagedRerun(
      enrolled,
      {
        acquireInput: () => Promise.resolve(undefined),
        handshake: () =>
          new Promise<never>((_resolve, reject) => {
            waiting();
            stop.signal.addEventListener("abort", () => {
              reject(new Error("the wait for the partner was aborted"));
            });
          }),
        dataExchange: () => Promise.resolve("exchanged"),
      },
      { stop },
    ).catch((error: unknown) => error);
    await listed;

    try {
      expect(await attemptLockedWrites(enrolled.id)).toEqual([]);
      expect(managedWindowRunStage(enrolled.id)).toBe("waiting");
      expect(stop.signal.aborted).toBe(false);
      expect(await getManagedExchange(enrolled.id)).toEqual(enrolled);
      expect(await getManagedLocalState(enrolled.id)).toEqual(localBefore);
    } finally {
      stopWaitingManagedWindowRun(enrolled.id);
      await run;
    }
  });

  test("each is refused by a run of this window past its rotation-in-flight marker", async () => {
    const enrolled = await enrolledExchange();
    const localBefore = await getManagedLocalState(enrolled.id);
    let marked!: () => void;
    const pastMarker = new Promise<void>((resolve) => {
      marked = resolve;
    });
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const run = runManagedRerun(
      enrolled,
      {
        acquireInput: () => Promise.resolve(undefined),
        handshake: async (_input, markRotationInFlight) => {
          await markRotationInFlight();
          marked();
          await finished;
          return {
            rotatedSecret: generateSharedSecret(),
            handshake: "carried",
          };
        },
        dataExchange: () => Promise.resolve("exchanged"),
      },
      { stop: new AbortController() },
    );
    await pastMarker;
    const marking = await getManagedExchange(enrolled.id);
    expect(marking?.rotationInFlightSince).toBeDefined();

    try {
      expect(managedWindowRunStage(enrolled.id)).toBe("exchanging");
      expect(await attemptLockedWrites(enrolled.id)).toEqual([]);
      expect(await getManagedExchange(enrolled.id)).toEqual(marking);
      expect(await getManagedLocalState(enrolled.id)).toEqual(localBefore);
    } finally {
      finish();
      await run;
    }
  });
});
