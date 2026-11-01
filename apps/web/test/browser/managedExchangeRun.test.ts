/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  deriveHistoryVerifier,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@alcove/core";

import {
  MANAGED_EXCHANGE_LOCAL_STORE_NAME,
  ManagedExchangeSecretChangedError,
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
  openManagedExchangeDatabase,
  persistManagedExchangeRotation,
  recordManagedExchangeLastRun,
} from "@psi/managed/managedExchangeStore";
import {
  ManagedExchangeLockUnavailableError,
  managedExchangeLockName,
  withManagedExchangeLock,
} from "@psi/managed/managedExchangeLock";
import {
  RotationPersistError,
  succeededRun,
} from "@psi/managed/managedRunRotate";
import {
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import { ManagedInputError } from "@psi/managed/managedInputGuard";
import { getManagedLocalState } from "@psi/managed/managedLocalState";
import { runManagedExchange } from "@psi/managed/managedExchangeRun";

import { rotatingDataExchange } from "../utils/rotatingDataExchange";
import { waitFor } from "../utils/waitFor";

import type {
  ManagedExchangeRecord,
  NewManagedExchange,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { WebRTCExchangeLocator } from "@alcove/core";

/** A stored record narrowed to the runnable shape these fixtures all have: every
 * record here is created with a shared secret, and the export, hand-off, and run
 * paths take the record type that holds one. */
async function createRunnableExchange(
  fields: Parameters<typeof createManagedExchange>[0],
): Promise<RunnableManagedExchangeRecord> {
  return runnableManagedExchangeOrRefuse(await createManagedExchange(fields));
}

// The platform half of the run+rotate critical section, exercised against real
// Chromium (real Web Locks and real IndexedDB): the single-writer lock's exclusion
// under contention, the no-steal property, the strict-durability field-scoped
// rotation write, and the
// persist-before-success wiring end to end. The pure ordering and decision logic is
// unit-tested in Node without either platform in test/unit/psi/managedRunRotate.test.ts.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

function newExchange(
  overrides: Partial<NewManagedExchange> = {},
): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: webrtcLocator,
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

/** A deferred promise, so a test can hold a lock open until it chooses to release
 * it and observe a contending acquisition wait or fail. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Write a raw value into the sibling local-state store, bypassing the validating
 * write path, so a test can stand up the entry a corruption or an app upgrade
 * leaves behind and drive the real read against it. */
async function putRawLocalState(id: string, value: unknown): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_LOCAL_STORE_NAME,
        "readwrite",
      );
      transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME).put(value, id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/** Whether an operator's own Run could take this record's lock right now, on the
 * attended surface's own fail-fast discipline. */
async function attendedRunCouldStart(id: string): Promise<boolean> {
  try {
    await withManagedExchangeLock(id, () => Promise.resolve(), {
      ifAvailable: true,
    });
    return true;
  } catch (error) {
    if (error instanceof ManagedExchangeLockUnavailableError) return false;
    throw error;
  }
}

/** Hold `name` from a same-origin browsing context of its own, and destroy that
 * context on demand. Standing in for a second tab: the lock's holder is the
 * frame's own lock manager, so removing the frame is the tab close, and what
 * happens to the lock is the real Web Locks implementation's answer. */
async function lockHeldByASecondContext(
  name: string,
): Promise<{ closeContext: () => void }> {
  const frame = document.createElement("iframe");
  const loaded = new Promise<void>((resolve) => {
    frame.addEventListener("load", () => resolve(), { once: true });
  });
  document.body.append(frame);
  await loaded;
  const contextWindow = frame.contentWindow;
  if (contextWindow === null)
    throw new Error("the second context did not open");
  const held = deferred<void>();
  void contextWindow.navigator.locks.request(name, () => {
    held.resolve();
    return new Promise(() => {
      // Held for as long as the context lives, the way a run parked in its
      // payload exchange holds it.
    });
  });
  await held.promise;
  return { closeContext: () => frame.remove() };
}

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  await clearManagedExchanges();
});

