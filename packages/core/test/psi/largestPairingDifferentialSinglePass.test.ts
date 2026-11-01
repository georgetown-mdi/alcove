import { afterAll, beforeAll, expect, test, vi } from "vitest";

vi.mock("../../src/psi/roundResolution", async (importOriginal) =>
  (await import("../utils/greedyRoundSweep")).withGreedySwitch(
    await importOriginal(),
  ),
);

import {
  measureDifferential,
  RECORDS,
  withoutCollector,
} from "../utils/largestPairingDifferential";

// The single-pass half of the differential in largestPairingDifferential.test.ts.

let restoreCollector = () => {};
beforeAll(() => {
  restoreCollector = withoutCollector();
});
afterAll(() => restoreCollector());

test(
  `every pair set on ${RECORDS} records a side, under single-pass`,
  { timeout: 600_000 },
  async () => {
    expect(await measureDifferential("single-pass")).toStrictEqual({
      inputs: 512,
      runs: 512 * 2 * 2,
      inputsWhereTablesDiffer: 95,
      largestGainInPairs: 1,
      inputsWhoseTableDependsOnTheRole: 2,
    });
  },
);
