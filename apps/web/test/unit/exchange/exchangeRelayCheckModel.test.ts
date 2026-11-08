import { describe, expect, test } from "vitest";

import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  RELAY_NOT_REACHED_REMEDY,
  TURN_RELAY_CREDENTIAL_REFUSED_MEANING,
  TURN_RELAY_NO_RELAYED_PATH_MEANING,
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

  test("a TURN relay not reached takes the CLI's remedy, in the web's words for this computer", () => {
    expect(
      shown({ relay: "turn", url: OWN_TURN, result: "not_reached" }),
    ).toEqual({
      url: OWN_TURN,
      works: false,
      cause: "not_reached",
      summary: "no relayed connection was made within 30 s.",
      meaning:
        "nothing on this computer reached this relay, the relay refused " +
        "the credential, or it presented a certificate this computer does " +
        "not trust; the reason is not reported, so the check cannot tell " +
        "which.",
      action: RELAY_NOT_REACHED_REMEDY,
    });
  });

  test.each([
    [OWN_TURN, "The relay may need this exchange enrolled first.", REMOVE_OWN],
    [
      INVITED_TURN,
      "This relay needs this exchange enrolled first.",
      ASK_PARTNER,
    ],
    [
      DEFAULT_TURN,
      "This relay needs this exchange enrolled first.",
      "Check again later.",
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
      expect(line.meaning).not.toContain("registrar");
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
    ["turn", OWN_TURN, "Correct this url in Connection settings."],
    ["turn", INVITED_TURN, "Ask your partner to check this relay's url."],
    ["turn", DEFAULT_TURN, "Check again later."],
    ["websocket", OWN_WEBSOCKET, "Correct this url in Connection settings."],
    [
      "websocket",
      INVITED_WEBSOCKET,
      "Ask your partner to check this relay's url.",
    ],
  ] as const)(
    "a %s relay at %s whose request threw says the check did not start, and what to do for that relay",
    (relay, url, action) => {
      const line = shown(
        relay === "turn"
          ? { relay, url, result: "not_started" }
          : { relay, url, result: { kind: "not_started" } },
      );
      expect(line).toMatchObject({
        works: false,
        cause: "not_reached",
        summary: "the check could not start a connection to this relay.",
        action,
      });
      expect(line.summary).not.toMatch(/within/);
      expect(line.meaning).toBeUndefined();
    },
  );

  test("a TURN credential that could not be made says so, and asks for a reload rather than a url change", () => {
    for (const url of [OWN_TURN, INVITED_TURN, DEFAULT_TURN])
      expect(
        shown({ relay: "turn", url, result: "credential_not_made" }),
      ).toEqual({
        url,
        works: false,
        cause: "not_reached",
        summary:
          "this browser could not make this exchange's relay credential.",
        action: "Reload this page, then check again.",
      });
  });

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
      meaning: "this relay needs this exchange enrolled first.",
      action: defaultRelayNotEnrolledNotice(refusal),
    });
  });

  test.each([
    [
      4003,
      "not_enrolled",
      "the relay holds no key for this exchange.",
      "the relay refuses this exchange until it is enrolled there.",
      ASK_PARTNER,
    ],
    [
      4004,
      "credential_refused",
      "the relay holds a different key for this exchange.",
      "the relay refuses this exchange until it holds the current key.",
      "Ask your partner to enroll this exchange at their relay again, " +
        "replacing the key it holds.",
    ],
  ])(
    "a partner's WebSocket relay refusing with %i names no close code, and the partner is asked to enroll",
    (closeCode, cause, summary, meaning, action) => {
      const line = shown({
        relay: "websocket",
        url: INVITED_WEBSOCKET,
        result: { kind: "refused", closeCode, proofRemadeOnRelayClock: false },
      });
      expect(line).toEqual({
        url: INVITED_WEBSOCKET,
        works: false,
        cause,
        summary,
        meaning,
        action,
      });
      expect(`${line.summary} ${line.meaning}`).not.toMatch(
        /admitted|close code|registrar|shared secret/,
      );
    },
  );

  test("a WebSocket relay's other refusal is summarized by core's clause, without the close code", () => {
    const line = shown({
      relay: "websocket",
      url: OWN_WEBSOCKET,
      result: {
        kind: "refused",
        closeCode: 4008,
        proofRemadeOnRelayClock: false,
      },
    });
    const words = webSocketRelayRefusalWords(4008, {
      enrollsAtInvitationRegistrar: false,
      partnersUnderInvitationExchangeId: false,
      enrollmentFailed: false,
    });
    expect(line).toMatchObject({
      summary: "the relay is serving as many exchanges as it allows.",
      meaning: words.meaning,
      action: words.action,
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
          "Replace the key the registrar holds for this exchange id, and " +
          "select Enroll.",
      ],
    ])(
      "a %i points at Relay registration where the page shows it and each run registers the new key there",
      (closeCode, action) => {
        expect(
          exchangeRelayCheckLineShown(refused(closeCode), {
            ...CONTEXT,
            relayRegistrationOffered: true,
            relayRegistrationRenewedByRuns: true,
          }),
        ).toMatchObject({
          cause: closeCode === 4003 ? "not_enrolled" : "credential_refused",
          action,
        });
      },
    );

    test.each([4003, 4004])(
      "a %i does not point at Relay registration where no run registers the new key there",
      (closeCode) => {
        expect(
          exchangeRelayCheckLineShown(refused(closeCode), {
            ...CONTEXT,
            relayRegistrationOffered: true,
          }).action,
        ).toBe(REMOVE_OWN);
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

    test("asks the partner about the relay their invitation names where the invitation names this site's registrar", () => {
      const line = exchangeRelayCheckLineShown(refused, {
        hosts: siteHosts,
        invitationRelay: {
          turn: [DEFAULT_TURN],
          websocket: DEFAULT_WEBSOCKET,
          registrar: "https://registrar.example.org",
        },
      });
      expect(line.action).toBe(
        "Check again. If the relay still holds no key, ask your partner " +
          "whether the relay their invitation names is working.",
      );
      expect(line.action).not.toContain("registrar");
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
      meaning:
        "nothing on this computer reached this url as an Alcove WebSocket " +
        "relay: the network blocked it, nothing answered at that address " +
        "and path, or the connection closed before the relay answered.",
      action:
        "Check that this computer can reach the relay and that the url " +
        "names its address and path, then check again.",
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
