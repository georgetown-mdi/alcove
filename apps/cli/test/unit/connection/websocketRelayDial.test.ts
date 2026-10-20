import { describe, expect, test } from "vitest";

import {
  UsageError,
  deriveRelayExchangeId,
  deriveRelayKey,
} from "@alcove/core";

import {
  webSocketRelayDialsFor,
  websocketRelayNeedsSecretMessage,
} from "../../../src/connection/webrtc/websocketRelayDial";

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
        "one with 'alcove invite' and 'alcove accept'.",
    );
  });

  test("the refusal names the one relay a run lists, and no edit that leaves it out", () => {
    const refusalFor = (url: string) =>
      `the WebSocket relay at ${url} takes a proof made from the exchange's ` +
      "shared secret, and this run holds none. Establish one with 'alcove " +
      "invite' and 'alcove accept'.";
    expect(websocketRelayNeedsSecretMessage({ websocketRelay: OWN })).toBe(
      refusalFor(OWN),
    );
    expect(
      websocketRelayNeedsSecretMessage({
        websocketRelay: OWN,
        invitationRelay: { websocket: PARTNER },
        allowedRelays: ["own.example.org"],
      }),
    ).toBe(refusalFor(OWN));
    expect(
      websocketRelayNeedsSecretMessage({
        websocketRelay: PARTNER,
        invitationRelay: { websocket: PARTNER },
      }),
    ).toBe(refusalFor(PARTNER));
  });
});
