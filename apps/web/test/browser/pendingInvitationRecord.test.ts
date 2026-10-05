/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import {
  readPendingInvitation,
  usePendingInvitationRecord,
  writePendingInvitation,
} from "@exchange/pendingInvitation";
import { PendingInvitationPrune } from "@exchange/PendingInvitationPrune";
import { ResumeInvitationOffer } from "@exchange/ResumeInvitation";
import { generateInvitation } from "@psi/invitation";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type { GeneratedInvitation } from "@psi/invitation";
import type { RunFailure } from "@exchange/useInviterExchange";

// Each removal of the invitation kept for a resume, driven through the hook the
// inviter screen keeps it with, one event at a time; and the app-start prune
// that removes an expired entry on a route where that hook is not mounted.

const PENDING_KEY = "alcove-pending-invitation";

const DAY_SECONDS = 24 * 60 * 60;

const app = createAppMount();

afterEach(async () => {
  vi.useRealTimers();
  await flushPendingUpdates();
  app.unmount();
  window.sessionStorage.clear();
});

async function mint(lifetimeSeconds?: number): Promise<GeneratedInvitation> {
  return generateInvitation({
    inviterName: "Dana Okafor",
    file: new File(
      ["first_name,last_name,dob\nAnn,Lee,1990-01-02\n"],
      "clients.csv",
      { type: "text/csv" },
    ),
    location: {
      origin: window.location.origin,
      signaling: {
        host: window.location.hostname,
        port: 443,
        path: "/api/",
        secure: true,
      },
    },
    ...(lifetimeSeconds !== undefined ? { lifetimeSeconds } : {}),
  });
}

function failure(retry: RunFailure["retry"]): RunFailure {
  return { category: "exchange", title: "Failed", message: "Failed", retry };
}

function Keeper(props: {
  invitation: GeneratedInvitation | undefined;
  failure?: RunFailure;
}) {
  usePendingInvitationRecord({
    invitation: props.invitation,
    context: { inviterName: "Dana Okafor", fileName: "clients.csv" },
    outputs: undefined,
    failure: props.failure,
  });
  return null;
}

const kept = () => window.sessionStorage.getItem(PENDING_KEY);

async function expectNothingOffered() {
  await vi.waitFor(() => expect(kept()).toBeNull());
  expect(await readPendingInvitation(new Date())).toBeUndefined();
}

describe("the invitation kept for a resume is removed", () => {
  test("when its expiry passes while the screen is open", async () => {
    const invitation = await mint(2);
    app.render(createElement(Keeper, { invitation }));
    await vi.waitFor(() => expect(kept()).not.toBeNull());

    await vi.waitFor(() => expect(kept()).toBeNull(), { timeout: 6000 });
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(invitation.expires));
    expect(await readPendingInvitation(new Date())).toBeUndefined();
  });

  test("when its expiry, further out than one timer holds, passes while the screen is open", async () => {
    const invitation = await mint(30 * DAY_SECONDS);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    app.render(createElement(Keeper, { invitation }));
    await vi.waitFor(() => expect(kept()).not.toBeNull());

    vi.advanceTimersByTime(Date.parse(invitation.expires) - Date.now() - 1000);
    expect(kept()).not.toBeNull();
    vi.advanceTimersByTime(1000);
    expect(kept()).toBeNull();
  });

  test("when its expiry passed while the page was hidden, once the page is shown", async () => {
    const invitation = await mint(30 * DAY_SECONDS);
    vi.useFakeTimers({ toFake: ["Date"] });
    app.render(createElement(Keeper, { invitation }));
    await vi.waitFor(() => expect(kept()).not.toBeNull());

    vi.setSystemTime(Date.parse(invitation.expires) + 1000);
    expect(kept()).not.toBeNull();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(kept()).toBeNull();
  });

  test("when the run fails in a way the same invitation cannot retry, with nothing else", async () => {
    const invitation = await mint();
    app.render(createElement(Keeper, { invitation }));
    await vi.waitFor(() => expect(kept()).not.toBeNull());

    app.render(
      createElement(Keeper, { invitation, failure: failure("offered") }),
    );
    await flushPendingUpdates();
    expect(kept()).not.toBeNull();

    app.render(
      createElement(Keeper, { invitation, failure: failure("withheld") }),
    );
    await expectNothingOffered();
  });

  test("when the screen drops the invitation, with no failure before it", async () => {
    const invitation = await mint();
    app.render(createElement(Keeper, { invitation }));
    await vi.waitFor(() => expect(kept()).not.toBeNull());

    app.render(createElement(Keeper, { invitation: undefined }));
    await expectNothingOffered();
  });

  test("not when the screen closes with the invitation still live", async () => {
    const invitation = await mint();
    app.render(createElement(Keeper, { invitation }));
    await vi.waitFor(() => expect(kept()).not.toBeNull());

    app.unmount();
    await flushPendingUpdates();
    expect(await readPendingInvitation(new Date())).toBeDefined();
  });
});

