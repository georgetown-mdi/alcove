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

import { createAppMount } from "./renderApp";

import type { ExchangeRelayCheckSubject } from "@psi/transport/exchangeRelayCheck";

// The web check of an exchange's relays in real Chromium: against the
// browser project's loopback WebSocket relay, and a TURN url that never
// resolves. No TURN relay runs here, so a TURN relay that carries the message
// or refuses the credential is not driven in a real browser.

const relayAddress = inject("websocketRelay");

/** A TLS relay under a reserved name that never resolves (RFC 6761). */
const UNREACHABLE_TURN_URL = "turns:relay.invalid:443";

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
    const lines = await runExchangeRelayCheck(ownWebSocketRelay(secret), {
      boundMs: 10_000,
    });
    expect(lines).toEqual([
      { relay: "websocket", url: relayAddress.url, result: { kind: "works" } },
    ]);
  });

  test("is refused as not enrolled where the relay holds no key", async (ctx) => {
    if (relayAddress === undefined)
      return ctx.skip("no WebSocket relay was provided");
    const lines = await runExchangeRelayCheck(
      ownWebSocketRelay(generateSharedSecret()),
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
    const lines = await runExchangeRelayCheck(ownWebSocketRelay(secret), {
      boundMs: 10_000,
    });
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
    const lines = await runExchangeRelayCheck(subject, { boundMs: 10_000 });
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
});
