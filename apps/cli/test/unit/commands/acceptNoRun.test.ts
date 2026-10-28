import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import YAML from "yaml";
import {
  disclosedColumnNames,
  encodeInvitation,
  getLogger,
  parseExchangeSpec,
  sanitizeForDisplay,
  UsageError,
} from "@alcove/core";
import type {
  ConnectionConfig,
  ConnectionEndpoint,
  InvitationToken,
} from "@alcove/core";

vi.mock("../../../src/util/prompt", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/util/prompt")
  >("../../../src/util/prompt");
  return { ...actual, promptConfirmOrClosed: vi.fn(), promptFreeText: vi.fn() };
});

// Every client a run reaches the network through, so an acceptance that stops
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
// Where the handler opens the event stream; the descriptor itself is the
// integration suite's (terminalErrorEvent.test.ts, noRunAcceptance.test.ts).
vi.mock("../../../src/eventStream", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/eventStream")
  >("../../../src/eventStream");
  return { ...actual, openEventStream: vi.fn() };
});

import {
  NO_RUN_NO_EFFECT,
  handler as acceptHandler,
  validateAccept,
} from "../../../src/commands/accept";
import { saveConfig } from "../../../src/config";
import { connectToBroker } from "../../../src/connection/webrtc/brokerClient";
import { webSocketRelayDialsFor } from "../../../src/connection/webrtc/websocketRelayDial";
import { enrollAtInvitationRelay } from "../../../src/invitationRelayEnrollment";
import { loadKeyFile } from "../../../src/keyFile";
import { openEventStream } from "../../../src/eventStream";
import type { EventStreamEmitter } from "../../../src/eventStream";
import { runOnlineBootstrap } from "../../../src/onlineBootstrap";
import type { CommonBootstrapOptions } from "../../../src/optionDefinitions";
import { readConnectionCredentials } from "../../../src/util/atSignRefs";
import { exitCodeForError } from "../../../src/util/exit";
import { promptConfirmOrClosed } from "../../../src/util/prompt";
import { captureProcessExit, runToExit } from "../../exitCapture";
import {
  FUTURE,
  LINKAGE_COLUMNS,
  OUTBOUND_SEND_LABEL,
  sampleTerms,
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
const SFTP_ENDPOINT: ConnectionEndpoint = {
  channel: "sftp",
  host: "sftp.example.org",
  path: "/drop",
};

/** The column the inviting party requests, which inference leaves out. */
const REQUESTED = "case_manager";

/**
 * The acceptor's header: the linkage columns, an `id` inference sends as the
 * record identifier, the requested column, and a column inference leaves out
 * that nobody requests.
 */
const INPUT_COLUMNS = ["id", ...LINKAGE_COLUMNS, REQUESTED, "notes"];

/** The entry every configuration written from INPUT_COLUMNS lists. */
const REQUESTED_ENTRY = {
  name: REQUESTED,
  type: "other",
  role: "payload",
  isPayload: false,
};

let dir: string;
let counter = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(tmpdir(), "alcove-accept-no-run-"));
});

