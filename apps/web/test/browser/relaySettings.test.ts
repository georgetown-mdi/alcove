/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { Suspense, createElement } from "react";

import { isRedirect } from "@tanstack/react-router";

import "@mantine/core/styles.css";

import {
  COORDINATION_SERVER_CLEARED,
  COORDINATION_SERVER_INFO,
  COORDINATION_SERVER_SET,
  COORDINATION_SERVER_UNREADABLE,
  coordinationServerFieldDescription,
} from "@exchange/CoordinationServerSection";
import {
  DEFAULT_RELAY_SWITCH_DESCRIPTION,
  DEFAULT_RELAY_SWITCH_NOT_SAVED,
  NO_OWN_RELAY_SITE_RELAY_IN_USE,
  NO_RELAY_SET,
  RELAY_KEY_NOTICE,
  RELAY_OPERATOR_DISCLOSURE,
  RELAY_PAGE_INFO,
  RELAY_PAGE_INTRO,
  RelaySettingsScreen,
  STUN_FIELD_DESCRIPTION,
  STUN_FIELD_INFO,
  TURN_FIELD_DESCRIPTION,
  WEBSOCKET_RELAY_FIELD_DESCRIPTION,
  WEBSOCKET_RELAY_FIELD_INFO,
} from "@exchange/RelaySettingsScreen";
import {
  DEFAULT_RELAY_SWITCH_LABEL,
  readDefaultRelaySwitch,
} from "@psi/transport/defaultRelaySwitch";
import {
  RELAY_TEST_FAILED,
  RELAY_TEST_INTRO,
  RELAY_TEST_NOTHING_TO_TEST,
  RELAY_TEST_SAVED_ONLY,
  RELAY_TEST_UNSUPPORTED,
  RelayTestSection,
} from "@exchange/RelayTestSection";
import {
  coordinationServerFormMessage,
  readCoordinationServerSetting,
} from "@psi/transport/coordinationServerSetting";
import {
  readOwnRelaySetting,
  writeOwnRelaySetting,
} from "@psi/transport/ownRelaySetting";
import { RELAY_SETTINGS_GUIDE_URL } from "@exchange/userGuide";

import { CONSOLE_RELAY_POINTER, Lobby } from "@exchange/Lobby";

import {
  SFTP_RELAY_CLEARED,
  SFTP_RELAY_FIELD_DESCRIPTION,
  SFTP_RELAY_INFO,
  SFTP_RELAY_SET,
  SFTP_RELAY_UNREADABLE,
} from "@exchange/SftpRelaySection";
import { readSftpRelaySetting } from "@psi/transport/sftpRelaySetting";

import { Route as RelayRoute } from "../../src/routes/relay.tsx";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type {
  RelayTestResult,
  RelayTestTarget,
} from "@psi/transport/relayTest";

// The route module's createFileRoute and redirect stay real, so the /relay
// route's own beforeLoad is what the route tests below run.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...(await import("./moduleMocks")).reactRouterMock(),
}));

// Each test picks the build: the route and the start page read
// isConsoleBuild() as they load and render.
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
const infoButton = (name: string) => page.getByRole("button", { name });

