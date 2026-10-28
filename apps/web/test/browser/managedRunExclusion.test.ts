/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import {
  ManagedExchangeLockUnavailableError,
  awaitManagedExchangeLockTurn,
} from "@psi/managed/managedExchangeLock";
import {
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
  listReadableManagedExchanges,
  persistManagedExchangeScheduleAdvance,
} from "@psi/managed/managedExchangeStore";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";
import { listReadableManagedLocalState } from "@psi/managed/managedLocalState";
import { runManagedRerun } from "@psi/managed/managedRun";
import { tickManagedSchedules } from "@psi/managed/managedScheduleRunner";

import { rotatingDataExchange } from "../utils/rotatingDataExchange";

import type {
  ManagedScheduleTickEntry,
  ManagedScheduleTickSeams,
} from "@psi/managed/managedScheduleRunner";
import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";
import type { WebRTCExchangeLocator } from "@alcove/core";

// The two run paths against each other, on real Chromium Web Locks and real
// IndexedDB: an attended Run and a scheduled attempt are the two contexts that
// can meet over one record, and the single-writer lock is what keeps at most one
// of them exchanging with the partner; two windows' scheduled runtimes meet the
// same way. Both directions go through the real run
// path, so the acquisition, the refusal, and the window's own bookkeeping are
// the ones the app runs.

const WINDOW_SECONDS = 60 * 60;

const linkageTerms = getDefaultLinkageTerms("County Health Dept");
const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

/** A deferred promise, so a test can hold a run's payload exchange open across
 * the moment the other context tries to start one. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = () => {
      settle();
    };
  });
  return { promise, resolve };
}

/** A folder the runner accepts as the record's working folder. Nothing under
 * test reads from it: every run's phases are supplied by this file. */
async function workingFolder(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return await root.getDirectoryHandle("exclusion-folder", { create: true });
}

/** A record whose schedule window is open now, so one tick occupies it. */
async function recordWithOpenWindow(): Promise<ManagedExchangeRecord> {
  const openedAt = new Date().toISOString();
  return await createManagedExchange({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: webrtcLocator,
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    workingDirectoryHandle: await workingFolder(),
    schedule: {
      anchor: openedAt,
      intervalDays: 7,
      windowSeconds: WINDOW_SECONDS,
      nextWindow: openedAt,
      consecutiveMisses: 0,
    },
  });
}

/** The platform boundaries one tick runs on, wired to the real store, with each
 * attempt going through the real attended run path on the scheduled runtime's
 * own fail-fast lock discipline. `attempt` supplies each attempt's phases, and
 * `delay` the pacing between attempts, which a refused attempt waits out. */
function scheduleTickSeams(
  attempt: {
    handshake: () => Promise<string>;
    dataExchange: (
      carried: string,
      persistNextSecret: (nextSecret: string) => Promise<void>,
    ) => Promise<string>;
  },
  delay: () => Promise<void> = () => Promise.resolve(),
): ManagedScheduleTickSeams {
  return {
    now: Date.now,
    listRecords: listReadableManagedExchanges,
    readRecord: getManagedExchange,
    awaitLockTurn: awaitManagedExchangeLockTurn,
    listLocalState: listReadableManagedLocalState,
    persistAdvance: persistManagedExchangeScheduleAdvance,
    delay,
    stopped: () => false,
    runAttempt: (scheduled) =>
      runManagedRerun(
        scheduled.record,
        {
          acquireInput: () => Promise.resolve(undefined),
          handshake: attempt.handshake,
          dataExchange: attempt.dataExchange,
        },
        {
          lock: { ifAvailable: true },
          onDataExchangeStart: scheduled.onDataExchangeStart,
        },
      ),
  };
}

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  await clearManagedExchanges();
});

