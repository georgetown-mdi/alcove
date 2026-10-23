import { describe, expect, test, vi } from "vitest";

import { generateSharedSecret } from "@alcove/core";

import {
  DEFAULT_RELAY_NOT_ENROLLED_NOTICE,
  defaultRelayForRun,
  defaultRelayInUse,
  invitationRelayWithDefault,
} from "@psi/transport/defaultRelay";
import { relayPlanForRun, runListsRelay } from "@psi/transport/runRelayPlan";

import type { OwnRelay, RelayUrls } from "@psi/transport/ownRelaySetting";
import type { DefaultRelayBuild } from "@utils/clientConfig";
import type { enrollRelayKeyWithinWait } from "@alcove/core";

// A build offering its default relay switched off (`opt-in`) lists it only
// once this browser turns it on, or, url by url, where the invitation a run
// accepted names it; a build turning it on (`on`) lists it in every run.

const SITE = {
  turnUrl: "turns:site.example.com:443?transport=tcp",
  registrarUrl: "https://registrar.site.example.com",
  websocketUrl: "wss://site.example.com/relay",
};
const PARTNER_URL = "turn:partner.example.net:3478";

const NONE: DefaultRelayBuild = { kind: "none" };
const OPT_IN: DefaultRelayBuild = { kind: "opt-in", relay: SITE };
const ON: DefaultRelayBuild = { kind: "on", relay: SITE };

const switched = (on: boolean) => () => on;

function enrolling() {
  return vi.fn(() =>
    Promise.resolve({ kind: "enrolled" as const, lapsesAt: "x" }),
  );
}

describe("the default relay in use", () => {
  test.each([
    ["no relay", NONE, false, undefined],
    ["no relay, the switch on", NONE, true, undefined],
    ["offered and off", OPT_IN, false, undefined],
    ["offered and turned on", OPT_IN, true, SITE],
    ["on", ON, false, SITE],
  ])("%s", (_state, build, on, expected) => {
    expect(defaultRelayInUse(() => build, switched(on))).toEqual(expected);
  });

  test("an invitation created with the relay off names neither it nor its registrar", () => {
    const own = { turn: [PARTNER_URL] };
    const relay = invitationRelayWithDefault(
      own,
      defaultRelayInUse(() => OPT_IN, switched(false)),
      undefined,
    );
    expect(relay).toEqual(own);
  });

  test("an invitation created with the relay turned on names it, its registrar and its WebSocket relay", () => {
    expect(
      invitationRelayWithDefault(
        undefined,
        defaultRelayInUse(() => OPT_IN, switched(true)),
        undefined,
      ),
    ).toEqual({
      turn: [SITE.turnUrl],
      registrar: SITE.registrarUrl,
      websocket: SITE.websocketUrl,
    });
  });
});

