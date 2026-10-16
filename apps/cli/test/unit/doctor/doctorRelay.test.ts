import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import YAML from "yaml";
import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  deriveRelayExchangeId,
  redactAndSanitizeForDisplay,
  UsageError,
} from "@alcove/core";

import type { RTCIceServer } from "werift";

import {
  checkRelay,
  mountHandler,
  relayHandler,
} from "../../../src/commands/doctor";
import { NO_RELAY_CANDIDATE_GATHERED } from "../../../src/connection/webrtc/iceDiagnostics";
import { runProbe } from "../../../src/doctor/probe";
import type { ProbeDeps } from "../../../src/doctor/probe";
import {
  ENROLLMENT_CHECK_ID,
  ENROLLMENT_FAILED_ACTION,
  NOT_CONTACTED_ACTION,
  RELAY_CHECK_NO_TURN_URL,
  RELAY_CHECK_WEBRTC_ONLY,
  RELAY_NOT_REACHED_REMEDY,
  relayCheckPlan,
  runRelayCheck,
  turnUrlTransport,
} from "../../../src/doctor/relay";
import type { RelayCandidateGathering } from "../../../src/doctor/relay";
import {
  DOCTOR_EXIT_CODE,
  overallOf,
  verdictLines,
  verdictOf,
} from "../../../src/doctor/verdict";
import type { DoctorReport } from "../../../src/doctor/verdict";
import {
  INVITATION_RELAY_NOT_ENROLLED_REMEDY,
  invitationRelayNotEnrolledStatement,
} from "../../../src/invitationRelayEnrollment";
import { saveKeyFile } from "../../../src/keyFile";
import { captureProcessExit, runToExit } from "../../exitCapture";
import {
  argv,
  captureStdio,
  snapshotDiagnosticSinkAndLevel,
} from "../../loggingTestSupport";
import {
  fakeRegistrar,
  jsonResponse,
  registrationAnswer,
} from "../relayRegistrarFake";

// Every peer connection werift is asked for, from any path in this file: the
// relay is only ever contacted through one.
const weriftPeers = vi.hoisted(() => ({ constructed: 0 }));
vi.mock("werift", () => ({
  RTCPeerConnection: class {
    constructor() {
      weriftPeers.constructed += 1;
      throw new Error("no werift peer connection may be built in this file");
    }
  },
}));

// The gathering `doctor relay` uses when a handler runs it: a test installs its
// own stub for the run.
const handlerGathering = vi.hoisted(() => ({
  stub: undefined as RelayCandidateGathering | undefined,
}));
vi.mock(
  "../../../src/connection/webrtc/weriftPeer",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../src/connection/webrtc/weriftPeer")
    >()),
    gatherRelayCandidate: (server: RTCIceServer, signal: AbortSignal) => {
      if (handlerGathering.stub === undefined)
        throw new Error("no gathering stub installed");
      return handlerGathering.stub(server, signal);
    },
  }),
);

snapshotDiagnosticSinkAndLevel();

const SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM";
const OWN_TURN = "turn:own-relay.example.org:3478?transport=tcp";
const STATIC_TURN = "turn:static-relay.example.org:3478";
const INVITATION_TURN = "turns:relay.example.org:443?transport=tcp";
const SECOND_INVITATION_TURN = "turn:relay-2.example.org:3478";
const REGISTRAR = "https://registrar.example.org";
const LAPSES_AT = "2026-01-01T01:10:00Z";

const LATER_URL_MEANING =
  "a run of this configuration does not contact this relay: a run " +
  "allocates on the first TURN url it lists alone, so the check does not " +
  "ask it.";

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

let dir: string;
let configFile: string;
let keyFile: string;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-doctor-relay-"));
  configFile = path.join(dir, "alcove.yaml");
  keyFile = path.join(dir, ".alcove.key");
  saveKeyFile(keyFile, { sharedSecret: SECRET });
  weriftPeers.constructed = 0;
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("no request may be sent in this file"));
});

afterEach(() => {
  fetchSpy.mockRestore();
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeConfig(connection: Record<string, unknown>): void {
  fs.writeFileSync(
    configFile,
    YAML.stringify({ connection, linkage_terms: linkageTerms }),
  );
}

/**
 * Own entries first -- a minted one, then a static one -- then the
 * invitation's relay and registrar: a run allocates on the own minted entry
 * and does not enroll at the registrar.
 */
function writeOwnFirstConfig(): void {
  writeConfig(
    webrtcConnection({
      turn: [
        { url: OWN_TURN },
        {
          url: STATIC_TURN,
          username: "static-user",
          credential: "placeholder-not-a-secret",
        },
      ],
      invitation_relay: { turn: [INVITATION_TURN], registrar: REGISTRAR },
    }),
  );
}

/**
 * The invitation's two urls and its registrar alone: a run allocates on the
 * first invitation url and enrolls at the registrar.
 */
function writeInvitationFirstConfig(): void {
  writeConfig(
    webrtcConnection({
      invitation_relay: {
        turn: [INVITATION_TURN, SECOND_INVITATION_TURN],
        registrar: REGISTRAR,
      },
    }),
  );
}

/** A gathering that answers each url from `answers`, recording every request. */
function scriptedGathering(
  answers: Record<string, boolean | "never">,
  requests: Array<RTCIceServer>,
): RelayCandidateGathering {
  return (server, signal) => {
    requests.push(server);
    const answer = answers[server.urls as string];
    if (answer === "never")
      return new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(false)),
      );
    return Promise.resolve(answer === true);
  };
}

