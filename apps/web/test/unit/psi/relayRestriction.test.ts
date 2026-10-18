import { afterEach, describe, expect, test, vi } from "vitest";

import { generateSharedSecret } from "@alcove/core";

import {
  DEFAULT_RELAY_NOT_ENROLLED_NOTICE,
  invitationRelayWithDefault,
  relayWithDefaultForRun,
} from "@psi/transport/defaultRelay";
import {
  MAX_ALLOWED_RELAYS,
  allowedRelaysRunNotice,
  parseAllowedRelayLines,
  readRelayRestriction,
  writeRelayRestriction,
} from "@psi/transport/relayRestriction";
import { relayForRun } from "@psi/transport/ownRelaySetting";
import { relayPlanForRun } from "@psi/transport/runRelayPlan";
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
    expect(readRelayRestriction()).toEqual({});
    writeRelayRestriction({
      allowedRelays: ["relay.example.org", "backup.example.org:443"],
    });
    expect(JSON.parse(values.get(STORAGE_KEY) ?? "")).toStrictEqual({
      version: 1,
      allowedRelays: ["relay.example.org", "backup.example.org:443"],
    });
    expect(readRelayRestriction()).toEqual({
      allowedRelays: ["relay.example.org", "backup.example.org:443"],
    });
  });

  test("a restriction of nothing removes the stored value", () => {
    const values = stubStorage();
    writeRelayRestriction({ allowedRelays: ["relay.example.org"] });
    expect(values.has(STORAGE_KEY)).toBe(true);
    writeRelayRestriction({});
    expect(values.has(STORAGE_KEY)).toBe(false);
  });

  test("an entry not in its normalized form is refused on write", () => {
    stubStorage();
    expect(() =>
      writeRelayRestriction({ allowedRelays: ["Relay.Example.org"] }),
    ).toThrow();
  });

  test.each([
    [
      "a version this build does not know",
      { version: 2, allowedRelays: ["relay.example.org"] },
    ],
    [
      "a field this build does not know",
      { version: 1, allowedRelays: ["relay.example.org"], other: true },
    ],
    [
      "an entry not in its normalized form",
      { version: 1, allowedRelays: ["turns:relay.example.org"] },
    ],
  ])("a stored value holding %s is treated as none saved", (_name, value) => {
    const values = stubStorage();
    values.set(STORAGE_KEY, JSON.stringify(value));
    expect(readRelayRestriction()).toEqual({});
  });

  test("a stored value that is not JSON is treated as none saved", () => {
    const values = stubStorage();
    values.set(STORAGE_KEY, "{not json");
    expect(readRelayRestriction()).toEqual({});
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
    expect(
      await relayWithDefaultForRun(
        generateSharedSecret(),
        relay,
        ["own.example.org"],
        { setting: () => SITE, enroll },
      ),
    ).toBe(relay);
    expect(enroll).not.toHaveBeenCalled();
  });

  test("the relay test contacts only the relays kept", () => {
    expect(
      relayTestTargets(["site.example.com"], readOwn, () => SITE).map(
        (target) => target.url,
      ),
    ).toEqual([SITE.turnUrl]);
  });
});

describe("relayPlanForRun", () => {
  test("a stored restriction this build cannot read lets the run proceed with no restriction", async () => {
    const values = stubStorage();
    values.set(
      STORAGE_KEY,
      JSON.stringify({ version: 2, allowedRelays: ["other.example"] }),
    );
    const enroll = vi.fn(() =>
      Promise.resolve({ kind: "enrolled" as const, lapsesAt: "x" }),
    );
    const onRunNotice = vi.fn();
    const plan = await relayPlanForRun(
      generateSharedSecret(),
      { turn: [PARTNER_URL] },
      readRelayRestriction().allowedRelays,
      { readOwn, setting: () => SITE, enroll, onRunNotice },
    );
    expect(plan).toEqual({
      relay: {
        turn: [OWN_URL, PARTNER_URL, SITE.turnUrl],
        stun: ["stun:own.example.org:3478"],
      },
      relaysLeftOut: [],
    });
    expect(enroll).toHaveBeenCalledOnce();
    expect(onRunNotice).not.toHaveBeenCalled();
  });

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
    expect(plan).toEqual({ relaysLeftOut: [] });
    expect(onRunNotice).toHaveBeenCalledExactlyOnceWith(
      DEFAULT_RELAY_NOT_ENROLLED_NOTICE,
    );
  });
});
