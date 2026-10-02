import { describe, expect, test } from "vitest";

import { parseClientConfig } from "@utils/clientConfig";

describe("parseClientConfig", () => {
  test("an empty build environment resolves every default", () => {
    expect(parseClientConfig({})).toEqual({
      PEERJS_DEBUG_LEVEL: 1,
      LOG_LEVEL: "INFO",
      DEPLOYMENT_PROFILE: "hosted",
      ALCOVE_VERSION: "",
    });
  });

  test("reads each value from its unprefixed key", () => {
    expect(
      parseClientConfig({
        PEERJS_DEBUG_LEVEL: "3",
        LOG_LEVEL: "DEBUG",
        DEPLOYMENT_PROFILE: "console",
        ALCOVE_VERSION: "1.2.3",
      }),
    ).toEqual({
      PEERJS_DEBUG_LEVEL: 3,
      LOG_LEVEL: "DEBUG",
      DEPLOYMENT_PROFILE: "console",
      ALCOVE_VERSION: "1.2.3",
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

  test("names every offending variable in one refusal", () => {
    expect(() =>
      parseClientConfig({ PEERJS_DEBUG_LEVEL: "abc", DEPLOYMENT_PROFILE: "x" }),
    ).toThrow(/VITE_PEERJS_DEBUG_LEVEL.*VITE_DEPLOYMENT_PROFILE/);
  });

  test("ignores keys it does not define", () => {
    expect(parseClientConfig({ OTHER: "1" })).toEqual(parseClientConfig({}));
  });
});
