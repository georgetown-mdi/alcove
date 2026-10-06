import { describe, expect, test } from "vitest";

import {
  assembleExchangeSpec,
  connectionFromLocator,
  generateSharedSecret,
  getDefaultLinkageTerms,
  parseExchangeSpec,
  parseSensitiveYaml,
} from "@alcove/core";

import {
  CRON_EXPORT_CONFIG_MIME,
  CRON_EXPORT_KEY_MIME,
} from "@psi/managed/managedCronExport";
import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  exportRunCommand,
  managedConfigurationExportState,
  managedCronExportPanelState,
} from "@recurring/managedCronExportModel";

import type { ExchangeLocator, WebRTCExchangeLocator } from "@alcove/core";
import type {
  NewManagedExchange,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { OwnRelayRead } from "@psi/transport/ownRelaySetting";

/** A record built from `fields` and narrowed to the runnable shape: every fixture
 * here is built with a shared secret, and the export paths take the record type
 * that holds one. */
function runnableRecord(
  fields: NewManagedExchange,
): RunnableManagedExchangeRecord {
  return runnableManagedExchangeOrRefuse(buildManagedExchangeRecord(fields));
}

// The pure model behind the command-line export panel, tested in Node without a
// store or a download: what the panel renders for an exportable record, the two
// schedule lines that run its invocation unattended, and the composer's own
// refusal presented rather than re-derived. The panel's claim that the export
// names no ICE server, falling back to the built-in STUN default, is a check
// here.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

const noOwnRelay = (): OwnRelayRead => ({ kind: "none" });

const IMAGE = "ghcr.io/georgetown-mdi/alcove:1.2.3";

/** A daily schedule whose first window opened 2026-10-06 at 14:30 UTC, an
 * hour wide. */
const SCHEDULE = {
  anchor: "2026-10-06T14:30:00.000Z",
  intervalDays: 1,
  windowSeconds: 3600,
  nextWindow: "2026-10-07T14:30:00.000Z",
  consecutiveMisses: 0,
};

const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

function managedRecord(
  overrides: Partial<NewManagedExchange> = {},
): RunnableManagedExchangeRecord {
  return runnableRecord({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: webrtcLocator,
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  });
}

/** The state for an exportable record, failing the test if the composer refused
 * one it was expected to compose. */
function exportableState(record: RunnableManagedExchangeRecord) {
  const state = managedCronExportPanelState(record, noOwnRelay, IMAGE);
  if (state.kind !== "exportable")
    throw new Error(`the model refused an exportable record: ${state.reason}`);
  return state;
}

describe("what the panel gets to render", () => {
  test("the two files have their CLI names, contents, and media types", () => {
    const record = managedRecord();
    const { composed } = exportableState(record);
    expect(composed.config.fileName).toBe("alcove.yaml");
    expect(composed.config.mimeType).toBe(CRON_EXPORT_CONFIG_MIME);
    expect(composed.key.fileName).toBe(".alcove.key");
    expect(composed.key.mimeType).toBe(CRON_EXPORT_KEY_MIME);
    // The secret rides the key half alone, which is what lets the panel tell the
    // operator to handle the two files differently once they land.
    expect(composed.key.text).toContain(record.sharedSecret);
    expect(composed.config.text).not.toContain(record.sharedSecret);
  });

  test("with no agreed schedule, the lines run the image daily at 2am from the export folder", () => {
    const state = exportableState(managedRecord());
    expect(state.composed.argv).toEqual([
      "alcove",
      "exchange",
      "--log-file=exchange.log",
      "input.csv",
      "./",
    ]);
    expect(state.composed.command).toBe(
      "alcove exchange --log-file=exchange.log input.csv ./",
    );
    expect(state.runCommand).toBe(
      "docker run --rm --mount " +
        "type=bind,src=/path/to/your/exchange-folder,dst=/work " +
        `${IMAGE} exchange --log-file=exchange.log input.csv ./`,
    );
    expect(state.dockerCronLine).toBe(
      "0 2 * * * /usr/bin/docker run --rm --mount " +
        "type=bind,src=/path/to/your/exchange-folder,dst=/work " +
        `${IMAGE} exchange --log-file=exchange.log input.csv ./`,
    );
    expect(state.installedCronLine).toBe(
      "0 2 * * * cd /path/to/your/exchange-folder && /path/to/alcove " +
        "exchange --log-file=exchange.log input.csv ./",
    );
    expect(state.dockerTaskSchedulerLine).toContain("/SC DAILY /ST 02:00 ");
    expect(state.dockerTaskSchedulerLine).toContain(
      "cmd /c cd /d C:\\path\\to\\your\\exchange-folder && docker run --rm " +
        "--mount type=bind,src=C:\\path\\to\\your\\exchange-folder,dst=/work " +
        `${IMAGE} exchange --log-file=exchange.log input.csv ./`,
    );
    expect(state.fromAgreedSchedule).toBe(false);
    expect(state.schedule).toBe("daily at 2am");
    expect(state.scheduleNote).toBeUndefined();
    expect(state.unmountableNotice).toBeUndefined();
    expect(state.bindPathsCaveat).toBeUndefined();
  });

  test("the lines run on the agreed schedule and wait the agreed window", () => {
    const state = exportableState(
      managedRecord({
        schedule: { ...SCHEDULE, intervalDays: 7, windowSeconds: 7200 },
      }),
    );
    expect(state.composed.argv).toEqual([
      "alcove",
      "exchange",
      "--log-file=exchange.log",
      "--peer-timeout=2h",
      "input.csv",
      "./",
    ]);
    // 2026-10-06T14:30Z is a Tuesday.
    expect(state.dockerCronLine).toMatch(
      /^30 14 \* \* 2 \/usr\/bin\/docker run --rm /,
    );
    expect(state.installedCronLine).toMatch(
      /^30 14 \* \* 2 cd \/path\/to\/your\/exchange-folder && \/path\/to\/alcove /,
    );
    expect(state.dockerTaskSchedulerLine).toContain(
      "/SC WEEKLY /D TUE /ST 14:30 ",
    );
    expect(state.fromAgreedSchedule).toBe(true);
    expect(state.schedule).toBe("every Tuesday at 14:30 UTC");
    expect(state.scheduleNote).toMatch(/UTC/);
  });

  test.each([
    [60, "1m"],
    [5400, "90m"],
    [3600, "1h"],
    [43_200, "12h"],
    [45, "45s"],
  ])("a %i-second window waits %s for the partner", (windowSeconds, flag) => {
    const { composed } = exportableState(
      managedRecord({ schedule: { ...SCHEDULE, windowSeconds } }),
    );
    expect(composed.argv).toContain(`--peer-timeout=${flag}`);
  });

  test("an interval cron cannot state runs daily behind a day count from the first window", () => {
    const state = exportableState(
      managedRecord({ schedule: { ...SCHEDULE, intervalDays: 3 } }),
    );
    const anchorDay = Math.floor(Date.parse(SCHEDULE.anchor) / 86_400_000);
    expect(state.installedCronLine).toBe(
      "30 14 * * * [ $(( (($(date +\\%s) - 9000) / 86400 - " +
        `${anchorDay}) \\% 3 )) -eq 0 ] && cd /path/to/your/exchange-folder ` +
        "&& /path/to/alcove exchange --log-file=exchange.log " +
        "--peer-timeout=1h input.csv ./",
    );
    expect(state.dockerTaskSchedulerLine).toContain(
      "/SC DAILY /MO 3 /SD 10/06/2026 /ST 14:30 ",
    );
  });

  test("the handed-off command is the image's one-off run", () => {
    const record = managedRecord();
    const state = exportableState(record);
    expect(exportRunCommand(state.composed, IMAGE)).toBe(state.runCommand);
  });

  test("the exported connection names no ICE server, as the panel's copy says", () => {
    // The panel tells the operator every scheduled run falls back to the CLI's
    // built-in STUN default. That holds because a managed connection is a
    // credential-free locator: host, port, and path, and nothing else.
    const { composed } = exportableState(managedRecord());
    const parsed = parseExchangeSpec(
      parseSensitiveYaml(composed.config.text, "exported alcove.yaml"),
    );
    expect(parsed.connection.channel).toBe("webrtc");
    expect(parsed.connection).not.toHaveProperty("stun");
    expect(parsed.connection).not.toHaveProperty("turn");
    expect(parsed.connection).not.toHaveProperty("iceProvision");
  });

  test("composing leaves the source record untouched", () => {
    const record = managedRecord({ tokenMaxAgeDays: 90 });
    const before = structuredClone(record);
    exportableState(record);
    expect(record).toEqual(before);
  });
});

describe("a configuration on a channel this app does not run", () => {
  const nonWebrtcLocators: Array<[string, ExchangeLocator]> = [
    ["filedrop", { channel: "filedrop", path: "/srv/exchange" }],
    ["sftp", { channel: "sftp", host: "sftp.example.org", path: "/exchange" }],
  ];

  test.each(nonWebrtcLocators)(
    "exports a configuration on a channel this app does not run (%s)",
    (channel, locator) => {
      // Exporting it is how the operator runs it, so the configuration panel
      // composes it like any other.
      const state = managedConfigurationExportState(
        buildManagedExchangeRecord({
          label: "Riverbend quarterly",
          exchangeFile: assembleExchangeSpec({
            connection: connectionFromLocator(locator),
            linkageTerms,
          }),
        }),
      );
      expect(state.kind).toBe("exportable");
      if (state.kind !== "exportable") return;
      expect(state.composed.config.text).toContain(`channel: ${channel}`);
    },
  );
});

describe("a configuration naming paths outside the export folder", () => {
  function sftpConfiguration(privateKey: string) {
    const exchangeFile = assembleExchangeSpec({
      connection: connectionFromLocator({
        channel: "sftp",
        host: "sftp.example.org",
        path: "/exchange",
      }),
      linkageTerms,
    });
    if (exchangeFile.connection.channel !== "sftp")
      throw new Error("the locator composed no sftp connection");
    return buildManagedExchangeRecord({
      label: "Riverbend quarterly",
      exchangeFile: {
        ...exchangeFile,
        connection: {
          ...exchangeFile.connection,
          server: {
            ...exchangeFile.connection.server,
            username: "county",
            privateKey: `@${privateKey}`,
          },
        },
      },
    });
  }

  test("the image lines mount each at its own path, read-only for a credential", () => {
    const state = managedConfigurationExportState(
      sftpConfiguration("/home/county/.ssh/id_ed25519"),
      IMAGE,
    );
    if (state.kind !== "exportable") throw new Error(state.reason);
    expect(state.composed.bindPaths).toEqual([
      { path: "/home/county/.ssh/id_ed25519", readOnly: true },
    ]);
    expect(state.runCommand).toContain(
      "--mount type=bind,src=/home/county/.ssh/id_ed25519," +
        "dst=/home/county/.ssh/id_ed25519,readonly",
    );
    expect(state.bindPathsCaveat).toContain("/home/county/.ssh/id_ed25519");
    expect(state.unmountableNotice).toBeUndefined();
  });

  test("a path a mount cannot state drops the image lines and says why", () => {
    const state = managedConfigurationExportState(
      sftpConfiguration("/home/county/keys,old/id_ed25519"),
      IMAGE,
    );
    if (state.kind !== "exportable") throw new Error(state.reason);
    expect(state.dockerCronLine).toBeUndefined();
    expect(state.dockerTaskSchedulerLine).toBeUndefined();
    expect(state.runCommand).toBe(
      "alcove exchange --log-file=exchange.log input.csv ./",
    );
    expect(state.unmountableNotice).toContain("contains a comma");
    expect(state.bindPathsCaveat).toBeUndefined();
  });
});

describe("a record the composer refuses", () => {
  test("an authentication block on the stored document is refused, secret and all", () => {
    // The panel gate sees the same secret-bearing block the composer refuses, and
    // renders the reason on screen -- so the reason must name the block and none
    // of its values.
    const secret = generateSharedSecret();
    const base = managedRecord();
    const state = managedCronExportPanelState(
      {
        ...base,
        exchangeFile: {
          ...base.exchangeFile,
          authentication: {
            sharedSecret: secret,
            expires: "2026-04-06T14:00:00.000Z",
          },
        },
      },
      noOwnRelay,
    );
    expect(state.kind).toBe("refused");
    if (state.kind !== "refused") return;
    expect(state.reason).toContain("authentication");
    expect(state.reason).not.toContain(secret);
  });
});
