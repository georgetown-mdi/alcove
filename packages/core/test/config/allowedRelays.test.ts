import { describe, expect, test } from "vitest";

import {
  normalizeAllowedRelay,
  parseConnectionConfig,
  turnUrlIsAllowed,
  turnUrlRelay,
  webSocketRelayUrlIsAllowed,
  webSocketRelayUrlRelay,
} from "../../src/config/connection";
import {
  allowedRelaysLeaveOutInvitationRelay,
  runEnrollsAtInvitationRegistrar,
  selectRunRelay,
} from "../../src/relayCredential";

const SERVER = { host: "signal.example" };

describe("an allowed_relays entry", () => {
  test.each([
    ["relay.example.org", "relay.example.org"],
    [" Relay.Example.ORG. ", "relay.example.org"],
    ["relay.example.org:443", "relay.example.org:443"],
    ["192.0.2.7:3478", "192.0.2.7:3478"],
    ["[2001:DB8::1]", "[2001:db8::1]"],
    ["[2001:db8::1]:5349", "[2001:db8::1]:5349"],
  ])("%j is held as %j", (entry, held) => {
    expect(
      parseConnectionConfig({
        channel: "webrtc",
        server: SERVER,
        allowed_relays: [entry],
      }),
    ).toMatchObject({ allowedRelays: [held] });
  });

  test.each([
    "turns:relay.example.org:443",
    "relay.example.org:0",
    "relay.example.org:65536",
    "relay.example.org/path",
    "user@relay.example.org",
    "2001:db8::1",
    "",
  ])("%j is refused, naming the form", (entry) => {
    expect(() =>
      parseConnectionConfig({
        channel: "webrtc",
        server: SERVER,
        allowed_relays: [entry],
      }),
    ).toThrow(/each allowed_relays entry must be a host and an optional port/);
  });

  test("normalizing is idempotent for a host with trailing dots", () => {
    const normalized = normalizeAllowedRelay("a..");
    expect(normalized).toBe("a");
    expect(normalizeAllowedRelay(normalized ?? "")).toBe(normalized);
  });
});

describe("matching a TURN url against allowed_relays", () => {
  test("a url names its host and its port, the scheme's default where it names none", () => {
    expect(turnUrlRelay("turn:relay.example.org")).toEqual({
      host: "relay.example.org",
      port: 3478,
    });
    expect(turnUrlRelay("turns:Relay.example.org?transport=tcp")).toEqual({
      host: "relay.example.org",
      port: 5349,
    });
    expect(turnUrlRelay("turn:[2001:db8::1]:3479?transport=udp")).toEqual({
      host: "[2001:db8::1]",
      port: 3479,
    });
  });

  test("a host entry matches the turn: and turns: forms and every transport of that host", () => {
    for (const url of [
      "turn:relay.example.org",
      "turn:relay.example.org:3478?transport=udp",
      "turn:RELAY.example.org:443?transport=tcp",
      "turns:relay.example.org:443?transport=tcp",
    ])
      expect(turnUrlIsAllowed(url, ["relay.example.org"])).toBe(true);
    expect(
      turnUrlIsAllowed("turn:other.example.org", ["relay.example.org"]),
    ).toBe(false);
    expect(
      turnUrlIsAllowed("turn:sub.relay.example.org", ["relay.example.org"]),
    ).toBe(false);
  });

  test("an entry with a port matches that port alone, a url's default port included", () => {
    const allowed = ["relay.example.org:443"];
    expect(
      turnUrlIsAllowed("turns:relay.example.org:443?transport=tcp", allowed),
    ).toBe(true);
    expect(
      turnUrlIsAllowed("turn:relay.example.org:443?transport=tcp", allowed),
    ).toBe(true);
    expect(turnUrlIsAllowed("turns:relay.example.org", allowed)).toBe(false);
    expect(
      turnUrlIsAllowed("turn:relay.example.org", ["relay.example.org:3478"]),
    ).toBe(true);
  });

  test("unset allows every url, and an empty list none", () => {
    expect(turnUrlIsAllowed("turn:relay.example.org", undefined)).toBe(true);
    expect(turnUrlIsAllowed("turn:relay.example.org", [])).toBe(false);
  });
});

