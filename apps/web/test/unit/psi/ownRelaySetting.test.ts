import { afterEach, describe, expect, test, vi } from "vitest";

import { deriveRelayExchangeId, generateSharedSecret } from "@alcove/core";

import {
  MAX_RELAY_URLS,
  ownRelayForInvitation,
  parseRelayUrlLines,
  parseWebSocketRelayUrl,
  readOwnRelaySetting,
  relayForRun,
  webSocketRelaysForRun,
  writeOwnRelaySetting,
} from "@psi/transport/ownRelaySetting";
import { DEFAULT_RELAY_NOT_ENROLLED_NOTICE } from "@psi/transport/defaultRelay";
import { relayPlanForRun } from "@psi/transport/runRelayPlan";

import type { RelayLocator } from "@psi/transport/rendezvous";

const STORAGE_KEY = "alcove-own-relay";

/** A localStorage stand-in over a Map, returned so a test reads what was
 * written. */
function stubStorage(): Map<string, string> {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  });
  return values;
}

const OWN: RelayLocator = {
  turn: ["turns:relay.example.org:443?transport=tcp"],
  stun: ["stun:stun.example.org:3478"],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the stored own relay", () => {
  test("reads back what was written", () => {
    stubStorage();
    writeOwnRelaySetting(OWN);
    expect(readOwnRelaySetting()).toEqual({ kind: "set", relay: OWN });
  });

  test("stores the urls and nothing else", () => {
    const values = stubStorage();
    writeOwnRelaySetting(OWN);
    expect(JSON.parse(values.get(STORAGE_KEY) ?? "")).toStrictEqual({
      version: 1,
      turn: OWN.turn,
      stun: OWN.stun,
    });
  });

  test("a stored value holding a credential is refused", () => {
    const values = stubStorage();
    values.set(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        turn: OWN.turn,
        stun: [],
        credential: "not-a-real-credential",
      }),
    );
    expect(readOwnRelaySetting()).toEqual({ kind: "unreadable" });
  });

  test("a stored url outside the grammar is refused", () => {
    const values = stubStorage();
    values.set(
      STORAGE_KEY,
      JSON.stringify({ version: 1, turn: ["turn:"], stun: [] }),
    );
    expect(readOwnRelaySetting()).toEqual({ kind: "unreadable" });
  });

  test("writing no url removes the setting", () => {
    const values = stubStorage();
    writeOwnRelaySetting(OWN);
    writeOwnRelaySetting({ turn: [], stun: [] });
    expect(values.has(STORAGE_KEY)).toBe(false);
    expect(readOwnRelaySetting()).toEqual({ kind: "none" });
  });

  test("a url outside the grammar is not written", () => {
    const values = stubStorage();
    expect(() =>
      writeOwnRelaySetting({
        turn: ["turns:relay.example.org:443?transport=udp"],
        stun: [],
      }),
    ).toThrow();
    expect(values.has(STORAGE_KEY)).toBe(false);
  });

  test("no storage reads as no relay", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readOwnRelaySetting()).toEqual({ kind: "none" });
  });
});

describe("parseRelayUrlLines", () => {
  test("reads one url per line, skipping blank lines and trimming", () => {
    expect(
      parseRelayUrlLines(
        "  turns:relay.example.org:443?transport=tcp\n\nturn:relay.example.org:3478\n",
        "turn",
      ),
    ).toEqual({
      ok: true,
      urls: [
        "turns:relay.example.org:443?transport=tcp",
        "turn:relay.example.org:3478",
      ],
    });
  });

  test("names each refused line with the connection grammar's message", () => {
    const result = parseRelayUrlLines(
      "turn:relay.example.org:3478\nturn:\nstun:relay.example.org",
      "turn",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((problem) => problem.line)).toEqual([2, 3]);
    expect(result.problems[0].message).toMatch(/must name a host/);
  });

  test("holds a stun list to the stun grammar", () => {
    expect(parseRelayUrlLines("turn:relay.example.org", "stun").ok).toBe(false);
  });

  test("refuses more urls than a list holds", () => {
    const lines = Array.from(
      { length: MAX_RELAY_URLS + 1 },
      (_, index) => `stun:stun${index}.example.org`,
    ).join("\n");
    expect(parseRelayUrlLines(lines, "stun").ok).toBe(false);
  });
});

