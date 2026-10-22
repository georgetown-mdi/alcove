/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  DEFAULT_RELAY_NOTICE_LEAD,
  DefaultRelayNotice,
  INVITED_DEFAULT_RELAY_NOTICE_LEAD,
} from "@exchange/DefaultRelayNotice";
import { RELAY_OPERATOR_DISCLOSURE } from "@exchange/RelaySettingsScreen";

import { createAppMount, flushPendingUpdates } from "./renderApp";

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
});

describe("the default relay notice", () => {
  test("with a default relay states what the relay's operator learns, naming no operator", async () => {
    app.render(
      createElement(DefaultRelayNotice, {
        setting: () => ({
          turnUrl: "turns:turn.example.org:443?transport=tcp",
          registrarUrl: "https://registrar.example.org",
        }),
      }),
    );
    await expect.element(page.getByRole("note")).toBeInTheDocument();
    const text = page.getByRole("note").element().textContent;
    expect(text).toBe(
      `${DEFAULT_RELAY_NOTICE_LEAD} ${RELAY_OPERATOR_DISCLOSURE}`,
    );
    expect(text).not.toMatch(/Alcove project/i);
    expect(page.getByRole("note").getByRole("link").elements()).toHaveLength(0);
  });

  test("switched off, on the review of an invitation naming it, says the exchange may connect through it", async () => {
    const relay = {
      turnUrl: "turns:turn.example.org:443?transport=tcp",
      registrarUrl: "https://registrar.example.org",
    };
    app.render(
      createElement(DefaultRelayNotice, {
        build: () => ({ kind: "opt-in" as const, relay }),
        setting: () => undefined,
        invitationRelay: { turn: [relay.turnUrl] },
      }),
    );
    await expect
      .element(page.getByRole("note"))
      .toHaveTextContent(
        `${INVITED_DEFAULT_RELAY_NOTICE_LEAD} ${RELAY_OPERATOR_DISCLOSURE}`,
      );
    expect(INVITED_DEFAULT_RELAY_NOTICE_LEAD).toBe(
      "This invitation names the site's relay server, so this exchange may " +
        "connect through it, unless its allowed relays leave it out.",
    );
  });

  test("switched off, with an invitation naming another relay, renders nothing", async () => {
    app.render(
      createElement(
        "div",
        { "data-testid": "host" },
        createElement(DefaultRelayNotice, {
          build: () => ({
            kind: "opt-in" as const,
            relay: {
              turnUrl: "turns:turn.example.org:443?transport=tcp",
              registrarUrl: "https://registrar.example.org",
            },
          }),
          setting: () => undefined,
          invitationRelay: { turn: ["turn:partner.example.net:3478"] },
        }),
      ),
    );
    await expect.element(page.getByTestId("host")).toBeEmptyDOMElement();
  });

  test("without a default relay renders nothing", async () => {
    app.render(
      createElement(
        "div",
        { "data-testid": "host" },
        createElement(DefaultRelayNotice, { setting: () => undefined }),
      ),
    );
    await expect.element(page.getByTestId("host")).toBeEmptyDOMElement();
  });
});
