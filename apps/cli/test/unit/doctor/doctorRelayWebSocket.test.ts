import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import YAML from "yaml";
import {
  checkWebSocketRelayProof,
  deriveRelayExchangeId,
  deriveRelayKey,
  deriveWebSocketRelayProofKey,
  parseWebSocketRelayProof,
  UsageError,
  WEBSOCKET_RELAY_LINE_BELOW,
} from "@alcove/core";

import type { RTCIceServer } from "werift";

import { checkRelay, relayHandler } from "../../../src/commands/doctor";
import { webSocketRelayDialFor } from "../../../src/connection/webrtc/websocketRelayDial";
import type { WebSocketRelayDial } from "../../../src/connection/webrtc/websocketRelayConnection";
import {
  RELAY_CHECK_ROLE_REQUIRED,
  RELAY_NOT_REACHED_REMEDY,
  relayCheckAllLeftOutMessage,
} from "../../../src/doctor/relay";
import type { RelayCandidateGathering } from "../../../src/doctor/relay";
import {
  DOCTOR_EXIT_CODE,
  overallOf,
  verdictLines,
  verdictOf,
} from "../../../src/doctor/verdict";
import type { DoctorReport } from "../../../src/doctor/verdict";
import { askWebSocketRelay } from "../../../src/doctor/websocketRelay";
import type {
  WebSocketRelayAnswer,
  WebSocketRelayAsking,
} from "../../../src/doctor/websocketRelay";
import { saveKeyFile } from "../../../src/keyFile";
import {
  argv,
  captureStdio,
  snapshotDiagnosticSinkAndLevel,
} from "../../loggingTestSupport";
import { fakeRegistrar, registrationAnswer } from "../relayRegistrarFake";

// `alcove doctor relay` against a WebSocket relay: the check a run's
// WebSocket relay gets, alone and beside the TURN relay, each answer the
// relay can give, and the console-facing fields it reports. The real relay is
// driven in test/integration/webrtc/doctorWebSocketRelay.test.ts.

vi.mock("werift", () => ({
  RTCPeerConnection: class {
    constructor() {
      throw new Error("no werift peer connection may be built in this file");
    }
  },
}));

snapshotDiagnosticSinkAndLevel();

const SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM";
const OWN_TURN = "turn:own-relay.example.org:3478?transport=tcp";
const OWN_WEBSOCKET = "wss://own-relay.example.org/relay";
const INVITATION_WEBSOCKET = "wss://relay.example.org/relay";
const REGISTRAR = "https://registrar.example.org";
const NOW = new Date("2026-01-01T00:00:00Z");

