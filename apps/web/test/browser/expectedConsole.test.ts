import { afterEach, describe, expect, test, vi } from "vitest";
import { getLogger } from "@alcove/core";

import { expectConsole } from "./expectedConsole";

const log = getLogger("expectedConsoleTest");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("expectConsole", () => {
  test("keeps a declared line off the console and passes an undeclared one through", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expectConsole("error", "Error: kex failed", /^the run stopped: /);

    console.error(new Error("kex failed"));
    console.error("the run stopped:", "transport");
    console.error(new Error("kex failed, differently"));

    expect(error.mock.calls).toEqual([[new Error("kex failed, differently")]]);
  });

  test("matches a line by level", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expectConsole("error", "the same text");
    console.error("the same text");
    console.warn("the same text");
    expect(warn).toHaveBeenCalledOnce();
  });

  test("reaches a core logger's line, rendered without its prefix", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expectConsole("warn", 'rejected 1 file(s): ["file-invalid-type"]');

    log.warn("rejected 1 file(s):", ["file-invalid-type"]);
    log.warn("an unrelated warning");

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.slice(1)).toEqual(["an unrelated warning"]);
  });

  test("waits for a declared line logged after the test body ends", () => {
    expectConsole("error", "Error: late");
    setTimeout(() => console.error(new Error("late")), 100);
  });

  test.fails("fails the test when a declared line is never logged", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expectConsole("error", "Error: never logged");
    console.error(new Error("logged instead"));
  });
});
