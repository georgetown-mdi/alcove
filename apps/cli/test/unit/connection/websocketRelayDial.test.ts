import { describe, expect, test } from "vitest";

import {
  UsageError,
  deriveRelayExchangeId,
  deriveRelayKey,
  getDefaultLinkageTerms,
  parseExchangeSpec,
  snakeizeKeys,
} from "@alcove/core";

import {
  webSocketRelayDialsFor,
  websocketRelayNeedsSecretMessage,
} from "../../../src/connection/webrtc/websocketRelayDial";

import type { RunRelayConnection } from "@alcove/core";

// The WebSocket relays a CLI run lists, each with the exchange id its proof is
// made under: the connection's own relay_registrar id or the invitation's id
// where one is named, else the id derived from the secret.

const SECRET = Buffer.from(
  Array.from({ length: 32 }, (_, index) => index),
).toString("base64url");

const OWN = "wss://own.example.org/relay";
const PARTNER = "wss://partner.example.net/relay";

const RELAY_REGISTRAR = {
  url: "https://registrar.own.example.org",
  exchangeId: "own-weekly",
};

describe("webSocketRelayDialsFor", () => {
  test("lists the connection's own relay, then the invitation's, each with its exchange id", async () => {
    const relayKey = await deriveRelayKey(SECRET);
    expect(
      await webSocketRelayDialsFor(
        {
          websocketRelay: OWN,
          relayRegistrar: RELAY_REGISTRAR,
          invitationRelay: {
            websocket: PARTNER,
            websocketExchangeId: "partner-weekly",
          },
        },
        SECRET,
        "acceptor",
      ),
    ).toEqual([
      { url: OWN, exchangeId: "own-weekly", relayKey, role: "acceptor" },
      {
        url: PARTNER,
        exchangeId: "partner-weekly",
        relayKey,
        role: "acceptor",
      },
    ]);
  });

  test("a relay with no exchange id named is proven under the id derived from the secret", async () => {
    const derived = await deriveRelayExchangeId(SECRET);
    const dials = await webSocketRelayDialsFor(
      { websocketRelay: OWN, invitationRelay: { websocket: PARTNER } },
      SECRET,
      "inviter",
    );
    expect(dials.map((dial) => [dial.url, dial.exchangeId])).toEqual([
      [OWN, derived],
      [PARTNER, derived],
    ]);
  });

  test("a url both sides name is dialed once, under the invitation's exchange id", async () => {
    const dials = await webSocketRelayDialsFor(
      {
        websocketRelay: PARTNER,
        relayRegistrar: RELAY_REGISTRAR,
        invitationRelay: {
          websocket: PARTNER,
          websocketExchangeId: "partner-weekly",
        },
      },
      SECRET,
      "acceptor",
    );
    expect(dials.map((dial) => [dial.url, dial.exchangeId])).toEqual([
      [PARTNER, "partner-weekly"],
    ]);
  });

  test("lists only the relays allowed_relays keeps", async () => {
    const dials = await webSocketRelayDialsFor(
      {
        websocketRelay: OWN,
        invitationRelay: { websocket: PARTNER },
        allowedRelays: ["partner.example.net"],
      },
      SECRET,
      "acceptor",
    );
    expect(dials.map((dial) => dial.url)).toEqual([PARTNER]);
  });

  test("a run listing no relay dials none, secret or not", async () => {
    expect(await webSocketRelayDialsFor({}, undefined, "inviter")).toEqual([]);
    expect(
      await webSocketRelayDialsFor(
        { websocketRelay: OWN, allowedRelays: [] },
        undefined,
        "inviter",
      ),
    ).toEqual([]);
  });

  test("a run with no shared secret refuses every relay it lists, naming each", async () => {
    const both = {
      websocketRelay: OWN,
      invitationRelay: { websocket: PARTNER },
    };
    const refused = webSocketRelayDialsFor(both, undefined, "inviter");
    await expect(refused).rejects.toBeInstanceOf(UsageError);
    await expect(refused).rejects.toThrow(
      websocketRelayNeedsSecretMessage(both),
    );
    expect(websocketRelayNeedsSecretMessage(both)).toBe(
      `the WebSocket relays at ${OWN} and ${PARTNER} take a proof made from ` +
        "the exchange's shared secret, and this run holds none. Establish " +
        "one with 'alcove invite' and 'alcove accept', or set " +
        "connection.allowed_relays to leave them out.",
    );
  });

  test("the refusal names removing websocket_relay only where that leaves no relay listed", () => {
    const ownOnly = `the WebSocket relay at ${OWN} takes a proof made from the exchange's shared secret, and this run holds none. Establish one with 'alcove invite' and 'alcove accept', or remove connection.websocket_relay.`;
    expect(websocketRelayNeedsSecretMessage({ websocketRelay: OWN })).toBe(
      ownOnly,
    );
    expect(
      websocketRelayNeedsSecretMessage({
        websocketRelay: OWN,
        invitationRelay: { websocket: PARTNER },
        allowedRelays: ["own.example.org"],
      }),
    ).toBe(ownOnly);
    expect(
      websocketRelayNeedsSecretMessage({
        websocketRelay: PARTNER,
        invitationRelay: { websocket: PARTNER },
      }),
    ).toBe(
      `the WebSocket relay at ${PARTNER} takes a proof made from the ` +
        "exchange's shared secret, and this run holds none. Establish one " +
        "with 'alcove invite' and 'alcove accept', or set " +
        "connection.allowed_relays to leave it out.",
    );
  });

  const BASE = {
    channel: "webrtc",
    role: "acceptor",
    server: { host: "peer.example.org" },
    turn: [{ url: "turns:own-turn.example.org:443?transport=tcp" }],
  };

  // An invitation_relay naming no TURN url, so removing its `websocket`
  // alone would leave an exchange id and a registrar the schema refuses.
  const ACCEPTED = {
    ...BASE,
    websocket_relay: OWN,
    invitation_relay: {
      websocket: PARTNER,
      websocket_exchange_id: "partner-weekly",
      registrar: "https://registrar.partner.example.net",
    },
  };

  function loadedConnection(
    connection: Record<string, unknown>,
  ): RunRelayConnection {
    const spec = parseExchangeSpec({
      connection,
      linkage_terms: snakeizeKeys(getDefaultLinkageTerms("Agency A")),
    });
    if (spec.connection?.channel !== "webrtc")
      throw new Error("expected a webrtc connection");
    return spec.connection;
  }

  test("following the refusal's edit loads, and the run then lists no relay", async () => {
    const refusal = websocketRelayNeedsSecretMessage(
      loadedConnection(ACCEPTED),
    );
    expect(refusal).toContain(
      "set connection.allowed_relays to leave them out.",
    );
    const { registrar } = ACCEPTED.invitation_relay;
    expect(() =>
      loadedConnection({
        ...ACCEPTED,
        invitation_relay: {
          websocket_exchange_id: "partner-weekly",
          registrar,
        },
      }),
    ).toThrow(/requires a websocket url/);
    expect(() =>
      loadedConnection({ ...ACCEPTED, invitation_relay: { registrar } }),
    ).toThrow(/requires a turn or websocket url/);
    const edited = loadedConnection({
      ...ACCEPTED,
      allowed_relays: ["own-turn.example.org:443"],
    });
    expect(await webSocketRelayDialsFor(edited, undefined, "acceptor")).toEqual(
      [],
    );
  });

  test("following the refusal's edit for the own relay alone loads, and the run then lists no relay", async () => {
    expect(
      websocketRelayNeedsSecretMessage(
        loadedConnection({ ...BASE, websocket_relay: OWN }),
      ),
    ).toMatch(/or remove connection\.websocket_relay\.$/);
    expect(
      await webSocketRelayDialsFor(
        loadedConnection(BASE),
        undefined,
        "acceptor",
      ),
    ).toEqual([]);
  });
});
