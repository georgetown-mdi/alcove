import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  JobManager,
  SignalingServerChangedError,
  SignalingServerUnavailableError,
  WORKING_FOLDER_FILE_APPEARED_FAILURE,
} from "@jobs/jobManager";
import { JOB_FILE_NAMES } from "@jobContract/intentSchemas";
import { WorkingFolderFilesRefusedError } from "@jobs/workingFolderExchangeFiles";
import { partnerCertificatePinnedNotice } from "@jobs/partnerPinNotice";

import {
  STUB_CLI_PATH,
  STUB_CONFIG_FILE_TOKEN,
  TEST_SIGNALING_ADDRESS,
  TEST_SIGNALING_SERVER,
  VALID_SHARED_SECRET,
  trackScratchDirs,
  validWebrtcIntent,
} from "../../utils/jobFixtures";

import type { JobRecord } from "@jobs/jobManager";

// Where a console WebRTC run keeps its alcove.yaml and .alcove.key: in its own
// run folder until the handshake, then in the working folder, where alcove
// invite writes them, so a run that never reached its partner leaves the
// working folder as it found it.

const OTHER_SECRET = "B".repeat(42) + "A";
const ROTATED_KEY = JSON.stringify({ sharedSecret: "C".repeat(42) + "A" });
const LATER_KEY = JSON.stringify({ sharedSecret: "D".repeat(42) + "A" });
const ADOPTED_FINGERPRINT = "E".repeat(42) + "A";

const HANDSHAKE = {
  v: 1,
  type: "stage",
  id: "confirming protocol",
  label: "Confirming protocol",
};
const DROPPED = {
  v: 1,
  type: "error",
  category: "exchange",
  message: "the connection to the partner dropped",
};
const RESULT = { v: 1, type: "result", resultWritten: true };

const { scratchDir, cleanup } = trackScratchDirs();
const managers: Array<JobManager> = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.shutdown();
  cleanup();
});

async function managerFor(
  childEnv: Record<string, string>,
  label = "webrtc-folder",
): Promise<{ manager: JobManager; dataRoot: string }> {
  const dataRoot = scratchDir(label);
  const manager = new JobManager({
    dataRoot,
    binaryPath: STUB_CLI_PATH,
    childEnv,
  });
  managers.push(manager);
  await manager.authorSignalingServer({ address: TEST_SIGNALING_ADDRESS });
  return { manager, dataRoot };
}

/** The record of job `id` once its child has exited. */
async function exited(manager: JobManager, id: string): Promise<JobRecord> {
  await vi.waitFor(() => expect(manager.getJob(id)?.terminal).not.toBeNull(), {
    timeout: 20_000,
  });
  return manager.getJob(id)!;
}

async function discard(manager: JobManager, id: string): Promise<void> {
  await manager.deleteJob(id);
  await vi.waitFor(() => expect(manager.occupiedSlotId()).toBeNull(), {
    timeout: 20_000,
  });
}

function folderFile(dataRoot: string, name: string): string {
  return path.join(dataRoot, name);
}

function exchangeFilesIn(dataRoot: string): Array<string> {
  return fs
    .readdirSync(dataRoot)
    .filter(
      (name) => name === JOB_FILE_NAMES.config || name === JOB_FILE_NAMES.key,
    );
}

describe("before the handshake", () => {
  test("a failed run leaves nothing in the working folder, and a fresh invitation starts", async () => {
    const { manager, dataRoot } = await managerFor({
      STUB_FD3_EVENTS: JSON.stringify([DROPPED]),
      STUB_EXIT_CODE: "69",
    });
    const id = await manager.createJob(validWebrtcIntent());
    const record = await exited(manager, id);
    expect(exchangeFilesIn(dataRoot)).toEqual([]);
    expect(record.configPath).toBe(
      path.join(dataRoot, id, JOB_FILE_NAMES.config),
    );
    expect(record.workingFolderPair?.written).toBe(false);

    await discard(manager, id);
    const fresh = await manager.createJob(
      validWebrtcIntent({ sharedSecret: OTHER_SECRET }),
    );
    await exited(manager, fresh);
    expect(exchangeFilesIn(dataRoot)).toEqual([]);
  });

  test("a run discarded while it waits leaves nothing in the working folder", async () => {
    const { manager, dataRoot } = await managerFor({
      STUB_FD3_EVENTS: JSON.stringify([]),
      STUB_DELAY_MS: "5000",
    });
    const id = await manager.createJob(validWebrtcIntent());
    await discard(manager, id);
    expect(fs.readdirSync(dataRoot)).toEqual([]);
  });
});

