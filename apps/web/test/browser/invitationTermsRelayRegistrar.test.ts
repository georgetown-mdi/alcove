/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import {
  CONSENT_FACTS,
  decodeInvitation,
  generateSharedSecret,
} from "@alcove/core";

import {
  ACCEPTED_INVITATION_ALLOWED_RELAYS_SCOPE,
  KEPT_BY_ALLOWED_RELAYS,
  LEFT_OUT_BY_ALLOWED_RELAYS,
} from "@psi/transport/relayRestriction";
import { InvitationTerms } from "@components/InvitationTerms";

import { createAppMount } from "./renderApp";
import { readyDisclosures } from "./collapsePanels";

import type { ConnectionEndpoint, LinkageTerms } from "@alcove/core";

// The registrar an invitation's relay names, and the marks this browser's
// allowed relays put on its TURN urls, on the accept screen of each build. A
// console run is the CLI's and enrolls there before it connects; a browser run
// does not, so the hosted line only names it.

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
  `A run registers this exchange at ${REGISTRAR} before it connects ` +
  "only when your side sets up its own connection on this relay, and " +
  "whoever runs that registrar then learns this machine's network address.";
const HOSTED_LINE = `The invitation also names this relay's registrar: ${REGISTRAR}`;

const app = createAppMount();

afterEach(() => {
  app.unmount();
  build.console = false;
});

async function producesText(
  connectionEndpoint: ConnectionEndpoint,
  allowedRelays?: ReadonlyArray<string>,
): Promise<string> {
  app.render(
    createElement(InvitationTerms, {
      linkageTerms: terms,
      connectionEndpoint,
      allowedRelays,
    }),
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

async function decodedFromTypedRegistrar(
  registrar: string,
): Promise<ConnectionEndpoint> {
  const base64Url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      version: "1",
      linkageTerms: terms,
      sharedSecret: generateSharedSecret(),
      connectionEndpoint: {
        channel: "webrtc",
        host: "peer.example.org",
        relay: { turn: [TURN_URL], registrar },
      },
    }),
  );
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const { connectionEndpoint } = await decodeInvitation(
    base64Url(bytes) + base64Url(new Uint8Array(hash).slice(0, 4)),
  );
  if (connectionEndpoint === undefined) throw new Error("no endpoint decoded");
  return connectionEndpoint;
}

describe("InvitationTerms: the invitation's relays under the exchange's allowed relays", () => {
  const KEPT_URL = "turn:Partner.Example.net:3478?transport=udp";
  const LEFT_OUT_URL = "turns:other.example.net:443?transport=tcp";
  const relayEndpoint: ConnectionEndpoint = {
    channel: "webrtc",
    host: "peer.example.org",
    relay: { turn: [KEPT_URL, LEFT_OUT_URL] },
  };

  test("the hosted build marks each TURN url kept or left out, and says what the setting decides", async () => {
    const text = await producesText(relayEndpoint, ["partner.example.net"]);
    expect(text).toContain(`TURN ${KEPT_URL} (${KEPT_BY_ALLOWED_RELAYS})`);
    expect(text).toContain(
      `TURN ${LEFT_OUT_URL} (${LEFT_OUT_BY_ALLOWED_RELAYS})`,
    );
    expect(text).toContain(ACCEPTED_INVITATION_ALLOWED_RELAYS_SCOPE);
    expect(text).toContain(CONSENT_FACTS.invitationRelay.note);
  });

  test("the hosted build with the setting unset marks nothing and says nothing about the setting", async () => {
    const text = await producesText(relayEndpoint);
    expect(text).toContain(`TURN ${KEPT_URL}`);
    expect(text).toContain(CONSENT_FACTS.invitationRelay.note);
    expect(text).not.toMatch(/relay server page|leave out a TURN server/i);
    expect(text).not.toContain(KEPT_BY_ALLOWED_RELAYS);
    expect(text).not.toContain(LEFT_OUT_BY_ALLOWED_RELAYS);
    expect(text).not.toContain(ACCEPTED_INVITATION_ALLOWED_RELAYS_SCOPE);
  });

  test("the console build, whose run is the CLI's, marks nothing whatever the browser holds", async () => {
    build.console = true;
    const text = await producesText(relayEndpoint, ["partner.example.net"]);
    expect(text).toContain(`TURN ${KEPT_URL}`);
    expect(text).not.toContain(KEPT_BY_ALLOWED_RELAYS);
    expect(text).not.toContain(LEFT_OUT_BY_ALLOWED_RELAYS);
    expect(text).not.toContain(ACCEPTED_INVITATION_ALLOWED_RELAYS_SCOPE);
    expect(text).toContain(CONSENT_FACTS.invitationRelay.note);
  });
});

describe("InvitationTerms: a registrar written in a typed form", () => {
  test.each([
    { profile: "console", isConsole: true, line: CONSOLE_LINE },
    { profile: "hosted", isConsole: false, line: HOSTED_LINE },
  ])(
    "the $profile build names the decoded origin and not the typed form",
    async ({ isConsole, line }) => {
      build.console = isConsole;
      const text = await producesText(
        await decodedFromTypedRegistrar(
          "https://Default-Relay.Example.net:443/",
        ),
      );
      expect(text).toContain(line);
      expect(text).not.toContain("Default-Relay");
      expect(text).not.toContain(":443/");
    },
  );
});
