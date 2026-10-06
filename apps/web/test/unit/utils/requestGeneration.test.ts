import { describe, expect, test } from "vitest";

import { createRequestGeneration } from "@utils/requestGeneration";

describe("createRequestGeneration", () => {
  test("the latest request is current", () => {
    const generation = createRequestGeneration();
    const token = generation.next();
    expect(generation.isCurrent(token)).toBe(true);
  });

  test("a newer request makes the older one stale", () => {
    const generation = createRequestGeneration();
    const older = generation.next();
    const newer = generation.next();
    expect(generation.isCurrent(older)).toBe(false);
    expect(generation.isCurrent(newer)).toBe(true);
  });

  test("invalidating leaves no request current", () => {
    const generation = createRequestGeneration();
    const token = generation.next();
    generation.invalidate();
    expect(generation.isCurrent(token)).toBe(false);
  });

  test("each generation counts on its own", () => {
    const first = createRequestGeneration();
    const second = createRequestGeneration();
    const token = first.next();
    second.next();
    second.invalidate();
    expect(first.isCurrent(token)).toBe(true);
  });
});