/** Open the info button named `name` and wait for its explanation. */
async function openInfo(name: string, explanation: string): Promise<void> {
  await userEvent.click(infoButton(name));
  await expect
    .element(infoButton(name))
    .toHaveAttribute("aria-expanded", "true");
  await expect.element(page.getByText(explanation)).toBeVisible();
}

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
  test("opens with when a relay is needed and links to the guide", async () => {
    await mountScreen();

    expect(RELAY_PAGE_INTRO).toBe(
      "Use a relay when a firewall blocks a direct connection to your partner.",
    );
    await expect.element(page.getByText(RELAY_PAGE_INTRO)).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: /^Learn more about relay/ }))
      .toHaveAttribute("href", RELAY_SETTINGS_GUIDE_URL);
    expect(RELAY_SETTINGS_GUIDE_URL).toBe(
      "https://data-bridge.org/docs/WEB_APP#relay-settings",
    );
  });

  test("its info button says which party sets up the relay and what its operator learns, before anything is saved", async () => {
    await mountScreen();

    expect(RELAY_OPERATOR_DISCLOSURE).toBe(
      "The relay's operator learns each party's network address for every " +
        "exchange that uses it, even when no traffic is relayed. The relay " +
        "passes only encrypted traffic and cannot read the exchange.",
    );
    expect(RELAY_PAGE_INFO).toContain(
      "If you run the relay, create the invitation so your partner uses it too.",
    );
    expect(RELAY_PAGE_INFO).toContain(RELAY_OPERATOR_DISCLOSURE);
    await openInfo("About relays", RELAY_PAGE_INFO);
    expect(readOwnRelaySetting()).toEqual({ kind: "none" });
  });

  test("the STUN field's info says what a STUN server learns and that its servers replace the default", async () => {
    await mountScreen();

    expect(STUN_FIELD_DESCRIPTION).toBe(
      "One per line, for example stun:stun.example.org:3478",
    );
    await expect
      .element(stunField())
      .toHaveAccessibleDescription(STUN_FIELD_DESCRIPTION);
    expect(STUN_FIELD_INFO).toBe(
      "A STUN server finds each browser's public network address, so it " +
        "learns the network address of each party that uses it. The servers " +
        "you enter replace the default, Google's public STUN server, in " +
        "every exchange this browser runs, and invitations you create name " +
        "them, so your partner contacts them in place of the default too. " +
        "Servers an invitation you accept names are contacted as well, and " +
        "also replace the default.",
    );
    await openInfo("About STUN servers", STUN_FIELD_INFO);
  });

  test("the TURN field's info says that an exchange not enrolled at a registrar needs its relay key registered again", async () => {
    await mountScreen();

    await expect
      .element(turnField())
      .toHaveAccessibleDescription(TURN_FIELD_DESCRIPTION);
    await openInfo("About TURN servers", RELAY_KEY_NOTICE);
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

    expect(NO_RELAY_SET).toBe("No relay of your own is set.");
    await expect.element(statusLine()).toHaveTextContent(NO_RELAY_SET);
    await expect.element(turnField()).toHaveValue("");
    await expect.element(stunField()).toHaveValue("");
    expect(readOwnRelaySetting()).toEqual({ kind: "none" });

    await mountScreen();
    await expect.element(turnField()).toHaveValue("");
    await expect.element(stunField()).toHaveValue("");
  });
});

describe("RelaySettingsScreen: the WebSocket relay", () => {
  const WEBSOCKET_URL = "wss://wsrelay.example.org/relay";
  const websocketField = () =>
    page.getByRole("textbox", { name: "WebSocket relay url" });

  test("the field's info says each exchange connects to the relay, so its operator learns your address", async () => {
    await mountScreen();

    expect(WEBSOCKET_RELAY_FIELD_DESCRIPTION).toBe(
      "For example: wss://relay.example.org/relay",
    );
    await expect
      .element(websocketField())
      .toHaveAccessibleDescription(WEBSOCKET_RELAY_FIELD_DESCRIPTION);
    expect(WEBSOCKET_RELAY_FIELD_INFO).toBe(
      "A relay for networks that block connections through a TURN relay. An " +
        "invitation you send names it. Each exchange connects to it as it " +
        "starts, so its operator learns your network address, and the " +
        "exchange passes through it, encrypted, only when no other " +
        "connection opens.",
    );
    await openInfo("About the WebSocket relay", WEBSOCKET_RELAY_FIELD_INFO);
  });

  test("a save is kept across a reload, and removing clears it", async () => {
    await mountScreen();

    await userEvent.fill(websocketField(), WEBSOCKET_URL);
    await userEvent.click(saveButton());

    await expect
      .element(statusLine())
      .toHaveTextContent(
        "Saved. Exchanges started from now on use this relay.",
      );
    expect(readOwnRelaySetting()).toEqual({
      kind: "set",
      relay: { turn: [], stun: [], websocket: WEBSOCKET_URL },
    });

    await mountScreen();
    await expect.element(websocketField()).toHaveValue(WEBSOCKET_URL);

    await userEvent.click(removeButton());
    await expect.element(websocketField()).toHaveValue("");
    expect(readOwnRelaySetting()).toEqual({ kind: "none" });
  });

  test("an invalid url is reported on its field alone and nothing is saved", async () => {
    await mountScreen();

    await userEvent.fill(turnField(), TURN_URL);
    await userEvent.fill(websocketField(), "ws://wsrelay.example.org/relay");
    await userEvent.click(saveButton());

    await expect
      .element(websocketField())
      .toHaveAccessibleDescription(/the WebSocket relay url must be a wss:/);
    await expect
      .element(turnField())
      .not.toHaveAttribute("aria-invalid", "true");
    expect(page.getByRole("alert").all()).toHaveLength(1);
    expect(readOwnRelaySetting()).toEqual({ kind: "none" });
  });
});

