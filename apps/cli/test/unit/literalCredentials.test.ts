import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getLogger } from "@alcove/core";
import type { ExchangeSpec } from "@alcove/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { saveConfig } from "../../src/config";
import {
  commandLineLiteralCredentialNotice,
  literalCredentials,
  savedLiteralCredentialWarning,
} from "../../src/literalCredentials";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-literal-credentials-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function captureConfigWarnings(): string[] {
  const warnings: string[] = [];
  vi.spyOn(getLogger("config"), "warn").mockImplementation(
    (...args: unknown[]) => {
      warnings.push(String(args[0]));
    },
  );
  return warnings;
}

describe("literalCredentials", () => {
  test("each credential field holding a value as typed is found", () => {
    expect(
      literalCredentials({
        password: "pw",
        privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
        privateKeyPassphrase: "phrase",
        provision: { auth: { bearer: "token" } },
      }).map((field) => field.configField),
    ).toEqual([
      "connection.server.password",
      "connection.server.private_key",
      "connection.server.private_key_passphrase",
      "connection.server.provision.auth.bearer",
    ]);
    expect(
      literalCredentials({
        provision: { auth: { username: "svc", password: "pw" } },
      }).map((field) => field.flag),
    ).toEqual(["--server-provision-password"]);
  });

  test("an @path reference, or no credential, is not a credential as typed", () => {
    expect(
      literalCredentials({
        password: "@./sftp-password.txt",
        privateKeyPassphrase: "@~/passphrase.txt",
        provision: { auth: { username: "svc", password: "@./basic.txt" } },
      }),
    ).toEqual([]);
    expect(literalCredentials({})).toEqual([]);
    expect(literalCredentials(undefined)).toEqual([]);
  });
});

describe("savedLiteralCredentialWarning", () => {
  test("names the file, the field and the @path form", () => {
    expect(
      savedLiteralCredentialWarning("./alcove.yaml", {
        channel: "sftp",
        server: { password: "pw" },
      }),
    ).toBe(
      "the configuration saved to ./alcove.yaml holds a credential as typed " +
        "in connection.server.password, and anyone with a copy of the file " +
        "can use it. Before you commit or share the file, put the value in a " +
        "file of its own and write its path with a leading @ in its place, " +
        'e.g. password: "@./sftp-password.txt".',
    );
  });

  test("lists every field holding one", () => {
    expect(
      savedLiteralCredentialWarning("alcove.yaml", {
        channel: "webrtc",
        server: { provision: { auth: { username: "u", password: "pw" } } },
      }),
    ).toContain(
      "holds a credential as typed in connection.server.provision.auth.password",
    );
    expect(
      savedLiteralCredentialWarning("alcove.yaml", {
        channel: "sftp",
        server: { privateKey: "key", privateKeyPassphrase: "phrase" },
      }),
    ).toContain(
      "holds credentials as typed in connection.server.private_key and " +
        "connection.server.private_key_passphrase",
    );
  });

  test("a connection with no server block, or only references, gets none", () => {
    expect(
      savedLiteralCredentialWarning("alcove.yaml", { channel: "filedrop" }),
    ).toBeUndefined();
    expect(
      savedLiteralCredentialWarning("alcove.yaml", {
        channel: "sftp",
        server: { password: "@./pw.txt" },
      }),
    ).toBeUndefined();
  });
});

describe("commandLineLiteralCredentialNotice", () => {
  test("a password in the URL is named, with the flag that replaces it", () => {
    expect(
      commandLineLiteralCredentialNotice(
        {},
        new URL("sftp://alice:pw@host/drop"),
      ),
    ).toBe(
      "the command line holds a credential as typed in the URL, which other " +
        "users of this machine can see while the command runs and your shell " +
        "may keep in its history. Put each value in a file of its own and " +
        "pass its path with a leading @, leaving the password out of the " +
        "URL, e.g. --server-password @./sftp-password.txt.",
    );
  });

  test("each credential flag given a value as typed is named", () => {
    const notice = commandLineLiteralCredentialNotice(
      {
        "server-private-key": "key",
        "server-private-key-passphrase": "phrase",
        "server-provision-bearer": "token",
      },
      undefined,
    );
    expect(notice).toContain(
      "holds credentials as typed in --server-private-key, " +
        "--server-private-key-passphrase and --server-provision-bearer,",
    );
    expect(notice).toContain("e.g. --server-private-key @~/.ssh/id_alcove.");
  });

  test("a URL password percent-encoding an @path is a reference", () => {
    expect(
      commandLineLiteralCredentialNotice(
        {},
        new URL("sftp://alice:%40.%2Fpw.txt@host/drop"),
      ),
    ).toBeUndefined();
  });

  test("references, and a URL with no password, get no notice", () => {
    expect(
      commandLineLiteralCredentialNotice(
        {
          "server-password": "@./pw.txt",
          "server-provision-username": "svc",
          "server-provision-password": "@./basic.txt",
        },
        new URL("sftp://alice@host/drop"),
      ),
    ).toBeUndefined();
  });

  test("a URL password is named even when the flag overrides it with a reference", () => {
    expect(
      commandLineLiteralCredentialNotice(
        { "server-password": "@./pw.txt" },
        new URL("sftp://alice:pw@host/drop"),
      ),
    ).toContain("holds a credential as typed in the URL,");
  });
});

describe("saveConfig", () => {
  const terms = {
    identity: "Party A",
    version: "1.0.0",
    date: "2026-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    deduplicate: false,
    output: { expectsOutput: true, shareWithPartner: true },
    linkageFields: [{ name: "firstName", type: "first_name" }],
    linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
  } as ExchangeSpec["linkageTerms"];

  function spec(password: string): ExchangeSpec {
    return {
      connection: {
        channel: "sftp",
        server: { host: "h", username: "alice", password },
      },
      linkageTerms: terms,
    };
  }

  test("warns once when the saved connection holds a password as typed", () => {
    const configPath = path.join(dir, "alcove.yaml");
    const warnings = captureConfigWarnings();
    saveConfig(configPath, spec("pw"));
    expect(warnings).toEqual([
      savedLiteralCredentialWarning(configPath, spec("pw").connection),
    ]);
    if (process.platform !== "win32")
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });

  test("does not warn for an @path, and writes the file owner-only all the same", () => {
    const configPath = path.join(dir, "alcove.yaml");
    const warnings = captureConfigWarnings();
    saveConfig(configPath, spec("@./sftp-password.txt"));
    expect(warnings).toEqual([]);
    if (process.platform !== "win32")
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });
});
