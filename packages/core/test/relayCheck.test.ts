import { describe, expect, test } from "vitest";

import {
  relayCheckHeadline,
  relayCheckPlan,
  relayHostStatement,
  relayHostStatementLines,
} from "../src/relayCheck";
import type { WebRTCConnectionConfig } from "../src/config/connection";

const OWN_TURN = "turn:own-relay.example.org:3478?transport=tcp";
const INVITATION_TURN = "turns:relay.example.org:443?transport=tcp";
const REGISTRAR = "https://registrar.example.org/enroll";

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

  test("refuses a connection listing no TURN url", () => {
    expect(() => relayCheckPlan(connection({}))).toThrow(/no TURN url/);
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
        lapsesAt: "2026-01-01T01:10:00Z",
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
  ] as const)("%o is no check doctor relay reports", (fields) => {
    expect(relayCheckHeadline(fields)).toBeUndefined();
  });
});
