/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  encodeInvitation,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@alcove/core";

import { SavedExchanges, SavedExchangesHome } from "@recurring/SavedExchanges";
import {
  clearManagedExchanges,
  createManagedExchange,
  recordManagedExchangeLastRun,
} from "@psi/managed/managedExchangeStore";
import { AcceptorScreen } from "@exchange/AcceptorScreen";
import { DirectExchangeScreen } from "@exchange/DirectExchangeScreen";
import { InviterScreen } from "@exchange/InviterScreen";
import { Lobby } from "@exchange/Lobby";
import { ManagedRunSurface } from "@recurring/ManagedRunSurface";
import { NotFound } from "@components/NotFound";
import { RelaySettingsScreen } from "@exchange/RelaySettingsScreen";
import { VerifyReceiptScreen } from "@exchange/VerifyReceiptScreen";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";
import { writeOwnRelaySetting } from "@psi/transport/ownRelaySetting";

import { createAppMount, flushPendingUpdates } from "./renderApp";
import {
  expectNoAccessibilityViolations,
  scanAccessibility,
} from "./accessibilityRules";

import type { InvitationToken } from "@alcove/core";
import type { ReactNode } from "react";

// The rule scan (accessibilityRules.ts) over every route the app declares, at the
// state the route lands in, plus the error states a route can land in instead.
// Result states, and the error states a run reaches, are scanned at the end of
// the keyboard-only journeys, which are what reach them.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

vi.mock("@psi/exchangeLifecycle", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runExchangeLifecycle: () => Promise.resolve(),
}));

async function acceptToken(): Promise<string> {
  const token: InvitationToken = {
    version: "1",
    linkageTerms: {
      ...getDefaultLinkageTerms("County Health Department"),
      linkageFields: [{ name: "firstName", type: "first_name" }],
      linkageKeys: [{ name: "first", elements: [{ field: "firstName" }] }],
    },
    sharedSecret: generateSharedSecret(),
    expires: new Date(Date.now() + 3600 * 1000).toISOString(),
    connectionEndpoint: {
      channel: "webrtc",
      host: "127.0.0.1",
      port: 3000,
      path: "/api/",
    },
  };
  return encodeInvitation(token);
}

async function savedExchangeId(): Promise<string> {
  const created = await createManagedExchange({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
  });
  return created.id;
}

/** A saved exchange with three recorded runs, opened in a browser whose own
 * relay names a TURN url: the state that shows the run history list and the
 * relay registration section. */
async function exchangeWithRunsId(): Promise<string> {
  writeOwnRelaySetting({
    turn: ["turns:relay.example.org:443?transport=tcp"],
    stun: [],
  });
  const created = await createManagedExchange({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
  });
  for (const [at, failureKind] of [
    ["2026-07-01T10:00:00.000Z", "input"],
    ["2026-07-08T10:00:00.000Z", "transport"],
  ] as const)
    await recordManagedExchangeLastRun(
      created.id,
      { at, outcome: "failed", failureKind },
      Date.parse(at),
    );
  await recordManagedExchangeLastRun(
    created.id,
    { at: "2026-07-15T10:00:00.000Z", outcome: "missed" },
    Date.parse("2026-07-15T10:00:00.000Z"),
  );
  return created.id;
}

interface ScannedState {
  /** The route path as the route file declares it. */
  route: string;
  /** What the state is, for the test name. */
  state: string;
  /** The heading the state shows once it has settled. */
  heading: string | RegExp;
  node: () => Promise<ReactNode>;
}

const SCANNED_STATES: Array<ScannedState> = [
  {
    route: "/",
    state: "no saved exchanges",
    heading: /Alcove|encrypted/i,
    node: () => Promise.resolve(createElement(SavedExchangesHome)),
  },
  {
    route: "/",
    state: "a saved exchange",
    heading: "Recurring exchanges",
    node: async () => {
      await savedExchangeId();
      return createElement(SavedExchangesHome);
    },
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
    state: "not offered by this deployment",
    heading: "Direct exchange",
    node: () => Promise.resolve(createElement(DirectExchangeScreen)),
  },
  {
    route: "/relay",
    state: "no relay set",
    heading: /./,
    node: () => Promise.resolve(createElement(RelaySettingsScreen)),
  },
  {
    route: "/saved/",
    state: "a saved exchange",
    heading: "Recurring exchanges",
    node: async () => {
      await savedExchangeId();
      return createElement(SavedExchanges);
    },
  },
  {
    route: "/saved/$id",
    state: "ready to run",
    heading: "Riverbend quarterly",
    node: async () =>
      createElement(ManagedRunSurface, { id: await savedExchangeId() }),
  },
  {
    route: "/saved/$id",
    state: "an exchange with recorded runs and a relay set",
    heading: "Riverbend quarterly",
    node: async () =>
      createElement(ManagedRunSurface, { id: await exchangeWithRunsId() }),
  },
  {
    route: "/saved/$id",
    state: "an exchange that is not stored",
    heading: "Exchange not found",
    node: () =>
      Promise.resolve(createElement(ManagedRunSurface, { id: "no-such-id" })),
  },
  {
    route: "(not found)",
    state: "an address no route matches",
    heading: "Page not found",
    node: () => Promise.resolve(createElement(NotFound)),
  },
];

/** The route paths the route files declare, read from their own
 * `createFileRoute` argument; the `/bench` routes are redirects to the primary
 * routes and render nothing of their own. */
function declaredRoutes(): Array<string> {
  const sources = import.meta.glob<string>("../../src/routes/**/*.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  return Object.entries(sources)
    .filter(([path]) => !path.endsWith("__root.tsx"))
    .map(([path, source]) => {
      const declared = /createFileRoute\("([^"]+)"\)/.exec(source);
      if (declared === null)
        throw new Error(`${path} declares no createFileRoute path`);
      return declared[1];
    })
    .filter((route) => !route.startsWith("/bench"));
}

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
    const scanned = new Set(SCANNED_STATES.map(({ route }) => route));
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

  for (const { route, state, heading, node } of SCANNED_STATES)
    test(`${route}: ${state}`, async () => {
      app.render(await node());
      await expect
        .element(page.getByRole("heading", { level: 1, name: heading }))
        .toBeInTheDocument();
      await flushPendingUpdates();
      expectNoAccessibilityViolations(app.container, { page: true });
    });
});
