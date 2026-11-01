import { afterEach, describe, expect, test, vi } from "vitest";

import {
  MAX_RELAY_LOCATOR_URLS,
  REMOVED_EXCHANGE_ID_TEXT,
  REMOVED_RELAY_KEY_TEXT,
  deriveRelayExchangeId,
  deriveRelayKey,
  enrollRelayKeyWithinWait,
  generateSharedSecret,
  getLogger,
} from "@alcove/core";

import {
  DEFAULT_RELAY_DIAL_WAIT_MS,
  DEFAULT_RELAY_NOT_ENROLLED_NOTICE,
  DEFAULT_RELAY_PREVIOUS_NOT_ENROLLED_NOTICE,
  invitationRelayWithDefault,
  relayWithDefaultForRun,
} from "../../../src/psi/transport/defaultRelay.js";

import type { RelayEnrollmentWithinWait } from "@alcove/core";

// The enrollment each browser run makes right before it connects. The first
// block mocks core's bounded enrollment; the dial's wait runs it over a
// registrar that never answers. Core's suite holds the request and its answers.

const DEFAULT_RELAY = {
  turnUrl: "turns:turn.example.org:443?transport=tcp",
  registrarUrl: "https://registrar.example.org",
};

const OWN = {
  turn: ["turns:own-relay.example.org:443?transport=tcp"],
  stun: [],
};

const ENROLLED: RelayEnrollmentWithinWait = {
  kind: "enrolled",
  lapsesAt: "2026-10-15T13:10:00Z",
};

const SHORT_WAIT_MS = 50;

const NO_RESTRICTION = undefined;

const WITHOUT_DEFAULT = { relay: OWN };

const WITH_DEFAULT = {
  relay: { turn: [...OWN.turn, DEFAULT_RELAY.turnUrl], stun: [] },
};

function answering(enrollment: RelayEnrollmentWithinWait) {
  return vi.fn<typeof enrollRelayKeyWithinWait>(() =>
    Promise.resolve(enrollment),
  );
}

// A registrar that takes each request and never answers it, until the
// request's signal aborts.
function neverAnsweringFetch() {
  return vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason as Error),
        );
      }),
  );
}

// Core's bounded enrollment, sending through `fetch`.
function enrollingThrough(fetch: typeof globalThis.fetch) {
  return vi.fn<typeof enrollRelayKeyWithinWait>((params, options) =>
    enrollRelayKeyWithinWait(params, { ...options, fetch }),
  );
}

