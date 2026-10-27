import { describe, expect, test } from "vitest";

import { DEFAULT_MAX_DISPLAY_LENGTH } from "../src/utils/sanitizeForDisplay";
import {
  isWebSocketRelayRefusal,
  registrarNotContactedReason,
  relayCheckHeadline,
  relayCheckPlan,
  relayHostStatement,
  relayHostStatementLines,
  webSocketRelayCheckId,
} from "../src/relayCheck";
import type { WebRTCConnectionConfig } from "../src/config/connection";

const OWN_TURN = "turn:own-relay.example.org:3478?transport=tcp";
const INVITATION_TURN = "turns:relay.example.org:443?transport=tcp";
const REGISTRAR = "https://registrar.example.org/enroll";
const OWN_WEBSOCKET = "wss://own-relay.example.org/relay";
const INVITATION_WEBSOCKET = "wss://relay.example.org/relay";

function connection(
  extra: Partial<WebRTCConnectionConfig>,
): WebRTCConnectionConfig {
  return {
    channel: "webrtc",
    server: { host: "peers.example.org" },
    role: "inviter",
    ...extra,
  } as WebRTCConnectionConfig;
}

describe("relayCheckPlan", () => {
  test("contacts the first TURN url, and the registrar where a run enrolls there", () => {
    const plan = relayCheckPlan(
      connection({
        invitationRelay: { turn: [INVITATION_TURN], registrar: REGISTRAR },
        turn: [{ url: OWN_TURN, username: "u", credential: "c" }],
        allowedRelays: ["relay.example.org:443"],
      }),
    );

    expect(plan.contacted).toEqual({
      server: { source: "invitation", url: INVITATION_TURN },
      transport: "tls",
    });
    expect(plan.notContacted).toEqual([]);
    expect(plan.leftOut.map((server) => server.url)).toEqual([OWN_TURN]);
    expect(plan.registrar).toEqual({ url: REGISTRAR, contacted: true });
  });

  test("refuses a connection listing no TURN url and no WebSocket relay", () => {
    expect(() => relayCheckPlan(connection({}))).toThrow(
      /no TURN url and no WebSocket relay/,
    );
  });

  test("contacts every WebSocket relay a run dials, with no TURN url", () => {
    const plan = relayCheckPlan(
      connection({
        websocketRelay: OWN_WEBSOCKET,
        invitationRelay: {
          websocket: INVITATION_WEBSOCKET,
          registrar: REGISTRAR,
        },
      }),
    );

    expect(plan.contacted).toBeUndefined();
    expect(plan.websocket).toEqual([
      {
        source: "own",
        url: OWN_WEBSOCKET,
        enrollsAtInvitationRegistrar: false,
      },
      {
        source: "invitation",
        url: INVITATION_WEBSOCKET,
        enrollsAtInvitationRegistrar: true,
      },
    ]);
    expect(plan.websocketLeftOut).toEqual([]);
    expect(plan.registrar).toEqual({ url: REGISTRAR, contacted: true });
  });

  test("an own WebSocket relay naming the invitation's url enrolls at its registrar, decided by the url", () => {
    const plan = relayCheckPlan(
      connection({
        websocketRelay: INVITATION_WEBSOCKET,
        invitationRelay: {
          websocket: INVITATION_WEBSOCKET,
          registrar: REGISTRAR,
        },
      }),
    );

    expect(plan.websocket).toEqual([
      {
        source: "own",
        url: INVITATION_WEBSOCKET,
        enrollsAtInvitationRegistrar: true,
      },
    ]);
    expect(plan.registrar?.contacted).toBe(true);
  });

  test("a WebSocket relay allowed_relays leaves out is not contacted", () => {
    const plan = relayCheckPlan(
      connection({
        turn: [{ url: OWN_TURN }],
        websocketRelay: OWN_WEBSOCKET,
        allowedRelays: ["own-relay.example.org:3478"],
      }),
    );

    expect(plan.websocket).toEqual([]);
    expect(plan.websocketLeftOut.map((relay) => relay.url)).toEqual([
      OWN_WEBSOCKET,
    ]);
  });

  test.each([
    [
      "a run proves to the invitation's WebSocket relay under the id it names",
      connection({
        invitationRelay: {
          websocket: INVITATION_WEBSOCKET,
          websocketExchangeId: "named-exchange",
          registrar: REGISTRAR,
        },
      }),
      "it proves to the WebSocket relay the invitation names under the " +
        "exchange id the invitation names",
    ],
    [
      "a run dials its own WebSocket relay alone",
      connection({
        websocketRelay: OWN_WEBSOCKET,
        invitationRelay: { registrar: REGISTRAR, turn: [INVITATION_TURN] },
        allowedRelays: ["own-relay.example.org"],
      }),
      "connection.allowed_relays leaves out the relay it names",
    ],
    [
      "a run allocates on its own TURN url and proves under the named id",
      connection({
        turn: [{ url: OWN_TURN }],
        invitationRelay: {
          websocket: INVITATION_WEBSOCKET,
          websocketExchangeId: "named-exchange",
          registrar: REGISTRAR,
        },
      }),
      "the relay it allocates on is not one the invitation names, and it " +
        "proves to the WebSocket relay the invitation names under the " +
        "exchange id the invitation names",
    ],
  ])(
    "states why a run does not enroll at the registrar where %s",
    (_case, config, reason) => {
      const plan = relayCheckPlan(config);
      expect(plan.registrar?.contacted).toBe(false);
      expect(registrarNotContactedReason(plan)).toBe(reason);
    },
  );

  test("states no reason for a registrar a run enrolls at", () => {
    const plan = relayCheckPlan(
      connection({
        invitationRelay: { turn: [INVITATION_TURN], registrar: REGISTRAR },
      }),
    );
    expect(() => registrarNotContactedReason(plan)).toThrow(
      /contacts its registrar/,
    );
  });
});

