import { describe, expect, test, vi } from "vitest";

import { generateSharedSecret } from "@alcove/core";

import {
  ALLOWED_RELAYS_REMEDY,
  allowedRelaysRunNotice,
  parseExchangeAllowedRelayLines,
} from "@psi/transport/relayRestriction";
import {
  DEFAULT_RELAY_NOT_ENROLLED_NOTICE,
  invitationRelayWithDefault,
  relayWithDefaultForRun,
} from "@psi/transport/defaultRelay";
import { relayForRun } from "@psi/transport/ownRelaySetting";
import { relayPlanForRun } from "@psi/transport/runRelayPlan";

import type { OwnRelayRead } from "@psi/transport/ownRelaySetting";

const OWN_URL = "turns:own.example.org:443?transport=tcp";
const PARTNER_URL = "turn:partner.example.net:3478?transport=udp";
const SITE = {
  turnUrl: "turns:site.example.com:443?transport=tcp",
  registrarUrl: "https://registrar.site.example.com",
};

const readOwn = (): OwnRelayRead => ({
  kind: "set",
  relay: { turn: [OWN_URL], stun: ["stun:own.example.org:3478"] },
});

describe("parseExchangeAllowedRelayLines", () => {
  test("normalizes each entry as core's allowed_relays does, once each", () => {
    expect(
      parseExchangeAllowedRelayLines(
        " Relay.Example.ORG. \n\nrelay.example.org\n[2001:DB8::1]:3478\n",
      ),
    ).toEqual({
      ok: true,
      entries: ["relay.example.org", "[2001:db8::1]:3478"],
    });
  });

  test("blank text leaves the setting unset", () => {
    expect(parseExchangeAllowedRelayLines(" \n")).toEqual({ ok: true });
  });

  test("names each refused line and the form", () => {
    const parsed = parseExchangeAllowedRelayLines(
      "relay.example.org\nturns:relay.example.org:443\nrelay.example.org:0",
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems.map((problem) => problem.line)).toEqual([2, 3]);
    expect(parsed.problems[0]?.message).toMatch(
      /^enter a host and an optional port .*with no turn: or turns: scheme$/,
    );
  });

  test("bounds neither how many entries nor how long one is, as core does not", () => {
    const hosts = Array.from(
      { length: 20 },
      (_unused, index) => `relay-${String(index)}.example.org`,
    );
    const long = `${"a".repeat(2000)}.example.org`;
    expect(parseExchangeAllowedRelayLines([...hosts, long].join("\n"))).toEqual(
      { ok: true, entries: [...hosts, long] },
    );
  });
});

describe("the remedy for a run that left relays out", () => {
  test("names where an exchange's own list is set, and no browser-wide page", () => {
    expect(ALLOWED_RELAYS_REMEDY).toBe(
      "To let a run try a relay left out, add its host to the exchange's " +
        "Allowed relays, or remove them. A saved exchange sets them on its " +
        "own page; any other exchange sets them on its review, before the " +
        "invitation is created or accepted.",
    );
    expect(ALLOWED_RELAYS_REMEDY).not.toContain("Relay server page");
  });
});

describe("the relays a browser run lists under its allowed relays", () => {
  test("own and invitation TURN urls an entry names are kept, and STUN urls untouched", () => {
    expect(
      relayForRun({ turn: [PARTNER_URL] }, ["partner.example.net"], readOwn),
    ).toEqual({
      turn: [PARTNER_URL],
      stun: ["stun:own.example.org:3478"],
    });
    expect(relayForRun({ turn: [PARTNER_URL] }, undefined, readOwn)).toEqual({
      turn: [OWN_URL, PARTNER_URL],
      stun: ["stun:own.example.org:3478"],
    });
  });

  test("an invitation it creates names the default relay only where it is kept", () => {
    const own = { turn: [OWN_URL], stun: [] };
    expect(invitationRelayWithDefault(own, SITE, ["own.example.org"])).toBe(
      own,
    );
    expect(
      invitationRelayWithDefault(own, SITE, ["site.example.com:443"]),
    ).toEqual({
      turn: [OWN_URL, SITE.turnUrl],
      stun: [],
      registrar: SITE.registrarUrl,
    });
  });

  test("a default relay left out is neither enrolled at nor listed", async () => {
    const enroll = vi.fn();
    const relay = { turn: [OWN_URL], stun: [] };
    const run = await relayWithDefaultForRun(
      generateSharedSecret(),
      relay,
      ["own.example.org"],
      { setting: () => SITE, enroll },
    );
    expect(run.relay).toBe(relay);
    expect(run).not.toHaveProperty("defaultWebSocketRelay");
    expect(enroll).not.toHaveBeenCalled();
  });
});