async function untilCalled(spy: {
  mock: { calls: ReadonlyArray<unknown> };
}): Promise<void> {
  while (spy.mock.calls.length === 0)
    await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("relayWithDefaultForRun", () => {
  test("makes one attempt bounded by the dial's wait, and lists the relay once enrolled, with no notice", async () => {
    const secret = generateSharedSecret();
    const signal = new AbortController().signal;
    const enroll = answering(ENROLLED);
    const onRunNotice = vi.fn();
    const run = await relayWithDefaultForRun(secret, OWN, NO_RESTRICTION, {
      setting: () => DEFAULT_RELAY,
      enroll,
      signal,
      onRunNotice,
    });
    expect(enroll).toHaveBeenCalledExactlyOnceWith(
      { registrarUrl: DEFAULT_RELAY.registrarUrl, sharedSecret: secret },
      { waitMs: DEFAULT_RELAY_DIAL_WAIT_MS, signal },
    );
    expect(run).toEqual(WITH_DEFAULT);
    expect(onRunNotice).not.toHaveBeenCalled();
  });

  test("enrolls again on every dial, and a same-key repeat lists the relay", async () => {
    const secret = generateSharedSecret();
    const enroll = answering(ENROLLED);
    const dial = { setting: () => DEFAULT_RELAY, enroll };
    expect(
      await relayWithDefaultForRun(secret, OWN, NO_RESTRICTION, dial),
    ).toEqual(WITH_DEFAULT);
    expect(
      await relayWithDefaultForRun(secret, OWN, NO_RESTRICTION, dial),
    ).toEqual(WITH_DEFAULT);
    expect(enroll).toHaveBeenCalledTimes(2);
  });

  test("lists the default relay alone when the run has no other", async () => {
    const run = await relayWithDefaultForRun(
      generateSharedSecret(),
      undefined,
      NO_RESTRICTION,
      {
        setting: () => DEFAULT_RELAY,
        enroll: answering(ENROLLED),
      },
    );
    expect(run).toEqual({ relay: { turn: [DEFAULT_RELAY.turnUrl], stun: [] } });
  });

  test("lists the default relay once, last, when the invitation already names it", async () => {
    const invited = {
      turn: [DEFAULT_RELAY.turnUrl, ...OWN.turn],
      stun: ["stun:stun.example.org:3478"],
    };
    const run = await relayWithDefaultForRun(
      generateSharedSecret(),
      invited,
      NO_RESTRICTION,
      {
        setting: () => DEFAULT_RELAY,
        enroll: answering(ENROLLED),
      },
    );
    expect(run).toEqual({
      relay: { turn: [...OWN.turn, DEFAULT_RELAY.turnUrl], stun: invited.stun },
    });
  });

  test("keeps the relay's STUN urls whether or not the enrollment confirms", async () => {
    const own = { ...OWN, stun: ["stun:own-stun.example.org:3478"] };
    for (const enrollment of [
      ENROLLED,
      { kind: "failed", detail: "HTTP 409" } as const,
    ]) {
      const run = await relayWithDefaultForRun(
        generateSharedSecret(),
        own,
        NO_RESTRICTION,
        { setting: () => DEFAULT_RELAY, enroll: answering(enrollment) },
      );
      expect(run.relay).toStrictEqual({
        turn:
          enrollment.kind === "enrolled"
            ? [...own.turn, DEFAULT_RELAY.turnUrl]
            : own.turn,
        stun: own.stun,
      });
    }
  });

  test("a failed enrollment says so once and dials with its other relays", async () => {
    const onRunNotice = vi.fn();
    const run = await relayWithDefaultForRun(
      generateSharedSecret(),
      OWN,
      NO_RESTRICTION,
      {
        setting: () => DEFAULT_RELAY,
        enroll: answering({ kind: "failed", detail: "HTTP 409: held" }),
        onRunNotice,
      },
    );
    expect(run).toEqual(WITHOUT_DEFAULT);
    expect(onRunNotice).toHaveBeenCalledExactlyOnceWith(
      DEFAULT_RELAY_NOT_ENROLLED_NOTICE,
    );
  });

  test("a registrar repeating the exchange id and relay key gets neither into the log", async () => {
    const secret = generateSharedSecret();
    const exchangeId = await deriveRelayExchangeId(secret);
    const key = await deriveRelayKey(secret);
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: `exchange ${exchangeId} holds no ${key}` }),
          { status: 409 },
        ),
      ),
    );
    const warn = vi.spyOn(getLogger("defaultRelay"), "warn");
    try {
      await relayWithDefaultForRun(secret, OWN, NO_RESTRICTION, {
        setting: () => DEFAULT_RELAY,
        enroll: enrollingThrough(fetch),
      });
      expect(warn).toHaveBeenCalledOnce();
      const logged = String(warn.mock.calls[0]?.[0]);
      expect(logged).toContain(
        `(HTTP 409: exchange ${REMOVED_EXCHANGE_ID_TEXT} holds no ` +
          `${REMOVED_RELAY_KEY_TEXT})`,
      );
      expect(logged).not.toContain(exchangeId);
      expect(logged).not.toContain(key);
    } finally {
      warn.mockRestore();
    }
  });

  test("leaves out the default relay an invitation names when this run could not enroll", async () => {
    const invited = { turn: [...OWN.turn, DEFAULT_RELAY.turnUrl], stun: [] };
    const run = await relayWithDefaultForRun(
      generateSharedSecret(),
      invited,
      NO_RESTRICTION,
      {
        setting: () => DEFAULT_RELAY,
        enroll: answering({ kind: "failed", detail: "HTTP 409" }),
      },
    );
    expect(run).toEqual(WITHOUT_DEFAULT);
  });

  test("a cancelled enrollment leaves the relay out and says nothing", async () => {
    const onRunNotice = vi.fn();
    const run = await relayWithDefaultForRun(
      generateSharedSecret(),
      OWN,
      NO_RESTRICTION,
      {
        setting: () => DEFAULT_RELAY,
        enroll: answering({ kind: "cancelled" }),
        onRunNotice,
      },
    );
    expect(run).toEqual(WITHOUT_DEFAULT);
    expect(onRunNotice).not.toHaveBeenCalled();
  });

  test("contacts no registrar, lists nothing more and says nothing when the build names no default relay", async () => {
    const enroll = answering(ENROLLED);
    const onRunNotice = vi.fn();
    expect(
      await relayWithDefaultForRun(
        generateSharedSecret(),
        undefined,
        NO_RESTRICTION,
        {
          setting: () => undefined,
          enroll,
          onRunNotice,
        },
      ),
    ).toEqual({});
    expect(
      await relayWithDefaultForRun(
        generateSharedSecret(),
        OWN,
        NO_RESTRICTION,
        {
          setting: () => undefined,
          enroll,
          onRunNotice,
        },
      ),
    ).toEqual({ relay: OWN });
    expect(enroll).not.toHaveBeenCalled();
    expect(onRunNotice).not.toHaveBeenCalled();
  });

  describe("the default WebSocket relay", () => {
    const WEBSOCKET = "wss://wsrelay.example.org/relay";
    const withWebSocket = () => ({ ...DEFAULT_RELAY, websocketUrl: WEBSOCKET });

    test("is listed beside the TURN url once the enrollment confirms", async () => {
      expect(
        await relayWithDefaultForRun(
          generateSharedSecret(),
          OWN,
          NO_RESTRICTION,
          { setting: withWebSocket, enroll: answering(ENROLLED) },
        ),
      ).toEqual({ ...WITH_DEFAULT, defaultWebSocketRelay: WEBSOCKET });
    });

    test("is enrolled for and listed, without the TURN url, where the allowed relays keep only its host", async () => {
      const enroll = answering(ENROLLED);
      const run = await relayWithDefaultForRun(
        generateSharedSecret(),
        OWN,
        ["wsrelay.example.org"],
        { setting: withWebSocket, enroll },
      );
      expect(enroll).toHaveBeenCalledTimes(1);
      expect(run).toEqual({
        ...WITHOUT_DEFAULT,
        defaultWebSocketRelay: WEBSOCKET,
      });
    });

    test("is left out where the allowed relays keep only the TURN url", async () => {
      expect(
        await relayWithDefaultForRun(
          generateSharedSecret(),
          OWN,
          ["turn.example.org", "own-relay.example.org"],
          { setting: withWebSocket, enroll: answering(ENROLLED) },
        ),
      ).toEqual(WITH_DEFAULT);
    });

    test("is left out when the enrollment fails, which is said once", async () => {
      const onRunNotice = vi.fn();
      const run = await relayWithDefaultForRun(
        generateSharedSecret(),
        OWN,
        NO_RESTRICTION,
        {
          setting: withWebSocket,
          enroll: answering({ kind: "failed", detail: "HTTP 503" }),
          onRunNotice,
        },
      );
      expect(run).toEqual(WITHOUT_DEFAULT);
      expect(onRunNotice).toHaveBeenCalledExactlyOnceWith(
        DEFAULT_RELAY_NOT_ENROLLED_NOTICE,
      );
    });

    test("is not enrolled for where the allowed relays leave out both its urls", async () => {
      const enroll = answering(ENROLLED);
      expect(
        await relayWithDefaultForRun(
          generateSharedSecret(),
          OWN,
          ["own-relay.example.org"],
          { setting: withWebSocket, enroll },
        ),
      ).toEqual(WITHOUT_DEFAULT);
      expect(enroll).not.toHaveBeenCalled();
    });
  });

  describe("under a previous secret", () => {
    const WEBSOCKET = "wss://wsrelay.example.org/relay";
    const withWebSocket = () => ({ ...DEFAULT_RELAY, websocketUrl: WEBSOCKET });

    test("enrolls under both secrets at once, and lists the WebSocket relay under each", async () => {
      const current = generateSharedSecret();
      const previous = generateSharedSecret();
      const enroll = answering(ENROLLED);
      const onRunNotice = vi.fn();
      const run = await relayWithDefaultForRun(current, OWN, NO_RESTRICTION, {
        setting: withWebSocket,
        enroll,
        previousSharedSecret: previous,
        onRunNotice,
      });
      expect(enroll.mock.calls.map(([params]) => params.sharedSecret)).toEqual([
        current,
        previous,
      ]);
      expect(run).toEqual({
        ...WITH_DEFAULT,
        defaultWebSocketRelay: WEBSOCKET,
        defaultWebSocketRelayUnderPrevious: WEBSOCKET,
      });
      expect(onRunNotice).not.toHaveBeenCalled();
    });

    test("a failed enrollment under the previous secret says so and lists the relay under the current one only", async () => {
      const current = generateSharedSecret();
      const previous = generateSharedSecret();
      const onRunNotice = vi.fn();
      const run = await relayWithDefaultForRun(current, OWN, NO_RESTRICTION, {
        setting: withWebSocket,
        enroll: vi.fn<typeof enrollRelayKeyWithinWait>((params) =>
          Promise.resolve(
            params.sharedSecret === previous
              ? { kind: "failed", detail: "HTTP 503" }
              : ENROLLED,
          ),
        ),
        previousSharedSecret: previous,
        onRunNotice,
      });
      expect(run).toEqual({
        ...WITH_DEFAULT,
        defaultWebSocketRelay: WEBSOCKET,
      });
      expect(onRunNotice).toHaveBeenCalledExactlyOnceWith(
        DEFAULT_RELAY_PREVIOUS_NOT_ENROLLED_NOTICE,
      );
    });

    test("the TURN url follows the current secret's enrollment alone", async () => {
      const current = generateSharedSecret();
      const previous = generateSharedSecret();
      const run = await relayWithDefaultForRun(current, OWN, NO_RESTRICTION, {
        setting: withWebSocket,
        enroll: vi.fn<typeof enrollRelayKeyWithinWait>((params) =>
          Promise.resolve(
            params.sharedSecret === current
              ? { kind: "failed", detail: "HTTP 503" }
              : ENROLLED,
          ),
        ),
        previousSharedSecret: previous,
      });
      expect(run).toEqual({
        ...WITHOUT_DEFAULT,
        defaultWebSocketRelayUnderPrevious: WEBSOCKET,
      });
    });

    test("both enrollments failing show the current secret's notice alone", async () => {
      const onRunNotice = vi.fn();
      const run = await relayWithDefaultForRun(
        generateSharedSecret(),
        OWN,
        NO_RESTRICTION,
        {
          setting: withWebSocket,
          enroll: answering({ kind: "failed", detail: "HTTP 503" }),
          previousSharedSecret: generateSharedSecret(),
          onRunNotice,
        },
      );
      expect(run).toEqual(WITHOUT_DEFAULT);
      expect(onRunNotice).toHaveBeenCalledExactlyOnceWith(
        DEFAULT_RELAY_NOT_ENROLLED_NOTICE,
      );
    });

    test("a default relay naming no WebSocket relay is enrolled at under the current secret alone", async () => {
      const current = generateSharedSecret();
      const enroll = answering(ENROLLED);
      const run = await relayWithDefaultForRun(current, OWN, NO_RESTRICTION, {
        setting: () => DEFAULT_RELAY,
        enroll,
        previousSharedSecret: generateSharedSecret(),
      });
      expect(enroll.mock.calls.map(([params]) => params.sharedSecret)).toEqual([
        current,
      ]);
      expect(run).toEqual(WITH_DEFAULT);
    });
  });
});

