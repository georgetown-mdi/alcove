import { afterEach, describe, expect, test, vi } from "vitest";

import { OperatorConfigError, generateSharedSecret } from "@alcove/core";

import {
  MAX_ALLOWED_RELAYS,
  RELAY_ONLY_NO_RELAY,
  RELAY_ONLY_RELAYS_LEFT_OUT,
  RELAY_RESTRICTION_UNREADABLE,
  allowedRelaysRunNotice,
  parseAllowedRelayLines,
  readRelayRestriction,
  runRelayRestriction,
  writeRelayRestriction,
} from "@psi/transport/relayRestriction";
import {
  assertRunRelayPlanPossible,
  relayPlanForRun,
} from "@psi/transport/runRelayPlan";
import {
  invitationRelayWithDefault,
  relayWithDefaultForRun,
} from "@psi/transport/defaultRelay";
import { relayForRun } from "@psi/transport/ownRelaySetting";
import { relayTestTargets } from "@psi/transport/relayTest";

import type { OwnRelayRead } from "@psi/transport/ownRelaySetting";

const STORAGE_KEY = "alcove-relay-restriction";

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

function stubStorage(): Map<string, string> {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  });
  return values;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the stored relay restriction", () => {
  test("reads back what was written, and restricts nothing when none is stored", () => {
    const values = stubStorage();
    expect(readRelayRestriction()).toEqual({
      kind: "set",
      restriction: { relayOnly: false },
    });
    writeRelayRestriction({
      allowedRelays: ["relay.example.org", "backup.example.org:443"],
      relayOnly: true,
    });
    expect(JSON.parse(values.get(STORAGE_KEY) ?? "")).toStrictEqual({
      version: 1,
      allowedRelays: ["relay.example.org", "backup.example.org:443"],
      relayOnly: true,
    });
    expect(readRelayRestriction()).toEqual({
      kind: "set",
      restriction: {
        allowedRelays: ["relay.example.org", "backup.example.org:443"],
        relayOnly: true,
      },
    });
  });

  test("a restriction of nothing removes the stored value", () => {
    const values = stubStorage();
    writeRelayRestriction({ relayOnly: true });
    expect(values.has(STORAGE_KEY)).toBe(true);
    writeRelayRestriction({ relayOnly: false });
    expect(values.has(STORAGE_KEY)).toBe(false);
  });

  test("an entry not in its normalized form is refused on write and on read", () => {
    const values = stubStorage();
    expect(() =>
      writeRelayRestriction({
        allowedRelays: ["Relay.Example.org"],
        relayOnly: false,
      }),
    ).toThrow();
    values.set(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        allowedRelays: ["turns:relay.example.org"],
        relayOnly: false,
      }),
    );
    expect(readRelayRestriction()).toEqual({ kind: "unreadable" });
  });

  test("a run under a value it cannot read keeps no relay and gathers relay candidates only", () => {
    expect(runRelayRestriction(() => ({ kind: "unreadable" }))).toEqual({
      allowedRelays: [],
      relayOnly: true,
      unreadable: true,
    });
  });
});

describe("parseAllowedRelayLines", () => {
  test("normalizes each entry as core's allowed_relays does, once each", () => {
    expect(
      parseAllowedRelayLines(
        " Relay.Example.ORG. \n\nrelay.example.org\n[2001:DB8::1]:3478\n",
      ),
    ).toEqual({
      ok: true,
      entries: ["relay.example.org", "[2001:db8::1]:3478"],
    });
  });

  test("blank text leaves the setting unset", () => {
    expect(parseAllowedRelayLines(" \n")).toEqual({ ok: true });
  });

  test("names each refused line and the form", () => {
    const parsed = parseAllowedRelayLines(
      "relay.example.org\nturns:relay.example.org:443\nrelay.example.org:0",
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems.map((problem) => problem.line)).toEqual([2, 3]);
    expect(parsed.problems[0]?.message).toMatch(
      /^enter a host and an optional port .*with no turn: or turns: scheme$/,
    );
  });

  test("refuses more entries than the bound", () => {
    const text = Array.from(
      { length: MAX_ALLOWED_RELAYS + 1 },
      (_unused, index) => `relay-${String(index)}.example.org`,
    ).join("\n");
    expect(parseAllowedRelayLines(text)).toEqual({
      ok: false,
      problems: [
        { message: `enter at most ${String(MAX_ALLOWED_RELAYS)} relays` },
      ],
    });
  });
});

