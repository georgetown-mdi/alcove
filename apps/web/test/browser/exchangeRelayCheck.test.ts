/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, inject, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  deriveRelayExchangeId,
  deriveRelayKey,
  generateSharedSecret,
} from "@alcove/core";

import {
  EXCHANGE_RELAY_CHECK_OPEN_LABEL,
  ExchangeRelayCheck,
} from "@exchange/ExchangeRelayCheck";
import {
  exchangeRelayCheckSubject,
  runExchangeRelayCheck,
} from "@psi/transport/exchangeRelayCheck";
import { RELAY_CHECK_START_LABEL } from "@console/relayCheckModel";
import { exchangeRelayCheckVerdict } from "@exchange/exchangeRelayCheckModel";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type {
  ExchangeRelayCheckSubject,
  WebSocketRelayParking,
} from "@psi/transport/exchangeRelayCheck";
import type { MessageConnection } from "@alcove/core";

// The web check of an exchange's relays in real Chromium: against the
// browser project's loopback WebSocket relay, and a TURN url that never
// resolves. No TURN relay runs here, so a TURN relay that carries the message
// or refuses the credential is not driven in a real browser.

const relayAddress = inject("websocketRelay");

/** A TLS relay under a reserved name that never resolves (RFC 6761). */
const UNREACHABLE_TURN_URL = "turns:relay.invalid:443";

const NOT_ABORTED = new AbortController().signal;

const app = createAppMount();

afterEach(() => {
  app.unmount();
});

async function enrollAtTestRelay(exchangeId: string, relayKey: string) {
  const response = await fetch(
    `${relayAddress?.testOrigin}/enroll?exchange_id=${exchangeId}&key=${relayKey}`,
  );
  expect(response.status).toBe(204);
}

function ownWebSocketRelay(secret: string): ExchangeRelayCheckSubject {
  return exchangeRelayCheckSubject(secret, undefined, undefined, {
    readOwn: () => ({
      kind: "set",
      relay: { turn: [], stun: [], websocket: relayAddress?.url ?? "" },
    }),
    build: () => ({ kind: "none" }),
  });
}

describe("the check against a real WebSocket relay", () => {
  test("works where the relay holds the exchange's key", async (ctx) => {
    if (relayAddress === undefined)
      return ctx.skip("no WebSocket relay was provided");
    const secret = generateSharedSecret();
    await enrollAtTestRelay(
      await deriveRelayExchangeId(secret),
      await deriveRelayKey(secret),
    );
    const lines = await runExchangeRelayCheck(
      ownWebSocketRelay(secret),
      NOT_ABORTED,
      {
        boundMs: 10_000,
      },
    );
    expect(lines).toEqual([
      { relay: "websocket", url: relayAddress.url, result: { kind: "works" } },
    ]);
  });

  test("is refused as not enrolled where the relay holds no key", async (ctx) => {
    if (relayAddress === undefined)
      return ctx.skip("no WebSocket relay was provided");
    const lines = await runExchangeRelayCheck(
      ownWebSocketRelay(generateSharedSecret()),
      NOT_ABORTED,
      { boundMs: 10_000 },
    );
    expect(lines).toEqual([
      {
        relay: "websocket",
        url: relayAddress.url,
        result: {
          kind: "refused",
          closeCode: 4003,
          proofRemadeOnRelayClock: false,
        },
      },
    ]);
  });

  test("is refused where the relay holds another key for the exchange", async (ctx) => {
    if (relayAddress === undefined)
      return ctx.skip("no WebSocket relay was provided");
    const secret = generateSharedSecret();
    await enrollAtTestRelay(
      await deriveRelayExchangeId(secret),
      await deriveRelayKey(generateSharedSecret()),
    );
    const lines = await runExchangeRelayCheck(
      ownWebSocketRelay(secret),
      NOT_ABORTED,
      {
        boundMs: 10_000,
      },
    );
    expect(lines).toEqual([
      {
        relay: "websocket",
        url: relayAddress.url,
        result: {
          kind: "refused",
          closeCode: 4004,
          proofRemadeOnRelayClock: false,
        },
      },
    ]);
  });
});

describe("the check against a TURN url that never resolves", () => {
  test("is not reached", async () => {
    const subject = exchangeRelayCheckSubject(
      generateSharedSecret(),
      undefined,
      undefined,
      {
        readOwn: () => ({
          kind: "set",
          relay: { turn: [UNREACHABLE_TURN_URL], stun: [] },
        }),
        build: () => ({ kind: "none" }),
      },
    );
    const lines = await runExchangeRelayCheck(subject, NOT_ABORTED, {
      boundMs: 10_000,
    });
    expect(lines).toEqual([
      { relay: "turn", url: UNREACHABLE_TURN_URL, result: "not_reached" },
    ]);
  }, 20_000);
});