function checkFor(report: DoctorReport, url: string) {
  const check = report.checks.find((entry) => entry.url === url);
  if (check === undefined) throw new Error(`no check for ${url}`);
  return check;
}

function contactedRelayLine(transportAndSource: string): string {
  return (
    `    The relay a run allocates on, ${transportAndSource}. The check asks ` +
    "it for a relay address, sending the credential a run sends there."
  );
}
const CONTACTED_RELAY_DISCLOSURE =
  "    Whoever runs that relay learns this machine's network address.";
const REGISTRAR_DISCLOSURE =
  "    Whoever runs that registrar learns this machine's network address.";
function laterUrlLine(transportAndSource: string): string {
  return (
    `    ${transportAndSource}. A run allocates on the first TURN url it ` +
    "lists alone."
  );
}

const OWN_FIRST_STATEMENT = [
  "This check contacts these hosts, as a run of this configuration does:",
  `  ${OWN_TURN}`,
  contactedRelayLine("over TCP, from connection.turn"),
  CONTACTED_RELAY_DISCLOSURE,
  "It does not contact these hosts, because a run of this configuration " +
    "does not:",
  `  ${STATIC_TURN}`,
  laterUrlLine("Over UDP, then TCP, from connection.turn"),
  `  ${INVITATION_TURN}`,
  laterUrlLine("Over TLS, from your partner's invitation"),
  `  ${REGISTRAR}`,
  "    The relay registrar your partner's invitation names. A run does not " +
    "enroll there, because the relay it allocates on is not one the " +
    "invitation names.",
  "It contacts nothing else.",
  "",
];

const INVITATION_FIRST_STATEMENT = [
  "This check contacts these hosts, as a run of this configuration does:",
  `  ${INVITATION_TURN}`,
  contactedRelayLine("over TLS, from your partner's invitation"),
  CONTACTED_RELAY_DISCLOSURE,
  `  ${REGISTRAR}`,
  "    The relay registrar your partner's invitation names. Before it asks " +
    "the relay, the check enrolls this exchange's relay key there, as a run " +
    "does just before it connects.",
  REGISTRAR_DISCLOSURE,
  "It does not contact these hosts, because a run of this configuration " +
    "does not:",
  `  ${SECOND_INVITATION_TURN}`,
  laterUrlLine("Over UDP, then TCP, from your partner's invitation"),
  "It contacts nothing else.",
  "",
];

const STATIC_FIRST_REGISTRAR_LINE =
  "    The relay registrar your partner's invitation names. A run does not " +
  "enroll there, because the relay it allocates on is sent its " +
  "connection.turn entry's own credential.";

test("every line of the host statement fits the display bound, so none is cut", () => {
  for (const line of [
    ...OWN_FIRST_STATEMENT,
    ...INVITATION_FIRST_STATEMENT,
    STATIC_FIRST_REGISTRAR_LINE,
  ])
    expect(line.length).toBeLessThanOrEqual(DEFAULT_MAX_DISPLAY_LENGTH);
});

test("the statement says whoever runs the contacted relay learns this machine's network address, as it says of the registrar", async () => {
  writeInvitationFirstConfig();
  const lines: Array<string> = [];

  await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: (line) => lines.push(line),
    fetch: fakeRegistrar([registrationAnswer(null, LAPSES_AT)]).fetch,
    gather: scriptedGathering({ [INVITATION_TURN]: true }, []),
  });

  const relayIndex = lines.indexOf(`  ${INVITATION_TURN}`);
  const registrarIndex = lines.indexOf(`  ${REGISTRAR}`);
  expect(lines[relayIndex + 2]).toBe(
    "    Whoever runs that relay learns this machine's network address.",
  );
  expect(lines[registrarIndex + 2]).toBe(
    "    Whoever runs that registrar learns this machine's network address.",
  );
});

