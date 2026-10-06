import { describe, expect, test } from "vitest";

import {
  INVITATION_LIFETIME_SECONDS,
  MAX_INVITATION_LIFETIME_SECONDS,
  assertInvitationLifetimeSeconds,
  invitationExpires,
} from "../../src/config/invitation";

const MINTED_AT = Date.parse("2026-03-01T12:00:00.000Z");

describe("invitationExpires", () => {
  test("is the mint moment plus the lifetime", () => {
    expect(invitationExpires(INVITATION_LIFETIME_SECONDS, MINTED_AT)).toBe(
      "2026-03-01T13:00:00.000Z",
    );
  });

  test("admits a lifetime at the ceiling", () => {
    expect(() =>
      invitationExpires(MAX_INVITATION_LIFETIME_SECONDS, MINTED_AT),
    ).not.toThrow();
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a lifetime of %s seconds",
    (seconds) => {
      expect(() => invitationExpires(seconds, MINTED_AT)).toThrow(RangeError);
      expect(() => assertInvitationLifetimeSeconds(seconds)).toThrow(
        /finite, positive number of seconds/,
      );
    },
  );

  test("refuses a lifetime past the one-year ceiling", () => {
    expect(() =>
      invitationExpires(MAX_INVITATION_LIFETIME_SECONDS + 1, MINTED_AT),
    ).toThrow(/must not exceed/);
  });
});