const linkageTerms = {
  version: "1.0.0",
  identity: "Test Party",
  date: "2025-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

function webrtcConnection(extra: Record<string, unknown> = {}) {
  return {
    channel: "webrtc",
    server: { host: "peers.example.org" },
    role: "inviter",
    ...extra,
  };
}

/**
 * A WebSocket stand-in with the surface the relay transport uses, standing in
 * for the relay's side of one socket.
 */
class FakeRelaySocket {
  readyState = 0;
  binaryType = "blob";
  bufferedAmount = 0;
  readonly sent: Array<string> = [];
  readonly closeCalls: Array<number | undefined> = [];
  private readonly listeners = new Map<string, Set<(event: never) => void>>();

  constructor(readonly url: string) {}

  addEventListener(type: string, handler: (event: never) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, handler: (event: never) => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closeCalls.push(code);
    if (this.readyState < 2) this.readyState = 2;
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  control(type: string): void {
    this.emit("message", { data: JSON.stringify({ type }) });
  }

  closedByRelay(code: number, reason = ""): void {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  private emit(type: string, event: unknown): void {
    for (const handler of [...(this.listeners.get(type) ?? [])])
      (handler as (event: unknown) => void)(event);
  }
}

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

async function dialed(
  sockets: Array<FakeRelaySocket>,
  count: number,
): Promise<Array<FakeRelaySocket>> {
  for (let i = 0; i < 200 && sockets.length < count; i++) await tick();
  if (sockets.length < count)
    throw new Error(`${count} sockets were not dialed`);
  return sockets.slice(0, count);
}

async function relayDial(url = OWN_WEBSOCKET): Promise<WebSocketRelayDial> {
  const dial = await webSocketRelayDialFor(
    { websocketRelay: url },
    SECRET,
    "inviter",
  );
  if (dial === undefined) throw new Error("no relay dial");
  return dial;
}

function harness(certificate?: string) {
  const sockets: Array<FakeRelaySocket> = [];
  const probed: Array<{ host: string; port: number; secure: boolean }> = [];
  return {
    sockets,
    probed,
    options: {
      socketFactory: (url: string): WebSocket => {
        const socket = new FakeRelaySocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      certificateProbe: (endpoint: {
        host: string;
        port: number;
        secure: boolean;
      }) => {
        probed.push(endpoint);
        return Promise.resolve(certificate);
      },
    },
  };
}

describe("asking one WebSocket relay", () => {
  test("parks two sockets in the run's role, each sending the run's hello, and a refusal of one as role taken is an admission", async () => {
    const dial = await relayDial();
    const { sockets, options } = harness();
    const asking = askWebSocketRelay(
      dial,
      new AbortController().signal,
      options,
    );
    const [first, second] = await dialed(sockets, 2);
    first!.open();
    second!.open();
    for (const socket of [first!, second!]) {
      const hello = JSON.parse(socket.sent[0]!) as Record<string, string>;
      expect(hello).toMatchObject({
        type: "hello",
        exchangeId: await deriveRelayExchangeId(SECRET),
        role: "inviter",
      });
      await expect(
        checkWebSocketRelayProof({
          proofKey: await deriveWebSocketRelayProofKey(
            await deriveRelayKey(SECRET),
          ),
          proof: parseWebSocketRelayProof(
            new TextEncoder().encode(hello.proof!),
            Uint8Array.from(Buffer.from(hello.tag!, "hex")),
          ),
          role: "inviter",
          now: new Date(),
        }),
      ).resolves.toBeUndefined();
    }
    expect(first!.sent).toHaveLength(1);

    second!.closedByRelay(4006);

    await expect(asking).resolves.toEqual({ outcome: "admitted" });
    expect(first!.closeCalls).toEqual([1000]);
  });

  test("a pairing with a partner waiting at the relay is an admission", async () => {
    const { sockets, options } = harness();
    const asking = askWebSocketRelay(
      await relayDial(),
      new AbortController().signal,
      options,
    );
    const [first, second] = await dialed(sockets, 2);
    first!.open();
    second!.open();
    first!.control("paired");

    await expect(asking).resolves.toEqual({ outcome: "admitted" });
    expect(first!.closeCalls).toEqual([1000]);
    expect(second!.closeCalls).toEqual([1000]);
  });

  test.each([4003, 4004, 4008, 1011, 1001, 4001])(
    "a hello refused with %i is not admitted, with that code",
    async (code) => {
      const { sockets, options } = harness();
      const asking = askWebSocketRelay(
        await relayDial(),
        new AbortController().signal,
        options,
      );
      const [first] = await dialed(sockets, 2);
      first!.open();
      first!.closedByRelay(code);

      await expect(asking).resolves.toEqual({
        outcome: "not_admitted",
        closeCode: code,
      });
    },
  );

  test("a proof refused as expired is made again on the relay's clock, as a run makes it, before the relay answers", async () => {
    const { sockets, options } = harness();
    const asking = askWebSocketRelay(
      await relayDial(),
      new AbortController().signal,
      options,
    );
    const [first, second] = await dialed(sockets, 2);
    first!.open();
    second!.open();
    first!.closedByRelay(4005, String(NOW.getTime() / 1000));
    const [, , third] = await dialed(sockets, 3);
    third!.open();
    expect(JSON.parse(third!.sent[0]!)).toMatchObject({ type: "hello" });
    second!.closedByRelay(4006);

    await expect(asking).resolves.toEqual({ outcome: "admitted" });
  });

  test("a second expired refusal on one socket, or one stating no clock, is not admitted", async () => {
    const { sockets, options } = harness();
    const asking = askWebSocketRelay(
      await relayDial(),
      new AbortController().signal,
      options,
    );
    const [first] = await dialed(sockets, 2);
    first!.open();
    first!.closedByRelay(4005, String(NOW.getTime() / 1000));
    const [, , third] = await dialed(sockets, 3);
    third!.open();
    third!.closedByRelay(4005, String(NOW.getTime() / 1000));
    await expect(asking).resolves.toEqual({
      outcome: "not_admitted",
      closeCode: 4005,
      proofRemadeOnRelayClock: true,
    });

    const unstated = harness();
    const askingAgain = askWebSocketRelay(
      await relayDial(),
      new AbortController().signal,
      unstated.options,
    );
    const [socket] = await dialed(unstated.sockets, 2);
    socket!.open();
    socket!.closedByRelay(4005, "later");
    await expect(askingAgain).resolves.toEqual({
      outcome: "not_admitted",
      closeCode: 4005,
    });
  });

  test("a message the run's relay client does not take is its own answer, and every socket is closed", async () => {
    const { sockets, options } = harness();
    const asking = askWebSocketRelay(
      await relayDial(),
      new AbortController().signal,
      options,
    );
    const [first, second] = await dialed(sockets, 2);
    first!.open();
    second!.open();
    first!.control("welcome");

    await expect(asking).resolves.toEqual({ outcome: "unexpected_message" });
    expect(second!.closeCalls).toEqual([1000]);
  });

  test("a socket that closes before it opens asks the certificate check, and a certificate that does not verify is its own answer", async () => {
    const { sockets, probed, options } = harness("SELF_SIGNED_CERT_IN_CHAIN");
    const asking = askWebSocketRelay(
      await relayDial("wss://relay.example.org:8443/relay"),
      new AbortController().signal,
      options,
    );
    const [first, second] = await dialed(sockets, 2);
    first!.closedByRelay(1006);

    await expect(asking).resolves.toEqual({
      outcome: "certificate_not_verified",
    });
    expect(probed).toEqual([
      { host: "relay.example.org", port: 8443, secure: true },
    ]);
    expect(second!.closeCalls).toEqual([1000]);
  });

  test("a socket that closes before it opens with a certificate that verified is not reached", async () => {
    const { sockets, probed, options } = harness(undefined);
    const asking = askWebSocketRelay(
      await relayDial(),
      new AbortController().signal,
      options,
    );
    const [first] = await dialed(sockets, 2);
    first!.closedByRelay(1006);

    await expect(asking).resolves.toEqual({
      outcome: "not_reached",
      certificateNotChecked: false,
    });
    expect(probed).toEqual([
      { host: "own-relay.example.org", port: 443, secure: true },
    ]);
  });

  test("a socket that opens and then drops is not reached, and no certificate is checked", async () => {
    const { sockets, probed, options } = harness("SELF_SIGNED_CERT_IN_CHAIN");
    const asking = askWebSocketRelay(
      await relayDial(),
      new AbortController().signal,
      options,
    );
    const [first] = await dialed(sockets, 2);
    first!.open();
    first!.closedByRelay(1006);

    await expect(asking).resolves.toEqual({
      outcome: "not_reached",
      certificateNotChecked: false,
    });
    expect(probed).toEqual([]);
  });

  test("a relay that has not answered when the bound expires is not reached, and every socket is closed", async () => {
    const { sockets, options } = harness();
    const bound = new AbortController();
    const asking = askWebSocketRelay(await relayDial(), bound.signal, options);
    const [first, second] = await dialed(sockets, 2);
    first!.open();

    bound.abort();

    await expect(asking).resolves.toEqual({
      outcome: "not_reached",
      certificateNotChecked: false,
    });
    expect(first!.closeCalls).toEqual([1000]);
    expect(second!.closeCalls).toEqual([1000]);
  });
});

// --- the check of a configuration ----------------------------------------------

let dir: string;
let configFile: string;
let keyFile: string;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-doctor-ws-"));
  configFile = path.join(dir, "alcove.yaml");
  keyFile = path.join(dir, ".alcove.key");
  saveKeyFile(keyFile, { sharedSecret: SECRET });
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("no request may be sent in this file"));
});

afterEach(() => {
  fetchSpy.mockRestore();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeConfig(connection: Record<string, unknown>): void {
  fs.writeFileSync(
    configFile,
    YAML.stringify({ connection, linkage_terms: linkageTerms }),
  );
}

interface Asked {
  dial: WebSocketRelayDial;
  signal: AbortSignal;
}

function scriptedAsking(
  answers: Record<string, WebSocketRelayAnswer>,
  asked: Array<Asked>,
): WebSocketRelayAsking {
  return (dial, signal) => {
    asked.push({ dial, signal });
    const answer = answers[dial.url];
    if (answer === undefined) throw new Error(`no answer for ${dial.url}`);
    return Promise.resolve(answer);
  };
}

function gatheringFor(
  answer: boolean,
  requests: Array<{ server: RTCIceServer; signal: AbortSignal }>,
): RelayCandidateGathering {
  return (server, signal) => {
    requests.push({ server, signal });
    return Promise.resolve(answer);
  };
}

async function check(
  answers: Record<string, WebSocketRelayAnswer>,
  extra: { gather?: RelayCandidateGathering; fetch?: typeof fetch } = {},
) {
  const lines: Array<string> = [];
  const asked: Array<Asked> = [];
  const report = await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: (line) => lines.push(line),
    gather:
      extra.gather ??
      (() => Promise.reject(new Error("no TURN url may be asked"))),
    askWebSocket: scriptedAsking(answers, asked),
    ...(extra.fetch !== undefined && { fetch: extra.fetch }),
    now: NOW,
  });
  return { report, lines, asked };
}

function only(report: DoctorReport, id: string) {
  const record = report.checks.find((check) => check.id === id);
  if (record === undefined) throw new Error(`no ${id} check`);
  return record;
}

test("a configuration with only a WebSocket relay is checked, naming the relay before it is asked", async () => {
  writeConfig(webrtcConnection({ websocket_relay: OWN_WEBSOCKET }));

  const { report, lines, asked } = await check({
    [OWN_WEBSOCKET]: { outcome: "admitted" },
  });

  expect(lines).toEqual([
    "This check contacts these hosts, as a run of this configuration does:",
    `  ${OWN_WEBSOCKET}`,
    "    A WebSocket relay a run dials, from connection.websocket_relay. The " +
      "check opens two connections to it, presents on each the proof a run " +
      "presents there, and closes both once the relay answers.",
    "    Whoever runs that relay learns this machine's network address.",
    "It contacts nothing else.",
    "",
  ]);
  expect(asked.map(({ dial }) => dial)).toEqual([
    {
      url: OWN_WEBSOCKET,
      exchangeId: await deriveRelayExchangeId(SECRET),
      relayKey: await deriveRelayKey(SECRET),
      role: "inviter",
    },
  ]);
  expect(verdictOf(report)).toEqual({
    version: 1,
    mode: "relay",
    overall: "ok",
    checks: [
      {
        id: "websocket_1",
        status: "ok",
        url: OWN_WEBSOCKET,
        outcome: "admitted",
      },
    ],
  });
  expect(verdictLines(report)).toEqual([
    `OK: ${OWN_WEBSOCKET}, a WebSocket relay a run dials: admitted; the ` +
      "relay accepted this exchange's proof.",
    "",
    "ALL CHECKS PASSED",
  ]);
});

test("a configuration with a TURN url and WebSocket relays asks them all at once, under the one bound, and reports the WebSocket relays last", async () => {
  writeConfig(
    webrtcConnection({
      turn: [{ url: OWN_TURN }],
      websocket_relay: OWN_WEBSOCKET,
      invitation_relay: { websocket: INVITATION_WEBSOCKET },
    }),
  );
  const requests: Array<{ server: RTCIceServer; signal: AbortSignal }> = [];

  const { report, asked } = await check(
    {
      [OWN_WEBSOCKET]: { outcome: "admitted" },
      [INVITATION_WEBSOCKET]: { outcome: "not_admitted", closeCode: 4003 },
    },
    { gather: gatheringFor(false, requests) },
  );

  expect(report.checks.map((record) => record.id)).toEqual([
    "turn_1",
    "websocket_1",
    "websocket_2",
  ]);
  expect(asked.map(({ dial }) => dial.url)).toEqual([
    OWN_WEBSOCKET,
    INVITATION_WEBSOCKET,
  ]);
  expect(
    new Set([requests[0]?.signal, ...asked.map((a) => a.signal)]).size,
  ).toBe(1);
  expect(overallOf(report)).toBe("fix_and_retry");
  expect(DOCTOR_EXIT_CODE[overallOf(report)]).toBe(78);
});

test("a relay that refuses the proof as not enrolled fails the check with the code, and an invitation's relay names the failed enrollment", async () => {
  writeConfig(
    webrtcConnection({
      invitation_relay: {
        websocket: INVITATION_WEBSOCKET,
        registrar: REGISTRAR,
      },
    }),
  );
  const registrar = fakeRegistrar([]);

  const { report } = await check(
    { [INVITATION_WEBSOCKET]: { outcome: "not_admitted", closeCode: 4003 } },
    { fetch: registrar.fetch },
  );

  const record = only(report, "websocket_1");
  expect(record).toMatchObject({
    status: "fail",
    url: INVITATION_WEBSOCKET,
    outcome: "not_admitted",
    close_code: 4003,
  });
  expect(record.summary).toBe(
    `${INVITATION_WEBSOCKET}, a WebSocket relay a run dials: not admitted; ` +
      "the relay holds no key for this exchange (close code 4003).",
  );
  expect(record.meaning).toContain(
    "The likely cause is the failed enrollment above.",
  );
  expect(record.action).toMatch(/^Run this check again\./);
  expect(overallOf(report)).toBe("fix_and_retry");
});

test("an own relay that refuses the proof as not enrolled points at alcove enroll-relay", async () => {
  writeConfig(webrtcConnection({ websocket_relay: OWN_WEBSOCKET }));

  const { report } = await check({
    [OWN_WEBSOCKET]: { outcome: "not_admitted", closeCode: 4003 },
  });

  expect(only(report, "websocket_1").action).toBe(
    "Enroll this exchange's relay key at the relay's registrar with alcove " +
      "enroll-relay, then run this check again.",
  );
});

test("a relay holding another key points at replacing it", async () => {
  writeConfig(webrtcConnection({ websocket_relay: OWN_WEBSOCKET }));

  const { report } = await check({
    [OWN_WEBSOCKET]: { outcome: "not_admitted", closeCode: 4004 },
  });

  expect(only(report, "websocket_1").action).toContain(
    "alcove enroll-relay --replace-relay-key",
  );
});

test("an own relay naming the invitation's url is decided by the url, as the run's enrollment is: the failed enrollment is its likely cause, and the partner's registrar the action", async () => {
  writeConfig(
    webrtcConnection({
      websocket_relay: INVITATION_WEBSOCKET,
      invitation_relay: {
        websocket: INVITATION_WEBSOCKET,
        registrar: REGISTRAR,
      },
    }),
  );
  const registrar = fakeRegistrar([]);

  const { report } = await check(
    { [INVITATION_WEBSOCKET]: { outcome: "not_admitted", closeCode: 4003 } },
    { fetch: registrar.fetch },
  );

  expect(only(report, "enrollment").status).toBe("warn");
  const record = only(report, "websocket_1");
  expect(record.meaning).toContain(
    "The likely cause is the failed enrollment above.",
  );
  expect(record.action).toMatch(/^Run this check again\. .*your partner/);
});

test("the invitation's relay under an exchange id the invitation names points at alcove enroll-relay, with no enrollment to blame", async () => {
  writeConfig(
    webrtcConnection({
      invitation_relay: {
        websocket: INVITATION_WEBSOCKET,
        websocket_exchange_id: "named-exchange",
        registrar: REGISTRAR,
      },
    }),
  );

  const { report } = await check({
    [INVITATION_WEBSOCKET]: { outcome: "not_admitted", closeCode: 4003 },
  });

  const record = only(report, "websocket_1");
  expect(record.meaning).not.toContain("failed enrollment");
  expect(record.action).toContain("alcove enroll-relay");
});

test("a second expired refusal, of a proof made on the relay's clock, does not blame this computer's clock", async () => {
  writeConfig(webrtcConnection({ websocket_relay: OWN_WEBSOCKET }));

  const { report } = await check({
    [OWN_WEBSOCKET]: {
      outcome: "not_admitted",
      closeCode: 4005,
      proofRemadeOnRelayClock: true,
    },
  });

  const record = only(report, "websocket_1");
  expect(record.meaning).toBe(
    "the relay refused the proof a run presents as expired twice, the " +
      "second time a proof made on the relay's own clock, so this " +
      "computer's clock is not the cause.",
  );
  expect(record.action).toBe(
    "Run this check again. If the relay refuses the proof the same way, " +
      "check the relay and the exchange's enrollment at its registrar.",
  );
  expect(record.summary).toBe(
    `${OWN_WEBSOCKET}, a WebSocket relay a run dials: not admitted; the ` +
      "relay refused the proof as expired (close code 4005).",
  );
});

test("an expired refusal stating no clock points at this computer's clock first", async () => {
  writeConfig(webrtcConnection({ websocket_relay: OWN_WEBSOCKET }));

  const { report } = await check({
    [OWN_WEBSOCKET]: { outcome: "not_admitted", closeCode: 4005 },
  });

  const record = only(report, "websocket_1");
  expect(record.meaning).toContain("without stating its own clock");
  expect(record.action).toMatch(/^Correct this computer's clock, /);
});

test("a relay that received no proof in time points at the network path", async () => {
  writeConfig(webrtcConnection({ websocket_relay: OWN_WEBSOCKET }));

  const { report } = await check({
    [OWN_WEBSOCKET]: { outcome: "not_admitted", closeCode: 4007 },
  });

  const record = only(report, "websocket_1");
  expect(record.meaning).toBe(
    "the relay received no proof from this side within 10 seconds of the " +
      "connection opening, so something on the path may be slow or holding " +
      "messages back.",
  );
  expect(record.action).toBe(
    "Check the network path to the relay, including any proxy, then run " +
      "this check again.",
  );
});

test("a relay that sends a message the run's relay client does not take is that relay's outcome, beside a TURN check that passed", async () => {
  writeConfig(
    webrtcConnection({
      turn: [{ url: OWN_TURN }],
      websocket_relay: OWN_WEBSOCKET,
    }),
  );
  const { sockets, options } = harness();

  const checking = checkRelay({
    configFile,
    keyFile,
    writeStatementLine: () => undefined,
    gather: gatheringFor(true, []),
    askWebSocket: (dial, signal) => askWebSocketRelay(dial, signal, options),
    now: NOW,
  });
  const [first, second] = await dialed(sockets, 2);
  first!.open();
  second!.open();
  first!.control("welcome");
  const report = await checking;

  const record = only(report, "websocket_1");
  expect(verdictOf(report)).toEqual({
    version: 1,
    mode: "relay",
    overall: "fix_and_retry",
    checks: [
      { id: "turn_1", status: "ok", url: OWN_TURN, transport: "tcp" },
      {
        id: "websocket_1",
        status: "fail",
        meaning: record.meaning,
        action: record.action,
        url: OWN_WEBSOCKET,
        outcome: "unexpected_message",
      },
    ],
  });
  expect(record.summary).toBe(
    `${OWN_WEBSOCKET}, a WebSocket relay a run dials: did not answer as an ` +
      "Alcove WebSocket relay.",
  );
  expect(record.action).toBe(
    "Check that the url names an Alcove WebSocket relay, then run this " +
      "check again.",
  );
});

test("a TURN relay not reached beside a WebSocket relay says the WebSocket relay's line shows whether the exchange can still go that way", async () => {
  writeConfig(
    webrtcConnection({
      turn: [{ url: OWN_TURN }],
      websocket_relay: OWN_WEBSOCKET,
    }),
  );

  const { report } = await check(
    { [OWN_WEBSOCKET]: { outcome: "admitted" } },
    { gather: gatheringFor(false, []) },
  );

  expect(only(report, "turn_1").action).toBe(
    `${RELAY_NOT_REACHED_REMEDY} ${WEBSOCKET_RELAY_LINE_BELOW}`,
  );
  expect(WEBSOCKET_RELAY_LINE_BELOW).toBe(
    "Each WebSocket relay line below shows whether the exchange can still " +
      "go that way.",
  );
  expect(overallOf(report)).toBe("fix_and_retry");
});

test("a relay that is not reached fails the check, distinct from not admitted", async () => {
  writeConfig(webrtcConnection({ websocket_relay: OWN_WEBSOCKET }));

  const { report } = await check({
    [OWN_WEBSOCKET]: { outcome: "not_reached", certificateNotChecked: false },
  });

  const record = only(report, "websocket_1");
  expect(verdictOf(report).checks).toEqual([
    {
      id: "websocket_1",
      status: "fail",
      meaning: record.meaning,
      action: record.action,
      url: OWN_WEBSOCKET,
      outcome: "not_reached",
    },
  ]);
  expect(record.summary).toBe(
    `${OWN_WEBSOCKET}, a WebSocket relay a run dials: not reached within 30 s.`,
  );
  expect(record.action).not.toContain("NODE_EXTRA_CA_CERTS");
});

test("a relay whose certificate does not verify under this host's trust names trusting the network's certificate authority", async () => {
  writeConfig(webrtcConnection({ websocket_relay: OWN_WEBSOCKET }));

  const { report } = await check({
    [OWN_WEBSOCKET]: { outcome: "certificate_not_verified" },
  });

  const record = only(report, "websocket_1");
  expect(record).toMatchObject({
    status: "fail",
    outcome: "certificate_not_verified",
  });
  expect(record.summary).toBe(
    `${OWN_WEBSOCKET}, a WebSocket relay a run dials: not reached; its TLS ` +
      "certificate did not verify on this host.",
  );
  expect(record.action).toContain(
    "If this network intercepts TLS, add its certificate authority to this " +
      "machine's trust store, or name a file holding it in " +
      "NODE_EXTRA_CA_CERTS",
  );
});

test("a run with environment proxying on is told the certificate was not checked", async () => {
  writeConfig(webrtcConnection({ websocket_relay: OWN_WEBSOCKET }));

  const { report } = await check({
    [OWN_WEBSOCKET]: { outcome: "not_reached", certificateNotChecked: true },
  });

  const record = only(report, "websocket_1");
  expect(record.meaning).toContain("certificate was not checked");
  expect(record.action).toContain("NODE_EXTRA_CA_CERTS");
});

test("a WebSocket relay allowed_relays leaves out is not asked, and the statement names it", async () => {
  writeConfig(
    webrtcConnection({
      turn: [{ url: OWN_TURN }],
      websocket_relay: OWN_WEBSOCKET,
      allowed_relays: ["own-relay.example.org:3478"],
    }),
  );

  const { report, lines, asked } = await check(
    {},
    { gather: gatheringFor(true, []) },
  );

  expect(asked).toEqual([]);
  expect(report.checks.map((record) => record.id)).toEqual(["turn_1"]);
  expect(lines).toContain(`  ${OWN_WEBSOCKET}`);
  expect(lines).toContain(
    "    A WebSocket relay, from connection.websocket_relay. Left out by " +
      "connection.allowed_relays.",
  );
});

test("a configuration whose every relay allowed_relays leaves out is refused, naming the WebSocket relay too", async () => {
  writeConfig(
    webrtcConnection({
      turn: [{ url: OWN_TURN }],
      websocket_relay: OWN_WEBSOCKET,
      allowed_relays: ["elsewhere.example.org"],
    }),
  );

  await expect(check({})).rejects.toThrow(
    relayCheckAllLeftOutMessage([OWN_TURN, OWN_WEBSOCKET]),
  );
});

test("a configuration with a WebSocket relay and no role is refused before anything is contacted", async () => {
  writeConfig({
    channel: "webrtc",
    server: { host: "peers.example.org" },
    websocket_relay: OWN_WEBSOCKET,
  });

  const checked = check({});
  await expect(checked).rejects.toThrow(UsageError);
  await expect(checked).rejects.toThrow(RELAY_CHECK_ROLE_REQUIRED);
});

test("the enrollment a run makes before it dials the invitation's WebSocket relay is made before the relay is asked", async () => {
  writeConfig(
    webrtcConnection({
      invitation_relay: {
        websocket: INVITATION_WEBSOCKET,
        registrar: REGISTRAR,
      },
    }),
  );
  const registrar = fakeRegistrar([
    registrationAnswer(null, "2026-01-01T01:10:00Z"),
  ]);
  const order: Array<string> = [];
  fetchSpy.mockImplementation(
    (input: string | URL | Request, init?: RequestInit) => {
      order.push("enrollment");
      return registrar.fetch(input, init);
    },
  );

  const report = await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: () => undefined,
    gather: () => Promise.reject(new Error("no TURN url may be asked")),
    askWebSocket: () => {
      order.push("relay");
      return Promise.resolve({ outcome: "admitted" });
    },
    now: NOW,
  });

  expect(order).toEqual(["enrollment", "relay"]);
  expect(report.checks.map((record) => [record.id, record.status])).toEqual([
    ["enrollment", "ok"],
    ["websocket_1", "ok"],
  ]);
});