test("a url whose hostname is 252 characters is clipped on its own line alone, and its transport and source show on the line below", async () => {
  const longHost = [
    "a".repeat(63),
    "b".repeat(63),
    "c".repeat(63),
    "d".repeat(60),
  ].join(".");
  expect(longHost).toHaveLength(252);
  const firstLongUrl = `turn:${longHost}:3478`;
  const laterLongUrl = `turn:${longHost}:3479`;
  writeConfig(
    webrtcConnection({
      invitation_relay: {
        turn: [firstLongUrl, laterLongUrl],
        registrar: REGISTRAR,
      },
    }),
  );
  const lines: Array<string> = [];
  const registrar = fakeRegistrar([registrationAnswer(null, LAPSES_AT)]);

  const report = await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: (line) => lines.push(line),
    fetch: registrar.fetch,
    gather: scriptedGathering({ [firstLongUrl]: true }, []),
  });

  const firstIndex = lines.indexOf(`  ${firstLongUrl}`);
  const laterIndex = lines.indexOf(`  ${laterLongUrl}`);
  expect(firstIndex).toBeGreaterThan(0);
  expect(laterIndex).toBeGreaterThan(firstIndex);
  expect(lines[firstIndex + 1]).toBe(
    contactedRelayLine("over UDP, then TCP, from your partner's invitation"),
  );
  expect(lines[firstIndex + 2]).toBe(CONTACTED_RELAY_DISCLOSURE);
  expect(lines[laterIndex + 1]).toBe(
    laterUrlLine("Over UDP, then TCP, from your partner's invitation"),
  );
  for (const [index, line] of lines.entries()) {
    const shown = String(redactAndSanitizeForDisplay(line));
    if (index === firstIndex || index === laterIndex) {
      expect(shown).not.toBe(line);
      expect(shown.startsWith(`  turn:${longHost.slice(0, 200)}`)).toBe(true);
    } else expect(shown).toBe(line);
  }
  expect(report.checks.map((check) => check.url)).toEqual([
    undefined,
    firstLongUrl,
    laterLongUrl,
  ]);
});

// --- a plain doctor contacts no relay and no registrar ------------------------

test("doctor probe and doctor mount build no peer connection and send no request", async () => {
  const contacted: Array<string> = [];
  const probeDeps: ProbeDeps = {
    runner: {
      run: () =>
        Promise.resolve({
          code: null,
          output: "",
          timedOut: false,
          spawnErrorCode: "ENOENT",
        }),
    },
    lookupHost: (host) => {
      contacted.push(host);
      return Promise.resolve("10.10.0.5");
    },
    connectTcp: (host) => {
      contacted.push(host);
      return Promise.resolve(true);
    },
    announce: () => undefined,
  };
  await runProbe(
    {
      server: "files.example.org",
      share: "exchange",
      subdirectory: "",
      username: "svc-alcove",
      domain: "",
      password: "",
      dialect: "",
      marker: "",
      token: "",
    },
    probeDeps,
  );

  const mountDirectory = fs.mkdtempSync(path.join(dir, "mount-"));
  const { restore } = captureStdio();
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const exitSpy = captureProcessExit();
  const previousExitCode = process.exitCode;
  try {
    await runToExit(() =>
      mountHandler(argv({ directory: mountDirectory, json: true })),
    );
  } finally {
    process.exitCode = previousExitCode;
    exitSpy.mockRestore();
    logSpy.mockRestore();
    restore();
  }

  expect(new Set(contacted)).toEqual(new Set(["files.example.org"]));
  expect(weriftPeers.constructed).toBe(0);
  expect(fetchSpy).not.toHaveBeenCalled();
});

// --- what the check contacts ---------------------------------------------------

test("an own-first configuration asks its first url alone, with the run's minted credential, and does not contact the registrar", async () => {
  writeOwnFirstConfig();
  const events: Array<string> = [];
  const requests: Array<RTCIceServer> = [];
  const registrar = fakeRegistrar([registrationAnswer(null, LAPSES_AT)]);
  const gather = scriptedGathering({ [OWN_TURN]: true }, requests);

  const report = await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: (line) => events.push(`line ${line}`),
    fetch: (input, init) => {
      events.push(`enroll ${String(input)}`);
      return registrar.fetch(input, init);
    },
    gather: (server, signal) => {
      events.push(`request ${server.urls as string}`);
      return gather(server, signal);
    },
    now: new Date("2026-01-01T00:00:00Z"),
  });

  expect(events).toEqual([
    ...OWN_FIRST_STATEMENT.map((line) => `line ${line}`),
    `request ${OWN_TURN}`,
  ]);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.urls).toBe(OWN_TURN);
  expect(requests[0]?.username).toMatch(/^\d+:alcove$/);
  expect(requests[0]?.credential).not.toBe("placeholder-not-a-secret");
  expect(registrar.requests).toEqual([]);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(report.checks.map((check) => [check.id, check.status])).toEqual([
    [ENROLLMENT_CHECK_ID, "skipped"],
    ["turn_1", "ok"],
    ["turn_2", "skipped"],
    ["turn_3", "skipped"],
  ]);
});

