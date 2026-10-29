import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  MAX_PEER_ID_BYTES,
  safeParseConnectionConfig,
  safeParseFileSyncOptions,
} from "../../src/config/connection";
import {
  PEER_ID_RANDOM_HEX_LENGTH,
  SYSTEM_PEER_ID_FIELD_SOURCE,
  expandPeerIdTemplate,
  fixedPeerId,
  matchesPeerIdTemplate,
  parsePeerIdTemplate,
  peerIdTemplateBytes,
  type PeerIdFieldSource,
  type PeerIdPart,
} from "../../src/config/peerIdTemplate";

const parts = (peerId: string): Array<PeerIdPart> => {
  const parsed = parsePeerIdTemplate(peerId);
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.parts;
};

// 2026-10-28T23:30:05.123Z: late enough in the UTC day that most zones east
// of UTC are already on the 29th.
const PINNED_MS = Date.UTC(2026, 9, 28, 23, 30, 5, 123);
const pinned = (
  nowMs = PINNED_MS,
  randomHex = "0123456789abcdef",
): PeerIdFieldSource => ({ nowMs: () => nowMs, randomHex: () => randomHex });

const ZONE_PROBE = fileURLToPath(
  new URL("./peerIdTemplateZone.probe.ts", import.meta.url),
);

const options = (peerId: string) =>
  safeParseFileSyncOptions({ timestampInFilename: true, peerId });

const messagesOf = (
  result: ReturnType<typeof safeParseFileSyncOptions>,
): Array<string> =>
  result.success ? [] : result.error.issues.map((issue) => issue.message);

describe("parsePeerIdTemplate", () => {
  test("a value with no '%' is one literal, used as written", () => {
    expect(parts("agency-a")).toEqual([{ literal: "agency-a" }]);
    expect(fixedPeerId(parts("agency-a"))).toBe("agency-a");
  });

  test("splits literal text and fields anywhere, and reads %% as a literal '%'", () => {
    expect(parts("agency_%Y%m%d-%H%M%S")).toEqual([
      { literal: "agency_" },
      { field: "Y" },
      { field: "m" },
      { field: "d" },
      { literal: "-" },
      { field: "H" },
      { field: "M" },
      { field: "S" },
    ]);
    expect(parts("%K-site%%")).toEqual([{ field: "K" }, { literal: "-site%" }]);
    expect(fixedPeerId(parts("site%%1"))).toBe("site%1");
    expect(fixedPeerId(parts("site-%K"))).toBeUndefined();
  });

  test("refuses a field Alcove does not fill in, naming it", () => {
    for (const field of ["%q", "%N", "%s", "%R", "%z", "%:", "%1"]) {
      const parsed = parsePeerIdTemplate(`site_${field}`);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.problem).toContain(`'${field}'`);
      expect(parsed.problem).toContain("%K");
    }
  });

  test("names an astral character after '%' whole", () => {
    const parsed = parsePeerIdTemplate("site%\u{1F600}");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem).toContain("'%\u{1F600}'");
  });

  test("refuses a lone '%' at the end", () => {
    const parsed = parsePeerIdTemplate("site%");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem).toContain("ends with a single '%'");
  });
});

describe("expandPeerIdTemplate", () => {
  test("fills in the fields from the clock and random source", () => {
    expect(
      expandPeerIdTemplate(parts("%Y%m%d-site-%H%M%S-%K%%"), pinned()),
    ).toBe("20261028-site-233005-0123456789abcdef%");
  });

  describe("UTC whatever the process time zone", () => {
    for (const zone of ["Pacific/Kiritimati", "America/Los_Angeles"]) {
      test(zone, () => {
        const out = execFileSync(
          process.execPath,
          ["--import", "tsx", ZONE_PROBE, "%Y%m%d%H%M%S", String(PINNED_MS)],
          {
            encoding: "utf8",
            env: { ...process.env, TZ: zone },
            timeout: 10_000,
          },
        );
        const result = JSON.parse(out) as { local: string; expanded: string };
        // The zone took effect: local time is on another day or hour.
        expect(result.local).not.toBe("28 23");
        expect(result.expanded).toBe("20261028233005");
      });
    }
  });

  test("reads a fresh random value for each %K", () => {
    let calls = 0;
    const source: PeerIdFieldSource = {
      nowMs: () => PINNED_MS,
      randomHex: () => String(calls++).repeat(16),
    };
    expect(expandPeerIdTemplate(parts("%K-%K"), source)).toBe(
      `${"0".repeat(16)}-${"1".repeat(16)}`,
    );
  });

  test("the system random source gives 16 lowercase hex characters", () => {
    const first = expandPeerIdTemplate(
      parts("%K"),
      SYSTEM_PEER_ID_FIELD_SOURCE,
    );
    const second = expandPeerIdTemplate(
      parts("%K"),
      SYSTEM_PEER_ID_FIELD_SOURCE,
    );
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(second).toMatch(/^[0-9a-f]{16}$/);
    expect(first).not.toBe(second);
  });

  test("refuses a clock past year 9999 and a malformed random value", () => {
    expect(() =>
      expandPeerIdTemplate(parts("%Y"), pinned(Date.UTC(10000, 0, 1))),
    ).toThrow(RangeError);
    expect(() =>
      expandPeerIdTemplate(parts("%K"), pinned(PINNED_MS, "ABCDEF0123456789")),
    ).toThrow(RangeError);
  });
});

