/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { InviterExchangeSection } from "@exchange/InviterExchangeSection";
import { initialRun } from "@exchange/exchangeRun";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type { GeneratedInvitation } from "@psi/invitation";

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
});

// The share screen reads only the link, the code and the expiry.
function invitationAt(origin: string): GeneratedInvitation {
  const shared: Pick<GeneratedInvitation, "encoded" | "deepLink" | "expires"> =
    {
      encoded: "TOKEN",
      deepLink: `${origin}/accept#TOKEN`,
      expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
  return shared as GeneratedInvitation;
}

function renderShareScreen(origin: string, partnerAcceptsByCli = false): void {
  app.render(
    createElement(InviterExchangeSection, {
      invitation: invitationAt(origin),
      inviterName: "County Health Department",
      run: initialRun("inviter"),
      outputs: undefined,
      failure: undefined,
      runRecord: undefined,
      warnings: [],
      partnerAcceptsByCli,
      serverJob: false,
      jobId: undefined,
      reattached: undefined,
      reattaching: false,
      onTryAgain: () => {},
      onStartOver: () => {},
      onReviewAppliedTerms: () => {},
      onAbandon: () => {},
    }),
  );
}

describe("share screen reach warning", () => {
  test("an invitation created on loopback says it only works on this computer", async () => {
    renderShareScreen("http://localhost:3000");
    await expect
      .element(page.getByText("This invitation only works on this computer"))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByRole("status", {
          name: "This invitation only works on this computer",
        }),
      )
      .toBeInTheDocument();
  });

  test("an invitation created on a private address says it only works on the local network", async () => {
    renderShareScreen("http://192.168.1.20:3000");
    await expect
      .element(
        page.getByText("This invitation only works on your local network"),
      )
      .toBeInTheDocument();
    expect(
      page.getByText("This invitation only works on this computer").query(),
    ).toBeNull();
  });

  test("an invitation created on a .corp name says it only works on the local network", async () => {
    renderShareScreen("http://alcove.corp:3000");
    await expect
      .element(
        page.getByText("This invitation only works on your local network"),
      )
      .toBeInTheDocument();
    expect(app.container.textContent).toContain(
      "This page runs on an address only your network reaches",
    );
  });

  test("an invitation created on a private name under an unlisted suffix shows no warning", async () => {
    renderShareScreen("http://alcove.agency-a.example:3000");
    await expect
      .element(page.getByRole("heading", { name: "Share this invitation" }))
      .toBeInTheDocument();
    expect(app.container.textContent).not.toContain("only works on");
  });

  test("a command-line partner is pointed at the code, which names no address", async () => {
    renderShareScreen("http://127.0.0.1:3000", true);
    await expect
      .element(
        page.getByText("The invitation link only works on this computer"),
      )
      .toBeInTheDocument();
    expect(app.container.textContent).toContain(
      "Send your partner the invitation code instead of the link.",
    );
  });

  test("an invitation created on a public address shows no warning", async () => {
    renderShareScreen("https://psi.data-bridge.org");
    await expect
      .element(page.getByRole("heading", { name: "Share this invitation" }))
      .toBeInTheDocument();
    expect(app.container.textContent).not.toContain("only works on");
  });
});

describe("share screen message", () => {
  test("a browser partner's invitation offers a message holding the link", async () => {
    renderShareScreen("https://psi.data-bridge.org");
    await expect
      .element(page.getByText("A message to send"))
      .toBeInTheDocument();
    await userEvent.click(
      page.getByRole("button", { name: "Show full message" }),
    );
    const message = (
      page
        .getByRole("textbox", { name: "A message to send" })
        .element() as HTMLTextAreaElement
    ).value;
    expect(message).toContain("https://psi.data-bridge.org/accept#TOKEN");
    expect(message).toContain("https://psi.data-bridge.org/quick");
    expect(message).toContain("County Health Department");
  });

  test("a command-line partner's invitation offers no browser message", async () => {
    renderShareScreen("https://psi.data-bridge.org", true);
    await expect
      .element(page.getByRole("heading", { name: "Share this invitation" }))
      .toBeInTheDocument();
    expect(app.container.textContent).not.toContain("A message to send");
  });
});
