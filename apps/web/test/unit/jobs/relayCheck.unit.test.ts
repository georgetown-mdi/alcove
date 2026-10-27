import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { stringify as stringifyYaml } from "yaml";

import {
  DISPLAY_TRUNCATION_MARKER,
  INVITATION_RELAY_ENROLLMENT_WAIT_MS,
  RELAY_CHECK_BOUND_MS,
  relayHostStatementLines,
  snakeizeKeys,
} from "@alcove/core";

import {
  ConsoleShuttingDownError,
  JobManager,
  RelayCheckBusyError,
} from "@jobs/jobManager";
import {
  RELAY_CHECK_CHILD_BUDGET_MS,
  RELAY_CHECK_SIGTERM_MS,
  RELAY_CHECK_TEXT_MAX_DISPLAY_LENGTH,
  parseRelayVerdict,
  reconcileRelayCheckExit,
  relayCheckOffer,
  runRelayCheck,
} from "@jobs/relayCheck";

import {
  STUB_CLI_PATH,
  VALID_SHARED_SECRET,
  trackScratchDirs,
  validIntent,
  validLinkageTerms,
} from "../../utils/jobFixtures";
import { waitFor } from "../../utils/waitFor";

import type { RelayCheckOffer, RelayCheckResult } from "@jobs/relayCheck";

/** The repository root, from this file's place at apps/web/test/unit/jobs/. */
const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));

interface PrintedOutput {
  statement: Array<string>;
  lines: Array<string>;
  json: string;
}

// What the CLI prints for the configurations below, recorded by its own test
// (apps/cli/test/unit/doctor/doctorRelayOutput.test.ts). apps/web does not
// import apps/cli, so the record is read as a file.
const CLI_PRINTED = JSON.parse(
  fs.readFileSync(
    path.join(REPO_ROOT, "apps/cli/test/unit/doctor/doctorRelayOutput.json"),
    "utf8",
  ),
) as Partial<Record<string, PrintedOutput>>;

const OWN_TURN = "turn:own-relay.example.org:3478?transport=tcp";
const STATIC_TURN = "turn:static-relay.example.org:3478";
const INVITATION_TURN = "turns:relay.example.org:443?transport=tcp";
const SECOND_INVITATION_TURN = "turn:relay-2.example.org:3478";
const REGISTRAR = "https://registrar.example.org";
const OWN_WEBSOCKET = "wss://own-relay.example.org/relay";

const INVITATION_FIRST = {
  invitationRelay: {
    turn: [INVITATION_TURN, SECOND_INVITATION_TURN],
    registrar: REGISTRAR,
  },
};
const OWN_FIRST = {
  turn: [
    { url: OWN_TURN },
    {
      url: STATIC_TURN,
      username: "static-user",
      credential: "placeholder-not-a-secret",
    },
  ],
  invitationRelay: { turn: [INVITATION_TURN], registrar: REGISTRAR },
};

const { scratchDir, cleanup: removeScratchDirs } = trackScratchDirs();
const managers: Array<JobManager> = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
  removeScratchDirs();
});

function writeConfig(root: string, connection: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(root, "alcove.yaml"),
    stringifyYaml(
      snakeizeKeys({ connection, linkageTerms: validLinkageTerms() }),
    ),
  );
}

/** A working folder holding a webrtc configuration and the key beside it. */
function workingFolder(extra: Record<string, unknown> = INVITATION_FIRST) {
  const root = scratchDir("relay-check");
  writeConfig(root, {
    channel: "webrtc",
    server: { host: "peers.example.org" },
    role: "inviter",
    ...extra,
  });
  fs.writeFileSync(
    path.join(root, ".alcove.key"),
    JSON.stringify({ sharedSecret: VALID_SHARED_SECRET }),
    { mode: 0o600 },
  );
  return root;
}

function managerFor(
  root: string,
  stub: NodeJS.ProcessEnv = {},
  options: { cancelSigkillGraceMs?: number } = {},
): JobManager {
  const manager = new JobManager({
    dataRoot: root,
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: scratchDir("rvz"),
    childEnv: stub,
    ...options,
  });
  managers.push(manager);
  return manager;
}

function available(
  offer: RelayCheckOffer,
): Extract<RelayCheckOffer, { kind: "available" }> {
  if (offer.kind !== "available") throw new Error(`offer is ${offer.kind}`);
  return offer;
}

function verdictOf(
  result: RelayCheckResult,
): Extract<RelayCheckResult, { kind: "verdict" }> {
  if (result.kind !== "verdict") throw new Error(`result is ${result.kind}`);
  return result;
}

