import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { getDefaultLinkageTerms, snakeizeKeys } from "@alcove/core";

import {
  JOB_FILE_NAMES,
  SIGNING_IDENTITY_FILE_NAME,
} from "@jobContract/intentSchemas";
import {
  JobManager,
  MountedSigningIdentityMismatchError,
  OpenedConfigurationNotRunnableError,
  SignalingServerChangedError,
  SignalingServerUnavailableError,
} from "@jobs/jobManager";
import { ConfigurationHandBackRefusedError } from "@jobs/configHandBack";
import { HANDOFF_SIGNING_IDENTITY_PLACEHOLDER } from "@jobContract/handoffBindPaths";
import { WorkingFolderFilesRefusedError } from "@jobs/workingFolderExchangeFiles";
import { partnerCertificatePinnedNotice } from "@jobs/partnerPinNotice";
import { signingIdentityPath } from "@jobs/signingIdentity";

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

// A console WebRTC run writes its alcove.yaml and .alcove.key into the working
// folder when it starts and runs the CLI on them, which rotates the key in
// place. A retry runs over them only while their bytes are the ones this
// console recorded.

const OTHER_SECRET = "B".repeat(42) + "A";
const ORIGINAL_KEY = JSON.stringify({ sharedSecret: VALID_SHARED_SECRET });
const ROTATED_KEY = JSON.stringify({ sharedSecret: "C".repeat(42) + "A" });
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
  dataRoot = scratchDir("webrtc-folder"),
): Promise<{ manager: JobManager; dataRoot: string }> {
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

function configPathIn(dataRoot: string): string {
  return path.join(dataRoot, JOB_FILE_NAMES.config);
}

function keyPathIn(dataRoot: string): string {
  return path.join(dataRoot, JOB_FILE_NAMES.key);
}

function exchangeFilesIn(dataRoot: string): Array<string> {
  return fs
    .readdirSync(dataRoot)
    .filter(
      (name) => name === JOB_FILE_NAMES.config || name === JOB_FILE_NAMES.key,
    )
    .sort();
}

const BOTH_FILES = [JOB_FILE_NAMES.config, JOB_FILE_NAMES.key].sort();

function argvFlag(argvFile: string, flag: string): string {
  const argv = JSON.parse(fs.readFileSync(argvFile, "utf8")) as Array<string>;
  return argv[argv.indexOf(flag) + 1];
}

async function refusalOf(
  manager: JobManager,
  sharedSecret = VALID_SHARED_SECRET,
): Promise<unknown> {
  return manager
    .createJob(validWebrtcIntent({ sharedSecret }))
    .catch((error: unknown) => error);
}

describe("when the run starts", () => {
  test("the pair is written owner-only into the working folder and the CLI runs on it", async () => {
    const argvFile = path.join(scratchDir("webrtc-argv"), "argv.json");
    const { manager, dataRoot } = await managerFor({
      STUB_ARGV_FILE: argvFile,
      STUB_FD3_EVENTS: JSON.stringify([]),
    });
    const id = await manager.createJob(validWebrtcIntent());
    await exited(manager, id);
    expect(fs.readFileSync(keyPathIn(dataRoot), "utf8")).toBe(ORIGINAL_KEY);
    for (const file of [configPathIn(dataRoot), keyPathIn(dataRoot)])
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(argvFlag(argvFile, "--config-file")).toBe(configPathIn(dataRoot));
    expect(argvFlag(argvFile, "--key-file")).toBe(keyPathIn(dataRoot));
    expect(fs.readdirSync(path.join(dataRoot, id))).not.toContain(
      JOB_FILE_NAMES.key,
    );
  });

  test.each([JOB_FILE_NAMES.config, JOB_FILE_NAMES.key])(
    "a file or a link already at %s refuses the run and nothing is written",
    async (name) => {
      const { manager, dataRoot } = await managerFor({
        STUB_FD3_EVENTS: JSON.stringify([]),
      });
      const outside = scratchDir("webrtc-outside");
      const live = path.join(outside, "live");
      fs.writeFileSync(live, "the operator's file\n");
      const plant: Array<(at: string) => void> = [
        (at) => fs.writeFileSync(at, "another exchange's file\n"),
        (at) => fs.symlinkSync(live, at),
        (at) => fs.symlinkSync(path.join(outside, "dangling"), at),
      ];
      for (const planted of plant) {
        planted(path.join(dataRoot, name));
        const refusal = await refusalOf(manager);
        expect(refusal).toBeInstanceOf(WorkingFolderFilesRefusedError);
        expect(refusal).toMatchObject({
          fault: "present",
          heldByConsoleExchange: false,
        });
        expect(fs.readdirSync(dataRoot)).toEqual([name]);
        expect(manager.occupiedSlotId()).toBeNull();
        fs.rmSync(path.join(dataRoot, name));
      }
      expect(fs.readFileSync(live, "utf8")).toBe("the operator's file\n");
      expect(fs.readdirSync(outside)).toEqual(["live"]);
    },
  );
});

describe("before the handshake", () => {
  test("a failed run leaves its pair, and discarding it removes the unchanged pair", async () => {
    const { manager, dataRoot } = await managerFor({
      STUB_FD3_EVENTS: JSON.stringify([DROPPED]),
      STUB_EXIT_CODE: "69",
    });
    const id = await manager.createJob(validWebrtcIntent());
    await exited(manager, id);
    expect(exchangeFilesIn(dataRoot)).toEqual(BOTH_FILES);

    await discard(manager, id);
    expect(fs.readdirSync(dataRoot)).toEqual([]);
    const fresh = await manager.createJob(
      validWebrtcIntent({ sharedSecret: OTHER_SECRET }),
    );
    await exited(manager, fresh);
    expect(exchangeFilesIn(dataRoot)).toEqual(BOTH_FILES);
  });

  test("a run discarded while it waits removes its unchanged pair once it has stopped", async () => {
    const { manager, dataRoot } = await managerFor({
      STUB_FD3_EVENTS: JSON.stringify([]),
      STUB_DELAY_MS: "5000",
    });
    const id = await manager.createJob(validWebrtcIntent());
    await discard(manager, id);
    expect(fs.readdirSync(dataRoot)).toEqual([]);
  });

  test("discarding leaves a pair whose bytes changed since the run wrote it", async () => {
    const { manager, dataRoot } = await managerFor({
      STUB_FD3_EVENTS: JSON.stringify([DROPPED]),
      STUB_EXIT_CODE: "69",
    });
    const id = await manager.createJob(validWebrtcIntent());
    await exited(manager, id);
    fs.appendFileSync(configPathIn(dataRoot), "# the operator's note\n");
    const config = fs.readFileSync(configPathIn(dataRoot), "utf8");

    await discard(manager, id);
    expect(exchangeFilesIn(dataRoot)).toEqual(BOTH_FILES);
    expect(fs.readFileSync(configPathIn(dataRoot), "utf8")).toBe(config);
    expect(fs.readFileSync(keyPathIn(dataRoot), "utf8")).toBe(ORIGINAL_KEY);
  });

  test("a retry runs over the pair the run changed without rotating the key", async () => {
    const argvFile = path.join(scratchDir("webrtc-argv"), "argv.json");
    const { manager, dataRoot } = await managerFor({
      STUB_PARTNER_PIN: ADOPTED_FINGERPRINT,
      STUB_ARGV_FILE: argvFile,
      STUB_FD3_EVENTS: JSON.stringify([DROPPED]),
      STUB_EXIT_CODE: "69",
    });
    const first = await manager.createJob(validWebrtcIntent());
    await exited(manager, first);
    await discard(manager, first);
    expect(exchangeFilesIn(dataRoot)).toEqual(BOTH_FILES);

    const retry = await manager.createJob(validWebrtcIntent());
    await exited(manager, retry);
    expect(argvFlag(argvFile, "--config-file")).toBe(configPathIn(dataRoot));
    expect(argvFlag(argvFile, "--key-file")).toBe(keyPathIn(dataRoot));
    expect(fs.readFileSync(keyPathIn(dataRoot), "utf8")).toBe(ORIGINAL_KEY);
  });
});

describe("after the handshake", () => {
  const rotatingRun = {
    STUB_KEY_FILE: ROTATED_KEY,
    STUB_FD3_EVENTS: JSON.stringify([HANDSHAKE, DROPPED]),
    STUB_EXIT_CODE: "69",
  };

  /** A manager whose first run rotated the key and failed, then was
   * discarded. */
  async function afterRotatedRun(
    childEnv: Record<string, string> = {},
  ): Promise<{ manager: JobManager; dataRoot: string }> {
    const prepared = await managerFor({ ...rotatingRun, ...childEnv });
    const first = await prepared.manager.createJob(validWebrtcIntent());
    await exited(prepared.manager, first);
    await discard(prepared.manager, first);
    return prepared;
  }

  test("discarding the run leaves the rotated pair", async () => {
    const { dataRoot } = await afterRotatedRun();
    expect(exchangeFilesIn(dataRoot)).toEqual(BOTH_FILES);
    expect(fs.readFileSync(keyPathIn(dataRoot), "utf8")).toBe(ROTATED_KEY);
  });

  test("each retry of the same invitation runs over the pair as the last run left it", async () => {
    const argvFile = path.join(scratchDir("webrtc-argv"), "argv.json");
    const { manager, dataRoot } = await afterRotatedRun({
      STUB_ARGV_FILE: argvFile,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      fs.rmSync(argvFile, { force: true });
      const retry = await manager.createJob(validWebrtcIntent());
      await exited(manager, retry);
      expect(argvFlag(argvFile, "--config-file")).toBe(configPathIn(dataRoot));
      expect(argvFlag(argvFile, "--key-file")).toBe(keyPathIn(dataRoot));
      expect(fs.readdirSync(path.join(dataRoot, retry))).not.toContain(
        JOB_FILE_NAMES.key,
      );
      await discard(manager, retry);
      expect(fs.readFileSync(keyPathIn(dataRoot), "utf8")).toBe(ROTATED_KEY);
    }
  });

  test("a fresh invitation is refused while the folder holds the pair, naming the console's exchange", async () => {
    const { manager, dataRoot } = await afterRotatedRun();
    const refusal = await refusalOf(manager, OTHER_SECRET);
    expect(refusal).toBeInstanceOf(WorkingFolderFilesRefusedError);
    expect(refusal).toMatchObject({
      fault: "present",
      heldByConsoleExchange: true,
    });
    expect(manager.occupiedSlotId()).toBeNull();

    // Moving the pair out of the folder lets the new exchange start.
    for (const name of exchangeFilesIn(dataRoot))
      fs.rmSync(path.join(dataRoot, name));
    const fresh = await manager.createJob(
      validWebrtcIntent({ sharedSecret: OTHER_SECRET }),
    );
    await exited(manager, fresh);
  });

  test.each([
    ["both files", true, true],
    ["the key file", false, true],
    ["the configuration", true, false],
  ])(
    "a retry over a pair with %s swapped in is refused, and the files keep their bytes",
    async (_, swapConfig, swapKey) => {
      const { manager, dataRoot } = await afterRotatedRun();
      // The operator moved the pair out and put another exchange's in its place.
      const otherConfig = "connection:\n  channel: filedrop\n";
      const otherKey = JSON.stringify({ sharedSecret: "D".repeat(42) + "A" });
      if (swapConfig) {
        fs.rmSync(configPathIn(dataRoot));
        fs.writeFileSync(configPathIn(dataRoot), otherConfig);
      }
      if (swapKey) {
        fs.rmSync(keyPathIn(dataRoot));
        fs.writeFileSync(keyPathIn(dataRoot), otherKey);
      }
      const config = fs.readFileSync(configPathIn(dataRoot), "utf8");
      const key = fs.readFileSync(keyPathIn(dataRoot), "utf8");

      const refusal = await refusalOf(manager);
      expect(refusal).toBeInstanceOf(WorkingFolderFilesRefusedError);
      expect(refusal).toMatchObject({
        fault: "present",
        heldByConsoleExchange: false,
      });
      expect(manager.occupiedSlotId()).toBeNull();
      expect(fs.readFileSync(configPathIn(dataRoot), "utf8")).toBe(config);
      expect(fs.readFileSync(keyPathIn(dataRoot), "utf8")).toBe(key);
    },
  );

  test("a retry after the console restarts is refused", async () => {
    const { dataRoot } = await afterRotatedRun();
    const { manager: restarted } = await managerFor(rotatingRun, dataRoot);
    const refusal = await refusalOf(restarted);
    expect(refusal).toMatchObject({
      fault: "present",
      heldByConsoleExchange: false,
    });
    expect(fs.readFileSync(keyPathIn(dataRoot), "utf8")).toBe(ROTATED_KEY);
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
    expect(fs.readFileSync(configPathIn(dataRoot), "utf8")).toContain(
      ADOPTED_FINGERPRINT,
    );
  });

  test("a certificate-mode run's hand-off runs the working folder's alcove.yaml, which holds the pin, and offers no template without it", async () => {
    const { manager, dataRoot } = await managerFor({
      STUB_KEY_FILE: ROTATED_KEY,
      STUB_PARTNER_PIN: ADOPTED_FINGERPRINT,
      STUB_FD3_EVENTS: JSON.stringify([HANDSHAKE, RESULT]),
    });
    const id = await manager.createJob(
      validWebrtcIntent({ signing: { mode: "certificate" } }),
    );
    await exited(manager, id);
    expect(fs.readFileSync(configPathIn(dataRoot), "utf8")).toContain(
      ADOPTED_FINGERPRINT,
    );
    const handoff = manager.getJobHandoff(id);
    expect(handoff?.template).toEqual({
      kind: "workingFolder",
      argv: [
        "alcove",
        "exchange",
        "--log-file=exchange.log",
        "input.csv",
        "./",
      ],
    });
    expect(handoff?.keyFileBesideConfiguration).toBe(true);
    expect(handoff?.usedSigningIdentity).toBe(true);
    expect(JSON.stringify(handoff)).not.toContain("partner_fingerprint");
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
    expect(fs.readdirSync(dataRoot)).toEqual([]);
  });
});

describe("a run of the webrtc configuration the operator opened", () => {
  /** The operator's own alcove.yaml, as the command line wrote it, over the
   * server the console holds unless `server` names another. */
  function operatorConfiguration(
    connection: Record<string, unknown> = {},
    settings: Record<string, unknown> = {},
  ): string {
    return stringifyYaml({
      connection: {
        channel: "webrtc",
        role: "acceptor",
        server: { host: "peers.test", path: "/psi/" },
        ...connection,
      },
      linkage_terms: snakeizeKeys(getDefaultLinkageTerms("County Health")),
      ...settings,
    });
  }

  /** A manager over a folder holding the operator's pair, opened. */
  async function opened(
    childEnv: Record<string, string>,
    connection: Record<string, unknown> = {},
    settings: Record<string, unknown> = {},
    dataRoot?: string,
  ): Promise<{ manager: JobManager; dataRoot: string }> {
    const prepared = await managerFor(childEnv, dataRoot);
    fs.writeFileSync(
      configPathIn(prepared.dataRoot),
      operatorConfiguration(connection, settings),
    );
    fs.writeFileSync(keyPathIn(prepared.dataRoot), ORIGINAL_KEY);
    prepared.manager.openMountedConfiguration();
    return prepared;
  }

  const openedRun = validWebrtcIntent({
    sharedSecret: undefined,
    mountedConfigurationOpened: true,
  });

  test("runs the folder's own files in place, and discarding it leaves both", async () => {
    const argvFile = path.join(scratchDir("webrtc-argv"), "argv.json");
    const { manager, dataRoot } = await opened({
      STUB_ARGV_FILE: argvFile,
      STUB_FD3_EVENTS: JSON.stringify([DROPPED]),
      STUB_EXIT_CODE: "69",
    });
    const before = fs.readFileSync(configPathIn(dataRoot), "utf8");
    const id = await manager.createJob(openedRun);
    await exited(manager, id);
    expect(argvFlag(argvFile, "--config-file")).toBe(configPathIn(dataRoot));
    expect(argvFlag(argvFile, "--key-file")).toBe(keyPathIn(dataRoot));
    await discard(manager, id);
    expect(fs.readFileSync(configPathIn(dataRoot), "utf8")).toBe(before);
    expect(fs.readFileSync(keyPathIn(dataRoot), "utf8")).toBe(ORIGINAL_KEY);
    const retry = await manager.createJob(openedRun);
    await exited(manager, retry);
  });

  test("runs a file naming another coordination server than the console's, naming none itself", async () => {
    const argvFile = path.join(scratchDir("webrtc-argv"), "argv.json");
    const { manager, dataRoot } = await opened(
      {
        STUB_ARGV_FILE: argvFile,
        STUB_FD3_EVENTS: JSON.stringify([DROPPED]),
        STUB_EXIT_CODE: "69",
      },
      { server: { host: "Elsewhere.Test", secure: false } },
    );
    manager.clearAuthoredSignalingServer();
    const id = await manager.createJob(
      validWebrtcIntent({
        sharedSecret: undefined,
        mountedConfigurationOpened: true,
        signalingServer: undefined,
      }),
    );
    await exited(manager, id);
    expect(argvFlag(argvFile, "--config-file")).toBe(configPathIn(dataRoot));
  });

  test("is refused over a file stating a relay, with nothing written", async () => {
    const { manager, dataRoot } = await opened(
      {},
      { turn: [{ url: "turns:relay.example.org:5349" }] },
    );
    const before = fs.readFileSync(configPathIn(dataRoot), "utf8");
    await expect(manager.createJob(openedRun)).rejects.toBeInstanceOf(
      OpenedConfigurationNotRunnableError,
    );
    expect(fs.readFileSync(configPathIn(dataRoot), "utf8")).toBe(before);
    expect(manager.occupiedSlotId()).toBeNull();
  });

  test("is refused once the file is gone", async () => {
    const { manager, dataRoot } = await opened({});
    fs.rmSync(configPathIn(dataRoot));
    await expect(manager.createJob(openedRun)).rejects.toBeInstanceOf(
      OpenedConfigurationNotRunnableError,
    );
  });

  describe("signed with a certificate", () => {
    const signedRun = validWebrtcIntent({
      sharedSecret: undefined,
      mountedConfigurationOpened: true,
      signing: { mode: "certificate" },
    });

    function signedBy(identityFile: string): Record<string, unknown> {
      return { signing: { mode: "certificate", identity_file: identityFile } };
    }

    test("is refused, converted or not, over a file signing with another identity than the console's", async () => {
      const { manager, dataRoot } = await opened(
        {},
        {},
        signedBy("/home/operator/.alcove/identity.json"),
      );
      const before = fs.readFileSync(configPathIn(dataRoot), "utf8");
      for (const intent of [
        signedRun,
        { ...signedRun, mountedConfigurationConverted: true },
      ])
        await expect(manager.createJob(intent)).rejects.toBeInstanceOf(
          MountedSigningIdentityMismatchError,
        );
      expect(fs.readFileSync(configPathIn(dataRoot), "utf8")).toBe(before);
      expect(manager.occupiedSlotId()).toBeNull();
    });

    test("is refused over a file naming the console's identity file by a relative path", async () => {
      const { manager } = await opened(
        {},
        {},
        signedBy(SIGNING_IDENTITY_FILE_NAME),
      );
      await expect(manager.createJob(signedRun)).rejects.toBeInstanceOf(
        MountedSigningIdentityMismatchError,
      );
    });

    test("runs a file signing with the console's own identity", async () => {
      const argvFile = path.join(scratchDir("webrtc-argv"), "argv.json");
      const dataRoot = scratchDir("webrtc-folder");
      const { manager } = await opened(
        {
          STUB_ARGV_FILE: argvFile,
          STUB_FD3_EVENTS: JSON.stringify([DROPPED]),
          STUB_EXIT_CODE: "69",
        },
        {},
        signedBy(signingIdentityPath(dataRoot)),
        dataRoot,
      );
      const id = await manager.createJob(signedRun);
      await exited(manager, id);
      expect(argvFlag(argvFile, "--config-file")).toBe(configPathIn(dataRoot));
    });

    /** The hand-back a Start with the signed receipt on sends. */
    const signedSave = {
      linkageTerms: getDefaultLinkageTerms("County Health"),
      signing: { mode: "certificate" as const },
    };

    function identityFileIn(dataRoot: string): unknown {
      const document = parseYaml(
        fs.readFileSync(configPathIn(dataRoot), "utf8"),
      ) as { signing?: { identity_file?: unknown } };
      return document.signing?.identity_file;
    }

    test.each([
      ["names no signing block", {}],
      ["names no identity file", { signing: { mode: "none" } }],
      [
        "names the hand-off's placeholder",
        {
          signing: {
            mode: "certificate",
            identity_file: HANDOFF_SIGNING_IDENTITY_PLACEHOLDER,
          },
        },
      ],
    ])(
      "a signed start over a file that %s writes the console's identity, and runs",
      async (_label, settings) => {
        const { manager, dataRoot } = await opened(
          {
            STUB_FD3_EVENTS: JSON.stringify([DROPPED]),
            STUB_EXIT_CODE: "69",
          },
          {},
          settings,
        );
        expect(manager.handBackOpenedConfiguration(signedSave)).toEqual({
          written: true,
        });
        expect(identityFileIn(dataRoot)).toBe(signingIdentityPath(dataRoot));
        const id = await manager.createJob(signedRun);
        await exited(manager, id);
      },
    );

    test("a signed start writes the secrets-mount identity the card holds", async () => {
      const dataRoot = scratchDir("webrtc-folder");
      const secretsDir = scratchDir("webrtc-secrets");
      fs.writeFileSync(path.join(secretsDir, "identity.json"), "{}\n");
      const manager = new JobManager({
        dataRoot,
        jobSecretsDir: secretsDir,
        binaryPath: STUB_CLI_PATH,
        childEnv: {
          STUB_FD3_EVENTS: JSON.stringify([DROPPED]),
          STUB_EXIT_CODE: "69",
        },
      });
      managers.push(manager);
      fs.writeFileSync(configPathIn(dataRoot), operatorConfiguration());
      fs.writeFileSync(keyPathIn(dataRoot), ORIGINAL_KEY);
      manager.openMountedConfiguration();
      const identityLocation = {
        mount: "secrets" as const,
        subPath: ["identity.json"],
      };
      manager.handBackOpenedConfiguration({
        ...signedSave,
        signing: { mode: "certificate", identityLocation },
      });
      expect(identityFileIn(dataRoot)).toBe(
        fs.realpathSync(path.join(secretsDir, "identity.json")),
      );
      const id = await manager.createJob({
        ...signedRun,
        signing: { mode: "certificate", identityLocation },
      });
      await exited(manager, id);
    });

    test("a signed start keeps the identity file a file names", async () => {
      const { manager, dataRoot } = await opened(
        {},
        {},
        { csv_delimiter: ";", ...signedBy("/home/operator/identity.json") },
      );
      manager.handBackOpenedConfiguration(signedSave);
      expect(identityFileIn(dataRoot)).toBe("/home/operator/identity.json");
    });

    test("runs unsigned over a file signing with another identity", async () => {
      const { manager } = await opened(
        {
          STUB_FD3_EVENTS: JSON.stringify([DROPPED]),
          STUB_EXIT_CODE: "69",
        },
        {},
        signedBy("/home/operator/.alcove/identity.json"),
      );
      const id = await manager.createJob({
        ...signedRun,
        signing: { mode: "none" },
      });
      await exited(manager, id);
    });
  });

  test("a partner terms change it stops on is applied to the file it ran", async () => {
    const { manager, dataRoot } = await opened({
      STUB_EXIT_CODE: "64",
      STUB_TERMS_PROPOSAL: "proposal",
      STUB_FD3_EVENTS: JSON.stringify([
        {
          v: 1,
          type: "error",
          category: "config",
          message: "this run is not attended.",
          termsChange: { proposalWritten: true, otherTerms: [] },
        },
      ]),
    });
    const id = await manager.createJob(openedRun);
    const record = await exited(manager, id);
    expect(record.termsProposal).toBe("available");
    expect(fs.existsSync(path.join(dataRoot, "alcove.proposed-terms"))).toBe(
      true,
    );
    const before = fs.readFileSync(configPathIn(dataRoot), "utf8");
    expect(await manager.applyTermsProposal(id)).toEqual({ kind: "applied" });
    expect(fs.readFileSync(configPathIn(dataRoot), "utf8")).not.toBe(before);
  });

  test("a save is refused while the run uses the file, and after it recorded a pin there", async () => {
    const { manager, dataRoot } = await opened({
      STUB_PARTNER_PIN: ADOPTED_FINGERPRINT,
      STUB_DELAY_MS: "300",
      STUB_FD3_EVENTS: JSON.stringify([HANDSHAKE, RESULT]),
    });
    const handBack = {
      linkageTerms: getDefaultLinkageTerms("County Health"),
      signing: { mode: "certificate" as const },
    };
    const id = await manager.createJob(openedRun);
    expect(() => manager.handBackOpenedConfiguration(handBack)).toThrow(
      ConfigurationHandBackRefusedError,
    );
    expect(() => manager.handBackOpenedConfiguration(handBack)).toThrow(
      /An exchange is running/,
    );
    await exited(manager, id);
    const pinned = fs.readFileSync(configPathIn(dataRoot), "utf8");
    expect(pinned).toContain(ADOPTED_FINGERPRINT);
    let refusal: unknown;
    try {
      manager.handBackOpenedConfiguration(handBack);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ConfigurationHandBackRefusedError);
    expect((refusal as ConfigurationHandBackRefusedError).message).toMatch(
      /changed since you opened it/,
    );
    expect((refusal as ConfigurationHandBackRefusedError).reason).toBe(
      "configuration-changed",
    );
    expect(fs.readFileSync(configPathIn(dataRoot), "utf8")).toBe(pinned);
  });

  test("opened again after a run recorded a pin, the next start saves nothing and runs", async () => {
    const { manager, dataRoot } = await opened(
      {
        STUB_PARTNER_PIN: ADOPTED_FINGERPRINT,
        STUB_FD3_EVENTS: JSON.stringify([HANDSHAKE, RESULT]),
      },
      {},
      {
        signing: {
          mode: "certificate",
          identity_file: "/home/county/.alcove/identity.json",
        },
      },
    );
    const first = await manager.createJob(openedRun);
    await exited(manager, first);
    await discard(manager, first);
    const pinned = fs.readFileSync(configPathIn(dataRoot), "utf8");
    manager.openMountedConfiguration();
    expect(
      manager.handBackOpenedConfiguration({
        linkageTerms: getDefaultLinkageTerms("County Health"),
        signing: {
          mode: "certificate",
          partnerFingerprint: ADOPTED_FINGERPRINT,
        },
      }),
    ).toEqual({ written: false });
    expect(fs.readFileSync(configPathIn(dataRoot), "utf8")).toBe(pinned);
    const second = await manager.createJob(openedRun);
    await exited(manager, second);
  });

  test("a start that changes nothing leaves the operator's file and makes no copy", async () => {
    const { manager, dataRoot } = await opened({});
    const before = fs.readFileSync(configPathIn(dataRoot), "utf8");
    expect(
      manager.handBackOpenedConfiguration({
        linkageTerms: getDefaultLinkageTerms("County Health"),
        signing: { mode: "none" },
      }),
    ).toEqual({ written: false });
    expect(fs.readFileSync(configPathIn(dataRoot), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(dataRoot, "alcove.yaml.previous"))).toBe(
      false,
    );
  });

  test("the copy keeps the operator's own file across the console's later saves", async () => {
    const { manager, dataRoot } = await opened({});
    const original = fs.readFileSync(configPathIn(dataRoot), "utf8");
    const previous = (): string =>
      fs.readFileSync(path.join(dataRoot, "alcove.yaml.previous"), "utf8");
    for (const csvDelimiter of [";", "|"])
      expect(
        manager.handBackOpenedConfiguration({
          linkageTerms: getDefaultLinkageTerms("County Health"),
          csvDelimiter,
          signing: { mode: "none" },
        }),
      ).toEqual({ written: true });
    expect(previous()).toBe(original);
    fs.appendFileSync(configPathIn(dataRoot), "# edited by hand\n");
    const edited = fs.readFileSync(configPathIn(dataRoot), "utf8");
    manager.openMountedConfiguration();
    manager.handBackOpenedConfiguration({
      linkageTerms: getDefaultLinkageTerms("County Health"),
      csvDelimiter: "\t",
      signing: { mode: "none" },
    });
    expect(previous()).toBe(edited);
  });
});