describe("defaultRelayForRun", () => {
  const TURN_ONLY = { turnUrl: SITE.turnUrl, registrarUrl: SITE.registrarUrl };

  test.each([
    ["its TURN url alone", { turn: [PARTNER_URL, SITE.turnUrl] }, TURN_ONLY],
    [
      "its TURN url beside another WebSocket relay",
      { turn: [SITE.turnUrl], websocket: "wss://partner.example.net/relay" },
      TURN_ONLY,
    ],
    [
      "its TURN url and its WebSocket relay url",
      { turn: [SITE.turnUrl], websocket: SITE.websocketUrl },
      SITE,
    ],
  ])(
    "an invitation naming %s puts what it names in the run",
    (_case, invitation, relay) => {
      expect(
        defaultRelayForRun(invitation, () => OPT_IN, switched(false)),
      ).toEqual({ kind: "invited", relay });
    },
  );

  test("an invitation naming its WebSocket relay url alone leaves it off", () => {
    expect(
      defaultRelayForRun(
        { websocket: SITE.websocketUrl },
        () => OPT_IN,
        switched(false),
      ),
    ).toEqual({ kind: "off", relay: SITE });
  });

  test("an invitation naming other relays, or none, leaves it off", () => {
    for (const invitation of [{ turn: [PARTNER_URL] }, undefined])
      expect(
        defaultRelayForRun(invitation, () => OPT_IN, switched(false)),
      ).toEqual({ kind: "off", relay: SITE });
  });

  test.each([
    [
      "its TURN url",
      { turn: [PARTNER_URL, SITE.turnUrl], stun: [] },
      TURN_ONLY,
    ],
    [
      "its TURN url and its WebSocket relay url",
      { turn: [SITE.turnUrl], stun: [], websocket: SITE.websocketUrl },
      SITE,
    ],
  ])(
    "this browser's own relay naming %s puts what it names in the run",
    (_case, own, relay) => {
      expect(
        defaultRelayForRun(undefined, () => OPT_IN, switched(false), own),
      ).toEqual({ kind: "own", relay });
    },
  );

  test("this browser's own relay naming its WebSocket relay url alone leaves it off", () => {
    expect(
      defaultRelayForRun(undefined, () => OPT_IN, switched(false), {
        turn: [PARTNER_URL],
        stun: [],
        websocket: SITE.websocketUrl,
      }),
    ).toEqual({ kind: "off", relay: SITE });
  });

  test("an invitation naming its TURN url is read before this browser's own relay", () => {
    expect(
      defaultRelayForRun(
        { turn: [SITE.turnUrl] },
        () => OPT_IN,
        switched(false),
        { turn: [SITE.turnUrl], stun: [], websocket: SITE.websocketUrl },
      ),
    ).toEqual({ kind: "invited", relay: TURN_ONLY });
  });

  test("turned on, or on in the build, it is in use whatever the invitation names", () => {
    expect(defaultRelayForRun(undefined, () => OPT_IN, switched(true))).toEqual(
      { kind: "in-use", relay: SITE },
    );
    expect(defaultRelayForRun(undefined, () => ON, switched(false))).toEqual({
      kind: "in-use",
      relay: SITE,
    });
    expect(defaultRelayForRun(undefined, () => NONE, switched(true))).toEqual({
      kind: "none",
    });
  });
});