/** The CLI's printed check lines, label and all, that start a check. */
function cliHeadlines(name: string): Array<string> {
  const printed = CLI_PRINTED[name];
  if (printed === undefined) throw new Error(`no recorded output ${name}`);
  return printed.lines.filter((line) => /^(OK|WARN|FAIL|SKIP): /.test(line));
}

function withoutLabel(line: string): string {
  return line.replace(/^(OK|WARN|FAIL|SKIP): /, "");
}

describe("the hosts stated before a check", () => {
  test.each([
    ["enrolledAndReached", INVITATION_FIRST],
    ["ownFirstNotReached", OWN_FIRST],
    ["websocketOnlyAdmitted", { websocketRelay: OWN_WEBSOCKET }],
    [
      "turnReachedWebSocketNotAdmitted",
      { turn: [{ url: OWN_TURN }], websocketRelay: OWN_WEBSOCKET },
    ],
  ] as const)(
    "for the configuration of %s are the CLI's own statement",
    (name, connection) => {
      const offer = available(relayCheckOffer(workingFolder(connection)));

      expect(relayHostStatementLines(offer.statement)).toEqual(
        CLI_PRINTED[name]?.statement,
      );
      expect(offer).not.toHaveProperty("websocketRelayNotChecked");
    },
  );

  test("are read without spawning anything", () => {
    const root = workingFolder();
    const argvFile = path.join(scratchDir("argv"), "argv.json");
    const manager = managerFor(root, { STUB_ARGV_FILE: argvFile });

    expect(manager.relayCheckOffer().kind).toBe("available");
    expect(fs.existsSync(argvFile)).toBe(false);
  });

  test("offer the check where a run lists a WebSocket relay and every TURN url is left out", () => {
    const offer = available(
      relayCheckOffer(
        workingFolder({
          turn: [{ url: OWN_TURN }],
          websocketRelay: OWN_WEBSOCKET,
          allowedRelays: ["own-relay.example.org:443"],
        }),
      ),
    );
    expect(offer.statement.contacted.map((entry) => entry.host)).toEqual([
      OWN_WEBSOCKET,
    ]);
  });

  test.each([
    ["no-relay", {}],
    [
      "relays-left-out",
      {
        turn: [{ url: OWN_TURN }],
        allowedRelays: ["elsewhere.example.org:3478"],
      },
    ],
    [
      "relays-left-out",
      {
        websocketRelay: OWN_WEBSOCKET,
        allowedRelays: ["elsewhere.example.org"],
      },
    ],
  ] as const)("offer no check where %s", (reason, connection) => {
    expect(relayCheckOffer(workingFolder(connection))).toEqual({
      kind: "unavailable",
      reason,
    });
  });

  test("offer no check over a folder with no configuration, another channel, or no key file", () => {
    expect(relayCheckOffer(scratchDir("empty"))).toEqual({
      kind: "unavailable",
      reason: "no-configuration",
    });

    const filedrop = scratchDir("filedrop");
    writeConfig(filedrop, { channel: "filedrop", path: "/srv/exchange" });
    expect(relayCheckOffer(filedrop)).toEqual({
      kind: "unavailable",
      reason: "not-webrtc",
    });

    const keyless = workingFolder();
    fs.rmSync(path.join(keyless, ".alcove.key"));
    expect(relayCheckOffer(keyless)).toEqual({
      kind: "unavailable",
      reason: "key-file",
    });

    const unreadable = scratchDir("unreadable");
    fs.writeFileSync(path.join(unreadable, "alcove.yaml"), "connection: [");
    expect(relayCheckOffer(unreadable)).toEqual({
      kind: "unavailable",
      reason: "configuration-refused",
    });
  });
});

