import { describe, expect, test } from "vitest";

import {
  ConnectionError,
  DEFAULT_MAX_DISPLAY_LENGTH,
  RELAY_CHECK_BOUND_MS,
  sanitizeForDisplay,
} from "@alcove/core";

import {
  HELLO_ANSWER_WAIT_MS,
  INVITER_RELAY_ACTIONS,
  INVITER_RELAY_CHECK_FAILS_VERDICT,
  INVITER_RELAY_CHECK_INTRO,
  INVITER_RELAY_CHECK_WORKS_VERDICT,
  INVITER_RELAY_WAITING_SUMMARY,
  inviterRelayCheckAt,
  inviterRelayCheckShown,
} from "../../../src/exchange/inviterRelayCheckModel.js";
import {
  REPLACE_INVITATION_BODY,
  REPLACE_INVITATION_LABEL,
} from "../../../src/exchange/InviterExchangeSection.js";
import { RunRelayWatch } from "../../../src/psi/transport/runRelayWatch.js";
import { exchangeRelayCheckLineShown } from "../../../src/exchange/exchangeRelayCheckModel.js";

import type { InviterRelayCheckState } from "../../../src/exchange/inviterRelayCheckModel.js";
import type { ParkedWebSocketRelayConnection } from "../../../src/psi/transport/websocketRelayConnection.js";
import type { RunRelayHosts } from "../../../src/psi/transport/runRelayPlan.js";

// The share screen's relay check: shown from Create until the partner
// connects, it reads the inviter run's own enrollment and WebSocket relay
// sockets and opens nothing, and takes the acceptor's check's words for each
// cause with remedies of its own, since Create fixes the Connection settings.

const OWN_TURN = "turns:own-relay.example.org:443?transport=tcp";
const OWN_WEBSOCKET = "wss://own-relay.example.org/relay";
const DEFAULT_TURN = "turns:turn.example.org:443?transport=tcp";
const DEFAULT_WEBSOCKET = "wss://relay.example.org/relay";

const HOSTS: RunRelayHosts = {
  registrar: "https://registrar.example.org",
  turn: [OWN_TURN, DEFAULT_TURN],
  websocket: [OWN_WEBSOCKET, DEFAULT_WEBSOCKET],
  listedOnceEnrolled: [DEFAULT_TURN, DEFAULT_WEBSOCKET],
  leftOut: [],
};

const OWN_ONLY: RunRelayHosts = {
  turn: [],
  websocket: [OWN_WEBSOCKET],
  listedOnceEnrolled: [],
  leftOut: [],
};

const DEFAULT_ONLY: RunRelayHosts = {
  registrar: "https://registrar.example.org",
  turn: [],
  websocket: [DEFAULT_WEBSOCKET],
  listedOnceEnrolled: [DEFAULT_WEBSOCKET],
  leftOut: [],
};

/** A parked socket as the watch reads it. */
function parkedRelay(
  state: { paired?: boolean; failure?: ConnectionError } = {},
): ParkedWebSocketRelayConnection {
  return {
    url: OWN_WEBSOCKET,
    paired: state.paired ?? false,
    partnerStarted: false,
    failure: state.failure,
    onChange: () => () => {},
    start: () => Promise.reject(new Error("not started in this test")),
    close: () => {},
  };
}

/** A watch on a clock the test sets. */
function watchAt(hosts: RunRelayHosts = HOSTS) {
  const clock = { now: 0 };
  const watch = new RunRelayWatch(hosts, () => clock.now);
  return { watch, clock };
}

const STARTED: InviterRelayCheckState = { step: "running", startedAt: 0 };

function checkAt(watch: RunRelayWatch, now: number): InviterRelayCheckState {
  return inviterRelayCheckAt(STARTED, watch.hosts, watch.snapshot(), now);
}

function done(state: InviterRelayCheckState) {
  if (state.step !== "done") throw new Error(`the check is ${state.step}`);
  return state;
}

