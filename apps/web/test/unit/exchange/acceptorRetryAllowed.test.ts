import { describe, expect, test } from "vitest";

import { acceptorRetryAllowed } from "@exchange/useAcceptorExchange";

describe("acceptorRetryAllowed", () => {
  const now = new Date("2026-06-01T12:00:00Z");

  test("refuses a token with no expires", () => {
    expect(acceptorRetryAllowed(undefined, now)).toBe(false);
  });

  test("refuses an expired invitation", () => {
    expect(acceptorRetryAllowed("2026-06-01T11:59:59Z", now)).toBe(false);
  });

  test("allows a live invitation", () => {
    expect(acceptorRetryAllowed("2026-06-01T13:00:00Z", now)).toBe(true);
  });
});
