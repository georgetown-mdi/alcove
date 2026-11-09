import { describe, expect, test } from "vitest";

import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  RELAY_NOT_REACHED_REMEDY,
  sanitizeForDisplay,
} from "@alcove/core";

import {
  exchangeRelayCheckLineShown,
  exchangeRelayCheckOffered,
  exchangeRelayCheckStatement,
  exchangeRelayCheckVerdict,
} from "../../../src/exchange/exchangeRelayCheckModel.js";
import { DEFAULT_RELAY_REFUSAL_CAUSES } from "../../../src/psi/transport/defaultRelayRefusal.js";

import type { ExchangeRelayCheckContext } from "../../../src/exchange/exchangeRelayCheckModel.js";
import type { ExchangeRelayCheckLine } from "../../../src/psi/transport/exchangeRelayCheck.js";
import type { RunRelayHosts } from "../../../src/psi/transport/runRelayPlan.js";

// The words of the web check of an exchange's relays: each outcome's
// message and remedy, in the web's own words with a step the page offers,
// and every url escaped and bounded.

const ENROLL_OWN = "Enroll this exchange under Relay registration below.";
const REMOVE_OWN = "Remove this relay from Connection settings.";
const ASK_PARTNER = "Ask your partner to enroll this exchange at their relay.";
const CORRECT_OWN = "Correct this url in Connection settings.";
const ASK_PARTNER_URL = "Ask your partner to check this relay's url.";

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
      summary: "a message passed through this relay.",
    });
  });

  test("a TURN relay not reached takes the web's own remedy, not the CLI's", () => {
    const line = shown({ relay: "turn", url: OWN_TURN, result: "not_reached" });
    expect(line).toEqual({
      url: OWN_TURN,
      works: false,
      cause: "not_reached",
      summary: "no connection through this relay within 30 s.",
      meaning:
        "this computer could not reach it, the relay refused this " +
        "exchange, or the relay presented a certificate this computer " +
        "does not trust; the browser does not report which.",
      action:
        "Check that this computer can reach the relay, then check again. " +
        "If it still fails, check this relay, or remove it from " +
        "Connection settings.",
    });
    expect(line.action).not.toBe(RELAY_NOT_REACHED_REMEDY);
  });

  test.each([
    [
      OWN_TURN,
      "Check that this computer can reach the relay, then check again. " +
        "If it still fails, check this relay, or remove it from " +
        "Connection settings.",
    ],
    [
      INVITED_TURN,
      "Check that this computer can reach the relay, then check again. " +
        "If it still fails, ask your partner to check this relay.",
    ],
    [
      DEFAULT_TURN,
      "Check that this computer can reach the relay, then check again.",
    ],
  ])(
    "a TURN relay not reached at %s ends its step by whose relay it is",
    (url, action) => {
      expect(shown({ relay: "turn", url, result: "not_reached" }).action).toBe(
        action,
      );
    },
  );

  test.each([
    [OWN_TURN, "it may need this exchange enrolled first.", REMOVE_OWN],
    [INVITED_TURN, "it needs this exchange enrolled first.", ASK_PARTNER],
    [
      DEFAULT_TURN,
      "it needs this exchange enrolled first.",
      "Check again later.",
    ],
  ])(
    "a refused credential at %s does not work, with a reason and an action for that source",
    (url, meaning, action) => {
      expect(
        shown({ relay: "turn", url, result: "credential_refused" }),
      ).toEqual({
        url,
        works: false,
        cause: "credential_refused",
        summary: "the relay refused this exchange.",
        meaning,
        action,
      });
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
    ["turn", OWN_TURN, CORRECT_OWN],
    ["turn", INVITED_TURN, ASK_PARTNER_URL],
    ["turn", DEFAULT_TURN, "Check again later."],
    ["websocket", OWN_WEBSOCKET, CORRECT_OWN],
    ["websocket", INVITED_WEBSOCKET, ASK_PARTNER_URL],
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

  test.each([
    [OWN_TURN, "Check this relay, or remove it from Connection settings."],
    [INVITED_TURN, "Ask your partner to check this relay."],
    [DEFAULT_TURN, "Check again later."],
  ])(
    "a TURN relay at %s with no relayed path does not work, with a step for that relay",
    (url, action) => {
      expect(shown({ relay: "turn", url, result: "no_relayed_path" })).toEqual({
        url,
        works: false,
        cause: "no_relayed_path",
        summary: "the relay connected, but no message passed through it.",
        action,
      });
    },
  );

  test.each([
    [
      { cause: "rate-limit" as const, retryAfterSeconds: 600 },
      "your network asked it to set up too many exchanges in a short time.",
      "Check again in about 10 minutes.",
    ],
    [
      { cause: "unreachable" as const },
      "it could not be reached, or did not answer in time.",
      "Check your network connection, then check again.",
    ],
    [
      { cause: "relay-full" as const },
      "it is serving as many exchanges as it can.",
      "Check again later.",
    ],
  ])(
    "a default relay that did not enroll the exchange (%o) states why, and when to check again",
    (refusal, meaning, action) => {
      expect(
        shown({ relay: "turn", url: DEFAULT_TURN, notEnrolled: refusal }),
      ).toEqual({
        url: DEFAULT_TURN,
        works: false,
        cause: "not_enrolled",
        summary:
          "this site's relay server could not be set up for this exchange, " +
          "so a run does not use this relay.",
        meaning,
        action,
      });
    },
  );

  test.each([
    [
      4003,
      "not_enrolled",
      "the relay refuses this exchange until it is enrolled there.",
      ASK_PARTNER,
    ],
    [
      4004,
      "credential_refused",
      "the relay refuses this exchange because it holds a different key " +
        "for it.",
      "Ask your partner to enroll this exchange at their relay again, " +
        "replacing the key it holds.",
    ],
  ])(
    "a partner's WebSocket relay refusing with %i names no close code, and the partner is asked to enroll",
    (closeCode, cause, summary, action) => {
      expect(
        shown({
          relay: "websocket",
          url: INVITED_WEBSOCKET,
          result: {
            kind: "refused",
            closeCode,
            proofRemadeOnRelayClock: false,
          },
        }),
      ).toEqual({
        url: INVITED_WEBSOCKET,
        works: false,
        cause,
        summary,
        action,
      });
    },
  );

  test.each([
    [
      4005,
      false,
      {
        cause: "credential_refused",
        summary: "the relay refused this computer's request as expired.",
        meaning:
          "this computer's clock and the relay's may differ by more than " +
          "five minutes.",
        action:
          "Correct this computer's clock, then check again. If the relay " +
          "still refuses, ask whoever runs it to check its clock.",
      },
    ],
    [
      4005,
      true,
      {
        cause: "credential_refused",
        summary:
          "the relay refused this computer's request as expired, even when " +
          "timed by the relay's own clock.",
        action:
          "Check again. If the relay still refuses, ask whoever runs it to " +
          "check it.",
      },
    ],
    [
      4007,
      false,
      {
        cause: "not_reached",
        summary: "the relay did not hear from this computer in time.",
        action:
          "Check the network path to the relay, including any proxy, then " +
          "check again.",
      },
    ],
    [
      4008,
      false,
      {
        cause: "not_reached",
        summary: "the relay is serving as many exchanges as it allows.",
        action: "Check again later.",
      },
    ],
    [
      1011,
      false,
      {
        cause: "not_reached",
        summary: "the relay failed while checking this exchange.",
        action: "Ask whoever runs the relay to check it, then check again.",
      },
    ],
    [
      1001,
      false,
      {
        cause: "not_reached",
        summary: "the relay is shutting down.",
        action: "Check again later.",
      },
    ],
    [
      4001,
      false,
      {
        cause: "not_reached",
        summary: "the relay refused a message from this computer.",
        meaning: "the url may not name an Alcove WebSocket relay.",
        action: CORRECT_OWN,
      },
    ],
  ] as const)(
    "a WebSocket relay's %i refusal (made again on the relay's clock: %s) takes the web's own words",
    (closeCode, proofRemadeOnRelayClock, words) => {
      expect(
        shown({
          relay: "websocket",
          url: OWN_WEBSOCKET,
          result: { kind: "refused", closeCode, proofRemadeOnRelayClock },
        }),
      ).toEqual({ url: OWN_WEBSOCKET, works: false, ...words });
    },
  );

  test.each([
    [OWN_WEBSOCKET, CORRECT_OWN],
    [INVITED_WEBSOCKET, ASK_PARTNER_URL],
  ])(
    "a url at %s that does not answer as a relay takes the url step for that relay",
    (url, action) => {
      expect(
        shown({
          relay: "websocket",
          url,
          result: { kind: "unexpected_message" },
        }),
      ).toEqual({
        url,
        works: false,
        cause: "not_reached",
        summary: "did not answer as an Alcove WebSocket relay.",
        action,
      });
    },
  );

  test("a relay the check found waiting for another connection works", () => {
    expect(
      shown({
        relay: "websocket",
        url: OWN_WEBSOCKET,
        result: { kind: "admitted" },
      }),
    ).toEqual({
      url: OWN_WEBSOCKET,
      works: true,
      summary:
        "the relay accepted this exchange, and another connection for it " +
        "is waiting there.",
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
          "Replace the key the relay holds for this exchange, and select " +
          "Enroll.",
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
        "Check again. If the relay still refuses, ask your partner whether " +
          "the relay their invitation names is working.",
      );
    });
  });

  test("a WebSocket relay not reached, or with no relayed path, does not work", () => {
    expect(
      shown({
        relay: "websocket",
        url: OWN_WEBSOCKET,
        result: { kind: "not_reached" },
      }),
    ).toEqual({
      url: OWN_WEBSOCKET,
      works: false,
      cause: "not_reached",
      summary: "not reached within 30 s.",
      action:
        "Check that this computer can reach the relay and that its url is " +
        "correct, then check again.",
    });
    expect(
      shown({
        relay: "websocket",
        url: OWN_WEBSOCKET,
        result: { kind: "no_relayed_path" },
      }),
    ).toEqual({
      url: OWN_WEBSOCKET,
      works: false,
      cause: "no_relayed_path",
      summary: "the relay connected, but no message passed through it.",
      action: "Check this relay, or remove it from Connection settings.",
    });
  });
});

