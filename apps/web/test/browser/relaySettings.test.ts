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
  RELAY_TEST_INTRO,
  RELAY_TEST_NOTHING_TO_TEST,
  RELAY_TEST_SAVED_ONLY,
} from "@exchange/RelayTestSection";
import {
  readOwnRelaySetting,
  writeOwnRelaySetting,
} from "@psi/transport/ownRelaySetting";

import { createAppMount, flushPendingUpdates } from "./renderApp";

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

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
});
