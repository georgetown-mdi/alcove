import { describe, expect, test } from "vitest";

import {
  RECURRING_SETUP_HREF,
  arrivedForRecurringSetup,
} from "@exchange/recurringSetup";

describe("arrivedForRecurringSetup", () => {
  test("is true for the query the recurring entries link with", () => {
    expect(
      arrivedForRecurringSetup(
        new URL(RECURRING_SETUP_HREF, "https://x").search,
      ),
    ).toBe(true);
    expect(arrivedForRecurringSetup("?demo=1&recurring=1")).toBe(true);
  });

  test("is false for any other query", () => {
    expect(arrivedForRecurringSetup("")).toBe(false);
    expect(arrivedForRecurringSetup("?demo=1")).toBe(false);
    expect(arrivedForRecurringSetup("?recurring=0")).toBe(false);
  });
});