describe("no line names an internal term", () => {
  const SITE_WEBSOCKET = "wss://turn.example.org/relay";
  const hosts: RunRelayHosts = {
    ...HOSTS,
    websocket: [...HOSTS.websocket, SITE_WEBSOCKET],
    listedOnceEnrolled: [DEFAULT_TURN, SITE_WEBSOCKET],
  };
  const contexts: ReadonlyArray<ExchangeRelayCheckContext> = [
    { ...CONTEXT, hosts },
    {
      ...CONTEXT,
      hosts: { ...hosts, defaultRelayOff: true },
      relayRegistrationOffered: true,
      relayRegistrationRenewedByRuns: true,
    },
    {
      hosts,
      invitationRelay: {
        turn: [DEFAULT_TURN],
        websocket: SITE_WEBSOCKET,
        registrar: "https://registrar.example.org",
      },
    },
  ];
  const turnResults = [
    "works",
    "not_reached",
    "credential_refused",
    "no_relayed_path",
    "not_started",
    "credential_not_made",
  ] as const;
  const closeCodes = [
    1001, 1009, 1011, 4001, 4002, 4003, 4004, 4005, 4007, 4008,
  ];

  function everyLine(context: ExchangeRelayCheckContext) {
    const lines: Array<ExchangeRelayCheckLine> = [];
    for (const url of hosts.turn) {
      for (const result of turnResults)
        lines.push({ relay: "turn", url, result });
    }
    for (const url of hosts.websocket) {
      for (const kind of [
        "works",
        "admitted",
        "unexpected_message",
        "not_reached",
        "no_relayed_path",
        "not_started",
      ] as const)
        lines.push({ relay: "websocket", url, result: { kind } });
      for (const closeCode of closeCodes)
        for (const proofRemadeOnRelayClock of [false, true])
          lines.push({
            relay: "websocket",
            url,
            result: { kind: "refused", closeCode, proofRemadeOnRelayClock },
          });
    }
    for (const url of hosts.listedOnceEnrolled)
      for (const cause of DEFAULT_RELAY_REFUSAL_CAUSES)
        lines.push({
          relay: url === DEFAULT_TURN ? "turn" : "websocket",
          url,
          notEnrolled: { cause, retryAfterSeconds: 90 },
        });
    return lines.map((line) => exchangeRelayCheckLineShown(line, context));
  }

  test("on any line, the statement, or a verdict", () => {
    const statement = exchangeRelayCheckStatement({
      ...hosts,
      leftOut: [OWN_TURN],
    });
    const words = [
      ...contexts
        .flatMap(everyLine)
        .flatMap((line) => [
          line.status,
          line.summary,
          line.meaning,
          line.action,
        ]),
      statement.contactedHeading,
      ...statement.contacted.flatMap(({ explanation }) => explanation),
      statement.notContacted?.heading,
      statement.closing,
      exchangeRelayCheckVerdict([]),
      exchangeRelayCheckVerdict(everyLine(contexts[0])),
    ];
    expect(words.length).toBeGreaterThan(400);
    for (const text of words)
      expect(text ?? "").not.toMatch(
        /[Rr]egistrar|[Ee]xchange id|[Pp]roof|close code|shared secret|alcove /,
      );
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
    expect(exchangeRelayCheckVerdict([refused])).toBe(
      "No relay works, so the exchange connects only where a direct " +
        "connection is possible. Follow the steps below, then check again.",
    );
  });

  test("says whether every relay works, or at least one", () => {
    expect(exchangeRelayCheckVerdict([works])).toBe("Every relay works.");
    expect(exchangeRelayCheckVerdict([works, refused])).toBe(
      "At least one relay works from this computer. " +
        "The steps below fix the others.",
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
