import { expect, test } from "vitest";

import { recordFileStamp } from "../../src/records/recordFileStamp";

test("recordFileStamp replaces the colons and the fractional-second dot", () => {
  expect(recordFileStamp("2026-03-01T12:34:56.789Z")).toBe(
    "2026-03-01T12-34-56-789Z",
  );
  expect(recordFileStamp("2026-03-01T12:34:56Z")).toBe("2026-03-01T12-34-56Z");
});
