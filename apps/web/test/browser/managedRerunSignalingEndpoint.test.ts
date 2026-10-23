/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  generateSharedSecret,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@alcove/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
} from "@psi/managed/managedExchangeStore";
import { MANAGED_INPUT_FILE_NAME } from "@psi/managed/managedInputHandle";
import { ManagedRunSurface } from "@recurring/ManagedRunSurface";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";

import { createAppMount, flushPendingUpdates } from "./renderApp";
import { expectConsole } from "./expectedConsole";

import type { WebRTCEndpoint, WebRTCExchangeLocator } from "@alcove/core";
import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";

// An accepting party's attended re-run, from the Run button through the real
// driver to the dial: the dial goes to the signaling server the record saved
// from the invitation it accepted, never to this page's own server, and a
// saved address that fails the invitation endpoint's validation stops the run
// before anything is dialled, naming the exchange. An inviting party's
// re-invite from such a record, while this browser cannot read its own
// coordination server setting, stops with the setting as its remedy.

const LABEL = "Riverbend quarterly";

const dials = vi.hoisted(() => ({
  endpoints: [] as Array<unknown>,
}));

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/transport/rendezvous", async () => {
  const mock = (await import("./moduleMocks")).rendezvousMock();
  return {
    ...mock,
    dialAsAcceptor: (_secret: string, endpoint: unknown) => {
      dials.endpoints.push(endpoint);
      return Promise.reject(new Error("no partner in this test"));
    },
  };
});

// A saved address on another deployment: nothing in it is this page's host,
// port or path.
const savedLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.partner-deployment.example",
  port: 8443,
  path: "/signal/",
};

const linkageTerms = getDefaultLinkageTerms(
  "County Health Dept",
  inferMetadata(["ssn", "first_name", "last_name", "date_of_birth"], []),
);

const INPUT_CSV =
  "ssn,first_name,last_name,date_of_birth\n123456789,ADA,LOVELACE,01/01/1990\n";

async function folderWithInput(
  name: string,
): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const folder = await root.getDirectoryHandle(name, { create: true });
  const handle = await folder.getFileHandle(MANAGED_INPUT_FILE_NAME, {
    create: true,
  });
  const writable = await handle.createWritable();
  await writable.write(INPUT_CSV);
  await writable.close();
  return folder;
}

const FOLDER_NAMES: Array<string> = [];

/** The localStorage key this browser's coordination server setting is kept
 * under. */
const COORDINATION_SERVER_SETTING_KEY = "alcove-own-coordination-server";

/** A saved host the invitation endpoint's validation refuses. */
const REFUSED_HOST = "partner.example@attacker.example";

async function acceptorExchange(
  folderName: string,
  overrides: Partial<NewManagedExchange> = {},
): Promise<NewManagedExchange> {
  FOLDER_NAMES.push(folderName);
  return {
    label: LABEL,
    exchangeFile: composeManagedExchangeFile({
      connection: savedLocator,
      linkageTerms,
    }),
    side: "acceptor",
    sharedSecret: generateSharedSecret(),
    workingDirectoryHandle: await folderWithInput(folderName),
    ...overrides,
  };
}

const app = createAppMount();

beforeEach(async () => {
  dials.endpoints.length = 0;
  await clearManagedExchanges();
});

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  window.localStorage.removeItem(COORDINATION_SERVER_SETTING_KEY);
  await clearManagedExchanges();
  const root = await navigator.storage.getDirectory();
  for (const name of FOLDER_NAMES.splice(0))
    await root.removeEntry(name, { recursive: true }).catch(() => undefined);
});

async function pressRun(id: string): Promise<void> {
  app.render(createElement(ManagedRunSurface, { id }));
  const runButton = page.getByRole("button", { name: "Run exchange" });
  await expect.element(runButton).toBeEnabled();
  await runButton.click();
}

describe("an accepting party's re-run", () => {
  test("dials the coordination server the record saved", async () => {
    expectConsole("error", /no partner in this test/);
    const created = await createManagedExchange(
      await acceptorExchange("rerun-saved-endpoint"),
    );

    await pressRun(created.id);

    await vi.waitFor(() => expect(dials.endpoints).toHaveLength(1));
    const expected: WebRTCEndpoint = { ...savedLocator };
    expect(dials.endpoints[0]).toEqual(expected);
    expect((dials.endpoints[0] as WebRTCEndpoint).host).not.toBe(
      window.location.hostname,
    );
    await expect
      .element(page.getByText("The run could not be completed"))
      .toBeInTheDocument();
  });

  test("a saved address that fails validation stops the run before any dial, naming the exchange and offering no retry", async () => {
    expectConsole("error", /ManagedSignalingEndpointRefusedError/);
    const exchange = await acceptorExchange("rerun-refused-endpoint");
    const created = await createManagedExchange({
      ...exchange,
      exchangeFile: composeManagedExchangeFile({
        connection: { ...savedLocator, host: REFUSED_HOST },
        linkageTerms,
      }),
    });

    await pressRun(created.id);

    await expect
      .element(
        page.getByText(
          `The saved exchange "${LABEL}" cannot run: the coordination server ` +
            "address it saved names a host that is not a host name or IP address alone " +
            "(an IPv6 address in square brackets), " +
            "so this app does not connect to it.",
          { exact: false },
        ),
      )
      .toBeInTheDocument();
    expect(dials.endpoints).toHaveLength(0);

    const alert = page.getByRole("alert").filter({
      hasText: "The saved coordination server address cannot be used",
    });
    await expect.element(alert).toBeInTheDocument();
    const alertText = alert.element().textContent;
    expect(alertText).toContain(
      "Running it again stops the same way; this exchange needs a fresh " +
        "invitation.",
    );
    expect(alertText).not.toMatch(/try again/i);
    expect(
      page.getByText("The run could not be completed").elements(),
    ).toHaveLength(0);
    await expect
      .element(page.getByText("Ask your partner to re-invite."))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("link", { name: "Back to recurring exchanges" }))
      .toBeInTheDocument();
  });
});

describe("an inviting party's re-invite while this browser cannot read its coordination server", () => {
  test("from a record whose saved address a run refuses, stops and says to set or clear the setting in relay settings first", async () => {
    expectConsole("error", /ManagedSignalingEndpointRefusedError/);
    window.localStorage.setItem(COORDINATION_SERVER_SETTING_KEY, "{not json");
    const exchange = await acceptorExchange("reinvite-refused-endpoint", {
      side: "inviter",
      exchangeFile: composeManagedExchangeFile({
        connection: { ...savedLocator, host: REFUSED_HOST },
        linkageTerms,
      }),
    });
    const created = await createManagedExchange(exchange);

    await pressRun(created.id);
    await expect
      .element(
        page.getByRole("alert").filter({
          hasText: "The saved coordination server address cannot be used",
        }),
      )
      .toBeInTheDocument();

    await page
      .getByRole("button", { name: "Create a fresh invitation" })
      .click();

    const failure = page.getByRole("alert").filter({
      hasText: "Could not create a fresh invitation",
    });
    await expect.element(failure).toBeInTheDocument();
    expect(failure.element().textContent).toBe(
      "Could not create a fresh invitation" +
        "Relay settings cannot read your coordination server, and the " +
        "coordination server address this exchange saved cannot be used. " +
        "Set your coordination server again or clear it in relay settings " +
        "first, then try again.",
    );
    expect((await getManagedExchange(created.id))?.sharedSecret).toBe(
      exchange.sharedSecret,
    );
  });
});