describe("a started check", () => {
  test("spawns doctor relay over the working folder's two files", async () => {
    const root = workingFolder();
    const argvFile = path.join(scratchDir("argv"), "argv.json");
    const manager = managerFor(root, {
      STUB_ARGV_FILE: argvFile,
      STUB_DOCTOR_STDOUT: CLI_PRINTED.enrolledAndReached?.json,
    });
    const { configurationDigest } = available(manager.relayCheckOffer());

    const result = await manager.checkRelay({ configurationDigest });

    expect(result.kind).toBe("verdict");
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8")) as Array<string>;
    expect(argv.slice(2)).toEqual([
      "doctor",
      "relay",
      "--json",
      `--config-file=${path.join(root, "alcove.yaml")}`,
      `--key-file=${path.join(root, ".alcove.key")}`,
    ]);
  });

  test("over a configuration changed since its hosts were shown spawns nothing", async () => {
    const root = workingFolder();
    const argvFile = path.join(scratchDir("argv"), "argv.json");
    const manager = managerFor(root, { STUB_ARGV_FILE: argvFile });
    const { configurationDigest } = available(manager.relayCheckOffer());
    writeConfig(root, {
      channel: "webrtc",
      server: { host: "peers.example.org" },
      role: "inviter",
      turn: [{ url: OWN_TURN }],
    });

    expect(await manager.checkRelay({ configurationDigest })).toEqual({
      kind: "configuration-changed",
    });
    expect(fs.existsSync(argvFile)).toBe(false);
  });

  test("over a folder become unavailable spawns nothing and says why", async () => {
    const root = workingFolder({
      turn: [{ url: OWN_TURN }],
      websocketRelay: OWN_WEBSOCKET,
    });
    const argvFile = path.join(scratchDir("argv"), "argv.json");
    const manager = managerFor(root, { STUB_ARGV_FILE: argvFile });
    const { configurationDigest } = available(manager.relayCheckOffer());
    fs.rmSync(path.join(root, ".alcove.key"));

    expect(await manager.checkRelay({ configurationDigest })).toEqual({
      kind: "unavailable",
      reason: "key-file",
    });
    expect(fs.existsSync(argvFile)).toBe(false);
  });

  test("is refused while another runs", async () => {
    const root = workingFolder();
    const manager = managerFor(root, { STUB_DELAY_MS: "400" });
    const { configurationDigest } = available(manager.relayCheckOffer());

    const first = manager.checkRelay({ configurationDigest });
    await expect(manager.checkRelay({ configurationDigest })).rejects.toThrow(
      RelayCheckBusyError,
    );
    expect((await first).kind).toBe("verdict");
    expect((await manager.checkRelay({ configurationDigest })).kind).toBe(
      "verdict",
    );
  });

  test("is refused while an exchange's child is running", async () => {
    const root = workingFolder();
    const argvFile = path.join(scratchDir("argv"), "argv.json");
    const manager = managerFor(root, {
      STUB_DELAY_MS: "5000",
      STUB_FD3_EVENTS: "[]",
    });
    const { configurationDigest } = available(manager.relayCheckOffer());
    await manager.createJob(validIntent());

    expect(await manager.checkRelay({ configurationDigest })).toEqual({
      kind: "exchange-running",
    });
    expect(fs.existsSync(argvFile)).toBe(false);
  });

  test("that outlives the watchdog is a timeout", async () => {
    const result = await runRelayCheck({
      dataRoot: workingFolder(),
      binaryPath: STUB_CLI_PATH,
      childEnv: { STUB_DELAY_MS: "10000", STUB_IGNORE_SIGTERM: "1" },
      sigtermMs: 100,
      sigkillGraceMs: 100,
    });
    expect(result).toEqual({ kind: "timeout" });
  });

  test("the watchdog sits above the check's own bound and its enrollment's wait", () => {
    expect(RELAY_CHECK_CHILD_BUDGET_MS).toBe(
      RELAY_CHECK_BOUND_MS + INVITATION_RELAY_ENROLLMENT_WAIT_MS,
    );
    expect(RELAY_CHECK_SIGTERM_MS).toBeGreaterThan(
      RELAY_CHECK_CHILD_BUDGET_MS + 5_000,
    );
  });
});

/** Whether a process with this pid still runs (a reaped child does not). */
function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Start a check whose stub child waits, and the child's pid once it runs. */
async function runningCheck(
  stub: NodeJS.ProcessEnv,
  options: { cancelSigkillGraceMs?: number } = {},
): Promise<{
  manager: JobManager;
  check: Promise<unknown>;
  pid: number;
}> {
  const pidFile = path.join(scratchDir("pid"), "pid");
  const manager = managerFor(
    workingFolder(),
    { STUB_DELAY_MS: "30000", STUB_PID_FILE: pidFile, ...stub },
    options,
  );
  const { configurationDigest } = available(manager.relayCheckOffer());
  const check = manager.checkRelay({ configurationDigest });
  await waitFor(
    () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8") !== "",
  );
  return { manager, check, pid: Number(fs.readFileSync(pidFile, "utf8")) };
}