describe("RelaySettingsScreen: the coordination server", () => {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const SERVER = `${scheme}://coordination.agency.example/signal/`;
  const serverField = () =>
    page.getByRole("textbox", { name: "Coordination server address" });
  const setButton = () =>
    page.getByRole("button", { name: "Set coordination server" });
  const clearButton = () =>
    page.getByRole("button", { name: "Clear coordination server" });
  const serverStatus = () =>
    page.getByText(/^(Set|Cleared)\. Invitations you create from now on/);

  test("its info says what the server learns and which server invitations name by default", async () => {
    await mountScreen();

    expect(COORDINATION_SERVER_INFO).toBe(
      "Your browser and your partner's find each other through a " +
        "coordination server. It learns the network address of each party " +
        "that uses it, and none of your data. Invitations you create name " +
        "this site's coordination server unless you set your own here. " +
        "Invitations you already sent, saved exchanges, and invitations you " +
        "accept keep the server they name, until you re-invite your partner " +
        "from a saved exchange you created, which then names the server set " +
        "here. If this browser cannot read the server set here, a re-invite " +
        "names the server that exchange already uses.",
    );
    expect(coordinationServerFieldDescription(scheme)).toBe(
      `For example: ${scheme}://signaling.example.org/api/`,
    );
    await expect
      .element(serverField())
      .toHaveAccessibleDescription(coordinationServerFieldDescription(scheme));
    await openInfo("About the coordination server", COORDINATION_SERVER_INFO);
  });

  test("a set address is kept across a reload, and clearing removes it", async () => {
    await mountScreen();

    await userEvent.fill(serverField(), SERVER);
    await userEvent.click(setButton());

    expect(COORDINATION_SERVER_SET).toBe(
      "Set. Invitations you create from now on name this coordination " +
        "server. It is first contacted when you create one.",
    );
    await expect
      .element(serverStatus())
      .toHaveTextContent(COORDINATION_SERVER_SET);
    expect(readCoordinationServerSetting(window.location.protocol)).toEqual({
      kind: "set",
      url: SERVER,
    });

    await mountScreen();
    await expect.element(serverField()).toHaveValue(SERVER);

    await userEvent.click(clearButton());
    await expect
      .element(serverStatus())
      .toHaveTextContent(COORDINATION_SERVER_CLEARED);
    await expect.element(serverField()).toHaveValue("");
    expect(readCoordinationServerSetting(window.location.protocol)).toEqual({
      kind: "none",
    });
  });

  const formMessage = coordinationServerFormMessage(window.location.protocol);

  test.each([
    [
      "https://psi.data-bridge.org",
      "This is a web page's address, not a coordination server's. Whoever " +
        `runs the server can give you its ${scheme}:// address.`,
    ],
    [
      `${scheme === "wss" ? "ws" : "wss"}://coordination.agency.example/`,
      formMessage,
    ],
    ["coordination.agency.example", formMessage],
  ])(
    "%j is refused on entry with a message naming the form that works",
    async (text, message) => {
      await mountScreen();

      await userEvent.fill(serverField(), text);
      await userEvent.click(setButton());

      await expect
        .element(serverField())
        .toHaveAttribute("aria-invalid", "true");
      await expect.element(page.getByRole("alert")).toHaveTextContent(message);
      expect(readCoordinationServerSetting(window.location.protocol)).toEqual({
        kind: "none",
      });
    },
  );

  const unreadableAlert = () =>
    page.getByRole("status", {
      name: "The saved coordination server could not be read",
    });

  test("a stored value this page cannot read says invitations name the site's server and a re-invite the exchange's own", async () => {
    window.localStorage.setItem("alcove-own-coordination-server", "{not json");
    await mountScreen();

    expect(COORDINATION_SERVER_UNREADABLE).toBe(
      "Until you set yours again, invitations you create name this site's " +
        "coordination server, and a re-invite from a saved exchange names " +
        "the server that exchange already uses. Enter its address and " +
        "choose Set coordination server.",
    );
    await expect.element(unreadableAlert()).toBeVisible();
    expect(unreadableAlert().element().textContent).toContain(
      COORDINATION_SERVER_UNREADABLE,
    );
  });

  test("the unreadable notice stays gone after a server is set and the address is edited again", async () => {
    window.localStorage.setItem("alcove-own-coordination-server", "{not json");
    await mountScreen();
    await expect.element(unreadableAlert()).toBeVisible();

    await userEvent.fill(serverField(), SERVER);
    await userEvent.click(setButton());
    await expect
      .element(serverStatus())
      .toHaveTextContent(COORDINATION_SERVER_SET);
    await userEvent.type(serverField(), "x");

    await expect.element(serverField()).toHaveValue(`${SERVER}x`);
    expect(unreadableAlert().query()).toBeNull();
  });
});

