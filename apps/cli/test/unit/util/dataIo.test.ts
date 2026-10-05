import { expect, test } from "vitest";

import { sanitizeErrorForDisplay } from "@alcove/core";

import { openInputSource } from "../../../src/util/dataIo";
import { InputNotFoundError } from "../../../src/util/exit";

test("openInputSource: a missing input that is a URL is named without its credentials", () => {
  let thrown: unknown;
  try {
    openInputSource("sfpt://alice:hunter2@host.example/drop");
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(InputNotFoundError);
  const rendered = sanitizeErrorForDisplay(thrown);
  expect(rendered).toBe("sfpt://host.example/drop does not exist");
  expect(rendered).not.toContain("alice");
  expect(rendered).not.toContain("hunter2");
});

test("openInputSource: a missing plain path is named as given", () => {
  let thrown: unknown;
  try {
    openInputSource("/nonexistent/alcove-input.csv");
  } catch (err) {
    thrown = err;
  }
  expect(sanitizeErrorForDisplay(thrown)).toBe(
    "/nonexistent/alcove-input.csv does not exist",
  );
});
