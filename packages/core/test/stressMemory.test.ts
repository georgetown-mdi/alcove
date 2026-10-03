import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { availableBytesFromMemoryPressure } from "./stress/stressMemory";

const SAMPLE = readFileSync(
  new URL("./fixtures/memoryPressureMacOS.txt", import.meta.url),
  "utf8",
);

describe("availableBytesFromMemoryPressure", () => {
  it("sums free, inactive and speculative pages of a recorded macOS sample", () => {
    expect(availableBytesFromMemoryPressure(SAMPLE)).toBe(
      (1122078 + 371063 + 83384) * 16384,
    );
  });

  it("is undefined when a figure is missing", () => {
    expect(
      availableBytesFromMemoryPressure(
        SAMPLE.replace(/^Pages inactive:.*$/m, ""),
      ),
    ).toBeUndefined();
    expect(availableBytesFromMemoryPressure("Pages free: 1\n")).toBeUndefined();
  });
});
