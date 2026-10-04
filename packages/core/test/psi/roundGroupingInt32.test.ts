import { expect, test } from "vitest";

import { InternalConsistencyError } from "../../src/errors";
import { describeLocalRoundGrouping } from "../../src/psi/roundGrouping";

test("this party's own grouping refuses a row or a row total past 32 bits", () => {
  expect(() =>
    describeLocalRoundGrouping({ rows: [2 ** 31] }, [0], false),
  ).toThrow(InternalConsistencyError);
  expect(() =>
    describeLocalRoundGrouping(
      { rows: [0], groupStarts: [0, 2 ** 31] },
      [0],
      false,
    ),
  ).toThrow(InternalConsistencyError);
  expect(
    describeLocalRoundGrouping({ rows: [2 ** 31 - 1] }, [0], false)
      .rowOfOrdinal,
  ).toStrictEqual(new Int32Array([2 ** 31 - 1]));
});
