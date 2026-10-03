import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("the CLI's copy of the stress memory gate", () => {
  it("is identical to the one the core stress cases share", () => {
    const read = (relative: string) =>
      readFileSync(new URL(relative, import.meta.url), "utf8");
    expect(read("../stress/stressMemory.ts")).toBe(
      read("../../../../packages/core/test/stress/stressMemory.ts"),
    );
  });
});
