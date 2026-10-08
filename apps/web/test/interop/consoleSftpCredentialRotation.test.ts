import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { JobManager } from "@jobs/jobManager";

import {
  TEST_HOST_KEY_FINGERPRINT,
  validSftpIntent,
  validZeroSetupSftpIntent,
} from "../utils/jobFixtures";
import { waitFor } from "../utils/waitFor";

import { cliEntry } from "./cliParty";

import type { JobCreateIntent } from "@jobContract/intentSchemas";
import type { JobRecord } from "@jobs/jobManager";

/**
 * The run's credential read is observed through the CLI's refusal of an empty
 * credential file at configuration load, versus a connect failure past it.
 */

// Satisfies every key of the fixture's default linkage terms, so the CLI's
// input check passes and the run reaches the connection.
const INPUT_CSV =
  "ssn,ssn4,first_name,last_name,date_of_birth\n" +
  "111223333,3333,bob,smith,1990-01-01\n";

const JOB_DEADLINE_MS = 60_000;

/** The CLI's exit for invalid caller configuration. */
const EXIT_USAGE = 64;
/** The CLI's exit for a server it could not reach. */
const EXIT_UNAVAILABLE = 69;

const MODES: Array<{
  mode: string;
  intent: () => JobCreateIntent;
}> = [
  {
    mode: "an exchange",
    intent: () =>
      validSftpIntent({
        inputCsv: INPUT_CSV,
        options: { maxReconnectAttempts: 0 },
      }),
  },
  {
    mode: "a zero-setup run",
    intent: () =>
      validZeroSetupSftpIntent({
        inputCsv: INPUT_CSV,
        options: { maxReconnectAttempts: 0 },
      }),
  },
];

let root: string;
const managers: Array<JobManager> = [];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "alcove-credential-rotation-"));
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  rmSync(root, { recursive: true, force: true });
});

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string")
    throw new Error("the probe listener reported no port");
  return address.port;
}

/** A manager with a connection authored over a credential file holding
 * `initialContent`, which lives outside the data root as the console guides. */
async function authoredManager(
  initialContent: string,
): Promise<{ manager: JobManager; credentialFile: string }> {
  const secretsDir = path.join(root, "secrets");
  mkdirSync(secretsDir);
  const credentialFile = path.join(secretsDir, "partner-password");
  writeFileSync(credentialFile, initialContent);
  const manager = new JobManager({
    dataRoot: path.join(root, "data"),
    binaryPath: cliEntry,
  });
  managers.push(manager);
  const projection = manager.authorSftpServer({
    host: "127.0.0.1",
    port: await unusedLoopbackPort(),
    username: "linkage",
    path: "/exchange",
    hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
    credential: {
      kind: "ref",
      ref: `@${credentialFile}`,
      credType: "password",
    },
  });
  expect(projection.credentialWarnings).toEqual([]);
  return { manager, credentialFile };
}

async function terminalRecord(
  manager: JobManager,
  id: string,
): Promise<JobRecord> {
  await waitFor(() => manager.getJob(id)?.terminal != null, {
    timeoutMs: JOB_DEADLINE_MS,
    intervalMs: 25,
    message: "the console run reached no terminal event",
  });
  return manager.getJob(id)!;
}

function errorMessages(record: JobRecord): Array<string> {
  return record.events.flatMap(({ event }) =>
    event.type === "error" ? [String(event.message)] : [],
  );
}

const EMPTY_CREDENTIAL_REFUSAL =
  /@-file reference .* resolved to an empty file/;

describe("a credential file rotated in place after the connection is authored", () => {
  test.each(MODES)(
    "$mode reads the emptied file and is refused at configuration load",
    async ({ intent }) => {
      const { manager, credentialFile } =
        await authoredManager("first-secret\n");
      writeFileSync(credentialFile, "\n");

      const record = await terminalRecord(
        manager,
        await manager.createJob(intent()),
      );

      expect(record.terminal?.exitCode).toBe(EXIT_USAGE);
      expect(errorMessages(record)).toEqual([
        expect.stringMatching(EMPTY_CREDENTIAL_REFUSAL),
      ]);
    },
  );

  test.each(MODES)(
    "$mode reads the filled file and goes on to dial the server",
    async ({ intent }) => {
      const { manager, credentialFile } = await authoredManager("\n");
      writeFileSync(credentialFile, "rotated-secret\n");

      const record = await terminalRecord(
        manager,
        await manager.createJob(intent()),
      );

      expect(record.terminal?.exitCode).toBe(EXIT_UNAVAILABLE);
      const messages = errorMessages(record).join("\n");
      expect(messages).toMatch(/ECONNREFUSED/);
      expect(messages).not.toMatch(EMPTY_CREDENTIAL_REFUSAL);
    },
  );
});
