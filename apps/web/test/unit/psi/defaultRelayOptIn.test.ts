import { describe, expect, test, vi } from "vitest";

import { generateSharedSecret } from "@alcove/core";

import {
  defaultRelayForRun,
  defaultRelayInUse,
  invitationRelayWithDefault,
} from "@psi/transport/defaultRelay";
import { relayPlanForRun } from "@psi/transport/runRelayPlan";

import type { DefaultRelayBuild } from "@utils/clientConfig";

// A build offering its default relay switched off (`opt-in`) lists it only
// once this browser turns it on, or where the invitation a run accepted names
// it; a build turning it on (`on`) lists it in every run.

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
  test.each([
    ["names its TURN url", { turn: [PARTNER_URL, SITE.turnUrl] }],
    ["names its WebSocket relay alone", { websocket: SITE.websocketUrl }],
  ])("an invitation that %s puts it in the run", (_case, invitation) => {
    expect(
      defaultRelayForRun(invitation, () => OPT_IN, switched(false)),
    ).toEqual({ kind: "invited", relay: SITE });
  });

  test("an invitation naming other relays, or none, leaves it off", () => {
    for (const invitation of [{ turn: [PARTNER_URL] }, undefined])
      expect(
        defaultRelayForRun(invitation, () => OPT_IN, switched(false)),
      ).toEqual({ kind: "off" });
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
    invitationRelay: { turn: Array<string> } | undefined,
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

  test("off, an accepted invitation naming the relay puts it in the run, enrolled", async () => {
    const { result, enroll } = await plan(
      { turn: [PARTNER_URL, SITE.turnUrl] },
      false,
    );
    expect(enroll).toHaveBeenCalledOnce();
    expect(result.relay?.turn).toEqual([PARTNER_URL, SITE.turnUrl]);
    expect(result).not.toHaveProperty("defaultRelayOff");
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