const ENDED = new ConnectionError("the relay client gave up", "transport");

/** The one line of a check of `url` alone, after `closes` and `failure`. */
function lineAfter(
  hosts: RunRelayHosts,
  closes: ReadonlyArray<number>,
  failure?: ConnectionError,
) {
  const url = hosts.websocket[0];
  const { watch } = watchAt(hosts);
  if (hosts.listedOnceEnrolled.length > 0)
    watch.onDefaultRelayEnrollment(undefined);
  const hooks = watch.relayOptions(url);
  for (const code of closes) hooks.onSetupClose?.(code);
  if (failure !== undefined) watch.parked(url, parkedRelay({ failure }));
  const lines = done(checkAt(watch, RELAY_CHECK_BOUND_MS)).lines;
  expect(lines).toHaveLength(1);
  return lines[0];
}

describe("when the share screen shows it", () => {
  test("while the run waits for the partner, once it lists a WebSocket relay", () => {
    expect(
      inviterRelayCheckShown({ phase: "share", failed: false, hosts: HOSTS }),
    ).toBe(true);
  });

  test("not before the run reaches its relays, nor where it dials no WebSocket relay", () => {
    expect(
      inviterRelayCheckShown({
        phase: "share",
        failed: false,
        hosts: undefined,
      }),
    ).toBe(false);
    expect(
      inviterRelayCheckShown({
        phase: "share",
        failed: false,
        hosts: { ...HOSTS, websocket: [] },
      }),
    ).toBe(false);
  });

  test("it is withdrawn once the partner connects", () => {
    for (const phase of ["running", "done"] as const)
      expect(
        inviterRelayCheckShown({ phase, failed: false, hosts: HOSTS }),
      ).toBe(false);
  });

  test("it is withdrawn on a failure, and offered again, not started, on the retry's own run", () => {
    expect(
      inviterRelayCheckShown({ phase: "share", failed: true, hosts: HOSTS }),
    ).toBe(false);
    const failedRun = watchAt(OWN_ONLY).watch;
    failedRun.relayOptions(OWN_WEBSOCKET).onSetupClose?.(4003);
    const retry = watchAt(OWN_ONLY).watch;
    expect(
      inviterRelayCheckShown({
        phase: "share",
        failed: false,
        hosts: retry.hosts,
      }),
    ).toBe(true);
    expect(retry.snapshot().websocket.size).toBe(0);
    expect(checkAt(retry, 1000)).toBe(STARTED);
  });
});

describe("before it is started", () => {
  test("it says what it reads and that it contacts nothing new", () => {
    expect(INVITER_RELAY_CHECK_INTRO).toBe(
      "Check whether the WebSocket relays accept this exchange. This uses " +
        "connections this page already has open and contacts nothing new.",
    );
  });

  test("a check not started stays not started", () => {
    const { watch } = watchAt();
    const notStarted: InviterRelayCheckState = { step: "not_started" };
    expect(
      inviterRelayCheckAt(notStarted, HOSTS, watch.snapshot(), 60_000),
    ).toBe(notStarted);
  });
});

