/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  RELAY_KEY_NOTICE,
  RELAY_OPERATOR_DISCLOSURE,
  RelaySettingsScreen,
} from "@exchange/RelaySettingsScreen";
import {
  RELAY_TEST_FAILED,
  RELAY_TEST_INTRO,
  RELAY_TEST_NOTHING_TO_TEST,
  RELAY_TEST_SAVED_ONLY,
  RELAY_TEST_UNSUPPORTED,
  RelayTestSection,
} from "@exchange/RelayTestSection";
import {
  readOwnRelaySetting,
  writeOwnRelaySetting,
} from "@psi/transport/ownRelaySetting";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type {
  RelayTestResult,
  RelayTestTarget,
} from "@psi/transport/relayTest";

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

// Each test picks the build: the screen reads isConsoleBuild() as it renders.
const build = vi.hoisted(() => ({ console: false }));
vi.mock("@utils/clientConfig", async (importOriginal) => {
  const { clientConfigMock, consoleClientConfigMock } =
    await import("../utils/clientConfigMock");
  const hosted = await clientConfigMock(importOriginal);
  const consoleBuild = await consoleClientConfigMock(importOriginal);
  return Object.fromEntries(
    Object.keys(hosted).map((name) => [
      name,
      (...args: Array<unknown>) =>
        (
          (build.console ? consoleBuild : hosted) as unknown as Record<
            string,
            (...a: Array<unknown>) => unknown
          >
        )[name](...args),
    ]),
  );
});

const TURN_URL = "turns:relay.example.org:443?transport=tcp";
const STUN_URL = "stun:stun.example.org:3478";

const app = createAppMount();

const turnField = () => page.getByRole("textbox", { name: "TURN server urls" });
const stunField = () => page.getByRole("textbox", { name: "STUN server urls" });
const saveButton = () => page.getByRole("button", { name: "Save" });
const removeButton = () => page.getByRole("button", { name: "Remove relay" });
const statusLine = () => page.getByRole("status");

/** Mount the screen afresh, as a page load does: it reads storage on mount. */
async function mountScreen(): Promise<void> {
  app.unmount();
  app.render(createElement(RelaySettingsScreen));
  await expect.element(turnField()).toBeInTheDocument();
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  window.localStorage.clear();
  build.console = false;
});

describe("RelaySettingsScreen", () => {
  test("states what the relay's operator learns before anything is saved", async () => {
    await mountScreen();

    await expect
      .element(page.getByText(RELAY_OPERATOR_DISCLOSURE))
      .toBeVisible();
    expect(readOwnRelaySetting()).toEqual({ kind: "none" });
  });

  test("states that an exchange not enrolled at a registrar needs its relay key registered again", async () => {
    await mountScreen();

    await expect.element(page.getByText(RELAY_KEY_NOTICE)).toBeVisible();
    expect(RELAY_KEY_NOTICE).toContain(
      "A saved exchange enrolled at your relay's registrar",
    );
    expect(RELAY_KEY_NOTICE).not.toContain("does not register");
  });

  test("an invalid TURN url is reported on the TURN field alone and nothing is saved", async () => {
    await mountScreen();

    await userEvent.fill(turnField(), "http://relay.example.org");
    await userEvent.fill(stunField(), STUN_URL);
    await userEvent.click(saveButton());

    await expect.element(turnField()).toHaveAccessibleDescription(/Line 1: /);
    await expect.element(turnField()).toHaveAttribute("aria-invalid", "true");
    await expect
      .element(stunField())
      .not.toHaveAttribute("aria-invalid", "true");
    expect(page.getByRole("alert").all()).toHaveLength(1);
    expect(statusLine().element().textContent).toBe("");
    expect(readOwnRelaySetting()).toEqual({ kind: "none" });
  });

  test("an invalid STUN url is reported on the STUN field alone and nothing is saved", async () => {
    await mountScreen();

    await userEvent.fill(turnField(), TURN_URL);
    await userEvent.fill(stunField(), `${STUN_URL}\nstun:`);
    await userEvent.click(saveButton());

    await expect.element(stunField()).toHaveAccessibleDescription(/Line 2: /);
    await expect.element(stunField()).toHaveAttribute("aria-invalid", "true");
    await expect
      .element(turnField())
      .not.toHaveAttribute("aria-invalid", "true");
    expect(page.getByRole("alert").all()).toHaveLength(1);
    expect(statusLine().element().textContent).toBe("");
    expect(readOwnRelaySetting()).toEqual({ kind: "none" });
  });

  test("a save is kept across a reload, and removing clears it", async () => {
    await mountScreen();

    await userEvent.fill(turnField(), TURN_URL);
    await userEvent.fill(stunField(), STUN_URL);
    await userEvent.click(saveButton());

    await expect
      .element(statusLine())
      .toHaveTextContent(
        "Saved. Exchanges started from now on use this relay.",
      );
    expect(readOwnRelaySetting()).toEqual({
      kind: "set",
      relay: { turn: [TURN_URL], stun: [STUN_URL] },
    });

    await mountScreen();
    await expect.element(turnField()).toHaveValue(TURN_URL);
    await expect.element(stunField()).toHaveValue(STUN_URL);

    await userEvent.click(removeButton());

    await expect
      .element(statusLine())
      .toHaveTextContent("No relay is set. Exchanges connect without one.");
    await expect.element(turnField()).toHaveValue("");
    await expect.element(stunField()).toHaveValue("");
    expect(readOwnRelaySetting()).toEqual({ kind: "none" });

    await mountScreen();
    await expect.element(turnField()).toHaveValue("");
    await expect.element(stunField()).toHaveValue("");
  });
});

