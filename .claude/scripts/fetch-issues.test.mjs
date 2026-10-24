import { describe, expect, it } from "vitest";
import { runBoardScript, STUB_FIRST_ID } from "./lib/stubbedBoardRun.mjs";

describe("fetch-issues.mjs output", () => {
  it("exits quietly when the reader closes the pipe early", async () => {
    const run = await runBoardScript(
      "fetch-issues.mjs",
      ["9", String(STUB_FIRST_ID), String(STUB_FIRST_ID + 1)],
      { closeStdout: true },
    );
    expect(run.stderr).not.toMatch(/EPIPE/);
    expect(run.code).toBe(0);
  });

  it("prints each requested item when the reader keeps the pipe open", async () => {
    const run = await runBoardScript("fetch-issues.mjs", [
      "9",
      String(STUB_FIRST_ID),
    ]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`=== ${STUB_FIRST_ID} ===`);
  });
});