test("an invitation-first configuration enrolls at the registrar once, before its one request, to the first url", async () => {
  writeInvitationFirstConfig();
  const events: Array<string> = [];
  const requests: Array<RTCIceServer> = [];
  const registrar = fakeRegistrar([registrationAnswer(null, LAPSES_AT)]);
  const gather = scriptedGathering({ [INVITATION_TURN]: true }, requests);

  const report = await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: (line) => events.push(`line ${line}`),
    fetch: (input, init) => {
      events.push(`enroll ${String(input)}`);
      return registrar.fetch(input, init);
    },
    gather: (server, signal) => {
      events.push(`request ${server.urls as string}`);
      return gather(server, signal);
    },
  });

  const exchangeId = await deriveRelayExchangeId(SECRET);
  expect(events).toEqual([
    ...INVITATION_FIRST_STATEMENT.map((line) => `line ${line}`),
    `enroll ${REGISTRAR}/exchanges/${exchangeId}`,
    `request ${INVITATION_TURN}`,
  ]);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.username).toMatch(/^\d+:alcove$/);
  expect(registrar.requests).toHaveLength(1);
  expect(registrar.requests[0]).toMatchObject({
    method: "POST",
    authorization: null,
  });
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(report.checks.map((check) => [check.id, check.status])).toEqual([
    [ENROLLMENT_CHECK_ID, "ok"],
    ["turn_1", "ok"],
    ["turn_2", "skipped"],
  ]);
});

test("a static entry first, at an invitation url, is asked with its own pair and the registrar is not contacted", async () => {
  writeConfig(
    webrtcConnection({
      turn: [
        {
          url: INVITATION_TURN,
          username: "static-user",
          credential: "placeholder-not-a-secret",
        },
      ],
      invitation_relay: { turn: [INVITATION_TURN], registrar: REGISTRAR },
    }),
  );
  const lines: Array<string> = [];
  const requests: Array<RTCIceServer> = [];
  const registrar = fakeRegistrar([registrationAnswer()]);

  const report = await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: (line) => lines.push(line),
    fetch: registrar.fetch,
    gather: scriptedGathering({ [INVITATION_TURN]: true }, requests),
  });

  expect(requests).toEqual([
    {
      urls: INVITATION_TURN,
      username: "static-user",
      credential: "placeholder-not-a-secret",
    },
  ]);
  expect(registrar.requests).toEqual([]);
  expect(lines).toContain(STATIC_FIRST_REGISTRAR_LINE);
  expect(verdictOf(report).checks[0]).toEqual({
    id: ENROLLMENT_CHECK_ID,
    status: "skipped",
    meaning:
      "a run of this configuration does not enroll at this registrar, " +
      "because the relay it allocates on is sent its connection.turn " +
      "entry's own credential, so the check does not contact it.",
    registrar: REGISTRAR,
  });
});

test("a registrar a run does not enroll at is a skipped enrollment line naming why", async () => {
  writeOwnFirstConfig();

  const report = await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: () => undefined,
    gather: scriptedGathering({ [OWN_TURN]: true }, []),
  });

  expect(verdictOf(report).checks[0]).toEqual({
    id: ENROLLMENT_CHECK_ID,
    status: "skipped",
    meaning:
      "a run of this configuration does not enroll at this registrar, " +
      "because the relay it allocates on is not one the invitation names, " +
      "so the check does not contact it.",
    registrar: REGISTRAR,
  });
  expect(verdictLines(report)[0]).toBe(
    `SKIP: the relay registrar at ${REGISTRAR} that your partner's ` +
      "invitation names: not contacted.",
  );
  expect(overallOf(report)).toBe("ok");
});

test("a configuration whose invitation relay names no registrar contacts none, and says so", async () => {
  writeConfig(
    webrtcConnection({
      turn: [{ url: OWN_TURN }],
      relay_registrar: {
        url: "https://own-registrar.example.org",
        exchange_id: "exchange-1",
      },
      invitation_relay: { turn: [INVITATION_TURN] },
    }),
  );
  const lines: Array<string> = [];
  const requests: Array<RTCIceServer> = [];
  const registrar = fakeRegistrar([registrationAnswer()]);

  const report = await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: (line) => lines.push(line),
    fetch: registrar.fetch,
    gather: scriptedGathering({ [OWN_TURN]: true }, requests),
  });

  expect(registrar.requests).toEqual([]);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(requests.map((server) => server.urls)).toEqual([OWN_TURN]);
  expect(lines).toContain(
    "It contacts nothing else. This configuration's invitation_relay names " +
      "no relay registrar, so it contacts none and enrolls nothing.",
  );
  expect(lines.join("\n")).not.toContain("own-registrar.example.org");
  expect(report.checks.map((check) => check.id)).toEqual(["turn_1", "turn_2"]);
});