/** What an earlier build stored as this browser's allowed relays, under the
 * key it used: no migration removes it. */
const EARLIER_ALLOWED_RELAYS_KEY = "alcove-relay-restriction";
const EARLIER_ALLOWED_RELAYS = JSON.stringify({
  version: 1,
  allowedRelays: ["elsewhere.example.org"],
});

describe("RelaySettingsScreen: the relays an exchange may use are its own", () => {
  test("the hosted build shows no Allowed relays, and says where an exchange sets them", async () => {
    await mountScreen();

    expect(
      page.getByRole("textbox", { name: "Allowed relays" }).query(),
    ).toBeNull();
    expect(
      page
        .getByRole("heading", { name: "Which relays an exchange may use" })
        .query(),
    ).toBeNull();
    expect(document.body.textContent).toContain(
      "A run also lists the relay named by an invitation you accept, after " +
        "yours. The allowed relays an exchange sets on its review, or a saved " +
        "exchange on its own page, can leave out any of these.",
    );
    expect(document.body.textContent).not.toContain(
      "connection.allowed_relays",
    );
  });

  test("the console build shows no Allowed relays and names no configuration key", async () => {
    build.console = true;
    await mountScreen();

    expect(
      page.getByRole("textbox", { name: "Allowed relays" }).query(),
    ).toBeNull();
    expect(document.body.textContent).not.toContain("allowed relays");
    expect(document.body.textContent).not.toContain(
      "connection.allowed_relays",
    );
    expect(document.body.textContent).toContain(
      "A run also lists the relay named by an invitation you accept, after " +
        "yours. Each exchange signs in",
    );
  });

  test("a save the browser refuses says so and leaves the saved relay as it was", async () => {
    writeOwnRelaySetting({ turn: [TURN_URL], stun: [] });
    await mountScreen();
    const refused = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota exceeded");
      });
    try {
      await userEvent.fill(turnField(), "turn:backup.example.org:3478");
      await userEvent.click(saveButton());
    } finally {
      refused.mockRestore();
    }

    await expect
      .element(statusLine())
      .toHaveTextContent(
        "This browser did not save the setting. Check that site storage is " +
          "allowed for this site, then save again.",
      );
    expect(readOwnRelaySetting()).toEqual({
      kind: "set",
      relay: { turn: [TURN_URL], stun: [] },
    });
  });

  test("saving and removing the relay leave an earlier build's stored allowed relays in place", async () => {
    window.localStorage.setItem(
      EARLIER_ALLOWED_RELAYS_KEY,
      EARLIER_ALLOWED_RELAYS,
    );
    await mountScreen();

    await userEvent.fill(turnField(), TURN_URL);
    await userEvent.click(saveButton());
    await expect
      .element(statusLine())
      .toHaveTextContent(
        "Saved. Exchanges started from now on use this relay.",
      );
    await userEvent.click(removeButton());
    await expect
      .element(statusLine())
      .toHaveTextContent("No relay is set. Exchanges connect without one.");

    expect(window.localStorage.getItem(EARLIER_ALLOWED_RELAYS_KEY)).toBe(
      EARLIER_ALLOWED_RELAYS,
    );
  });
});

