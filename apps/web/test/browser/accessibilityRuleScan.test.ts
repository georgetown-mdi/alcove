/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import "@mantine/core/styles.css";

import { clearManagedExchanges } from "@psi/managed/managedExchangeStore";

import { ROUTE_STATES, declaredRoutes } from "./routeStates";
import { createAppMount, flushPendingUpdates } from "./renderApp";
import {
  expectNoAccessibilityViolations,
  scanAccessibility,
} from "./accessibilityRules";

// The rule scan (accessibilityRules.ts) over every route the app declares, at the
// state the route lands in, plus the error states a route can land in instead
// (routeStates.ts). Result states, and the error states a run reaches, are
// scanned at the end of the keyboard-only journeys, which are what reach them.

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

describe("accessibility rule scan", () => {
  test("every declared route has a scanned state", () => {
    const declared = declaredRoutes();
    expect(declared).toContain("/accept");
    const scanned = new Set(ROUTE_STATES.map(({ route }) => route));
    expect(declared.filter((route) => !scanned.has(route))).toEqual([]);
  });

  test("the scan reports each rule it holds", () => {
    const fixture = document.createElement("div");
    fixture.innerHTML = `
      <h2>No page heading above this one</h2>
      <h4>Two levels below</h4>
      <p id="twice">one</p><p id="twice">two</p>
      <input type="text" aria-describedby="nowhere">
      <button></button>
      <a href="/x"><button>Inside a link</button></a>
      <span tabindex="2">Reordered</span>
      <div aria-hidden="true"><button>Hidden</button></div>
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="4" height="4">
      <ul><div>Not an item</div></ul>`;
    document.body.appendChild(fixture);
    try {
      const rules = new Set(
        scanAccessibility(fixture, { page: true }).map(({ rule }) => rule),
      );
      expect([...rules].sort()).toEqual(
        [
          "broken-reference",
          "control-name",
          "duplicate-id",
          "heading-skip",
          "hidden-focusable",
          "image-name",
          "list-children",
          "nested-interactive",
          "page-h1",
          "positive-tabindex",
        ].sort(),
      );
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
      expectNoAccessibilityViolations(app.container, { page: true });
    });
});