describe("relayForRun", () => {
  const NO_RESTRICTION = undefined;

  const invitation: RelayLocator = {
    turn: ["turns:partner-relay.example.org:443"],
    stun: [],
  };

  test("lists the own setting's urls, then the invitation's, per kind", () => {
    const named: RelayLocator = {
      turn: ["turns:partner-relay.example.org:443"],
      stun: ["stun:partner-relay.example.org:3478"],
    };
    expect(
      relayForRun(named, NO_RESTRICTION, () => ({ kind: "set", relay: OWN })),
    ).toEqual({
      turn: [...OWN.turn, ...named.turn],
      stun: [...OWN.stun, ...named.stun],
    });
  });

  test("keeps the own setting's kind the invitation leaves unnamed", () => {
    expect(
      relayForRun(invitation, NO_RESTRICTION, () => ({
        kind: "set",
        relay: OWN,
      })),
    ).toEqual({
      turn: [...OWN.turn, ...invitation.turn],
      stun: OWN.stun,
    });
    expect(
      relayForRun(
        { stun: ["stun:partner-relay.example.org:3478"] },
        NO_RESTRICTION,
        () => ({
          kind: "set",
          relay: OWN,
        }),
      ),
    ).toEqual({
      turn: OWN.turn,
      stun: [...OWN.stun, "stun:partner-relay.example.org:3478"],
    });
  });

  test("lists a url both name once", () => {
    expect(
      relayForRun(OWN, NO_RESTRICTION, () => ({ kind: "set", relay: OWN })),
    ).toEqual(OWN);
  });

  test("lists the invitation's STUN urls where the own setting names none", () => {
    const named = { stun: ["stun:partner-relay.example.org:3478"] };
    expect(
      relayForRun(named, NO_RESTRICTION, () => ({ kind: "none" })),
    ).toStrictEqual({ turn: [], stun: named.stun });
    expect(
      relayForRun(named, NO_RESTRICTION, () => ({
        kind: "set",
        relay: { turn: OWN.turn, stun: [] },
      })),
    ).toStrictEqual({ turn: OWN.turn, stun: named.stun });
  });

  test("uses the invitation's relay alone with no own setting", () => {
    expect(
      relayForRun(invitation, NO_RESTRICTION, () => ({ kind: "none" })),
    ).toEqual(invitation);
    expect(
      relayForRun(invitation, NO_RESTRICTION, () => ({ kind: "unreadable" })),
    ).toEqual(invitation);
  });

  test("falls back to the own setting", () => {
    expect(
      relayForRun(undefined, NO_RESTRICTION, () => ({
        kind: "set",
        relay: OWN,
      })),
    ).toEqual(OWN);
  });

  test("lists only the TURN urls the allowed relays keep, and every STUN url", () => {
    const named: RelayLocator = {
      turn: ["turns:partner-relay.example.org:443"],
      stun: ["stun:partner-relay.example.org:3478"],
    };
    expect(
      relayForRun(named, ["relay.example.org"], () => ({
        kind: "set",
        relay: OWN,
      })),
    ).toEqual({
      turn: OWN.turn,
      stun: [...OWN.stun, ...named.stun],
    });
  });

  test("is none with neither", () => {
    expect(
      relayForRun(undefined, NO_RESTRICTION, () => ({ kind: "none" })),
    ).toBeUndefined();
    expect(
      relayForRun(undefined, NO_RESTRICTION, () => ({ kind: "unreadable" })),
    ).toBeUndefined();
  });
});