const SITE_RELAY = {
  turnUrl: "turn:site-relay.example.org:3478",
  registrarUrl: "https://registrar.example.org",
};

/**
 * Stands in for the browser's peer connection: records each one built and
 * answers every relay with a 401 once the offer is set, as a relay refusing
 * the placeholder credential does.
 */
function stubRelayAnswering(): Array<RTCConfiguration> {
  const built: Array<RTCConfiguration> = [];
  class AnsweringPeerConnection extends EventTarget {
    iceGatheringState: RTCIceGatheringState = "new";
    constructor(readonly configuration: RTCConfiguration) {
      super();
      built.push(configuration);
    }
    createDataChannel(): void {}
    createOffer(): Promise<RTCSessionDescriptionInit> {
      return Promise.resolve({ type: "offer", sdp: "" });
    }
    setLocalDescription(): Promise<void> {
      const server = this.configuration.iceServers?.[0];
      const url = [server?.urls ?? []].flat()[0] ?? "";
      queueMicrotask(() =>
        this.dispatchEvent(
          Object.assign(new Event("icecandidateerror"), {
            url,
            errorCode: 401,
            errorText: "Unauthorized",
          }),
        ),
      );
      return Promise.resolve();
    }
    close(): void {}
  }
  vi.stubGlobal("RTCPeerConnection", AnsweringPeerConnection);
  return built;
}

