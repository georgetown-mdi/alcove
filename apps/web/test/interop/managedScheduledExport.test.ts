import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { parseSensitiveJson } from "@alcove/core";

import {
  EXCHANGE_FOLDER_PLACEHOLDER,
  INSTALLED_ALCOVE_PLACEHOLDER,
} from "@recurring/scheduledRunCommand";
import { dockerRunArgv } from "@psi/dockerRunCommand";
import { managedConfigurationExportState } from "@recurring/managedCronExportModel";
import { readManagedCommandLineConfiguration } from "@psi/managed/managedCommandLineImport";

import {
  cliEntry,
  expectCliSucceeded,
  fillInFileDropConnection,
  invitationFrom,
  pairsFromResultCsv,
  startCli,
} from "./cliParty";

import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";

/**
 * The managed exchange's command-line export, taken to a scheduling machine
 * and run as given: the configuration it composes from a partnership's
 * alcove.yaml, the key file beside it, and its cron line for an installed
 * Alcove with only the placeholders set, run by the shell against the
 * partner's next scheduled run.
 *
 * A record this app runs is a webrtc exchange, which needs a signaling server
 * this suite does not stand up, so the partnership here is a shared folder's,
 * exported with the agreed schedule a record this app runs holds. The Docker
 * form is the same arguments after the image, which this suite checks but
 * cannot run (no Docker in the test environment).
 */

const PARTNER_CSV =
  "ssn,first_name,last_name,date_of_birth\n" +
  "111223333,bob,smith,1990-01-01\n" +
  "222334444,carol,jones,1985-11-30\n" +
  "333445555,dave,lee,1979-04-02\n";

const OWN_CSV =
  "ssn,first_name,last_name,date_of_birth\n" +
  "444556666,erin,park,1970-07-07\n" +
  "111223333,bob,smith,1990-01-01\n" +
  "222334444,carol,jones,1985-11-30\n";

const OWN_PAIRS: Array<[number, number]> = [
  [1, 0],
  [2, 1],
];

const POLL_INTERVAL_MS = 20;
const PEER_TIMEOUT_MS = 60_000;
const CLI_DEADLINE_MS = 150_000;
const IMAGE = "ghcr.io/georgetown-mdi/alcove:latest";

/** Every third day from this minute, two minutes wide, so the cron line run
 * now is the run cron starts at the first window's open. */
function agreedSchedule(): NonNullable<ManagedExchangeRecord["schedule"]> {
  const opens = new Date();
  opens.setUTCSeconds(0, 0);
  return {
    anchor: opens.toISOString(),
    intervalDays: 3,
    windowSeconds: 120,
    nextWindow: opens.toISOString(),
    consecutiveMisses: 0,
  };
}

interface Workspace {
  root: string;
  dropDir: string;
  partnerDir: string;
  /** Where the partnership is accepted on the command line before import. */
  acceptDir: string;
  /** The folder on the scheduling machine the operator saves the files to. */
  scheduleDir: string;
}

let workspace: Workspace;

beforeEach(() => {
  const root = mkdtempSync(path.join(tmpdir(), "alcove-managed-schedule-"));
  workspace = {
    root,
    dropDir: path.join(root, "drop"),
    partnerDir: path.join(root, "partner"),
    acceptDir: path.join(root, "accept"),
    scheduleDir: path.join(root, "scheduled"),
  };
  for (const dir of [
    workspace.dropDir,
    workspace.partnerDir,
    workspace.acceptDir,
    workspace.scheduleDir,
  ])
    mkdirSync(dir);
  writeFileSync(path.join(workspace.partnerDir, "input.csv"), PARTNER_CSV);
  writeFileSync(path.join(workspace.acceptDir, "input.csv"), OWN_CSV);
});

afterEach(() => {
  rmSync(workspace.root, { recursive: true, force: true });
});

function sharedSecretIn(folder: string): string {
  const parsed = parseSensitiveJson(
    readFileSync(path.join(folder, ".alcove.key"), "utf8"),
    "key file",
  ) as { sharedSecret?: unknown };
  if (typeof parsed.sharedSecret !== "string")
    throw new Error(`${folder} holds no shared secret`);
  return parsed.sharedSecret;
}

/** The partner's `alcove invite`, accepted on the command line, with both
 * connection blocks naming the shared folder. */
async function establishPartnership(): Promise<void> {
  const invite = await startCli({
    args: ["invite", "--identity", "Agency A, a@agency-a.example", "input.csv"],
    cwd: workspace.partnerDir,
    timeoutMs: CLI_DEADLINE_MS,
  });
  expectCliSucceeded(invite, "invite");
  const connection = {
    dropDir: workspace.dropDir,
    pollIntervalMs: POLL_INTERVAL_MS,
    peerTimeoutMs: PEER_TIMEOUT_MS,
  };
  fillInFileDropConnection({
    configPath: path.join(workspace.partnerDir, "alcove.yaml"),
    ...connection,
  });
  const accept = await startCli({
    args: [
      "accept",
      "--identity",
      "Agency B, b@agency-b.example",
      "--consent-to-terms",
      invitationFrom(invite),
      "input.csv",
    ],
    cwd: workspace.acceptDir,
    timeoutMs: CLI_DEADLINE_MS,
  });
  expectCliSucceeded(accept, "accept");
  fillInFileDropConnection({
    configPath: path.join(workspace.acceptDir, "alcove.yaml"),
    ...connection,
  });
}

