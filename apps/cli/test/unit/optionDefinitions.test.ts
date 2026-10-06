import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";
import type { Arguments } from "yargs";
import { UsageError } from "@alcove/core";

import {
  configFileFlag,
  CONNECTION_PER_POLL_SHORT_INTERVAL_WARN_MS,
  connectionOverridesFrom,
  hostKeyFingerprintFlag,
  keyFileFlag,
  namedConfigFileFlag,
  serverProvisionFlag,
  warnConnectionPerPollShortInterval,
  warnOptionsOverridesIgnoredOffline,
  warnUnsupportedFileSyncFlags,
} from "../../src/optionDefinitions";

/** Collect the warnings a helper emits, for assertion. */
function warnCollector(): { warn: (m: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (m: string) => messages.push(m), messages };
}

function argv(extra: Record<string, unknown>): Arguments {
  return { _: [], $0: "alcove", ...extra } as unknown as Arguments;
}

const FP = "SHA256:" + "A".repeat(43);

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-optdefs-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Write a fingerprint file under the test dir and return its `@path` reference. */
function atFile(name: string, contents: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, contents);
  return `@${p}`;
}

// --- configFileFlag / keyFileFlag ---------------------------------------------

test("the path flags default when absent", () => {
  expect(configFileFlag(argv({}))).toBe("./alcove.yaml");
  expect(keyFileFlag(argv({}))).toBe("./.alcove.key");
  expect(namedConfigFileFlag(argv({}))).toBeUndefined();
});

test.each([
  ["config-file", configFileFlag],
  ["key-file", keyFileFlag],
  ["config-file", namedConfigFileFlag],
] as const)("--%s expands a leading ~ and trims", (flag, read) => {
  expect(read(argv({ [flag]: "~/p/file \r" }))).toBe(
    path.join(os.homedir(), "p", "file"),
  );
  expect(read(argv({ [flag]: "~" }))).toBe(os.homedir());
  expect(read(argv({ [flag]: "dir/~/file" }))).toBe("dir/~/file");
  expect(read(argv({ [flag]: "~other/file" }))).toBe("~other/file");
});

test.each([
  ["config-file", configFileFlag],
  ["key-file", keyFileFlag],
  ["config-file", namedConfigFileFlag],
] as const)("--%s refuses an empty value and a repeat", (flag, read) => {
  expect(() => read(argv({ [flag]: "  " }))).toThrow(UsageError);
  expect(() => read(argv({ [flag]: "  " }))).toThrow(`--${flag} is empty`);
  expect(() => read(argv({ [flag]: ["a", "b"] }))).toThrow(UsageError);
});

test.each([
  [
    configFileFlag,
    "configuration file, or omit the flag to use ./alcove.yaml.",
  ],
  [keyFileFlag, "key file, or omit the flag to use ./.alcove.key."],
  [
    namedConfigFileFlag,
    "configuration file, or omit the flag to load no configuration file.",
  ],
] as const)("an empty path flag says what omitting it does", (read, ending) => {
  const flag = read === keyFileFlag ? "key-file" : "config-file";
  expect(() => read(argv({ [flag]: "" }))).toThrow(
    `--${flag} is empty; name the ${ending}`,
  );
});

// --- hostKeyFingerprintFlag ---------------------------------------------------

test("hostKeyFingerprintFlag: an absent flag is undefined", () => {
  expect(hostKeyFingerprintFlag(argv({}))).toBeUndefined();
});

test("hostKeyFingerprintFlag: a well-formed literal fingerprint is returned unchanged", () => {
  expect(
    hostKeyFingerprintFlag(argv({ "server-host-key-fingerprint": FP })),
  ).toBe(FP);
});

test("hostKeyFingerprintFlag: a malformed fingerprint is a UsageError naming the flag and format", () => {
  const run = (): string | undefined =>
    hostKeyFingerprintFlag(
      argv({ "server-host-key-fingerprint": "not-a-fingerprint" }),
    );
  expect(run).toThrow(UsageError);
  expect(run).toThrow(/--server-host-key-fingerprint/);
  expect(run).toThrow(/SHA256/);
});

test("hostKeyFingerprintFlag: a base64url signing-fingerprint-shaped value is rejected", () => {
  // The same confusable shape core's schema names specially (a signing
  // partner_fingerprint pasted in by mistake) must still be rejected here --
  // the CLI parser need not replicate the specific "looks like a signing
  // fingerprint" message, only refuse to let it through.
  const signingShaped = "B".repeat(42) + "A"; // base64url, 43 chars, no prefix
  expect(() =>
    hostKeyFingerprintFlag(
      argv({ "server-host-key-fingerprint": signingShaped }),
    ),
  ).toThrow(UsageError);
});

test("hostKeyFingerprintFlag: reads and validates an @file reference", () => {
  const ref = atFile("fp.txt", FP + "\n");
  expect(
    hostKeyFingerprintFlag(argv({ "server-host-key-fingerprint": ref })),
  ).toBe(FP);
});

