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
  dockerCronLine,
  handoffInputName,
  installedCronLine,
} from "@recurring/scheduledRunCommand";
import { HANDOFF_SHARED_DIRECTORY_PLACEHOLDER } from "@jobs/handoff";
import { JobManager } from "@jobs/jobManager";
import { authoringStateFromDocument } from "@console/loadedConfig";
import { connectionTuningOptions } from "@console/connectionTuningModel";
import { dockerRunArgv } from "@psi/dockerRunCommand";

import { awaitJobSucceeded } from "../utils/jobFixtures";

import {
  cliEntry,
  expectCliSucceeded,
  fillInFileDropConnection,
  invitationFrom,
  pairsFromResultCsv,
  startCli,
} from "./cliParty";

import type { JobFiledropExchangeIntent } from "@jobs/intentSchemas";
import type { ScheduledRunSource } from "@psi/dockerRunCommand";

/**
 * The console's recurring-run hand-off, taken to a scheduling machine and run
 * as given: a console run of an exchange against a real `alcove` partner, then
 * the files and command line its hand-off names, with only the placeholders
 * set, run by the shell against the same partner's next scheduled run.
 *
 * The command line run here is the installed-program form; the Docker form is
 * the same arguments after the image, which this suite checks but cannot run
 * (no Docker in the test environment).
 */

const PARTNER_CSV =
  "ssn,first_name,last_name,date_of_birth\n" +
  "111223333,bob,smith,1990-01-01\n" +
  "222334444,carol,jones,1985-11-30\n" +
  "333445555,dave,lee,1979-04-02\n";

const CONSOLE_CSV =
  "ssn,first_name,last_name,date_of_birth\n" +
  "444556666,erin,park,1970-07-07\n" +
  "111223333,bob,smith,1990-01-01\n" +
  "222334444,carol,jones,1985-11-30\n";

/** The input the partnership is accepted over on the command line. */
const ACCEPT_INPUT_NAME = "clients.csv";

/** The same input under the name the console run picks, which the hand-off
 * states; its leading dash is a file name the scheduled command must not
 * read as a flag. */
const CONSOLE_INPUT_NAME = "-clients.csv";

const CONSOLE_PAIRS: Array<[number, number]> = [
  [1, 0],
  [2, 1],
];

const POLL_INTERVAL_MS = 20;
const PEER_TIMEOUT_MS = 60_000;
const CLI_DEADLINE_MS = 150_000;
const JOB_DEADLINE_MS = 150_000;

interface Workspace {
  root: string;
  dropDir: string;
  partnerDir: string;
  mount: string;
  /** The folder on the scheduling machine the operator copies the files to. */
  scheduleDir: string;
}

let workspace: Workspace;
const managers: Array<JobManager> = [];

beforeEach(() => {
  const root = mkdtempSync(path.join(tmpdir(), "alcove-console-schedule-"));
  workspace = {
    root,
    dropDir: path.join(root, "drop"),
    partnerDir: path.join(root, "partner"),
    mount: path.join(root, "mount"),
    scheduleDir: path.join(root, "scheduled"),
  };
  for (const dir of [
    workspace.dropDir,
    workspace.partnerDir,
    workspace.mount,
    workspace.scheduleDir,
  ])
    mkdirSync(dir);
  writeFileSync(path.join(workspace.partnerDir, "input.csv"), PARTNER_CSV);
  writeFileSync(path.join(workspace.mount, ACCEPT_INPUT_NAME), CONSOLE_CSV);
  writeFileSync(path.join(workspace.mount, CONSOLE_INPUT_NAME), CONSOLE_CSV);
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
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

/** The partner's `alcove invite`, accepted on the command line into the
 * console's folder, with both connection blocks naming the shared folder. */
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
      ACCEPT_INPUT_NAME,
    ],
    cwd: workspace.mount,
    timeoutMs: CLI_DEADLINE_MS,
  });
  expectCliSucceeded(accept, "accept");
  fillInFileDropConnection({
    configPath: path.join(workspace.mount, "alcove.yaml"),
    ...connection,
  });
}

/** The console's run of the configuration it opened, converted to the
 * console's own paths so the hand-off states placeholders. */
function convertedIntentFromOpen(
  manager: JobManager,
): JobFiledropExchangeIntent {
  const response = manager.openMountedConfiguration();
  if (response.document === undefined)
    throw new Error("the mount holds no configuration to open");
  const loaded = authoringStateFromDocument(response.document);
  const options = connectionTuningOptions(loaded.connectionTuning);
  return {
    channel: "filedrop",
    side: "acceptor",
    linkageTerms: loaded.linkageTerms,
    inputFile: { name: CONSOLE_INPUT_NAME },
    mountedConfigurationOpened: true,
    mountedConfigurationConverted: true,
    ...(loaded.metadata !== undefined ? { metadata: loaded.metadata } : {}),
    ...(loaded.standardization !== undefined
      ? { standardization: loaded.standardization }
      : {}),
    ...loaded.records,
    ...(options !== undefined ? { options } : {}),
  };
}

