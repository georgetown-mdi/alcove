import { selectRunRelay } from "@alcove/core";
import { expect, test } from "vitest";

import {
  ALLOWED_RELAYS_SCOPE,
  allowedRelaysRunNotice,
} from "../../src/allowedRelays";

const OWN = "turns:own.example.org:443?transport=tcp";
const INVITATION = "turn:partner.example.net\u001b[31m";

test("a run's line names the relays it keeps and the ones it leaves out, an invitation's escaped, then what the setting governs", () => {
  expect(
    allowedRelaysRunNotice(
      selectRunRelay({
        turn: [{ url: OWN }],
        invitationRelay: { turn: [INVITATION] },
        allowedRelays: ["own.example.org"],
      }),
    ),
  ).toBe(
    `connection.allowed_relays keeps ${OWN} and leaves out ` +
      "turn:partner.example.net\\x1b[31m for this run. " +
      ALLOWED_RELAYS_SCOPE,
  );
});

test("a run's line names the WebSocket relay urls it keeps and leaves out after the TURN urls, an invitation's escaped", () => {
  expect(
    allowedRelaysRunNotice(
      selectRunRelay({
        turn: [{ url: OWN }],
        websocketRelay: "wss://own.example.org/relay",
        invitationRelay: { websocket: "wss://partner.example.net/r\u001b" },
        allowedRelays: ["own.example.org"],
      }),
    ),
  ).toBe(
    `connection.allowed_relays keeps ${OWN}, wss://own.example.org/relay ` +
      "and leaves out wss://partner.example.net/r\\x1b for this run. " +
      ALLOWED_RELAYS_SCOPE,
  );
});

test("what the setting governs names the key its own relay_registrar still receives", () => {
  expect(ALLOWED_RELAYS_SCOPE).toContain(
    "your own connection.relay_registrar, where set, still receives each " +
      "rotated relay key",
  );
});

test("a run's line says so when the setting keeps no relay, or leaves out none", () => {
  expect(
    allowedRelaysRunNotice(
      selectRunRelay({ turn: [{ url: OWN }], allowedRelays: [] }),
    ),
  ).toBe(
    `connection.allowed_relays keeps no relay url and leaves out ${OWN} for ` +
      `this run. ${ALLOWED_RELAYS_SCOPE}`,
  );
  expect(
    allowedRelaysRunNotice(
      selectRunRelay({
        turn: [{ url: OWN }],
        allowedRelays: ["own.example.org"],
      }),
    ),
  ).toBe(
    `connection.allowed_relays keeps ${OWN} and leaves out none for this ` +
      `run. ${ALLOWED_RELAYS_SCOPE}`,
  );
});
