import { describe, expect, it } from "vitest";

import { DEFAULT_KEY_TABLE_PATH, KEY_TABLE_PATH_ENV } from "../src/keyTable.ts";
import {
  DEFAULT_RELAY_HOST,
  DEFAULT_RELAY_PORT,
  RelayOptionError,
  resolveRelayOptions,
} from "../src/standaloneOptions.ts";

describe("resolveRelayOptions", () => {
  it("defaults to loopback, an ephemeral port and the relay host's key table", () => {
    expect(resolveRelayOptions([], {})).toEqual({
      host: DEFAULT_RELAY_HOST,
      port: DEFAULT_RELAY_PORT,
      keyTablePath: DEFAULT_KEY_TABLE_PATH,
    });
  });

  it("reads each flag", () => {
    expect(
      resolveRelayOptions(
        ["--host", "0.0.0.0", "--port", "9443", "--key-table", "/tmp/turndb"],
        {},
      ),
    ).toEqual({ host: "0.0.0.0", port: 9443, keyTablePath: "/tmp/turndb" });
  });

  it("takes the key table from the environment relay_table.py reads, behind the flag", () => {
    const env = { [KEY_TABLE_PATH_ENV]: "/srv/turndb" };
    expect(resolveRelayOptions([], env).keyTablePath).toBe("/srv/turndb");
    expect(
      resolveRelayOptions(["--key-table", "/tmp/turndb"], env).keyTablePath,
    ).toBe("/tmp/turndb");
    expect(
      resolveRelayOptions([], { [KEY_TABLE_PATH_ENV]: " " }).keyTablePath,
    ).toBe(DEFAULT_KEY_TABLE_PATH);
  });

  it.each([
    [["--verbose"], "Unknown argument: --verbose"],
    [["9443"], "Unknown argument: 9443"],
    [["--port", "1", "--port", "2"], "--port may be given only once"],
    [["--host"], "--host requires a value"],
    [["--host", "--port", "1"], "--host requires a value"],
    [["--key-table", " "], "--key-table must not be empty"],
    [["--port", "65536"], "--port must be a whole number from 0 to 65535"],
    [["--port", "-1"], "--port must be a whole number from 0 to 65535"],
  ])("refuses %j", (argv, message) => {
    expect(() => resolveRelayOptions(argv, {})).toThrow(RelayOptionError);
    expect(() => resolveRelayOptions(argv, {})).toThrow(message);
  });
});
