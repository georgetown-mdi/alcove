/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Load Mantine's stylesheet so the swept surfaces render with their real
// geometry and painted backgrounds (the .page ground, the input fills), not the
// unstyled DOM a contrast walk cannot resolve a background from.
import "@mantine/core/styles.css";

import { clearManagedExchanges } from "@psi/managed/managedExchangeStore";

import { ROUTE_STATES, declaredRoutes } from "./routeStates";
import { createAppMount, flushPendingUpdates } from "./renderApp";
import { expectAaClean, mountAndSweep } from "./contrastSweep";

// The contrast sweep (contrastSweep.ts) over every route the app declares on the
// hosted profile, at each state routeStates.ts lands it in, rendered through
// renderApp (the app's real MantineProvider + resolver config) in BOTH
// forceColorScheme: "light" and "dark", so a surface AA-clean in one scheme but
// not the other is still caught. The console profile's states are swept by
// themeContrastSweepConsole.test.ts.

// The lobby's action cards and the "recurring" links are Links; the stubbed
// plain anchors let those surfaces mount without the router.
vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

// The rendezvous dial and listen run only inside a run lifecycle these initial
// mounts never start.
vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// Stub the run lifecycle so nothing dials; no run is launched from an initial
// mount, but the stub keeps the import inert either way.
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

describe("primary-route contrast sweep (WCAG 2.1 AA)", () => {
  test("every declared route has a swept state", () => {
    const swept = new Set(ROUTE_STATES.map(({ route }) => route));
    expect(declaredRoutes().filter((route) => !swept.has(route))).toEqual([]);
  });

  for (const state of ROUTE_STATES)
    for (const scheme of ["light", "dark"] as const)
      test(`${state.route}: ${state.state} is AA-clean (${scheme})`, async () => {
        expectAaClean(await mountAndSweep(app, scheme, state), scheme, state);
      });
});
