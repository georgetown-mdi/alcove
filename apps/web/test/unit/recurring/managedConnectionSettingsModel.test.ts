import { describe, expect, test } from "vitest";
import { getDefaultLinkageTerms } from "@alcove/core";

import {
  connectionSettingsEdits,
  connectionSettingsTextFrom,
  signalingServerText,
} from "@recurring/managedConnectionSettingsModel";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";

import type { WebRTCExchangeLocator } from "@alcove/core";

const OWN_TURN = "turns:relay.example.org:443?transport=tcp";

function stored(locator: Partial<WebRTCExchangeLocator> = {}) {
  return {
    exchangeFile: composeManagedExchangeFile({
      connection: {
        channel: "webrtc",
        host: "signaling.example.org",
        port: 443,
        path: "/api/",
        ...locator,
      },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
  };
}

describe("the coordination server field", () => {
  test("shows the saved server by the page's scheme, leaving out the default port", () => {
    expect(signalingServerText(stored(), "https:")).toBe(
      "wss://signaling.example.org/api/",
    );
    expect(signalingServerText(stored({ port: 9999 }), "https:")).toBe(
      "wss://signaling.example.org:9999/api/",
    );
    expect(signalingServerText(stored({ port: 80 }), "http:")).toBe(
      "ws://signaling.example.org/api/",
    );
  });
});

describe("connectionSettingsEdits", () => {
  const https = "https:";

  function text(
    overrides: Partial<Parameters<typeof connectionSettingsEdits>[0]> = {},
  ) {
    return {
      ...connectionSettingsTextFrom(stored(), https),
      ...overrides,
    };
  }
  const saved = signalingServerText(stored(), https);

  test("an untouched form edits no server, drops no relay it does not hold, and leaves the switch off", () => {
    expect(connectionSettingsEdits(text(), saved, https)).toEqual({
      ok: true,
      edits: { ownRelay: null, defaultRelayOn: false },
    });
  });

  test("a changed server is read into a host, port and path", () => {
    expect(
      connectionSettingsEdits(
        text({ server: "wss://coordination.agency.example/signal/" }),
        saved,
        https,
      ),
    ).toEqual({
      ok: true,
      edits: {
        signalingServer: {
          host: "coordination.agency.example",
          port: 443,
          path: "/signal/",
        },
        ownRelay: null,
        defaultRelayOn: false,
      },
    });
  });

  test.each([
    ["is blank", "", "starting with wss://"],
    ["is a web page's address", "https://app.example.org/", "web page"],
    ["uses the other scheme", "ws://signaling.example.org/api/", "wss://"],
  ])("a server that %s is refused", (_case, server, message) => {
    const read = connectionSettingsEdits(text({ server }), saved, https);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.errors.server).toContain(message);
  });

  test("relay urls become the exchange's own relay, and the switch is kept as set", () => {
    expect(
      connectionSettingsEdits(
        text({
          turn: `${OWN_TURN}\n\n`,
          stun: "stun:stun.example.org:3478",
          websocket: "wss://wsrelay.example.org/relay",
          defaultRelayOn: true,
        }),
        saved,
        https,
      ),
    ).toEqual({
      ok: true,
      edits: {
        ownRelay: {
          turn: [OWN_TURN],
          stun: ["stun:stun.example.org:3478"],
          websocket: "wss://wsrelay.example.org/relay",
        },
        defaultRelayOn: true,
      },
    });
  });

  test("a refused url is named by its field and line", () => {
    const read = connectionSettingsEdits(
      text({ turn: `${OWN_TURN}\nturn:`, websocket: "ftp://relay" }),
      saved,
      https,
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.errors.turn).toMatch(/^Line 2: /);
    expect(read.errors.websocket).toBeDefined();
    expect(read.errors.server).toBeUndefined();
  });

  test("the fields start from what the record holds", () => {
    expect(
      connectionSettingsTextFrom(
        {
          ...stored(),
          ownRelay: { turn: [OWN_TURN, OWN_TURN], stun: [] },
          defaultRelayOn: true,
        },
        https,
      ),
    ).toEqual({
      server: saved,
      turn: `${OWN_TURN}\n${OWN_TURN}`,
      stun: "",
      websocket: "",
      defaultRelayOn: true,
    });
  });
});