describe("server shutdown and a check", () => {
  test("stops a running check's child before it resolves", async () => {
    const { manager, check, pid } = await runningCheck({});

    await manager.shutdown();

    expect(processRuns(pid)).toBe(false);
    await expect(check).resolves.toBeDefined();
  });

  test("SIGKILLs a check child still running after the grace", async () => {
    const { manager, check, pid } = await runningCheck(
      { STUB_IGNORE_SIGTERM: "1" },
      { cancelSigkillGraceMs: 200 },
    );
    const started = Date.now();

    await manager.shutdown();

    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(processRuns(pid)).toBe(false);
    await expect(check).resolves.toBeDefined();
  });

  test("resolves at once when no check is running", async () => {
    const manager = managerFor(workingFolder());
    const { configurationDigest } = available(manager.relayCheckOffer());
    expect((await manager.checkRelay({ configurationDigest })).kind).toBe(
      "verdict",
    );

    await expect(manager.shutdown()).resolves.toBeUndefined();
    await expect(manager.checkRelay({ configurationDigest })).rejects.toThrow(
      ConsoleShuttingDownError,
    );
  });
});

describe("each outcome", () => {
  test.each([
    ["enrolledAndReached", 0, "ok"],
    ["ownFirstNotReached", 78, "fix_and_retry"],
    ["staticFirstReached", 0, "ok"],
    ["noRegistrarNotReached", 78, "fix_and_retry"],
    ["websocketOnlyAdmitted", 0, "ok"],
    ["turnReachedWebSocketNotAdmitted", 78, "fix_and_retry"],
    ["invitationWebSocketNotReached", 78, "fix_and_retry"],
    ["websocketCertificateNotVerified", 78, "fix_and_retry"],
  ] as const)(
    "%s states each check in the CLI's words",
    (name, code, overall) => {
      const result = verdictOf(
        reconcileRelayCheckExit(code, CLI_PRINTED[name]?.json),
      );

      expect(result.overall).toBe(overall);
      expect(result.checks.map((check) => check.headline)).toEqual(
        cliHeadlines(name).map(withoutLabel),
      );
    },
  );

  test("a later url is skipped, with the CLI's meaning and action", () => {
    const result = verdictOf(
      reconcileRelayCheckExit(0, CLI_PRINTED.enrolledAndReached?.json),
    );
    const later = result.checks.find((check) => check.id === "turn_2");
    expect(later?.status).toBe("skipped");
    expect(later?.meaning).toMatch(/^a run of this configuration does not/);
    expect(later?.action).toMatch(/^If this relay should be the one/);
  });

  test.each([
    ["turnReachedWebSocketNotAdmitted", /^Enroll this exchange's relay key/],
    ["invitationWebSocketNotReached", /^Check that this host can reach/],
    ["websocketCertificateNotVerified", /NODE_EXTRA_CA_CERTS/],
  ] as const)(
    "the WebSocket relay's line of %s crosses with the CLI's meaning and action",
    (name, action) => {
      const result = verdictOf(
        reconcileRelayCheckExit(78, CLI_PRINTED[name]?.json),
      );
      const websocket = result.checks.find(
        (check) => check.id === "websocket_1",
      );
      expect(websocket?.status).toBe("fail");
      expect(websocket?.meaning).toMatch(/^(the relay|nothing on this host)/);
      expect(websocket?.action).toMatch(action);
    },
  );

  test("a refused enrollment is a warning without the registrar's answer", () => {
    const result = verdictOf(
      reconcileRelayCheckExit(
        78,
        CLI_PRINTED.refusedEnrollmentNotReached?.json,
      ),
    );
    const [enrollment, relay] = result.checks;
    const [cliEnrollment, cliRelay] = cliHeadlines(
      "refusedEnrollmentNotReached",
    );

    expect(enrollment.status).toBe("warn");
    expect(enrollment.headline).toBe(
      withoutLabel(cliEnrollment).replace(" (HTTP 409: no)", ""),
    );
    expect(enrollment.headline).not.toContain("HTTP 409");
    expect(relay.status).toBe("fail");
    expect(relay.headline).toBe(withoutLabel(cliRelay));
  });

  test("exit 64 is the CLI's refusal, whatever it printed", () => {
    expect(reconcileRelayCheckExit(64, "")).toEqual({ kind: "refused" });
    expect(reconcileRelayCheckExit(64, undefined)).toEqual({
      kind: "refused",
    });
  });

  test.each([
    ["an exit with no verdict", 70, ""],
    ["an uncaught error", 1, ""],
    ["a signal", null, ""],
    ["exit 0 with nothing printed", 0, ""],
    ["an overflowed read", 0, undefined],
    ["a verdict whose overall is not its exit's", 78, "enrolledAndReached"],
  ] as const)("%s is an error", (_label, code, stdout) => {
    const line =
      stdout === undefined || stdout === ""
        ? stdout
        : CLI_PRINTED[stdout]?.json;
    expect(reconcileRelayCheckExit(code, line)).toEqual({ kind: "error" });
  });
});

describe("the verdict is held to closed sets at the boundary", () => {
  const turn = { id: "turn_1", status: "ok", url: OWN_TURN, transport: "tcp" };
  const websocket = {
    id: "websocket_1",
    status: "ok",
    url: OWN_WEBSOCKET,
    outcome: "admitted",
  };
  const verdictLine = (
    checks: Array<Record<string, unknown>>,
    overall = "ok",
  ): string => JSON.stringify({ version: 1, mode: "relay", overall, checks });

  test.each([
    ["an unknown check id", [{ ...turn, id: "stun_1" }]],
    ["an unknown status", [{ ...turn, status: "maybe" }]],
    ["an unknown transport", [{ ...turn, transport: "quic" }]],
    ["a url that is not text", [{ ...turn, url: 7 }]],
    [
      "a lapse that is not a UTC timestamp",
      [
        {
          id: "enrollment",
          status: "ok",
          registrar: REGISTRAR,
          lapses_at: "tomorrow",
        },
        turn,
      ],
    ],
    ["fields no check of doctor relay has", [{ ...turn, status: "warn" }]],
    ["an unknown outcome", [{ ...websocket, outcome: "maybe" }]],
    [
      "a close code that is not a whole number",
      [
        {
          ...websocket,
          status: "fail",
          outcome: "not_admitted",
          close_code: "4003",
        },
      ],
    ],
    [
      "a close code the relay does not refuse a proof with",
      [
        {
          ...websocket,
          status: "fail",
          outcome: "not_admitted",
          close_code: 4006,
        },
      ],
    ],
    [
      "a WebSocket relay check with a transport",
      [{ ...websocket, transport: "tls" }],
    ],
    ["a TURN check with an outcome", [{ ...turn, outcome: "admitted" }]],
    ["no checks", []],
  ])("%s is an error", (_label, checks) => {
    expect(parseRelayVerdict(verdictLine(checks), "ok")).toEqual({
      kind: "error",
    });
  });

  test("a member the verdict's closed fields do not name never crosses to the browser", () => {
    const result = verdictOf(
      parseRelayVerdict(
        verdictLine([
          { ...websocket, relayKey: "a".repeat(64), proof: "secret" },
        ]),
        "ok",
      ),
    );
    expect(result.checks).toEqual([
      {
        id: "websocket_1",
        status: "ok",
        headline:
          `${OWN_WEBSOCKET}, a WebSocket relay a run dials: admitted; the ` +
          "relay accepted this exchange's proof.",
      },
    ]);
  });

  test("a verdict of another schema version or mode is an error", () => {
    const line = JSON.parse(verdictLine([turn])) as Record<string, unknown>;
    expect(
      parseRelayVerdict(JSON.stringify({ ...line, version: 2 }), "ok"),
    ).toEqual({ kind: "error" });
    expect(
      parseRelayVerdict(JSON.stringify({ ...line, mode: "probe" }), "ok"),
    ).toEqual({ kind: "error" });
  });

  test("an overall the checks do not roll up to is an error", () => {
    expect(
      parseRelayVerdict(verdictLine([{ ...turn, status: "fail" }], "ok"), "ok"),
    ).toEqual({ kind: "error" });
  });

  test("text the partner's invitation can name is escaped and bounded", () => {
    const hostile = `turn:relay.example.org\u001b[31m\u202e${"x".repeat(4000)}`;
    const result = verdictOf(
      parseRelayVerdict(
        verdictLine([
          {
            id: "enrollment",
            status: "skipped",
            registrar: "https://registrar.example.org/\u0007\u2028",
            meaning: "not \u001b[2Jcontacted",
          },
          { ...turn, url: hostile },
        ]),
        "ok",
      ),
    );
    const [enrollment, relay] = result.checks;

    expect(enrollment.headline).toContain("\\x07\\u2028");
    expect(enrollment.meaning).toBe("not \\x1b[2Jcontacted");
    expect(relay.headline).toContain("turn:relay.example.org\\x1b[31m\\u202e");
    expect(relay.headline.endsWith(DISPLAY_TRUNCATION_MARKER)).toBe(true);
    expect(relay.headline.length).toBeLessThanOrEqual(
      RELAY_CHECK_TEXT_MAX_DISPLAY_LENGTH + DISPLAY_TRUNCATION_MARKER.length,
    );
    for (const check of result.checks)
      for (const text of [check.headline, check.meaning ?? ""])
        expect(text).toMatch(/^[\x20-\x7e]*$/);
  });
});
