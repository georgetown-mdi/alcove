/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import {
  ManagedExchangeLockUnavailableError,
  awaitManagedExchangeLockTurn,
  managedExchangeLockName,
  withManagedExchangeLock,
} from "@psi/managed/managedExchangeLock";
import {
  ManagedRunStoppedError,
  managedWindowRunStage,
  stopWaitingManagedWindowRun,
} from "@psi/managed/managedWindowRuns";
import {
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
  listReadableManagedExchanges,
  persistManagedExchangeScheduleAdvance,
} from "@psi/managed/managedExchangeStore";
import {
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import { listReadableManagedLocalState } from "@psi/managed/managedLocalState";
import { reinviteManagedExchange } from "@psi/managed/managedReinviteDriver";
import { runManagedRerun } from "@psi/managed/managedRun";
import { tickManagedSchedules } from "@psi/managed/managedScheduleRunner";

import type {
  ManagedExchangeRecord,
  NewManagedExchange,
} from "@psi/managed/managedExchangeRecord";

// The stop a re-invite or a relay enrollment offers while a run of this
// window waits for its partner, on real Chromium Web Locks and IndexedDB. The
// run decides whether the stop lands: before its rotation-in-flight marker the
// run ends with nothing recorded, past it the stop is refused. The operation
// then requests the lock queued, and the scheduled window's next attempt
// queues behind it, so the attempt after a stop runs on the re-invite's
// secret. Two runs of one exchange stay exclusive (managedRunExclusion.test.ts).

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

/** A promise a test settles by hand. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A wait for a partner who never arrives, ended only by `signal`'s abort,
 * as the transport's own peer wait is. */
function waitForPartner(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(new Error("the wait for the partner was aborted"));
    });
  });
}

async function workingFolder(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return await root.getDirectoryHandle("stop-folder", { create: true });
}

async function inviterRecord(
  overrides: Partial<NewManagedExchange> = {},
): Promise<ManagedExchangeRecord> {
  return await createManagedExchange({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  });
}

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  await clearManagedExchanges();
});

describe("the lock order a stop relies on", () => {
  test("an operation queued while the run holds the lock is granted before a turn queued after the run released it, and an ifAvailable request between them is refused", async () => {
    const name = managedExchangeLockName("ordering");
    const order: Array<string> = [];
    const held = deferred();
    const release = deferred();
    const run = navigator.locks.request(
      name,
      { mode: "exclusive" },
      async () => {
        held.resolve();
        await release.promise;
        order.push("run released");
      },
    );
    await held.promise;

    const operation = withManagedExchangeLock("ordering", async () => {
      order.push("operation granted");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("operation released");
    });
    release.resolve();
    await run;
    // The scheduled loop asks for its turn only once the stopped attempt has
    // unwound, and its next attempt asks ifAvailable.
    const turn = awaitManagedExchangeLockTurn("ordering").then(() => {
      order.push("turn granted");
    });
    const attempt = await withManagedExchangeLock(
      "ordering",
      () => Promise.resolve("ran"),
      { ifAvailable: true },
    ).catch((error: unknown) => error);

    await Promise.all([operation, turn]);
    expect(attempt).toBeInstanceOf(ManagedExchangeLockUnavailableError);
    expect(order).toEqual([
      "run released",
      "operation granted",
      "operation released",
      "turn granted",
    ]);
  });
});

describe("a stop asked while the run waits for its partner", () => {
  test("ends the run before its marker, recording nothing", async () => {
    const record = await inviterRecord();
    const stop = new AbortController();
    const waiting = deferred();

    const run = runManagedRerun(
      record,
      {
        acquireInput: () => Promise.resolve(undefined),
        handshake: async () => {
          waiting.resolve();
          return await waitForPartner(stop.signal);
        },
        dataExchange: () => Promise.resolve("exchanged"),
      },
      { stop },
    ).catch((error: unknown) => error);
    await waiting.promise;

    expect(managedWindowRunStage(record.id)).toBe("waiting");
    expect(stopWaitingManagedWindowRun(record.id)).toBe("stopped");
    expect(await run).toBeInstanceOf(ManagedRunStoppedError);

    const stored = await getManagedExchange(record.id);
    expect(stored?.sharedSecret).toBe(record.sharedSecret);
    expect(stored).not.toHaveProperty("lastRun");
    expect(stored).not.toHaveProperty("rotationInFlightSince");
    expect(managedWindowRunStage(record.id)).toBeUndefined();
  });

  test("lands even after the channel opened, so long as the marker was not yet written", async () => {
    const record = await inviterRecord();
    const stop = new AbortController();
    const opened = deferred();
    const proceed = deferred();
    let keyExchange = false;

    const run = runManagedRerun(
      record,
      {
        acquireInput: () => Promise.resolve(undefined),
        handshake: async (_input, markRotationInFlight) => {
          opened.resolve();
          await proceed.promise;
          await markRotationInFlight();
          keyExchange = true;
          return {
            rotatedSecret: generateSharedSecret(),
            handshake: "carried",
          };
        },
        dataExchange: () => Promise.resolve("exchanged"),
      },
      { stop },
    ).catch((error: unknown) => error);
    await opened.promise;

    expect(stopWaitingManagedWindowRun(record.id)).toBe("stopped");
    proceed.resolve();

    expect(await run).toBeInstanceOf(ManagedRunStoppedError);
    expect(keyExchange).toBe(false);
    expect(await getManagedExchange(record.id)).not.toHaveProperty(
      "rotationInFlightSince",
    );
  });

  test("then lets the re-invite take the lock and write the fresh secret", async () => {
    const record = await inviterRecord();
    const stop = new AbortController();
    const waiting = deferred();
    const run = runManagedRerun(
      record,
      {
        acquireInput: () => Promise.resolve(undefined),
        handshake: async () => {
          waiting.resolve();
          return await waitForPartner(stop.signal);
        },
        dataExchange: () => Promise.resolve("exchanged"),
      },
      { stop },
    ).catch((error: unknown) => error);
    await waiting.promise;

    expect(stopWaitingManagedWindowRun(record.id)).toBe("stopped");
    const { record: reinvited } = await reinviteManagedExchange(record.id, {});

    expect(await run).toBeInstanceOf(ManagedRunStoppedError);
    expect(reinvited.sharedSecret).not.toBe(record.sharedSecret);
    expect((await getManagedExchange(record.id))?.sharedSecret).toBe(
      reinvited.sharedSecret,
    );
  });
});