describe("the own WebSocket relay", () => {
  const WEBSOCKET = "wss://wsrelay.example.org/relay";
  const PARTNER = "wss://partner.example.net/relay";

  test("is stored beside the TURN and STUN urls and reads back", () => {
    const values = stubStorage();
    writeOwnRelaySetting({ ...OWN, websocket: WEBSOCKET });
    expect(JSON.parse(values.get(STORAGE_KEY) ?? "")).toStrictEqual({
      version: 1,
      turn: OWN.turn,
      stun: OWN.stun,
      websocket: WEBSOCKET,
    });
    expect(readOwnRelaySetting()).toEqual({
      kind: "set",
      relay: { ...OWN, websocket: WEBSOCKET },
    });
  });

  test("is a setting on its own", () => {
    stubStorage();
    writeOwnRelaySetting({ turn: [], stun: [], websocket: WEBSOCKET });
    expect(readOwnRelaySetting()).toEqual({
      kind: "set",
      relay: { turn: [], stun: [], websocket: WEBSOCKET },
    });
  });

  test("a url outside the grammar is not written, and a stored one is refused", () => {
    const values = stubStorage();
    expect(() =>
      writeOwnRelaySetting({ ...OWN, websocket: "ws://wsrelay.example.org" }),
    ).toThrow();
    expect(values.has(STORAGE_KEY)).toBe(false);
    values.set(
      STORAGE_KEY,
      JSON.stringify({ version: 1, turn: [], stun: [], websocket: "x" }),
    );
    expect(readOwnRelaySetting()).toEqual({ kind: "unreadable" });
  });

  test("parseWebSocketRelayUrl reads one url, blank as none, with core's message for a refusal", () => {
    expect(parseWebSocketRelayUrl("  ")).toEqual({ ok: true });
    expect(parseWebSocketRelayUrl(` ${WEBSOCKET} `)).toEqual({
      ok: true,
      url: WEBSOCKET,
    });
    const refused = parseWebSocketRelayUrl(`${WEBSOCKET}?token=x`);
    expect(refused.ok).toBe(false);
    if (!refused.ok)
      expect(refused.message).toMatch(
        /^the WebSocket relay url has a query or fragment/,
      );
  });

  test("a run lists its own before the invitation's, each once, less those the allowed relays leave out", () => {
    const own = () => ({
      kind: "set" as const,
      relay: { ...OWN, websocket: WEBSOCKET },
    });
    expect(
      webSocketRelaysForRun({ websocket: PARTNER }, undefined, own),
    ).toEqual([WEBSOCKET, PARTNER]);
    expect(
      webSocketRelaysForRun({ websocket: WEBSOCKET }, undefined, own),
    ).toEqual([WEBSOCKET]);
    expect(
      webSocketRelaysForRun(
        { websocket: PARTNER },
        ["partner.example.net"],
        own,
      ),
    ).toEqual([PARTNER]);
    expect(
      webSocketRelaysForRun({ websocket: PARTNER }, undefined, () => ({
        kind: "unreadable",
      })),
    ).toEqual([PARTNER]);
  });

  test("an invitation names it beside the own TURN and STUN urls where the allowed relays keep it", () => {
    const own = () => ({
      kind: "set" as const,
      relay: { ...OWN, websocket: WEBSOCKET },
    });
    expect(ownRelayForInvitation(undefined, own)).toStrictEqual({
      ...OWN,
      websocket: WEBSOCKET,
    });
    expect(ownRelayForInvitation(["relay.example.org"], own)).toStrictEqual({
      turn: OWN.turn,
      stun: OWN.stun,
    });
    expect(
      ownRelayForInvitation(undefined, () => ({
        kind: "set",
        relay: { turn: [], stun: [], websocket: WEBSOCKET },
      })),
    ).toEqual({ websocket: WEBSOCKET });
  });
});

