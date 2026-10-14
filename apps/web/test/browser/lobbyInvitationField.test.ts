/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { encodeInvitation, generateSharedSecret } from "@alcove/core";

import { PASTE_INVITATION_FIELD_ID, deepLinkFor } from "@psi/invitation";
import { Lobby } from "@exchange/Lobby";

import { createAppMount } from "./renderApp";

import type { InvitationToken, LinkageTerms } from "@alcove/core";

// A pasted invitation link is one unbroken string of a thousand characters or
// so; the lobby's paste field must hold it in place, scrolling within itself,
// so neither the field nor the cards and page around it change size.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

// Each test picks the build: the lobby reads isConsoleBuild() as it renders.
const build = vi.hoisted(() => ({ console: false }));
vi.mock("@utils/clientConfig", async (importOriginal) => {
  const { clientConfigMock, consoleClientConfigMock } =
    await import("../utils/clientConfigMock");
  const hosted = await clientConfigMock(importOriginal);
  const consoleBuild = await consoleClientConfigMock(importOriginal);
  return Object.fromEntries(
    Object.keys(hosted).map((name) => [
      name,
      (...args: Array<unknown>) =>
        (
          (build.console ? consoleBuild : hosted) as unknown as Record<
            string,
            (...a: Array<unknown>) => unknown
          >
        )[name](...args),
    ]),
  );
});

const terms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "firstName", type: "first_name" },
    { name: "lastName", type: "last_name" },
    { name: "dateOfBirth", type: "date_of_birth" },
  ],
  linkageKeys: [
    {
      name: "full",
      elements: [
        { field: "firstName" },
        { field: "lastName" },
        { field: "dateOfBirth" },
      ],
    },
    {
      name: "last_dob",
      elements: [{ field: "lastName" }, { field: "dateOfBirth" }],
    },
  ],
};

async function mintDeepLink(): Promise<string> {
  const token: InvitationToken = {
    version: "1",
    linkageTerms: terms,
    sharedSecret: generateSharedSecret(),
    expires: new Date(Date.now() + 3600 * 1000).toISOString(),
    connectionEndpoint: {
      channel: "webrtc",
      host: "signaling.example.org",
      port: 443,
      path: "/api/",
    },
  };
  return deepLinkFor(
    "https://alcove.example.org",
    await encodeInvitation(token),
  );
}

interface Layout {
  field: { width: number; height: number };
  main: { width: number; height: number };
  pageScrollWidth: number;
}

function measureLayout(): Layout {
  const field = document.getElementById(PASTE_INVITATION_FIELD_ID);
  const main = document.querySelector("main");
  if (field === null || main === null) throw new Error("lobby not mounted");
  const fieldBox = field.getBoundingClientRect();
  const mainBox = main.getBoundingClientRect();
  return {
    field: { width: fieldBox.width, height: fieldBox.height },
    main: { width: mainBox.width, height: mainBox.height },
    pageScrollWidth: document.documentElement.scrollWidth,
  };
}

const app = createAppMount();

afterEach(() => {
  app.unmount();
  build.console = false;
});

describe.each([
  { buildName: "hosted", isConsole: false },
  { buildName: "console", isConsole: true },
])("lobby invitation field ($buildName build)", ({ isConsole }) => {
  test("a pasted full-length invitation link leaves the field and page size unchanged", async () => {
    build.console = isConsole;
    app.render(createElement(Lobby));
    const field = page.getByLabelText("Invitation");
    await expect.element(field).toBeInTheDocument();
    // The hosted lobby adds its saved-exchanges pointer once its store read
    // settles; measure after it, so only the paste can change the layout.
    if (!isConsole)
      await expect
        .element(page.getByRole("link", { name: "Recurring exchanges" }))
        .toBeInTheDocument();
    const before = measureLayout();
    expect(before.pageScrollWidth).toBeLessThanOrEqual(window.innerWidth);

    const link = await mintDeepLink();
    expect(link.length).toBeGreaterThan(800);
    await userEvent.fill(field, link);
    await expect.element(field).toHaveValue(link);

    expect(measureLayout()).toEqual(before);
    const textarea = field.element() as HTMLTextAreaElement;
    expect(textarea.scrollHeight).toBeGreaterThan(textarea.clientHeight);
  });
});