describe("the relays a run lists under allowed_relays", () => {
  const own = { url: "turns:own.example.org:443?transport=tcp" };
  const invitationRelay = {
    turn: ["turns:partner.example.net:443?transport=tcp"],
    registrar: "https://partner.example.net",
  };

  test("unset: every relay is listed and none left out, as without the setting", () => {
    const selection = selectRunRelay({ turn: [own], invitationRelay });
    expect(selection.turn?.map((server) => server.url)).toEqual([
      own.url,
      invitationRelay.turn[0],
    ]);
    expect(selection).not.toHaveProperty("turnLeftOut");
  });

  test("set: the run allocates on the first listed relay and leaves out the rest, in order", () => {
    const selection = selectRunRelay({
      turn: [own],
      invitationRelay,
      allowedRelays: ["partner.example.net"],
    });
    expect(selection.turn).toEqual([
      { source: "invitation", url: invitationRelay.turn[0] },
    ]);
    expect(selection.turnLeftOut).toEqual([{ source: "own", url: own.url }]);
  });

  test("the setting decides enrollment at the invitation's registrar through the relay it keeps", () => {
    expect(
      runEnrollsAtInvitationRegistrar({ turn: [own], invitationRelay }),
    ).toBe(false);
    expect(
      runEnrollsAtInvitationRegistrar({
        turn: [own],
        invitationRelay,
        allowedRelays: ["partner.example.net"],
      }),
    ).toBe(true);
    const leftOut = { invitationRelay, allowedRelays: ["own.example.org"] };
    expect(runEnrollsAtInvitationRegistrar(leftOut)).toBe(false);
    expect(allowedRelaysLeaveOutInvitationRelay(leftOut)).toBe(true);
    expect(allowedRelaysLeaveOutInvitationRelay({ invitationRelay })).toBe(
      false,
    );
  });

  test("a setting naming no listed relay leaves an empty list", () => {
    const selection = selectRunRelay({
      turn: [own],
      invitationRelay,
      allowedRelays: ["elsewhere.example.com"],
    });
    expect(selection.turn).toEqual([]);
    expect(selection.turnLeftOut).toHaveLength(2);
  });
});

describe("matching a WebSocket relay url against allowed_relays", () => {
  test("a url names its host and its port, 443 where it names none", () => {
    expect(webSocketRelayUrlRelay("wss://wsrelay.example.org/relay")).toEqual({
      host: "wsrelay.example.org",
      port: 443,
    });
    expect(webSocketRelayUrlRelay("wss://WSRelay.example.org/relay")).toBe(
      undefined,
    );
    expect(
      webSocketRelayUrlRelay("wss://evil.example\\@wsrelay.example.org/relay"),
    ).toBe(undefined);
    expect(webSocketRelayUrlRelay("wss://wsrelay.example.org./relay")).toEqual({
      host: "wsrelay.example.org",
      port: 443,
    });
    expect(webSocketRelayUrlRelay("wss://[2001:db8::1]:8443/relay")).toEqual({
      host: "[2001:db8::1]",
      port: 8443,
    });
    expect(webSocketRelayUrlRelay("ws://wsrelay.example.org/relay")).toBe(
      undefined,
    );
  });

  test("an entry matches the url's host, and its port where it names one", () => {
    const url = "wss://wsrelay.example.org/relay";
    expect(webSocketRelayUrlIsAllowed(url, ["wsrelay.example.org"])).toBe(true);
    expect(webSocketRelayUrlIsAllowed(url, ["wsrelay.example.org:443"])).toBe(
      true,
    );
    expect(webSocketRelayUrlIsAllowed(url, ["wsrelay.example.org:8443"])).toBe(
      false,
    );
    expect(webSocketRelayUrlIsAllowed(url, ["example.org"])).toBe(false);
    expect(
      webSocketRelayUrlIsAllowed("wss://wsrelay.example.org:8443/relay", [
        "wsrelay.example.org:8443",
      ]),
    ).toBe(true);
  });

  test("unset allows every url, and an empty list none", () => {
    const url = "wss://wsrelay.example.org/relay";
    expect(webSocketRelayUrlIsAllowed(url, undefined)).toBe(true);
    expect(webSocketRelayUrlIsAllowed(url, [])).toBe(false);
  });
});

