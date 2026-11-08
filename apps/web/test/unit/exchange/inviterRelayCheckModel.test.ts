import { describe, expect, test } from "vitest";

import {
  ConnectionError,
  DEFAULT_MAX_DISPLAY_LENGTH,
  RELAY_CHECK_BOUND_MS,
  sanitizeForDisplay,
} from "@alcove/core";

import {
  HELLO_ANSWER_WAIT_MS,
  INVITER_RELAY_CHECK_INTRO,
  INVITER_RELAY_WAITING_SUMMARY,
  TURN_RELAY_NOT_CHECKED_SUMMARY,
  inviterRelayCheckAt,
  inviterRelayCheckShown,
} from "../../../src/exchange/inviterRelayCheckModel.js";
import {
  exchangeRelayCheckLineLabel,
  exchangeRelayCheckLineShown,
} from "../../../src/exchange/exchangeRelayCheckModel.js";
import { REPLACE_INVITATION_BODY } from "../../../src/exchange/InviterExchangeSection.js";
import { RunRelayWatch } from "../../../src/psi/transport/runRelayWatch.js";

import type { InviterRelayCheckState } from "../../../src/exchange/inviterRelayCheckModel.js";
import type { ParkedWebSocketRelayConnection } from "../../../src/psi/transport/websocketRelayConnection.js";
import type { RunRelayHosts } from "../../../src/psi/transport/runRelayPlan.js";

// The share screen's relay check: shown from Create until the partner
// connects, it reads the inviter run's own enrollment and WebSocket relay
// sockets and opens nothing, and words each cause as the acceptor's check
// does.

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
  test("it says what it reads and that it contacts nothing else", () => {
    expect(INVITER_RELAY_CHECK_INTRO).toBe(
      "Check whether this exchange's relays accept it, using the connections " +
        "this page holds open for your partner. Nothing else is contacted.",
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
  test("a socket held open after its hello works, and a TURN relay is not checked", () => {
    const { watch } = watchAt();
    watch.onDefaultRelayEnrollment(undefined);
    for (const url of [OWN_WEBSOCKET, DEFAULT_WEBSOCKET])
      watch.relayOptions(url).onHelloSent?.();
    const result = done(checkAt(watch, HELLO_ANSWER_WAIT_MS));
    const notChecked = (url: string) => ({
      url,
      works: false,
      notChecked: true,
      summary: TURN_RELAY_NOT_CHECKED_SUMMARY,
    });
    const waiting = (url: string) => ({
      url,
      works: true,
      summary: INVITER_RELAY_WAITING_SUMMARY,
    });
    expect(result.lines).toEqual([
      notChecked(OWN_TURN),
      notChecked(DEFAULT_TURN),
      waiting(OWN_WEBSOCKET),
      waiting(DEFAULT_WEBSOCKET),
    ]);
    expect(result.lines.map(exchangeRelayCheckLineLabel)).toEqual([
      "Not checked",
      "Not checked",
      "Works",
      "Works",
    ]);
    expect(result.verdict).toBe(
      "At least one relay this exchange lists works, so the exchange will " +
        "get through over it where a direct connection is blocked.",
    );
  });

  test("the new words", () => {
    expect(INVITER_RELAY_WAITING_SUMMARY).toBe(
      "the relay accepted this exchange's proof, and this page is waiting " +
        "there for your partner.",
    );
    expect(TURN_RELAY_NOT_CHECKED_SUMMARY).toBe(
      "this page first uses this relay when your partner connects.",
    );
  });

  test("a paired socket works", () => {
    const { watch } = watchAt(OWN_ONLY);
    watch.relayOptions(OWN_WEBSOCKET);
    watch.parked(OWN_WEBSOCKET, parkedRelay({ paired: true }));
    expect(done(checkAt(watch, 0)).lines[0]?.works).toBe(true);
  });

  test("a default relay that did not enroll takes the acceptor check's words on its TURN and WebSocket urls", () => {
    const { watch } = watchAt();
    const refusal = { cause: "rate-limit" as const, retryAfterSeconds: 60 };
    watch.onDefaultRelayEnrollment(refusal);
    watch.relayOptions(OWN_WEBSOCKET).onHelloSent?.();
    const lines = done(checkAt(watch, HELLO_ANSWER_WAIT_MS)).lines;
    expect(lines[1]).toEqual(
      exchangeRelayCheckLineShown(
        { relay: "turn", url: DEFAULT_TURN, notEnrolled: refusal },
        { hosts: HOSTS },
      ),
    );
    expect(lines[3]).toEqual(
      exchangeRelayCheckLineShown(
        { relay: "websocket", url: DEFAULT_WEBSOCKET, notEnrolled: refusal },
        { hosts: HOSTS },
      ),
    );
    expect(lines[3]?.cause).toBe("not_enrolled");
  });

  test.each([4003, 4004, 4008])(
    "a %i refusal takes the acceptor check's words for it",
    (code) => {
      const { watch } = watchAt(OWN_ONLY);
      watch.relayOptions(OWN_WEBSOCKET).onSetupClose?.(code);
      const result = done(checkAt(watch, 0));
      expect(result.lines).toEqual([
        exchangeRelayCheckLineShown(
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
        ),
      ]);
      expect(result.lines[0]?.works).toBe(false);
      expect(result.verdict).toMatch(/^No relay this exchange lists works/);
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

  test("a relay still silent at the bound is not reached", () => {
    const { watch } = watchAt(OWN_ONLY);
    watch.relayOptions(OWN_WEBSOCKET).onSetupClose?.(1006);
    expect(checkAt(watch, RELAY_CHECK_BOUND_MS - 1)).toBe(STARTED);
    const line = done(checkAt(watch, RELAY_CHECK_BOUND_MS)).lines[0];
    expect(line.cause).toBe("not_reached");
    expect(line.summary).toBe("not reached within 30 s.");
  });

  test("an enrollment still pending at the bound leaves the default relay not reached", () => {
    const { watch } = watchAt();
    watch.relayOptions(OWN_WEBSOCKET).onHelloSent?.();
    const lines = done(checkAt(watch, RELAY_CHECK_BOUND_MS)).lines;
    expect(lines[1]?.notChecked).toBe(true);
    expect(lines[3]?.cause).toBe("not_reached");
  });
});

describe("the verdict where some relays are not checked", () => {
  test("names the relays checked where none of them works", () => {
    const { watch } = watchAt({ ...OWN_ONLY, turn: [OWN_TURN] });
    watch.relayOptions(OWN_WEBSOCKET).onSetupClose?.(4004);
    expect(done(checkAt(watch, 0)).verdict).toBe(
      "No relay checked works. Follow the steps below, then check again.",
    );
  });
});

test("a url is escaped and bounded where it is shown", () => {
  const hostile = `wss://relay.example.org/\u202e\u0000${"x".repeat(1100)}`;
  const hostileTurn = `turn:relay.example.org\u202e:3478?${"x".repeat(1100)}`;
  const hosts: RunRelayHosts = {
    turn: [hostileTurn],
    websocket: [hostile],
    listedOnceEnrolled: [],
    leftOut: [],
  };
  const { watch } = watchAt(hosts);
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