describe("a stop asked once the run is past its marker", () => {
  test("is refused, and the run completes its rotation", async () => {
    const record = await inviterRecord();
    const stop = new AbortController();
    const marked = deferred();
    const finish = deferred();
    const rotatedSecret = generateSharedSecret();

    const run = runManagedRerun(
      record,
      {
        acquireInput: () => Promise.resolve(undefined),
        handshake: async (_input, markRotationInFlight) => {
          await markRotationInFlight();
          marked.resolve();
          await finish.promise;
          return { rotatedSecret, handshake: "carried" };
        },
        dataExchange: () => Promise.resolve("exchanged"),
      },
      { stop },
    );
    await marked.promise;

    expect(managedWindowRunStage(record.id)).toBe("exchanging");
    expect(stopWaitingManagedWindowRun(record.id)).toBe("exchanging");
    expect(stop.signal.aborted).toBe(false);
    await expect(reinviteManagedExchange(record.id)).rejects.toBeInstanceOf(
      ManagedExchangeLockUnavailableError,
    );
    finish.resolve();

    const result = await run;
    expect(result.lastRun.outcome).toBe("succeeded");
    expect((await getManagedExchange(record.id))?.sharedSecret).toBe(
      rotatedSecret,
    );
  });
});

describe("a scheduled attempt stopped for a re-invite", () => {
  test("ends that attempt, not the window: the next attempt runs on the re-invite's secret, and no miss is counted", async () => {
    const openedAt = new Date().toISOString();
    const record = await inviterRecord({
      workingDirectoryHandle: await workingFolder(),
      schedule: {
        anchor: openedAt,
        intervalDays: 7,
        windowSeconds: 60 * 60,
        nextWindow: openedAt,
        consecutiveMisses: 0,
      },
    });
    const secrets: Array<string> = [];
    const firstWaiting = deferred();

    const tick = tickManagedSchedules({
      now: Date.now,
      listRecords: listReadableManagedExchanges,
      readRecord: getManagedExchange,
      awaitLockTurn: awaitManagedExchangeLockTurn,
      listLocalState: listReadableManagedLocalState,
      persistAdvance: persistManagedExchangeScheduleAdvance,
      delay: () => Promise.resolve(),
      stopped: () => false,
      runAttempt: (scheduled) => {
        // Each attempt has its own stop, as the run driver gives it.
        const stop = new AbortController();
        return runManagedRerun(
          scheduled.record,
          {
            acquireInput: () => Promise.resolve(undefined),
            handshake: async (_input, markRotationInFlight, current) => {
              secrets.push(
                runnableManagedExchangeOrRefuse(current).sharedSecret,
              );
              if (secrets.length === 1) {
                firstWaiting.resolve();
                return await waitForPartner(stop.signal);
              }
              await markRotationInFlight();
              return {
                rotatedSecret: generateSharedSecret(),
                handshake: "carried",
              };
            },
            dataExchange: () => Promise.resolve("exchanged"),
          },
          {
            lock: { ifAvailable: true },
            stop,
            onDataExchangeStart: scheduled.onDataExchangeStart,
          },
        ).then(() => undefined);
      },
    });
    await firstWaiting.promise;

    expect(stopWaitingManagedWindowRun(record.id)).toBe("stopped");
    const reinvited = (await reinviteManagedExchange(record.id, {})).record
      .sharedSecret;
    const [entry] = await tick;

    expect(entry).toMatchObject({ attempts: 2, disposition: "succeeded" });
    expect(secrets).toEqual([record.sharedSecret, reinvited]);
    const stored = await getManagedExchange(record.id);
    expect(stored?.schedule?.consecutiveMisses).toBe(0);
    expect(Date.parse(stored!.schedule!.nextWindow)).toBeGreaterThan(
      Date.parse(openedAt),
    );
  });
});