describe("while it runs", () => {
  test("it waits on the run's enrollment and on a socket still connecting", () => {
    const { watch } = watchAt();
    expect(checkAt(watch, 1000)).toBe(STARTED);
    watch.onDefaultRelayEnrollment(undefined);
    watch.relayOptions(OWN_WEBSOCKET);
    watch.relayOptions(DEFAULT_WEBSOCKET);
    expect(checkAt(watch, 1000)).toBe(STARTED);
  });

  test("it waits on the enrollment where only the default relay's TURN url depends on it", () => {
    const hosts: RunRelayHosts = {
      ...OWN_ONLY,
      turn: [DEFAULT_TURN],
      listedOnceEnrolled: [DEFAULT_TURN],
    };
    const { watch } = watchAt(hosts);
    watch.relayOptions(OWN_WEBSOCKET).onHelloSent?.();
    expect(checkAt(watch, HELLO_ANSWER_WAIT_MS)).toBe(STARTED);
    watch.onDefaultRelayEnrollment(undefined);
    expect(done(checkAt(watch, HELLO_ANSWER_WAIT_MS)).lines).toHaveLength(1);
  });

  test("it waits for a hello just sent before taking the relay to accept it", () => {
    const { watch, clock } = watchAt(OWN_ONLY);
    clock.now = 500;
    watch.relayOptions(OWN_WEBSOCKET).onHelloSent?.();
    expect(checkAt(watch, 500 + HELLO_ANSWER_WAIT_MS - 1)).toBe(STARTED);
    expect(done(checkAt(watch, 500 + HELLO_ANSWER_WAIT_MS)).lines).toEqual([
      {
        url: OWN_WEBSOCKET,
        works: true,
        summary: INVITER_RELAY_WAITING_SUMMARY,
      },
    ]);
  });
});

