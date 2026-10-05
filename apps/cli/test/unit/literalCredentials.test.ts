import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getLogger, UsageError } from "@alcove/core";
import type { ExchangeSpec } from "@alcove/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { saveConfig } from "../../src/config";
import {
  assertBootstrapUrlPasswordStorable,
  BOOTSTRAP_CREDENTIAL_FLAGS,
  commandLineLiteralCredentialNotice,
  commandLineLiteralCredentials,
  literalCredentials,
  savedLiteralCredentialWarning,
  urlPasswordIsNotStorable,
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

function noticeFor(
  argv: Record<string, unknown>,
  url: URL | undefined,
  definedFlags: readonly string[] = BOOTSTRAP_CREDENTIAL_FLAGS,
): string | undefined {
  const found = commandLineLiteralCredentials(argv, url, definedFlags);
  return found === undefined
    ? undefined
    : commandLineLiteralCredentialNotice(found);
}

describe("commandLineLiteralCredentialNotice", () => {
  test("a password in the URL is named, with the URL as it should be typed", () => {
    expect(noticeFor({}, new URL("sftp://alice:pw@host/drop"))).toBe(
      "the command line holds a credential as typed in the URL, which other " +
        "users of this machine can see while the command runs and your shell " +
        "may keep in its history. Put each value in a file of its own and " +
        "pass its path with a leading @, leaving the password out of the " +
        "URL, e.g. sftp://alice@host/drop --server-password @./sftp-password.txt.",
    );
  });

  test("a command with no --server-password names the configuration form", () => {
    expect(noticeFor({}, new URL("sftp://alice:pw@host/drop"), [])).toContain(
      'e.g. password: "@./sftp-password.txt".',
    );
  });

  test("each credential flag given a value as typed is named", () => {
    const notice = noticeFor(
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

  test("a flag the command does not define is not read", () => {
    expect(
      noticeFor({ "server-password": "pw" }, undefined, [
        "--server-private-key",
      ]),
    ).toBeUndefined();
  });

  test("a URL password percent-encoding an @path is a reference", () => {
    expect(
      noticeFor({}, new URL("sftp://alice:%40.%2Fpw.txt@host/drop")),
    ).toBeUndefined();
  });

  test("references, and a URL with no password, get no notice", () => {
    expect(
      noticeFor(
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
      noticeFor(
        { "server-password": "@./pw.txt" },
        new URL("sftp://alice:pw@host/drop"),
      ),
    ).toContain("holds a credential as typed in the URL,");
  });
});

describe("savedLiteralCredentialWarning with the command line's credentials", () => {
  const commandLine = commandLineLiteralCredentials(
    { "server-password": "pw" },
    undefined,
    BOOTSTRAP_CREDENTIAL_FLAGS,
  );

  test("one warning states both the command line and the saved file", () => {
    expect(
      savedLiteralCredentialWarning(
        "alcove.yaml",
        { channel: "sftp", server: { password: "pw" } },
        commandLine,
      ),
    ).toBe(
      "the command line holds a credential as typed in --server-password, " +
        "which other users of this machine can see while the command runs " +
        "and your shell may keep in its history, and the configuration saved " +
        "to alcove.yaml holds a credential as typed in " +
        "connection.server.password, where anyone with a copy of the file " +
        "can use it. Put each value in a file of its own and give its path " +
        "with a leading @: on the command line, e.g. --server-password " +
        "@./sftp-password.txt, and in the file before you commit or share " +
        'it, e.g. password: "@./sftp-password.txt".',
    );
  });

  test("a saved file holding none still gets the command line's notice", () => {
    expect(
      savedLiteralCredentialWarning(
        "alcove.yaml",
        { channel: "filedrop" },
        commandLine,
      ),
    ).toBe(commandLineLiteralCredentialNotice(commandLine!));
  });
});

describe("urlPasswordIsNotStorable", () => {
  test("a URL password beginning with @ cannot be stored as typed", () => {
    expect(
      urlPasswordIsNotStorable(new URL("sftp://alice:%40secret@host/drop")),
    ).toBe(true);
    expect(
      urlPasswordIsNotStorable(new URL("sftp://alice:p%40ss@host/drop")),
    ).toBe(false);
    expect(urlPasswordIsNotStorable(new URL("sftp://alice@host/drop"))).toBe(
      false,
    );
    expect(urlPasswordIsNotStorable(undefined)).toBe(false);
  });

  test("a bootstrap command refuses it unless --server-password replaces it", () => {
    const url = new URL("sftp://alice:%40secret@host/drop");
    expect(() => assertBootstrapUrlPasswordStorable({}, url)).toThrow(
      UsageError,
    );
    expect(() => assertBootstrapUrlPasswordStorable({}, url)).toThrow(
      "e.g. --server-password @./sftp-password.txt.",
    );
    expect(() =>
      assertBootstrapUrlPasswordStorable(
        { "server-password": "@./pw.txt" },
        url,
      ),
    ).not.toThrow();
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

  test("warns through the logger it is given", () => {
    const configPath = path.join(dir, "alcove.yaml");
    const configWarnings = captureConfigWarnings();
    const warnings: string[] = [];
    saveConfig(configPath, spec("pw"), {
      log: { warn: (message) => warnings.push(message) },
    });
    expect(warnings).toHaveLength(1);
    expect(configWarnings).toEqual([]);
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