describe("the app-start prune", () => {
  test("removes an expired entry on a route without the inviter screen", async () => {
    const invitation = await mint();
    writePendingInvitation(invitation, {
      inviterName: "Dana Okafor",
      fileName: "clients.csv",
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(invitation.expires) + 1000);

    app.render(createElement(PendingInvitationPrune));
    await vi.waitFor(() => expect(kept()).toBeNull());
  });

  test("keeps an entry that can still be waited on", async () => {
    writePendingInvitation(await mint(), {
      inviterName: "Dana Okafor",
      fileName: "clients.csv",
    });

    app.render(createElement(PendingInvitationPrune));
    await vi.waitFor(async () =>
      expect(await readPendingInvitation(new Date())).toBeDefined(),
    );
    await flushPendingUpdates();
    expect(kept()).not.toBeNull();
  });
});

describe("the resume offer", () => {
  test("gives way and removes the entry when the invitation expires while shown", async () => {
    writePendingInvitation(await mint(), {
      inviterName: "Dana Okafor",
      fileName: "clients.csv",
    });
    const pending = await readPendingInvitation(new Date());
    if (pending === undefined) throw new Error("no pending invitation");
    const expires = new Date(Date.now() + 300).toISOString();

    app.render(
      createElement(ResumeInvitationOffer, {
        pending: { ...pending, invitation: { ...pending.invitation, expires } },
        onResume: () => undefined,
        onDiscard: () => undefined,
      }),
    );
    const offer = page.getByRole("heading", {
      name: "Your invitation is still open",
    });
    await expect.element(offer).toBeInTheDocument();

    await expect
      .element(
        page
          .getByRole("status")
          .filter({ hasText: "Your earlier invitation has expired" }),
      )
      .toBeInTheDocument();
    expect(offer.query()).toBeNull();
    expect(kept()).toBeNull();
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(expires));
  });

  test("gives way when the page is shown after a 30-day invitation expired while hidden", async () => {
    writePendingInvitation(await mint(30 * DAY_SECONDS), {
      inviterName: "Dana Okafor",
      fileName: "clients.csv",
    });
    const pending = await readPendingInvitation(new Date());
    if (pending === undefined) throw new Error("no pending invitation");
    vi.useFakeTimers({ toFake: ["Date"] });

    app.render(
      createElement(ResumeInvitationOffer, {
        pending,
        onResume: () => undefined,
        onDiscard: () => undefined,
      }),
    );
    await expect
      .element(
        page.getByRole("heading", { name: "Your invitation is still open" }),
      )
      .toBeInTheDocument();
    await flushPendingUpdates();

    vi.setSystemTime(Date.parse(pending.invitation.expires) + 1000);
    document.dispatchEvent(new Event("visibilitychange"));
    await expect
      .element(
        page
          .getByRole("status")
          .filter({ hasText: "Your earlier invitation has expired" }),
      )
      .toBeInTheDocument();
    expect(kept()).toBeNull();
  });
});
