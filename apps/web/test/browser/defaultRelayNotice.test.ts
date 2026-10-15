/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  DEFAULT_RELAY_NOTICE_LEAD,
  DefaultRelayNotice,
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
