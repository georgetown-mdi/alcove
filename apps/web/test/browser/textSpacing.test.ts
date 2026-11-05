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

import { WCAG_TEXT_SPACING_CSS, lostContent } from "./reflowChecks";
import { createAppMount, flushPendingUpdates } from "./renderApp";
import { ROUTE_STATES } from "./routeStates";

// Each route state under the text spacing WCAG 1.4.12 names, at the
// project's desktop viewport: no text is clipped and nothing leaves the page.

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
const spacing = document.createElement("style");

beforeAll(() => {
  spacing.textContent = WCAG_TEXT_SPACING_CSS;
  document.head.appendChild(spacing);
});

afterAll(() => {
  spacing.remove();
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

describe("text spacing (WCAG 1.4.12)", () => {
  test("the check reports text a fixed-height box clips", () => {
    const fixture = document.createElement("div");
    fixture.innerHTML = `<p style="height: 1em; overflow: hidden; width: 120px">Text spacing pushes these words past a fixed height</p>`;
    document.body.appendChild(fixture);
    try {
      expect(lostContent(fixture)).toEqual([
        expect.stringContaining("Text spacing pushes"),
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
