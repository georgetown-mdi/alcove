import { describe, expect, test } from "vitest";

import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  INVITATION_RELAY_REFUSES_UNTIL_ENROLLED,
  NO_RELAY_CANDIDATE_GATHERED,
  RELAY_NOT_REACHED_REMEDY,
  RELAY_REFUSES_UNTIL_ENROLLED_AT_REGISTRAR,
  TURN_RELAY_CREDENTIAL_REFUSED_MEANING,
  TURN_RELAY_NOT_REACHED_MEANING,
  TURN_RELAY_NO_RELAYED_PATH_MEANING,
  WEBSOCKET_RELAY_NOT_REACHED_ACTION,
  WEBSOCKET_RELAY_NOT_REACHED_MEANING,
  WEBSOCKET_RELAY_NO_RELAYED_PATH_MEANING,
  sanitizeForDisplay,
  webSocketRelayRefusalWords,
} from "@alcove/core";

import {
  exchangeRelayCheckLineShown,
  exchangeRelayCheckOffered,
  exchangeRelayCheckStatement,
  exchangeRelayCheckVerdict,
} from "../../../src/exchange/exchangeRelayCheckModel.js";
import { defaultRelayNotEnrolledNotice } from "../../../src/psi/transport/defaultRelayRefusal.js";

import type { ExchangeRelayCheckLine } from "../../../src/psi/transport/exchangeRelayCheck.js";
import type { RunRelayHosts } from "../../../src/psi/transport/runRelayPlan.js";

// The words of the web check of an exchange's relays: each outcome's
// message and remedy, taken from the words `alcove doctor relay` and the
// console use for the same cause except where the remedy is a web control,
// and every url escaped and bounded.

const ENROLL_OWN = "Enroll this exchange under Relay registration below.";
const REMOVE_OWN = "Remove this relay from Connection settings.";
const ASK_PARTNER = "Ask your partner to enroll this exchange at their relay.";

const OWN_TURN = "turns:own-relay.example.org:443?transport=tcp";
const INVITED_TURN = "turn:invited-relay.example.org:3478";
const DEFAULT_TURN = "turns:turn.example.org:443?transport=tcp";
const OWN_WEBSOCKET = "wss://own-relay.example.org/relay";
const INVITED_WEBSOCKET = "wss://invited-relay.example.org/relay";

const HOSTS: RunRelayHosts = {
  registrar: "https://registrar.example.org",
  turn: [OWN_TURN, INVITED_TURN, DEFAULT_TURN],
  websocket: [OWN_WEBSOCKET, INVITED_WEBSOCKET],
  listedOnceEnrolled: [DEFAULT_TURN],
  leftOut: [],
};

const CONTEXT = {
  hosts: HOSTS,
  invitationRelay: {
    turn: [INVITED_TURN],
    websocket: INVITED_WEBSOCKET,
    websocketExchangeId: "c".repeat(32),
  },
};

function shown(line: ExchangeRelayCheckLine) {
  return exchangeRelayCheckLineShown(line, CONTEXT);
}

