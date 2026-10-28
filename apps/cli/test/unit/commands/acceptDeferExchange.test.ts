import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import YAML from "yaml";
import {
  disclosedColumnNames,
  encodeInvitation,
  getLogger,
  parseExchangeSpec,
  UsageError,
} from "@alcove/core";
import type { ConnectionEndpoint, InvitationToken } from "@alcove/core";

vi.mock("../../../src/util/prompt", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/util/prompt")
  >("../../../src/util/prompt");
  return { ...actual, promptConfirmOrClosed: vi.fn(), promptFreeText: vi.fn() };
});

// Every client a run reaches the network through, so the deferred acceptance
// is shown to construct and call none of them: the bootstrap that runs the
// exchange, the coordination-server socket, the invitation relay's registrar
// enrollment, and the WebSocket relay dial.
vi.mock("../../../src/onlineBootstrap", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/onlineBootstrap")
  >("../../../src/onlineBootstrap");
  return { ...actual, runOnlineBootstrap: vi.fn() };
});
vi.mock("../../../src/connection/webrtc/brokerClient", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/connection/webrtc/brokerClient")
  >("../../../src/connection/webrtc/brokerClient");
  return { ...actual, connectToBroker: vi.fn() };
});
vi.mock("../../../src/invitationRelayEnrollment", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/invitationRelayEnrollment")
  >("../../../src/invitationRelayEnrollment");
  return { ...actual, enrollAtInvitationRelay: vi.fn() };
});
vi.mock("../../../src/connection/webrtc/websocketRelayDial", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/connection/webrtc/websocketRelayDial")
  >("../../../src/connection/webrtc/websocketRelayDial");
  return { ...actual, webSocketRelayDialsFor: vi.fn() };
});

import {
  DEFER_EXCHANGE_NO_EFFECT,
  DEFER_EXCHANGE_WITH_URL,
  handler as acceptHandler,
  validateAccept,
} from "../../../src/commands/accept";
import { connectToBroker } from "../../../src/connection/webrtc/brokerClient";
import { webSocketRelayDialsFor } from "../../../src/connection/webrtc/websocketRelayDial";
import { enrollAtInvitationRelay } from "../../../src/invitationRelayEnrollment";
import { runOnlineBootstrap } from "../../../src/onlineBootstrap";
import type { CommonBootstrapOptions } from "../../../src/optionDefinitions";
import { exitCodeForError } from "../../../src/util/exit";
import { promptConfirmOrClosed } from "../../../src/util/prompt";
import { captureProcessExit } from "../../exitCapture";
import {
  FUTURE,
  LINKAGE_COLUMNS,
  OUTBOUND_SEND_LABEL,
  sampleToken,
} from "../../invitationDisplayTestSupport";
import { captureStdio } from "../../loggingTestSupport";

const promptConfirmMock = vi.mocked(promptConfirmOrClosed);
const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);

const WEBRTC_ENDPOINT: ConnectionEndpoint = {
  channel: "webrtc",
  host: "peer.example.org",
  path: "/psi",
};

/** The column the inviting party requests, which inference leaves out. */
const REQUESTED = "case_manager";

/**
 * The acceptor's header: the linkage columns, an `id` inference sends as the
 * record identifier, the requested column, and a column inference leaves out
 * that nobody requests.
 */
const INPUT_COLUMNS = ["id", ...LINKAGE_COLUMNS, REQUESTED, "notes"];

let dir: string;
let counter = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(tmpdir(), "alcove-accept-defer-"));
});

