/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  MANAGED_EXCHANGE_STORE_NAME,
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
  putManagedExchange,
  recordManagedExchangeLastRun,
} from "@psi/managed/managedExchangeStore";
import { ManagedRunSurface } from "@recurring/ManagedRunSurface";
import { RUN_OUTCOME_UNSAVED_NOTE } from "@recurring/managedRunLaunchModel";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";
import { succeededRun } from "@psi/managed/managedRunRotate";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type { ManagedExchangeRunResult } from "@psi/managed/managedExchangeRun";
import type { RunOutputs } from "@psi/runOutputs";

// A run keeps going through the store errors it does not need to stop for: a
// success stamp the store aborts leaves the results on screen with a note that
// the outcome was not saved, and a record read again while a run is in flight
// leaves the run to finish.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// What a test varies about the stubbed run. `realRun` drives the real
// run+rotate critical section with stubbed phases, its success stamp failed by
// the store when `faultStamp` is set; otherwise the run parks on `hold` until
// the test releases it.
const stub = vi.hoisted(() => ({
  realRun: false,
  faultStamp: false,
  hold: undefined as Promise<void> | undefined,
  started: undefined as (() => void) | undefined,
  signal: undefined as AbortSignal | undefined,
}));

const WITHHELD: RunOutputs = { kind: "withheld" };

vi.mock("@psi/managed/managedRunDriver", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { runManagedExchange } =
    await import("@psi/managed/managedExchangeRun");
  return {
    ...actual,
    runManagedExchangeInBrowser: async (config: {
      record: { id: string };
      signal: AbortSignal;
    }): Promise<ManagedExchangeRunResult<RunOutputs>> => {
      stub.signal = config.signal;
      if (stub.realRun)
        return await runManagedExchange({
          record: { id: config.record.id },
          runStartedAtMs: Date.now(),
          acquireInput: () => Promise.resolve(undefined),
          handshake: async (_input, markRotationInFlight) => {
            await markRotationInFlight();
            return {
              rotatedSecret: generateSharedSecret(),
              handshake: undefined,
            };
          },
          dataExchange: () => {
            if (stub.faultStamp) storeFault.armedFor = config.record.id;
            return Promise.resolve(WITHHELD);
          },
        });
      stub.started?.();
      await stub.hold;
      return {
        exchange: WITHHELD,
        lastRun: succeededRun(Date.now()),
        lastRunSaved: true,
      };
    },
  };
});

// The surface's terms section, standing in as the control whose change tells
// the page to read the stored exchange again: the real one withholds its writes
// while a run is in flight, but a write it began just before the run can land
// during it.
vi.mock("@recurring/ManagedTermsUpdate", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ManagedTermsUpdate: ({ onChanged }: { onChanged: () => void }) =>
    createElement(
      "button",
      { type: "button", onClick: onChanged },
      "Read the exchange again",
    ),
}));

/**
 * A request failure IndexedDB itself raises on the next write of the record
 * it is armed for: the write's `put` is issued as an `add` of a key the store already
 * holds, which fails the request with a ConstraintError and aborts the
 * transaction. What `transaction.error` holds at the bubbled `error` event and
 * at the `abort` event that follows is recorded, for the test to assert;
 * `aborted` resolves with the latter once the abort event fires.
 */
const storeFault = vi.hoisted(() => ({
  armedFor: undefined as string | undefined,
  atError: undefined as DOMException | null | undefined,
  requestError: undefined as DOMException | null | undefined,
  aborted: undefined as unknown as Promise<DOMException | null>,
  recordAbort: undefined as unknown as (error: DOMException | null) => void,
}));
const realPut = IDBObjectStore.prototype.put;

function installStoreFault(): void {
  IDBObjectStore.prototype.put = function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey,
  ): IDBRequest<IDBValidKey> {
    if (
      storeFault.armedFor === undefined ||
      this.name !== MANAGED_EXCHANGE_STORE_NAME ||
      (value as { id?: unknown }).id !== storeFault.armedFor
    )
      return realPut.call(this, value, key);
    storeFault.armedFor = undefined;
    const transaction = this.transaction;
    const request = this.add(value, key);
    // On the request rather than the transaction, so it runs before the
    // store's own transaction handler, whose rejection resumes the caller.
    request.addEventListener("error", () => {
      storeFault.atError = transaction.error;
      storeFault.requestError = request.error;
    });
    transaction.addEventListener("abort", () => {
      storeFault.recordAbort(transaction.error);
    });
    return request;
  };
}

async function workingFolder(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return await root.getDirectoryHandle("managed-folder", { create: true });
}