describe("single-writer lock", () => {
  test("a second acquisition waits for the first to release", async () => {
    const id = "record-a";
    const order: Array<string> = [];
    const firstHeld = deferred<void>();
    const release = deferred<void>();

    const first = withManagedExchangeLock(id, async () => {
      order.push("first-enter");
      firstHeld.resolve();
      await release.promise;
      order.push("first-exit");
    });

    // Only start contending once the first holder is confirmed inside the lock.
    await firstHeld.promise;
    const second = withManagedExchangeLock(id, () => {
      order.push("second-enter");
      return Promise.resolve();
    });

    try {
      // Give the second acquisition a chance to (wrongly) barge in; it must not.
      await new Promise((r) => setTimeout(r, 50));
      expect(order).toEqual(["first-enter"]);
    } finally {
      // Release even if the assertion above throws, so a failing test cannot
      // strand the exclusive lock for the rest of the page's life.
      release.resolve();
      await Promise.all([first, second]);
    }
    // The second entered only after the first released -- serialized, not raced.
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
  });

  test("distinct record ids do not contend", async () => {
    const held = deferred<void>();
    const release = deferred<void>();
    const first = withManagedExchangeLock("record-a", async () => {
      held.resolve();
      await release.promise;
    });
    await held.promise;
    try {
      // A different id's lock is a different name, so it runs immediately.
      await expect(
        withManagedExchangeLock("record-b", () => Promise.resolve("ran")),
      ).resolves.toBe("ran");
    } finally {
      release.resolve();
      await first;
    }
  });

  test("ifAvailable refuses rather than waits when the lock is held", async () => {
    const id = "record-a";
    const held = deferred<void>();
    const release = deferred<void>();
    const first = withManagedExchangeLock(id, async () => {
      held.resolve();
      await release.promise;
    });
    await held.promise;

    try {
      await expect(
        withManagedExchangeLock(id, () => Promise.resolve("ran"), {
          ifAvailable: true,
        }),
      ).rejects.toBeInstanceOf(ManagedExchangeLockUnavailableError);
    } finally {
      release.resolve();
      await first;
    }
  });

  test("the lock is taken without steal (a concurrent steal is not requested)", async () => {
    // Prove the no-steal property structurally: intercept navigator.locks.request
    // and assert the run+rotate acquisition never passes `steal: true`. A steal
    // would wrench the lock from a live holder, defeating single-writer exclusion.
    const realRequest = navigator.locks.request.bind(navigator.locks);
    const seenOptions: Array<LockOptions | undefined> = [];
    // The overloads of request() make a faithful wrapper verbose; the run path
    // always calls the (name, options, callback) form, which is all we assert.
    (navigator.locks as unknown as { request: unknown }).request = (
      name: string,
      options: LockOptions,
      callback: (lock: Lock | null) => Promise<unknown>,
    ) => {
      seenOptions.push(options);
      return realRequest(name, options, callback);
    };
    try {
      await withManagedExchangeLock("record-a", () => Promise.resolve("ran"));
    } finally {
      (navigator.locks as unknown as { request: typeof realRequest }).request =
        realRequest;
    }
    expect(seenOptions).toHaveLength(1);
    expect(seenOptions[0]?.steal).toBeUndefined();
    expect(seenOptions[0]?.mode).toBe("exclusive");
  });

  test("the lock releases when the critical section rejects", async () => {
    await expect(
      withManagedExchangeLock("record-a", () =>
        Promise.reject(new Error("run failed inside the lock")),
      ),
    ).rejects.toThrow("run failed inside the lock");
    // A failed run must not strand the lock; ifAvailable would refuse (not
    // wait) if it were still held.
    await expect(
      withManagedExchangeLock("record-a", () => Promise.resolve("ran"), {
        ifAvailable: true,
      }),
    ).resolves.toBe("ran");
  });

  test("the lock name is namespaced to the record id", () => {
    expect(managedExchangeLockName("abc")).toBe("alcove-managed-exchange:abc");
  });
});

