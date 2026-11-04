/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  DEFAULT_RELAY_NOTICE_LEAD,
  DefaultRelayNotice,
  INVITED_DEFAULT_RELAY_NOTICE_LEAD,
  OWN_DEFAULT_RELAY_NOTICE_LEAD,
} from "@exchange/DefaultRelayNotice";
import { RELAY_OPERATOR_DISCLOSURE } from "@exchange/ExchangeConnectionSettings";

import { createAppMount, flushPendingUpdates } from "./renderApp";

const app = createAppMount();

const SITE_RELAY = {
  turnUrl: "turns:turn.example.org:443?transport=tcp",
  registrarUrl: "https://registrar.example.org",
};

const OPT_IN = () => ({ kind: "opt-in" as const, relay: SITE_RELAY });

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
});

/** Render `props` inside a host element, to check it renders nothing. */
function renderHosted(props: Parameters<typeof DefaultRelayNotice>[0]) {
  app.render(
    createElement(
      "div",
      { "data-testid": "host" },
      createElement(DefaultRelayNotice, props),
    ),
  );
}

describe("the default relay notice", () => {
  test("with a default relay states what the relay's operator learns, naming no operator", async () => {
    app.render(
      createElement(DefaultRelayNotice, {
        build: () => ({ kind: "on" as const, relay: SITE_RELAY }),
        switchedOn: false,
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
    app.render(
      createElement(DefaultRelayNotice, {
        build: OPT_IN,
        switchedOn: false,
        invitationRelay: { turn: [SITE_RELAY.turnUrl] },
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
    renderHosted({
      build: OPT_IN,
      switchedOn: false,
      invitationRelay: { turn: ["turn:partner.example.net:3478"] },
    });
    await expect.element(page.getByTestId("host")).toBeEmptyDOMElement();
  });

  test("switched off, with the exchange's own relay naming it, says the exchange may connect through it", async () => {
    app.render(
      createElement(DefaultRelayNotice, {
        build: OPT_IN,
        switchedOn: false,
        ownRelay: { turn: [SITE_RELAY.turnUrl], stun: [] },
      }),
    );
    await expect
      .element(page.getByRole("note"))
      .toHaveTextContent(
        `${OWN_DEFAULT_RELAY_NOTICE_LEAD} ${RELAY_OPERATOR_DISCLOSURE}`,
      );
    expect(OWN_DEFAULT_RELAY_NOTICE_LEAD).toBe(
      "Your Connection settings name the site's relay server, so this " +
        "exchange may connect through it, unless its allowed relays leave " +
        "it out.",
    );
  });

  test("switched off, with an invitation naming another relay and the exchange's own relay naming it, says the exchange may connect through it", async () => {
    app.render(
      createElement(DefaultRelayNotice, {
        build: OPT_IN,
        switchedOn: false,
        ownRelay: { turn: [SITE_RELAY.turnUrl], stun: [] },
        invitationRelay: { turn: ["turn:partner.example.net:3478"] },
      }),
    );
    await expect
      .element(page.getByRole("note"))
      .toHaveTextContent(
        `${OWN_DEFAULT_RELAY_NOTICE_LEAD} ${RELAY_OPERATOR_DISCLOSURE}`,
      );
  });

  test("switched off, where both the invitation and the exchange's own relay name it, gives the invitation as the reason", async () => {
    app.render(
      createElement(DefaultRelayNotice, {
        build: OPT_IN,
        switchedOn: false,
        ownRelay: { turn: [SITE_RELAY.turnUrl], stun: [] },
        invitationRelay: { turn: [SITE_RELAY.turnUrl] },
      }),
    );
    await expect
      .element(page.getByRole("note"))
      .toHaveTextContent(
        `${INVITED_DEFAULT_RELAY_NOTICE_LEAD} ${RELAY_OPERATOR_DISCLOSURE}`,
      );
  });

  test("switched off, with the exchange's own relay naming another relay, renders nothing", async () => {
    renderHosted({
      build: OPT_IN,
      switchedOn: false,
      ownRelay: { turn: ["turn:own.example.net:3478"], stun: [] },
    });
    await expect.element(page.getByTestId("host")).toBeEmptyDOMElement();
  });

  test("switched on renders nothing, since the switch states it", async () => {
    renderHosted({
      build: OPT_IN,
      switchedOn: true,
      invitationRelay: { turn: [SITE_RELAY.turnUrl] },
    });
    await expect.element(page.getByTestId("host")).toBeEmptyDOMElement();
  });

  test("without a default relay renders nothing", async () => {
    renderHosted({
      build: () => ({ kind: "none" as const }),
      switchedOn: false,
    });
    await expect.element(page.getByTestId("host")).toBeEmptyDOMElement();
  });
});