describe("ExchangeRelayCheck", () => {
  test("contacts nothing until the user starts it, after naming the hosts", async () => {
    const plan = vi.fn<ExchangeRelayCheckSubject["plan"]>(() =>
      Promise.resolve({ relaysLeftOut: [], websocketRelays: [] }),
    );
    const subject: ExchangeRelayCheckSubject = {
      sharedSecret: generateSharedSecret(),
      hosts: {
        turn: [UNREACHABLE_TURN_URL],
        websocket: [],
        listedOnceEnrolled: [],
        leftOut: [],
      },
      plan,
    };
    app.render(createElement(ExchangeRelayCheck, { subject }));

    await page
      .getByRole("button", { name: EXCHANGE_RELAY_CHECK_OPEN_LABEL })
      .click();
    await expect
      .element(page.getByText(UNREACHABLE_TURN_URL))
      .toBeInTheDocument();
    expect(plan).not.toHaveBeenCalled();

    await page.getByRole("button", { name: RELAY_CHECK_START_LABEL }).click();
    await expect
      .element(page.getByText(exchangeRelayCheckVerdict([])))
      .toBeInTheDocument();
    expect(plan).toHaveBeenCalledOnce();
  });

  const RELAY_A = "wss://relay-a.example.org/relay";
  const RELAY_B = "wss://relay-b.example.org/relay";

  /** A relay client whose sockets never answer, each park and close recorded. */
  function silentRelay() {
    const parked: Array<string> = [];
    const closed: Array<string> = [];
    const park: WebSocketRelayParking = (options) => {
      parked.push(options.url);
      return {
        url: options.url,
        paired: false,
        partnerStarted: false,
        failure: undefined,
        onChange: () => () => undefined,
        start: () => new Promise<MessageConnection>(() => undefined),
        close: () => {
          closed.push(options.url);
        },
      };
    };
    return {
      parked,
      closed,
      dependencies: { parkWebSocketRelay: park, boundMs: 60_000 },
    };
  }

  function webSocketRelaySubject(url: string): ExchangeRelayCheckSubject {
    return {
      sharedSecret: generateSharedSecret(),
      hosts: {
        turn: [],
        websocket: [url],
        listedOnceEnrolled: [],
        leftOut: [],
      },
      plan: () =>
        Promise.resolve({
          relaysLeftOut: [],
          websocketRelays: [{ url, exchangeId: "a".repeat(32) }],
        }),
    };
  }

  async function startCheck(): Promise<void> {
    await page
      .getByRole("button", { name: EXCHANGE_RELAY_CHECK_OPEN_LABEL })
      .click();
    await page.getByRole("button", { name: RELAY_CHECK_START_LABEL }).click();
  }

  test("a change of the hosts while a check runs aborts its requests and shows no line for the old hosts", async () => {
    const relay = silentRelay();
    app.render(
      createElement(ExchangeRelayCheck, {
        subject: webSocketRelaySubject(RELAY_A),
        dependencies: relay.dependencies,
      }),
    );
    await startCheck();
    await vi.waitFor(() => expect(relay.parked).toEqual([RELAY_A, RELAY_A]));

    app.render(
      createElement(ExchangeRelayCheck, {
        subject: webSocketRelaySubject(RELAY_B),
        dependencies: relay.dependencies,
      }),
    );
    await vi.waitFor(() => expect(relay.closed).toEqual([RELAY_A, RELAY_A]));
    await flushPendingUpdates();
    await expect
      .element(
        page.getByRole("button", { name: EXCHANGE_RELAY_CHECK_OPEN_LABEL }),
      )
      .toBeInTheDocument();
    await expect.element(page.getByText(RELAY_A)).not.toBeInTheDocument();
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  });

  test("unmounting while a check runs aborts its requests", async () => {
    const relay = silentRelay();
    app.render(
      createElement(ExchangeRelayCheck, {
        subject: webSocketRelaySubject(RELAY_A),
        dependencies: relay.dependencies,
      }),
    );
    await startCheck();
    await vi.waitFor(() => expect(relay.parked).toEqual([RELAY_A, RELAY_A]));

    await flushPendingUpdates();
    app.unmount();
    await vi.waitFor(() => expect(relay.closed).toEqual([RELAY_A, RELAY_A]));
  });
});
