import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import YAML from "yaml";

import type { RTCIceServer } from "werift";

import { checkRelay } from "../../../src/commands/doctor";
import type { RelayCandidateGathering } from "../../../src/doctor/relay";
import { verdictJson, verdictLines } from "../../../src/doctor/verdict";
import { saveKeyFile } from "../../../src/keyFile";
import { snapshotDiagnosticSinkAndLevel } from "../../loggingTestSupport";
import {
  fakeRegistrar,
  jsonResponse,
  registrationAnswer,
} from "../relayRegistrarFake";

// What `alcove doctor relay` prints for each kind of verdict -- the host
// statement, the check lines and the --json line -- held to the output
// recorded in doctorRelayOutput.json, so moving where any of that wording is
// composed cannot change what the command prints.

vi.mock("werift", () => ({
  RTCPeerConnection: class {
    constructor() {
      throw new Error("no werift peer connection may be built in this file");
    }
  },
}));

snapshotDiagnosticSinkAndLevel();

interface PrintedOutput {
  statement: string[];
  lines: string[];
  json: string;
}

const RECORDED = JSON.parse(
  fs.readFileSync(new URL("./doctorRelayOutput.json", import.meta.url), "utf8"),
) as Record<string, PrintedOutput>;

const SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM";
const OWN_TURN = "turn:own-relay.example.org:3478?transport=tcp";
const STATIC_TURN = "turn:static-relay.example.org:3478";
const INVITATION_TURN = "turns:relay.example.org:443?transport=tcp";
const SECOND_INVITATION_TURN = "turn:relay-2.example.org:3478";
const REGISTRAR = "https://registrar.example.org";
const LAPSES_AT = "2026-01-01T01:10:00Z";
const STATIC_PAIR = {
  username: "static-user",
  credential: "placeholder-not-a-secret",
};

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

let dir: string;
let configFile: string;
let keyFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-doctor-output-"));
  configFile = path.join(dir, "alcove.yaml");
  keyFile = path.join(dir, ".alcove.key");
  saveKeyFile(keyFile, { sharedSecret: SECRET });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeConnection(extra: Record<string, unknown>): void {
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      connection: {
        channel: "webrtc",
        server: { host: "peers.example.org" },
        role: "inviter",
        ...extra,
      },
      linkage_terms: linkageTerms,
    }),
  );
}

function gathering(reached: ReadonlyArray<string>): RelayCandidateGathering {
  return (server: RTCIceServer) =>
    Promise.resolve(reached.includes(server.urls as string));
}

async function printed(options: {
  registrarAnswers?: Response[];
  reached: ReadonlyArray<string>;
}): Promise<PrintedOutput> {
  const statement: string[] = [];
  const report = await checkRelay({
    configFile,
    keyFile,
    writeStatementLine: (line) => statement.push(line),
    fetch: fakeRegistrar(options.registrarAnswers ?? []).fetch,
    gather: gathering(options.reached),
    now: new Date("2026-01-01T00:00:00Z"),
  });
  return { statement, lines: verdictLines(report), json: verdictJson(report) };
}

const INVITATION_FIRST = {
  invitation_relay: {
    turn: [INVITATION_TURN, SECOND_INVITATION_TURN],
    registrar: REGISTRAR,
  },
};

test.each([
  [
    "enrolledAndReached",
    INVITATION_FIRST,
    [registrationAnswer(null, LAPSES_AT)],
    [INVITATION_TURN],
  ],
  [
    "refusedEnrollmentNotReached",
    INVITATION_FIRST,
    [jsonResponse(409, { error: "no" })],
    [],
  ],
  [
    "enrolledWithoutLapseNotReached",
    INVITATION_FIRST,
    [registrationAnswer()],
    [],
  ],
  [
    "ownFirstNotReached",
    {
      turn: [{ url: OWN_TURN }, { url: STATIC_TURN, ...STATIC_PAIR }],
      invitation_relay: { turn: [INVITATION_TURN], registrar: REGISTRAR },
    },
    [],
    [],
  ],
  [
    "staticFirstReached",
    {
      turn: [{ url: INVITATION_TURN, ...STATIC_PAIR }],
      invitation_relay: { turn: [INVITATION_TURN], registrar: REGISTRAR },
    },
    [],
    [INVITATION_TURN],
  ],
  [
    "invitationRelayLeftOut",
    {
      turn: [{ url: OWN_TURN }],
      invitation_relay: { turn: [INVITATION_TURN], registrar: REGISTRAR },
      allowed_relays: ["own-relay.example.org:3478"],
    },
    [],
    [OWN_TURN],
  ],
  [
    "noRegistrarNotReached",
    { invitation_relay: { turn: [INVITATION_TURN] } },
    [],
    [],
  ],
  ["ownOnlyReached", { turn: [{ url: OWN_TURN }] }, [], [OWN_TURN]],
] as const)(
  "doctor relay prints the recorded output for %s",
  async (name, connection, registrarAnswers, reached) => {
    writeConnection(connection);

    const output = await printed({
      registrarAnswers: [...registrarAnswers],
      reached,
    });

    expect(output).toEqual(RECORDED[name]);
  },
);
