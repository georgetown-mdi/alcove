/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createElement } from "react";

// Load Mantine's stylesheet so the swept surfaces render with their real
// geometry and painted backgrounds, as themeContrastSweep.test.ts does.
import "@mantine/core/styles.css";

import { AcceptorScreen } from "@exchange/AcceptorScreen";
import { DirectExchangeScreen } from "@exchange/DirectExchangeScreen";
import { InviterScreen } from "@exchange/InviterScreen";
import { Lobby } from "@exchange/Lobby";
import { NotFound } from "@components/NotFound";
import { RecoveredExchangePanel } from "@exchange/RecoveredExchangePanel";
import { RelaySettingsScreen } from "@exchange/RelaySettingsScreen";
import { VerifyReceiptScreen } from "@exchange/VerifyReceiptScreen";

import { acceptToken, declaredRoutes } from "./routeStates";
import { createAppMount, flushPendingUpdates } from "./renderApp";
import { expectAaClean, mountAndSweep } from "./contrastSweep";

import type { RouteState } from "./routeStates";

// The contrast sweep (contrastSweep.ts) over the console profile's route
// states, in both schemes: the console's own cards render on the exchange
// screens in place of the hosted ones. The `/saved` routes redirect to `/` on
// the console, so they have no state here.

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

/** The console server's answers for a working directory holding one input
 * file and nothing else: no configuration, no connection, no exchange running.
 * Any other job route answers 404. */
function consoleJobAnswer(url: string): Response {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  if (url === "/api/jobs/inputs")
    return json({
      configured: true,
      files: [
        { name: "clients.csv", sizeBytes: 4096, modifiedAt: 1_700_000_000_000 },
      ],
    });
  if (
    url === "/api/jobs/sftp" ||
    url === "/api/jobs/rendezvous" ||
    url === "/api/jobs/webrtc"
  )
    return json({ configured: false });
  if (url === "/api/jobs/slot") return json({ occupied: false });
  if (url === "/api/jobs/config")
    return json({
      configured: true,
      present: false,
      carriedThrough: [],
      warnings: [],
    });
  if (url.startsWith("/api/jobs/mounts/"))
    return json({ configured: true, readable: true, entries: [] });
  return new Response(null, { status: 404 });
}

const CONSOLE_ROUTE_STATES: ReadonlyArray<RouteState> = [
  {
    route: "/",
    state: "no exchange running",
    heading: /./,
    node: () =>
      Promise.resolve(
        createElement(
          "div",
          null,
          createElement(RecoveredExchangePanel),
          createElement(Lobby),
        ),
      ),
  },
  {
    route: "/quick",
    state: "landing",
    heading: /./,
    node: () => Promise.resolve(createElement(Lobby)),
  },
  {
    route: "/exchange",
    state: "first step",
    heading: "Your file",
    node: () => Promise.resolve(createElement(InviterScreen)),
  },
  {
    route: "/accept",
    state: "terms review",
    heading: /County Health Department/,
    node: async () => {
      window.location.hash = await acceptToken();
      return createElement(AcceptorScreen);
    },
  },
  {
    route: "/accept",
    state: "an invitation that cannot be read",
    heading: "Accept an invitation",
    node: () => {
      window.location.hash = "not-an-invitation";
      return Promise.resolve(createElement(AcceptorScreen));
    },
  },
  {
    route: "/verify",
    state: "nothing loaded",
    heading: "Verify an exchange record",
    node: () => Promise.resolve(createElement(VerifyReceiptScreen)),
  },
  {
    route: "/direct",
    state: "landing",
    heading: /./,
    node: () => Promise.resolve(createElement(DirectExchangeScreen)),
  },
  {
    route: "/relay",
    state: "no relay set",
    heading: /./,
    node: () => Promise.resolve(createElement(RelaySettingsScreen)),
  },
  {
    route: "(not found)",
    state: "an address no route matches",
    heading: "Page not found",
    node: () => Promise.resolve(createElement(NotFound)),
  },
];

const app = createAppMount();

beforeEach(() => {
  const realFetch = window.fetch.bind(window);
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      return url.startsWith("/api/jobs")
        ? Promise.resolve(consoleJobAnswer(url))
        : realFetch(input, init);
    },
  );
});

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

  for (const state of CONSOLE_ROUTE_STATES)
    for (const scheme of ["light", "dark"] as const)
      test(`${state.route}: ${state.state} is AA-clean (${scheme})`, async () => {
        expectAaClean(await mountAndSweep(app, scheme, state), scheme, state);
      });
});