describe("a discarded run", () => {
  test("a stage event arriving after the discard writes nothing, though the run's key rotated", async () => {
    const gate = path.join(scratchDir("webrtc-gate"), "go");
    const { manager, dataRoot } = await managerFor({
      STUB_KEY_FILE: ROTATED_KEY,
      STUB_FD3_EVENTS: JSON.stringify([]),
      STUB_READY_FILE: gate,
      STUB_DELAY_MS: "5000",
    });
    const id = await manager.createJob(validWebrtcIntent());
    await vi.waitFor(() => expect(fs.existsSync(gate)).toBe(true), {
      timeout: 20_000,
    });
    const record = manager.getJob(id)!;
    const discarded = manager.deleteJob(id);
    // The event a killed child left in the pipe, relayed after the discard
    // began and before the run's folder is gone.
    (
      manager as unknown as {
        appendEvent: (record: JobRecord, event: unknown) => void;
      }
    ).appendEvent(record, HANDSHAKE);
    await discarded;
    await vi.waitFor(() => expect(manager.occupiedSlotId()).toBeNull(), {
      timeout: 20_000,
    });
    expect(fs.readdirSync(dataRoot)).toEqual([]);
    expect(
      record.events.some(
        (entry) =>
          entry.event.type === "error" && entry.event.category === "config",
      ),
    ).toBe(false);
  });

  test("discarding a finished run leaves the working folder's files as they are now", async () => {
    const { manager, dataRoot } = await managerFor({
      STUB_KEY_FILE: ROTATED_KEY,
      STUB_FD3_EVENTS: JSON.stringify([HANDSHAKE, RESULT]),
    });
    const id = await manager.createJob(validWebrtcIntent());
    await exited(manager, id);
    // A later `alcove exchange` in the same folder rotated the secret again.
    const keyPath = folderFile(dataRoot, JOB_FILE_NAMES.key);
    const configPath = folderFile(dataRoot, JOB_FILE_NAMES.config);
    fs.writeFileSync(keyPath, LATER_KEY);
    fs.writeFileSync(configPath, "graduated: true\n");

    await discard(manager, id);
    expect(fs.readFileSync(keyPath, "utf8")).toBe(LATER_KEY);
    expect(fs.readFileSync(configPath, "utf8")).toBe("graduated: true\n");
  });
});