test("a configuration with no invitation_relay block says it contacts nothing else, and does not name the block", async () => {
  writeConfig(
    webrtcConnection({
      turn: [{ url: OWN_TURN, username: "u", credential: "c" }],
    }),
  );
  const lines: Array<string> = [];

  const report = await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: (line) => lines.push(line),
    gather: scriptedGathering({ [OWN_TURN]: true }, []),
  });

  expect(lines).toContain("It contacts nothing else.");
  expect(lines.join("\n")).not.toContain("invitation_relay");
  expect(lines.join("\n")).not.toContain("does not contact");
  expect(report.checks.map((check) => check.id)).toEqual(["turn_1"]);
});

// --- each outcome --------------------------------------------------------------

test("a relay that gives a relay candidate is reported reached", async () => {
  writeConfig(
    webrtcConnection({ invitation_relay: { turn: [INVITATION_TURN] } }),
  );

  const report = await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: () => undefined,
    gather: scriptedGathering({ [INVITATION_TURN]: true }, []),
  });

  expect(verdictOf(report)).toEqual({
    version: 1,
    mode: "relay",
    overall: "ok",
    checks: [
      { id: "turn_1", status: "ok", url: INVITATION_TURN, transport: "tls" },
    ],
  });
  expect(verdictLines(report)[0]).toBe(
    `OK: ${INVITATION_TURN} over TLS, the relay a run allocates on: reached; ` +
      "the relay gave a relay address.",
  );
  expect(DOCTOR_EXIT_CODE[overallOf(report)]).toBe(0);
});

test("the relay a run allocates on that gives none fails the check, with the run's remedy, and exits 78", async () => {
  writeOwnFirstConfig();

  const report = await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: () => undefined,
    gather: scriptedGathering({ [OWN_TURN]: false }, []),
  });

  expect(overallOf(report)).toBe("fix_and_retry");
  expect(DOCTOR_EXIT_CODE[overallOf(report)]).toBe(78);
  const own = checkFor(report, OWN_TURN);
  expect(own).toMatchObject({
    id: "turn_1",
    status: "fail",
    transport: "tcp",
    action: RELAY_NOT_REACHED_REMEDY,
  });
  expect(own.summary).toBe(
    `${OWN_TURN} over TCP, the relay a run allocates on: ` +
      `${NO_RELAY_CANDIDATE_GATHERED} within 30 s.`,
  );
  expect(own.meaning).toContain("the check cannot tell which");
  expect(own.meaning).toContain("alcove enroll-relay");
  const lines = verdictLines(report).join("\n");
  expect(lines).toContain(`FAIL: ${OWN_TURN} over TCP`);
  expect(lines).toContain("ACTION:  Fix the relay, or arrange a direct path;");
});

test("each later url is skipped, with no request, and leaves the verdict ok", async () => {
  writeOwnFirstConfig();
  const requests: Array<RTCIceServer> = [];

  const report = await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: () => undefined,
    gather: scriptedGathering(
      { [OWN_TURN]: true, [STATIC_TURN]: true, [INVITATION_TURN]: true },
      requests,
    ),
  });

  expect(requests.map((server) => server.urls)).toEqual([OWN_TURN]);
  expect(overallOf(report)).toBe("ok");
  expect(DOCTOR_EXIT_CODE[overallOf(report)]).toBe(0);
  expect(verdictOf(report).checks.slice(2)).toEqual([
    {
      id: "turn_2",
      status: "skipped",
      meaning: LATER_URL_MEANING,
      action: NOT_CONTACTED_ACTION,
      url: STATIC_TURN,
      transport: "udp",
    },
    {
      id: "turn_3",
      status: "skipped",
      meaning: LATER_URL_MEANING,
      action: NOT_CONTACTED_ACTION,
      url: INVITATION_TURN,
      transport: "tls",
    },
  ]);
  expect(checkFor(report, STATIC_TURN).summary).toBe(
    `${STATIC_TURN}, listed after the relay a run allocates on: not contacted.`,
  );
  expect(NOT_CONTACTED_ACTION).toBe(
    "If this relay should be the one a run allocates on, list it first " +
      "under connection.turn and run this check again.",
  );
});

test("the later urls' shared meaning and action print once, under the last of them", async () => {
  writeOwnFirstConfig();

  const report = await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: () => undefined,
    gather: scriptedGathering({ [OWN_TURN]: true }, []),
  });

  const lines = verdictLines(report);
  const second = lines.indexOf(
    `SKIP: ${STATIC_TURN}, listed after the relay a run allocates on: not contacted.`,
  );
  expect(second).toBeGreaterThan(0);
  expect(lines[second + 1]).toBe(
    `SKIP: ${INVITATION_TURN}, listed after the relay a run allocates on: not contacted.`,
  );
  expect(
    lines.filter((line) =>
      line.startsWith(
        "MEANING: a run of this configuration does not contact this relay",
      ),
    ),
  ).toHaveLength(1);
  expect(
    lines.filter((line) => line.startsWith("ACTION:  If this relay should be")),
  ).toHaveLength(1);
  expect(lines.at(-1)).toBe("ALL CHECKS PASSED");
});