describe("relayPlanForRun", () => {
  test("keeps the relays named and says which it kept and left out", async () => {
    const onRunNotice = vi.fn();
    const plan = await relayPlanForRun(
      generateSharedSecret(),
      { turn: [PARTNER_URL] },
      ["own.example.org", "site.example.com:443"],
      {
        readOwn,
        setting: () => SITE,
        enroll: vi.fn(() =>
          Promise.resolve({ kind: "enrolled" as const, lapsesAt: "x" }),
        ),
        onRunNotice,
      },
    );
    expect(plan).toEqual({
      relay: {
        turn: [OWN_URL, SITE.turnUrl],
        stun: ["stun:own.example.org:3478"],
      },
      relaysLeftOut: [PARTNER_URL],
      websocketRelays: [],
    });
    expect(onRunNotice).toHaveBeenCalledExactlyOnceWith(
      allowedRelaysRunNotice([OWN_URL, SITE.turnUrl], [PARTNER_URL]),
    );
    expect(onRunNotice.mock.calls[0]?.[0]).toBe(
      `Your allowed relays keep ${OWN_URL}, ${SITE.turnUrl} and leave out ` +
        `${PARTNER_URL} for this run.`,
    );
  });

  test("unset, lists every relay with no notice", async () => {
    const onRunNotice = vi.fn();
    const plan = await relayPlanForRun(
      generateSharedSecret(),
      { turn: [PARTNER_URL] },
      undefined,
      { readOwn, setting: () => undefined, onRunNotice },
    );
    expect(plan).toEqual({
      relay: {
        turn: [OWN_URL, PARTNER_URL],
        stun: ["stun:own.example.org:3478"],
      },
      relaysLeftOut: [],
      websocketRelays: [],
    });
    expect(onRunNotice).not.toHaveBeenCalled();
  });

  test("a run whose every TURN url is left out continues without one", async () => {
    const plan = await relayPlanForRun(
      generateSharedSecret(),
      undefined,
      ["other.example"],
      { readOwn, setting: () => undefined },
    );
    expect(plan.relay).toEqual({
      turn: [],
      stun: ["stun:own.example.org:3478"],
    });
    expect(plan.relaysLeftOut).toEqual([OWN_URL]);
  });

  test("a failed default relay enrollment says so after the allowed relays notice, and the run continues", async () => {
    const onRunNotice = vi.fn();
    const plan = await relayPlanForRun(
      generateSharedSecret(),
      { turn: [PARTNER_URL] },
      ["site.example.com"],
      {
        readOwn,
        setting: () => SITE,
        enroll: vi.fn(() =>
          Promise.resolve({ kind: "failed" as const, detail: "HTTP 503" }),
        ),
        onRunNotice,
      },
    );
    expect(plan).toEqual({
      relay: { turn: [], stun: ["stun:own.example.org:3478"] },
      relaysLeftOut: [OWN_URL, PARTNER_URL],
      websocketRelays: [],
    });
    expect(onRunNotice.mock.calls).toEqual([
      [allowedRelaysRunNotice([SITE.turnUrl], [OWN_URL, PARTNER_URL])],
      [DEFAULT_RELAY_NOT_ENROLLED_NOTICE],
    ]);
  });

  test("with no relay at all, a failed default relay enrollment says so and the run continues", async () => {
    const onRunNotice = vi.fn();
    const plan = await relayPlanForRun(
      generateSharedSecret(),
      undefined,
      undefined,
      {
        readOwn: () => ({ kind: "none" }),
        setting: () => SITE,
        enroll: vi.fn(() =>
          Promise.resolve({ kind: "failed" as const, detail: "HTTP 503" }),
        ),
        onRunNotice,
      },
    );
    expect(plan).toEqual({ relaysLeftOut: [], websocketRelays: [] });
    expect(onRunNotice).toHaveBeenCalledExactlyOnceWith(
      DEFAULT_RELAY_NOT_ENROLLED_NOTICE,
    );
  });
});