describe("each outcome's message and remedy", () => {
  test("a TURN relay that carries the message works", () => {
    expect(shown({ relay: "turn", url: OWN_TURN, result: "works" })).toEqual({
      url: OWN_TURN,
      works: true,
      summary:
        "a message passed through this relay between two connections " +
        "under this exchange's credential.",
    });
  });

  test("a TURN relay not reached takes the CLI's meaning and remedy", () => {
    expect(
      shown({ relay: "turn", url: OWN_TURN, result: "not_reached" }),
    ).toEqual({
      url: OWN_TURN,
      works: false,
      cause: "not_reached",
      summary: `${NO_RELAY_CANDIDATE_GATHERED} within 30 s.`,
      meaning: TURN_RELAY_NOT_REACHED_MEANING,
      action: RELAY_NOT_REACHED_REMEDY,
    });
  });

  test.each([
    [
      OWN_TURN,
      "A relay that takes enrolled keys refuses it until this exchange is enrolled there.",
      REMOVE_OWN,
    ],
    [INVITED_TURN, INVITATION_RELAY_REFUSES_UNTIL_ENROLLED, ASK_PARTNER],
    [
      DEFAULT_TURN,
      "T" + RELAY_REFUSES_UNTIL_ENROLLED_AT_REGISTRAR.slice(1),
      RELAY_NOT_REACHED_REMEDY,
    ],
  ])(
    "a refused credential at %s does not work, with a reason and an action for that source",
    (url, reason, action) => {
      const line = shown({ relay: "turn", url, result: "credential_refused" });
      expect(line).toEqual({
        url,
        works: false,
        cause: "credential_refused",
        summary: "the relay refused this exchange's credential.",
        meaning: `${TURN_RELAY_CREDENTIAL_REFUSED_MEANING} ${reason}`,
        action,
      });
      expect(line.meaning).not.toContain("alcove");
    },
  );

  test("a refused credential at the user's own TURN relay points at Relay registration where the page shows it", () => {
    const line = exchangeRelayCheckLineShown(
      { relay: "turn", url: OWN_TURN, result: "credential_refused" },
      { ...CONTEXT, relayRegistrationOffered: true },
    );
    expect(line.action).toBe(ENROLL_OWN);
  });

  test.each([
    ["turn", { result: "not_started" }],
    ["websocket", { result: { kind: "not_started" } }],
  ] as const)(
    "a %s relay whose request threw says the check did not start, not that it waited",
    (relay, result) => {
      const line = shown({
        relay,
        url: relay === "turn" ? OWN_TURN : OWN_WEBSOCKET,
        ...result,
      } as ExchangeRelayCheckLine);
      expect(line).toMatchObject({
        works: false,
        cause: "not_reached",
        summary: "the check could not start a connection to this relay.",
        action: "Check that this relay's url is correct.",
      });
      expect(line.summary).not.toMatch(/within/);
      expect(line.meaning).toBeUndefined();
    },
  );

  test("a TURN relay with no relayed path does not work", () => {
    expect(
      shown({ relay: "turn", url: OWN_TURN, result: "no_relayed_path" }),
    ).toMatchObject({
      works: false,
      cause: "no_relayed_path",
      meaning: TURN_RELAY_NO_RELAYED_PATH_MEANING,
      action: RELAY_NOT_REACHED_REMEDY,
    });
  });

  test("a default relay that did not enroll the exchange is not enrolled, in the web run's own words", () => {
    const refusal = { cause: "rate-limit" as const, retryAfterSeconds: 600 };
    expect(
      shown({ relay: "turn", url: DEFAULT_TURN, notEnrolled: refusal }),
    ).toMatchObject({
      works: false,
      cause: "not_enrolled",
      meaning: RELAY_REFUSES_UNTIL_ENROLLED_AT_REGISTRAR,
      action: defaultRelayNotEnrolledNotice(refusal),
    });
  });

  test("a partner's WebSocket relay that holds no key is not enrolled, and the partner is asked to enroll", () => {
    const line = shown({
      relay: "websocket",
      url: INVITED_WEBSOCKET,
      result: {
        kind: "refused",
        closeCode: 4003,
        proofRemadeOnRelayClock: false,
      },
    });
    const words = webSocketRelayRefusalWords(4003, {
      enrollsAtInvitationRegistrar: false,
      partnersUnderInvitationExchangeId: true,
      enrollmentFailed: false,
      proofRemadeOnRelayClock: false,
    });
    expect(line).toEqual({
      url: INVITED_WEBSOCKET,
      works: false,
      cause: "not_enrolled",
      summary:
        "not admitted; the relay holds no key for this exchange (close code 4003).",
      meaning: words.meaning,
      action: ASK_PARTNER,
    });
  });

  describe("the user's own WebSocket relay holding no key or another key", () => {
    const refused = (closeCode: number): ExchangeRelayCheckLine => ({
      relay: "websocket",
      url: OWN_WEBSOCKET,
      result: { kind: "refused", closeCode, proofRemadeOnRelayClock: false },
    });

    test.each([
      [4003, ENROLL_OWN],
      [
        4004,
        "Under Relay registration below, enter the relay-owner token, tick " +
          "the box to replace the key, and select Enroll.",
      ],
    ])(
      "a %i points at Relay registration where the page shows it",
      (closeCode, action) => {
        expect(
          exchangeRelayCheckLineShown(refused(closeCode), {
            ...CONTEXT,
            relayRegistrationOffered: true,
          }),
        ).toMatchObject({
          cause: closeCode === 4003 ? "not_enrolled" : "credential_refused",
          meaning: webSocketRelayRefusalWords(closeCode, {
            enrollsAtInvitationRegistrar: false,
            partnersUnderInvitationExchangeId: false,
            enrollmentFailed: false,
          }).meaning,
          action,
        });
      },
    );

    test.each([4003, 4004])(
      "a %i elsewhere says to remove the relay, or turn on this site's relay server where that would add it",
      (closeCode) => {
        expect(shown(refused(closeCode)).action).toBe(REMOVE_OWN);
        expect(
          exchangeRelayCheckLineShown(refused(closeCode), {
            ...CONTEXT,
            hosts: { ...HOSTS, defaultRelayOff: true },
          }).action,
        ).toBe(
          "Remove this relay from Connection settings, or turn on this " +
            "site's relay server there.",
        );
      },
    );
  });

  describe("a 4003 at this site's default WebSocket relay", () => {
    const DEFAULT_WEBSOCKET = "wss://turn.example.org/relay";
    const siteHosts: RunRelayHosts = {
      registrar: "https://registrar.example.org",
      turn: [DEFAULT_TURN],
      websocket: [DEFAULT_WEBSOCKET],
      listedOnceEnrolled: [DEFAULT_TURN, DEFAULT_WEBSOCKET],
      leftOut: [],
    };
    const refused: ExchangeRelayCheckLine = {
      relay: "websocket",
      url: DEFAULT_WEBSOCKET,
      result: {
        kind: "refused",
        closeCode: 4003,
        proofRemadeOnRelayClock: false,
      },
    };
    const words = (enrollsAtInvitationRegistrar: boolean) =>
      webSocketRelayRefusalWords(4003, {
        enrollsAtInvitationRegistrar,
        partnersUnderInvitationExchangeId: false,
        enrollmentFailed: false,
        proofRemadeOnRelayClock: false,
      });

    test.each([
      ["no invitation", undefined],
      ["an invitation naming no registrar", { turn: [INVITED_TURN] }],
      [
        "an invitation naming another registrar",
        { turn: [INVITED_TURN], registrar: "https://elsewhere.example.org" },
      ],
    ])(
      "does not send the user to the partner's registrar where %s names this site's",
      (_, invitationRelay) => {
        const line = exchangeRelayCheckLineShown(refused, {
          hosts: siteHosts,
          ...(invitationRelay !== undefined && { invitationRelay }),
        });
        expect(line.action).toBe("Check again.");
        expect(line.action).not.toBe(words(true).action);
      },
    );

    test("keeps the partner's registrar advice where the invitation names this site's registrar", () => {
      const line = exchangeRelayCheckLineShown(refused, {
        hosts: siteHosts,
        invitationRelay: {
          turn: [DEFAULT_TURN],
          websocket: DEFAULT_WEBSOCKET,
          registrar: "https://registrar.example.org",
        },
      });
      expect(line.action).toBe(words(true).action);
    });
  });

  test.each([
    [4004, "credential_refused"],
    [4005, "credential_refused"],
    [4008, "not_reached"],
  ])("a WebSocket relay's %i refusal does not work", (closeCode, cause) => {
    expect(
      shown({
        relay: "websocket",
        url: OWN_WEBSOCKET,
        result: { kind: "refused", closeCode, proofRemadeOnRelayClock: false },
      }),
    ).toMatchObject({ works: false, cause });
  });

  test("a WebSocket relay not reached, or with no relayed path, does not work", () => {
    expect(
      shown({
        relay: "websocket",
        url: OWN_WEBSOCKET,
        result: { kind: "not_reached" },
      }),
    ).toMatchObject({
      works: false,
      cause: "not_reached",
      meaning: WEBSOCKET_RELAY_NOT_REACHED_MEANING,
      action: WEBSOCKET_RELAY_NOT_REACHED_ACTION,
    });
    expect(
      shown({
        relay: "websocket",
        url: OWN_WEBSOCKET,
        result: { kind: "no_relayed_path" },
      }),
    ).toMatchObject({
      works: false,
      cause: "no_relayed_path",
      meaning: WEBSOCKET_RELAY_NO_RELAYED_PATH_MEANING,
      action: RELAY_NOT_REACHED_REMEDY,
    });
  });
});