test("a relay that has not answered when the bound expires is reported not reached", async () => {
  writeConfig(webrtcConnection({ turn: [{ url: OWN_TURN }] }));
  const started = Date.now();

  const report = await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: () => undefined,
    gather: scriptedGathering({ [OWN_TURN]: "never" }, []),
    boundMs: 50,
  });

  expect(Date.now() - started).toBeLessThan(5_000);
  expect(checkFor(report, OWN_TURN)).toMatchObject({
    status: "fail",
    summary:
      `${OWN_TURN} over TCP, the relay a run allocates on: ` +
      `${NO_RELAY_CANDIDATE_GATHERED} within 0 s.`,
  });
});

test("a gather that rejects ends the check with its error and aborts its signal", async () => {
  const signals: Array<AbortSignal> = [];
  const plan = relayCheckPlan(
    { turn: [{ url: OWN_TURN, username: "u", credential: "c" }] },
    undefined,
  );

  const checked = runRelayCheck(
    plan,
    (_server, signal) => {
      signals.push(signal);
      return Promise.reject(new Error("gather failed"));
    },
    60_000,
  );

  await expect(checked).rejects.toThrow("gather failed");
  expect(signals).toHaveLength(1);
  expect(signals[0]?.aborted).toBe(true);
});

test("an enrollment given where the run would not enroll is refused as a fault", async () => {
  const plan = relayCheckPlan(
    { turn: [{ url: OWN_TURN, username: "u", credential: "c" }] },
    undefined,
  );
  const requests: Array<RTCIceServer> = [];

  await expect(
    runRelayCheck(plan, scriptedGathering({}, requests), 60_000, {
      registrar: REGISTRAR,
      outcome: { kind: "enrolled", lapsesAt: null },
    }),
  ).rejects.toThrow("an enrollment is given exactly where a run enrolls");
  expect(requests).toEqual([]);
});

test("an invitation relay with no registrar that gives none names the missing enrollment", async () => {
  writeConfig(
    webrtcConnection({ invitation_relay: { turn: [INVITATION_TURN] } }),
  );

  const report = await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: () => undefined,
    gather: scriptedGathering({ [INVITATION_TURN]: false }, []),
  });

  expect(checkFor(report, INVITATION_TURN).meaning).toContain(
    "until the exchange's relay key is enrolled there.",
  );
  expect(checkFor(report, INVITATION_TURN).meaning).not.toContain(
    "failed enrollment",
  );
});

// --- the enrollment's line -------------------------------------------------------

test("an enrollment the registrar confirms is an OK line with the lapse it states", async () => {
  writeInvitationFirstConfig();

  const report = await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: () => undefined,
    fetch: fakeRegistrar([registrationAnswer(null, LAPSES_AT)]).fetch,
    gather: scriptedGathering({ [INVITATION_TURN]: true }, []),
  });

  expect(verdictOf(report)).toEqual({
    version: 1,
    mode: "relay",
    overall: "ok",
    checks: [
      {
        id: ENROLLMENT_CHECK_ID,
        status: "ok",
        registrar: REGISTRAR,
        lapses_at: LAPSES_AT,
      },
      { id: "turn_1", status: "ok", url: INVITATION_TURN, transport: "tls" },
      {
        id: "turn_2",
        status: "skipped",
        meaning: LATER_URL_MEANING,
        action: NOT_CONTACTED_ACTION,
        url: SECOND_INVITATION_TURN,
        transport: "udp",
      },
    ],
  });
  expect(verdictLines(report)[0]).toBe(
    `OK: the relay registrar at ${REGISTRAR} that your partner's invitation ` +
      `names enrolled this exchange, until ${LAPSES_AT}.`,
  );
});

test("an enrollment with no lapse states none, on the line and in the verdict", async () => {
  writeInvitationFirstConfig();

  const report = await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: () => undefined,
    fetch: fakeRegistrar([registrationAnswer()]).fetch,
    gather: scriptedGathering({ [INVITATION_TURN]: true }, []),
  });

  expect(verdictOf(report).checks[0]).toEqual({
    id: ENROLLMENT_CHECK_ID,
    status: "ok",
    registrar: REGISTRAR,
  });
  expect(verdictLines(report)[0]).toBe(
    `OK: the relay registrar at ${REGISTRAR} that your partner's invitation ` +
      "names enrolled this exchange.",
  );
});

