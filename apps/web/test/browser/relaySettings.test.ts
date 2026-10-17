/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  ALLOWED_RELAYS_SCOPE,
  readRelayRestriction,
} from "@psi/transport/relayRestriction";
import {
  CONSOLE_RELAY_RESTRICTION_LINE,
  NOTHING_SAVED,
  RELAY_KEY_NOTICE,
  RELAY_OPERATOR_DISCLOSURE,
  REMOVED_RESTRICTION_UNREADABLE,
  RESTRICTION_SAVED_RELAY_NOT_SAVED,
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

describe("RelaySettingsScreen: allowed relays", () => {
  const allowedField = () =>
    page.getByRole("textbox", { name: "Allowed relays" });

  test("states what the setting decides, and that an accepted invitation's relay is listed beside this browser's", async () => {
    await mountScreen();

    await expect.element(page.getByText(ALLOWED_RELAYS_SCOPE)).toBeVisible();
    expect(ALLOWED_RELAYS_SCOPE).toContain(
      "Your partner's side can still connect through a relay you leave out.",
    );
    await expect
      .element(allowedField())
      .toHaveAccessibleDescription(
        /covers relay servers only: a run still contacts the STUN servers an invitation names\./,
      );
    expect(document.body.textContent).not.toContain("in their place");
  });

  test("a save keeps the entries normalized across a reload, and clearing them removes them", async () => {
    await mountScreen();

    await userEvent.fill(
      allowedField(),
      " Relay.Example.ORG. \nbackup.example.org:443",
    );
    await userEvent.click(saveButton());

    await expect
      .element(statusLine())
      .toHaveTextContent("Saved. No relay of your own is set.");
    expect(readRelayRestriction()).toEqual({
      kind: "set",
      restriction: {
        allowedRelays: ["relay.example.org", "backup.example.org:443"],
      },
    });

    await mountScreen();
    await expect
      .element(allowedField())
      .toHaveValue("relay.example.org\nbackup.example.org:443");

    await userEvent.fill(allowedField(), "");
    await userEvent.click(saveButton());

    await expect
      .element(statusLine())
      .toHaveTextContent("No relay is set. Exchanges connect without one.");
    expect(window.localStorage.getItem("alcove-relay-restriction")).toBeNull();
  });

  test("an entry naming a scheme is reported on the field alone and nothing is saved", async () => {
    await mountScreen();

    await userEvent.fill(turnField(), TURN_URL);
    await userEvent.fill(allowedField(), "turns:relay.example.org:443");
    await userEvent.click(saveButton());

    await expect
      .element(allowedField())
      .toHaveAccessibleDescription(/Line 1: enter a host and an optional port/);
    await expect
      .element(allowedField())
      .toHaveAttribute("aria-invalid", "true");
    expect(page.getByRole("alert").all()).toHaveLength(1);
    expect(readRelayRestriction()).toEqual({ kind: "set", restriction: {} });
    expect(readOwnRelaySetting()).toEqual({ kind: "none" });
  });

  test("a save that stores the allowed relays but not the own relay shows what is stored", async () => {
    const backupUrl = "turn:backup.example.org:3478";
    writeOwnRelaySetting({ turn: [TURN_URL, backupUrl], stun: [] });
    await mountScreen();
    const setItem = Storage.prototype.setItem;
    const refused = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === "alcove-own-relay") throw new Error("quota exceeded");
        setItem.call(this, key, value);
      });
    try {
      await userEvent.fill(allowedField(), "relay.example.org");
      await userEvent.click(saveButton());
    } finally {
      refused.mockRestore();
    }

    await expect
      .element(statusLine())
      .toHaveTextContent(RESTRICTION_SAVED_RELAY_NOT_SAVED);
    expect(RESTRICTION_SAVED_RELAY_NOT_SAVED).toBe(
      "Your allowed relays were saved, and the relay server addresses " +
        "were not. Check that site storage is allowed for this site, then " +
        "save again.",
    );
    expect(readRelayRestriction()).toEqual({
      kind: "set",
      restriction: { allowedRelays: ["relay.example.org"] },
    });
    expect(readOwnRelaySetting()).toEqual({
      kind: "set",
      relay: { turn: [TURN_URL, backupUrl], stun: [] },
    });
    await expect
      .element(page.getByRole("listitem").filter({ hasText: TURN_URL }))
      .toBeVisible();
    expect(
      page.getByRole("listitem").filter({ hasText: backupUrl }).query(),
    ).toBeNull();
    expect(page.getByText(RELAY_TEST_SAVED_ONLY).query()).toBeNull();
  });

  test("a save that stores neither says so, and leaves both as they were", async () => {
    writeOwnRelaySetting({ turn: [TURN_URL], stun: [] });
    await mountScreen();
    const refused = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota exceeded");
      });
    try {
      await userEvent.fill(allowedField(), "relay.example.org");
      await userEvent.fill(turnField(), "turn:backup.example.org:3478");
      await userEvent.click(saveButton());
    } finally {
      refused.mockRestore();
    }

    await expect.element(statusLine()).toHaveTextContent(NOTHING_SAVED);
    expect(NOTHING_SAVED).toBe(
      "This browser did not save the relay server addresses or the allowed " +
        "relays. Check that site storage is allowed for this site, then " +
        "save again.",
    );
    expect(readRelayRestriction()).toEqual({ kind: "set", restriction: {} });
    expect(readOwnRelaySetting()).toEqual({
      kind: "set",
      relay: { turn: [TURN_URL], stun: [] },
    });
  });

  test("a stored value this build cannot read is reported until it is saved again", async () => {
    window.localStorage.setItem(
      "alcove-relay-restriction",
      JSON.stringify({ version: 1, allowedRelays: ["Not Normal"] }),
    );
    await mountScreen();

    const notice = () =>
      page.getByText("The saved allowed relays could not be read");
    await expect.element(notice()).toBeVisible();
    await expect
      .element(
        page.getByText(
          "Every exchange in this browser is refused until the relay " +
            "settings are saved again. Enter your allowed relays and save.",
        ),
      )
      .toBeVisible();

    await userEvent.fill(allowedField(), "relay.example.org");
    await userEvent.click(saveButton());

    await expect.element(notice()).not.toBeInTheDocument();
    expect(readRelayRestriction()).toEqual({
      kind: "set",
      restriction: { allowedRelays: ["relay.example.org"] },
    });

    await userEvent.fill(allowedField(), "backup.example.org");
    await expect.poll(() => statusLine().element().textContent).toBe("");
    expect(notice().query()).toBeNull();
  });

  test("removing the relay while the stored value cannot be read says every exchange is still refused", async () => {
    window.localStorage.setItem(
      "alcove-relay-restriction",
      JSON.stringify({ version: 1, allowedRelays: ["Not Normal"] }),
    );
    await mountScreen();

    await userEvent.click(removeButton());

    await expect
      .element(page.getByText(REMOVED_RESTRICTION_UNREADABLE))
      .toBeVisible();
    expect(REMOVED_RESTRICTION_UNREADABLE).toBe(
      "The relay was removed. Every exchange in this browser is still " +
        "refused because the saved allowed relays could not be read. Save " +
        "the relay settings to replace them.",
    );
    expect(document.body.textContent).not.toContain("Saved.");
    await expect
      .element(
        page.getByText("The saved allowed relays could not be read", {
          exact: true,
        }),
      )
      .toBeVisible();
    expect(readOwnRelaySetting()).toEqual({ kind: "none" });
    expect(readRelayRestriction().kind).toBe("unreadable");
  });
});