afterEach(() => {
  promptConfirmMock.mockReset();
  runOnlineBootstrapMock.mockReset();
  vi.mocked(connectToBroker).mockReset();
  vi.mocked(enrollAtInvitationRelay).mockReset();
  vi.mocked(webSocketRelayDialsFor).mockReset();
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeInput(columns: string[] = INPUT_COLUMNS): string {
  const file = path.join(dir, `input-${counter++}.csv`);
  fs.writeFileSync(
    file,
    `${columns.join(",")}\n` +
      columns
        .map((column) => (column === "dob" ? "1990-01-02" : "x"))
        .join(",") +
      "\n",
  );
  return file;
}

function testOptions(): CommonBootstrapOptions {
  const id = counter++;
  return {
    configFile: path.join(dir, `alcove-${id}.yaml`),
    keyFile: path.join(dir, `alcove-${id}.key`),
    identity: "Agency B",
    record: false,
    eventStream: false,
    logLevel: 5,
    verbosity: 0,
  };
}

/** A webrtc invitation whose inviting party requests `receive`. */
function requestingToken(
  receive: string[] = [REQUESTED],
  endpoint: ConnectionEndpoint = WEBRTC_ENDPOINT,
): InvitationToken {
  const base = sampleToken(FUTURE(), endpoint);
  return {
    ...base,
    linkageTerms: {
      ...base.linkageTerms,
      payload: { receive: receive.map((name) => ({ name })) },
    },
  };
}

function recordingLog(warnings: string[]): ReturnType<typeof getLogger> {
  const log = getLogger(`accept-defer-${counter++}`);
  log.setLevel("silent");
  vi.spyOn(log, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  return log;
}

async function accept(params: {
  token: InvitationToken;
  input?: string;
  deferExchange?: boolean;
  warnings?: string[];
}): Promise<Awaited<ReturnType<typeof validateAccept>>> {
  return validateAccept({
    resolved: {
      mode: "offline",
      invitation: await encodeInvitation(params.token),
      input: params.input,
    },
    options: testOptions(),
    log: recordingLog(params.warnings ?? []),
    deferExchange: params.deferExchange,
  });
}

describe("validateAccept: --defer-exchange", () => {
  test("writes the blocks inference gives the same file, with the requested column sent", async () => {
    const input = writeInput();
    const token = requestingToken();
    const run = await accept({ token, input });
    const deferred = await accept({ token, input, deferExchange: true });

    // The default acceptance still runs the exchange, and its inferred
    // metadata sends nothing the inviting party requested.
    expect(run.mode).toBe("endpointRun");
    if (run.mode !== "endpointRun") return;
    expect(run.dataSpec.metadata?.map((c) => c.name)).not.toContain(REQUESTED);

    expect(deferred.mode).toBe("offline");
    if (deferred.mode !== "offline") return;
    // The standardization is exactly inference's, and the metadata is
    // inference's with one entry added: the requested column, sent.
    expect(deferred.dataSpec.standardization).toEqual(
      run.dataSpec.standardization,
    );
    expect(
      deferred.dataSpec.metadata?.filter((c) => c.name !== REQUESTED),
    ).toEqual(run.dataSpec.metadata);
    expect(
      deferred.dataSpec.metadata?.find((c) => c.name === REQUESTED),
    ).toEqual({
      name: REQUESTED,
      type: "other",
      role: "payload",
      isPayload: true,
    });
    expect(disclosedColumnNames(deferred.dataSpec.metadata ?? [])).toEqual([
      "id",
      REQUESTED,
    ]);
    // It writes the webrtc block the run would have dialed, and applies none
    // of the run's overrides to it.
    expect(deferred.connection).toMatchObject({
      channel: "webrtc",
      role: "acceptor",
      server: { host: "peer.example.org", path: "/psi" },
    });
  });

  test("sends a requested column inference already declares, keeping its role", async () => {
    const input = writeInput();
    const ready = await accept({
      token: requestingToken(["ssn"]),
      input,
      deferExchange: true,
    });
    expect(ready.mode).toBe("offline");
    if (ready.mode !== "offline") return;
    expect(ready.dataSpec.metadata?.find((c) => c.name === "ssn")).toEqual({
      name: "ssn",
      type: "ssn",
      role: "linkage",
      isPayload: true,
    });
    expect(ready.dataSpec.metadata?.map((c) => c.name)).not.toContain(
      REQUESTED,
    );
  });

  test("refuses a requested column the input file lacks, before anything is written", async () => {
    const input = writeInput(["id", ...LINKAGE_COLUMNS]);
    const options = testOptions();
    const one = await validateAccept({
      resolved: {
        mode: "offline",
        invitation: await encodeInvitation(requestingToken()),
        input,
      },
      options,
      log: recordingLog([]),
      deferExchange: true,
    }).catch((err: unknown) => err);
    expect(one).toBeInstanceOf(UsageError);
    expect(exitCodeForError(one)).toBe(64);
    expect((one as Error).message).toBe(
      'the invitation requests a column your input file does not have (["case_manager"]), ' +
        "and your partner's exchange refuses a run that does not send it. Add " +
        "it to your input file and accept again, or ask your partner for an " +
        "invitation that does not request it.",
    );
    expect(fs.existsSync(options.configFile)).toBe(false);
    expect(fs.existsSync(options.keyFile)).toBe(false);

    // The names are the partner's, so each stands delimited: a name holding
    // the delimiter or the list separator stays one name.
    const two = await accept({
      token: requestingToken(["id", 'fax", "x', REQUESTED]),
      input,
      deferExchange: true,
    }).catch((err: unknown) => err);
    expect(two).toBeInstanceOf(UsageError);
    expect((two as Error).message).toBe(
      "the invitation requests columns your input file does not have " +
        '(["fax"", ""x","case_manager"]), and your partner\'s exchange refuses a run ' +
        "that does not send them. Add them to your input file and accept " +
        "again, or ask your partner for an invitation that does not request " +
        "them.",
    );
  });

  test("leaves the default acceptance to meet a missing requested column at the exchange", async () => {
    const ready = await accept({
      token: requestingToken(),
      input: writeInput(["id", ...LINKAGE_COLUMNS]),
    });
    expect(ready.mode).toBe("endpointRun");
  });

  test("is refused beside a server URL, before the invitation is read", async () => {
    const options = testOptions();
    const refused = await validateAccept({
      resolved: {
        mode: "online",
        url: new URL("sftp://host/drop"),
        invitation: "not-an-invitation",
        input: writeInput(),
      },
      options,
      log: recordingLog([]),
      deferExchange: true,
    }).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(UsageError);
    expect((refused as Error).message).toBe(DEFER_EXCHANGE_WITH_URL);
    expect(DEFER_EXCHANGE_WITH_URL).toContain(
      "--defer-exchange cannot be used with a server URL",
    );
    expect(fs.existsSync(options.keyFile)).toBe(false);
  });

  test("is reported as having no effect where the acceptance runs no exchange anyway", async () => {
    expect(DEFER_EXCHANGE_NO_EFFECT).toContain(
      "--defer-exchange has no effect on this acceptance",
    );
    const input = writeInput();

    // No input file: the configuration is written with no metadata.
    const noInput: string[] = [];
    const written = await accept({
      token: requestingToken(),
      deferExchange: true,
      warnings: noInput,
    });
    expect(noInput).toContain(DEFER_EXCHANGE_NO_EFFECT);
    expect(written.mode).toBe("offline");
    if (written.mode !== "offline") return;
    expect(written.dataSpec.metadata).toBeUndefined();

    // An sftp endpoint: its metadata is inference's, the request unsent.
    const sftp: string[] = [];
    const sftpReady = await accept({
      token: requestingToken([REQUESTED], {
        channel: "sftp",
        host: "sftp.example.org",
        path: "/drop",
      }),
      input,
      deferExchange: true,
      warnings: sftp,
    });
    expect(sftp).toContain(DEFER_EXCHANGE_NO_EFFECT);
    expect(sftpReady.mode).toBe("offline");
    if (sftpReady.mode !== "offline") return;
    expect(sftpReady.dataSpec.metadata?.map((c) => c.name)).not.toContain(
      REQUESTED,
    );

    // Where it takes effect, or is not given, nothing is reported.
    const deferred: string[] = [];
    await accept({
      token: requestingToken(),
      input,
      deferExchange: true,
      warnings: deferred,
    });
    expect(deferred).not.toContain(DEFER_EXCHANGE_NO_EFFECT);
    const notGiven: string[] = [];
    await accept({ token: requestingToken(), warnings: notGiven });
    expect(notGiven).not.toContain(DEFER_EXCHANGE_NO_EFFECT);
  });
});

function handlerArgv(
  args: string[],
  extra: Record<string, unknown>,
): Arguments {
  const id = counter++;
  return {
    _: [],
    $0: "alcove",
    identity: "Agency B",
    args,
    "config-file": path.join(dir, `alcove-${id}.yaml`),
    "key-file": path.join(dir, `alcove-${id}.key`),
    "log-level": "info",
    record: false,
    ...extra,
  } as unknown as Arguments;
}

describe("handler: --defer-exchange", () => {
  let isTTY: PropertyDescriptor | undefined;
  beforeEach(() => {
    isTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
  });
  afterEach(() => {
    if (isTTY !== undefined)
      Object.defineProperty(process.stdin, "isTTY", isTTY);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  });

  test("writes the configuration and key file and contacts no server", async () => {
    const encoded = await encodeInvitation(requestingToken());
    const input = writeInput();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const exit = captureProcessExit();
    const stdio = captureStdio();
    const argv = handlerArgv([encoded, input], {
      "consent-to-terms": true,
      "defer-exchange": true,
    });
    try {
      await acceptHandler(argv);
    } finally {
      stdio.restore();
      exit.mockRestore();
      fetchSpy.mockRestore();
    }
    expect(exit).not.toHaveBeenCalled();
    expect(runOnlineBootstrapMock).not.toHaveBeenCalled();
    expect(connectToBroker).not.toHaveBeenCalled();
    expect(enrollAtInvitationRelay).not.toHaveBeenCalled();
    expect(webSocketRelayDialsFor).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    const configFile = argv["config-file"] as string;
    expect(fs.existsSync(argv["key-file"] as string)).toBe(true);
    const written = parseExchangeSpec(
      YAML.parse(fs.readFileSync(configFile, "utf8")),
    );
    expect(disclosedColumnNames(written.metadata ?? [])).toEqual([
      "id",
      REQUESTED,
    ]);
    expect(written.standardization).toBeDefined();
    const stderr = stdio.stderrWrites.join("");
    expect(stderr).toContain(
      "Its metadata block sets the columns you send; edit it if needed, then " +
        "run 'alcove exchange' with your input file at the agreed time.",
    );
    expect(stderr).not.toContain("to conduct the exchange");
  });

  test("leaves the default acceptance running the exchange", async () => {
    runOnlineBootstrapMock.mockResolvedValue({
      outcome: "completed",
      configWriteError: undefined,
    });
    const encoded = await encodeInvitation(requestingToken());
    const exit = captureProcessExit();
    try {
      await acceptHandler(
        handlerArgv([encoded, writeInput()], {
          "consent-to-terms": true,
          "log-level": "silent",
        }),
      );
    } finally {
      exit.mockRestore();
    }
    expect(exit).not.toHaveBeenCalled();
    expect(runOnlineBootstrapMock).toHaveBeenCalledTimes(1);
  });

  test("shows, before the question, the columns the written configuration sends", async () => {
    promptConfirmMock.mockResolvedValue("yes");
    const encoded = await encodeInvitation(requestingToken());
    const exit = captureProcessExit();
    const stdio = captureStdio();
    const argv = handlerArgv([encoded, writeInput()], {
      "defer-exchange": true,
    });
    try {
      await acceptHandler(argv);
    } finally {
      stdio.restore();
      exit.mockRestore();
    }
    expect(exit).not.toHaveBeenCalled();
    expect(promptConfirmMock).toHaveBeenCalledWith(
      "Accept this invitation and write configuration?",
    );
    const surface = stdio.stderrWrites.join("");
    const shown = surface.slice(surface.indexOf(OUTBOUND_SEND_LABEL));
    // The label's own lines: up to the next entry at the outline's top level.
    const shownList = shown.slice(0, 1 + shown.slice(1).search(/\n {2}\S/));
    expect(shownList.split("\n").slice(1)).toEqual([
      "    - id",
      `    - ${REQUESTED}`,
    ]);
    const written = parseExchangeSpec(
      YAML.parse(fs.readFileSync(argv["config-file"] as string, "utf8")),
    );
    expect(disclosedColumnNames(written.metadata ?? [])).toEqual([
      "id",
      REQUESTED,
    ]);
  });
});