test("a refused enrollment is a WARN line that, with the first url reached and a later one skipped, leaves the verdict ok", async () => {
  writeInvitationFirstConfig();
  const requests: Array<RTCIceServer> = [];

  const report = await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: () => undefined,
    fetch: fakeRegistrar([jsonResponse(409, { error: "no" })]).fetch,
    gather: scriptedGathering({ [INVITATION_TURN]: true }, requests),
  });

  expect(requests).toHaveLength(1);
  expect(report.checks.map((check) => [check.id, check.status])).toEqual([
    [ENROLLMENT_CHECK_ID, "warn"],
    ["turn_1", "ok"],
    ["turn_2", "skipped"],
  ]);
  const enrollment = report.checks[0];
  expect(enrollment).toMatchObject({
    registrar: REGISTRAR,
    summary: invitationRelayNotEnrolledStatement(REGISTRAR, "HTTP 409: no"),
    action: ENROLLMENT_FAILED_ACTION,
  });
  expect(verdictOf(report).checks[0]).toEqual({
    id: ENROLLMENT_CHECK_ID,
    status: "warn",
    meaning: enrollment?.meaning,
    action: ENROLLMENT_FAILED_ACTION,
    registrar: REGISTRAR,
  });
  expect(verdictLines(report)[0]).toBe(
    `WARN: the relay registrar at ${REGISTRAR} that your partner's ` +
      "invitation names did not enroll this exchange (HTTP 409: no).",
  );
  expect(overallOf(report)).toBe("ok");
  expect(DOCTOR_EXIT_CODE[overallOf(report)]).toBe(0);
});

test("a refused enrollment with the first url not reached fails the check on that url's line", async () => {
  writeInvitationFirstConfig();

  const report = await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: () => undefined,
    fetch: fakeRegistrar([jsonResponse(409, { error: "no" })]).fetch,
    gather: scriptedGathering({ [INVITATION_TURN]: false }, []),
  });

  expect(report.checks.map((check) => [check.id, check.status])).toEqual([
    [ENROLLMENT_CHECK_ID, "warn"],
    ["turn_1", "fail"],
    ["turn_2", "skipped"],
  ]);
  const invitation = checkFor(report, INVITATION_TURN);
  expect(invitation.action).toBe(RELAY_NOT_REACHED_REMEDY);
  expect(invitation.meaning).toContain(
    "The likely cause is the failed enrollment above",
  );
  expect(overallOf(report)).toBe("fix_and_retry");
  expect(DOCTOR_EXIT_CODE[overallOf(report)]).toBe(78);
});

test("a failed enrollment's action is to retry, then ask the partner about the registrar", () => {
  expect(ENROLLMENT_FAILED_ACTION).toBe(
    "Run this check again. If the enrollment keeps failing, ask your " +
      "partner whether the relay registrar their invitation names is up. A " +
      "run goes on without this enrollment, but the relay your partner's " +
      "invitation names refuses the run's credential until either of you " +
      "enrolls the exchange there.",
  );
  expect(ENROLLMENT_FAILED_ACTION).not.toBe(
    INVITATION_RELAY_NOT_ENROLLED_REMEDY,
  );
});

test("a registrar that cannot be reached is a WARN line, and the relay is still asked", async () => {
  writeInvitationFirstConfig();
  const requests: Array<RTCIceServer> = [];

  const report = await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: () => undefined,
    fetch: fakeRegistrar([]).fetch,
    gather: scriptedGathering({ [INVITATION_TURN]: true }, requests),
  });

  expect(requests).toHaveLength(1);
  const enrollment = report.checks[0];
  expect(enrollment?.status).toBe("warn");
  expect(enrollment?.summary).toMatch(
    /^the relay registrar at https:\/\/registrar\.example\.org that your partner's invitation names did not enroll this exchange \(.+\)\.$/,
  );
  expect(enrollment?.action).toBe(ENROLLMENT_FAILED_ACTION);
  expect(checkFor(report, INVITATION_TURN).status).toBe("ok");
  expect(overallOf(report)).toBe("ok");
});

// --- the host statement through the handler -------------------------------------

test.each([
  ["--json at the default level", { json: true }],
  ["--json at warn", { json: true, "log-level": "warn" }],
  ["--json at silent", { json: true, "log-level": "silent" }],
  ["the check lines at warn", { "log-level": "warn" }],
  ["the check lines at silent", { "log-level": "silent" }],
] as const)(
  "the handler writes the host statement to stderr before its first request, %s",
  async (_label, flags) => {
    writeInvitationFirstConfig();
    const registrar = fakeRegistrar([registrationAnswer(null, LAPSES_AT)]);
    const { stdoutWrites, stderrWrites, restore } = captureStdio();
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        stdoutWrites.push(args.map((a) => String(a)).join(" ") + "\n");
      });
    const stderrBefore: Array<string> = [];
    fetchSpy.mockImplementation(
      (input: string | URL | Request, init?: RequestInit) => {
        stderrBefore.push(stderrWrites.join(""));
        return registrar.fetch(input, init);
      },
    );
    const requests: Array<RTCIceServer> = [];
    handlerGathering.stub = (server, signal) => {
      stderrBefore.push(stderrWrites.join(""));
      return scriptedGathering({}, requests)(server, signal);
    };
    const previousExitCode = process.exitCode;
    try {
      await relayHandler(
        argv({ "config-file": configFile, "key-file": keyFile, ...flags }),
      );
    } finally {
      process.exitCode = previousExitCode;
      logSpy.mockRestore();
      restore();
      handlerGathering.stub = undefined;
    }

    expect(registrar.requests).toHaveLength(1);
    expect(requests.map((server) => server.urls)).toEqual([INVITATION_TURN]);
    expect(stderrBefore).toHaveLength(2);
    for (const written of stderrBefore)
      expect(written).toContain(INVITATION_FIRST_STATEMENT.join("\n"));
    if ("json" in flags) {
      const stdout = stdoutWrites.join("");
      expect(stdout.trimEnd().split("\n")).toHaveLength(1);
      expect(JSON.parse(stdout)).toMatchObject({ mode: "relay" });
      expect(stdout).not.toContain("network address");
    }
  },
);

