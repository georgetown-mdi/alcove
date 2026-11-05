/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  appShellUpdateHeldHere,
  appShellUpdateHoldLockName,
} from "@utils/appShellUpdateHold";
import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import { ManagedConnectionSettings } from "@recurring/ManagedConnectionSettings";
import { useBeforeUnloadPrompt } from "@exchange/useUnloadGuard";

import { createAppMount } from "./renderApp";

// What holds back the scheduled runner's apply of a waiting app update, in
// Chromium, whose Web Locks are what another window reads: an armed leave-page
// prompt holds it in every window, and an unsaved edit holds it in this one.
// The apply's own decision over both is test/unit/psi/unattendedRuntimeBoundaries.test.ts.

const app = createAppMount();

afterEach(app.unmount);

/** Whether any context of this origin holds the cross-window hold now. */
async function heldAcrossWindows(): Promise<boolean> {
  const { held } = await navigator.locks.query();
  return (
    held?.some((lock) => lock.name === appShellUpdateHoldLockName("run")) ===
    true
  );
}

function Prompt({ armed }: { armed: boolean }) {
  useBeforeUnloadPrompt(armed);
  return null;
}

describe("an armed leave-page prompt", () => {
  test("holds the update back across windows for as long as it is armed", async () => {
    app.render(createElement(Prompt, { armed: false }));
    expect(await heldAcrossWindows()).toBe(false);

    app.render(createElement(Prompt, { armed: true }));
    await vi.waitFor(async () => {
      expect(await heldAcrossWindows()).toBe(true);
    });

    app.render(createElement(Prompt, { armed: false }));
    await vi.waitFor(async () => {
      expect(await heldAcrossWindows()).toBe(false);
    });
  });
});

describe("a saved exchange's connection settings", () => {
  test("hold the update back here from an edit until it is saved", async () => {
    const record = buildManagedExchangeRecord({
      label: "Riverbend quarterly",
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms: getDefaultLinkageTerms("County Health Dept"),
      }),
      side: "acceptor",
      sharedSecret: generateSharedSecret(),
    });
    app.render(
      createElement(ManagedConnectionSettings, {
        record,
        onSave: () => Promise.resolve(),
        build: () => ({ kind: "none" as const }),
      }),
    );
    const server = page.getByRole("textbox", { name: "Coordination server" });
    await expect.element(server).toBeInTheDocument();
    expect(appShellUpdateHeldHere()).toBe(false);

    // The scheme the page's own protocol admits.
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    await userEvent.fill(server, `${scheme}://other.example.org/api/`);
    await vi.waitFor(() => {
      expect(appShellUpdateHeldHere()).toBe(true);
    });

    await page
      .getByRole("button", { name: "Save connection settings" })
      .click();
    await expect
      .element(page.getByText("Connection settings saved."))
      .toBeInTheDocument();
    expect(appShellUpdateHeldHere()).toBe(false);
  });
});
