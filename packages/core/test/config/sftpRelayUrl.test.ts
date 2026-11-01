import { describe, expect, test } from "vitest";

import { UsageError } from "../../src/errors";
import {
  MAX_SFTP_RELAY_URL_LENGTH,
  SftpRelayUrlError,
  sftpRelayUrlRefusal,
} from "../../src/config/sftpRelayUrl";

const NAME = "the SFTP relay url";

describe("sftpRelayUrlRefusal", () => {
  test.each([
    ["a host and path", "wss://sftp.example.org/sftp"],
    ["a port", "wss://sftp.example.org:8443/sftp"],
    ["an IPv6 literal", "wss://[2001:db8::1]/sftp"],
    ["an IPv4 literal", "wss://192.0.2.1/sftp"],
    ["an empty path without its slash", "wss://sftp.example.org"],
    ["an empty path with its slash", "wss://sftp.example.org/"],
    ["a longer path", "wss://edge.example.org/partners/county/sftp"],
  ])("accepts %s", (_shape, url) => {
    expect(sftpRelayUrlRefusal(url, NAME)).toBeUndefined();
  });

  test.each([
    ["ws", "ws://sftp.example.org/sftp"],
    ["https", "https://sftp.example.org/sftp"],
    ["http", "http://sftp.example.org/sftp"],
    ["sftp", "sftp://sftp.example.org/sftp"],
    ["ssh", "ssh://sftp.example.org"],
  ])("refuses the %s scheme as notWss", (_scheme, url) => {
    const refusal = sftpRelayUrlRefusal(url, NAME);
    expect(refusal).toBeInstanceOf(SftpRelayUrlError);
    expect(refusal).toBeInstanceOf(UsageError);
    expect(refusal?.name).toBe("SftpRelayUrlError");
    expect(refusal?.problem).toBe("notWss");
    expect(refusal?.message).toBe(
      "the SFTP relay url must start with wss://; write it as a wss:// url " +
        "naming a host, an optional port, and a path, for example " +
        "wss://sftp.example.org/sftp",
    );
  });

  // One case for each refused character, so a set narrowed by a later edit
  // fails here.
  test.each([
    ["userinfo", "wss://sftp.example.org@evil.example.org/sftp"],
    ["a user and password", "wss://user:pass@sftp.example.org/sftp"],
    ["a backslash in the host", "wss://sftp.example.org\\evil.example.org/"],
    ["a backslash in the path", "wss://sftp.example.org/a\\b"],
    ["a query", "wss://sftp.example.org/sftp?x=1"],
    ["an empty query", "wss://sftp.example.org/sftp?"],
    ["a fragment", "wss://sftp.example.org/sftp#x"],
    ["a percent-escape", "wss://sftp.example.org/%73ftp"],
    ["a space", "wss://sftp.example.org/s ftp"],
    ["a tab", "wss://sftp.example.org/s\tftp"],
    ["a newline", "wss://sftp.example\n.org/sftp"],
    ["a leading space", " wss://sftp.example.org/sftp"],
    ["a no-break space", "wss://sftp.example.org/s\u00a0ftp"],
    ["a NUL", "wss://sftp.example.org/s\u0000ftp"],
    ["a DEL", "wss://sftp.example.org/s\u007fftp"],
    ["a C1 control", "wss://sftp.example.org/s\u0085ftp"],
  ])("refuses %s as delimiter", (_shape, url) => {
    const refusal = sftpRelayUrlRefusal(url, NAME);
    expect(refusal).toBeInstanceOf(SftpRelayUrlError);
    expect(refusal?.problem).toBe("delimiter");
    expect(refusal?.message).toMatch(
      /^the SFTP relay url contains a space, a control character, or one of @ \\ \? # %;/,
    );
  });

  test("a refusal of a url holding @ does not repeat the url", () => {
    const refusal = sftpRelayUrlRefusal(
      "wss://user:not-a-real-password@sftp.example.org/sftp",
      NAME,
    );
    expect(refusal?.message).not.toContain("not-a-real-password");
  });

  test("refuses text that is not a url", () => {
    expect(sftpRelayUrlRefusal("sftp.example.org/sftp", NAME)?.problem).toBe(
      "notUrl",
    );
    expect(sftpRelayUrlRefusal("wss://", NAME)?.problem).toBe("notUrl");
  });

  test("refuses port 0", () => {
    expect(
      sftpRelayUrlRefusal("wss://sftp.example.org:0/sftp", NAME)?.problem,
    ).toBe("portZero");
  });

  test.each([
    [
      "an upper-case host",
      "wss://SFTP.example.org/sftp",
      "wss://sftp.example.org/sftp",
    ],
    [
      "the default port",
      "wss://sftp.example.org:443/sftp",
      "wss://sftp.example.org/sftp",
    ],
    [
      "a dot segment",
      "wss://sftp.example.org/a/../sftp",
      "wss://sftp.example.org/sftp",
    ],
    [
      "a character the parser escapes",
      "wss://sftp.example.org/a<b",
      "wss://sftp.example.org/a%3Cb",
    ],
    [
      "a mapped label separator",
      "wss://sftp\u3002example.org/sftp",
      "wss://sftp.example.org/sftp",
    ],
  ])(
    "refuses %s as notCanonical, naming the canonical form",
    (_shape, url, canonical) => {
      const refusal = sftpRelayUrlRefusal(url, NAME);
      expect(refusal?.problem).toBe("notCanonical");
      expect(refusal?.message).toBe(
        `the SFTP relay url is not in canonical form; write it as ${canonical}`,
      );
    },
  );

  test("refuses a url longer than the bound, and admits one at it", () => {
    const prefix = "wss://sftp.example.org/";
    const atBound =
      prefix + "a".repeat(MAX_SFTP_RELAY_URL_LENGTH - prefix.length);
    expect(sftpRelayUrlRefusal(atBound, NAME)).toBeUndefined();
    expect(sftpRelayUrlRefusal(`${atBound}a`, NAME)?.problem).toBe("tooLong");
  });
});