test("the handler writes the host statement to the log file before its first request, at silent and under --json", async () => {
  writeOwnFirstConfig();
  const logFile = path.join(dir, "doctor.log");
  const { stdoutWrites, stderrWrites, restore } = captureStdio();
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      stdoutWrites.push(args.map((a) => String(a)).join(" ") + "\n");
    });
  const fileBefore: Array<string> = [];
  const requests: Array<RTCIceServer> = [];
  handlerGathering.stub = (server, signal) => {
    fileBefore.push(fs.readFileSync(logFile, "utf8"));
    return scriptedGathering({}, requests)(server, signal);
  };
  const previousExitCode = process.exitCode;
  try {
    await relayHandler(
      argv({
        "config-file": configFile,
        "key-file": keyFile,
        "log-file": logFile,
        "log-level": "silent",
        json: true,
      }),
    );
  } finally {
    process.exitCode = previousExitCode;
    logSpy.mockRestore();
    restore();
    handlerGathering.stub = undefined;
  }

  expect(fetchSpy).not.toHaveBeenCalled();
  expect(requests.map((server) => server.urls)).toEqual([OWN_TURN]);
  expect(fileBefore).toHaveLength(1);
  expect(fileBefore[0]).toContain(OWN_FIRST_STATEMENT.join("\n"));
  expect(stderrWrites.join("")).toBe("");
  expect(stdoutWrites.join("").trimEnd().split("\n")).toHaveLength(1);
  expect(stdoutWrites.join("")).not.toContain("It does not contact");
});

// --- the refusals --------------------------------------------------------------

test("a configuration that is not webrtc is refused before anything is contacted", async () => {
  writeConfig({ channel: "filedrop", path: path.join(dir, "drop") });
  const requests: Array<RTCIceServer> = [];
  const lines: Array<string> = [];

  const checked = checkRelay({
    configFile,
    keyFile,
    writeStatementLine: (line) => lines.push(line),
    gather: scriptedGathering({}, requests),
  });

  await expect(checked).rejects.toThrow(UsageError);
  await expect(checked).rejects.toThrow(RELAY_CHECK_WEBRTC_ONLY);
  expect(lines).toEqual([]);
  expect(requests).toEqual([]);
});

test("a webrtc configuration listing no TURN url is refused as having no relay to check", async () => {
  writeConfig(webrtcConnection({ stun: ["stun:stun.example.org:3478"] }));
  const requests: Array<RTCIceServer> = [];
  const lines: Array<string> = [];

  const checked = checkRelay({
    configFile,
    keyFile,
    writeStatementLine: (line) => lines.push(line),
    gather: scriptedGathering({}, requests),
  });

  await expect(checked).rejects.toThrow(RELAY_CHECK_NO_TURN_URL);
  expect(lines).toEqual([]);
  expect(requests).toEqual([]);
});

test("doctor relay on a configuration it refuses exits 64 and prints no verdict", async () => {
  writeConfig({ channel: "filedrop", path: path.join(dir, "drop") });
  const { stdoutWrites, stderrWrites, restore } = captureStdio();
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      stdoutWrites.push(args.map((a) => String(a)).join(" "));
    });
  const exitSpy = captureProcessExit();
  try {
    await runToExit(() =>
      relayHandler(
        argv({ "config-file": configFile, "key-file": keyFile, json: true }),
      ),
    );
    expect(exitSpy).toHaveBeenCalledWith(64);
  } finally {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    restore();
  }
  expect(stdoutWrites.join("")).toBe("");
  expect(stderrWrites.join("")).toContain("WebRTC exchange only");
  expect(weriftPeers.constructed).toBe(0);
});

// --- the transport each url names ----------------------------------------------

test.each([
  ["turn:relay.example.org:3478", "udp"],
  ["turn:relay.example.org:3478?transport=udp", "udp"],
  ["turn:relay.example.org:3478?transport=tcp", "tcp"],
  ["turns:relay.example.org:443", "tls"],
  ["turns:relay.example.org:443?transport=tcp", "tls"],
] as const)("%s names %s", (url, transport) => {
  expect(turnUrlTransport(url)).toBe(transport);
});
