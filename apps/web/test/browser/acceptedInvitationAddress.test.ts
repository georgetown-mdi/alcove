/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { encodeInvitation, generateSharedSecret } from "@alcove/core";

import { ACCEPTED_INVITATION_STORAGE_KEY } from "@exchange/acceptedInvitation";
import { AcceptorScreen } from "@exchange/AcceptorScreen";

import { createAppMount } from "./renderApp";

import type { InvitationToken, LinkageTerms } from "@alcove/core";

// The acceptor's invitation arrives in the URL fragment. Once the screen has
// read it, the address bar and the history entry no longer hold it; the tab keeps
// one copy so a reload lands on the same invitation, removed when the screen is
// left or the invitation is refused. A second invitation pasted into the same
// tab's address bar replaces the first one's terms.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);
vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);
vi.mock("@psi/exchangeLifecycle", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runExchangeLifecycle: () => Promise.resolve(),
}));

function termsFrom(identity: string): LinkageTerms {
  return {
    version: "1.0.0",
    identity,
    date: "2026-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: true },
    deduplicate: false,
    linkageFields: [{ name: "lastName", type: "last_name" }],
    linkageKeys: [{ name: "last", elements: [{ field: "lastName" }] }],
  };
}

async function invitationFrom(identity: string): Promise<string> {
  const token: InvitationToken = {
    version: "1",
    linkageTerms: termsFrom(identity),
    sharedSecret: generateSharedSecret(),
    connectionEndpoint: {
      channel: "webrtc",
      host: "127.0.0.1",
      port: 3000,
      path: "/api/",
    },
  };
  return encodeInvitation(token);
}

const kept = () =>
  window.sessionStorage.getItem(ACCEPTED_INVITATION_STORAGE_KEY);

const app = createAppMount();

afterEach(() => {
  app.unmount();
  window.location.hash = "";
});

describe("the acceptor's invitation in the address", () => {
  test("is cleared from the address once read, and kept for a reload", async () => {
    const encoded = await invitationFrom("County Health Department");
    window.location.hash = encoded;
    app.render(createElement(AcceptorScreen));

    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(encoded);
    expect(kept()).toBe(encoded);
  });

  test("a reload with no fragment opens the invitation the tab kept", async () => {
    window.sessionStorage.setItem(
      ACCEPTED_INVITATION_STORAGE_KEY,
      await invitationFrom("County Health Department"),
    );
    app.render(createElement(AcceptorScreen));

    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();
  });

  test("leaving the screen removes the kept copy", async () => {
    window.location.hash = await invitationFrom("County Health Department");
    app.render(createElement(AcceptorScreen));
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    app.unmount();
    expect(kept()).toBeNull();
  });

  test("a refused invitation is not kept", async () => {
    window.location.hash = "not-an-invitation";
    app.render(createElement(AcceptorScreen));

    await expect.element(page.getByRole("alert")).toBeInTheDocument();
    expect(window.location.hash).toBe("");
    expect(kept()).toBeNull();
  });

  test("a second invitation in the same tab replaces the first one's terms", async () => {
    window.location.hash = await invitationFrom("County Health Department");
    app.render(createElement(AcceptorScreen));
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    const second = await invitationFrom("Riverbend Clinic");
    window.location.hash = second;

    await expect
      .element(page.getByText("Invitation from Riverbend Clinic"))
      .toBeInTheDocument();
    expect(
      page.getByText("Invitation from County Health Department").query(),
    ).toBeNull();
    expect(window.location.hash).toBe("");
    expect(kept()).toBe(second);
  });
});
