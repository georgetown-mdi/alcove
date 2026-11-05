/// <reference types="@vitest/browser-playwright/context" />

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { page } from "vitest/browser";

import "@mantine/core/styles.css";

import { clearManagedExchanges } from "@psi/managed/managedExchangeStore";

import { createAppMount, flushPendingUpdates } from "./renderApp";
import { ROUTE_STATES } from "./routeStates";
import { lostContent } from "./reflowChecks";

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

vi.mock("@psi/exchangeLifecycle", async (importOriginal) =>
  (await import("./moduleMocks")).exchangeLifecycleMock(importOriginal),
);

const app = createAppMount();

beforeAll(async () => {
  await page.viewport(320, 256);
});

afterAll(async () => {
  await page.viewport(1280, 800);
});

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  window.location.hash = "";
  window.localStorage.clear();
  await clearManagedExchanges();
});

describe("reflow at 320 CSS pixels (WCAG 1.4.10)", () => {
  test("the check reports content past the viewport's edge", () => {
    const fixture = document.createElement("div");
    fixture.innerHTML = `<p style="width: 400px">Wider than the viewport</p>`;
    document.body.appendChild(fixture);
    try {
      expect(lostContent(fixture)).toEqual([
        "the page scrolls sideways: 400 px of content in 320 px",
        expect.stringContaining("Wider than the viewport"),
      ]);
    } finally {
      fixture.remove();
    }
  });

  for (const { route, state, heading, node } of ROUTE_STATES)
    test(`${route}: ${state}`, async () => {
      app.render(await node());
      await expect
        .element(page.getByRole("heading", { level: 1, name: heading }))
        .toBeInTheDocument();
      await flushPendingUpdates();
      expect(lostContent(app.container)).toEqual([]);
    });
});