describe("relayHostStatement", () => {
  test("lists a skipped host only where there is one, and prints each host alone on its line", () => {
    const own = connection({ turn: [{ url: OWN_TURN }] });
    const statement = relayHostStatement(relayCheckPlan(own), own);

    expect(statement.notContacted).toBeUndefined();
    expect(relayHostStatementLines(statement)).toEqual([
      "This check contacts these hosts, as a run of this configuration does:",
      `  ${OWN_TURN}`,
      "    The relay a run allocates on, over TCP, from connection.turn. " +
        "The check asks it for a relay address, sending the credential a " +
        "run sends there.",
      "    Whoever runs that relay learns this machine's network address.",
      "It contacts nothing else.",
      "",
    ]);
  });

  test("lists each WebSocket relay a run dials after the TURN url, and one allowed_relays leaves out as not contacted", () => {
    const config = connection({
      turn: [{ url: OWN_TURN }],
      websocketRelay: OWN_WEBSOCKET,
      invitationRelay: { websocket: INVITATION_WEBSOCKET },
      allowedRelays: ["own-relay.example.org"],
    });
    const lines = relayHostStatementLines(
      relayHostStatement(relayCheckPlan(config), config),
    );

    expect(lines).toEqual([
      "This check contacts these hosts, as a run of this configuration does:",
      `  ${OWN_TURN}`,
      "    The relay a run allocates on, over TCP, from connection.turn. " +
        "The check asks it for a relay address, sending the credential a " +
        "run sends there.",
      "    Whoever runs that relay learns this machine's network address.",
      `  ${OWN_WEBSOCKET}`,
      "    A WebSocket relay a run dials, from connection.websocket_relay. " +
        "The check opens two connections to it, presents on each the proof " +
        "a run presents there, and closes both once the relay answers.",
      "    Whoever runs that relay learns this machine's network address.",
      "It does not contact these hosts, because a run of this configuration " +
        "does not:",
      `  ${INVITATION_WEBSOCKET}`,
      "    A WebSocket relay, from your partner's invitation. Left out by " +
        "connection.allowed_relays.",
      "It contacts nothing else. This configuration's invitation_relay names " +
        "no relay registrar, so it contacts none and enrolls nothing.",
      "",
    ]);
    for (const line of lines)
      expect(line.length).toBeLessThanOrEqual(DEFAULT_MAX_DISPLAY_LENGTH);
  });
});