describe("each result", () => {
  test("a socket held open after its hello works, and a TURN relay is left off the list", () => {
    const { watch } = watchAt();
    watch.onDefaultRelayEnrollment(undefined);
    for (const url of [OWN_WEBSOCKET, DEFAULT_WEBSOCKET])
      watch.relayOptions(url).onHelloSent?.();
    const result = done(checkAt(watch, HELLO_ANSWER_WAIT_MS));
    const waiting = (url: string) => ({
      url,
      works: true,
      summary: INVITER_RELAY_WAITING_SUMMARY,
    });
    expect(result.lines).toEqual([
      waiting(OWN_WEBSOCKET),
      waiting(DEFAULT_WEBSOCKET),
    ]);
    expect(result.verdict).toBe(INVITER_RELAY_CHECK_WORKS_VERDICT);
  });

  test("a paired socket works", () => {
    const { watch } = watchAt(OWN_ONLY);
    watch.relayOptions(OWN_WEBSOCKET);
    watch.parked(OWN_WEBSOCKET, parkedRelay({ paired: true }));
    expect(done(checkAt(watch, 0)).lines[0]?.works).toBe(true);
  });

  test("a socket last refused as role taken works, as the acceptor's check reads it", () => {
    const { watch } = watchAt(OWN_ONLY);
    watch.relayOptions(OWN_WEBSOCKET).onSetupClose?.(4006);
    expect(done(checkAt(watch, 0)).lines).toEqual([
      {
        url: OWN_WEBSOCKET,
        works: true,
        summary: INVITER_RELAY_WAITING_SUMMARY,
      },
    ]);
  });

  test("a relay client that failed after a role-taken refusal does not work", () => {
    const line = lineAfter(OWN_ONLY, [4006], ENDED);
    expect(line.works).toBe(false);
    expect(line.cause).toBe("not_reached");
  });

  test("a default relay that did not enroll takes the acceptor check's words, with the share screen's remedy, on its TURN and WebSocket urls", () => {
    const { watch } = watchAt();
    const refusal = { cause: "rate-limit" as const, retryAfterSeconds: 60 };
    watch.onDefaultRelayEnrollment(refusal);
    watch.relayOptions(OWN_WEBSOCKET).onHelloSent?.();
    const lines = done(checkAt(watch, HELLO_ANSWER_WAIT_MS)).lines;
    expect(lines.map((line) => line.url)).toEqual([
      DEFAULT_TURN,
      OWN_WEBSOCKET,
      DEFAULT_WEBSOCKET,
    ]);
    expect(lines[0]).toEqual({
      ...exchangeRelayCheckLineShown(
        { relay: "turn", url: DEFAULT_TURN, notEnrolled: refusal },
        { hosts: HOSTS },
      ),
      action: INVITER_RELAY_ACTIONS.notEnrolled,
    });
    expect(lines[2]).toEqual({
      ...exchangeRelayCheckLineShown(
        { relay: "websocket", url: DEFAULT_WEBSOCKET, notEnrolled: refusal },
        { hosts: HOSTS },
      ),
      action: INVITER_RELAY_ACTIONS.notEnrolled,
    });
    expect(lines[2]?.cause).toBe("not_enrolled");
  });

  test.each([4003, 4004, 4008])(
    "a %i refusal takes the acceptor check's words for it",
    (code) => {
      const { watch } = watchAt(OWN_ONLY);
      watch.relayOptions(OWN_WEBSOCKET).onSetupClose?.(code);
      const result = done(checkAt(watch, 0));
      const { action: _action, ...words } = exchangeRelayCheckLineShown(
        {
          relay: "websocket",
          url: OWN_WEBSOCKET,
          result: {
            kind: "refused",
            closeCode: code,
            proofRemadeOnRelayClock: false,
          },
        },
        { hosts: OWN_ONLY },
      );
      expect(result.lines).toEqual([
        { ...words, action: expect.any(String) as string },
      ]);
      expect(result.lines[0]?.works).toBe(false);
      expect(result.verdict).toBe(INVITER_RELAY_CHECK_FAILS_VERDICT);
    },
  );

  test("a refusal stays reported while the run dials again, until a later hello is held", () => {
    const { watch, clock } = watchAt(OWN_ONLY);
    const hooks = watch.relayOptions(OWN_WEBSOCKET);
    hooks.onHelloSent?.();
    hooks.onSetupClose?.(4003);
    clock.now = 5000;
    hooks.onHelloSent?.();
    expect(checkAt(watch, 5000)).toBe(STARTED);
    hooks.onSetupClose?.(4003);
    expect(done(checkAt(watch, 5001)).lines[0]?.cause).toBe("not_enrolled");
    clock.now = 10_000;
    hooks.onHelloSent?.();
    expect(
      done(checkAt(watch, 10_000 + HELLO_ANSWER_WAIT_MS)).lines[0],
    ).toEqual({
      url: OWN_WEBSOCKET,
      works: true,
      summary: INVITER_RELAY_WAITING_SUMMARY,
    });
  });

  test("a proof refused as expired twice is refused, made again on the relay's clock", () => {
    const { watch } = watchAt(OWN_ONLY);
    const hooks = watch.relayOptions(OWN_WEBSOCKET);
    hooks.onSetupClose?.(4005);
    expect(checkAt(watch, 0)).toBe(STARTED);
    hooks.onSetupClose?.(4005);
    watch.parked(
      OWN_WEBSOCKET,
      parkedRelay({ failure: new ConnectionError("expired", "transport") }),
    );
    expect(done(checkAt(watch, 0)).lines[0]?.cause).toBe("credential_refused");
  });

  test("a relay that answers out of order did not answer as a relay", () => {
    const { watch } = watchAt(OWN_ONLY);
    watch.relayOptions(OWN_WEBSOCKET).onHelloSent?.();
    watch.parked(
      OWN_WEBSOCKET,
      parkedRelay({ failure: new ConnectionError("garbled", "protocol") }),
    );
    expect(done(checkAt(watch, 0)).lines[0]?.summary).toBe(
      "did not answer as an Alcove WebSocket relay.",
    );
  });

  test("a relay client that failed after its hello is not reported as working", () => {
    const { watch } = watchAt(OWN_ONLY);
    watch.relayOptions(OWN_WEBSOCKET).onHelloSent?.();
    watch.parked(
      OWN_WEBSOCKET,
      parkedRelay({
        failure: new ConnectionError("the partner did not arrive", "transport"),
      }),
    );
    const line = done(checkAt(watch, HELLO_ANSWER_WAIT_MS)).lines[0];
    expect(line.works).toBe(false);
    expect(line.cause).toBe("not_reached");
  });

  test("a relay still silent at the bound is not reached", () => {
    const { watch } = watchAt(OWN_ONLY);
    watch.relayOptions(OWN_WEBSOCKET).onSetupClose?.(1006);
    expect(checkAt(watch, RELAY_CHECK_BOUND_MS - 1)).toBe(STARTED);
    const line = done(checkAt(watch, RELAY_CHECK_BOUND_MS)).lines[0];
    expect(line.cause).toBe("not_reached");
    expect(line.summary).toBe("not reached within 30 s.");
  });

  test("an enrollment still pending at the bound leaves the default relay not reached and its TURN url off the list", () => {
    const { watch } = watchAt();
    watch.relayOptions(OWN_WEBSOCKET).onHelloSent?.();
    const lines = done(checkAt(watch, RELAY_CHECK_BOUND_MS)).lines;
    expect(lines.map((line) => line.url)).toEqual([
      OWN_WEBSOCKET,
      DEFAULT_WEBSOCKET,
    ]);
    expect(lines[1]?.cause).toBe("not_reached");
  });
});

