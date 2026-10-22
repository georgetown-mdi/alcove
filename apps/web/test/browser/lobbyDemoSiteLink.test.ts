/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { DEMO_SITE_LINK_REFUSAL, Lobby } from "@exchange/Lobby";
import { DEMO_SITE_ORIGIN, deepLinkFor } from "@psi/invitation";

import { createAppMount } from "./renderApp";

import type { DefaultRelayBuild } from "@utils/clientConfig";

// A build offering the site's relay switched off refuses a full invitation
// link made on the demo site, pasted on its start page, and takes the bare
// code of the same invitation. The demo site's own build refuses nothing.

const navigations = vi.hoisted(() => [] as Array<unknown>);
vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock({
    onNavigate: (options) => navigations.push(options),
  }),
);

const SITE_RELAY = {
  turnUrl: "turns:turn.example.org:443?transport=tcp",
  registrarUrl: "https://registrar.example.org",
};
const relayBuild = vi.hoisted((): { current: DefaultRelayBuild } => ({
  current: { kind: "none" },
}));
vi.mock("@utils/clientConfig", async (importOriginal) =>
  (await import("../utils/clientConfigMock")).clientConfigMock(importOriginal, {
    defaultRelayBuild: () => relayBuild.current,
  }),
);

const CODE = "DEMOINVITATIONCODE";
const DEMO_LINK = deepLinkFor(DEMO_SITE_ORIGIN, CODE);

const app = createAppMount();

afterEach(() => {
  app.unmount();
  navigations.length = 0;
});

const field = () =>
  page.getByRole("textbox", { name: "Have an invitation? Paste it here" });

async function review(pasted: string, build: DefaultRelayBuild) {
  relayBuild.current = build;
  app.render(createElement(Lobby));
  await userEvent.fill(field(), pasted);
  await page.getByRole("button", { name: "Review invitation" }).click();
}

describe("a demo-site invitation pasted on the start page", () => {
  test("a full link is refused where the site's relay is offered switched off, saying to open the link", async () => {
    await review(DEMO_LINK, { kind: "opt-in", relay: SITE_RELAY });

    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(DEMO_SITE_LINK_REFUSAL);
    expect(DEMO_SITE_LINK_REFUSAL).toBe(
      "This link opens an invitation on the demo site, so it was not opened " +
        "here. Open the link itself in your browser to accept it there.",
    );
    expect(navigations).toEqual([]);
  });

  test("its bare code proceeds to the review", async () => {
    await review(CODE, { kind: "opt-in", relay: SITE_RELAY });

    await vi.waitFor(() =>
      expect(navigations).toEqual([{ to: "/accept", hash: CODE }]),
    );
    expect(page.getByRole("alert").query()).toBeNull();
  });

  test.each([
    [
      "a link from another site",
      deepLinkFor("https://alcove.example.org", CODE),
      { kind: "opt-in", relay: SITE_RELAY },
    ],
    [
      "on the demo site's own build",
      DEMO_LINK,
      { kind: "on", relay: SITE_RELAY },
    ],
  ] as const)("%s proceeds to the review", async (_case, pasted, build) => {
    await review(pasted, build);

    await vi.waitFor(() =>
      expect(navigations).toEqual([{ to: "/accept", hash: CODE }]),
    );
  });
});
