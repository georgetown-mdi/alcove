/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  RELAY_CHECK_AGAIN_LABEL,
  RELAY_CHECK_OPEN_LABEL,
  RELAY_CHECK_START_LABEL,
  relayCheckUnavailableText,
  relayCheckVerdictSummary,
} from "@console/relayCheckModel";
import { RelayCheckPanel } from "@console/RelayCheckPanel";

import { createAppMount } from "./renderApp";

const DIGEST = "a".repeat(64);
const RELAY_HOST = "turn:relay.example.org:3478";

const AVAILABLE = {
  status: "available",
  configurationDigest: DIGEST,
  statement: {
    contactedHeading: "The check contacts:",
    contacted: [{ host: RELAY_HOST, explanation: [] }],
    closing: "Nothing else is contacted.",
  },
};

const VERDICT = {
  status: "verdict",
  overall: "ok",
  checks: [{ id: "turn_1", status: "ok", headline: "The relay answered." }],
};

const app = createAppMount();

afterEach(() => {
  app.unmount();
  vi.unstubAllGlobals();
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The console's relay-check endpoint, answering each `GET` with the next
 * offer `offers` holds (the last repeated) and each `POST` with `started`.
 */
function stubRelayCheck(
  offers: Array<Record<string, unknown>>,
  started: Record<string, unknown>,
): void {
  const pending = [...offers];
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input) !== "/api/jobs/relay-check")
        return Promise.reject(new Error(`unexpected request ${String(input)}`));
      if (init?.method === "POST") return Promise.resolve(json(started));
      const offer = pending.length > 1 ? pending.shift() : pending[0];
      return Promise.resolve(json(offer));
    },
  );
}

describe("RelayCheckPanel: a configuration that could not be read", () => {
  test("checks again once the file is fixed, and the check then runs", async () => {
    stubRelayCheck(
      [{ status: "unavailable", reason: "configuration-refused" }, AVAILABLE],
      VERDICT,
    );
    app.render(createElement(RelayCheckPanel));

    await expect
      .element(
        page.getByText(relayCheckUnavailableText("configuration-refused")),
      )
      .toBeInTheDocument();

    await page.getByRole("button", { name: RELAY_CHECK_AGAIN_LABEL }).click();
    await expect.element(page.getByText(RELAY_HOST)).toBeInTheDocument();

    await page.getByRole("button", { name: RELAY_CHECK_START_LABEL }).click();
    await expect
      .element(page.getByText(relayCheckVerdictSummary("ok")))
      .toBeInTheDocument();
  });
});

describe("RelayCheckPanel: a start answered unavailable", () => {
  test("states the reason alone", async () => {
    stubRelayCheck([AVAILABLE], { status: "unavailable", reason: "key-file" });
    app.render(createElement(RelayCheckPanel));

    await page.getByRole("button", { name: RELAY_CHECK_OPEN_LABEL }).click();
    await page.getByRole("button", { name: RELAY_CHECK_START_LABEL }).click();

    await expect
      .element(page.getByText(relayCheckUnavailableText("key-file")))
      .toBeInTheDocument();
  });
});

describe("RelayCheckPanel: a verdict over a WebSocket relay", () => {
  const WEBSOCKET_HOST = "wss://relay.example.org/relay";
  const offer = {
    ...AVAILABLE,
    statement: {
      ...AVAILABLE.statement,
      contacted: [{ host: WEBSOCKET_HOST, explanation: [] }],
    },
  };

  test.each([
    [
      "admitted",
      "ok",
      {
        id: "websocket_1",
        status: "ok",
        headline: `${WEBSOCKET_HOST}, a WebSocket relay a run dials: admitted.`,
      },
    ],
    [
      "not admitted",
      "fix_and_retry",
      {
        id: "websocket_1",
        status: "fail",
        headline: `${WEBSOCKET_HOST}: not admitted (close code 4003).`,
        meaning: "The relay holds no key for this exchange.",
        action: "Run the check again once your partner has enrolled.",
      },
    ],
    [
      "not reached",
      "fix_and_retry",
      {
        id: "websocket_1",
        status: "fail",
        headline: `${WEBSOCKET_HOST}: not reached within 30 s.`,
        meaning: "A run on this computer cannot open a connection to it.",
        action: "Check that this computer can reach the relay.",
      },
    ],
    [
      "a certificate that did not verify",
      "fix_and_retry",
      {
        id: "websocket_1",
        status: "fail",
        headline: `${WEBSOCKET_HOST}: its TLS certificate did not verify.`,
        meaning: "This computer does not trust the relay's certificate.",
        action: "Name your network's certificate in NODE_EXTRA_CA_CERTS.",
      },
    ],
  ] as const)(
    "%s shows its headline, meaning and action",
    async (_name, overall, check) => {
      stubRelayCheck([offer], { status: "verdict", overall, checks: [check] });
      app.render(createElement(RelayCheckPanel));

      await page.getByRole("button", { name: RELAY_CHECK_OPEN_LABEL }).click();
      await expect.element(page.getByText(WEBSOCKET_HOST)).toBeInTheDocument();
      await page.getByRole("button", { name: RELAY_CHECK_START_LABEL }).click();

      await expect
        .element(page.getByText(relayCheckVerdictSummary(overall)))
        .toBeInTheDocument();
      await expect.element(page.getByText(check.headline)).toBeInTheDocument();
      if ("meaning" in check) {
        await expect
          .element(page.getByText(`What this means: ${check.meaning}`))
          .toBeInTheDocument();
        await expect
          .element(page.getByText(`What to do: ${check.action}`))
          .toBeInTheDocument();
      }
    },
  );
});
