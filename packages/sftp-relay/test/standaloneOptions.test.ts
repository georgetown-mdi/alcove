import { describe, expect, it } from "vitest";

import {
  DEFAULT_SFTP_RELAY_HOST,
  DEFAULT_SFTP_RELAY_PORT,
  SftpRelayOptionError,
  parseAllowedOrigin,
  parseTarget,
  resolveSftpRelayOptions,
} from "../src/standaloneOptions.ts";

const REQUIRED = [
  "--target",
  "sftp.example.org:22",
  "--allowed-origin",
  "https://app.example.org",
];

describe("resolveSftpRelayOptions", () => {
  it("takes the target and the allowed origins, defaulting the listener", () => {
    expect(
      resolveSftpRelayOptions([
        ...REQUIRED,
        "--allowed-origin",
        "http://localhost:5173",
      ]),
    ).toEqual({
      host: DEFAULT_SFTP_RELAY_HOST,
      port: DEFAULT_SFTP_RELAY_PORT,
      target: { host: "sftp.example.org", port: 22 },
      allowedOrigins: ["https://app.example.org", "http://localhost:5173"],
    });
  });

  it("takes the listener's host and port", () => {
    expect(
      resolveSftpRelayOptions([
        ...REQUIRED,
        "--host",
        "0.0.0.0",
        "--port",
        "8080",
      ]),
    ).toMatchObject({ host: "0.0.0.0", port: 8080 });
  });

  it.each([
    [["--allowed-origin", "https://app.example.org"], /--target is required/],
    [["--target", "sftp.example.org:22"], /--allowed-origin is required/],
    [[...REQUIRED, "--target", "other.example:22"], /only once/],
    [[...REQUIRED, "--port", "1", "--port", "2"], /only once/],
    [[...REQUIRED, "--key-table", "x"], /Unknown argument: --key-table/],
    [[...REQUIRED, "stray"], /Unknown argument: stray/],
    [[...REQUIRED, "--host"], /--host requires a value/],
    [[...REQUIRED, "--host", " "], /--host requires a value/],
    [[...REQUIRED, "--host", "--port"], /--host requires a value/],
    [[...REQUIRED, "--port", "65536"], /--port must be a whole number/],
    [[...REQUIRED, "--port", "-1"], /--port requires a value|--port must/],
  ])("refuses %j", (argv, message) => {
    expect(() => resolveSftpRelayOptions(argv)).toThrow(SftpRelayOptionError);
    expect(() => resolveSftpRelayOptions(argv)).toThrow(message);
  });
});

describe("parseTarget", () => {
  it.each([
    ["sftp.example.org:22", { host: "sftp.example.org", port: 22 }],
    ["10.0.0.5:2222", { host: "10.0.0.5", port: 2222 }],
    ["[2001:db8::5]:22", { host: "2001:db8::5", port: 22 }],
  ])("reads %s", (raw, target) => {
    expect(parseTarget(raw)).toEqual(target);
  });

  it.each([
    "sftp.example.org",
    "sftp.example.org:0",
    "sftp.example.org:65536",
    "2001:db8::5:22",
    "user@sftp.example.org:22",
    "sftp.example.org/x:22",
    "sftp://sftp.example.org:22",
    ":22",
  ])("refuses %s", (raw) => {
    expect(() => parseTarget(raw)).toThrow(SftpRelayOptionError);
  });
});

describe("parseAllowedOrigin", () => {
  it.each([
    "https://app.example.org",
    "http://localhost:5173",
    "https://app.example.org:8443",
  ])("takes %s", (raw) => {
    expect(parseAllowedOrigin(raw)).toBe(raw);
  });

  it.each([
    ["https://app.example.org/", "https://app.example.org"],
    ["https://App.example.org", "https://app.example.org"],
    ["https://app.example.org:443", "https://app.example.org"],
    ["https://app.example.org/path", "https://app.example.org"],
  ])("refuses %s, naming %s", (raw, suggestion) => {
    expect(() => parseAllowedOrigin(raw)).toThrow(
      `did you mean ${suggestion}?`,
    );
  });

  it.each(["null", "*", "app.example.org", "ftp://app.example.org", ""])(
    "refuses %j",
    (raw) => {
      expect(() => parseAllowedOrigin(raw)).toThrow(SftpRelayOptionError);
    },
  );
});
