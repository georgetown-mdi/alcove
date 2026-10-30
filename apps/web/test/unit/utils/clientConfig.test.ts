import { describe, expect, test } from "vitest";

import { defaultRelayBuildOf, parseClientConfig } from "@utils/clientConfig";
import { SIGNALING_SCHEME_MISMATCH } from "@utils/signalingScheme";

describe("parseClientConfig", () => {
  test("an empty build environment resolves every default", () => {
    expect(parseClientConfig({})).toEqual({
      PEERJS_DEBUG_LEVEL: 1,
      LOG_LEVEL: "INFO",
      DEPLOYMENT_PROFILE: "hosted",
      ALCOVE_VERSION: "",
      BUILD_COMMIT: "",
      SIGNALING_SERVER_URL: undefined,
      DEFAULT_RELAY_TURN_URL: "",
      DEFAULT_RELAY_REGISTRAR_URL: "",
      DEFAULT_RELAY_WEBSOCKET_URL: "",
      DEFAULT_RELAY_MODE: "opt-in",
    });
  });

  test("reads each value from its unprefixed key", () => {
    expect(
      parseClientConfig({
        PEERJS_DEBUG_LEVEL: "3",
        LOG_LEVEL: "DEBUG",
        DEPLOYMENT_PROFILE: "console",
        ALCOVE_VERSION: "1.2.3",
        BUILD_COMMIT: "0123abc",
        SIGNALING_SERVER_URL: "wss://signaling.example.org:8443/broker/",
      }),
    ).toEqual({
      PEERJS_DEBUG_LEVEL: 3,
      LOG_LEVEL: "DEBUG",
      DEPLOYMENT_PROFILE: "console",
      ALCOVE_VERSION: "1.2.3",
      BUILD_COMMIT: "0123abc",
      SIGNALING_SERVER_URL: {
        secure: true,
        host: "signaling.example.org",
        port: 8443,
        path: "/broker/",
      },
      DEFAULT_RELAY_TURN_URL: "",
      DEFAULT_RELAY_REGISTRAR_URL: "",
      DEFAULT_RELAY_WEBSOCKET_URL: "",
      DEFAULT_RELAY_MODE: "opt-in",
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

  test.each(["012345", "0123ABC", "0123abc ", "g123abc"])(
    "refuses BUILD_COMMIT %j",
    (input) => {
      expect(() => parseClientConfig({ BUILD_COMMIT: input })).toThrow(
        /VITE_BUILD_COMMIT/,
      );
    },
  );

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

  test("refuses a SIGNALING_SERVER_URL port of 0", () => {
    expect(() =>
      parseClientConfig({ SIGNALING_SERVER_URL: "wss://host:0/" }),
    ).toThrow(
      "Invalid build configuration: VITE_SIGNALING_SERVER_URL: the port must be 1 to 65535.",
    );
  });

  test("accepts the top SIGNALING_SERVER_URL port and folds a default port", () => {
    expect(
      parseClientConfig({ SIGNALING_SERVER_URL: "wss://host:65535/" })
        .SIGNALING_SERVER_URL,
    ).toStrictEqual({ secure: true, host: "host", port: 65535, path: "/" });
    expect(
      parseClientConfig({ SIGNALING_SERVER_URL: "ws://host:80/" })
        .SIGNALING_SERVER_URL,
    ).toStrictEqual({ secure: false, host: "host", path: "/" });
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

  test("reads the default relay's two values together", () => {
    const config = parseClientConfig({
      DEFAULT_RELAY_TURN_URL: " turns:turn.example.org:443?transport=tcp ",
      DEFAULT_RELAY_REGISTRAR_URL: "https://registrar.example.org",
    });
    expect(config.DEFAULT_RELAY_TURN_URL).toBe(
      "turns:turn.example.org:443?transport=tcp",
    );
    expect(config.DEFAULT_RELAY_REGISTRAR_URL).toBe(
      "https://registrar.example.org",
    );
  });

  test("reads the default relay's registrar as its origin", () => {
    const config = parseClientConfig({
      DEFAULT_RELAY_TURN_URL: "turns:turn.example.org:443",
      DEFAULT_RELAY_REGISTRAR_URL: "https://Registrar.example.org:443/",
    });
    expect(config.DEFAULT_RELAY_REGISTRAR_URL).toBe(
      "https://registrar.example.org",
    );
  });

  test.each([
    [
      { DEFAULT_RELAY_TURN_URL: "turns:turn.example.org:443" },
      /VITE_DEFAULT_RELAY_REGISTRAR_URL: is not set/,
    ],
    [
      { DEFAULT_RELAY_REGISTRAR_URL: "https://registrar.example.org" },
      /VITE_DEFAULT_RELAY_TURN_URL: is not set/,
    ],
    [
      {
        DEFAULT_RELAY_TURN_URL: "stun:stun.example.org:3478",
        DEFAULT_RELAY_REGISTRAR_URL: "https://registrar.example.org",
      },
      /VITE_DEFAULT_RELAY_TURN_URL: must be one turn: or turns: url/,
    ],
    [
      {
        DEFAULT_RELAY_TURN_URL: "turns:turn.example.org:443",
        DEFAULT_RELAY_REGISTRAR_URL: "http://registrar.example.org/path",
      },
      /VITE_DEFAULT_RELAY_REGISTRAR_URL: must be an https:\/\/ url/,
    ],
    [
      {
        DEFAULT_RELAY_TURN_URL: "turns:turn.example.org:443",
        DEFAULT_RELAY_REGISTRAR_URL: "https://registrar.example.org?",
      },
      /VITE_DEFAULT_RELAY_REGISTRAR_URL: must be an https:\/\/ url naming only a host and an optional port from 1 to 65535, for example https:\/\/registrar\.example\.org/,
    ],
    [
      { DEFAULT_RELAY_WEBSOCKET_URL: "wss://wsrelay.example.org/relay" },
      /VITE_DEFAULT_RELAY_WEBSOCKET_URL: is set without the default relay/,
    ],
    [
      {
        DEFAULT_RELAY_TURN_URL: "turns:turn.example.org:443",
        DEFAULT_RELAY_REGISTRAR_URL: "https://registrar.example.org",
        DEFAULT_RELAY_WEBSOCKET_URL: "wss://wsrelay.example.org/relay?x",
      },
      /VITE_DEFAULT_RELAY_WEBSOCKET_URL: must be one wss:\/\/ url/,
    ],
  ])("refuses the default relay %j", (data, message) => {
    expect(() => parseClientConfig(data)).toThrow(message);
  });

  test("reads the default WebSocket relay beside the default relay", () => {
    const config = parseClientConfig({
      DEFAULT_RELAY_TURN_URL: "turns:turn.example.org:443",
      DEFAULT_RELAY_REGISTRAR_URL: "https://registrar.example.org",
      DEFAULT_RELAY_WEBSOCKET_URL: " wss://wsrelay.example.org/relay ",
    });
    expect(config.DEFAULT_RELAY_WEBSOCKET_URL).toBe(
      "wss://wsrelay.example.org/relay",
    );
  });
});

describe("defaultRelayBuildOf", () => {
  const RELAY = {
    DEFAULT_RELAY_TURN_URL: "turns:turn.example.org:443",
    DEFAULT_RELAY_REGISTRAR_URL: "https://registrar.example.org",
  };
  const relay = {
    turnUrl: RELAY.DEFAULT_RELAY_TURN_URL,
    registrarUrl: RELAY.DEFAULT_RELAY_REGISTRAR_URL,
  };
  const buildOf = (data: Record<string, unknown>) =>
    defaultRelayBuildOf(parseClientConfig(data));

  test("names no relay where the build names none, whatever its mode", () => {
    expect(buildOf({})).toEqual({ kind: "none" });
    expect(buildOf({ DEFAULT_RELAY_MODE: "on" })).toEqual({ kind: "none" });
  });

  test.each([undefined, "", " opt-in "])(
    "offers the relay switched off where the mode is %j",
    (mode) => {
      expect(buildOf({ ...RELAY, DEFAULT_RELAY_MODE: mode })).toEqual({
        kind: "opt-in",
        relay,
      });
    },
  );

  test("turns the relay on where the mode is on", () => {
    expect(buildOf({ ...RELAY, DEFAULT_RELAY_MODE: "on" })).toEqual({
      kind: "on",
      relay,
    });
  });

  test("refuses any other mode", () => {
    expect(() => buildOf({ ...RELAY, DEFAULT_RELAY_MODE: "off" })).toThrow(
      /VITE_DEFAULT_RELAY_MODE: must be opt-in or on/,
    );
  });
});
