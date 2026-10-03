import { describe, expect, test } from "vitest";

import { SIGNALING_SCHEME_MISMATCH } from "@utils/signalingScheme";
import { parseClientConfig } from "@utils/clientConfig";

describe("parseClientConfig", () => {
  test("an empty build environment resolves every default", () => {
    expect(parseClientConfig({})).toEqual({
      PEERJS_DEBUG_LEVEL: 1,
      LOG_LEVEL: "INFO",
      DEPLOYMENT_PROFILE: "hosted",
      ALCOVE_VERSION: "",
      SIGNALING_SERVER_URL: undefined,
    });
  });

  test("reads each value from its unprefixed key", () => {
    expect(
      parseClientConfig({
        PEERJS_DEBUG_LEVEL: "3",
        LOG_LEVEL: "DEBUG",
        DEPLOYMENT_PROFILE: "console",
        ALCOVE_VERSION: "1.2.3",
        SIGNALING_SERVER_URL: "wss://signaling.example.org:8443/broker/",
      }),
    ).toEqual({
      PEERJS_DEBUG_LEVEL: 3,
      LOG_LEVEL: "DEBUG",
      DEPLOYMENT_PROFILE: "console",
      ALCOVE_VERSION: "1.2.3",
      SIGNALING_SERVER_URL: {
        secure: true,
        host: "signaling.example.org",
        port: 8443,
        path: "/broker/",
      },
    });
  });

  test.each([
    ["3", 3],
    [" 2 ", 2],
    ["0", 0],
    [3, 3],
  ])("reads PEERJS_DEBUG_LEVEL %j as %d", (input, expected) => {
    expect(
      parseClientConfig({ PEERJS_DEBUG_LEVEL: input }).PEERJS_DEBUG_LEVEL,
    ).toBe(expected);
  });

  test.each(["", "  ", "abc", "Infinity"])(
    "refuses PEERJS_DEBUG_LEVEL %j",
    (input) => {
      expect(() => parseClientConfig({ PEERJS_DEBUG_LEVEL: input })).toThrow(
        /VITE_PEERJS_DEBUG_LEVEL/,
      );
    },
  );

  test.each([
    ["debug", "DEBUG"],
    ["Warn", "WARN"],
    ["SILENT", "SILENT"],
  ])("reads LOG_LEVEL %j as %s", (input, expected) => {
    expect(parseClientConfig({ LOG_LEVEL: input }).LOG_LEVEL).toBe(expected);
  });

  test.each(["", "verbose", "setLevel"])("refuses LOG_LEVEL %j", (input) => {
    expect(() => parseClientConfig({ LOG_LEVEL: input })).toThrow(
      /VITE_LOG_LEVEL/,
    );
  });

  test.each(["4", "-1", "1.5"])("refuses PEERJS_DEBUG_LEVEL %j", (input) => {
    expect(() => parseClientConfig({ PEERJS_DEBUG_LEVEL: input })).toThrow(
      /VITE_PEERJS_DEBUG_LEVEL/,
    );
  });

  test.each(["", "Console", "appliance"])(
    "refuses DEPLOYMENT_PROFILE %j",
    (input) => {
      expect(() => parseClientConfig({ DEPLOYMENT_PROFILE: input })).toThrow(
        /VITE_DEPLOYMENT_PROFILE/,
      );
    },
  );

  test.each(["", "   "])(
    "reads a blank SIGNALING_SERVER_URL %j as unset",
    (input) => {
      expect(
        parseClientConfig({ SIGNALING_SERVER_URL: input }).SIGNALING_SERVER_URL,
      ).toBeUndefined();
    },
  );

  test.each([
    [
      "wss://signaling.example.org",
      { secure: true, host: "signaling.example.org", path: "/" },
    ],
    [
      "wss://signaling.example.org:443/api",
      { secure: true, host: "signaling.example.org", path: "/api/" },
    ],
    [
      " ws://127.0.0.1:9000/api/ ",
      { secure: false, host: "127.0.0.1", port: 9000, path: "/api/" },
    ],
    [
      "wss://[::1]:8443/api/",
      { secure: true, host: "[::1]", port: 8443, path: "/api/" },
    ],
  ])("reads SIGNALING_SERVER_URL %j", (input, expected) => {
    expect(
      parseClientConfig({ SIGNALING_SERVER_URL: input }).SIGNALING_SERVER_URL,
    ).toStrictEqual(expected);
  });

  test.each([
    "signaling.example.org",
    "https://signaling.example.org/api/",
    "wss://",
    "wss://user:pw@signaling.example.org/",
    "wss://signaling.example.org/api/?key=x",
    "wss://signaling.example.org/api/?",
    "wss://signaling.example.org/api/#x",
    "wss://signaling.example.org/a@b/",
  ])("refuses SIGNALING_SERVER_URL %j", (input) => {
    expect(() => parseClientConfig({ SIGNALING_SERVER_URL: input })).toThrow(
      /VITE_SIGNALING_SERVER_URL/,
    );
  });

  test.each([
    ["ws://signaling.example.org/api/", "https:"],
    ["wss://signaling.example.org/api/", "http:"],
  ])("refuses SIGNALING_SERVER_URL %j under a %s page", (input, protocol) => {
    expect(() =>
      parseClientConfig({ SIGNALING_SERVER_URL: input }, protocol),
    ).toThrow(
      `Invalid build configuration: VITE_SIGNALING_SERVER_URL: ${SIGNALING_SCHEME_MISMATCH}.`,
    );
  });

  test.each([
    ["wss://signaling.example.org/api/", "https:"],
    ["ws://signaling.example.org/api/", "http:"],
  ])("accepts SIGNALING_SERVER_URL %j under a %s page", (input, protocol) => {
    expect(
      parseClientConfig({ SIGNALING_SERVER_URL: input }, protocol)
        .SIGNALING_SERVER_URL,
    ).toBeDefined();
  });

  test("names every offending variable in one refusal", () => {
    expect(() =>
      parseClientConfig({ PEERJS_DEBUG_LEVEL: "abc", DEPLOYMENT_PROFILE: "x" }),
    ).toThrow(/VITE_PEERJS_DEBUG_LEVEL.*VITE_DEPLOYMENT_PROFILE/);
  });

  test("ignores keys it does not define", () => {
    expect(parseClientConfig({ OTHER: "1" })).toEqual(parseClientConfig({}));
  });
});
