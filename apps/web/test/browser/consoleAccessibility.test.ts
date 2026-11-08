/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import "@mantine/core/styles.css";

import {
  CONSOLE_CARD_STATES,
  CONSOLE_ROUTE_STATES,
  stubConsoleJobApi,
} from "./consoleStates";
import { createAppMount, flushPendingUpdates } from "./renderApp";
import { declaredRoutes } from "./routeStates";
import { expectStepAccessible } from "./stepChecks";

// The checks the keyboard journeys run at each step (stepChecks.ts: the rule
// scan, axe, the control boundary sweep, and the layout checks under the WCAG
// text spacing and at 320 CSS pixels), over the console profile's route states
// and its cards' empty, error and running states (consoleStates.ts). The
// states only input reaches are checked by the console keyboard journeys.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@utils/clientConfig", async (importOriginal) =>
  (await import("../utils/clientConfigMock")).consoleClientConfigMock(
    importOriginal,
  ),
);

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

vi.mock("@psi/exchangeLifecycle", async (importOriginal) =>
  (await import("./moduleMocks")).exchangeLifecycleMock(importOriginal),
);

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  window.location.hash = "";
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("console accessibility (WCAG 2.1 AA)", () => {
  test("every declared route the console renders has a checked state", () => {
    const checked = new Set(CONSOLE_ROUTE_STATES.map(({ route }) => route));
    expect(
      declaredRoutes().filter(
        (route) => !route.startsWith("/saved") && !checked.has(route),
      ),
    ).toEqual([]);
  });

  for (const state of [...CONSOLE_ROUTE_STATES, ...CONSOLE_CARD_STATES])
    test(`${state.route}: ${state.state}`, async () => {
      stubConsoleJobApi(state.jobApi);
      app.render(await state.node());
      await expect
        .element(page.getByRole("heading", { level: 1, name: state.heading }))
        .toBeInTheDocument();
      if (state.settled !== undefined)
        await expect
          .element(page.getByText(state.settled).first())
          .toBeInTheDocument();
      await flushPendingUpdates();
      await expectStepAccessible(app.container);
    });
});