describe("what the share screen says to do", () => {
  const actions = INVITER_RELAY_ACTIONS;
  const refusedEnded = new ConnectionError("refused", "transport");

  test.each([
    ["own", 4003, OWN_ONLY, [4003], undefined, actions.remove],
    ["own", 4004, OWN_ONLY, [4004], refusedEnded, actions.remove],
    ["this site's", 4003, DEFAULT_ONLY, [4003], undefined, actions.keepsTrying],
    ["this site's", 4003, DEFAULT_ONLY, [4003], refusedEnded, actions.replace],
    ["this site's", 4004, DEFAULT_ONLY, [4004], refusedEnded, actions.replace],
    ["own", 4005, OWN_ONLY, [4005, 4005], refusedEnded, actions.remove],
    [
      "this site's",
      4005,
      DEFAULT_ONLY,
      [4005, 4005],
      refusedEnded,
      actions.replace,
    ],
    ["own", 4005, OWN_ONLY, [4005], refusedEnded, actions.clock],
    ["own", 4007, OWN_ONLY, [4007], refusedEnded, actions.slowPath],
    ["own", 4008, OWN_ONLY, [4008], refusedEnded, actions.replaceLater],
    ["own", 1001, OWN_ONLY, [1001], refusedEnded, actions.replaceLater],
    ["own", 1011, OWN_ONLY, [1011], refusedEnded, actions.keyTable],
    ["own", 4001, OWN_ONLY, [4001], refusedEnded, actions.correct],
    ["this site's", 4001, DEFAULT_ONLY, [4001], refusedEnded, actions.replace],
  ] as const)(
    "%s relay refusing with %i: the remedy for that close",
    (_whose, _code, hosts, closes, failure, action) => {
      expect(lineAfter(hosts, closes, failure).action).toBe(action);
    },
  );

  test("an own relay refusing with 4003 where this site's relay server is off offers to turn it on", () => {
    const hosts: RunRelayHosts = { ...OWN_ONLY, defaultRelayOff: true };
    expect(lineAfter(hosts, [4003]).action).toBe(actions.removeOrTurnOnDefault);
  });

  test("a url that cannot be dialed, or that does not answer as a relay, is corrected on an own relay", () => {
    for (const kind of ["usage", "protocol"] as const) {
      const failure = new ConnectionError("bad", kind);
      expect(lineAfter(OWN_ONLY, [], failure).action).toBe(actions.correct);
      expect(lineAfter(DEFAULT_ONLY, [], failure).action).toBe(actions.replace);
    }
  });

  test("a relay not reached says to check again only while the run still dials it", () => {
    expect(lineAfter(OWN_ONLY, [1006]).action).toBe(
      actions.notReachedTryingOwn,
    );
    expect(lineAfter(DEFAULT_ONLY, [1006]).action).toBe(
      actions.notReachedTrying,
    );
    expect(lineAfter(OWN_ONLY, [1006], ENDED).action).toBe(
      actions.notReachedEndedOwn,
    );
    expect(lineAfter(DEFAULT_ONLY, [1006], ENDED).action).toBe(
      actions.notReachedEnded,
    );
  });

  test("the share screen's words", () => {
    expect(INVITER_RELAY_WAITING_SUMMARY).toBe(
      "the relay accepted this exchange's proof, and this page is waiting " +
        "there for your partner.",
    );
    expect(INVITER_RELAY_CHECK_WORKS_VERDICT).toBe(
      "A relay accepts this exchange from this page. Your partner's side is " +
        "not checked.",
    );
    expect(INVITER_RELAY_CHECK_FAILS_VERDICT).toBe(
      "No WebSocket relay accepts this exchange from this page. Follow the steps below.",
    );
    expect(actions).toEqual({
      remove:
        "Choose Replace this invitation, then remove this relay under " +
        "Connection settings.",
      removeOrTurnOnDefault:
        "Choose Replace this invitation, then under Connection settings " +
        "remove this relay or turn on this site's relay server.",
      correct:
        "Choose Replace this invitation, then correct this url under " +
        "Connection settings.",
      replace: "Choose Replace this invitation to try again.",
      replaceLater: "Later, choose Replace this invitation to try again.",
      notEnrolled:
        "If your partner cannot connect, choose Replace this invitation to " +
        "try again.",
      keepsTrying: "This page keeps trying, so check again shortly.",
      clock:
        "Correct this computer's clock, then choose Replace this invitation.",
      slowPath:
        "Check the network path to the relay, including any proxy, then " +
        "choose Replace this invitation.",
      keyTable:
        "Ask the relay's operator to check its key table, then choose " +
        "Replace this invitation.",
      notReachedTrying:
        "Check that this computer can reach the relay. This page keeps " +
        "trying, so check again afterwards.",
      notReachedTryingOwn:
        "Check that this computer can reach the relay. This page keeps " +
        "trying, so check again afterwards. If the url is wrong, choose " +
        "Replace this invitation and correct it under Connection settings.",
      notReachedEnded:
        "Check that this computer can reach the relay, then choose Replace " +
        "this invitation.",
      notReachedEndedOwn:
        "Check that this computer can reach the relay, then choose Replace " +
        "this invitation and correct this url under Connection settings if " +
        "it is wrong.",
    });
  });

  test("each remedy that does not wait on the run names the share screen's Replace control", () => {
    const waitsOnTheRun: ReadonlyArray<string> = [
      actions.keepsTrying,
      actions.notReachedTrying,
    ];
    for (const action of Object.values(actions))
      if (!waitsOnTheRun.includes(action))
        expect(action).toContain(REPLACE_INVITATION_LABEL);
  });
});

