// A both-sided table's partner rows paired with one of this party's rows are
// checked in one V8 Set, which holds 2^24 entries (docs/spec/PROTOCOL.md, The
// limits over file-sync). Driven at the real bound: a run past it is refused
// before the Set is filled, and the run at it fills one Set to 2^24 entries
// on the running engine, which takes a few seconds and about 0.7 GB.

import { describe, expect, test } from "vitest";

import { MAX_SINGLE_PASS_CELLS } from "../src/connection/frameSize";
import {
  ConnectionError,
  statesItsOwnNextStep,
  UsageError,
} from "../src/errors";
import {
  assertPartnerPairTable,
  MAX_PARTNER_ROWS_OF_ONE_ROW,
} from "../src/utils/partnerIndices";

const PARTICIPANT = "starter";

// The first of this party's `localRecordCount` rows paired with `partnerRows`
// rows of a partner that has `partnerRecordCount`, held to the pair bound the
// two counts give.
function oneRowTable(
  partnerRows: ReadonlyArray<number>,
  counts: { localRecordCount: number; partnerRecordCount: number },
) {
  return () =>
    assertPartnerPairTable(
      PARTICIPANT,
      {
        what: "the local half",
        indices: new Array<number>(partnerRows.length).fill(0),
        exclusiveBound: counts.localRecordCount,
      },
      {
        what: "the partner half",
        indices: partnerRows,
        exclusiveBound: counts.partnerRecordCount,
      },
      BigInt(counts.localRecordCount) * BigInt(counts.partnerRecordCount),
    );
}

function failureOf(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("the partner rows paired with one row of a both-sided table", () => {
  test("the bound is the entries one Set holds", () => {
    expect(MAX_PARTNER_ROWS_OF_ONE_ROW).toBe(16_777_216);
  });

  test("over WebRTC the value-slot budget holds a partner under the bound", () => {
    expect(MAX_SINGLE_PASS_CELLS).toBeLessThan(MAX_PARTNER_ROWS_OF_ONE_ROW);
  });

  test("one row paired with one more than the bound is refused in plain words", () => {
    const pastBound = MAX_PARTNER_ROWS_OF_ONE_ROW + 1;
    const partnerRows = Array.from({ length: pastBound }, (_, row) => row);
    const failure = failureOf(
      oneRowTable(partnerRows, {
        localRecordCount: 1,
        partnerRecordCount: pastBound,
      }),
    );
    expect(failure).toBeInstanceOf(UsageError);
    expect(failure).not.toBeInstanceOf(RangeError);
    expect(statesItsOwnNextStep(failure)).toBe(true);
    expect((failure as Error).message).toBe(
      "one of your records matched more than 16,777,216 of your partner's " +
        "records, more than an exchange can pair with one record, so the " +
        "exchange stopped. A linkage key that matches almost every record, " +
        "such as one on a field with the same value in most rows, causes " +
        "this: agree on new terms with your partner that leave that key " +
        "out, and run the exchange again.",
    );
  });

  test("one row paired with exactly the bound is accepted", () => {
    const partnerRows = Array.from(
      { length: MAX_PARTNER_ROWS_OF_ONE_ROW },
      (_, row) => row,
    );
    expect(
      failureOf(
        oneRowTable(partnerRows, {
          localRecordCount: 1,
          partnerRecordCount: MAX_PARTNER_ROWS_OF_ONE_ROW + 1,
        }),
      ),
    ).toBeUndefined();
  });

  test("a run past the bound against a partner with no more rows than that repeats a row, and is refused as one", () => {
    const partnerRows = new Array<number>(MAX_PARTNER_ROWS_OF_ONE_ROW + 1).fill(
      0,
    );
    const failure = failureOf(
      oneRowTable(partnerRows, {
        localRecordCount: 2,
        partnerRecordCount: MAX_PARTNER_ROWS_OF_ONE_ROW,
      }),
    );
    expect(failure).toBeInstanceOf(ConnectionError);
    expect((failure as ConnectionError).kind).toBe("protocol");
    expect((failure as Error).message).toMatch(
      /names one row twice for one record of the other side/,
    );
  });
});