describe("relayCheckHeadline", () => {
  test.each([
    [
      { id: "enrollment", status: "ok", registrar: REGISTRAR },
      "the relay registrar at https://registrar.example.org that your " +
        "partner's invitation names enrolled this exchange.",
    ],
    [
      {
        id: "enrollment",
        status: "ok",
        registrar: REGISTRAR,
        lapses_at: "2026-01-01T01:10:00Z",
      },
      "the relay registrar at https://registrar.example.org that your " +
        "partner's invitation names enrolled this exchange, until " +
        "2026-01-01T01:10:00Z.",
    ],
    [
      { id: "enrollment", status: "warn", registrar: REGISTRAR },
      "the relay registrar at https://registrar.example.org that your " +
        "partner's invitation names did not enroll this exchange.",
    ],
    [
      { id: "enrollment", status: "skipped", registrar: REGISTRAR },
      `the relay registrar at ${REGISTRAR} that your partner's invitation ` +
        "names: not contacted.",
    ],
    [
      { id: "turn_1", status: "ok", url: OWN_TURN, transport: "udp" },
      `${OWN_TURN} over UDP, then TCP, the relay a run allocates on: ` +
        "reached; the relay gave a relay address.",
    ],
    [
      { id: "turn_1", status: "fail", url: INVITATION_TURN, transport: "tls" },
      `${INVITATION_TURN} over TLS, the relay a run allocates on: no relay ` +
        "candidate gathered within 30 s.",
    ],
    [
      { id: "turn_12", status: "skipped", url: OWN_TURN },
      `${OWN_TURN}, listed after the relay a run allocates on: not contacted.`,
    ],
    [
      {
        id: "websocket_1",
        status: "ok",
        url: OWN_WEBSOCKET,
        outcome: "admitted",
      },
      `${OWN_WEBSOCKET}, a WebSocket relay a run dials: admitted; the relay ` +
        "accepted this exchange's proof.",
    ],
    [
      {
        id: "websocket_2",
        status: "fail",
        url: INVITATION_WEBSOCKET,
        outcome: "not_admitted",
        close_code: 4003,
      },
      `${INVITATION_WEBSOCKET}, a WebSocket relay a run dials: not admitted; ` +
        "the relay holds no key for this exchange (close code 4003).",
    ],
    [
      {
        id: "websocket_1",
        status: "fail",
        url: OWN_WEBSOCKET,
        outcome: "not_admitted",
        close_code: 4004,
      },
      `${OWN_WEBSOCKET}, a WebSocket relay a run dials: not admitted; the ` +
        "relay holds a key for this exchange other than the one this side's " +
        "shared secret derives (close code 4004).",
    ],
    [
      {
        id: "websocket_1",
        status: "fail",
        url: OWN_WEBSOCKET,
        outcome: "not_reached",
      },
      `${OWN_WEBSOCKET}, a WebSocket relay a run dials: not reached within 30 s.`,
    ],
    [
      {
        id: "websocket_1",
        status: "fail",
        url: OWN_WEBSOCKET,
        outcome: "certificate_not_verified",
      },
      `${OWN_WEBSOCKET}, a WebSocket relay a run dials: not reached; its TLS ` +
        "certificate did not verify on this host.",
    ],
    [
      {
        id: "websocket_1",
        status: "fail",
        url: OWN_WEBSOCKET,
        outcome: "unexpected_message",
      },
      `${OWN_WEBSOCKET}, a WebSocket relay a run dials: did not answer as ` +
        "an Alcove WebSocket relay.",
    ],
  ] as const)("%o is worded as doctor relay prints it", (fields, expected) => {
    expect(relayCheckHeadline(fields)).toBe(expected);
  });

  test("a refused enrollment holds the registrar's answer only where it is given", () => {
    expect(
      relayCheckHeadline(
        { id: "enrollment", status: "warn", registrar: REGISTRAR },
        { registrarAnswer: "HTTP 409: no" },
      ),
    ).toBe(
      "the relay registrar at https://registrar.example.org that your " +
        "partner's invitation names did not enroll this exchange " +
        "(HTTP 409: no).",
    );
  });

  test("the bound a test set is the one the failure states", () => {
    expect(
      relayCheckHeadline(
        { id: "turn_1", status: "fail", url: OWN_TURN, transport: "tcp" },
        { boundMs: 2_000 },
      ),
    ).toMatch(/within 2 s\.$/);
  });

  test.each([
    { id: "enrollment", status: "ok" },
    { id: "enrollment", status: "fail", registrar: REGISTRAR },
    { id: "enrollment", status: "ok", registrar: "not a url" },
    { id: "turn_1", status: "ok", url: OWN_TURN },
    { id: "turn_1", status: "skipped", url: OWN_TURN, transport: "tcp" },
    { id: "turn_1", status: "warn", url: OWN_TURN, transport: "tcp" },
    { id: "turn_2", status: "ok", url: OWN_TURN, transport: "tcp" },
    { id: "turn_02", status: "skipped", url: OWN_TURN },
    { id: "turn_2", status: "skipped" },
    { id: "stun_1", status: "ok", url: OWN_TURN, transport: "tcp" },
    {
      id: "turn_1",
      status: "ok",
      url: OWN_TURN,
      transport: "tcp",
      outcome: "admitted",
    },
    {
      id: "turn_1",
      status: "fail",
      url: OWN_TURN,
      transport: "tcp",
      close_code: 4003,
    },
    { id: "websocket_1", status: "ok", outcome: "admitted" },
    { id: "websocket_1", status: "ok", url: OWN_WEBSOCKET },
    {
      id: "websocket_1",
      status: "fail",
      url: OWN_WEBSOCKET,
      outcome: "admitted",
    },
    {
      id: "websocket_1",
      status: "ok",
      url: OWN_WEBSOCKET,
      outcome: "not_reached",
    },
    {
      id: "websocket_1",
      status: "fail",
      url: OWN_WEBSOCKET,
      outcome: "not_admitted",
    },
    {
      id: "websocket_1",
      status: "fail",
      url: OWN_WEBSOCKET,
      outcome: "not_admitted",
      close_code: 4006,
    },
    {
      id: "websocket_1",
      status: "fail",
      url: OWN_WEBSOCKET,
      outcome: "not_admitted",
      close_code: 1006,
    },
    {
      id: "websocket_1",
      status: "fail",
      url: OWN_WEBSOCKET,
      outcome: "not_reached",
      close_code: 4003,
    },
    {
      id: "websocket_1",
      status: "skipped",
      url: OWN_WEBSOCKET,
      outcome: "not_reached",
    },
    {
      id: "websocket_1",
      status: "ok",
      url: OWN_WEBSOCKET,
      transport: "tls",
      outcome: "admitted",
    },
    {
      id: "websocket_1",
      status: "ok",
      url: OWN_WEBSOCKET,
      registrar: REGISTRAR,
      outcome: "admitted",
    },
    {
      id: "websocket_0",
      status: "ok",
      url: OWN_WEBSOCKET,
      outcome: "admitted",
    },
  ] as const)("%o is no check doctor relay reports", (fields) => {
    expect(relayCheckHeadline(fields)).toBeUndefined();
  });

  test("ids the WebSocket relay checks from 1, and takes as a refusal only a close the relay refuses a hello with", () => {
    expect(webSocketRelayCheckId(2)).toBe("websocket_2");
    expect(isWebSocketRelayRefusal(4003)).toBe(true);
    expect(isWebSocketRelayRefusal(4006)).toBe(false);
    expect(isWebSocketRelayRefusal(1006)).toBe(false);
    expect(isWebSocketRelayRefusal(1000)).toBe(false);
  });
});
