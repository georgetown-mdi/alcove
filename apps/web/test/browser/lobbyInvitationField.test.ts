/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { encodeInvitation, generateSharedSecret } from "@alcove/core";

import { PASTE_INVITATION_FIELD_ID, deepLinkFor } from "@psi/invitation";
import { DirectExchangeScreen } from "@exchange/DirectExchangeScreen";
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

// Each test picks the runtime: this tab is never the installed app, so the
// lobby's isInstalledRuntime() answers what the test sets.
const runtime = vi.hoisted(() => ({ installed: false }));
vi.mock("@utils/installedRuntime", () => ({
  isInstalledRuntime: () => runtime.installed,
}));

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
  runtime.installed = false;
});

describe.each([
  { buildName: "hosted", isConsole: false },
  { buildName: "console", isConsole: true },
])("lobby invitation field ($buildName build)", ({ isConsole }) => {
  test("the field is named by its card heading", async () => {
    build.console = isConsole;
    app.render(createElement(Lobby));
    const field = page.getByRole("textbox", {
      name: "Have an invitation? Paste it here",
      exact: true,
    });
    await expect.element(field).toBeInTheDocument();
    expect(field.element().id).toBe(PASTE_INVITATION_FIELD_ID);
  });

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

describe("lobby link to the step-by-step instructions", () => {
  test.each([
    ["hosted", false, "https://data-bridge.org/"],
    ["console", true, "https://data-bridge.org/console-start"],
  ])(
    "the %s build links its instructions on the project site",
    async (_name, isConsole, href) => {
      build.console = isConsole;
      runtime.installed = false;
      app.render(createElement(Lobby));
      await expect
        .element(page.getByText(/^First time here\?/))
        .toHaveTextContent(
          "First time here? Follow the step-by-step instructions (opens in a " +
            "new tab) to run an exchange.",
        );
      const link = page.getByRole("link", {
        name: "step-by-step instructions (opens in a new tab)",
        exact: true,
      });
      await expect.element(link).toHaveAttribute("href", href);
      await expect.element(link).toHaveAttribute("target", "_blank");
      await expect.element(link).toHaveAttribute("rel", "noreferrer");
    },
  );

  test("the hosted quick exchange page links the instructions for starting the console", async () => {
    build.console = false;
    app.render(createElement(DirectExchangeScreen));
    const link = page.getByRole("link", {
      name: "instructions for starting the console",
      exact: true,
    });
    await expect
      .element(link)
      .toHaveAttribute("href", "https://data-bridge.org/console-start");
    await expect.element(link).toHaveAttribute("target", "_blank");
  });
});

describe("lobby pointer to the other ways to use Alcove", () => {
  const line =
    "For SFTP, a shared folder, or scheduled runs on your own servers, see " +
    "the instructions for the other ways to use Alcove (opens in a new tab).";
  const pointer = () => page.getByText(/^For SFTP, a shared folder/);

  test("the hosted build in a browser tab shows it and links the instructions home", async () => {
    build.console = false;
    runtime.installed = false;
    app.render(createElement(Lobby));
    await expect
      .element(
        page.getByText(
          "Find records you have in common while keeping PII private, then " +
            "exchange data about those records.",
          { exact: true },
        ),
      )
      .toBeInTheDocument();
    await expect.element(pointer()).toHaveTextContent(line);
    const heading = page.getByRole("heading", {
      name: "More options",
    });
    await expect.element(heading).toBeInTheDocument();
    const headingEl = heading.element();
    const pointerEl = pointer().element();
    expect(
      headingEl.compareDocumentPosition(pointerEl) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(headingEl.nextElementSibling).toBe(pointerEl);
    const link = page.getByRole("link", {
      name: "instructions for the other ways to use Alcove (opens in a new tab)",
      exact: true,
    });
    await expect
      .element(link)
      .toHaveAttribute("href", "https://data-bridge.org/");
    await expect.element(link).toHaveAttribute("target", "_blank");
    await expect.element(link).toHaveAttribute("rel", "noreferrer");
  });

  test("the console build does not show it", async () => {
    build.console = true;
    runtime.installed = false;
    app.render(createElement(Lobby));
    await expect.element(page.getByLabelText("Invitation")).toBeInTheDocument();
    await expect.element(pointer()).not.toBeInTheDocument();
  });

  test("the installed web app does not show it", async () => {
    build.console = false;
    runtime.installed = true;
    app.render(createElement(Lobby));
    await expect.element(page.getByLabelText("Invitation")).toBeInTheDocument();
    await expect.element(pointer()).not.toBeInTheDocument();
  });
});

describe("the site footer", () => {
  const builtBy =
    "Alcove is open-source software built by Georgetown's Massive Data " +
    "Institute (opens in a new tab).";

  test.each([
    ["hosted", false],
    ["console", true],
  ])(
    "the %s build names who builds Alcove, links its project pages on the project site in order and its source code on GitHub",
    async (_name, isConsole) => {
      build.console = isConsole;
      app.render(createElement(Lobby));
      const footer = page.getByRole("contentinfo");
      await expect.element(footer.getByText(builtBy)).toBeInTheDocument();
      const institute = footer.getByRole("link", {
        name: "Georgetown's Massive Data Institute (opens in a new tab)",
        exact: true,
      });
      await expect
        .element(institute)
        .toHaveAttribute("href", "https://mdi.georgetown.edu/pets/");
      await expect.element(institute).toHaveAttribute("target", "_blank");
      await expect.element(institute).toHaveAttribute("rel", "noreferrer");
      const expected = [
        ["Documentation", "https://data-bridge.org/docs/"],
        [
          "Instructions",
          isConsole
            ? "https://data-bridge.org/console-start"
            : "https://data-bridge.org/",
        ],
        ["Privacy", "https://data-bridge.org/PRIVACY"],
        ["Security", "https://data-bridge.org/SECURITY"],
        ["Support", "https://data-bridge.org/SUPPORT"],
        ["Source code", "https://github.com/georgetown-mdi/alcove"],
      ] as const;
      for (const [name, href] of expected) {
        const link = footer.getByRole("link", {
          name: `${name} (opens in a new tab)`,
          exact: true,
        });
        await expect.element(link).toHaveAttribute("href", href);
        await expect.element(link).toHaveAttribute("target", "_blank");
      }
      const row = footer.element().querySelector("p + div");
      const projectLinks = Array.from(row?.querySelectorAll("a") ?? []);
      expect(projectLinks.map((a) => a.getAttribute("href"))).toEqual(
        expected.map(([, href]) => href),
      );
      expect(footer.element().textContent).not.toMatch(/more about alcove/i);
      expect(footer.element().textContent).not.toMatch(/on github/i);
    },
  );
});
