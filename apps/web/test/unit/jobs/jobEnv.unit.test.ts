import path from "node:path";

import { describe, expect, test } from "vitest";

import { jobDirectory, readJobDirectory } from "@jobs/jobEnv";

describe("readJobDirectory", () => {
  test("an unset or blank variable reads as no directory", () => {
    expect(readJobDirectory({}, "secretsDir")).toBeUndefined();
    expect(
      readJobDirectory({ JOB_SECRETS_DIR: "   " }, "secretsDir"),
    ).toBeUndefined();
  });

  test("the data root and the credential scratch directory are used as configured", () => {
    expect(jobDirectory({ JOB_DATA_ROOT: "  /data/  " }, "dataRoot")).toBe(
      "/data/",
    );
    expect(
      jobDirectory(
        { JOB_SFTP_CREDENTIAL_DIR: "relative" },
        "sftpCredentialDir",
      ),
    ).toBe("relative");
  });

  test("a mount directory is resolved to an absolute path", () => {
    expect(jobDirectory({ JOB_SECRETS_DIR: "relative" }, "secretsDir")).toBe(
      path.resolve("relative"),
    );
    expect(
      jobDirectory(
        { JOB_RENDEZVOUS_OUTBOUND_DIR: "/out/" },
        "rendezvousOutboundDir",
      ),
    ).toBe("/out");
  });

  test("the input and rendezvous directories fall back to the data root, resolved", () => {
    const env = { JOB_DATA_ROOT: "/data/" };
    expect(readJobDirectory(env, "inputDir")).toEqual({
      path: "/data",
      fromOwnVariable: false,
    });
    expect(readJobDirectory(env, "rendezvousDir")).toEqual({
      path: "/data",
      fromOwnVariable: false,
    });
    expect(
      readJobDirectory(
        { ...env, JOB_RENDEZVOUS_DIR: "/shared" },
        "rendezvousDir",
      ),
    ).toEqual({ path: "/shared", fromOwnVariable: true });
  });

  test("the secrets and outbound directories have no data-root fallback", () => {
    const env = { JOB_DATA_ROOT: "/data" };
    expect(readJobDirectory(env, "secretsDir")).toBeUndefined();
    expect(readJobDirectory(env, "rendezvousOutboundDir")).toBeUndefined();
    expect(readJobDirectory(env, "sftpCredentialDir")).toBeUndefined();
  });
});