describe("matchesPeerIdTemplate", () => {
  const template = parts("site_%Y%m%d-%H%M%S-%K");

  test("matches every expansion and nothing else", () => {
    expect(
      matchesPeerIdTemplate(template, expandPeerIdTemplate(template, pinned())),
    ).toBe(true);
    expect(
      matchesPeerIdTemplate(
        template,
        expandPeerIdTemplate(template, pinned(0, "f".repeat(16))),
      ),
    ).toBe(true);
    for (const other of [
      "",
      "site",
      "site-2",
      "site_x",
      "site_20261028-233005",
      "site_20261028-233005-0123456789abcdeg",
      "site_20261028-233005-0123456789ABCDEF",
      "site_2026102x-233005-0123456789abcdef",
      "site_20261028-233005-0123456789abcdefx",
      "xsite_20261028-233005-0123456789abcdef",
    ])
      expect(matchesPeerIdTemplate(template, other), other).toBe(false);
  });

  test("matches a field at the start of the id", () => {
    const leading = parts("%Y%m%d-site");
    expect(matchesPeerIdTemplate(leading, "20261028-site")).toBe(true);
    expect(matchesPeerIdTemplate(leading, "site")).toBe(false);
  });
});

describe("peer_id fields in the configuration", () => {
  test("admits literal text and fields anywhere, with %%", () => {
    for (const peerId of [
      "agency-a",
      "agency-a_%Y%m%d-%H%M%S",
      "%Y%m%d-agency-a",
      "agency-a-%K",
      "run%%%K",
    ])
      expect(options(peerId).success, peerId).toBe(true);
  });

  test("refuses an unknown field and a lone '%'", () => {
    expect(messagesOf(options("site_%q"))).toEqual([
      "peer_id has the field '%q', which Alcove does not fill in. Use %Y, " +
        "%m, %d, %H, %M and %S (the UTC date and time), %K (16 random hex " +
        "characters), or %% for a literal '%'.",
    ]);
    expect(messagesOf(options("site%"))).toEqual([
      "peer_id ends with a single '%'. Write %% for a literal '%', or use " +
        "one of %Y, %m, %d, %H, %M and %S (the UTC date and time), %K (16 " +
        "random hex characters), or %% for a literal '%'.",
    ]);
  });

  test("holds the longest expansion to MAX_PEER_ID_BYTES", () => {
    const fields = "_%Y%m%d-%H%M%S-%K";
    const fieldBytes = peerIdTemplateBytes(parts(fields));
    expect(fieldBytes).toBe(1 + 8 + 1 + 6 + 1 + PEER_ID_RANDOM_HEX_LENGTH);
    const longest = `${"p".repeat(MAX_PEER_ID_BYTES - fieldBytes)}${fields}`;
    expect(options(longest).success).toBe(true);
    expect(messagesOf(options(`p${longest}`))).toEqual([
      `peer_id comes to ${MAX_PEER_ID_BYTES + 1} bytes of UTF-8 once its ` +
        `fields are filled in, over the ${MAX_PEER_ID_BYTES}-byte limit that ` +
        "keeps file names holding both parties' ids within 255 bytes. " +
        "Shorten peer_id or use fewer fields.",
    ]);
  });

  test("a value with no field keeps the cap and message it has always had", () => {
    expect(options("p".repeat(MAX_PEER_ID_BYTES)).success).toBe(true);
    expect(messagesOf(options("p".repeat(MAX_PEER_ID_BYTES + 1)))).toEqual([
      `peer_id must be at most ${MAX_PEER_ID_BYTES} bytes of UTF-8; the ` +
        "file names built from it would exceed the 255-byte limit",
    ]);
    // %% is one byte once filled in, so a literal '%' costs one byte.
    expect(options(`${"p".repeat(MAX_PEER_ID_BYTES - 1)}%%`).success).toBe(
      true,
    );
  });

  test("counts a multi-byte literal in UTF-8 bytes", () => {
    const longest = `${"p".repeat(MAX_PEER_ID_BYTES - 2 - 16)}é%K`;
    expect(options(longest).success).toBe(true);
    expect(options(`p${longest}`).success).toBe(false);
  });

  test("refuses the reserved id 'temp' however it is written, and admits a template that only starts with it", () => {
    expect(messagesOf(options("temp"))).toEqual([
      expect.stringContaining("peer_id 'temp' is reserved"),
    ]);
    expect(options("temp%K").success).toBe(true);
    expect(options("te%%mp").success).toBe(true);
  });

  test("is read unexpanded from a connection block", () => {
    const result = safeParseConnectionConfig({
      channel: "filedrop",
      path: "/mnt/share",
      options: {
        timestamp_in_filename: true,
        peer_id: "site_%Y%m%d-%H%M%S",
      },
    });
    expect(result.success).toBe(true);
    if (!result.success || result.data.channel !== "filedrop") return;
    expect(result.data.options?.peerId).toBe("site_%Y%m%d-%H%M%S");
  });
});
