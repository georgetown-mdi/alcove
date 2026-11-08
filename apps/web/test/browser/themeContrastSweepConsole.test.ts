/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

// Load Mantine's stylesheet so the swept surfaces render with their real
// geometry and painted backgrounds, as themeContrastSweep.test.ts does.
import "@mantine/core/styles.css";

import {
  CONSOLE_CARD_STATES,
  CONSOLE_ROUTE_STATES,
  stubConsoleJobApi,
} from "./consoleStates";
import { createAppMount, flushPendingUpdates } from "./renderApp";
import { expectAaClean, mountAndSweep } from "./contrastSweep";
import { declaredRoutes } from "./routeStates";

// The contrast sweep (contrastSweep.ts) over the console profile's route
// states and its cards' empty, error and running states (consoleStates.ts), in
// both schemes: the console's own cards render on the exchange screens in
// place of the hosted ones.

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

describe("console route contrast sweep (WCAG 2.1 AA)", () => {
  test("every declared route the console renders has a swept state", () => {
    const swept = new Set(CONSOLE_ROUTE_STATES.map(({ route }) => route));
    expect(
      declaredRoutes().filter(
        (route) => !route.startsWith("/saved") && !swept.has(route),
      ),
    ).toEqual([]);
  });

  for (const state of [...CONSOLE_ROUTE_STATES, ...CONSOLE_CARD_STATES])
    for (const scheme of ["light", "dark"] as const)
      test(`${state.route}: ${state.state} is AA-clean (${scheme})`, async () => {
        stubConsoleJobApi(state.jobApi);
        expectAaClean(await mountAndSweep(app, scheme, state), scheme, state);
      });
});