describe("RelaySettingsScreen: the relays a run may use on each build", () => {
  test("the hosted build shows Allowed relays", async () => {
    await mountScreen();

    await expect
      .element(page.getByRole("textbox", { name: "Allowed relays" }))
      .toBeVisible();
    expect(page.getByText(CONSOLE_RELAY_RESTRICTION_LINE).query()).toBeNull();
    expect(document.body.textContent).toContain(
      "unless your allowed relays below leave it out",
    );
  });

  test("the console build withholds them, names the configuration keys that decide, and saves the relay alone", async () => {
    build.console = true;
    window.localStorage.setItem(
      "alcove-relay-restriction",
      JSON.stringify({ version: 1, allowedRelays: ["Not Normal"] }),
    );
    await mountScreen();

    await expect
      .element(page.getByText(CONSOLE_RELAY_RESTRICTION_LINE))
      .toBeVisible();
    expect(CONSOLE_RELAY_RESTRICTION_LINE).toBe(
      "Exchanges run from this console follow the command-line " +
        "configuration: its connection.allowed_relays key decides which " +
        "relays an exchange may use.",
    );
    expect(
      page.getByRole("textbox", { name: "Allowed relays" }).query(),
    ).toBeNull();
    expect(page.getByText(ALLOWED_RELAYS_SCOPE).query()).toBeNull();
    expect(
      page.getByText("The saved allowed relays could not be read").query(),
    ).toBeNull();
    expect(document.body.textContent).not.toContain("allowed relays below");
    await expect.element(turnField()).toBeVisible();
    await expect
      .element(page.getByText(RELAY_OPERATOR_DISCLOSURE))
      .toBeVisible();

    await userEvent.fill(turnField(), TURN_URL);
    await userEvent.click(saveButton());

    await expect
      .element(statusLine())
      .toHaveTextContent(
        "Saved. Exchanges started from now on use this relay.",
      );
    expect(readOwnRelaySetting()).toEqual({
      kind: "set",
      relay: { turn: [TURN_URL], stun: [] },
    });
    expect(window.localStorage.getItem("alcove-relay-restriction")).toBe(
      JSON.stringify({ version: 1, allowedRelays: ["Not Normal"] }),
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