test("hostKeyFingerprintFlag: an @file reference resolving to a malformed value is a UsageError naming the reference", () => {
  const ref = atFile("bad-fp.txt", "garbage\n");
  const run = (): string | undefined =>
    hostKeyFingerprintFlag(argv({ "server-host-key-fingerprint": ref }));
  expect(run).toThrow(UsageError);
  expect(run).toThrow(ref);
});

test("hostKeyFingerprintFlag: a missing @file reference is a UsageError naming the reference", () => {
  const ref = `@${path.join(dir, "absent.txt")}`;
  const run = (): string | undefined =>
    hostKeyFingerprintFlag(argv({ "server-host-key-fingerprint": ref }));
  expect(run).toThrow(UsageError);
  expect(run).toThrow(ref);
});

test("hostKeyFingerprintFlag: a repeated flag is rejected before format validation", () => {
  expect(() =>
    hostKeyFingerprintFlag(argv({ "server-host-key-fingerprint": [FP, FP] })),
  ).toThrow(/may be given only once/);
});

// --- connectionOverridesFrom ---------------------------------------------------

test("connectionOverridesFrom: fans serverHostKeyFingerprint into the server override block", () => {
  const overrides = connectionOverridesFrom({
    connectionTimeout: undefined,
    peerTimeout: undefined,
    pollingFrequencyMs: undefined,
    maxReconnectAttempts: undefined,
    serverUsername: undefined,
    serverPassword: undefined,
    serverPrivateKey: undefined,
    serverPrivateKeyPassphrase: undefined,
    serverKeyboardInteractive: undefined,
    serverHostKeyFingerprint: FP,
    serverPort: undefined,
    locklessRendezvous: undefined,
    peerId: undefined,
    timestampInFilename: undefined,
    retainFiles: undefined,
    outboundPath: undefined,
  });
  expect(overrides.server?.hostKeyFingerprint).toBe(FP);
});

test("connectionOverridesFrom: an absent serverHostKeyFingerprint stays absent", () => {
  const overrides = connectionOverridesFrom({
    connectionTimeout: undefined,
    peerTimeout: undefined,
    pollingFrequencyMs: undefined,
    maxReconnectAttempts: undefined,
    serverUsername: undefined,
    serverPassword: undefined,
    serverPrivateKey: undefined,
    serverPrivateKeyPassphrase: undefined,
    serverKeyboardInteractive: undefined,
    serverHostKeyFingerprint: undefined,
    serverPort: undefined,
    locklessRendezvous: undefined,
    peerId: undefined,
    timestampInFilename: undefined,
    retainFiles: undefined,
    outboundPath: undefined,
  });
  expect(overrides.server?.hostKeyFingerprint).toBeUndefined();
});

test("connectionOverridesFrom: fans connectionPerPoll into the options override block", () => {
  const overrides = connectionOverridesFrom({ connectionPerPoll: true });
  expect(overrides.options?.connectionPerPoll).toBe(true);
});

// --- warnUnsupportedFileSyncFlags: --connection-per-poll ----------------------

test("warnUnsupportedFileSyncFlags: --connection-per-poll warns on filedrop (SFTP-only)", () => {
  // Unlike the file-sync flags, connection-per-poll warns on filedrop too: the
  // ephemeral-session mode needs a real SFTP socket, which filedrop lacks.
  const log = warnCollector();
  warnUnsupportedFileSyncFlags("filedrop", { connectionPerPoll: true }, log);
  expect(log.messages).toHaveLength(1);
  expect(log.messages[0]).toContain("--connection-per-poll");
  expect(log.messages[0]).toContain("filedrop");
  expect(log.messages[0]).toContain("only supported on sftp");
});

test("warnUnsupportedFileSyncFlags: --connection-per-poll warns on webrtc", () => {
  const log = warnCollector();
  warnUnsupportedFileSyncFlags("webrtc", { connectionPerPoll: true }, log);
  expect(log.messages.some((m) => m.includes("--connection-per-poll"))).toBe(
    true,
  );
});

test("warnUnsupportedFileSyncFlags: --connection-per-poll is silent on sftp", () => {
  const log = warnCollector();
  warnUnsupportedFileSyncFlags("sftp", { connectionPerPoll: true }, log);
  expect(log.messages).toHaveLength(0);
});

// --- warnConnectionPerPollShortInterval --------------------------------------

test("warnConnectionPerPollShortInterval: warns below the threshold on sftp", () => {
  const log = warnCollector();
  warnConnectionPerPollShortInterval(
    "sftp",
    true,
    CONNECTION_PER_POLL_SHORT_INTERVAL_WARN_MS - 1,
    log,
  );
  expect(log.messages).toHaveLength(1);
  expect(log.messages[0]).toContain("--connection-per-poll");
  expect(log.messages[0]).toContain("--polling-frequency");
});