describe("relayPlanForRun on a build offering the relay switched off", () => {
  const plan = (
    invitationRelay: RelayUrls | undefined,
    on: boolean,
    allowedRelays?: Array<string>,
    build: DefaultRelayBuild = OPT_IN,
  ) => {
    const enroll = enrolling();
    return relayPlanForRun(
      generateSharedSecret(),
      invitationRelay,
      allowedRelays,
      {
        readOwn: () => ({ kind: "none" }),
        build: () => build,
        switchedOn: switched(on),
        enroll,
      },
    ).then((result) => ({ result, enroll }));
  };

  test("off, the run neither lists the relay nor enrolls at its registrar, and says it is off", async () => {
    const { result, enroll } = await plan(undefined, false);
    expect(enroll).not.toHaveBeenCalled();
    expect(result).toEqual({
      relaysLeftOut: [],
      websocketRelays: [],
      defaultRelayOff: true,
    });
  });

  test("turned on, the run enrolls at its registrar and lists it", async () => {
    const { result, enroll } = await plan(undefined, true);
    expect(enroll).toHaveBeenCalledOnce();
    expect(enroll.mock.calls[0]).toEqual([
      expect.objectContaining({ registrarUrl: SITE.registrarUrl }),
      expect.anything(),
    ]);
    expect(result.relay?.turn).toEqual([SITE.turnUrl]);
    expect(result.websocketRelays.map((relay) => relay.url)).toEqual([
      SITE.websocketUrl,
    ]);
    expect(result).not.toHaveProperty("defaultRelayOff");
  });

  test("on in the build, the run lists it with the switch off", async () => {
    const { result, enroll } = await plan(undefined, false, undefined, ON);
    expect(enroll).toHaveBeenCalledOnce();
    expect(result.relay?.turn).toEqual([SITE.turnUrl]);
  });

  test("off, an accepted invitation naming the relay's TURN url alone puts that url in the run, enrolled, and not its WebSocket relay", async () => {
    const { result, enroll } = await plan(
      { turn: [PARTNER_URL, SITE.turnUrl] },
      false,
    );
    expect(enroll).toHaveBeenCalledOnce();
    expect(result.relay?.turn).toEqual([PARTNER_URL, SITE.turnUrl]);
    expect(result.websocketRelays).toEqual([]);
    expect(result).not.toHaveProperty("defaultRelayOff");
  });

  test("off, an accepted invitation naming both of the relay's urls puts both in the run, enrolled", async () => {
    const { result, enroll } = await plan(
      { turn: [SITE.turnUrl], websocket: SITE.websocketUrl },
      false,
    );
    expect(enroll).toHaveBeenCalledOnce();
    expect(result.relay?.turn).toEqual([SITE.turnUrl]);
    expect(result.websocketRelays.map((relay) => relay.url)).toEqual([
      SITE.websocketUrl,
    ]);
  });

  test("off, an accepted invitation naming the relay's WebSocket relay url alone lists that url, and neither enrolls nor lists the TURN url", async () => {
    const { result, enroll } = await plan(
      { turn: [PARTNER_URL], websocket: SITE.websocketUrl },
      false,
    );
    expect(enroll).not.toHaveBeenCalled();
    expect(result.relay?.turn).toEqual([PARTNER_URL]);
    expect(result.websocketRelays.map((relay) => relay.url)).toEqual([
      SITE.websocketUrl,
    ]);
    expect(result.defaultRelayOff).toBe(true);
  });

  test("off, allowed relays that keep the relay's TURN url still say it is off", async () => {
    const { result } = await plan(undefined, false, ["site.example.com"]);
    expect(result.defaultRelayOff).toBe(true);
  });

  test("off, allowed relays that leave out the relay's TURN url do not say it is off", async () => {
    const { result, enroll } = await plan(undefined, false, [
      "partner.example.net",
    ]);
    expect(enroll).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("defaultRelayOff");
  });

  describe("a build whose WebSocket relay is on another host than its TURN relay", () => {
    const SPLIT_SITE = {
      ...SITE,
      websocketUrl: "wss://relay-socket.example.com/relay",
    };
    const SPLIT: DefaultRelayBuild = { kind: "opt-in", relay: SPLIT_SITE };

    test("off, allowed relays that keep only the relay's WebSocket relay url still say it is off", async () => {
      const { result, enroll } = await plan(
        undefined,
        false,
        ["relay-socket.example.com"],
        SPLIT,
      );
      expect(enroll).not.toHaveBeenCalled();
      expect(result.defaultRelayOff).toBe(true);
    });

    test("off, allowed relays that keep neither of the relay's urls do not say it is off", async () => {
      const { result } = await plan(
        undefined,
        false,
        ["partner.example.net"],
        SPLIT,
      );
      expect(result).not.toHaveProperty("defaultRelayOff");
    });
  });

  test("off, the acceptor's allowed relays still leave out the relay an invitation names", async () => {
    const { result, enroll } = await plan(
      { turn: [PARTNER_URL, SITE.turnUrl] },
      false,
      ["partner.example.net"],
    );
    expect(enroll).not.toHaveBeenCalled();
    expect(result.relay?.turn).toEqual([PARTNER_URL]);
    expect(result.relaysLeftOut).toEqual([SITE.turnUrl]);
    expect(result.websocketRelays).toEqual([]);
  });
});