describe("the relay test", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const testButton = () =>
    page.getByRole("button", { name: "Test these relays" });

  test("names the saved and the site's relay and contacts neither until it is started", async () => {
    const built = stubRelayAnswering();
    writeOwnRelaySetting({ turn: [TURN_URL], stun: [STUN_URL] });
    app.render(
      createElement(RelaySettingsScreen, { defaultRelay: () => SITE_RELAY }),
    );

    await expect.element(page.getByText(RELAY_TEST_INTRO)).toBeVisible();
    await expect
      .element(page.getByRole("listitem").filter({ hasText: TURN_URL }))
      .toHaveTextContent(`${TURN_URL} - your relay, over TLS`);
    await expect
      .element(
        page.getByRole("listitem").filter({ hasText: SITE_RELAY.turnUrl }),
      )
      .toHaveTextContent(`${SITE_RELAY.turnUrl} - this site's relay, over UDP`);
    await expect.element(testButton()).toBeVisible();
    expect(built).toHaveLength(0);

    await userEvent.click(testButton());

    await expect
      .element(page.getByRole("heading", { name: "Test results" }))
      .toBeVisible();
    expect(built.map((configuration) => configuration.iceServers)).toEqual([
      [expect.objectContaining({ urls: [TURN_URL] })],
      [expect.objectContaining({ urls: [SITE_RELAY.turnUrl] })],
    ]);
    const results = page.getByRole("list").last().getByRole("listitem");
    await expect
      .element(results.first())
      .toHaveTextContent(
        `${TURN_URL}: Answered over TLS: the relay refused the test's placeholder credential, so this browser reaches it over TLS.`,
      );
    await expect
      .element(results.last())
      .toHaveTextContent(
        `${SITE_RELAY.turnUrl}: Answered over UDP: the relay refused the test's placeholder credential, so this browser reaches it over UDP.`,
      );
  });

  test("lists every saved relay and the site's, whatever an earlier build stored as allowed relays", async () => {
    stubRelayAnswering();
    window.localStorage.setItem(
      EARLIER_ALLOWED_RELAYS_KEY,
      JSON.stringify({ version: 1, allowedRelays: ["relay.example.org"] }),
    );
    const backupUrl = "turn:backup.example.org:3478";
    writeOwnRelaySetting({ turn: [TURN_URL, backupUrl], stun: [] });
    app.render(
      createElement(RelaySettingsScreen, { defaultRelay: () => SITE_RELAY }),
    );

    await expect.element(testButton()).toBeVisible();
    for (const [url, listed] of [
      [TURN_URL, `${TURN_URL} - your relay, over TLS`],
      [backupUrl, `${backupUrl} - your relay, over UDP`],
      [
        SITE_RELAY.turnUrl,
        `${SITE_RELAY.turnUrl} - this site's relay, over UDP`,
      ],
    ])
      await expect
        .element(page.getByRole("listitem").filter({ hasText: url }))
        .toHaveTextContent(listed);
  });

  test("tests the saved addresses, and says so while the field differs", async () => {
    stubRelayAnswering();
    writeOwnRelaySetting({ turn: [TURN_URL], stun: [] });
    app.render(
      createElement(RelaySettingsScreen, { defaultRelay: () => undefined }),
    );
    await expect.element(testButton()).toBeVisible();
    expect(page.getByText(RELAY_TEST_SAVED_ONLY).query()).toBeNull();

    await userEvent.fill(turnField(), "turn:other.example.org:3478");

    await expect.element(page.getByText(RELAY_TEST_SAVED_ONLY)).toBeVisible();
  });

  test("with no relay saved and none named by the site, offers nothing to test", async () => {
    const built = stubRelayAnswering();
    app.render(
      createElement(RelaySettingsScreen, { defaultRelay: () => undefined }),
    );

    await expect
      .element(page.getByText(RELAY_TEST_NOTHING_TO_TEST))
      .toBeVisible();
    expect(testButton().query()).toBeNull();
    expect(built).toHaveLength(0);
  });

  test("in a browser without peer connections, says the test cannot run and offers none", async () => {
    vi.stubGlobal("RTCPeerConnection", undefined);
    app.render(
      createElement(RelaySettingsScreen, { defaultRelay: () => SITE_RELAY }),
    );

    await expect.element(page.getByText(RELAY_TEST_UNSUPPORTED)).toBeVisible();
    expect(testButton().query()).toBeNull();
    expect(page.getByText("did not accept the address").query()).toBeNull();
  });

  test("while it runs, announces the wait and keeps focus on the button", async () => {
    const runTest = vi.fn(
      () => new Promise<Array<RelayTestResult>>(() => undefined),
    );
    app.render(
      createElement(RelayTestSection, {
        targets: TWO_TARGETS,
        unsavedChanges: false,
        runTest,
      }),
    );

    await userEvent.click(testButton());

    await expect
      .element(
        page.getByText("Testing 2 relays. This can take up to 30 seconds."),
      )
      .toBeVisible();
    const button = testButton().element();
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(button);

    await userEvent.keyboard("{Enter}");
    expect(runTest).toHaveBeenCalledOnce();
  });

  test("a run that fails says the test could not run and ends the wait", async () => {
    const runTest = vi.fn(() =>
      Promise.reject<Array<RelayTestResult>>(new Error("no data channel")),
    );
    app.render(
      createElement(RelayTestSection, {
        targets: TWO_TARGETS,
        unsavedChanges: false,
        runTest,
      }),
    );

    await userEvent.click(testButton());

    await expect.element(page.getByText(RELAY_TEST_FAILED)).toBeVisible();
    expect(testButton().element().hasAttribute("aria-disabled")).toBe(false);
    expect(page.getByText(/^Testing /).query()).toBeNull();
  });
});

const TWO_TARGETS: Array<RelayTestTarget> = [
  { url: TURN_URL, source: "own", transport: "tls" },
  { url: SITE_RELAY.turnUrl, source: "site", transport: "udp" },
];
