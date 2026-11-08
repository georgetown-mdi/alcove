import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  ConsoleShuttingDownError,
  ExchangeBusyError,
  JobIntentUncomposableError,
  JobRendezvousRetainRequiredError,
  JobRendezvousUnavailableError,
  JobSftpCredentialConsoleOwnedError,
  JobSigningIdentityExposedError,
  MountedSigningIdentityMismatchError,
  MountedSigningPathsUnconvertedError,
  OpenedConfigurationNotRunnableError,
  SftpUnavailableError,
  SignalingServerChangedError,
  SignalingServerUnavailableError,
} from "@jobs/jobManager";
import {
  ZeroSetupFingerprintListError,
  ZeroSetupRemoteDirectoryError,
} from "@jobs/intentArgv";
import { JobInputNotFoundError } from "@jobs/workInputs";
import { MountedKeyFileRefusedError } from "@jobs/mountedKeyFile";
import { SigningIdentityLocationError } from "@jobs/signingIdentity";
import { WorkingFolderFilesRefusedError } from "@jobs/workingFolderExchangeFiles";

import { route as CreateRoute } from "../../../server/console/routes/index";

import { tempDataRoot, validIntent } from "../../utils/jobFixtures";

import type { JobManager } from "@jobs/jobManager";

const globals = globalThis as { jobManagerInstance?: JobManager };

beforeEach(() => {
  vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
  vi.stubEnv("JOB_DATA_ROOT", tempDataRoot("create-error-responses"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  globals.jobManagerInstance = undefined;
});

async function createRefusedWith(
  error: unknown,
): Promise<{ status: number; body: string }> {
  globals.jobManagerInstance = {
    createJob: () => Promise.reject(error),
  } as unknown as JobManager;
  const handlers = CreateRoute.handlers as Record<
    string,
    (ctx: { request: Request; params: Record<string, string> }) => unknown
  >;
  const response = (await handlers.POST({
    request: new Request("http://localhost/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost" },
      body: JSON.stringify(validIntent()),
    }),
    params: {},
  })) as Response;
  return { status: response.status, body: await response.text() };
}

const reason = (token: string): string => JSON.stringify({ reason: token });

describe("POST /api/jobs maps each create error to its answer", () => {
  test.each([
    ["busy", new ExchangeBusyError("job-1"), 409, '{"id":"job-1"}'],
    ["shutting down", new ConsoleShuttingDownError(), 503, ""],
    [
      "signing identity exposed",
      new JobSigningIdentityExposedError(),
      400,
      reason("signing-identity-in-rendezvous"),
    ],
    [
      "fingerprint list",
      new ZeroSetupFingerprintListError(),
      400,
      reason("sftp-fingerprint-list"),
    ],
    [
      "remote directory",
      new ZeroSetupRemoteDirectoryError(),
      400,
      reason("sftp-url-directory"),
    ],
    [
      "console-owned credential",
      new JobSftpCredentialConsoleOwnedError(),
      400,
      reason("sftp-credential-console-file"),
    ],
    [
      "key file absent",
      new MountedKeyFileRefusedError("absent"),
      400,
      reason("mounted-key-file-absent"),
    ],
    [
      "key file invalid",
      new MountedKeyFileRefusedError("invalid"),
      400,
      reason("mounted-key-file-invalid"),
    ],
    [
      "key file newer",
      new MountedKeyFileRefusedError("newer"),
      400,
      reason("mounted-key-file-newer"),
    ],
    [
      "signing paths unconverted",
      new MountedSigningPathsUnconvertedError(),
      400,
      reason("mounted-signing-paths-unconverted"),
    ],
    [
      "signing identity mismatch",
      new MountedSigningIdentityMismatchError(),
      400,
      reason("mounted-signing-identity-mismatch"),
    ],
    [
      "opened configuration not runnable",
      new OpenedConfigurationNotRunnableError(),
      400,
      reason("opened-configuration-not-runnable"),
    ],
    [
      "working folder files present",
      new WorkingFolderFilesRefusedError("present"),
      400,
      reason("working-folder-configuration-present"),
    ],
    [
      "working folder files from a console exchange",
      new WorkingFolderFilesRefusedError("present", true),
      400,
      reason("working-folder-console-exchange"),
    ],
    [
      "working folder unwritable",
      new WorkingFolderFilesRefusedError("unwritable"),
      500,
      reason("working-folder-unwritable"),
    ],
    [
      "coordination server changed",
      new SignalingServerChangedError(),
      400,
      reason("coordination-server-changed"),
    ],
    [
      "uncomposable intent",
      new JobIntentUncomposableError("connection.path: too long"),
      400,
      '{"error":"connection.path: too long"}',
    ],
    ["input not found", new JobInputNotFoundError(), 400, ""],
    ["no shared folder", new JobRendezvousUnavailableError(), 400, ""],
    ["retain required", new JobRendezvousRetainRequiredError(), 400, ""],
    ["no sftp connection", new SftpUnavailableError(), 400, ""],
    ["no coordination server", new SignalingServerUnavailableError(), 400, ""],
    [
      "signing identity location",
      new SigningIdentityLocationError("names nothing"),
      400,
      "",
    ],
    ["any other error", new Error("disk full at /data/x"), 500, ""],
    ["a thrown non-error", "disk full", 500, ""],
  ] as const)("%s", async (_label, error, status, body) => {
    expect(await createRefusedWith(error)).toEqual({ status, body });
  });
});