describe("the WebSocket relays a run's plan lists", () => {
  const WEBSOCKET = "wss://wsrelay.example.org/relay";
  const PARTNER = "wss://partner.example.net/relay";
  const SITE_WEBSOCKET = "wss://site-relay.example.com/relay";
  const SITE = {
    turnUrl: "turns:site-relay.example.com:443?transport=tcp",
    registrarUrl: "https://site-relay.example.com",
    websocketUrl: SITE_WEBSOCKET,
  };
  const ownWithWebSocket = () => ({
    kind: "set" as const,
    relay: { ...OWN, websocket: WEBSOCKET },
  });
  const enrolled = () =>
    Promise.resolve({ kind: "enrolled" as const, lapsesAt: "x" });

  test("lists this browser's own, the invitation's, then the default relay's, each with its exchange id", async () => {
    const secret = generateSharedSecret();
    const derived = await deriveRelayExchangeId(secret);
    const plan = await relayPlanForRun(
      secret,
      { websocket: PARTNER, websocketExchangeId: "partner-weekly" },
      undefined,
      {
        readOwn: ownWithWebSocket,
        ownRelayExchangeId: "own-weekly",
        setting: () => SITE,
        enroll: vi.fn(enrolled),
      },
    );
    expect(plan.websocketRelays).toEqual([
      { url: WEBSOCKET, exchangeId: "own-weekly" },
      { url: PARTNER, exchangeId: "partner-weekly" },
      { url: SITE_WEBSOCKET, exchangeId: derived },
    ]);
  });

  test("a relay with no exchange id named is proven under the id derived from the secret", async () => {
    const secret = generateSharedSecret();
    const derived = await deriveRelayExchangeId(secret);
    const plan = await relayPlanForRun(
      secret,
      { websocket: PARTNER },
      undefined,
      {
        readOwn: ownWithWebSocket,
        setting: () => undefined,
      },
    );
    expect(plan.websocketRelays).toEqual([
      { url: WEBSOCKET, exchangeId: derived },
      { url: PARTNER, exchangeId: derived },
    ]);
  });

  test("with a previous secret, each relay under the derived id is listed again under that secret's id, and one under a named id once", async () => {
    const current = generateSharedSecret();
    const previous = generateSharedSecret();
    const enroll = vi.fn(enrolled);
    const plan = await relayPlanForRun(
      current,
      { websocket: PARTNER, websocketExchangeId: "partner-weekly" },
      undefined,
      {
        readOwn: ownWithWebSocket,
        setting: () => SITE,
        enroll,
        previousSharedSecret: previous,
      },
    );
    const derived = await deriveRelayExchangeId(current);
    const derivedPrevious = await deriveRelayExchangeId(previous);
    expect(plan.websocketRelays).toEqual([
      { url: WEBSOCKET, exchangeId: derived },
      { url: PARTNER, exchangeId: "partner-weekly" },
      { url: SITE_WEBSOCKET, exchangeId: derived },
      {
        url: WEBSOCKET,
        exchangeId: derivedPrevious,
        underPreviousSecret: true,
      },
      {
        url: SITE_WEBSOCKET,
        exchangeId: derivedPrevious,
        underPreviousSecret: true,
      },
    ]);
    expect(enroll).toHaveBeenCalledTimes(2);
  });

  test("with a previous secret the default relay could not enroll, its url is listed under the current secret only", async () => {
    const current = generateSharedSecret();
    const previous = generateSharedSecret();
    const plan = await relayPlanForRun(current, undefined, undefined, {
      readOwn: () => ({ kind: "set", relay: OWN }),
      setting: () => SITE,
      enroll: vi.fn((params: { sharedSecret: string }) =>
        Promise.resolve(
          params.sharedSecret === previous
            ? { kind: "failed" as const, detail: "HTTP 503" }
            : { kind: "enrolled" as const, lapsesAt: "x" },
        ),
      ),
      previousSharedSecret: previous,
    });
    expect(plan.websocketRelays).toEqual([
      { url: SITE_WEBSOCKET, exchangeId: await deriveRelayExchangeId(current) },
    ]);
  });

  test("a url both name is listed once, under the invitation's exchange id", async () => {
    const plan = await relayPlanForRun(
      generateSharedSecret(),
      { websocket: WEBSOCKET, websocketExchangeId: "partner-weekly" },
      undefined,
      {
        readOwn: ownWithWebSocket,
        ownRelayExchangeId: "own-weekly",
        setting: () => undefined,
      },
    );
    expect(plan.websocketRelays).toEqual([
      { url: WEBSOCKET, exchangeId: "partner-weekly" },
    ]);
  });

  test("lists only the relays the allowed relays keep, and enrolls for the default one they keep", async () => {
    const enroll = vi.fn(enrolled);
    const plan = await relayPlanForRun(
      generateSharedSecret(),
      { websocket: PARTNER },
      ["site-relay.example.com:443"],
      { readOwn: ownWithWebSocket, setting: () => SITE, enroll },
    );
    expect(plan.websocketRelays.map((relay) => relay.url)).toEqual([
      SITE_WEBSOCKET,
    ]);
    expect(enroll).toHaveBeenCalledOnce();
  });

  test("a run whose allowed relays keep only the default WebSocket relay url enrolls there and lists it, naming the urls left out", async () => {
    const enroll = vi.fn(enrolled);
    const onRunNotice = vi.fn();
    const site = {
      ...SITE,
      websocketUrl: "wss://site-wsrelay.example.com/relay",
    };
    const secret = generateSharedSecret();
    const plan = await relayPlanForRun(
      secret,
      { websocket: site.websocketUrl },
      ["site-wsrelay.example.com"],
      { readOwn: ownWithWebSocket, setting: () => site, enroll, onRunNotice },
    );
    expect(enroll).toHaveBeenCalledTimes(1);
    expect(plan.websocketRelays).toEqual([
      {
        url: site.websocketUrl,
        exchangeId: await deriveRelayExchangeId(secret),
      },
    ]);
    const leftOut = [...OWN.turn, SITE.turnUrl, WEBSOCKET];
    expect(plan.relaysLeftOut).toEqual(leftOut);
    expect(onRunNotice).toHaveBeenCalledWith(
      `Your allowed relays keep ${site.websocketUrl} and leave out ` +
        `${leftOut.join(", ")} for this run.`,
    );
    expect(onRunNotice).not.toHaveBeenCalledWith(
      DEFAULT_RELAY_NOT_ENROLLED_NOTICE,
    );
  });

  test("the default relay's url is left out when the run could not enroll there, even where the invitation names it", async () => {
    const plan = await relayPlanForRun(
      generateSharedSecret(),
      { websocket: SITE_WEBSOCKET },
      undefined,
      {
        readOwn: ownWithWebSocket,
        setting: () => SITE,
        enroll: vi.fn(() =>
          Promise.resolve({ kind: "failed" as const, detail: "HTTP 503" }),
        ),
      },
    );
    expect(plan.websocketRelays.map((relay) => relay.url)).toEqual([WEBSOCKET]);
  });

  test("a run listing no WebSocket relay lists none", async () => {
    const plan = await relayPlanForRun(
      generateSharedSecret(),
      undefined,
      undefined,
      {
        readOwn: () => ({ kind: "set", relay: OWN }),
        setting: () => undefined,
      },
    );
    expect(plan.websocketRelays).toEqual([]);
  });
});