describe("an attended Run exchanging when a scheduled attempt is due", () => {
  test("the attempt does not exchange, counts no miss, and the window ends on the Run's success", async () => {
    const created = await recordWithOpenWindow();
    const rotatedSecret = generateSharedSecret();
    const exchanging = deferred();
    const releaseExchange = deferred();
    let scheduledHandshakes = 0;

    const attended = runManagedRerun(
      created,
      {
        acquireInput: () => Promise.resolve(undefined),
        handshake: () => Promise.resolve("attended"),
        dataExchange: rotatingDataExchange(rotatedSecret, async () => {
          await releaseExchange.promise;
          return "exchanged";
        }),
      },
      { lock: { ifAvailable: true }, onDataExchangeStart: exchanging.resolve },
    );
    await exchanging.promise;

    const [entry] = await tickManagedSchedules(
      scheduleTickSeams(
        {
          handshake: () => {
            scheduledHandshakes += 1;
            return Promise.resolve("scheduled");
          },
          dataExchange: rotatingDataExchange(generateSharedSecret(), () =>
            Promise.resolve("scheduled"),
          ),
        },
        // The Run completes while the refused attempt waits out its pacing.
        async () => {
          releaseExchange.resolve();
          await attended;
        },
      ),
    );

    // No second exchange: the attempt was refused the lock before its handshake,
    // and the attempt after it found the Run's success inside the window.
    expect(scheduledHandshakes).toBe(0);
    expect(entry).toMatchObject({ attempts: 0, disposition: "succeeded" });
    const stored = await getManagedExchange(created.id);
    expect(stored?.schedule?.consecutiveMisses).toBe(0);
    // And the attended Run's own outcome is the record's, unwritten over.
    expect(stored?.lastRun?.outcome).toBe("succeeded");
    expect(stored?.sharedSecret).toBe(rotatedSecret);
  });
});

describe("a scheduled attempt exchanging when the operator runs by hand", () => {
  test("the attended Run is refused for the whole exchange", async () => {
    const created = await recordWithOpenWindow();
    const rotatedSecret = generateSharedSecret();
    const exchanging = deferred();
    const releaseExchange = deferred();

    const tick = tickManagedSchedules(
      scheduleTickSeams({
        handshake: () => Promise.resolve("scheduled"),
        dataExchange: rotatingDataExchange(rotatedSecret, async () => {
          exchanging.resolve();
          await releaseExchange.promise;
          return "scheduled";
        }),
      }),
    );
    await exchanging.promise;

    try {
      // The operator opens the app mid-exchange and presses Run: refused, and
      // told a run is already in progress, rather than dialing the partner a
      // second time.
      await expect(
        runManagedRerun(
          created,
          {
            acquireInput: () => Promise.resolve(undefined),
            handshake: () => {
              throw new Error("the attended Run must not reach the handshake");
            },
            dataExchange: () => {
              throw new Error("the attended Run must not exchange");
            },
          },
          { lock: { ifAvailable: true } },
        ),
      ).rejects.toBeInstanceOf(ManagedExchangeLockUnavailableError);
    } finally {
      releaseExchange.resolve();
    }

    const [entry] = await tick;
    expect(entry.disposition).toBe("succeeded");
    const stored = await getManagedExchange(created.id);
    expect(stored?.lastRun?.outcome).toBe("succeeded");
    expect(stored?.sharedSecret).toBe(rotatedSecret);
  });
});

describe("two app windows' scheduled runtimes ticking one exchange", () => {
  test("never hold its lock at once: one window's attempt exchanges, and the other's is refused and counts no miss", async () => {
    const created = await recordWithOpenWindow();
    const releaseExchange = deferred();
    let holding = 0;
    let mostHolding = 0;
    let handshakes = 0;
    const ticks: Array<Promise<Array<ManagedScheduleTickEntry>>> = [];
    const windowSeams = (other: number) =>
      scheduleTickSeams(
        {
          handshake: () => {
            handshakes += 1;
            holding += 1;
            mostHolding = Math.max(mostHolding, holding);
            return Promise.resolve("scheduled");
          },
          dataExchange: rotatingDataExchange(
            generateSharedSecret(),
            async () => {
              await releaseExchange.promise;
              holding -= 1;
              return "scheduled";
            },
          ),
        },
        // The refused window's pacing outlasts the other window's whole tick,
        // as a minute's pacing outlasts a stamp and an advance.
        async () => {
          releaseExchange.resolve();
          await ticks[other];
        },
      );

    // Each window's runtime keeps its own registry of records in flight, so
    // neither tick passes the record over for the other's.
    ticks.push(
      tickManagedSchedules(windowSeams(1)),
      tickManagedSchedules(windowSeams(0)),
    );
    const entries = (await Promise.all(ticks)).flat();

    expect(mostHolding).toBe(1);
    expect(handshakes).toBe(1);
    // The refused window attempts again and finds the plan the other window's
    // success advanced: it ends with nothing to record, and counts no miss.
    expect(
      entries.map(({ attempts, disposition, skipped }) => ({
        attempts,
        disposition,
        skipped,
      })),
    ).toEqual(
      expect.arrayContaining([
        { attempts: 1, disposition: "succeeded", skipped: undefined },
        { attempts: 0, disposition: undefined, skipped: "plan-moved" },
      ]),
    );
    const stored = await getManagedExchange(created.id);
    expect(stored?.lastRun?.outcome).toBe("succeeded");
    expect(stored?.schedule?.consecutiveMisses).toBe(0);
  });
});