afterEach(() => {
  promptConfirmMock.mockReset();
  runOnlineBootstrapMock.mockReset();
  vi.mocked(connectToBroker).mockReset();
  vi.mocked(enrollAtInvitationRelay).mockReset();
  vi.mocked(webSocketRelayDialsFor).mockReset();
  vi.mocked(openEventStream).mockReset();
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

/** An invitation whose inviting party requests `receive`. */
function requestingToken(
  receive: string[] = [REQUESTED],
  endpoint: ConnectionEndpoint | undefined = WEBRTC_ENDPOINT,
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
  const log = getLogger(`accept-no-run-${counter++}`);
  log.setLevel("silent");
  vi.spyOn(log, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  return log;
}

/** The two acceptance forms each test below is driven through. */
type Form =
  | { mode: "offline" }
  | { mode: "online"; url: URL; input: string; output?: string };

async function accept(params: {
  token: InvitationToken;
  input?: string;
  form?: Form;
  run?: boolean;
  warnings?: string[];
  options?: CommonBootstrapOptions;
}): Promise<Awaited<ReturnType<typeof validateAccept>>> {
  const invitation = await encodeInvitation(params.token);
  const form = params.form ?? { mode: "offline" };
  return validateAccept({
    resolved:
      form.mode === "online"
        ? { ...form, invitation }
        : { mode: "offline", invitation, input: params.input },
    options: params.options ?? testOptions(),
    log: recordingLog(params.warnings ?? []),
    run: params.run,
  });
}

const sftpUrl = (): URL => new URL("sftp://host/drop");
const fileUrl = (): URL => pathToFileURL(path.join(dir, "share"));

describe("validateAccept: a configuration written from an input file", () => {
  test("lists the requested column unsent on every channel and form, beside inference's blocks", async () => {
    const input = writeInput();
    // Inference's own blocks for this file: the one-command webrtc run over an
    // invitation that requests nothing.
    const inferred = await accept({
      token: requestingToken([]),
      input,
    });
    expect(inferred.mode).toBe("endpointRun");
    if (inferred.mode !== "endpointRun") return;
    expect(inferred.dataSpec.metadata?.map((c) => c.name)).not.toContain(
      REQUESTED,
    );

    const forms: Array<{ label: string; ready: Promise<unknown> }> = [
      { label: "webrtc", ready: accept({ token: requestingToken(), input }) },
      {
        label: "sftp endpoint",
        ready: accept({
          token: requestingToken([REQUESTED], SFTP_ENDPOINT),
          input,
        }),
      },
      {
        label: "no endpoint",
        ready: accept({
          token: requestingToken([REQUESTED], undefined),
          input,
        }),
      },
      {
        label: "sftp URL",
        ready: accept({
          token: requestingToken([REQUESTED], undefined),
          form: { mode: "online", url: sftpUrl(), input },
        }),
      },
      {
        label: "file URL",
        ready: accept({
          token: requestingToken([REQUESTED], undefined),
          form: { mode: "online", url: fileUrl(), input },
        }),
      },
    ];
    for (const { label, ready: pending } of forms) {
      const ready = (await pending) as Awaited<
        ReturnType<typeof validateAccept>
      >;
      expect(ready.mode, label).toBe("offline");
      if (ready.mode !== "offline") return;
      expect(ready.dataSpec.standardization, label).toEqual(
        inferred.dataSpec.standardization,
      );
      expect(
        ready.dataSpec.metadata?.filter((c) => c.name !== REQUESTED),
        label,
      ).toEqual(inferred.dataSpec.metadata);
      expect(
        ready.dataSpec.metadata?.find((c) => c.name === REQUESTED),
        label,
      ).toEqual(REQUESTED_ENTRY);
      expect(
        disclosedColumnNames(ready.dataSpec.metadata ?? []),
        label,
      ).toEqual(["id"]);
      expect(ready.unsentRequestedColumns, label).toEqual([REQUESTED]);
    }
  });

  test("leaves a requested column inference already declares as inference has it", async () => {
    const ready = await accept({
      token: requestingToken(["ssn"]),
      input: writeInput(),
    });
    expect(ready.mode).toBe("offline");
    if (ready.mode !== "offline") return;
    expect(ready.dataSpec.metadata?.find((c) => c.name === "ssn")).toEqual({
      name: "ssn",
      type: "ssn",
      role: "linkage",
      isPayload: false,
    });
    expect(ready.dataSpec.metadata?.map((c) => c.name)).not.toContain(
      REQUESTED,
    );
  });

  test("lists no requested column where no input file was given", async () => {
    const ready = await accept({ token: requestingToken() });
    expect(ready.mode).toBe("offline");
    if (ready.mode !== "offline") return;
    expect(ready.dataSpec.metadata).toBeUndefined();
    expect(ready.unsentRequestedColumns).toEqual([]);
    expect(ready.stop).toBeUndefined();
  });

  test("refuses a requested column the input file lacks, on every form, before anything is written", async () => {
    const input = writeInput(["id", ...LINKAGE_COLUMNS]);
    for (const form of [
      { mode: "offline" } as const,
      { mode: "online", url: sftpUrl(), input } as const,
    ])
      for (const endpoint of [WEBRTC_ENDPOINT, SFTP_ENDPOINT]) {
        const options = testOptions();
        const refused = await accept({
          token: requestingToken([REQUESTED], endpoint),
          input,
          form,
          options,
        }).catch((err: unknown) => err);
        expect(refused).toBeInstanceOf(UsageError);
        expect(exitCodeForError(refused)).toBe(64);
        expect((refused as Error).message).toBe(
          'the invitation requests a column your input file does not have (["case_manager"]), ' +
            "and your partner's exchange refuses a run that does not send it. Add " +
            "it to your input file and accept again, or ask your partner for an " +
            "invitation that does not request it.",
        );
        expect(fs.existsSync(options.configFile)).toBe(false);
        expect(fs.existsSync(options.keyFile)).toBe(false);
      }

    // The names are the partner's, so each stands delimited: a name holding
    // the delimiter or the list separator stays one name.
    const two = await accept({
      token: requestingToken(["id", 'fax", "x', REQUESTED]),
      input,
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
});

describe("validateAccept: whether the acceptance runs", () => {
  test("runs where it has an input file and a connection, and nothing is requested", async () => {
    const input = writeInput();
    expect((await accept({ token: requestingToken([]), input })).mode).toBe(
      "endpointRun",
    );
    expect(
      (
        await accept({
          token: requestingToken([], undefined),
          form: { mode: "online", url: sftpUrl(), input },
        })
      ).mode,
    ).toBe("online");
  });

  test("stops for a request on every form that would run, contacting nothing", async () => {
    const input = writeInput();
    const webrtc = await accept({ token: requestingToken(), input });
    const online = await accept({
      token: requestingToken([REQUESTED], undefined),
      form: { mode: "online", url: sftpUrl(), input },
    });
    for (const ready of [webrtc, online]) {
      expect(ready.mode).toBe("offline");
      if (ready.mode !== "offline") return;
      expect(ready.stop).toBe("requestedColumns");
    }
    // An acceptance that would not have run states no reason it stopped.
    const sftp = await accept({
      token: requestingToken([REQUESTED], SFTP_ENDPOINT),
      input,
    });
    expect(sftp.mode).toBe("offline");
    if (sftp.mode !== "offline") return;
    expect(sftp.stop).toBeUndefined();
  });

  test("runs where the inferred configuration already sends every requested column", async () => {
    const input = writeInput();
    // Inference sends `id`, the record identifier.
    const webrtc = await accept({ token: requestingToken(["id"]), input });
    expect(webrtc.mode).toBe("endpointRun");
    if (webrtc.mode !== "endpointRun") return;
    expect(disclosedColumnNames(webrtc.prepared.metadata)).toEqual(["id"]);
    const online = await accept({
      token: requestingToken(["id"], undefined),
      form: { mode: "online", url: sftpUrl(), input },
    });
    expect(online.mode).toBe("online");
  });

  test("stops where a requested column is not sent, on each form, naming only the unsent ones", async () => {
    const input = writeInput();
    const webrtc = await accept({
      token: requestingToken(["id", REQUESTED]),
      input,
    });
    const online = await accept({
      token: requestingToken(["id", REQUESTED], undefined),
      form: { mode: "online", url: sftpUrl(), input },
    });
    for (const ready of [webrtc, online]) {
      expect(ready.mode).toBe("offline");
      if (ready.mode !== "offline") return;
      expect(ready.stop).toBe("requestedColumns");
      expect(ready.unsentRequestedColumns).toEqual([REQUESTED]);
    }
  });

  test("--no-run stops the webrtc form, writing the endpoint's connection", async () => {
    const warnings: string[] = [];
    const ready = await accept({
      token: requestingToken([]),
      input: writeInput(),
      run: false,
      warnings,
    });
    expect(ready.mode).toBe("offline");
    if (ready.mode !== "offline") return;
    expect(ready.stop).toBe("noRun");
    expect(ready.connectionFromUrl).toBe(false);
    expect(ready.connection).toMatchObject({
      channel: "webrtc",
      role: "acceptor",
      server: { host: "peer.example.org", path: "/psi" },
    });
    expect(warnings).not.toContain(NO_RUN_NO_EFFECT);
  });

  test("--no-run stops the URL form, writing the URL's connection", async () => {
    const warnings: string[] = [];
    const ready = await accept({
      token: requestingToken([], undefined),
      form: {
        mode: "online",
        url: sftpUrl(),
        input: writeInput(),
        output: "results",
      },
      run: false,
      warnings,
    });
    expect(ready.mode).toBe("offline");
    if (ready.mode !== "offline") return;
    expect(ready.stop).toBe("noRun");
    expect(ready.connectionFromUrl).toBe(true);
    expect(ready.seeded).toBe(false);
    expect(ready.connection).toMatchObject({
      channel: "sftp",
      server: { host: "host", path: "/drop" },
    });
    expect(warnings).not.toContain(NO_RUN_NO_EFFECT);
    expect(warnings.some((m) => m.includes("OUTPUT_FOLDER"))).toBe(true);
    // The invitation accepts no payload column while `id` is sent: the warning
    // states the exchange runs later, from the written configuration.
    const refused = warnings.filter((m) =>
      m.includes("will accept no payload columns"),
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("when you run 'alcove exchange'");
    expect(refused[0]).not.toContain("runs that exchange next");
  });

  test("--no-run is reported as having no effect where the acceptance runs no exchange anyway", async () => {
    expect(NO_RUN_NO_EFFECT).toContain(
      "--no-run has no effect on this acceptance",
    );
    const input = writeInput();
    const reported = async (
      params: Parameters<typeof accept>[0],
    ): Promise<boolean> => {
      const warnings: string[] = [];
      await accept({ ...params, warnings });
      return warnings.includes(NO_RUN_NO_EFFECT);
    };
    // No input file, an endpoint on another channel, and no endpoint.
    expect(await reported({ token: requestingToken([]), run: false })).toBe(
      true,
    );
    expect(
      await reported({
        token: requestingToken([], SFTP_ENDPOINT),
        input,
        run: false,
      }),
    ).toBe(true);
    // A kept configuration governs its own exchange.
    const options = testOptions();
    saveConfig(options.configFile, {
      connection: { channel: "filedrop", path: "/mnt/share" },
      linkageTerms: sampleTerms("Agency B"),
    });
    expect(
      await reported({
        token: sampleToken(FUTURE(), WEBRTC_ENDPOINT),
        input,
        run: false,
        options,
      }),
    ).toBe(true);
    // Where it takes effect, or is not given, nothing is reported.
    expect(
      await reported({ token: requestingToken([]), input, run: false }),
    ).toBe(false);
    expect(await reported({ token: requestingToken([]) })).toBe(false);
  });
});

/**
 * Options naming a configuration already at the path, as a `--no-run`
 * acceptance over the sftp URL writes it from `input`, with the requested
 * column sent or not.
 */
async function keptConfiguration(
  sendsRequested: boolean,
  input: string,
): Promise<CommonBootstrapOptions> {
  const fresh = await accept({
    token: requestingToken([REQUESTED], undefined),
    form: { mode: "online", url: sftpUrl(), input },
    run: false,
  });
  if (fresh.mode !== "offline") throw new Error("expected an acceptance stop");
  const options = testOptions();
  saveConfig(options.configFile, {
    connection: fresh.connection,
    ...fresh.dataSpec,
    metadata: (fresh.dataSpec.metadata ?? []).map((column) =>
      column.name === REQUESTED
        ? { ...column, isPayload: sendsRequested }
        : column,
    ),
  });
  return options;
}

describe("validateAccept: a kept configuration on the URL form", () => {
  test("runs where it sends every requested column, sending what it declares", async () => {
    const input = writeInput();
    const options = await keptConfiguration(true, input);
    const ready = await accept({
      token: requestingToken([REQUESTED], undefined),
      form: { mode: "online", url: sftpUrl(), input },
      options,
    });
    expect(ready.reuseExistingConfig).toBe(true);
    expect(ready.mode).toBe("online");
    if (ready.mode !== "online") return;
    expect(disclosedColumnNames(ready.prepared.metadata)).toEqual([
      "id",
      REQUESTED,
    ]);
  });

  test("stops where it does not send one, naming it", async () => {
    const input = writeInput();
    const options = await keptConfiguration(false, input);
    const ready = await accept({
      token: requestingToken([REQUESTED], undefined),
      form: { mode: "online", url: sftpUrl(), input },
      options,
    });
    expect(ready.reuseExistingConfig).toBe(true);
    expect(ready.mode).toBe("offline");
    if (ready.mode !== "offline") return;
    expect(ready.stop).toBe("requestedColumns");
    expect(ready.unsentRequestedColumns).toEqual([REQUESTED]);
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

/** Run the handler, returning what it wrote to stderr. */
async function runHandler(argv: Arguments): Promise<string> {
  const exit = captureProcessExit();
  const stdio = captureStdio();
  // Read before the restore, which clears the recorded calls.
  let exitCalls: unknown[][];
  try {
    await acceptHandler(argv);
  } finally {
    exitCalls = [...exit.mock.calls];
    stdio.restore();
    exit.mockRestore();
  }
  expect(exitCalls).toEqual([]);
  return stdio.stderrWrites.join("");
}

function writtenSpec(argv: Arguments): ReturnType<typeof parseExchangeSpec> {
  return parseExchangeSpec(
    YAML.parse(fs.readFileSync(argv["config-file"] as string, "utf8")),
  );
}

describe("handler: an acceptance that stops", () => {
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

  test("--no-run on a webrtc invitation writes the files and contacts no server", async () => {
    const encoded = await encodeInvitation(requestingToken([]));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const argv = handlerArgv([encoded, writeInput()], {
      "consent-to-terms": true,
      run: false,
    });
    let stderr: string;
    try {
      stderr = await runHandler(argv);
    } finally {
      fetchSpy.mockRestore();
    }
    expect(runOnlineBootstrapMock).not.toHaveBeenCalled();
    expect(connectToBroker).not.toHaveBeenCalled();
    expect(enrollAtInvitationRelay).not.toHaveBeenCalled();
    expect(webSocketRelayDialsFor).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(argv["key-file"] as string)).toBe(true);
    const written = writtenSpec(argv);
    expect(disclosedColumnNames(written.metadata ?? [])).toEqual(["id"]);
    expect(written.standardization).toBeDefined();
    expect(stderr).toContain(
      "it needs no credentials of your own. Run 'alcove exchange' with your " +
        "input file to conduct the exchange.",
    );
    expect(stderr).not.toContain("requests columns from you");
  });

  test("--no-run on a URL writes the URL's connection and the invitation's secret", async () => {
    const token = requestingToken([], undefined);
    const encoded = await encodeInvitation(token);
    const argv = handlerArgv(["sftp://host/drop", encoded, writeInput()], {
      "consent-to-terms": true,
      run: false,
    });
    const stderr = await runHandler(argv);
    expect(runOnlineBootstrapMock).not.toHaveBeenCalled();
    expect(writtenSpec(argv).connection).toMatchObject({
      channel: "sftp",
      server: { host: "host", path: "/drop" },
    });
    expect(loadKeyFile(argv["key-file"] as string)?.sharedSecret).toBe(
      token.sharedSecret,
    );
    expect(stderr).toContain(
      "with the connection from the URL and your connection flags. Run " +
        "'alcove exchange' with your input file to conduct the exchange.",
    );
  });

  test("a URL acceptance that stops refuses an unreadable @path credential as a run's read does, writing nothing", async () => {
    const missing = path.join(dir, "missing-password");
    // What the run's bootstrap raises for the same connection.
    let runRefusal: unknown;
    try {
      readConnectionCredentials({
        channel: "sftp",
        server: { host: "host", path: "/drop", password: `@${missing}` },
      } as ConnectionConfig);
    } catch (err) {
      runRefusal = err;
    }
    expect(exitCodeForError(runRefusal)).toBe(64);

    for (const [token, extra] of [
      [requestingToken([], undefined), { run: false }],
      [requestingToken([REQUESTED], undefined), {}],
    ] as Array<[InvitationToken, Record<string, unknown>]>) {
      const argv = handlerArgv(
        ["sftp://host/drop", await encodeInvitation(token), writeInput()],
        {
          "consent-to-terms": true,
          "server-password": `@${missing}`,
          ...extra,
        },
      );
      const exit = captureProcessExit();
      const stdio = captureStdio();
      let exitCalls: unknown[][];
      try {
        await runToExit(() => acceptHandler(argv));
      } finally {
        exitCalls = [...exit.mock.calls];
        stdio.restore();
        exit.mockRestore();
      }
      expect(exitCalls).toEqual([[exitCodeForError(runRefusal)]]);
      expect(stdio.stderrWrites.join("")).toContain("missing-password");
      expect(fs.existsSync(argv["config-file"] as string)).toBe(false);
      expect(fs.existsSync(argv["key-file"] as string)).toBe(false);
    }
    expect(runOnlineBootstrapMock).not.toHaveBeenCalled();
  });

  test("a URL acceptance that stops writes a readable @path credential as its reference", async () => {
    const passwordFile = path.join(dir, "password");
    fs.writeFileSync(passwordFile, "not-a-real-password\n");
    const argv = handlerArgv(
      [
        "sftp://host/drop",
        await encodeInvitation(requestingToken([], undefined)),
        writeInput(),
      ],
      {
        "consent-to-terms": true,
        "server-password": `@${passwordFile}`,
        run: false,
      },
    );
    await runHandler(argv);
    expect(writtenSpec(argv).connection).toMatchObject({
      channel: "sftp",
      server: { password: `@${passwordFile}` },
    });
  });

  test("a request stops a webrtc acceptance, naming the columns to declare", async () => {
    // The names are the partner's: one holding an invisible character is
    // escaped where it is shown, on a line of its own.
    const hostile = "case\u200dx";
    const input = writeInput([...INPUT_COLUMNS, hostile]);
    const encoded = await encodeInvitation(
      requestingToken([REQUESTED, hostile]),
    );
    const argv = handlerArgv([encoded, input], { "consent-to-terms": true });
    const stderr = await runHandler(argv);
    expect(runOnlineBootstrapMock).not.toHaveBeenCalled();
    expect(connectToBroker).not.toHaveBeenCalled();
    expect(stderr).toContain(
      "this acceptance did not run the exchange: your partner's run refuses " +
        "an exchange that does not send the columns it requests from you, " +
        "and the configuration written to ",
    );
    expect(stderr).toContain(" does not send these:\n");
    expect(stderr).toContain(`\n  - ${REQUESTED}\n`);
    expect(sanitizeForDisplay(hostile)).not.toBe(hostile);
    expect(stderr).toContain(`\n  - ${sanitizeForDisplay(hostile)}\n`);
    expect(stderr).not.toContain("\u200d");
    expect(stderr).toContain(
      "They are listed in its metadata block with is_payload: false. Set " +
        "is_payload: true on each one you agreed to send, then run 'alcove " +
        "exchange' with your input file at the agreed time.",
    );
    expect(stderr).not.toContain("to conduct the exchange");
    const written = writtenSpec(argv);
    expect(written.metadata).toContainEqual(REQUESTED_ENTRY);
    expect(disclosedColumnNames(written.metadata ?? [])).toEqual(["id"]);
  });

  test("a request stops a URL acceptance the same way", async () => {
    const encoded = await encodeInvitation(
      requestingToken([REQUESTED], undefined),
    );
    const argv = handlerArgv(["sftp://host/drop", encoded, writeInput()], {
      "consent-to-terms": true,
    });
    const stderr = await runHandler(argv);
    expect(runOnlineBootstrapMock).not.toHaveBeenCalled();
    expect(stderr).toContain("this acceptance did not run the exchange");
    expect(writtenSpec(argv).metadata).toContainEqual(REQUESTED_ENTRY);
  });

  test("a request on an acceptance that would not run is named without a reason to stop", async () => {
    const encoded = await encodeInvitation(
      requestingToken([REQUESTED], SFTP_ENDPOINT),
    );
    const argv = handlerArgv([encoded, writeInput()], {
      "consent-to-terms": true,
    });
    const stderr = await runHandler(argv);
    expect(stderr).toContain(
      "the invitation requests columns from you that the configuration " +
        "written to ",
    );
    expect(stderr).toContain(` does not send:\n  - ${REQUESTED}\n`);
    expect(stderr).not.toContain("did not run the exchange");
    expect(writtenSpec(argv).metadata).toContainEqual(REQUESTED_ENTRY);
  });

  test("names only the requested columns the configuration does not send", async () => {
    const encoded = await encodeInvitation(requestingToken(["id", REQUESTED]));
    const stderr = await runHandler(
      handlerArgv([encoded, writeInput()], { "consent-to-terms": true }),
    );
    expect(runOnlineBootstrapMock).not.toHaveBeenCalled();
    expect(stderr).toContain(` does not send these:\n  - ${REQUESTED}\nThey`);
    expect(stderr).not.toContain("\n  - id\n");
  });

  test("a kept configuration that does not send a requested column stops, naming the kept file", async () => {
    const input = writeInput();
    const options = await keptConfiguration(false, input);
    const encoded = await encodeInvitation(
      requestingToken([REQUESTED], undefined),
    );
    const stderr = await runHandler(
      handlerArgv(["sftp://host/drop", encoded, input], {
        "consent-to-terms": true,
        "config-file": options.configFile,
        "key-file": options.keyFile,
      }),
    );
    expect(runOnlineBootstrapMock).not.toHaveBeenCalled();
    expect(stderr).toContain("reused the existing configuration at ");
    expect(stderr).toContain(
      "this acceptance did not run the exchange: your partner's run refuses " +
        "an exchange that does not send the columns it requests from you, " +
        "and the existing configuration at ",
    );
    expect(stderr).toContain(
      `${options.configFile} does not send these:\n` +
        `  - ${REQUESTED}\n` +
        "In its metadata block, set is_payload: true on each one you agreed " +
        "to send, with a role other than ignored, adding an entry with " +
        "role: payload for one it does not list, then run 'alcove exchange' " +
        "with your input file at the agreed time.",
    );
    expect(fs.existsSync(options.keyFile)).toBe(true);
  });

  test("an offline acceptance keeping a configuration names the requested columns it does not send", async () => {
    const input = writeInput();
    const encoded = await encodeInvitation(
      requestingToken([REQUESTED], undefined),
    );
    const notSending = await keptConfiguration(false, input);
    const stderr = await runHandler(
      handlerArgv([encoded, input], {
        "consent-to-terms": true,
        "config-file": notSending.configFile,
        "key-file": notSending.keyFile,
      }),
    );
    expect(stderr).toContain(
      "the invitation requests columns from you that the existing " +
        `configuration at ${notSending.configFile} does not send:\n` +
        `  - ${REQUESTED}\nIn its metadata block`,
    );
    expect(stderr).not.toContain("did not run the exchange");

    const sending = await keptConfiguration(true, input);
    const quiet = await runHandler(
      handlerArgv([encoded, input], {
        "consent-to-terms": true,
        "config-file": sending.configFile,
        "key-file": sending.keyFile,
      }),
    );
    expect(quiet).toContain("reused the existing configuration at ");
    expect(quiet).not.toContain("requests columns from you that");
  });

  test("an offline acceptance keeping a configuration shows the kept file's columns as sent", async () => {
    promptConfirmMock.mockResolvedValue("yes");
    const input = writeInput();
    const options = await keptConfiguration(true, input);
    // Unlike inference, the kept file keeps `id` and does not send it.
    const kept = parseExchangeSpec(
      YAML.parse(fs.readFileSync(options.configFile, "utf8")),
    );
    const keptMetadata = (kept.metadata ?? []).map((column) =>
      column.name === "id" ? { ...column, isPayload: false } : column,
    );
    saveConfig(options.configFile, { ...kept, metadata: keptMetadata });
    const token = requestingToken([REQUESTED], undefined);

    const ready = await accept({ token, input, options });
    expect(ready.reuseExistingConfig).toBe(true);
    expect(ready.mode).toBe("offline");
    if (ready.mode !== "offline") return;
    expect(ready.dataSpec.metadata).toEqual(keptMetadata);
    expect(ready.unsentRequestedColumns).toEqual([]);

    fs.rmSync(options.keyFile, { force: true });
    const surface = await runHandler(
      handlerArgv([await encodeInvitation(token), input], {
        "config-file": options.configFile,
        "key-file": options.keyFile,
      }),
    );
    const shown = surface.slice(surface.indexOf(OUTBOUND_SEND_LABEL));
    const shownList = shown.slice(0, 1 + shown.slice(1).search(/\n {2}\S/));
    expect(shownList.split("\n").slice(1)).toEqual([`    - ${REQUESTED}`]);
    expect(surface).not.toContain("requests columns from you that");
  });

  test("a kept configuration that sends every requested column runs", async () => {
    runOnlineBootstrapMock.mockResolvedValue({
      outcome: "completed",
      configWriteError: undefined,
    });
    const input = writeInput();
    const options = await keptConfiguration(true, input);
    const encoded = await encodeInvitation(
      requestingToken([REQUESTED], undefined),
    );
    await runHandler(
      handlerArgv(["sftp://host/drop", encoded, input], {
        "consent-to-terms": true,
        "config-file": options.configFile,
        "key-file": options.keyFile,
        "log-level": "silent",
      }),
    );
    expect(runOnlineBootstrapMock).toHaveBeenCalledTimes(1);
    const passed = runOnlineBootstrapMock.mock.calls[0][0];
    expect(passed.reuseExistingConfig).toBe(true);
    expect(disclosedColumnNames(passed.prepared.metadata)).toEqual([
      "id",
      REQUESTED,
    ]);
  });

  test("leaves an acceptance with nothing requested running the exchange", async () => {
    runOnlineBootstrapMock.mockResolvedValue({
      outcome: "completed",
      configWriteError: undefined,
    });
    const encoded = await encodeInvitation(requestingToken([]));
    await runHandler(
      handlerArgv([encoded, writeInput()], {
        "consent-to-terms": true,
        "log-level": "silent",
      }),
    );
    expect(runOnlineBootstrapMock).toHaveBeenCalledTimes(1);
  });

  test("shows, before the question, the columns the written configuration sends", async () => {
    promptConfirmMock.mockResolvedValue("yes");
    const encoded = await encodeInvitation(requestingToken());
    const argv = handlerArgv([encoded, writeInput()], {});
    const surface = await runHandler(argv);
    expect(promptConfirmMock).toHaveBeenCalledWith(
      "Accept this invitation and write configuration?",
    );
    const shown = surface.slice(surface.indexOf(OUTBOUND_SEND_LABEL));
    // The label's own lines: up to the next entry at the outline's top level.
    const shownList = shown.slice(0, 1 + shown.slice(1).search(/\n {2}\S/));
    expect(shownList.split("\n").slice(1)).toEqual(["    - id"]);
    // The requested column is named where the display already names it, as
    // asked for rather than sent.
    const requested = surface.slice(
      surface.indexOf("columns the inviting party requests from you"),
    );
    expect(requested.split("\n")[1]).toBe(`    - ${REQUESTED}`);
    expect(disclosedColumnNames(writtenSpec(argv).metadata ?? [])).toEqual([
      "id",
    ]);
  });

  test("--event-stream: an acceptance that does not run opens no stream, on either form", async () => {
    promptConfirmMock.mockResolvedValue("no");
    const webrtc = await encodeInvitation(requestingToken());
    const online = await encodeInvitation(
      requestingToken([REQUESTED], undefined),
    );
    const nothingRequested = await encodeInvitation(requestingToken([]));
    for (const [args, extra] of [
      // Stopped for the request, on each form.
      [[webrtc, writeInput()], { "consent-to-terms": true }],
      [
        ["sftp://host/drop", online, writeInput()],
        { "consent-to-terms": true },
      ],
      // --no-run, no INPUT_FILE, and a decline.
      [
        [nothingRequested, writeInput()],
        { "consent-to-terms": true, run: false },
      ],
      [[nothingRequested], { "consent-to-terms": true }],
      [[nothingRequested, writeInput()], {}],
    ] as Array<[string[], Record<string, unknown>]>)
      await runHandler(
        handlerArgv(args, {
          ...extra,
          "event-stream": true,
          "log-level": "silent",
        }),
      );
    expect(openEventStream).not.toHaveBeenCalled();
    expect(runOnlineBootstrapMock).not.toHaveBeenCalled();
  });

  test("--event-stream: an acceptance that runs opens the stream at consent and hands it to the bootstrap, on either form", async () => {
    const emitter = { result: vi.fn() } as unknown as EventStreamEmitter;
    vi.mocked(openEventStream).mockReturnValue(emitter);
    runOnlineBootstrapMock.mockResolvedValue({
      outcome: "completed",
      configWriteError: undefined,
    });
    const webrtc = await encodeInvitation(requestingToken([]));
    const online = await encodeInvitation(requestingToken([], undefined));
    for (const args of [
      [webrtc, writeInput()],
      ["sftp://host/drop", online, writeInput()],
    ])
      await runHandler(
        handlerArgv(args, {
          "consent-to-terms": true,
          "event-stream": true,
          "log-level": "silent",
        }),
      );
    expect(vi.mocked(openEventStream).mock.calls).toEqual([[true], [true]]);
    expect(runOnlineBootstrapMock).toHaveBeenCalledTimes(2);
    runOnlineBootstrapMock.mock.calls.forEach(([passed], index) => {
      expect(passed.eventStream).toBe(emitter);
      expect(
        vi.mocked(openEventStream).mock.invocationCallOrder[index],
      ).toBeLessThan(runOnlineBootstrapMock.mock.invocationCallOrder[index]);
    });
  });
});