describe("RelaySettingsScreen: the SFTP relay", () => {
  const RELAY = "wss://relay.agency.example/sftp";
  const relayField = () =>
    page.getByRole("textbox", { name: "SFTP relay url" });
  const setButton = () => page.getByRole("button", { name: "Set SFTP relay" });
  const clearButton = () =>
    page.getByRole("button", { name: "Clear SFTP relay" });

  test("its info says what the relay sees and which relay a setting replaces", async () => {
    await mountScreen();

    expect(SFTP_RELAY_INFO).toBe(
      "To exchange over SFTP, a browser connects through an SFTP relay in " +
        "front of the SFTP server. An SFTP invitation can name your " +
        "partner's relay. Set a relay here to use your own instead, such as " +
        "one your organization runs. The relay sees your network address " +
        "and the start of each connection, and none of your data: the SFTP " +
        "server's own sign-in and encryption protect it.",
    );
    await expect
      .element(relayField())
      .toHaveAccessibleDescription(SFTP_RELAY_FIELD_DESCRIPTION);
    await openInfo("About the SFTP relay", SFTP_RELAY_INFO);
  });

  test("a set url is kept across a reload, and clearing removes it", async () => {
    await mountScreen();

    await userEvent.fill(relayField(), RELAY);
    await userEvent.click(setButton());
    await expect.element(page.getByText(SFTP_RELAY_SET)).toBeVisible();
    expect(readSftpRelaySetting()).toEqual({ kind: "set", url: RELAY });

    await mountScreen();
    await expect.element(relayField()).toHaveValue(RELAY);

    await userEvent.click(clearButton());
    await expect.element(page.getByText(SFTP_RELAY_CLEARED)).toBeVisible();
    await expect.element(relayField()).toHaveValue("");
    expect(readSftpRelaySetting()).toEqual({ kind: "none" });
  });

  const RELAY_FORM =
    "write it as a wss:// url naming a host, an optional port, and a path, " +
    "for example wss://sftp.example.org/sftp";

  test.each([
    [
      "a ws scheme",
      "ws://relay.agency.example/sftp",
      `The SFTP relay url must start with wss://; ${RELAY_FORM}`,
    ],
    [
      "userinfo",
      "wss://relay.agency.example@evil.example/sftp",
      "The SFTP relay url contains a space, a control character, or one of " +
        `@ \\ ? # %; ${RELAY_FORM}`,
    ],
  ])(
    "a url with %s is refused on entry and nothing is stored",
    async (_shape, text, message) => {
      await mountScreen();

      await userEvent.fill(relayField(), text);
      await userEvent.click(setButton());

      await expect
        .element(relayField())
        .toHaveAttribute("aria-invalid", "true");
      await expect.element(page.getByRole("alert")).toHaveTextContent(message);
      expect(readSftpRelaySetting()).toEqual({ kind: "none" });
    },
  );

  test("a stored value this page cannot read says so until it is set again", async () => {
    window.localStorage.setItem("alcove-own-sftp-relay", "{not json");
    await mountScreen();

    await expect.element(page.getByText(SFTP_RELAY_UNREADABLE)).toBeVisible();
    await userEvent.fill(relayField(), RELAY);
    await userEvent.click(setButton());
    await expect.element(page.getByText(SFTP_RELAY_SET)).toBeVisible();
    expect(page.getByText(SFTP_RELAY_UNREADABLE).query()).toBeNull();
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
    expect(RELAY_PAGE_INFO).toContain(
      "The allowed relays an exchange sets on its review, or a saved " +
        "exchange on its own page, can leave out any of the relays saved here.",
    );
    await openInfo("About relays", RELAY_PAGE_INFO);
    expect(document.body.textContent).not.toContain(
      "connection.allowed_relays",
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
    await expect.element(statusLine()).toHaveTextContent(NO_RELAY_SET);

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

    expect(RELAY_TEST_INTRO).toBe(
      "The test checks that this browser can reach each relay below. It does " +
        "not check that an exchange's traffic will pass through it. Each " +
        "relay's operator learns this browser's network address.",
    );
    await openInfo("About the relay test", RELAY_TEST_INTRO);
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

    expect(RELAY_TEST_NOTHING_TO_TEST).toBe(
      "There is no relay to test. Save a TURN server url above to test it.",
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

describe("the switch for a site relay offered switched off", () => {
  const siteSwitch = () =>
    page.getByRole("switch", { name: DEFAULT_RELAY_SWITCH_LABEL });
  const siteRelayListed = () =>
    page.getByRole("listitem").filter({ hasText: SITE_RELAY.turnUrl });

  test("starts off, states what the relay's operator learns, and turning it on or off takes one action", async () => {
    app.render(
      createElement(RelaySettingsScreen, {
        build: () => ({ kind: "opt-in" as const, relay: SITE_RELAY }),
      }),
    );

    await expect.element(siteSwitch()).not.toBeChecked();
    await openInfo(
      "About this site's relay server",
      DEFAULT_RELAY_SWITCH_DESCRIPTION,
    );
    await expect
      .element(siteSwitch())
      .toHaveAccessibleDescription(DEFAULT_RELAY_SWITCH_DESCRIPTION);
    expect(DEFAULT_RELAY_SWITCH_DESCRIPTION).toContain(
      RELAY_OPERATOR_DISCLOSURE,
    );
    expect(siteRelayListed().query()).toBeNull();
    expect(readDefaultRelaySwitch()).toBe(false);

    await userEvent.click(siteSwitch());

    await expect.element(siteSwitch()).toBeChecked();
    expect(readDefaultRelaySwitch()).toBe(true);
    await expect.element(siteRelayListed()).toBeVisible();

    await userEvent.click(siteSwitch());

    await expect.element(siteSwitch()).not.toBeChecked();
    expect(readDefaultRelaySwitch()).toBe(false);
    await expect.poll(() => siteRelayListed().query()).toBeNull();
  });

  test("its description says what it covers and that a partner can still bring the relay in", () => {
    expect(DEFAULT_RELAY_SWITCH_DESCRIPTION).toBe(
      "This setting applies to the exchanges this browser runs and the " +
        "invitations you create. When it is on, those exchanges use the " +
        "site's relay server, unless an exchange's allowed relays leave it " +
        "out, and those invitations name it so your partner can use it too. " +
        "When it is off, this browser uses it only where an invitation you " +
        "accept names it, or where you enter its address under TURN server " +
        "urls. Your partner can still bring it into an exchange whatever you " +
        "choose here, so to keep it out, you both leave it out. " +
        RELAY_OPERATOR_DISCLOSURE,
    );
  });

  test("a switch the browser did not save announces the error as an alert", async () => {
    app.render(
      createElement(RelaySettingsScreen, {
        build: () => ({ kind: "opt-in" as const, relay: SITE_RELAY }),
      }),
    );
    await expect.element(siteSwitch()).not.toBeChecked();
    const refused = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota exceeded");
      });
    try {
      await userEvent.click(siteSwitch());
    } finally {
      refused.mockRestore();
    }

    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(DEFAULT_RELAY_SWITCH_NOT_SAVED);
    await expect
      .element(siteSwitch())
      .toHaveAccessibleDescription(
        new RegExp(DEFAULT_RELAY_SWITCH_NOT_SAVED.replace(/\./g, "\\.")),
      );
    await expect.element(siteSwitch()).not.toBeChecked();
    expect(readDefaultRelaySwitch()).toBe(false);
  });

  test("removing the relay with the site's relay turned on says exchanges use it, and turning it off says they use none", async () => {
    writeOwnRelaySetting({ turn: [TURN_URL], stun: [] });
    app.render(
      createElement(RelaySettingsScreen, {
        build: () => ({ kind: "opt-in" as const, relay: SITE_RELAY }),
      }),
    );
    await userEvent.click(siteSwitch());
    await expect.element(siteSwitch()).toBeChecked();

    await userEvent.click(removeButton());

    await expect
      .element(statusLine())
      .toHaveTextContent(NO_OWN_RELAY_SITE_RELAY_IN_USE);
    expect(NO_OWN_RELAY_SITE_RELAY_IN_USE).toBe(
      "No relay of your own is set. Exchanges use this site's relay server.",
    );

    await userEvent.click(siteSwitch());

    await expect.element(statusLine()).toHaveTextContent(NO_RELAY_SET);
  });

  test("saving no relay on a build that turns the site's relay on says exchanges use it", async () => {
    app.render(
      createElement(RelaySettingsScreen, {
        build: () => ({ kind: "on" as const, relay: SITE_RELAY }),
      }),
    );
    await expect.element(turnField()).toBeInTheDocument();

    await userEvent.click(saveButton());

    await expect
      .element(statusLine())
      .toHaveTextContent(NO_OWN_RELAY_SITE_RELAY_IN_USE);
  });

  test.each([
    [
      "in use",
      { kind: "on" as const, relay: SITE_RELAY },
      NO_OWN_RELAY_SITE_RELAY_IN_USE,
    ],
    [
      "offered and off",
      { kind: "opt-in" as const, relay: SITE_RELAY },
      "Exchanges in this browser use no relay of your own until you save one again.",
    ],
  ])(
    "an unreadable saved relay with the site's relay %s says what exchanges use",
    async (_state, offer, said) => {
      window.localStorage.setItem("alcove-own-relay", "{not json");
      app.render(createElement(RelaySettingsScreen, { build: () => offer }));

      const alert = page.getByRole("status", {
        name: "The saved relay could not be read",
      });
      await expect.element(alert).toBeVisible();
      expect(alert.element().textContent).toContain(
        `${said} Enter the relay's addresses and save.`,
      );
    },
  );

  test.each([
    ["names no relay", { kind: "none" as const }],
    ["turns the relay on", { kind: "on" as const, relay: SITE_RELAY }],
  ])("a build that %s offers no switch", async (_build, offer) => {
    app.render(createElement(RelaySettingsScreen, { build: () => offer }));
    await expect.element(turnField()).toBeInTheDocument();
    expect(siteSwitch().query()).toBeNull();
  });
});

/** What the /relay route's beforeLoad throws, or undefined where it returns. */
function relayRouteBeforeLoadThrown(): unknown {
  const { beforeLoad } = RelayRoute.options as {
    beforeLoad?: (context: unknown) => unknown;
  };
  if (beforeLoad === undefined) throw new Error("route declares no beforeLoad");
  try {
    beforeLoad({});
  } catch (thrown) {
    return thrown;
  }
  return undefined;
}

describe("the /relay route", () => {
  test("on the console, opens the invitation flow, whose review step sets the relay", () => {
    build.console = true;

    const thrown = relayRouteBeforeLoadThrown();

    expect(isRedirect(thrown)).toBe(true);
    expect((thrown as { options: unknown }).options).toMatchObject({
      to: "/exchange",
      replace: true,
    });
  });

  test("on the hosted app, renders the relay settings page with its relay test", async () => {
    writeOwnRelaySetting({ turn: [TURN_URL], stun: [] });

    expect(relayRouteBeforeLoadThrown()).toBeUndefined();
    const component = RelayRoute.options.component;
    if (component === undefined) throw new Error("route declares no component");
    app.render(
      createElement(Suspense, { fallback: null }, createElement(component)),
    );

    await expect
      .element(page.getByRole("heading", { level: 1, name: "Relay server" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Test these relays" }))
      .toBeVisible();
  });

  test("the console start page links to no relay page and says where a relay is set", async () => {
    build.console = true;
    app.render(createElement(Lobby));

    await expect.element(page.getByText(CONSOLE_RELAY_POINTER)).toBeVisible();
    expect(CONSOLE_RELAY_POINTER).toBe(
      "If using peer-to-peer, some workplace networks may block the " +
        "connection. Your IT team can give you a relay server address. To " +
        "use it, create an invitation, choose Over WebRTC, run here on its " +
        "review step, and choose Set a relay.",
    );
    expect(document.querySelector('a[href="/relay"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/relay settings/i);
  });

  test("the hosted start page links to relay settings", async () => {
    app.render(createElement(Lobby));

    await expect
      .element(page.getByRole("link", { name: "relay settings" }))
      .toHaveAttribute("href", "/relay");
    expect(page.getByText(CONSOLE_RELAY_POINTER).query()).toBeNull();
  });
});