describe("runManagedExchange: persist-before-success end to end", () => {
  test("persists the rotated secret durably before the data exchange begins", async () => {
    const created = await createRunnableExchange(newExchange());
    const rotatedSecret = generateSharedSecret();
    const order: Array<string> = [];
    // The stored record as seen at the moment the data exchange begins -- the
    // secret must already be the rotated one (the persist resolved first), and
    // no success stamp may exist yet (it is recorded only after the data
    // exchange completes).
    let storedAtDataExchange:
      Awaited<ReturnType<typeof getManagedExchange>> | undefined;

    const result = await runManagedExchange({
      record: created,
      runStartedAtMs: Date.now(),
      acquireInput: () => Promise.resolve(undefined),
      handshake: () => {
        order.push("handshake");
        return Promise.resolve("carried");
      },
      dataExchange: rotatingDataExchange(
        rotatedSecret,
        async (carried: string) => {
          order.push("dataExchange");
          storedAtDataExchange = await getManagedExchange(created.id);
          return `exchanged:${carried}`;
        },
      ),
    });

    expect(order).toEqual(["handshake", "dataExchange"]);
    expect(storedAtDataExchange?.sharedSecret).toBe(rotatedSecret);
    // No success stamp during the data exchange: succeeded is written strictly after.
    expect(storedAtDataExchange?.lastRun).toBeUndefined();
    expect(result.exchange).toBe("exchanged:carried");
    // The success outcome landed on the store.
    const stored = await getManagedExchange(created.id);
    expect(stored?.sharedSecret).toBe(rotatedSecret);
    expect(stored?.lastRun?.outcome).toBe("succeeded");
  });

  test("the rotation write uses a strict-durability transaction", async () => {
    const created = await createRunnableExchange(newExchange());
    const rotatedSecret = generateSharedSecret();

    // Observe the durability of the readwrite transactions the run opens: the
    // persist-before-success write requests strict durability (OS writeback before
    // complete), the renderer-crash-consistency the secret at rest relies on.
    const realTransaction = IDBDatabase.prototype.transaction;
    const durabilities: Array<IDBTransactionDurability | undefined> = [];
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      storeNames: string | Array<string>,
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ) {
      if (mode === "readwrite") durabilities.push(options?.durability);
      return realTransaction.call(this, storeNames, mode, options);
    };
    try {
      await runManagedExchange({
        record: created,
        runStartedAtMs: Date.now(),
        acquireInput: () => Promise.resolve(undefined),
        handshake: () => Promise.resolve("c"),
        dataExchange: rotatingDataExchange(rotatedSecret, () =>
          Promise.resolve("done"),
        ),
      });
    } finally {
      IDBDatabase.prototype.transaction = realTransaction;
    }

    // Every readwrite the run opened (the rotation persist and the lastRun record)
    // is strict; none defaulted to relaxed durability.
    expect(durabilities.length).toBeGreaterThanOrEqual(1);
    for (const durability of durabilities) expect(durability).toBe("strict");
  });

  test("the rotation write records the retired secret's verifier in the history, strict and under the run's lock", async () => {
    const olderEntry = {
      verifier: await deriveHistoryVerifier(generateSharedSecret()),
    };
    const created = await createRunnableExchange(
      newExchange({
        expires: "2099-01-01T00:00:00.000Z",
        rotationHistory: [olderEntry],
      }),
    );
    const rotatedSecret = generateSharedSecret();
    const realTransaction = IDBDatabase.prototype.transaction;
    const durabilities: Array<IDBTransactionDurability | undefined> = [];
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      storeNames: string | Array<string>,
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ) {
      if (mode === "readwrite") durabilities.push(options?.durability);
      return realTransaction.call(this, storeNames, mode, options);
    };
    let storedAtExchange: ManagedExchangeRecord | undefined;
    let lockHeldAtExchange: boolean | undefined;
    try {
      await runManagedExchange({
        record: created,
        runStartedAtMs: Date.now(),
        acquireInput: () => Promise.resolve(undefined),
        handshake: () => Promise.resolve("c"),
        dataExchange: rotatingDataExchange(rotatedSecret, async () => {
          storedAtExchange = await getManagedExchange(created.id);
          lockHeldAtExchange = !(await attendedRunCouldStart(created.id));
          return "done";
        }),
      });
    } finally {
      IDBDatabase.prototype.transaction = realTransaction;
    }

    // The history landed in the rotation write itself, while the run held the
    // lock, and every readwrite the run opened was strict.
    expect(storedAtExchange?.sharedSecret).toBe(rotatedSecret);
    expect(storedAtExchange?.rotationHistory).toEqual([
      {
        verifier: await deriveHistoryVerifier(created.sharedSecret),
        expires: "2099-01-01T00:00:00.000Z",
      },
      olderEntry,
    ]);
    expect(lockHeldAtExchange).toBe(true);
    expect(durabilities.length).toBeGreaterThanOrEqual(1);
    for (const durability of durabilities) expect(durability).toBe("strict");
  });

  describe("the previous secret across a cut run and its heal", () => {
    /** Every readwrite transaction's durability while `body` runs. */
    async function readwriteDurabilities(
      body: () => Promise<unknown>,
    ): Promise<Array<IDBTransactionDurability | undefined>> {
      const realTransaction = IDBDatabase.prototype.transaction;
      const durabilities: Array<IDBTransactionDurability | undefined> = [];
      IDBDatabase.prototype.transaction = function (
        this: IDBDatabase,
        storeNames: string | Array<string>,
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions,
      ) {
        if (mode === "readwrite") durabilities.push(options?.durability);
        return realTransaction.call(this, storeNames, mode, options);
      };
      try {
        await body();
      } finally {
        IDBDatabase.prototype.transaction = realTransaction;
      }
      return durabilities;
    }

    test("the initiator's store keeps the secret it used, the partner's save drops it, and a heal adds no history, each write strict and under the lock", async () => {
      const PREVIOUS_EXPIRES = "2099-01-01T00:00:00.000Z";
      const created = await createRunnableExchange(
        newExchange({ side: "acceptor", expires: PREVIOUS_EXPIRES }),
      );
      const cutSecret = generateSharedSecret();
      const healedSecret = generateSharedSecret();
      const cut = new Error("the partner could not save the next secret");
      let afterCutStore: ManagedExchangeRecord | undefined;
      let lockHeldAtCutStore: boolean | undefined;

      const cutDurabilities = await readwriteDurabilities(() =>
        runManagedExchange({
          record: created,
          runStartedAtMs: Date.now(),
          acquireInput: () => Promise.resolve(undefined),
          handshake: () => Promise.resolve("c"),
          dataExchange: async (_carried, persistNextSecret) => {
            await persistNextSecret(cutSecret);
            afterCutStore = await getManagedExchange(created.id);
            lockHeldAtCutStore = !(await attendedRunCouldStart(created.id));
            throw cut;
          },
        }).catch((error: unknown) => {
          if (error !== cut) throw error;
        }),
      );

      expect(lockHeldAtCutStore).toBe(true);
      expect(afterCutStore?.sharedSecret).toBe(cutSecret);
      expect(afterCutStore?.previousSharedSecret).toBe(created.sharedSecret);
      expect(afterCutStore?.previousExpires).toBe(PREVIOUS_EXPIRES);
      const retiredEntry = {
        verifier: await deriveHistoryVerifier(created.sharedSecret),
        expires: PREVIOUS_EXPIRES,
      };
      expect(afterCutStore?.rotationHistory).toEqual([retiredEntry]);
      expect(cutDurabilities.length).toBeGreaterThanOrEqual(1);
      for (const durability of cutDurabilities)
        expect(durability).toBe("strict");

      const beforeHeal = runnableManagedExchangeOrRefuse(
        (await getManagedExchange(created.id)) as ManagedExchangeRecord,
      );
      let afterHealStore: ManagedExchangeRecord | undefined;
      let afterPartnerStored: ManagedExchangeRecord | undefined;
      let lockHeldAtDrop: boolean | undefined;

      const healDurabilities = await readwriteDurabilities(() =>
        runManagedExchange({
          record: beforeHeal,
          runStartedAtMs: Date.now(),
          acquireInput: () => Promise.resolve(undefined),
          handshake: () => Promise.resolve("c"),
          dataExchange: async (
            _carried,
            persistNextSecret,
            _partnerMayHoldNextSecret,
            partnerStored,
          ) => {
            await persistNextSecret(healedSecret, {
              local: "previous",
              partner: "current",
            });
            afterHealStore = await getManagedExchange(created.id);
            await partnerStored();
            afterPartnerStored = await getManagedExchange(created.id);
            lockHeldAtDrop = !(await attendedRunCouldStart(created.id));
            return "done";
          },
        }),
      );

      // The heal's store keeps the secret its key exchange used, and the
      // history holds no entry for the cut run's secret, never shared.
      expect(afterHealStore?.sharedSecret).toBe(healedSecret);
      expect(afterHealStore?.previousSharedSecret).toBe(created.sharedSecret);
      expect(afterHealStore?.rotationHistory).toEqual([retiredEntry]);
      expect(afterPartnerStored?.sharedSecret).toBe(healedSecret);
      expect(afterPartnerStored).not.toHaveProperty("previousSharedSecret");
      expect(afterPartnerStored).not.toHaveProperty("previousExpires");
      expect(lockHeldAtDrop).toBe(true);
      expect(healDurabilities.length).toBeGreaterThanOrEqual(3);
      for (const durability of healDurabilities)
        expect(durability).toBe("strict");

      const stored = await getManagedExchange(created.id);
      expect(stored?.sharedSecret).toBe(healedSecret);
      expect(stored).not.toHaveProperty("previousSharedSecret");
      expect(stored?.lastRun).toMatchObject({
        outcome: "succeeded",
        healedCutRotation: true,
      });
    });

    test("the responder's store keeps none, and a run under both current secrets is not marked healed", async () => {
      const created = await createRunnableExchange(
        newExchange({ side: "inviter" }),
      );
      const rotatedSecret = generateSharedSecret();
      let afterStore: ManagedExchangeRecord | undefined;

      await runManagedExchange({
        record: created,
        runStartedAtMs: Date.now(),
        acquireInput: () => Promise.resolve(undefined),
        handshake: () => Promise.resolve("c"),
        dataExchange: async (_carried, persistNextSecret) => {
          await persistNextSecret(rotatedSecret);
          afterStore = await getManagedExchange(created.id);
          return "done";
        },
      });

      expect(afterStore?.sharedSecret).toBe(rotatedSecret);
      expect(afterStore).not.toHaveProperty("previousSharedSecret");
      const stored = await getManagedExchange(created.id);
      expect(stored?.lastRun?.outcome).toBe("succeeded");
      expect(stored?.lastRun).not.toHaveProperty("healedCutRotation");
    });

    test("the responder of a heal, whose partner used its previous secret, is marked healed", async () => {
      const created = await createRunnableExchange(
        newExchange({ side: "inviter" }),
      );

      await runManagedExchange({
        record: created,
        runStartedAtMs: Date.now(),
        acquireInput: () => Promise.resolve(undefined),
        handshake: () => Promise.resolve("c"),
        dataExchange: async (_carried, persistNextSecret) => {
          await persistNextSecret(generateSharedSecret(), {
            local: "current",
            partner: "previous",
          });
          return "done";
        },
      });

      const stored = await getManagedExchange(created.id);
      expect(stored).not.toHaveProperty("previousSharedSecret");
      expect(stored?.lastRun).toMatchObject({
        outcome: "succeeded",
        healedCutRotation: true,
      });
    });
  });

  test("a rotation write refused for a replaced secret leaves the history as it was", async () => {
    const created = await createRunnableExchange(newExchange());
    await expect(
      persistManagedExchangeRotation(created.id, generateSharedSecret(), {
        sharedSecret: generateSharedSecret(),
        expires: null,
      }),
    ).rejects.toBeInstanceOf(ManagedExchangeSecretChangedError);
    const stored = await getManagedExchange(created.id);
    expect(stored?.sharedSecret).toBe(created.sharedSecret);
    expect(stored?.rotationHistory).toBeUndefined();
  });

  test("the rotation write is field-scoped: it advances the secret, not the label", async () => {
    const created = await createRunnableExchange(
      newExchange({ label: "original label" }),
    );
    const rotatedSecret = generateSharedSecret();
    await runManagedExchange({
      record: created,
      runStartedAtMs: Date.now(),
      acquireInput: () => Promise.resolve(undefined),
      handshake: () => Promise.resolve("c"),
      dataExchange: rotatingDataExchange(rotatedSecret, () =>
        Promise.resolve("done"),
      ),
    });
    const stored = await getManagedExchange(created.id);
    // The rotation advanced only the secret; the document and label are intact.
    expect(stored?.sharedSecret).toBe(rotatedSecret);
    expect(stored?.label).toBe("original label");
    expect(stored?.exchangeFile).toEqual(created.exchangeFile);
  });

  test("restamps expires from tokenMaxAgeDays on a successful run", async () => {
    const created = await createRunnableExchange(
      newExchange({ tokenMaxAgeDays: 90 }),
    );
    const rotatedSecret = generateSharedSecret();
    const rotationAt = Date.parse("2026-07-14T12:00:00.000Z");
    await runManagedExchange({
      record: created,
      runStartedAtMs: Date.now(),
      acquireInput: () => Promise.resolve(undefined),
      handshake: () => Promise.resolve("c"),
      dataExchange: rotatingDataExchange(rotatedSecret, () =>
        Promise.resolve("done"),
      ),
      now: () => rotationAt,
    });
    const stored = await getManagedExchange(created.id);
    expect(stored?.expires).toBe(
      new Date(rotationAt + 90 * 86_400_000).toISOString(),
    );
  });

  test("no policy clears any standing expires bound on rotation", async () => {
    const created = await createRunnableExchange(
      newExchange({ expires: "2026-09-01T00:00:00.000Z" }),
    );
    const rotatedSecret = generateSharedSecret();
    await runManagedExchange({
      record: created,
      runStartedAtMs: Date.now(),
      acquireInput: () => Promise.resolve(undefined),
      handshake: () => Promise.resolve("c"),
      dataExchange: rotatingDataExchange(rotatedSecret, () =>
        Promise.resolve("done"),
      ),
    });
    // A record with no max-age policy must not keep a stale bound armed.
    expect((await getManagedExchange(created.id))?.expires).toBeUndefined();
  });

  test("a persist failure records a storage failure and never begins the data exchange", async () => {
    const created = await createRunnableExchange(newExchange());
    const rotatedSecret = generateSharedSecret();
    let dataExchangeRan = false;

    // Force the rotation persist to fail by aborting the FIRST readwrite
    // transaction the run opens, sparing the follow-up bookkeeping write. The
    // put's own transaction abort shows as a rejected persist, which the
    // ordering turns into the storage-tier failure.
    const realTransaction = IDBDatabase.prototype.transaction;
    let failNextReadwrite = true;
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      storeNames: string | Array<string>,
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ) {
      const transaction = realTransaction.call(this, storeNames, mode, options);
      if (mode === "readwrite" && failNextReadwrite) {
        failNextReadwrite = false;
        // Abort on the next microtask, after the store.get/put are queued, so the
        // rotation's read-modify-write transaction fails as a storage error.
        queueMicrotask(() => {
          try {
            transaction.abort();
          } catch {
            // Already settled; nothing to abort.
          }
        });
      }
      return transaction;
    };

    let error: unknown;
    try {
      await runManagedExchange({
        record: created,
        runStartedAtMs: Date.now(),
        acquireInput: () => Promise.resolve(undefined),
        handshake: () => Promise.resolve("c"),
        dataExchange: rotatingDataExchange(rotatedSecret, () => {
          dataExchangeRan = true;
          return Promise.resolve("done");
        }),
      });
    } catch (reason) {
      error = reason;
    } finally {
      IDBDatabase.prototype.transaction = realTransaction;
    }

    expect(error).toBeInstanceOf(RotationPersistError);
    expect(dataExchangeRan).toBe(false);
    // The record still holds the pre-rotation secret (the rotation did not commit),
    // and the run is recorded as a benign-tier storage failure.
    const stored = await getManagedExchange(created.id);
    expect(stored?.sharedSecret).toBe(created.sharedSecret);
    expect(stored?.lastRun?.outcome).toBe("failed");
    expect(stored?.lastRun?.failureKind).toBe("storage");
  });

  test("a total storage fault still exposes the RotationPersistError, not the bookkeeping failure", async () => {
    const created = await createRunnableExchange(newExchange());
    const rotatedSecret = generateSharedSecret();
    let dataExchangeRan = false;

    // Fail EVERY readwrite the run opens: the rotation persist fails, and so
    // does the in-catch storage bookkeeping write. The second rejection must not
    // replace the RotationPersistError -- the runner's classification, and the
    // storage lastRun the error holds, depend on the original propagating.
    const realTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      storeNames: string | Array<string>,
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ) {
      const transaction = realTransaction.call(this, storeNames, mode, options);
      if (mode === "readwrite") {
        queueMicrotask(() => {
          try {
            transaction.abort();
          } catch {
            // Already settled; nothing to abort.
          }
        });
      }
      return transaction;
    };

    let error: unknown;
    try {
      await runManagedExchange({
        record: created,
        runStartedAtMs: Date.now(),
        acquireInput: () => Promise.resolve(undefined),
        handshake: () => Promise.resolve("c"),
        dataExchange: rotatingDataExchange(rotatedSecret, () => {
          dataExchangeRan = true;
          return Promise.resolve("done");
        }),
      });
    } catch (reason) {
      error = reason;
    } finally {
      IDBDatabase.prototype.transaction = realTransaction;
    }

    // The original error survives the failed bookkeeping write, still holding
    // the storage lastRun for the runner to classify on.
    expect(error).toBeInstanceOf(RotationPersistError);
    expect((error as RotationPersistError).lastRun.failureKind).toBe("storage");
    expect(dataExchangeRan).toBe(false);
    // Nothing committed: the old secret is retained and no bookkeeping was written
    // (the write failed; the evidence travels on the error instead).
    const stored = await getManagedExchange(created.id);
    expect(stored?.sharedSecret).toBe(created.sharedSecret);
    expect(stored?.lastRun).toBeUndefined();
  });

  test("a total storage fault still exposes the ManagedInputError, not the bookkeeping failure", async () => {
    const created = await createRunnableExchange(newExchange());
    let handshakeRan = false;

    // Fail EVERY readwrite the run opens: the input tier's best-effort `input`
    // bookkeeping write fails alongside the input rejection. The second rejection
    // must not replace the ManagedInputError -- the runner's classification
    // depends on the original propagating, exactly as in the storage tier above.
    const realTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      storeNames: string | Array<string>,
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ) {
      const transaction = realTransaction.call(this, storeNames, mode, options);
      if (mode === "readwrite") {
        queueMicrotask(() => {
          try {
            transaction.abort();
          } catch {
            // Already settled; nothing to abort.
          }
        });
      }
      return transaction;
    };

    const inputFailure = new ManagedInputError({
      reason: "acquire",
      cause: new Error("the entry was not found"),
    });
    let error: unknown;
    try {
      await runManagedExchange({
        record: created,
        runStartedAtMs: Date.now(),
        acquireInput: () => Promise.reject(inputFailure),
        handshake: () => {
          handshakeRan = true;
          return Promise.resolve("c");
        },
        dataExchange: rotatingDataExchange(generateSharedSecret(), () =>
          Promise.resolve("done"),
        ),
      });
    } catch (reason) {
      error = reason;
    } finally {
      IDBDatabase.prototype.transaction = realTransaction;
    }

    // The exact instance survives the failed bookkeeping write -- not wrapped,
    // not replaced by the bookkeeping rejection.
    expect(error).toBe(inputFailure);
    // No connection was attempted and nothing committed: the guard failed before
    // the handshake, the pre-run secret is intact, and no bookkeeping was written.
    expect(handshakeRan).toBe(false);
    const stored = await getManagedExchange(created.id);
    expect(stored?.sharedSecret).toBe(created.sharedSecret);
    expect(stored?.lastRun).toBeUndefined();
  });

  test("two contended runs serialize: the second sees the first's rotated secret", async () => {
    const created = await createRunnableExchange(newExchange());
    const firstRotated = generateSharedSecret();
    const secondRotated = generateSharedSecret();
    const firstInExchange = deferred<void>();
    const releaseFirst = deferred<void>();

    // The first run parks inside its data exchange, still holding the lock. The
    // second queues behind it and rotates from the freshest stored record once
    // the first is done: the two rotations cannot interleave, so the second's
    // field-scoped write lands on the first's committed secret rather than
    // reverting it.
    const first = runManagedExchange({
      record: created,
      runStartedAtMs: Date.now(),
      acquireInput: () => Promise.resolve(undefined),
      handshake: () => Promise.resolve("1"),
      dataExchange: rotatingDataExchange(firstRotated, async () => {
        firstInExchange.resolve();
        await releaseFirst.promise;
        return "1";
      }),
    });

    await firstInExchange.promise;
    let second: Promise<unknown> = Promise.resolve();
    try {
      const secretBeforeSecond = (await getManagedExchange(created.id))
        ?.sharedSecret;
      expect(secretBeforeSecond).toBe(firstRotated);

      second = runManagedExchange({
        record: { id: created.id },
        runStartedAtMs: Date.now(),
        acquireInput: () => Promise.resolve(undefined),
        handshake: () => Promise.resolve("2"),
        dataExchange: rotatingDataExchange(secondRotated, () =>
          Promise.resolve("2"),
        ),
      });
    } finally {
      // Unpark the first run even if an assertion above throws, so neither run
      // hangs the suite.
      releaseFirst.resolve();
      await Promise.all([first, second]);
    }

    // The second rotation advanced the secret without reverting the first's write.
    expect((await getManagedExchange(created.id))?.sharedSecret).toBe(
      secondRotated,
    );
  });

  test("a data-exchange failure propagates unchanged, with the rotation kept and no success recorded", async () => {
    const created = await createRunnableExchange(newExchange());
    const rotatedSecret = generateSharedSecret();
    const failure = new Error("data channel dropped mid-exchange");

    const error: unknown = await runManagedExchange({
      record: created,
      runStartedAtMs: Date.now(),
      acquireInput: () => Promise.resolve(undefined),
      handshake: () => Promise.resolve("c"),
      dataExchange: rotatingDataExchange(rotatedSecret, () =>
        Promise.reject(failure),
      ),
    }).then(
      () => {
        throw new Error(
          "the run should have rejected with the exchange failure",
        );
      },
      (reason: unknown) => reason,
    );

    // The exact instance propagates -- not wrapped, not re-tagged -- for the
    // runner to classify and record.
    expect(error).toBe(failure);
    const stored = await getManagedExchange(created.id);
    // The rotation is real even though the exchange then failed: both parties
    // stored the next secret at the terms exchange, so the persisted secret
    // must stay rotated.
    expect(stored?.sharedSecret).toBe(rotatedSecret);
    // No succeeded outcome was recorded; the failure bookkeeping is the runner's.
    expect(stored?.lastRun).toBeUndefined();
  });

  test("a sibling entry an earlier version marked handed off does not stop a run", async () => {
    // No gate reads a handed-off state: the run goes ahead, and its rotation
    // drops the entry this build cannot parse along with the markers it clears.
    const created = await createRunnableExchange(newExchange());
    await putRawLocalState(created.id, {
      spent: { spentAt: "2026-07-14T09:00:00.000Z", handoff: "command-line" },
    });
    const rotatedSecret = generateSharedSecret();

    const result = await runManagedExchange({
      record: created,
      runStartedAtMs: Date.now(),
      acquireInput: () => Promise.resolve(undefined),
      handshake: () => Promise.resolve("c"),
      dataExchange: rotatingDataExchange(rotatedSecret, () =>
        Promise.resolve("done"),
      ),
    });

    expect(result.exchange).toBe("done");
    expect((await getManagedExchange(created.id))?.sharedSecret).toBe(
      rotatedSecret,
    );
    expect(await getManagedLocalState(created.id)).toBeUndefined();
  });

  test("a slow run's stale success tail cannot mask a newer outcome", async () => {
    const created = await createRunnableExchange(newExchange());
    const earlierRunAt = Date.parse("2026-07-14T12:00:00.000Z");
    const laterRunAt = Date.parse("2026-07-14T13:00:00.000Z");
    const runInExchange = deferred<void>();
    const releaseRun = deferred<void>();

    // The run parks in its data exchange, holding the lock; its success
    // bookkeeping will land last, stamped with the older clock. It stands in for
    // the write the lock does not bind -- a failing run's bookkeeping tail,
    // stamped and written after its own lock has released (managedRun.ts) --
    // arriving behind the newer entry written here.
    const run = runManagedExchange({
      record: created,
      runStartedAtMs: Date.now(),
      acquireInput: () => Promise.resolve(undefined),
      handshake: () => Promise.resolve("1"),
      dataExchange: rotatingDataExchange(generateSharedSecret(), async () => {
        runInExchange.resolve();
        await releaseRun.promise;
        return "1";
      }),
      now: () => earlierRunAt,
    });

    await runInExchange.promise;
    try {
      await recordManagedExchangeLastRun(
        created.id,
        succeededRun(laterRunAt),
        laterRunAt,
      );
    } finally {
      releaseRun.resolve();
      await run;
    }

    // The run's tail wrote last, but with an older stamp: the monotonic
    // bookkeeping write no-ops, keeping the newer outcome.
    expect((await getManagedExchange(created.id))?.lastRun?.at).toBe(
      new Date(laterRunAt).toISOString(),
    );
  });
});

