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

// The cascade half of the differential between the one-to-one resolution and
// the greedy sweep it replaced (largestPairingDifferential.ts states what each
// run asserts); the single-pass half is its own file so the two run side by
// side.

let restoreCollector = () => {};
beforeAll(() => {
  restoreCollector = withoutCollector();
});
afterAll(() => restoreCollector());

test(
  `every pair set on ${RECORDS} records a side, under the cascade`,
  { timeout: 600_000 },
  async () => {
    expect(await measureDifferential("cascade")).toStrictEqual({
      inputs: 512,
      runs: 512 * 2 * 2,
      inputsWhereTablesDiffer: 95,
      largestGainInPairs: 1,
      inputsWhoseTableDependsOnTheRole: 2,
    });
  },
);