test("a url is escaped and bounded where it is shown", () => {
  const hostile = `wss://relay.example.org/\u202e\u0000${"x".repeat(1100)}`;
  const hostileTurn = `turn:relay.example.org\u202e:3478?${"x".repeat(1100)}`;
  const hosts: RunRelayHosts = {
    registrar: "https://registrar.example.org",
    turn: [hostileTurn],
    websocket: [hostile],
    listedOnceEnrolled: [hostileTurn],
    leftOut: [],
  };
  const { watch } = watchAt(hosts);
  watch.onDefaultRelayEnrollment({ cause: "other" });
  watch.relayOptions(hostile).onHelloSent?.();
  const lines = done(checkAt(watch, HELLO_ANSWER_WAIT_MS)).lines;
  expect(lines.map((line) => line.url)).toEqual([
    sanitizeForDisplay(hostileTurn),
    sanitizeForDisplay(hostile),
  ]);
  for (const { url } of lines) {
    expect(url).not.toContain("\u202e");
    expect(url.length).toBeLessThanOrEqual(DEFAULT_MAX_DISPLAY_LENGTH + 20);
  }
});

test("Replace says it changes the relays too", () => {
  expect(REPLACE_INVITATION_BODY).toBe(
    "To change the terms or the relays, replace this invitation. Its link " +
      "stops working, and you go back to Review & create with your choices kept.",
  );
});