describe("the lock spans the payload exchange", () => {
  /** Park a run inside its payload exchange and hand back what a test needs to
   * probe it: the secret it persisted, and the release that lets it finish. */
  async function runParkedInItsExchange(id: string): Promise<{
    rotatedSecret: string;
    release: () => void;
    settled: Promise<unknown>;
  }> {
    const rotatedSecret = generateSharedSecret();
    const exchanging = deferred<void>();
    const release = deferred<void>();
    const settled = runManagedExchange({
      record: { id },
      runStartedAtMs: Date.now(),
      acquireInput: () => Promise.resolve(undefined),
      handshake: () => Promise.resolve("c"),
      dataExchange: rotatingDataExchange(rotatedSecret, async () => {
        exchanging.resolve();
        await release.promise;
        return "exchanged";
      }),
    });
    await exchanging.promise;
    return {
      rotatedSecret,
      release: () => release.resolve(),
      settled: settled.catch((error: unknown) => error),
    };
  }

  test("a second attended Run is refused while the payload exchange is in flight", async () => {
    const created = await createRunnableExchange(newExchange());
    const parked = await runParkedInItsExchange(created.id);

    try {
      // The operator's own Run, on the attended surface's fail-fast discipline:
      // refused for the whole exchange, not just the rotation ahead of it.
      expect(await attendedRunCouldStart(created.id)).toBe(false);
      await expect(
        runManagedExchange({
          record: { id: created.id },
          runStartedAtMs: Date.now(),
          acquireInput: () => Promise.resolve(undefined),
          handshake: () => {
            throw new Error("a second run must not reach the handshake");
          },
          dataExchange: () => {
            throw new Error("a second run must not exchange");
          },
          lock: { ifAvailable: true },
        }),
      ).rejects.toBeInstanceOf(ManagedExchangeLockUnavailableError);
    } finally {
      parked.release();
      await parked.settled;
    }
  });

  test("the lock is free once the success stamp resolves", async () => {
    const created = await createRunnableExchange(newExchange());
    const rotatedSecret = generateSharedSecret();
    let lockHeldAtExchange: boolean | undefined;

    await runManagedExchange({
      record: created,
      runStartedAtMs: Date.now(),
      acquireInput: () => Promise.resolve(undefined),
      handshake: () => Promise.resolve("c"),
      dataExchange: rotatingDataExchange(rotatedSecret, async () => {
        lockHeldAtExchange = !(await attendedRunCouldStart(created.id));
        return "exchanged";
      }),
    });

    expect(lockHeldAtExchange).toBe(true);
    // Held to the end of the run and no further: the stamp is on the record and
    // the next run can take the lock at once.
    expect((await getManagedExchange(created.id))?.lastRun?.outcome).toBe(
      "succeeded",
    );
    expect(await attendedRunCouldStart(created.id)).toBe(true);
  });

  test("the lock is free after the payload exchange fails", async () => {
    const created = await createRunnableExchange(newExchange());
    const failure = new Error("data channel dropped mid-exchange");

    await expect(
      runManagedExchange({
        record: created,
        runStartedAtMs: Date.now(),
        acquireInput: () => Promise.resolve(undefined),
        handshake: () => Promise.resolve("c"),
        dataExchange: rotatingDataExchange(generateSharedSecret(), () =>
          Promise.reject(failure),
        ),
      }),
    ).rejects.toBe(failure);

    // A failed exchange must not strand the lock for the retry that follows it.
    expect(await attendedRunCouldStart(created.id)).toBe(true);
  });

  test("a tab closed mid-exchange releases the lock it held", async () => {
    const created = await createRunnableExchange(newExchange());
    const secondTab = await lockHeldByASecondContext(
      managedExchangeLockName(created.id),
    );
    expect(await attendedRunCouldStart(created.id)).toBe(false);

    secondTab.closeContext();

    // Polled because Web Locks raises no change event.
    await waitFor(() => attendedRunCouldStart(created.id), {
      message: "timed out waiting for the closed tab's lock to be released",
    });
    // And the record runs again, which is the whole of what the release buys.
    const rotatedSecret = generateSharedSecret();
    await runManagedExchange({
      record: created,
      runStartedAtMs: Date.now(),
      acquireInput: () => Promise.resolve(undefined),
      handshake: () => Promise.resolve("c"),
      dataExchange: rotatingDataExchange(rotatedSecret, () =>
        Promise.resolve("exchanged"),
      ),
      lock: { ifAvailable: true },
    });
    expect((await getManagedExchange(created.id))?.sharedSecret).toBe(
      rotatedSecret,
    );
  });
});

