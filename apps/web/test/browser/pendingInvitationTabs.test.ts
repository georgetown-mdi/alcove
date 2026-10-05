/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import { InviterScreen } from "@exchange/InviterScreen";
import { generateInvitation } from "@psi/invitation";
import { pendingInvitationLockName } from "@exchange/pendingInvitation";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type * as PendingInvitationModule from "@exchange/pendingInvitation";

// A duplicated tab starts with a copy of its original's session storage, kept
// invitation included: one tab offers to wait on the invitation, and the other
// says where it is open. This page is one tab; an iframe is the other.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

const OFFER_HEADING = "Your invitation is still open";
const ELSEWHERE_HEADING = "Your invitation is open in another tab";

const app = createAppMount();
const frames: Array<HTMLIFrameElement> = [];

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  for (const frame of frames.splice(0)) frame.remove();
  window.sessionStorage.clear();
});

interface OtherTab {
  pendingInvitation: typeof PendingInvitationModule;
  close: () => void;
}

/**
 * Another tab: a same-origin browsing context of its own, loading the app's
 * pending-invitation module afresh, so it has its own module state and its
 * own lock manager. It reads this page's session storage, as a duplicated tab
 * reads its copy. Removing the frame is closing the tab.
 */
async function openOtherTab(): Promise<OtherTab> {
  const moduleUrl = new URL(
    "../../src/exchange/pendingInvitation.ts",
    import.meta.url,
  ).href;
  const frame = document.createElement("iframe");
  // A document of this origin, so the frame's location names the origin the
  // kept deep link was built for.
  frame.src = moduleUrl;
  const loaded = new Promise<void>((resolve) => {
    frame.addEventListener("load", () => resolve(), { once: true });
  });
  document.body.append(frame);
  frames.push(frame);
  await loaded;
  const contextWindow = frame.contentWindow as
    (Window & { eval: (source: string) => unknown }) | null;
  if (contextWindow === null) throw new Error("the other tab did not open");
  const pendingInvitation = (await contextWindow.eval(
    `import(${JSON.stringify(moduleUrl)})`,
  )) as typeof PendingInvitationModule;
  return { pendingInvitation, close: () => frame.remove() };
}

/** Mint an invitation in `tab` and keep it there, as the tab that created it
 * does; the name of its claim. */
async function mintIn(tab: OtherTab): Promise<string> {
  const invitation = await generateInvitation({
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
  });
  tab.pendingInvitation.writePendingInvitation(invitation, {
    inviterName: "Dana Okafor",
    fileName: "clients.csv",
  });
  const lockName = await pendingInvitationLockName(invitation.encoded);
  await vi.waitFor(async () => expect(await claimed(lockName)).toBe(true));
  return lockName;
}

/** Whether some tab of this origin holds the claim `lockName`. */
async function claimed(lockName: string): Promise<boolean> {
  const { held = [] } = await navigator.locks.query();
  return held.some((lock) => lock.name === lockName);
}

const heading = (name: string) => page.getByRole("heading", { name });

describe("a kept invitation in two tabs", () => {
  test("the tab that created it keeps it, and the other says it is open there", async () => {
    const creator = await openOtherTab();
    await mintIn(creator);

    app.render(createElement(InviterScreen));
    await expect.element(heading(ELSEWHERE_HEADING)).toBeInTheDocument();
    expect(heading(OFFER_HEADING).query()).toBeNull();
  });

  test("after the tab that created it closes, the first tab to look offers it and the second does not", async () => {
    const creator = await openOtherTab();
    const lockName = await mintIn(creator);
    creator.close();
    await vi.waitFor(async () => expect(await claimed(lockName)).toBe(false));

    app.render(createElement(InviterScreen));
    await expect.element(heading(OFFER_HEADING)).toBeInTheDocument();
    expect(heading(ELSEWHERE_HEADING).query()).toBeNull();

    const second = await openOtherTab();
    expect(
      (await second.pendingInvitation.offerPendingInvitation(new Date()))?.kind,
    ).toBe("open-elsewhere");
  });

  test("closing the tab that holds it lets a reload of the other offer it", async () => {
    const creator = await openOtherTab();
    const lockName = await mintIn(creator);
    app.render(createElement(InviterScreen));
    await expect.element(heading(ELSEWHERE_HEADING)).toBeInTheDocument();

    creator.close();
    await vi.waitFor(async () => expect(await claimed(lockName)).toBe(false));
    app.unmount();
    app.render(createElement(InviterScreen));
    await expect.element(heading(OFFER_HEADING)).toBeInTheDocument();
    expect(heading(ELSEWHERE_HEADING).query()).toBeNull();
  });
});
