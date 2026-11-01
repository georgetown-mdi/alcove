/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  MANAGED_EXCHANGE_LOCAL_STORE_NAME,
  MANAGED_EXCHANGE_STORE_NAME,
  clearManagedExchanges,
  createManagedExchange,
  deleteManagedExchange,
  listManagedExchanges,
  listManagedExchangesDiagnostic,
  openManagedExchangeDatabase,
  recordManagedExchangeLastRun,
} from "@psi/managed/managedExchangeStore";
import {
  STATE_UNREADABLE_NOTE,
  UNREADABLE_RECORD_LABEL,
} from "@recurring/savedExchangesRecovery";
import {
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  encodeManagedExchangeArtifact,
  serializeManagedExchangeArtifact,
} from "@psi/managed/managedExchangeArtifact";
import {
  listManagedLocalState,
  markManagedExchangeBackedUp,
} from "@psi/managed/managedLocalState";
import { SavedExchanges } from "@recurring/SavedExchanges";
import { dateLabel } from "@psi/formatting";

import { createAppMount } from "./renderApp";

import type {
  NewManagedExchange,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";

/** A stored record narrowed to the runnable shape these fixtures all have: every
 * record here is created with a shared secret, and the export, hand-off, and run
 * paths take the record type that holds one. */
async function createRunnableExchange(
  fields: Parameters<typeof createManagedExchange>[0],
): Promise<RunnableManagedExchangeRecord> {
  return runnableManagedExchangeOrRefuse(await createManagedExchange(fields));
}

// The read-failed recovery listing, against real Chromium (real IndexedDB).
// Unlike savedExchangesFailed.test.ts, which mocks the strict read, this file
// seeds an unreadable record beside a good one: the strict list read
// rejects wholesale, routing both routes to the read-failed surface, while the
// diagnostic read lists both entries with a delete-by-key. Deleting the bad
// record and reloading recovers the list to the normal run surface.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

function newExchange(
  overrides: Partial<NewManagedExchange> = {},
): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

/** Seed an arbitrary raw value under a key, so a test can plant a future-version
 * record the strict read rejects but the diagnostic read still enumerates. */
async function rawPut(value: unknown): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_STORE_NAME,
        "readwrite",
      );
      transaction.objectStore(MANAGED_EXCHANGE_STORE_NAME).put(value);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/** Seed a corrupted sibling local-state value under a key, bypassing the validating
 * write, so a test can prove the diagnostic read treats an unparseable sibling
 * conservatively (backed up on doubt). */
async function rawLocalPut(id: string, value: unknown): Promise<void> {
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
    });
  } finally {
    db.close();
  }
}

const app = createAppMount();

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  app.unmount();
  await clearManagedExchanges();
});

