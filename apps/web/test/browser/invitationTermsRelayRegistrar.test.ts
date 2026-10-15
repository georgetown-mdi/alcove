/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import { CONSENT_FACTS } from "@alcove/core";

import { InvitationTerms } from "@components/InvitationTerms";

import { createAppMount } from "./renderApp";
import { readyDisclosures } from "./collapsePanels";

import type { ConnectionEndpoint, LinkageTerms } from "@alcove/core";

// The registrar an invitation's relay names, on the accept screen of each
// build. A console run is the CLI's and enrolls there before it connects; a
// browser run does not, so the hosted line only names it.

// Each test picks the build: the terms read isConsoleBuild() as they render.
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
    { name: "last_name", type: "last_name" },
    { name: "dob", type: "date_of_birth" },
  ],
  linkageKeys: [
    { name: "LN + DOB", elements: [{ field: "last_name" }, { field: "dob" }] },
  ],
};

const TURN_URL = "turns:default-relay.example.net:443?transport=tcp";
const REGISTRAR = "https://default-relay.example.net";

const CONSOLE_LINE =
  `Each run registers this exchange at ${REGISTRAR} before it connects, ` +
  "and whoever runs that registrar learns this machine's network address.";
const HOSTED_LINE = `The invitation also names this relay's registrar: ${REGISTRAR}`;

const app = createAppMount();

afterEach(() => {
  app.unmount();
  build.console = false;
});

async function producesText(
  connectionEndpoint: ConnectionEndpoint,
): Promise<string> {
  app.render(
    createElement(InvitationTerms, { linkageTerms: terms, connectionEndpoint }),
  );
  await readyDisclosures(app.container);
  const produces = page.getByRole("group", {
    name: "What the exchange produces",
  });
  await expect.element(produces).toBeInTheDocument();
  return produces.element().textContent;
}

describe("InvitationTerms: the registrar an invitation's relay names", () => {
  test.each([
    { profile: "console", isConsole: true, line: CONSOLE_LINE },
    { profile: "hosted", isConsole: false, line: HOSTED_LINE },
  ])(
    "the $profile build names the registrar beside the relay's urls",
    async ({ isConsole, line }) => {
      build.console = isConsole;
      const text = await producesText({
        channel: "webrtc",
        host: "peer.example.org",
        relay: { turn: [TURN_URL], registrar: REGISTRAR },
      });
      expect(text).toContain(`TURN ${TURN_URL}`);
      expect(text).toContain(line);
      expect(text).toContain(CONSENT_FACTS.invitationRelay.note);
      expect(text).not.toContain(
        isConsole ? HOSTED_LINE : "whoever runs that registrar",
      );
    },
  );

  test.each([
    { profile: "console", isConsole: true },
    { profile: "hosted", isConsole: false },
  ])(
    "the $profile build names no registrar for a relay naming none",
    async ({ isConsole }) => {
      build.console = isConsole;
      const text = await producesText({
        channel: "webrtc",
        host: "peer.example.org",
        relay: { turn: [TURN_URL] },
      });
      expect(text).toContain(`TURN ${TURN_URL}`);
      expect(text).not.toContain("registrar");
    },
  );
});