/** Run `line` as cron does: the five schedule fields dropped, each `\%`
 * unescaped, and the rest handed to `/bin/sh`. */
function runCrontabCommand(
  line: string,
): Promise<{ exitCode: number | null; output: string }> {
  const command = line.split(" ").slice(5).join(" ").replaceAll("\\%", "%");
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: workspace.root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const deadline = setTimeout(() => child.kill("SIGKILL"), CLI_DEADLINE_MS);
    child.once("error", reject);
    child.once("close", (exitCode) => {
      clearTimeout(deadline);
      resolve({ exitCode, output });
    });
  });
}

describe("the managed exchange's command-line export, run as given", () => {
  test("the exported file and cron line link against the partner's next run", async () => {
    await establishPartnership();
    const record: ManagedExchangeRecord = {
      ...readManagedCommandLineConfiguration(
        readFileSync(path.join(workspace.acceptDir, "alcove.yaml"), "utf8"),
      ),
      schedule: agreedSchedule(),
    };
    const state = managedConfigurationExportState(record, IMAGE);
    if (state.kind !== "exportable") throw new Error(state.reason);
    expect(state.composed.argv).toEqual([
      "alcove",
      "exchange",
      "--log-file=exchange.log",
      "--peer-timeout=2m",
      "input.csv",
      "./",
    ]);
    expect(state.composed.bindPaths).toEqual([
      { path: workspace.dropDir, readOnly: false },
    ]);

    // The operator's part: save the exported alcove.yaml, put the key file
    // and the input beside it.
    writeFileSync(
      path.join(workspace.scheduleDir, state.composed.config.fileName),
      state.composed.config.text,
    );
    copyFileSync(
      path.join(workspace.acceptDir, ".alcove.key"),
      path.join(workspace.scheduleDir, ".alcove.key"),
    );
    chmodSync(path.join(workspace.scheduleDir, ".alcove.key"), 0o600);
    copyFileSync(
      path.join(workspace.acceptDir, "input.csv"),
      path.join(workspace.scheduleDir, "input.csv"),
    );
    const installedAlcove = path.join(workspace.root, "alcove");
    writeFileSync(
      installedAlcove,
      `#!/bin/sh\nexec '${process.execPath}' '${cliEntry}' "$@"\n`,
    );
    chmodSync(installedAlcove, 0o755);

    if (state.lines.kind !== "shown")
      throw new Error(`the export withheld its lines: ${state.lines.notice}`);
    expect(state.lines.installedCronLine).toMatch(/^\d+ \d+ \* \* \* \[ /);
    const line = state.lines.installedCronLine
      .replace(EXCHANGE_FOLDER_PLACEHOLDER, workspace.scheduleDir)
      .replace(INSTALLED_ALCOVE_PLACEHOLDER, installedAlcove);

    const partnerNext = startCli({
      args: ["exchange", "input.csv", "out/"],
      cwd: workspace.partnerDir,
      timeoutMs: CLI_DEADLINE_MS,
    });
    const scheduled = await runCrontabCommand(line);
    expectCliSucceeded(await partnerNext, "exchange");
    if (scheduled.exitCode !== 0)
      throw new Error(
        `the scheduled command exited ${String(scheduled.exitCode)}\n` +
          scheduled.output,
      );

    const scheduledFiles = readdirSync(workspace.scheduleDir);
    const results = scheduledFiles.filter((name) =>
      /^alcove-results-.+\.csv$/.test(name),
    );
    expect(results).toHaveLength(1);
    expect(
      pairsFromResultCsv(path.join(workspace.scheduleDir, results[0])),
    ).toEqual(OWN_PAIRS);
    const runRecord = results[0]
      .replace(/^alcove-results-/, "alcove-record-")
      .replace(/\.csv$/, ".json");
    expect(scheduledFiles).toContain(runRecord);
    const verified = await startCli({
      args: ["verify-receipt", runRecord, "input.csv", results[0]],
      cwd: workspace.scheduleDir,
      timeoutMs: CLI_DEADLINE_MS,
    });
    expectCliSucceeded(verified, "verify-receipt");
    expect(verified.output).toMatch(/^VERIFIED/m);
    expect(existsSync(path.join(workspace.scheduleDir, "exchange.log"))).toBe(
      true,
    );
    expect(
      sharedSecretIn(workspace.scheduleDir) ===
        sharedSecretIn(workspace.partnerDir),
    ).toBe(true);

    // The Docker line runs the same arguments in the image, over the same
    // folder mounted at its working directory and the shared folder at its
    // own path.
    const source = {
      argv: state.composed.argv,
      bindPaths: state.composed.bindPaths,
      image: IMAGE,
    };
    const dockerArgv = dockerRunArgv(
      source,
      "/usr/bin/docker",
      EXCHANGE_FOLDER_PLACEHOLDER,
    );
    expect(dockerArgv?.slice(0, 7)).toEqual([
      "/usr/bin/docker",
      "run",
      "--rm",
      "--mount",
      `type=bind,src=${EXCHANGE_FOLDER_PLACEHOLDER},dst=/work`,
      "--mount",
      `type=bind,src=${workspace.dropDir},dst=${workspace.dropDir}`,
    ]);
    expect(dockerArgv?.slice(8)).toEqual(state.composed.argv.slice(1));
    expect(state.lines.dockerCronLine).toContain(
      "/usr/bin/docker run --rm --mount " +
        `type=bind,src=${EXCHANGE_FOLDER_PLACEHOLDER},dst=/work`,
    );
  });
});