describe("read-failed recovery listing", () => {
  test("lists the readable record and the unreadable one, then delete-and-reload recovers", async () => {
    const good = await createRunnableExchange(
      newExchange({ label: "Riverbend quarterly" }),
    );
    // A key that sorts after any hex-first randomUUID, so the unreadable row is
    // deterministically last in the store-key-ordered listing (the delete below
    // targets the last row).
    await rawPut({
      ...good,
      id: "zzz-bad-record",
      schemaVersion: "alcove-managed-exchange/v5",
    });
    // Precondition: the strict list read rejects wholesale on the bad record.
    await expect(listManagedExchanges()).rejects.toThrow();

    app.render(createElement(SavedExchanges));

    // The read-failed surface stands, and the recovery listing shows both entries.
    await expect
      .element(
        page.getByText(
          "Your recurring exchanges could not be read from this browser",
          { exact: false },
        ),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Riverbend quarterly"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Unreadable record"))
      .toBeInTheDocument();

    // Delete the unreadable record. Two Remove buttons in the listing (one per
    // entry); the unreadable row is the second, seeded after the good one.
    const deletes = page.getByRole("button", { name: "Remove" }).all();
    await deletes[deletes.length - 1].click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Remove" })
      .click();

    // With the offending record gone, the reload recovers to the normal run
    // surface: the good record renders as a runnable row.
    await expect
      .element(page.getByRole("button", { name: "Run" }))
      .toBeInTheDocument();
    expect(page.getByText("Unreadable record").query()).toBeNull();
  });

  test("a configuration-only shared-folder record names its channel in the listing", async () => {
    const good = await createRunnableExchange(
      newExchange({ label: "Riverbend quarterly" }),
    );
    const { sharedSecret: _sharedSecret, side: _side, ...rest } = good;
    await rawPut({
      ...rest,
      id: "folder-record",
      label: "Shared folder quarterly",
      exchangeFile: {
        ...rest.exchangeFile,
        connection: { channel: "filedrop", path: "/srv/exchange" },
      },
    });
    await rawPut({
      ...good,
      id: "zzz-bad-record",
      schemaVersion: "alcove-managed-exchange/v5",
    });

    app.render(createElement(SavedExchanges));

    await expect
      .element(page.getByText("Shared folder quarterly"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Shared-folder exchange"))
      .toBeInTheDocument();
  });

  test("the recovery listing never renders the stored secret", async () => {
    const good = await createRunnableExchange(
      newExchange({ label: "Riverbend quarterly" }),
    );
    await rawPut({
      ...good,
      id: "zzz-bad-record",
      schemaVersion: "alcove-managed-exchange/v5",
    });

    app.render(createElement(SavedExchanges));

    await expect
      .element(page.getByText("Riverbend quarterly"))
      .toBeInTheDocument();
    // The secret must not appear anywhere on the recovery surface.
    expect(document.body.textContent).not.toContain(good.sharedSecret);
  });

  test("a record whose migration fails names why in its row, and no value it holds", async () => {
    const good = await createRunnableExchange(
      newExchange({ label: "Riverbend quarterly" }),
    );
    const earlierSecret = generateSharedSecret();
    await rawPut({
      ...good,
      id: "zzz-earlier-record",
      label: "Lakeside annual",
      sharedSecret: earlierSecret,
      schemaVersion: "alcove-managed-exchange/v3",
    });

    app.render(createElement(SavedExchanges));

    await expect
      .element(
        page.getByText(
          "A saved exchange is format version alcove-managed-exchange/v3, " +
            "and this version of Alcove could not move it to version " +
            "alcove-managed-exchange/v4: it has no migration from version " +
            "alcove-managed-exchange/v3. The saved exchange was not changed. " +
            "Remove it from the list of saved exchanges, then import its " +
            "backup file or set the exchange up again with your partner.",
        ),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByText(UNREADABLE_RECORD_LABEL))
      .toBeInTheDocument();
    for (const value of [
      "Lakeside annual",
      "zzz-earlier-record",
      earlierSecret,
    ])
      expect(document.body.textContent).not.toContain(value);
  });

  test("a record unreadable for another reason states no migration", async () => {
    const good = await createRunnableExchange(
      newExchange({ label: "Riverbend quarterly" }),
    );
    await rawPut({
      ...good,
      id: "zzz-bad-record",
      schemaVersion: "alcove-managed-exchange/v5",
    });

    app.render(createElement(SavedExchanges));

    await expect
      .element(page.getByText(UNREADABLE_RECORD_LABEL))
      .toBeInTheDocument();
    expect(
      page.getByText("could not move it to version", { exact: false }).query(),
    ).toBeNull();
  });
});

describe("recovery listing: the delete confirm's custody notes", () => {
  /** Seed a good record (so a readable recovery row exists to delete) beside a bad
   * one (so the surface is the read-failed one), run `seedState` to stamp any sibling
   * state on the good record BEFORE the single mount, then render the always-list
   * route. Returns the good record. Its row is first in store-key order (a hex-first
   * randomUUID sorts before "zzz-bad-record"), so the `.first()` Delete opens it. */
  async function mountReadFailedWith(
    label: string,
    seedState?: (record: RunnableManagedExchangeRecord) => Promise<unknown>,
  ): Promise<RunnableManagedExchangeRecord> {
    const good = await createRunnableExchange(newExchange({ label }));
    await rawPut({
      ...good,
      id: "zzz-bad-record",
      schemaVersion: "alcove-managed-exchange/v5",
    });
    if (seedState) await seedState(good);
    await expect(listManagedExchanges()).rejects.toThrow();
    app.render(createElement(SavedExchanges));
    await expect
      .element(page.getByText(label === "" ? "(unnamed exchange)" : label))
      .toBeInTheDocument();
    return good;
  }

  test("marker present -> the custody note shows on the recovery confirm", async () => {
    await mountReadFailedWith("Backed up partnership", (record) =>
      markManagedExchangeBackedUp(record.id, "2026-07-10T09:00:00.000Z"),
    );

    await page.getByRole("button", { name: "Remove" }).first().click();
    await expect
      .element(
        page.getByText("A backup file you exported stays in your custody", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
  });

  test("marker absent -> the custody note is not shown on the recovery confirm", async () => {
    await mountReadFailedWith("Fresh partnership");

    await page.getByRole("button", { name: "Remove" }).first().click();
    await expect
      .element(page.getByText("your partner is not notified", { exact: false }))
      .toBeInTheDocument();
    expect(
      page
        .getByText("A backup file you exported stays in your custody", {
          exact: false,
        })
        .query(),
    ).toBeNull();
  });

  test("an unparseable sibling entry -> the row names the exchange and its unreadable state, and the confirm says the accounting goes unread", async () => {
    // No bad record here: a corrupted sibling entry alone fails the strict local-state
    // read, which routes the surface to read-failed on its own. The diagnostic read
    // then lists that record's essentials with its state unreadable, backed up on
    // doubt, so its delete confirm includes the custody note.
    const good = await createRunnableExchange(
      newExchange({ label: "Doubtful partnership" }),
    );
    await recordManagedExchangeLastRun(
      good.id,
      { at: "2026-07-10T09:00:00.000Z", outcome: "succeeded" },
      Date.parse("2026-07-10T09:00:00.000Z"),
    );
    await rawLocalPut(good.id, { backup: { backedUpAt: "not-an-instant" } });
    await expect(listManagedLocalState()).rejects.toThrow();

    app.render(createElement(SavedExchanges));
    await expect
      .element(page.getByText("Doubtful partnership"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(STATE_UNREADABLE_NOTE, { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("You sent the invitation", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(dateLabel(new Date("2026-07-10T09:00:00.000Z")), {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    expect(page.getByText(UNREADABLE_RECORD_LABEL).query()).toBeNull();

    await page.getByRole("button", { name: "Remove" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect
      .element(
        dialog.getByText(
          "its accounting of disclosures cannot be read or exported, and is removed with the exchange",
          { exact: false },
        ),
      )
      .toBeInTheDocument();
    expect(
      dialog.getByText("export the accounting first", { exact: false }).query(),
    ).toBeNull();
    await expect
      .element(
        dialog.getByText("A backup file you exported stays in your custody", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
  });

  test("a readable row's confirm still offers exporting the accounting first", async () => {
    await mountReadFailedWith("Readable partnership");

    await page.getByRole("button", { name: "Remove" }).first().click();
    await expect
      .element(
        page
          .getByRole("dialog")
          .getByText("export the accounting first", { exact: false }),
      )
      .toBeInTheDocument();
  });

  test("an unlabeled readable entry's confirm displays 'Remove this exchange?', not the row's display text", async () => {
    // The row text is the display transform "(unnamed exchange)", but the confirm
    // must name the raw (empty) label, so the button's own empty-label branch fires.
    await mountReadFailedWith("");

    // The good (unlabeled) record's row is first; open its confirm.
    await page.getByRole("button", { name: "Remove" }).first().click();
    await expect
      .element(page.getByText("Remove this exchange?", { exact: false }))
      .toBeInTheDocument();
    expect(
      page.getByText('Remove "(unnamed exchange)"?', { exact: false }).query(),
    ).toBeNull();
  });
});

describe("the import this surface offers works from the read-failed state", () => {
  test("an artifact of a different exchange lands beside the unreadable record", async () => {
    // What the surface's copy offers as the way forward: one record this build cannot
    // parse must not refuse an import for an unrelated exchange. The other side
    // of the terms keeps it from reading as a copy of the good record.
    const other = await createRunnableExchange(
      newExchange({ label: "Other partnership", side: "acceptor" }),
    );
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(other),
    );
    await deleteManagedExchange(other.id);
    const good = await createRunnableExchange(
      newExchange({ label: "Riverbend quarterly" }),
    );
    await rawPut({
      ...good,
      id: "zzz-bad-record",
      schemaVersion: "alcove-managed-exchange/v5",
    });
    await expect(listManagedExchanges()).rejects.toThrow();

    app.render(createElement(SavedExchanges));
    await expect
      .element(page.getByRole("button", { name: "Import a file" }))
      .toBeInTheDocument();
    await userEvent.upload(
      page.elementLocator(
        document.querySelector('input[type="file"]') as HTMLElement,
      ),
      new File([bytes], "alcove-backup-2026-07-14.json", {
        type: "application/json",
      }),
    );

    // The imported exchange is stored, beside the good record and the bad one.
    await expect
      .poll(async () => (await listManagedExchangesDiagnostic()).length)
      .toBe(3);
    // No refusal is shown: the file read fine.
    expect(
      page.getByText("That file could not be imported").query(),
    ).toBeNull();
    // The unreadable record is left in place, still listed for the operator.
    const entries = await listManagedExchangesDiagnostic();
    expect(
      entries.flatMap((entry) =>
        entry.kind === "unreadable" ? [entry.id] : [],
      ),
    ).toEqual(["zzz-bad-record"]);
  });
});