// --- what never reaches the output ---------------------------------------------

/** The relay's side of every socket the handler dials: the second hello under a role is refused as role taken. */
const relaySockets = vi.hoisted(() => ({ sent: [] as Array<string> }));

class RoleTakingRelaySocket extends FakeRelaySocket {
  static helloed = 0;

  constructor(url: string) {
    super(url);
    setTimeout(() => this.open(), 0);
  }

  override send(data: string): void {
    super.send(data);
    relaySockets.sent.push(data);
    RoleTakingRelaySocket.helloed += 1;
    if (RoleTakingRelaySocket.helloed === 2)
      setTimeout(() => this.closedByRelay(4006), 0);
  }
}

test.each([
  ["--json", { json: true }],
  ["the check lines", {}],
])(
  "the credential, the relay key and the exchange id reach neither stdout nor stderr, %s",
  async (_label, flags) => {
    writeConfig(webrtcConnection({ websocket_relay: OWN_WEBSOCKET }));
    RoleTakingRelaySocket.helloed = 0;
    relaySockets.sent.length = 0;
    vi.stubGlobal("WebSocket", RoleTakingRelaySocket);
    const { stdoutWrites, stderrWrites, restore } = captureStdio();
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        stdoutWrites.push(args.map((a) => String(a)).join(" ") + "\n");
      });
    const previousExitCode = process.exitCode;
    let exitCode: number | string | null | undefined;
    try {
      await relayHandler(
        argv({ "config-file": configFile, "key-file": keyFile, ...flags }),
      );
      exitCode = process.exitCode;
    } finally {
      process.exitCode = previousExitCode;
      logSpy.mockRestore();
      restore();
    }

    expect(exitCode).toBe(0);
    const output = stdoutWrites.join("") + stderrWrites.join("");
    expect(output).toContain(OWN_WEBSOCKET);
    const hellos = relaySockets.sent.map(
      (text) => JSON.parse(text) as Record<string, string>,
    );
    expect(hellos).toHaveLength(2);
    const withheld = [
      SECRET,
      await deriveRelayKey(SECRET),
      await deriveRelayExchangeId(SECRET),
      ...hellos.flatMap((hello) => [hello.tag!, hello.proof!]),
      ...hellos
        .flatMap((hello) => hello.proof!.split("\n"))
        .filter((line) => line.length > 12),
    ];
    for (const value of withheld) expect(output).not.toContain(value);
  },
);
