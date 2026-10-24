import { describe, expect, it } from "vitest";
import { runBoardScript, STUB_EPIC } from "./lib/stubbedBoardRun.mjs";

describe("list-epic.mjs output", () => {
  it("exits quietly when the reader closes the pipe early", async () => {
    const run = await runBoardScript("list-epic.mjs", ["9", STUB_EPIC], {
      closeStdout: true,
    });
    expect(run.stderr).not.toMatch(/EPIPE/);
    expect(run.code).toBe(0);
  });
});