describe("the relays a browser run lists under its allowed relays", () => {
  test("own and invitation TURN urls an entry names are kept, and STUN urls untouched", () => {
    expect(
      relayForRun({ turn: [PARTNER_URL] }, readOwn, ["partner.example.net"]),
    ).toEqual({
      turn: [PARTNER_URL],
      stun: ["stun:own.example.org:3478"],
    });
    expect(relayForRun({ turn: [PARTNER_URL] }, readOwn, undefined)).toEqual({
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
    expect(
      await relayWithDefaultForRun(generateSharedSecret(), relay, {
        setting: () => SITE,
        enroll,
        allowedRelays: () => ["own.example.org"],
      }),
    ).toBe(relay);
    expect(enroll).not.toHaveBeenCalled();
  });

  test("the relay test contacts only the relays kept", () => {
    expect(
      relayTestTargets(readOwn, () => SITE, ["site.example.com"]).map(
        (target) => target.url,
      ),
    ).toEqual([SITE.turnUrl]);
  });
});

describe("relayPlanForRun", () => {
  test("under Relay only, refuses before any contact when every TURN url is left out", async () => {
    const enroll = vi.fn();
    const onRunNotice = vi.fn();
    const planning = relayPlanForRun(
      generateSharedSecret(),
      { turn: [PARTNER_URL] },
      {
        readOwn,
        setting: () => SITE,
        enroll,
        onRunNotice,
        restriction: () => ({
          allowedRelays: ["elsewhere.example.org"],
          relayOnly: true,
        }),
      },
    );
    await expect(planning).rejects.toThrow(OperatorConfigError);
    await expect(planning).rejects.toThrow(RELAY_ONLY_RELAYS_LEFT_OUT);
    expect(enroll).not.toHaveBeenCalled();
    expect(onRunNotice).not.toHaveBeenCalled();
  });

  test("under Relay only, refuses before any contact when the run lists no TURN url at all", async () => {
    const enroll = vi.fn();
    const onRunNotice = vi.fn();
    const planning = relayPlanForRun(generateSharedSecret(), undefined, {
      readOwn: () => ({ kind: "none" }),
      setting: () => undefined,
      enroll,
      onRunNotice,
      restriction: () => ({ relayOnly: true }),
    });
    await expect(planning).rejects.toThrow(OperatorConfigError);
    await expect(planning).rejects.toThrow(RELAY_ONLY_NO_RELAY);
    expect(enroll).not.toHaveBeenCalled();
    expect(onRunNotice).not.toHaveBeenCalled();
  });

  test("a stored restriction this build cannot read refuses the run, naming the saved settings", async () => {
    const enroll = vi.fn();
    const planning = relayPlanForRun(
      generateSharedSecret(),
      { turn: [PARTNER_URL] },
      {
        readOwn,
        setting: () => SITE,
        enroll,
        restriction: () => runRelayRestriction(() => ({ kind: "unreadable" })),
      },
    );
    await expect(planning).rejects.toThrow(OperatorConfigError);
    await expect(planning).rejects.toThrow(RELAY_RESTRICTION_UNREADABLE);
    expect(enroll).not.toHaveBeenCalled();
  });

  test("the refusals are available without planning the run", () => {
    expect(() =>
      assertRunRelayPlanPossible(undefined, {
        readOwn: () => ({ kind: "none" }),
        setting: () => undefined,
        restriction: () => ({ relayOnly: true }),
      }),
    ).toThrow(RELAY_ONLY_NO_RELAY);
    expect(() =>
      assertRunRelayPlanPossible(
        { turn: [PARTNER_URL] },
        {
          readOwn,
          setting: () => undefined,
          restriction: () => ({ relayOnly: true }),
        },
      ),
    ).not.toThrow();
  });

  test("keeps the relays named, says which it kept and left out, and gathers relay candidates only", async () => {
    const onRunNotice = vi.fn();
    const plan = await relayPlanForRun(
      generateSharedSecret(),
      { turn: [PARTNER_URL] },
      {
        readOwn,
        setting: () => SITE,
        enroll: vi.fn(() =>
          Promise.resolve({ kind: "enrolled" as const, lapsesAt: "x" }),
        ),
        onRunNotice,
        restriction: () => ({
          allowedRelays: ["own.example.org", "site.example.com:443"],
          relayOnly: true,
        }),
      },
    );
    expect(plan).toEqual({
      relay: {
        turn: [OWN_URL, SITE.turnUrl],
        stun: ["stun:own.example.org:3478"],
      },
      iceTransportPolicy: "relay",
      relaysLeftOut: [PARTNER_URL],
    });
    expect(onRunNotice).toHaveBeenCalledExactlyOnceWith(
      allowedRelaysRunNotice([OWN_URL, SITE.turnUrl], [PARTNER_URL]),
    );
    expect(onRunNotice.mock.calls[0]?.[0]).toBe(
      `Your allowed relays keep ${OWN_URL}, ${SITE.turnUrl} and leave out ` +
        `${PARTNER_URL} for this run.`,
    );
  });

  test("unset, lists every relay with no notice and gathers every candidate type", async () => {
    const onRunNotice = vi.fn();
    const plan = await relayPlanForRun(
      generateSharedSecret(),
      { turn: [PARTNER_URL] },
      {
        readOwn,
        setting: () => undefined,
        onRunNotice,
        restriction: () => ({ relayOnly: false }),
      },
    );
    expect(plan).toEqual({
      relay: {
        turn: [OWN_URL, PARTNER_URL],
        stun: ["stun:own.example.org:3478"],
      },
      iceTransportPolicy: "all",
      relaysLeftOut: [],
    });
    expect(onRunNotice).not.toHaveBeenCalled();
  });

  test("not relay-only, a run whose every TURN url is left out continues without one", async () => {
    const plan = await relayPlanForRun(generateSharedSecret(), undefined, {
      readOwn,
      setting: () => undefined,
      restriction: () => ({
        allowedRelays: ["other.example"],
        relayOnly: false,
      }),
    });
    expect(plan.relay).toEqual({
      turn: [],
      stun: ["stun:own.example.org:3478"],
    });
    expect(plan.relaysLeftOut).toEqual([OWN_URL]);
  });
});