describe("the dial's wait for the enrollment", () => {
  test("a registrar that never answers costs the dial its wait and one request, and is reported once", async () => {
    const fetch = neverAnsweringFetch();
    const onRunNotice = vi.fn();
    const run = await relayWithDefaultForRun(
      generateSharedSecret(),
      OWN,
      NO_RESTRICTION,
      {
        setting: () => DEFAULT_RELAY,
        enroll: enrollingThrough(fetch),
        dialWaitMs: SHORT_WAIT_MS,
        onRunNotice,
      },
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(run).toEqual(WITHOUT_DEFAULT);
    expect(onRunNotice).toHaveBeenCalledExactlyOnceWith(
      DEFAULT_RELAY_NOT_ENROLLED_NOTICE,
    );
  });

  test("by default a dial waits DEFAULT_RELAY_DIAL_WAIT_MS and no longer", async () => {
    expect(DEFAULT_RELAY_DIAL_WAIT_MS).toBe(3_000);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetch = neverAnsweringFetch();
    const onRunNotice = vi.fn();
    let settled = false;
    const pending = relayWithDefaultForRun(
      generateSharedSecret(),
      OWN,
      NO_RESTRICTION,
      {
        setting: () => DEFAULT_RELAY,
        enroll: enrollingThrough(fetch),
        onRunNotice,
      },
    ).finally(() => {
      settled = true;
    });
    await untilCalled(fetch);
    await vi.advanceTimersByTimeAsync(DEFAULT_RELAY_DIAL_WAIT_MS - 1);
    expect(settled).toBe(false);
    expect(onRunNotice).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual(WITHOUT_DEFAULT);
    expect(onRunNotice).toHaveBeenCalledExactlyOnceWith(
      DEFAULT_RELAY_NOT_ENROLLED_NOTICE,
    );
  });

  test("a cancelled run stops waiting and says nothing", async () => {
    const cancel = new AbortController();
    const fetch = neverAnsweringFetch();
    const onRunNotice = vi.fn();
    const pending = relayWithDefaultForRun(
      generateSharedSecret(),
      OWN,
      NO_RESTRICTION,
      {
        setting: () => DEFAULT_RELAY,
        enroll: enrollingThrough(fetch),
        signal: cancel.signal,
        dialWaitMs: 60_000,
        onRunNotice,
      },
    );
    await untilCalled(fetch);
    cancel.abort();
    await expect(pending).resolves.toEqual(WITHOUT_DEFAULT);
    expect(onRunNotice).not.toHaveBeenCalled();
  });

  test("a run cancelled before it dials contacts no registrar and says nothing", async () => {
    const cancel = new AbortController();
    cancel.abort();
    const fetch = neverAnsweringFetch();
    const onRunNotice = vi.fn();
    await expect(
      relayWithDefaultForRun(generateSharedSecret(), OWN, NO_RESTRICTION, {
        setting: () => DEFAULT_RELAY,
        enroll: enrollingThrough(fetch),
        signal: cancel.signal,
        onRunNotice,
      }),
    ).resolves.toEqual(WITHOUT_DEFAULT);
    expect(fetch).not.toHaveBeenCalled();
    expect(onRunNotice).not.toHaveBeenCalled();
  });
});

describe("invitationRelayWithDefault", () => {
  test("names the default relay after the own relay, with its registrar", () => {
    expect(
      invitationRelayWithDefault(OWN, DEFAULT_RELAY, NO_RESTRICTION),
    ).toEqual({
      turn: [...OWN.turn, DEFAULT_RELAY.turnUrl],
      stun: [],
      registrar: DEFAULT_RELAY.registrarUrl,
    });
  });

  test("names the default relay alone when there is no own relay", () => {
    expect(
      invitationRelayWithDefault(undefined, DEFAULT_RELAY, NO_RESTRICTION),
    ).toEqual({
      turn: [DEFAULT_RELAY.turnUrl],
      registrar: DEFAULT_RELAY.registrarUrl,
    });
  });

  test("names it once when the own relay already names it, with its registrar", () => {
    const own = { turn: [DEFAULT_RELAY.turnUrl] };
    expect(
      invitationRelayWithDefault(own, DEFAULT_RELAY, NO_RESTRICTION),
    ).toEqual({
      turn: [DEFAULT_RELAY.turnUrl],
      registrar: DEFAULT_RELAY.registrarUrl,
    });
  });

  test("names only the own relay, and no registrar, when the build names no default relay", () => {
    expect(invitationRelayWithDefault(OWN, undefined, NO_RESTRICTION)).toBe(
      OWN,
    );
    expect(
      invitationRelayWithDefault(undefined, undefined, NO_RESTRICTION),
    ).toBeUndefined();
  });

  test("withholds it and its registrar when the locator is full", () => {
    const full = {
      turn: Array.from(
        { length: MAX_RELAY_LOCATOR_URLS },
        (_, index) => `turns:relay-${index}.example.org:443?transport=tcp`,
      ),
    };
    expect(
      invitationRelayWithDefault(full, DEFAULT_RELAY, NO_RESTRICTION),
    ).toBe(full);
  });

  describe("the default WebSocket relay", () => {
    const WEBSOCKET = "wss://wsrelay.example.org/relay";
    const withWebSocket = { ...DEFAULT_RELAY, websocketUrl: WEBSOCKET };

    test("is named beside the default relay's TURN url and registrar", () => {
      expect(
        invitationRelayWithDefault(undefined, withWebSocket, NO_RESTRICTION),
      ).toEqual({
        turn: [DEFAULT_RELAY.turnUrl],
        websocket: WEBSOCKET,
        registrar: DEFAULT_RELAY.registrarUrl,
      });
    });

    test("gives way to a WebSocket relay of this browser's own", () => {
      const own = { ...OWN, websocket: "wss://own.example.org/relay" };
      expect(
        invitationRelayWithDefault(own, withWebSocket, NO_RESTRICTION),
      ).toEqual({
        ...own,
        turn: [...OWN.turn, DEFAULT_RELAY.turnUrl],
        registrar: DEFAULT_RELAY.registrarUrl,
      });
    });

    test("is named with its registrar where this browser's own WebSocket relay is the same url", () => {
      expect(
        invitationRelayWithDefault(
          { websocket: WEBSOCKET },
          withWebSocket,
          NO_RESTRICTION,
        ),
      ).toEqual({
        websocket: WEBSOCKET,
        turn: [DEFAULT_RELAY.turnUrl],
        registrar: DEFAULT_RELAY.registrarUrl,
      });
    });

    test("is named or left out by the allowed relays apart from the TURN url, with the registrar either way", () => {
      expect(
        invitationRelayWithDefault(undefined, withWebSocket, [
          "wsrelay.example.org",
        ]),
      ).toEqual({
        websocket: WEBSOCKET,
        registrar: DEFAULT_RELAY.registrarUrl,
      });
      expect(
        invitationRelayWithDefault(undefined, withWebSocket, [
          "turn.example.org",
        ]),
      ).toEqual({
        turn: [DEFAULT_RELAY.turnUrl],
        registrar: DEFAULT_RELAY.registrarUrl,
      });
    });

    test("is named with its registrar when the locator's TURN list is full", () => {
      const full = {
        turn: Array.from(
          { length: MAX_RELAY_LOCATOR_URLS },
          (_, index) => `turns:relay-${index}.example.org:443?transport=tcp`,
        ),
      };
      expect(
        invitationRelayWithDefault(full, withWebSocket, NO_RESTRICTION),
      ).toEqual({
        ...full,
        websocket: WEBSOCKET,
        registrar: DEFAULT_RELAY.registrarUrl,
      });
    });

    test("a WebSocket relay of this browser's own names no registrar where the default TURN url is left out", () => {
      const own = { websocket: "wss://own.example.org/relay" };
      expect(
        invitationRelayWithDefault(own, withWebSocket, ["own.example.org"]),
      ).toEqual(own);
    });

    test("an exchange id beside this browser's own WebSocket relay is kept", () => {
      const own = {
        websocket: "wss://own.example.org/relay",
        websocketExchangeId: "own-weekly",
      };
      expect(
        invitationRelayWithDefault(own, withWebSocket, NO_RESTRICTION),
      ).toEqual({
        ...own,
        turn: [DEFAULT_RELAY.turnUrl],
        registrar: DEFAULT_RELAY.registrarUrl,
      });
    });
  });

  test("names the registrar beside either default url only, whatever other WebSocket relay url it names", () => {
    const WEBSOCKET = "wss://wsrelay.example.org/relay";
    const OWN_WEBSOCKET = "wss://own.example.org/relay";
    const fullTurn = Array.from(
      { length: MAX_RELAY_LOCATOR_URLS },
      (_, index) => `turns:relay-${index}.example.org:443?transport=tcp`,
    );
    const ownRelays = [
      undefined,
      OWN,
      { websocket: OWN_WEBSOCKET },
      { ...OWN, websocket: OWN_WEBSOCKET, websocketExchangeId: "own-weekly" },
      { websocket: WEBSOCKET },
      { turn: fullTurn, websocket: OWN_WEBSOCKET },
      { turn: fullTurn },
    ];
    const defaultRelays: ReadonlyArray<{
      turnUrl: string;
      registrarUrl: string;
      websocketUrl?: string;
    }> = [DEFAULT_RELAY, { ...DEFAULT_RELAY, websocketUrl: WEBSOCKET }];
    const allowedRelaysCases = [
      NO_RESTRICTION,
      ["turn.example.org"],
      ["wsrelay.example.org"],
      ["own.example.org", "own-relay.example.org"],
    ];
    for (const ownRelay of ownRelays)
      for (const defaultRelay of defaultRelays)
        for (const allowedRelays of allowedRelaysCases) {
          const relay = invitationRelayWithDefault(
            ownRelay,
            defaultRelay,
            allowedRelays,
          );
          const label = JSON.stringify({
            ownRelay,
            defaultRelay,
            allowedRelays,
          });
          const namesDefaultUrl =
            (relay?.turn ?? []).includes(defaultRelay.turnUrl) ||
            (defaultRelay.websocketUrl !== undefined &&
              relay?.websocket === defaultRelay.websocketUrl);
          expect(relay?.registrar, label).toBe(
            namesDefaultUrl ? defaultRelay.registrarUrl : undefined,
          );
        }
  });
});