describe("the verdict", () => {
  const works = shown({ relay: "turn", url: OWN_TURN, result: "works" });
  const refused = shown({
    relay: "turn",
    url: OWN_TURN,
    result: "credential_refused",
  });

  test("a refused credential is never counted as a relay that works", () => {
    expect(refused.works).toBe(false);
    expect(exchangeRelayCheckVerdict([refused])).toMatch(
      /^No relay this exchange lists works, so the exchange will not get through/,
    );
  });

  test("says the exchange will get through where a relay works", () => {
    expect(exchangeRelayCheckVerdict([works])).toMatch(
      /^Every relay this exchange lists works, so the exchange will get through/,
    );
    expect(exchangeRelayCheckVerdict([works, refused])).toMatch(
      /^At least one relay this exchange lists works/,
    );
  });
});

describe("a partner-named url where it is shown", () => {
  const hostile = `turn:relay.example.org\u202e\u0000:3478?${"x".repeat(1100)}`;

  test("is escaped and bounded on the host statement", () => {
    const statement = exchangeRelayCheckStatement({
      turn: [hostile],
      websocket: [],
      listedOnceEnrolled: [],
      leftOut: [hostile],
    });
    const hosts = [
      ...statement.contacted,
      ...(statement.notContacted?.hosts ?? []),
    ];
    expect(hosts).toHaveLength(2);
    for (const { host } of hosts) {
      expect(host).toBe(sanitizeForDisplay(hostile));
      expect(host).not.toContain("\u202e");
      expect(host).not.toContain("\u0000");
      expect(host.length).toBeLessThanOrEqual(DEFAULT_MAX_DISPLAY_LENGTH + 20);
    }
  });

  test("is escaped and bounded on a verdict line", () => {
    const line = exchangeRelayCheckLineShown(
      { relay: "turn", url: hostile, result: "credential_refused" },
      { hosts: { ...HOSTS, turn: [hostile] } },
    );
    expect(line.url).toBe(sanitizeForDisplay(hostile));
    expect(line.url).not.toContain("\u202e");
  });
});

describe("the offer", () => {
  test("is made only where a run lists a relay", () => {
    expect(
      exchangeRelayCheckOffered({
        turn: [],
        websocket: [],
        listedOnceEnrolled: [],
        leftOut: [OWN_TURN],
      }),
    ).toBe(false);
    expect(exchangeRelayCheckOffered(HOSTS)).toBe(true);
  });

  test("names the registrar and every relay before any contact, and nothing else", () => {
    const statement = exchangeRelayCheckStatement(HOSTS);
    expect(statement.contacted.map(({ host }) => host)).toEqual([
      "https://registrar.example.org",
      OWN_TURN,
      INVITED_TURN,
      DEFAULT_TURN,
      OWN_WEBSOCKET,
      INVITED_WEBSOCKET,
    ]);
    expect(statement.notContacted).toBeUndefined();
    expect(statement.closing).toBe(
      "It contacts nothing else: not the coordination server, and no STUN server.",
    );
  });
});
