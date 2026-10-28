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
  persistManagedExchangeRelayRegistrar,
  persistManagedExchangeScheduleAdvance,
} from "@psi/managed/managedExchangeStore";
import {
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import { ManagedInputError } from "@psi/managed/managedInputGuard";
import { classifyManagedRunFailure } from "@recurring/managedRunLaunchModel";
import { enrollManagedRelayRegistrar } from "@psi/managed/managedRelayRegistration";
import { listReadableManagedLocalState } from "@psi/managed/managedLocalState";
import { reinviteManagedExchange } from "@psi/managed/managedReinviteDriver";
import { runManagedRerun } from "@psi/managed/managedRun";
import { tickManagedSchedules } from "@psi/managed/managedScheduleRunner";

import { rotatingDataExchange } from "../utils/rotatingDataExchange";

import type {
  ManagedExchangeRecord,
  NewManagedExchange,
} from "@psi/managed/managedExchangeRecord";
import type { ManagedScheduleTickSeams } from "@psi/managed/managedScheduleRunner";
import type { RelayRegistrar } from "@alcove/core";

// The stop a re-invite or a relay enrollment offers while a run of this
// window waits for its partner, on real Chromium Web Locks and IndexedDB. The
// run decides whether the stop lands: before its rotation-in-flight marker the
// run ends with nothing recorded, past it the stop is refused. The operation
// then requests the lock queued, and the scheduled window's next attempt
// queues behind it, so the attempt after a stop runs on the re-invite's
// secret. An input failure after a stop is the run's own, and a stop ends only
// the run it was asked of. Two runs of one exchange stay exclusive
// (managedRunExclusion.test.ts).

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

/** The state the run surface shows for a launch that failed with `error`. */
function launchState(
  error: unknown,
  atLaunch: ManagedExchangeRecord,
  afterRun: ManagedExchangeRecord,
) {
  return classifyManagedRunFailure(
    error,
    { atLaunch, afterRun },
    undefined,
    Date.now(),
    false,
  );
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
    const error = await run;
    expect(error).toBeInstanceOf(ManagedRunStoppedError);

    const stored = await getManagedExchange(record.id);
    expect(stored?.sharedSecret).toBe(record.sharedSecret);
    expect(stored).not.toHaveProperty("lastRun");
    expect(stored).not.toHaveProperty("rotationInFlightSince");
    expect(managedWindowRunStage(record.id)).toBeUndefined();
    expect(launchState(error, record, stored!).kind).toBe("stopped");
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
          return "carried";
        },
        dataExchange: rotatingDataExchange(generateSharedSecret(), () =>
          Promise.resolve("exchanged"),
        ),
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

describe("a stop asked while the run acquires its input", () => {
  test("an input failure that follows ends the run as itself: shown and stamped as with no stop, and the operation still follows", async () => {
    const record = await inviterRecord();
    const stop = new AbortController();
    const acquiring = deferred();
    const inputRead = deferred();

    const run = runManagedRerun(
      record,
      {
        acquireInput: async () => {
          acquiring.resolve();
          await inputRead.promise;
          throw new ManagedInputError({
            reason: "acquire",
            cause: new Error("input.csv is not in the folder"),
          });
        },
        handshake: () => Promise.reject(new Error("no handshake expected")),
        dataExchange: () => Promise.resolve("exchanged"),
      },
      { stop },
    ).catch((error: unknown) => error);
    await acquiring.promise;

    expect(managedWindowRunStage(record.id)).toBe("waiting");
    expect(stopWaitingManagedWindowRun(record.id)).toBe("stopped");
    const operation = withManagedExchangeLock(record.id, () =>
      getManagedExchange(record.id),
    );
    inputRead.resolve();

    const error = await run;
    expect(error).toBeInstanceOf(ManagedInputError);
    const stored = await getManagedExchange(record.id);
    expect(stored?.lastRun).toMatchObject({
      outcome: "failed",
      failureKind: "input",
    });
    expect(stored?.sharedSecret).toBe(record.sharedSecret);
    expect(launchState(error, record, stored!).kind).toBe("input");
    expect((await operation)?.lastRun).toEqual(stored?.lastRun);
  });

  test("an input that passes leaves the stop to end the run before it connects, recording nothing", async () => {
    const record = await inviterRecord();
    const stop = new AbortController();
    const acquiring = deferred();
    const inputRead = deferred();
    let connected = false;

    const run = runManagedRerun(
      record,
      {
        acquireInput: async () => {
          acquiring.resolve();
          await inputRead.promise;
        },
        handshake: () => {
          if (stop.signal.aborted)
            return Promise.reject(new Error("the run's signal was aborted"));
          connected = true;
          return Promise.reject(new Error("no connection expected"));
        },
        dataExchange: () => Promise.resolve("exchanged"),
      },
      { stop },
    ).catch((error: unknown) => error);
    await acquiring.promise;

    expect(stopWaitingManagedWindowRun(record.id)).toBe("stopped");
    inputRead.resolve();

    expect(await run).toBeInstanceOf(ManagedRunStoppedError);
    expect(connected).toBe(false);
    expect(await getManagedExchange(record.id)).not.toHaveProperty("lastRun");
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
          return "carried";
        },
        dataExchange: rotatingDataExchange(rotatedSecret, () =>
          Promise.resolve("exchanged"),
        ),
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
              return "carried";
            },
            dataExchange: rotatingDataExchange(generateSharedSecret(), () =>
              Promise.resolve("exchanged"),
            ),
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

/** An inviter record whose schedule window is open now. */
async function scheduledRecord(): Promise<ManagedExchangeRecord> {
  const openedAt = new Date().toISOString();
  return await inviterRecord({
    workingDirectoryHandle: await workingFolder(),
    schedule: {
      anchor: openedAt,
      intervalDays: 7,
      windowSeconds: 60 * 60,
      nextWindow: openedAt,
      consecutiveMisses: 0,
    },
  });
}

/** One tick's seams on the real store and locks, with `runAttempt` as each
 * attempt and `stopped` as the runtime's own end. */
function tickSeams(
  runAttempt: ManagedScheduleTickSeams["runAttempt"],
  stopped: () => boolean = () => false,
): ManagedScheduleTickSeams {
  return {
    now: Date.now,
    listRecords: listReadableManagedExchanges,
    readRecord: getManagedExchange,
    awaitLockTurn: awaitManagedExchangeLockTurn,
    listLocalState: listReadableManagedLocalState,
    persistAdvance: persistManagedExchangeScheduleAdvance,
    delay: () => Promise.resolve(),
    stopped,
    runAttempt,
  };
}

describe("a scheduled attempt stopped while it acquires its input", () => {
  test("whose input then fails counts as the failed window it is with no stop: no retry and no miss", async () => {
    const record = await scheduledRecord();
    const acquiring = deferred();
    const inputRead = deferred();
    let attempts = 0;

    const tick = tickManagedSchedules(
      tickSeams((scheduled) => {
        attempts += 1;
        return runManagedRerun(
          scheduled.record,
          {
            acquireInput: async () => {
              acquiring.resolve();
              await inputRead.promise;
              throw new ManagedInputError({
                reason: "acquire",
                cause: new Error("input.csv is not in the folder"),
              });
            },
            handshake: () => Promise.reject(new Error("no handshake expected")),
            dataExchange: () => Promise.resolve("exchanged"),
          },
          { lock: { ifAvailable: true }, stop: new AbortController() },
        ).then(() => undefined);
      }),
    );
    await acquiring.promise;

    expect(stopWaitingManagedWindowRun(record.id)).toBe("stopped");
    const operation = withManagedExchangeLock(record.id, () =>
      Promise.resolve("operated"),
    );
    inputRead.resolve();
    const [entry] = await tick;

    expect(await operation).toBe("operated");
    expect(entry).toMatchObject({ attempts: 1, disposition: "failed" });
    expect(attempts).toBe(1);
    const stored = await getManagedExchange(record.id);
    expect(stored?.lastRun).toMatchObject({
      outcome: "failed",
      failureKind: "input",
    });
    expect(stored?.schedule?.consecutiveMisses).toBe(0);
    expect(Date.parse(stored!.schedule!.nextWindow)).toBeGreaterThan(
      Date.parse(record.schedule!.nextWindow),
    );
  });
});

describe("two exchanges' runs in flight at once", () => {
  test("a stop for one ends only that one: the other run and the scheduled runtime go on", async () => {
    const attended = await inviterRecord({ label: "Attended exchange" });
    const scheduled = await scheduledRecord();
    const runtime = new AbortController();
    const attendedStop = new AbortController();
    let scheduledStop: AbortController | undefined;
    const attendedWaiting = deferred();
    const scheduledWaiting = deferred();
    const partnerArrives = deferred();

    const attendedRun = runManagedRerun(
      attended,
      {
        acquireInput: () => Promise.resolve(undefined),
        handshake: async () => {
          attendedWaiting.resolve();
          return await waitForPartner(attendedStop.signal);
        },
        dataExchange: () => Promise.resolve("exchanged"),
      },
      { stop: attendedStop },
    ).catch((error: unknown) => error);
    const tick = tickManagedSchedules(
      tickSeams(
        (attempt) => {
          // The run driver's own stop, fed by the runtime's signal.
          const stop = new AbortController();
          runtime.signal.addEventListener("abort", () => {
            stop.abort(runtime.signal.reason);
          });
          scheduledStop = stop;
          return runManagedRerun(
            attempt.record,
            {
              acquireInput: () => Promise.resolve(undefined),
              handshake: async (_input, markRotationInFlight) => {
                scheduledWaiting.resolve();
                await Promise.race([
                  partnerArrives.promise,
                  waitForPartner(stop.signal),
                ]);
                await markRotationInFlight();
                return "carried";
              },
              dataExchange: rotatingDataExchange(generateSharedSecret(), () =>
                Promise.resolve("exchanged"),
              ),
            },
            {
              lock: { ifAvailable: true },
              stop,
              onDataExchangeStart: attempt.onDataExchangeStart,
            },
          ).then(() => undefined);
        },
        () => runtime.signal.aborted,
      ),
    );
    await Promise.all([attendedWaiting.promise, scheduledWaiting.promise]);

    expect(stopWaitingManagedWindowRun(attended.id)).toBe("stopped");
    expect(await attendedRun).toBeInstanceOf(ManagedRunStoppedError);
    expect(managedWindowRunStage(scheduled.id)).toBe("waiting");
    expect(scheduledStop?.signal.aborted).toBe(false);
    expect(runtime.signal.aborted).toBe(false);

    partnerArrives.resolve();
    const entries = await tick;
    expect(entries.find(({ id }) => id === scheduled.id)).toMatchObject({
      attempts: 1,
      disposition: "succeeded",
    });
    expect((await getManagedExchange(scheduled.id))?.lastRun?.outcome).toBe(
      "succeeded",
    );
    expect(await getManagedExchange(attended.id)).not.toHaveProperty("lastRun");
  });
});

describe("a scheduled attempt stopped for a relay enrollment", () => {
  test("ends that attempt, not the window: the enrollment completes under the queued lock, and the next attempt reads the enrolled record", async () => {
    const record = await scheduledRecord();
    const registrar: RelayRegistrar = {
      url: "https://relay.example.org:8443",
      exchangeId: "riverbend-q3",
    };
    const asked: Array<string> = [];
    const env = {
      fetch: ((input: string | URL | Request) => {
        asked.push(String(input));
        return Promise.resolve(
          new Response(JSON.stringify({ maxAgeDays: null, lapsesAt: null }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }) as typeof globalThis.fetch,
    };
    const registrarsSeen: Array<RelayRegistrar | undefined> = [];
    const firstWaiting = deferred();

    const tick = tickManagedSchedules(
      tickSeams((scheduled) => {
        const stop = new AbortController();
        return runManagedRerun(
          scheduled.record,
          {
            acquireInput: () => Promise.resolve(undefined),
            handshake: async (_input, markRotationInFlight, current) => {
              registrarsSeen.push(current.relayRegistrar);
              if (registrarsSeen.length === 1) {
                firstWaiting.resolve();
                return await waitForPartner(stop.signal);
              }
              await markRotationInFlight();
              return "carried";
            },
            dataExchange: rotatingDataExchange(generateSharedSecret(), () =>
              Promise.resolve("exchanged"),
            ),
          },
          {
            lock: { ifAvailable: true },
            stop,
            onDataExchangeStart: scheduled.onDataExchangeStart,
          },
        ).then(() => undefined);
      }),
    );
    await firstWaiting.promise;

    expect(stopWaitingManagedWindowRun(record.id)).toBe("stopped");
    const enrolled = await enrollManagedRelayRegistrar(
      { id: record.id, registrar, lock: {} },
      {
        withLock: withManagedExchangeLock,
        getRecord: getManagedExchange,
        persistRegistrar: persistManagedExchangeRelayRegistrar,
        env,
      },
    );
    const [entry] = await tick;

    expect(enrolled.kind).toBe("enrolled");
    expect(asked).toHaveLength(1);
    expect(entry).toMatchObject({ attempts: 2, disposition: "succeeded" });
    expect(registrarsSeen).toEqual([undefined, registrar]);
    const stored = await getManagedExchange(record.id);
    expect(stored?.relayRegistrar).toEqual(registrar);
    expect(stored?.lastRun?.outcome).toBe("succeeded");
    expect(stored?.schedule?.consecutiveMisses).toBe(0);
  });
});