describe("the WebSocket relays a run lists", () => {
  const own = "wss://own.example.org/relay";
  const partner = "wss://partner.example.net/relay";

  test("the connection's own is listed before the invitation's", () => {
    const selection = selectRunRelay({
      websocketRelay: own,
      invitationRelay: { websocket: partner },
    });
    expect(selection.websocket).toEqual([
      { source: "own", url: own },
      { source: "invitation", url: partner },
    ]);
    expect(selection).not.toHaveProperty("websocketLeftOut");
  });

  test("a url both sides name is listed once, as the connection's own", () => {
    expect(
      selectRunRelay({
        websocketRelay: own,
        invitationRelay: { websocket: own },
      }).websocket,
    ).toEqual([{ source: "own", url: own }]);
  });

  test("neither side naming one lists none", () => {
    const selection = selectRunRelay({ invitationRelay: { stun: ["stun:s"] } });
    expect(selection).not.toHaveProperty("websocket");
    expect(selection).not.toHaveProperty("websocketLeftOut");
  });

  test("allowed_relays leaves out every url no entry names, in order", () => {
    const selection = selectRunRelay({
      websocketRelay: own,
      invitationRelay: { websocket: partner },
      allowedRelays: ["partner.example.net"],
    });
    expect(selection.websocket).toEqual([
      { source: "invitation", url: partner },
    ]);
    expect(selection.websocketLeftOut).toEqual([{ source: "own", url: own }]);
  });

  const relayRegistrar = {
    url: "https://registrar.own.example.org",
    exchangeId: "own-weekly",
  };

  test("each relay names the exchange id the connection or the invitation names for it", () => {
    expect(
      selectRunRelay({
        websocketRelay: own,
        relayRegistrar,
        invitationRelay: {
          websocket: partner,
          websocketExchangeId: "partner-weekly",
        },
      }).websocket,
    ).toEqual([
      { source: "own", url: own, exchangeId: "own-weekly" },
      { source: "invitation", url: partner, exchangeId: "partner-weekly" },
    ]);
    expect(
      selectRunRelay({
        websocketRelay: own,
        invitationRelay: { websocket: partner },
      }).websocket,
    ).toEqual([
      { source: "own", url: own },
      { source: "invitation", url: partner },
    ]);
  });

  test("a url both sides name takes the invitation's exchange id, or none, by the url", () => {
    expect(
      selectRunRelay({
        websocketRelay: own,
        relayRegistrar,
        invitationRelay: { websocket: own, websocketExchangeId: "partner-id" },
      }).websocket,
    ).toEqual([{ source: "own", url: own, exchangeId: "partner-id" }]);
    expect(
      selectRunRelay({
        websocketRelay: own,
        relayRegistrar,
        invitationRelay: { websocket: own },
      }).websocket,
    ).toEqual([{ source: "own", url: own }]);
  });

  test("a run enrolls at the invitation's registrar when it lists the invitation's WebSocket relay", () => {
    const invitationRelay = {
      websocket: partner,
      registrar: "https://registrar.partner.example.net",
    };
    expect(runEnrollsAtInvitationRegistrar({ invitationRelay })).toBe(true);
    expect(
      runEnrollsAtInvitationRegistrar({
        websocketRelay: partner,
        invitationRelay,
        allowedRelays: ["partner.example.net"],
      }),
    ).toBe(true);
    const leftOut = { invitationRelay, allowedRelays: ["own.example.org"] };
    expect(runEnrollsAtInvitationRegistrar(leftOut)).toBe(false);
    expect(allowedRelaysLeaveOutInvitationRelay(leftOut)).toBe(true);
    expect(allowedRelaysLeaveOutInvitationRelay({ invitationRelay })).toBe(
      false,
    );
    expect(
      runEnrollsAtInvitationRegistrar({
        invitationRelay: { websocket: partner },
      }),
    ).toBe(false);
  });

  test("a kept WebSocket relay of the invitation's enrolls where the setting leaves out its TURN url", () => {
    const connection = {
      turn: [{ url: "turns:own.example.org:443?transport=tcp" }],
      invitationRelay: {
        turn: ["turns:partner-turn.example.net:443?transport=tcp"],
        websocket: partner,
        registrar: "https://registrar.partner.example.net",
      },
      allowedRelays: ["own.example.org", "partner.example.net"],
    };
    expect(runEnrollsAtInvitationRegistrar(connection)).toBe(true);
    expect(allowedRelaysLeaveOutInvitationRelay(connection)).toBe(false);
  });
});