/** Run `line` with `/bin/sh`, as cron hands a crontab command to it, less the
 * five schedule fields. */
function runCrontabCommand(
  line: string,
): Promise<{ exitCode: number | null; output: string }> {
  const command = line.split(" ").slice(5).join(" ");
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

describe("the console's recurring-run hand-off, run as given", () => {
  test("the handed-off files and cron command link against the partner's next run", async () => {
    await establishPartnership();
    const manager = new JobManager({
      dataRoot: workspace.mount,
      binaryPath: cliEntry,
      jobInputDir: workspace.mount,
      jobRendezvousDir: workspace.dropDir,
    });
    managers.push(manager);
    const id = await manager.createJob(convertedIntentFromOpen(manager));
    const partnerFirst = startCli({
      args: ["exchange", "input.csv", "out/"],
      cwd: workspace.partnerDir,
      timeoutMs: CLI_DEADLINE_MS,
    });
    await awaitJobSucceeded(manager, id, JOB_DEADLINE_MS);
    expectCliSucceeded(await partnerFirst, "exchange");

    const handoff = manager.getJobHandoff(id);
    if (handoff?.template.kind !== "config")
      throw new Error("the run composed no configuration template");
    expect(handoff.bindPaths).toEqual([
      { path: HANDOFF_SHARED_DIRECTORY_PLACEHOLDER, readOnly: false },
    ]);

    // The operator's part: save alcove.yaml with the shared folder set, copy
    // the key file the run rotated, and put the input in the folder.
    writeFileSync(
      path.join(workspace.scheduleDir, "alcove.yaml"),
      handoff.template.yaml.replaceAll(
        HANDOFF_SHARED_DIRECTORY_PLACEHOLDER,
        workspace.dropDir,
      ),
    );
    copyFileSync(
      path.join(workspace.mount, ".alcove.key"),
      path.join(workspace.scheduleDir, ".alcove.key"),
    );
    chmodSync(path.join(workspace.scheduleDir, ".alcove.key"), 0o600);
    expect(handoff.template.argv).toContain(`./${CONSOLE_INPUT_NAME}`);
    expect(handoffInputName(handoff.template.argv)).toBe(CONSOLE_INPUT_NAME);
    copyFileSync(
      path.join(workspace.mount, CONSOLE_INPUT_NAME),
      path.join(workspace.scheduleDir, CONSOLE_INPUT_NAME),
    );
    const installedAlcove = path.join(workspace.root, "alcove");
    writeFileSync(
      installedAlcove,
      `#!/bin/sh\nexec '${process.execPath}' '${cliEntry}' "$@"\n`,
    );
    chmodSync(installedAlcove, 0o755);

    const source: ScheduledRunSource = {
      argv: handoff.template.argv,
      bindPaths: handoff.bindPaths,
      image: "ghcr.io/georgetown-mdi/alcove:latest",
    };
    const handedOffLine = installedCronLine(source);
    expect(handedOffLine).not.toContain("$(");
    expect(handedOffLine).not.toContain("%");
    const line = handedOffLine
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

    // The result is named with its record's stamp, and the record verifies
    // against it and the input the run read.
    const scheduledFiles = readdirSync(workspace.scheduleDir);
    const results = scheduledFiles.filter((name) =>
      /^alcove-results-.+\.csv$/.test(name),
    );
    expect(results).toHaveLength(1);
    expect(
      pairsFromResultCsv(path.join(workspace.scheduleDir, results[0])),
    ).toEqual(CONSOLE_PAIRS);
    const record = results[0]
      .replace(/^alcove-results-/, "alcove-record-")
      .replace(/\.csv$/, ".json");
    expect(scheduledFiles).toContain(record);
    const verified = await startCli({
      args: ["verify-receipt", record, `./${CONSOLE_INPUT_NAME}`, results[0]],
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
      `type=bind,src=${HANDOFF_SHARED_DIRECTORY_PLACEHOLDER},` +
        `dst=${HANDOFF_SHARED_DIRECTORY_PLACEHOLDER}`,
    ]);
    expect(dockerArgv?.slice(8)).toEqual(handoff.template.argv.slice(1));
    expect(dockerCronLine(source)).toMatch(/ \.\/$/);
  });
});
