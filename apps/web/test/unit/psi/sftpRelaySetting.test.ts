import { afterEach, describe, expect, test, vi } from "vitest";

import {
  parseSftpRelayUrl,
  readSftpRelaySetting,
  sftpRelayForExchange,
  writeSftpRelaySetting,
} from "@psi/transport/sftpRelaySetting";

const STORAGE_KEY = "alcove-own-sftp-relay";
const OWN = "wss://relay.agency.example/sftp";
const PARTNER = "wss://sftp.partner.example/sftp";

/** A localStorage stand-in over a Map, returned so a test reads what was
 * written. */
function stubStorage(): Map<string, string> {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  });
  return values;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseSftpRelayUrl", () => {
  test("accepts a wss url, trimming the text around it", () => {
    expect(parseSftpRelayUrl(`  ${OWN}\n`)).toEqual({ ok: true, url: OWN });
  });

  test("blank text names none", () => {
    expect(parseSftpRelayUrl("   ")).toEqual({ ok: true });
  });

  test("refuses a scheme other than wss, with core's message", () => {
    expect(parseSftpRelayUrl("ws://relay.agency.example/sftp")).toEqual({
      ok: false,
      message:
        "The SFTP relay url must start with wss://; write it as a wss:// " +
        "url naming a host, an optional port, and a path, for example " +
        "wss://sftp.example.org/sftp",
    });
  });

  test.each([
    "wss://relay.agency.example@evil.example/sftp",
    "wss://relay.agency.example\\evil.example/sftp",
    "wss://relay.agency.example/sftp?x",
    "wss://relay.agency.example/sftp#x",
    "wss://relay.agency.example/s%66tp",
    "wss://relay.agency.example/s ftp",
  ])("refuses a delimiter: %s", (text) => {
    const entry = parseSftpRelayUrl(text);
    expect(entry.ok).toBe(false);
    if (entry.ok) return;
    expect(entry.message).toMatch(
      /^The SFTP relay url contains a space, a control character, or one of/,
    );
  });
});

describe("the stored SFTP relay", () => {
  test("reads back what was written, and clearing removes it", () => {
    const values = stubStorage();
    writeSftpRelaySetting(OWN);
    expect(JSON.parse(values.get(STORAGE_KEY) ?? "")).toStrictEqual({
      version: 1,
      url: OWN,
    });
    expect(readSftpRelaySetting()).toEqual({ kind: "set", url: OWN });
    writeSftpRelaySetting(undefined);
    expect(values.has(STORAGE_KEY)).toBe(false);
    expect(readSftpRelaySetting()).toEqual({ kind: "none" });
  });

  test("a stored url outside the rule is unreadable", () => {
    const values = stubStorage();
    values.set(
      STORAGE_KEY,
      JSON.stringify({ version: 1, url: "ws://relay.agency.example/sftp" }),
    );
    expect(readSftpRelaySetting()).toEqual({ kind: "unreadable" });
  });

  test("a stored value with another member or version is unreadable", () => {
    const values = stubStorage();
    values.set(
      STORAGE_KEY,
      JSON.stringify({ version: 1, url: OWN, credential: "not-a-real-one" }),
    );
    expect(readSftpRelaySetting()).toEqual({ kind: "unreadable" });
    values.set(STORAGE_KEY, JSON.stringify({ version: 2, url: OWN }));
    expect(readSftpRelaySetting()).toEqual({ kind: "unreadable" });
  });

  test("storage the browser refuses is unreadable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
    });
    expect(readSftpRelaySetting()).toEqual({ kind: "unreadable" });
  });
});

describe("sftpRelayForExchange", () => {
  test("this browser's own relay replaces the invitation's", () => {
    expect(
      sftpRelayForExchange(PARTNER, () => ({ kind: "set", url: OWN })),
    ).toEqual({ kind: "own", url: OWN });
  });

  test("with none set, the invitation's is used", () => {
    expect(sftpRelayForExchange(PARTNER, () => ({ kind: "none" }))).toEqual({
      kind: "invitation",
      url: PARTNER,
    });
  });

  test("with neither, none is chosen", () => {
    expect(sftpRelayForExchange(undefined, () => ({ kind: "none" }))).toEqual({
      kind: "none",
    });
  });

  test("an unreadable setting chooses neither, rather than the invitation's", () => {
    expect(
      sftpRelayForExchange(PARTNER, () => ({ kind: "unreadable" })),
    ).toEqual({ kind: "unreadable" });
  });
});
