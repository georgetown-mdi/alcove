import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import YAML from "yaml";
import { UsageError } from "@alcove/core";

import type { RTCIceServer } from "werift";

import {
  checkRelay,
  mountHandler,
  relayHandler,
} from "../../../src/commands/doctor";
import {
  NO_RELAY_CANDIDATE_GATHERED,
  RELAY_NOT_REACHED_REMEDY,
} from "../../../src/connection/webrtc/iceDiagnostics";
import { runProbe } from "../../../src/doctor/probe";
import type { ProbeDeps } from "../../../src/doctor/probe";
import {
  RELAY_CHECK_NO_TURN_URL,
  RELAY_CHECK_WEBRTC_ONLY,
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
import { saveKeyFile } from "../../../src/keyFile";
import { captureProcessExit, runToExit } from "../../exitCapture";
import { argv, captureStdio } from "../../loggingTestSupport";

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

const SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM";
const OWN_TURN = "turn:own-relay.example.org:3478?transport=tcp";
const STATIC_TURN = "turn:static-relay.example.org:3478";
const INVITATION_TURN = "turns:relay.example.org:443?transport=tcp";
const REGISTRAR = "https://registrar.example.org";

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

/** A configuration listing an own minted entry, an own static one, and the invitation's relay. */
function writeThreeRelayConfig(): void {
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

// --- the host statement --------------------------------------------------------

test("doctor relay names every relay it contacts before its first request", async () => {
  writeThreeRelayConfig();
  const events: Array<string> = [];
  const requests: Array<RTCIceServer> = [];
  const gather = scriptedGathering(
    { [OWN_TURN]: true, [STATIC_TURN]: true, [INVITATION_TURN]: true },
    requests,
  );

  await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: (line) => events.push(`line ${line}`),
    gather: (server, signal) => {
      events.push(`request ${server.urls as string}`);
      return gather(server, signal);
    },
  });

  const firstRequest = events.findIndex((event) =>
    event.startsWith("request "),
  );
  const statement = events.slice(0, firstRequest).join("\n");
  expect(firstRequest).toBeGreaterThan(0);
  for (const url of [OWN_TURN, STATIC_TURN, INVITATION_TURN])
    expect(statement).toContain(url);
  expect(statement).toContain(
    `${INVITATION_TURN} over TLS, from your partner's invitation`,
  );
  expect(statement).toContain(`${OWN_TURN} over TCP, from connection.turn`);
  expect(statement).toContain(`${STATIC_TURN} over UDP, from connection.turn`);
  expect(statement).toContain("contacts no relay registrar");
  expect(statement).not.toContain(REGISTRAR);
  expect(
    events.slice(firstRequest).every((e) => e.startsWith("request ")),
  ).toBe(true);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("doctor relay asks each url alone, in the run's order, with what the run presents there", async () => {
  writeThreeRelayConfig();
  const requests: Array<RTCIceServer> = [];

  await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: () => undefined,
    gather: scriptedGathering({}, requests),
    now: new Date("2026-01-01T00:00:00Z"),
  });

  expect(requests.map((server) => server.urls)).toEqual([
    OWN_TURN,
    STATIC_TURN,
    INVITATION_TURN,
  ]);
  const [own, fixed, invitation] = requests;
  expect(fixed).toMatchObject({
    username: "static-user",
    credential: "placeholder-not-a-secret",
  });
  expect(own?.username).toMatch(/^\d+:alcove$/);
  expect(invitation?.username).toBe(own?.username);
  expect(invitation?.credential).toBe(own?.credential);
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
    `OK: ${INVITATION_TURN} over TLS: reached; the relay gave a relay address.`,
  );
  expect(DOCTOR_EXIT_CODE[overallOf(report)]).toBe(0);
});

test("a relay that gives none is reported not reached, with the run's remedy", async () => {
  writeThreeRelayConfig();

  const report = await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: () => undefined,
    gather: scriptedGathering(
      { [OWN_TURN]: true, [STATIC_TURN]: false, [INVITATION_TURN]: false },
      [],
    ),
  });

  expect(overallOf(report)).toBe("fix_and_retry");
  expect(DOCTOR_EXIT_CODE[overallOf(report)]).toBe(78);
  const fixed = checkFor(report, STATIC_TURN);
  expect(fixed).toMatchObject({
    id: "turn_2",
    status: "fail",
    transport: "udp",
    action: RELAY_NOT_REACHED_REMEDY,
  });
  expect(fixed.summary).toBe(
    `${STATIC_TURN} over UDP: ${NO_RELAY_CANDIDATE_GATHERED} within 30 s.`,
  );
  expect(fixed.meaning).toContain("the check cannot tell which");
  expect(fixed.meaning).not.toContain("enrolled");
  expect(checkFor(report, INVITATION_TURN).meaning).toContain(
    "until a run has enrolled the exchange's relay key there",
  );
  const lines = verdictLines(report).join("\n");
  expect(lines).toContain(`FAIL: ${STATIC_TURN} over UDP`);
  expect(lines).toContain("ACTION:  Fix the relay, or arrange a direct path;");
  expect(checkFor(report, OWN_TURN).status).toBe("ok");
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
    summary: `${OWN_TURN} over TCP: ${NO_RELAY_CANDIDATE_GATHERED} within 0 s.`,
  });
  expect(checkFor(report, OWN_TURN).meaning).toContain("alcove enroll-relay");
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