describe("a failing run never overwrites a success stamped after it began", () => {
  /** The input rejection a run's guard raises, whose benign bookkeeping the
   * critical section writes before it re-raises. */
  const inputFailure = new ManagedInputError({
    reason: "acquire",
    cause: new Error("the entry was not found"),
  });

  test("a failure stamped over a success written mid-run leaves the success", async () => {
    const created = await createRunnableExchange(newExchange());
    // Every stamp sits behind the store's own clock, which holds a stored stamp
    // from the future off nothing.
    const runStartedAtMs = Date.now() - 10_000;
    const successAt = runStartedAtMs + 1_000;

    // This run is open, another context completes a whole exchange and stamps
    // its success, and this run then fails and writes a NEWER failure stamp.
    // The failure is the newer entry, so monotonicity admits it; the run-start
    // rule is what keeps the success.
    await expect(
      runManagedExchange({
        record: created,
        runStartedAtMs,
        acquireInput: async () => {
          await recordManagedExchangeLastRun(
            created.id,
            succeededRun(successAt),
            successAt,
          );
          throw inputFailure;
        },
        handshake: () => {
          throw new Error("the handshake must not run past an input rejection");
        },
        dataExchange: () => {
          throw new Error("the data exchange must not run");
        },
        now: () => successAt + 1_000,
      }),
    ).rejects.toBe(inputFailure);

    const stored = await getManagedExchange(created.id);
    expect(stored?.lastRun).toEqual(succeededRun(successAt));
  });

  test("a failure whose run began after the success stamp records normally", async () => {
    const created = await createRunnableExchange(newExchange());
    const successAt = Date.now();
    await recordManagedExchangeLastRun(
      created.id,
      succeededRun(successAt),
      successAt,
    );

    // The same failure, from a run that opened after the success landed: this
    // one has its own window to account for, so its outcome stands.
    await expect(
      runManagedExchange({
        record: created,
        runStartedAtMs: successAt + 1_000,
        acquireInput: () => Promise.reject(inputFailure),
        handshake: () => {
          throw new Error("the handshake must not run past an input rejection");
        },
        dataExchange: () => {
          throw new Error("the data exchange must not run");
        },
        now: () => successAt + 2_000,
      }),
    ).rejects.toBe(inputFailure);

    const stored = await getManagedExchange(created.id);
    expect(stored?.lastRun?.outcome).toBe("failed");
    expect(stored?.lastRun?.failureKind).toBe("input");
  });

  test("a success writes over a stored failure whatever the run start", async () => {
    const created = await createRunnableExchange(newExchange());
    const runStartedAtMs = Date.now();
    const completedAt = runStartedAtMs + 2_000;
    await recordManagedExchangeLastRun(
      created.id,
      {
        at: new Date(runStartedAtMs + 1_000).toISOString(),
        outcome: "failed",
        failureKind: "custody-unreadable",
      },
      runStartedAtMs + 1_000,
    );

    // The rule holds a FAILURE off a newer success, never a success off
    // anything: this run completed, and its own stamp is the record's outcome.
    const result = await runManagedExchange({
      record: created,
      runStartedAtMs,
      acquireInput: () => Promise.resolve(undefined),
      handshake: () => Promise.resolve("carried"),
      dataExchange: rotatingDataExchange(generateSharedSecret(), () =>
        Promise.resolve("done"),
      ),
      now: () => completedAt,
    });

    expect(result.lastRun).toEqual(succeededRun(completedAt));
    expect((await getManagedExchange(created.id))?.lastRun).toEqual(
      succeededRun(completedAt),
    );
  });
});
