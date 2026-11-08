import { describe, expect, test, vi } from "vitest";

import { AuthenticationSchema } from "../src/config/connection";
import { decodeInvitation } from "../src/config/invitation";
import { KeyFileSchema, rotatedKeyExpires } from "../src/config/keyFile";
import { getDefaultLinkageTerms } from "../src/defaults/builtInLinkageTerms";
import { pruneRotationHistory } from "../src/rotationHistory";
import { rotationHistoryPruneFixtures } from "../src/rotationHistoryPruneFixtures";
import { encodeRawInvitation } from "./utils/support";

const SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VERIFIER = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM";

describe("pruneRotationHistory", () => {
  test.each(rotationHistoryPruneFixtures.map((f) => [f.label, f] as const))(
    "%s",
    (_label, fixture) => {
      const retired =
        fixture.retired === undefined
          ? []
          : [{ verifier: VERIFIER, ...fixture.retired }];
      const history = [...retired, ...fixture.history];
      expect(pruneRotationHistory(history, fixture.now, Date.parse)).toEqual(
        history.slice(0, fixture.kept),
      );
    },
  );

  test("an entry whose expires reads as NaN is removed as expired", () => {
    const live = { verifier: VERIFIER };
    const unread = { verifier: SECRET, expires: "unread" };
    const parseInstant = vi.fn(() => Number.NaN);
    expect(pruneRotationHistory([live, unread], 0, parseInstant)).toEqual([
      live,
    ]);
    expect(parseInstant).toHaveBeenCalledWith("unread");
  });

  test("leaves the history it is given as it was", () => {
    const history = Object.freeze([
      { verifier: VERIFIER, expires: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(pruneRotationHistory(history, Date.now(), Date.parse)).toEqual([]);
    expect(history).toHaveLength(1);
  });
});

// Each `expires` a history entry is written with is read through one of these
// schemas or stamped by rotatedKeyExpires as toISOString, so a history holds
// the "Z" form only, and the two apps' instant parsers agree on every entry.
describe("an instant a history entry takes is read in the Z form only", () => {
  const Z = "2030-01-01T00:00:00.000Z";
  const notZ = ["2030-01-01T00:00:00.000+00:00", "2030-01-01T00:00:00.000"];

  test.each(["expires", "previousExpires"] as const)(
    "the key file's %s",
    (field) => {
      const file = (instant: string) => ({
        sharedSecret: SECRET,
        ...(field === "previousExpires" && { previousSharedSecret: VERIFIER }),
        [field]: instant,
      });
      expect(KeyFileSchema.safeParse(file(Z)).success).toBe(true);
      for (const instant of notZ)
        expect(KeyFileSchema.safeParse(file(instant)).success).toBe(false);
    },
  );

  test("the key file's history entry", () => {
    const file = (instant: string) => ({
      sharedSecret: SECRET,
      rotationHistory: [{ verifier: VERIFIER, expires: instant }],
    });
    expect(KeyFileSchema.safeParse(file(Z)).success).toBe(true);
    for (const instant of notZ)
      expect(KeyFileSchema.safeParse(file(instant)).success).toBe(false);
  });

  test("a rotated secret's stamp", () => {
    const now = Date.parse("2026-06-01T12:34:56.789Z");
    for (const days of [1, 36500])
      expect(rotatedKeyExpires(days, now)).toMatch(/Z$/);
  });

  test("the config's authentication block", () => {
    const block = (instant: string) => ({
      sharedSecret: SECRET,
      expires: instant,
    });
    expect(AuthenticationSchema.safeParse(block(Z)).success).toBe(true);
    for (const instant of notZ)
      expect(AuthenticationSchema.safeParse(block(instant)).success).toBe(
        false,
      );
  });

  test("the invitation", async () => {
    const encoded = (instant: string) =>
      encodeRawInvitation({
        version: "1",
        linkageTerms: getDefaultLinkageTerms("Inviter Org"),
        sharedSecret: SECRET,
        expires: instant,
      });
    expect((await decodeInvitation(await encoded(Z))).expires).toBe(Z);
    for (const instant of notZ)
      await expect(decodeInvitation(await encoded(instant))).rejects.toThrow();
  });
});