test("warnConnectionPerPollShortInterval: warns at the default interval when none is set", () => {
  // Unset poll interval resolves to the 5s default, which is short, so the mode's
  // most common misconfiguration (turned on, interval left at the default) warns.
  const log = warnCollector();
  warnConnectionPerPollShortInterval("sftp", true, undefined, log);
  expect(log.messages).toHaveLength(1);
});

test("warnConnectionPerPollShortInterval: silent at or above the threshold", () => {
  const log = warnCollector();
  warnConnectionPerPollShortInterval(
    "sftp",
    true,
    CONNECTION_PER_POLL_SHORT_INTERVAL_WARN_MS,
    log,
  );
  expect(log.messages).toHaveLength(0);
});

test("warnConnectionPerPollShortInterval: silent when the mode is off", () => {
  const log = warnCollector();
  warnConnectionPerPollShortInterval("sftp", undefined, 1000, log);
  expect(log.messages).toHaveLength(0);
});

test("warnConnectionPerPollShortInterval: silent off the sftp channel", () => {
  // The mode is SFTP-only; on filedrop the ignored-flag warning covers it instead,
  // so this advisory must not also fire (a poll never runs the mode there).
  const log = warnCollector();
  warnConnectionPerPollShortInterval("filedrop", true, 1000, log);
  expect(log.messages).toHaveLength(0);
});

// --- warnOptionsOverridesIgnoredOffline: --connection-per-poll ----------------

test("warnOptionsOverridesIgnoredOffline: names --connection-per-poll when set", () => {
  const log = warnCollector();
  warnOptionsOverridesIgnoredOffline({ connectionPerPoll: true }, log);
  expect(log.messages).toHaveLength(1);
  expect(log.messages[0]).toContain("--connection-per-poll");
});

// --- serverProvisionFlag -------------------------------------------------------

test("serverProvisionFlag: no flag states no block", () => {
  expect(serverProvisionFlag(argv({}))).toBeUndefined();
});

test.each([
  [
    "https://wake.example.org/sftp/start",
    { host: "wake.example.org", path: "/sftp/start" },
  ],
  ["https://wake.example.org", { host: "wake.example.org" }],
  ["https://wake.example.org:8443/", { host: "wake.example.org", port: 8443 }],
  ["https://[::1]:9000/w", { host: "::1", port: 9000, path: "/w" }],
])("serverProvisionFlag: %s states a start-mode block", (raw, expected) => {
  expect(serverProvisionFlag(argv({ "server-provision": raw }))).toEqual(
    expected,
  );
});

test("serverProvisionFlag: credentials are kept verbatim, an @path unread", () => {
  expect(
    serverProvisionFlag(
      argv({
        "server-provision": "https://wake.example.org/start",
        "server-provision-bearer": "@/run/secrets/wake.token",
      }),
    ),
  ).toEqual({
    host: "wake.example.org",
    path: "/start",
    auth: { bearer: "@/run/secrets/wake.token" },
  });
  expect(
    serverProvisionFlag(
      argv({
        "server-provision": "https://wake.example.org/start",
        "server-provision-username": "waker",
        "server-provision-password": "@pw",
      }),
    )?.auth,
  ).toEqual({ username: "waker", password: "@pw" });
});

test.each([
  "http://wake.example.org/start",
  "https://user:secret-token@wake.example.org/start",
  "https://wake.example.org/start?token=secret-token",
  "https://wake.example.org/start#secret-token",
  "https://wake.example.org\n/secret-token",
  "https://0x7f.1/secret-token",
  "wake.example.org/secret-token",
])("serverProvisionFlag: %j is refused without echoing it", (raw) => {
  let caught: unknown;
  try {
    serverProvisionFlag(argv({ "server-provision": raw }));
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  expect((caught as Error).message).toContain(
    "--server-provision must be an https URL",
  );
  expect((caught as Error).message).not.toContain("secret-token");
});

test.each([
  [{ "server-provision-bearer": "t" }, "requires --server-provision"],
  [{ "server-provision-password": "p" }, "requires --server-provision"],
  [
    {
      "server-provision": "https://wake.example.org",
      "server-provision-bearer": "t",
      "server-provision-username": "u",
      "server-provision-password": "p",
    },
    "pass one",
  ],
  [
    {
      "server-provision": "https://wake.example.org",
      "server-provision-username": "u",
    },
    "must be passed together",
  ],
])("serverProvisionFlag: %j is refused", (flags, fragment) => {
  expect(() => serverProvisionFlag(argv(flags))).toThrow(fragment);
});

test("serverProvisionFlag: a non-string bearer is refused", () => {
  let caught: unknown;
  try {
    serverProvisionFlag(argv({ "server-provision-bearer": 5 }));
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  expect((caught as Error).message).toContain(
    "--server-provision-bearer must be a string",
  );
});

test("connectionOverridesFrom: --server-provision reaches the server overrides", () => {
  const provision = { host: "wake.example.org" };
  expect(
    connectionOverridesFrom({ serverProvision: provision }).server?.provision,
  ).toBe(provision);
});
