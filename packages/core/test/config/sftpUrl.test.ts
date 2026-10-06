import { describe, expect, test } from "vitest";

import { ConnectionConfigSchema } from "../../src/config/connection";
import {
  SftpPortSchema,
  formatSftpUrl,
  isBareSftpHost,
  parseSftpServerAddress,
  parseSftpUrl,
  sftpDialHost,
} from "../../src/config/sftpUrl";
import { joinFileSyncPath } from "../../src/connection/fileSyncPath";
import { UsageError } from "../../src/errors";

describe("parseSftpUrl", () => {
  test("decodes a percent-encoded directory", () => {
    expect(parseSftpUrl("sftp://host/my%20dir")).toEqual({
      host: "host",
      path: "/my dir",
    });
  });

  test("reads a path under /~/ as relative to the login directory", () => {
    expect(parseSftpUrl("sftp://host/~/drop/in").path).toBe("drop/in");
    expect(parseSftpUrl("sftp://host/~/my%20dir").path).toBe("my dir");
  });

  test("leaves the directory unset for no path, /, /~ and /~/", () => {
    for (const url of [
      "sftp://host",
      "sftp://host/",
      "sftp://host/~",
      "sftp://host/~/",
    ])
      expect(parseSftpUrl(url).path).toBeUndefined();
  });

  test("reads an encoded ~ as a literal absolute directory", () => {
    expect(parseSftpUrl("sftp://host/%7E/drop").path).toBe("/~/drop");
  });

  test("decodes a %-bearing path once", () => {
    expect(parseSftpUrl("sftp://host/50%2525/off").path).toBe("/50%25/off");
  });

  test("refuses an encoded slash in any path segment", () => {
    for (const url of [
      "sftp://host/~/%2Fetc",
      "sftp://host/~/%2fetc/x",
      "sftp://host/%2Fetc",
      "sftp://host/%2F%2Fetc",
      "sftp://host/srv/a%2Fb",
      "sftp://host/~/drop/a%2F..%2Fb",
    ])
      expect(() => parseSftpUrl(url)).toThrow(/encoded slash/);
  });

  test("decodes the host, username and password", () => {
    expect(parseSftpUrl("ssh://us%40er:p%3Ass@h%C3%A9st:2222/x")).toEqual({
      host: "h\u00e9st",
      port: 2222,
      username: "us@er",
      password: "p:ss",
      path: "/x",
    });
  });

  test("removes the brackets from an IPv6 literal", () => {
    expect(parseSftpUrl("sftp://[2001:db8::1]:22/x")).toEqual({
      host: "2001:db8::1",
      port: 22,
      path: "/x",
    });
  });

  test("refuses port 0", () => {
    expect(() => parseSftpUrl("sftp://host:0/x")).toThrow(
      /port must be from 1 to 65535/,
    );
  });

  test("refuses the whole URL on a malformed escape, without its password", () => {
    for (const url of [
      "sftp://user:secret@host/bad%zzpath",
      "sftp://user:secret@host/%",
      "sftp://us%zz:secret@host/x",
      "sftp://user:sec%ret@host/x",
    ]) {
      let thrown: unknown;
      try {
        parseSftpUrl(url);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(UsageError);
      expect((thrown as Error).message).toMatch(/malformed percent-encoding/);
      expect((thrown as Error).message).not.toMatch(/secret|sec%ret/);
    }
  });

  test("refuses a decoded host that is not a bare address", () => {
    for (const url of ["sftp://a%2Fb/", "sftp://a%40b/", "sftp://a%20b/"])
      expect(() => parseSftpUrl(url)).toThrow(/server name or IP address/);
    expect(() => parseSftpUrl("sftp://a%C2%85b/x")).toThrow(
      /server name or IP address/,
    );
  });

  test("refuses a URL with no host, a query, a fragment, or another scheme", () => {
    expect(() => parseSftpUrl("sftp:///drop")).toThrow(/must include a host/);
    expect(() => parseSftpUrl("sftp://host/drop?x")).toThrow(/query/);
    expect(() => parseSftpUrl("sftp://host/drop#x")).toThrow(/fragment/);
    expect(() => parseSftpUrl("https://host/drop")).toThrow(/sftp:\/\//);
    expect(() => parseSftpUrl("not a url")).toThrow(UsageError);
  });
});

describe("parseSftpServerAddress", () => {
  test("reads the host and port without decoding the userinfo", () => {
    expect(
      parseSftpServerAddress("sftp://us%er:50%@[::1]:2222/x%zz?q#f"),
    ).toEqual({ host: "::1", port: 2222 });
    expect(parseSftpServerAddress("ssh://host")).toEqual({ host: "host" });
  });

  test("refuses what parseSftpUrl refuses about the host and port", () => {
    expect(() => parseSftpServerAddress("sftp:///x")).toThrow(/host/);
    expect(() => parseSftpServerAddress("sftp://h:0")).toThrow(/1 to 65535/);
    expect(() => parseSftpServerAddress("sftp://a%2Fb")).toThrow(/server name/);
    expect(() => parseSftpServerAddress("https://h")).toThrow(/sftp:\/\//);
  });
});

describe("isBareSftpHost", () => {
  test("accepts a host name, an IPv4, and an IPv6 literal with or without brackets", () => {
    for (const host of [
      "sftp.example.org",
      "partner-host.internal",
      "10.0.0.5",
      "[2001:db8::1]",
      "2001:db8::1",
      "::ffff:10.0.0.5",
    ])
      expect(isBareSftpHost(host)).toBe(true);
  });

  test("refuses userinfo, separators, delimiters, a port, whitespace and controls", () => {
    for (const host of [
      "",
      "user@host",
      "sftp://host",
      "sftp.example.org/drop",
      "sftp .example.org",
      "foo#bar",
      "foo?bar",
      "foo\\bar",
      "foo%00",
      "host:22",
      "[host]",
      "[::1",
      "::1]",
      "[::1]:22",
      "a\u0000b",
      "a\u007fb",
      "a\u0085b",
      "a\u202eb",
      "a\u200bb",
    ])
      expect(isBareSftpHost(host)).toBe(false);
  });

  test("sftpDialHost removes only an IPv6 literal's brackets", () => {
    expect(sftpDialHost("[::1]")).toBe("::1");
    expect(sftpDialHost("::1")).toBe("::1");
    expect(sftpDialHost("host")).toBe("host");
  });
});

describe("SftpPortSchema", () => {
  test("accepts 1 through 65535 and refuses 0", () => {
    expect(SftpPortSchema.safeParse(1).success).toBe(true);
    expect(SftpPortSchema.safeParse(65535).success).toBe(true);
    expect(SftpPortSchema.safeParse(0).success).toBe(false);
    expect(SftpPortSchema.safeParse(65536).success).toBe(false);
    expect(SftpPortSchema.safeParse(2.5).success).toBe(false);
  });

  test("an sftp connection refuses port 0", () => {
    const parsed = ConnectionConfigSchema.safeParse({
      channel: "sftp",
      server: { host: "h", port: 0 },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("formatSftpUrl", () => {
  test.each([
    ["unset", undefined],
    ["empty", ""],
    ["relative", "drop/in"],
    ["relative with a space", "my dir"],
    ["relative starting with ~", "~/x"],
    ["absolute", "/srv/drop"],
    ["absolute literal ~", "/~"],
    ["absolute under literal ~", "/~/drop"],
    ["%-bearing", "50%25 off/a%zz"],
    ["URL delimiters", "a?b/c#d/e\\f"],
    ["trailing slash", "drop/"],
    ["empty segment", "a//b"],
    ["non-ASCII", "d\u00e9p\u00f4t"],
  ])("a %s directory reads back unchanged", (_label, path) => {
    const url = formatSftpUrl({ host: "sftp.example.org", port: 2222, path });
    const readBack = parseSftpUrl(url);
    expect(readBack.path).toBe(path === "" ? undefined : path);
    expect(readBack.host).toBe("sftp.example.org");
    expect(readBack.port).toBe(2222);
  });

  test("writes a relative directory under /~/ and leaves an unset one off", () => {
    expect(formatSftpUrl({ host: "h", path: "drop" })).toBe("sftp://h/~/drop");
    expect(formatSftpUrl({ host: "h" })).toBe("sftp://h");
  });

  test("brackets an IPv6 literal and adopts its canonical form", () => {
    for (const host of ["2001:0db8::0001", "[2001:DB8::1]", "2001:db8::1"])
      expect(formatSftpUrl({ host, port: 22 })).toBe("sftp://[2001:db8::1]:22");
  });

  test("writes every / as a separator, never as an encoded slash", () => {
    for (const path of ["/srv/a/b", "a/b", "/a%2Fb"]) {
      const url = formatSftpUrl({ host: "h", path });
      expect(url).not.toMatch(/%2F/i);
      expect(parseSftpUrl(url).path).toBe(path);
    }
    expect(formatSftpUrl({ host: "h", path: "/a%2Fb" })).toBe(
      "sftp://h/a%252Fb",
    );
  });

  test("refuses a directory with no URL form that reads back unchanged", () => {
    for (const path of ["./drop", "a/../b", "/", "drop/."])
      expect(() => formatSftpUrl({ host: "h", path })).toThrow(/reads back/);
  });

  test("refuses a host that is not bare, and port 0", () => {
    expect(() => formatSftpUrl({ host: "foo#bar" })).toThrow(/bare/);
    expect(() => formatSftpUrl({ host: "h", port: 0 })).toThrow(/1-65535/);
  });
});

describe("joinFileSyncPath", () => {
  test("keeps a name relative in the login directory", () => {
    expect(joinFileSyncPath("", "hello.json")).toBe("hello.json");
  });

  test("joins under a directory, the root, and a drive root", () => {
    expect(joinFileSyncPath("drop", "x")).toBe("drop/x");
    expect(joinFileSyncPath("/srv/drop", "x")).toBe("/srv/drop/x");
    expect(joinFileSyncPath("/", "x")).toBe("/x");
    expect(joinFileSyncPath("C:/", "x")).toBe("C:/x");
  });
});