describe("at the handshake", () => {
  test("the run's pair, rotated secret included, is written into the working folder owner-only", async () => {
    const { manager, dataRoot } = await managerFor({
      STUB_KEY_FILE: ROTATED_KEY,
      STUB_FD3_EVENTS: JSON.stringify([HANDSHAKE, RESULT]),
    });
    const id = await manager.createJob(validWebrtcIntent());
    const record = await exited(manager, id);
    const configPath = folderFile(dataRoot, JOB_FILE_NAMES.config);
    const keyPath = folderFile(dataRoot, JOB_FILE_NAMES.key);
    expect(fs.readFileSync(keyPath, "utf8")).toBe(ROTATED_KEY);
    expect(fs.readFileSync(configPath, "utf8")).toBe(
      fs.readFileSync(path.join(dataRoot, id, JOB_FILE_NAMES.config), "utf8"),
    );
    for (const file of [configPath, keyPath])
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(record.configPath).toBe(configPath);
    expect(record.workingFolderPair?.written).toBe(true);
  });

  test("a run that stops right after its key rotated, before any event, still saves its pair, and a retry runs over it", async () => {
    const argvFile = path.join(scratchDir("webrtc-argv"), "argv.json");
    const { manager, dataRoot } = await managerFor({
      STUB_KEY_FILE: ROTATED_KEY,
      STUB_ARGV_FILE: argvFile,
      STUB_FD3_EVENTS: JSON.stringify([]),
      STUB_EXIT_CODE: "69",
    });
    const first = await manager.createJob(validWebrtcIntent());
    const record = await exited(manager, first);
    const configPath = folderFile(dataRoot, JOB_FILE_NAMES.config);
    const keyPath = folderFile(dataRoot, JOB_FILE_NAMES.key);
    expect(fs.readFileSync(keyPath, "utf8")).toBe(ROTATED_KEY);
    expect(record.workingFolderPair?.written).toBe(true);
    expect(record.status).toBe("failed");
    await discard(manager, first);

    const retry = await manager.createJob(validWebrtcIntent());
    await exited(manager, retry);
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8")) as Array<string>;
    expect(argv[argv.indexOf("--config-file") + 1]).toBe(configPath);
    expect(argv[argv.indexOf("--key-file") + 1]).toBe(keyPath);
  });

  test("a later write by the CLI reaches the working folder's copy", async () => {
    const { manager, dataRoot } = await managerFor({
      STUB_KEY_FILE: ROTATED_KEY,
      STUB_KEY_FILE_AT_EXIT: LATER_KEY,
      STUB_FD3_EVENTS: JSON.stringify([HANDSHAKE, RESULT]),
    });
    const id = await manager.createJob(validWebrtcIntent());
    await exited(manager, id);
    expect(
      fs.readFileSync(folderFile(dataRoot, JOB_FILE_NAMES.key), "utf8"),
    ).toBe(LATER_KEY);
  });

  test("a file that appeared while the run waited stops the run and is left as it is", async () => {
    const gate = path.join(scratchDir("webrtc-gate"), "go");
    const { manager, dataRoot } = await managerFor({
      STUB_WAIT_FOR_FILE: gate,
      STUB_KEY_FILE: ROTATED_KEY,
      STUB_FD3_EVENTS: JSON.stringify([HANDSHAKE, RESULT]),
      STUB_DELAY_MS: "5000",
    });
    const id = await manager.createJob(validWebrtcIntent());
    const keyPath = folderFile(dataRoot, JOB_FILE_NAMES.key);
    fs.writeFileSync(keyPath, "another exchange's key\n");
    fs.writeFileSync(gate, "");
    const record = await exited(manager, id);
    expect(fs.readFileSync(keyPath, "utf8")).toBe("another exchange's key\n");
    expect(exchangeFilesIn(dataRoot)).toEqual([JOB_FILE_NAMES.key]);
    const failures = record.events
      .map((entry) => entry.event)
      .filter((event) => event.type !== "stages");
    expect(failures).toEqual([
      {
        v: 1,
        type: "error",
        category: "config",
        message: WORKING_FOLDER_FILE_APPEARED_FAILURE,
      },
    ]);
    expect(record.status).toBe("failed");
  });
});