async function createExchange(label: string) {
  return await createManagedExchange({
    label,
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    workingDirectoryHandle: await workingFolder(),
  });
}

const app = createAppMount();

beforeEach(async () => {
  await clearManagedExchanges();
  installStoreFault();
  storeFault.armedFor = undefined;
  storeFault.atError = undefined;
  storeFault.requestError = undefined;
  storeFault.aborted = new Promise((resolve) => {
    storeFault.recordAbort = resolve;
  });
  stub.realRun = false;
  stub.faultStamp = false;
  stub.hold = undefined;
  stub.started = undefined;
  stub.signal = undefined;
});

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  IDBObjectStore.prototype.put = realPut;
  await clearManagedExchanges();
});

test("an aborted stamp rejects with the failed request's error, which transaction.error holds only from the abort on", async () => {
  const created = await createExchange("Riverbend quarterly");
  storeFault.armedFor = created.id;

  const rejection = await recordManagedExchangeLastRun(
    created.id,
    succeededRun(Date.now()),
    Date.now(),
  ).then(
    () => undefined,
    (reason: unknown) => reason,
  );

  // The error event, which the write rejects on, fires before the abort sets
  // transaction.error: the rejection is the request's own error.
  expect(storeFault.atError).toBeNull();
  expect(storeFault.requestError?.name).toBe("ConstraintError");
  expect(rejection).toBe(storeFault.requestError);
  // The abort event follows in a later task, holding the same error.
  expect(await storeFault.aborted).toBe(storeFault.requestError);
  expect((await getManagedExchange(created.id))?.lastRun).toBeUndefined();
});

test("a run whose success stamp the store aborts shows its results and says the outcome was not saved", async () => {
  const created = await createExchange("Riverbend quarterly");
  stub.realRun = true;
  stub.faultStamp = true;
  app.render(createElement(ManagedRunSurface, { id: created.id }));
  const runButton = page.getByRole("button", { name: "Run exchange" });
  await expect.element(runButton).toBeEnabled();
  await runButton.click();

  await expect
    .element(page.getByRole("heading", { name: "Run complete" }))
    .toBeInTheDocument();
  await expect
    .element(page.getByText(RUN_OUTCOME_UNSAVED_NOTE.title))
    .toBeInTheDocument();
  await expect
    .element(page.getByText(RUN_OUTCOME_UNSAVED_NOTE.message))
    .toBeInTheDocument();
  // The abort was IndexedDB's own, with the timing the store write reads. The
  // note shows once the write rejects at the error event; the abort event
  // follows in a later task, so it may not have fired yet.
  expect(storeFault.atError).toBeNull();
  expect((await storeFault.aborted)?.name).toBe("ConstraintError");
  // The rotation committed before the stamp; the stamp did not.
  const stored = await getManagedExchange(created.id);
  expect(stored?.sharedSecret).not.toBe(created.sharedSecret);
  expect(stored?.lastRun).toBeUndefined();
});

test("a run whose success stamp the store takes shows no such note", async () => {
  const created = await createExchange("Riverbend quarterly");
  stub.realRun = true;
  app.render(createElement(ManagedRunSurface, { id: created.id }));
  const runButton = page.getByRole("button", { name: "Run exchange" });
  await expect.element(runButton).toBeEnabled();
  await runButton.click();

  await expect
    .element(page.getByRole("heading", { name: "Run complete" }))
    .toBeInTheDocument();
  expect(
    page.getByText(RUN_OUTCOME_UNSAVED_NOTE.title).elements(),
  ).toHaveLength(0);
  expect((await getManagedExchange(created.id))?.lastRun?.outcome).toBe(
    "succeeded",
  );
});

test("a record read again during a run leaves the run to finish", async () => {
  const created = await createExchange("Riverbend quarterly");
  let release!: () => void;
  stub.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    stub.started = resolve;
  });
  app.render(createElement(ManagedRunSurface, { id: created.id }));
  const runButton = page.getByRole("button", { name: "Run exchange" });
  await expect.element(runButton).toBeEnabled();
  await runButton.click();
  await started;

  const stored = await getManagedExchange(created.id);
  if (stored === undefined) throw new Error("the exchange is gone");
  await putManagedExchange({ ...stored, label: "Riverbend annual" });
  await page.getByRole("button", { name: "Read the exchange again" }).click();
  await expect
    .element(page.getByRole("heading", { name: "Riverbend annual" }))
    .toBeInTheDocument();
  expect(stub.signal?.aborted).toBe(false);

  release();
  await expect
    .element(page.getByRole("heading", { name: "Run complete" }))
    .toBeInTheDocument();
});