describe("relayPlanForRun with this browser's own relay naming the relay, switched off", () => {
  const ownPlan = (
    own: OwnRelay,
    options: {
      allowedRelays?: Array<string>;
      enroll?: typeof enrollRelayKeyWithinWait;
    } = {},
  ) => {
    const enroll = vi.fn<typeof enrollRelayKeyWithinWait>(
      options.enroll ??
        (() => Promise.resolve({ kind: "enrolled", lapsesAt: "x" })),
    );
    const onRunNotice = vi.fn();
    return relayPlanForRun(
      generateSharedSecret(),
      undefined,
      options.allowedRelays,
      {
        readOwn: () => ({ kind: "set", relay: own }),
        build: () => OPT_IN,
        switchedOn: switched(false),
        enroll,
        onRunNotice,
      },
    ).then((result) => ({ result, enroll, onRunNotice }));
  };
  const refusing: typeof enrollRelayKeyWithinWait = () =>
    Promise.resolve({ kind: "failed", detail: "HTTP 409" });

  test("the run enrolls at its registrar before it lists the TURN url, and does not say it is off", async () => {
    const { result, enroll } = await ownPlan({
      turn: [SITE.turnUrl, PARTNER_URL],
      stun: [],
    });
    expect(enroll).toHaveBeenCalledOnce();
    expect(enroll.mock.calls[0]).toEqual([
      expect.objectContaining({ registrarUrl: SITE.registrarUrl }),
      expect.anything(),
    ]);
    expect(result.relay?.turn).toEqual([PARTNER_URL, SITE.turnUrl]);
    expect(result.websocketRelays).toEqual([]);
    expect(result).not.toHaveProperty("defaultRelayOff");
  });

  test("an enrollment that fails leaves the TURN url out and says so", async () => {
    const { result, enroll, onRunNotice } = await ownPlan(
      { turn: [SITE.turnUrl], stun: [] },
      { enroll: refusing },
    );
    expect(enroll).toHaveBeenCalledOnce();
    expect(result.relay).toBeUndefined();
    expect(onRunNotice).toHaveBeenCalledWith(DEFAULT_RELAY_NOT_ENROLLED_NOTICE);
  });

  test("naming both of the relay's urls lists both once enrolled", async () => {
    const { result } = await ownPlan({
      turn: [SITE.turnUrl],
      stun: [],
      websocket: SITE.websocketUrl,
    });
    expect(result.relay?.turn).toEqual([SITE.turnUrl]);
    expect(result.websocketRelays.map((relay) => relay.url)).toEqual([
      SITE.websocketUrl,
    ]);
  });

  test("allowed relays that leave out the TURN url leave it out without enrolling", async () => {
    const { result, enroll } = await ownPlan(
      { turn: [SITE.turnUrl, PARTNER_URL], stun: [] },
      { allowedRelays: ["partner.example.net"] },
    );
    expect(enroll).not.toHaveBeenCalled();
    expect(result.relay?.turn).toEqual([PARTNER_URL]);
    expect(result.relaysLeftOut).toEqual([SITE.turnUrl]);
  });
});

describe("runListsRelay", () => {
  const lists = (
    invitationRelay: RelayUrls | undefined,
    own: OwnRelay | undefined,
    build: DefaultRelayBuild = NONE,
    on = false,
  ) =>
    runListsRelay(invitationRelay, {
      readOwn: () =>
        own === undefined ? { kind: "none" } : { kind: "set", relay: own },
      build: () => build,
      switchedOn: switched(on),
    });

  test("no relay of this browser's, the invitation's, or the site's lists none", () => {
    expect(lists(undefined, undefined)).toBe(false);
    expect(lists(undefined, undefined, OPT_IN)).toBe(false);
  });

  test("STUN servers are not relays", () => {
    expect(
      lists({ stun: ["stun:stun.example.org"] }, { turn: [], stun: ["x"] }),
    ).toBe(false);
  });

  test.each([
    ["this browser's TURN url", undefined, { turn: [PARTNER_URL], stun: [] }],
    [
      "this browser's WebSocket relay",
      undefined,
      { turn: [], stun: [], websocket: "wss://own.example.org/relay" },
    ],
    ["the invitation's TURN url", { turn: [PARTNER_URL] }, undefined],
    [
      "the invitation's WebSocket relay",
      { websocket: "wss://partner.example.net/relay" },
      undefined,
    ],
  ])("%s lists a relay", (_case, invitation, own) => {
    expect(lists(invitation, own)).toBe(true);
  });

  test("the site's relay lists where the run uses it", () => {
    expect(lists(undefined, undefined, ON)).toBe(true);
    expect(lists(undefined, undefined, OPT_IN, true)).toBe(true);
    expect(lists({ turn: [SITE.turnUrl] }, undefined, OPT_IN)).toBe(true);
  });

  test("a given default relay setting replaces the build's", () => {
    expect(
      runListsRelay(undefined, {
        readOwn: () => ({ kind: "none" }),
        build: () => ON,
        setting: () => undefined,
      }),
    ).toBe(false);
    expect(
      runListsRelay(undefined, {
        readOwn: () => ({ kind: "none" }),
        build: () => NONE,
        setting: () => SITE,
      }),
    ).toBe(true);
  });

  test("an unreadable own setting lists nothing", () => {
    expect(
      runListsRelay(undefined, {
        readOwn: () => ({ kind: "unreadable" }),
        build: () => NONE,
      }),
    ).toBe(false);
  });
});