describe("after the handshake", () => {
  test("a retry of the same invitation runs over the working folder's pair as it stands", async () => {
    const argvFile = path.join(scratchDir("webrtc-argv"), "argv.json");
    const { manager, dataRoot } = await managerFor({
      STUB_KEY_FILE: ROTATED_KEY,
      STUB_ARGV_FILE: argvFile,
      STUB_FD3_EVENTS: JSON.stringify([HANDSHAKE, DROPPED]),
      STUB_EXIT_CODE: "69",
    });
    const first = await manager.createJob(validWebrtcIntent());
    await exited(manager, first);
    await discard(manager, first);

    const retry = await manager.createJob(validWebrtcIntent());
    const record = await exited(manager, retry);
    const configPath = folderFile(dataRoot, JOB_FILE_NAMES.config);
    const keyPath = folderFile(dataRoot, JOB_FILE_NAMES.key);
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8")) as Array<string>;
    expect(argv[argv.indexOf("--config-file") + 1]).toBe(configPath);
    expect(argv[argv.indexOf("--key-file") + 1]).toBe(keyPath);
    expect(fs.readdirSync(path.join(dataRoot, retry))).not.toContain(
      JOB_FILE_NAMES.key,
    );
    expect(fs.readFileSync(keyPath, "utf8")).toBe(ROTATED_KEY);
    expect(record.configPath).toBe(configPath);
    expect(record.workingFolderPair?.written).toBe(true);
  });

  test("a fresh invitation is refused while the folder holds the pair, naming the console's exchange", async () => {
    const { manager, dataRoot } = await managerFor({
      STUB_KEY_FILE: ROTATED_KEY,
      STUB_FD3_EVENTS: JSON.stringify([HANDSHAKE, DROPPED]),
      STUB_EXIT_CODE: "69",
    });
    const first = await manager.createJob(validWebrtcIntent());
    await exited(manager, first);
    await discard(manager, first);

    const refusal = await manager
      .createJob(validWebrtcIntent({ sharedSecret: OTHER_SECRET }))
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(WorkingFolderFilesRefusedError);
    expect(refusal).toMatchObject({
      fault: "present",
      heldByConsoleExchange: true,
    });
    expect(manager.occupiedSlotId()).toBeNull();

    // Moving the pair out of the folder lets the new exchange start.
    for (const name of exchangeFilesIn(dataRoot))
      fs.rmSync(folderFile(dataRoot, name));
    const fresh = await manager.createJob(
      validWebrtcIntent({ sharedSecret: OTHER_SECRET }),
    );
    await exited(manager, fresh);
  });

  test("one file of the pair left in the folder refuses without naming the console's exchange", async () => {
    const { manager, dataRoot } = await managerFor({
      STUB_KEY_FILE: ROTATED_KEY,
      STUB_FD3_EVENTS: JSON.stringify([HANDSHAKE, DROPPED]),
      STUB_EXIT_CODE: "69",
    });
    const first = await manager.createJob(validWebrtcIntent());
    await exited(manager, first);
    await discard(manager, first);
    fs.rmSync(folderFile(dataRoot, JOB_FILE_NAMES.config));

    for (const sharedSecret of [OTHER_SECRET, VALID_SHARED_SECRET]) {
      const refusal = await manager
        .createJob(validWebrtcIntent({ sharedSecret }))
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(WorkingFolderFilesRefusedError);
      expect(refusal).toMatchObject({
        fault: "present",
        heldByConsoleExchange: false,
      });
    }
  });

  test("a pair this console did not write refuses even the same invitation", async () => {
    const { manager, dataRoot } = await managerFor({
      STUB_FD3_EVENTS: JSON.stringify([]),
    });
    fs.writeFileSync(
      folderFile(dataRoot, JOB_FILE_NAMES.key),
      JSON.stringify({ sharedSecret: VALID_SHARED_SECRET }),
    );
    fs.writeFileSync(folderFile(dataRoot, JOB_FILE_NAMES.config), "{}\n");
    const refusal = await manager
      .createJob(validWebrtcIntent())
      .catch((error: unknown) => error);
    expect(refusal).toMatchObject({
      fault: "present",
      heldByConsoleExchange: false,
    });
  });

  test("the first-contact notice reads the pin back from the working folder's alcove.yaml", async () => {
    const { manager, dataRoot } = await managerFor({
      STUB_KEY_FILE: ROTATED_KEY,
      STUB_PARTNER_PIN: ADOPTED_FINGERPRINT,
      STUB_FD3_EVENTS: JSON.stringify([
        HANDSHAKE,
        {
          v: 1,
          type: "warning",
          source: "partnerCertificatePinned",
          message: `Pinned ${ADOPTED_FINGERPRINT} in ${STUB_CONFIG_FILE_TOKEN}.`,
        },
        RESULT,
      ]),
    });
    const id = await manager.createJob(
      validWebrtcIntent({ signing: { mode: "certificate" } }),
    );
    const record = await exited(manager, id);
    const notice = record.events
      .map((entry) => entry.event)
      .find((event) => event.type === "warning");
    expect(notice?.message).toBe(
      partnerCertificatePinnedNotice(ADOPTED_FINGERPRINT, true),
    );
    expect(notice?.message).not.toContain(dataRoot);
    expect(
      fs.readFileSync(folderFile(dataRoot, JOB_FILE_NAMES.config), "utf8"),
    ).toContain(ADOPTED_FINGERPRINT);
  });
});

describe("the coordination server the invitation names", () => {
  test("a create naming another server, or none, is refused before anything is written", async () => {
    const { manager, dataRoot } = await managerFor({
      STUB_FD3_EVENTS: JSON.stringify([]),
    });
    for (const signalingServer of [
      { ...TEST_SIGNALING_SERVER, host: "elsewhere.test" },
      undefined,
    ])
      await expect(
        manager.createJob(validWebrtcIntent({ signalingServer })),
      ).rejects.toBeInstanceOf(SignalingServerChangedError);
    expect(fs.readdirSync(dataRoot)).toEqual([]);
    expect(manager.occupiedSlotId()).toBeNull();
  });

  test("a console that holds no server refuses one the invitation names as changed", async () => {
    const dataRoot = scratchDir("webrtc-no-server");
    const manager = new JobManager({ dataRoot, binaryPath: STUB_CLI_PATH });
    managers.push(manager);
    await expect(manager.createJob(validWebrtcIntent())).rejects.toBeInstanceOf(
      SignalingServerChangedError,
    );
    await expect(
      manager.createJob(validWebrtcIntent({ signalingServer: undefined })),
    ).rejects.toBeInstanceOf(SignalingServerUnavailableError);
  });
});
