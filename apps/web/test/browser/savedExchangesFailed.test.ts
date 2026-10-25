/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { SavedExchanges, SavedExchangesHome } from "@recurring/SavedExchanges";

import { createAppMount } from "./renderApp";

// A read failure after a successful open (a corrupted or app-upgrade-invalidated
// record) must render the read-failed surface on both the home route (`/`) and
// the always-list route (`/saved`), never the quick path. Failure classification
// is unit-tested elsewhere; this file checks rendering, including the import
// affordance on this surface.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

// The store opens, but the record read rejects: the post-open read failure the load
// classifies as `failed`. The rest of the store module is left intact.
vi.mock("@psi/managed/managedExchangeStore", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listManagedExchanges: () => Promise.reject(new Error("corrupt record")),
  };
});

const app = createAppMount();

afterEach(app.unmount);

describe("store opens but the read fails", () => {
  test("the home route shows the read-failed surface, not the quick path", async () => {
    app.render(createElement(SavedExchangesHome));

    await expect
      .element(
        page.getByText(
          "Your recurring exchanges could not be read from this browser",
          { exact: false },
        ),
      )
      .toBeInTheDocument();

    // The lobby's one-off cards must not stand in for the loss.
    expect(
      page.getByRole("heading", { name: "Invite a partner" }).query(),
    ).toBeNull();
  });

  test("the always-list route shows the read-failed surface", async () => {
    app.render(createElement(SavedExchanges));

    await expect
      .element(
        page.getByText(
          "Your recurring exchanges could not be read from this browser",
          { exact: false },
        ),
      )
      .toBeInTheDocument();
  });

  // The read-failed surface is not a dead end: it includes the same
  // restore-from-backup import affordance the empty state has. The list read
  // rejects wholesale on any one bad record, so the import cannot mend the list,
  // but it still stores the exchange and routes straight to its run surface.
  test("the read-failed surface offers the restore-from-backup import", async () => {
    app.render(createElement(SavedExchanges));

    await expect
      .element(page.getByText("Import an exchange", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Import a file" }))
      .toBeInTheDocument();
    // The shared import stands here in place of the configuration-only one a
    // readable list offers.
    expect(
      page.getByRole("button", { name: "Import an alcove.yaml" }).query(),
    ).toBeNull();
  });
});
