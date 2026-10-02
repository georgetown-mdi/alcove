import { describe, expect, it } from "vitest";

import { maxLoopLagSince } from "../stress/completionRun";

describe("the longest main-thread hold from a time on", () => {
  const since = Date.parse("2026-10-02T12:00:00.000Z");

  it("counts a hold by when it began, not when it ended", () => {
    const loopLags = [
      // Began 10 s before `since`, ended 2 s after it.
      { at: since + 2_000, lateMs: 12_000 },
      // Began 1 s after `since`.
      { at: since + 5_000, lateMs: 4_000 },
    ];
    expect(maxLoopLagSince({ loopLags }, since)).toBe(4_000);
  });

  it("counts a hold that began at or after the time in full", () => {
    const loopLags = [
      { at: since + 3_000, lateMs: 3_000 },
      { at: since + 20_000, lateMs: 9_000 },
    ];
    expect(maxLoopLagSince({ loopLags }, since)).toBe(9_000);
  });

  it("is 0 where no hold began from the time on", () => {
    expect(
      maxLoopLagSince({ loopLags: [{ at: since - 1, lateMs: 5_000 }] }, since),
    ).toBe(0);
  });
});
