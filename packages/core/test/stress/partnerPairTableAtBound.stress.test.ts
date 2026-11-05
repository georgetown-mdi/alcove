import { expect, test, type TestContext } from "vitest";

import { ConnectionError, UsageError } from "../../src/errors";
import {
  assertPartnerPairTable,
  MAX_PARTNER_ROWS_OF_ONE_ROW,
} from "../../src/utils/partnerIndices";
import { stressMemory } from "./stressMemory";

// A both-sided table's partner rows paired with one of this party's rows are
// checked in one V8 Set, which holds 2^24 entries (docs/spec/PROTOCOL.md, The
// limits over file-sync). The run at the bound fills one Set to 2^24 entries
// on the running engine: a few seconds and about 0.7 GB. A run past the bound
// is checked in a sorted copy instead: repeating only its last entry, about
// 1.1 s and 67 MB beside its 0.3 GB of input; naming a row past 2^32, about
// 0.8 s and 134 MB. The other cases past the bound are in
// test/partnerPairTableRowLimit.test.ts.

const GIB = 1024 ** 3;
const NEED_GIB = 1;

function oneRowTable(
  partnerRows: ReadonlyArray<number>,
  partnerRecordCount: number,
) {
  return () =>
    assertPartnerPairTable(
      "starter",
      {
        what: "the local half",
        indices: new Array<number>(partnerRows.length).fill(0),
        exclusiveBound: 1,
      },
      {
        what: "the partner half",
        indices: partnerRows,
        exclusiveBound: partnerRecordCount,
      },
      BigInt(partnerRecordCount),
    );
}

function skipWithoutMemory(ctx: TestContext) {
  const memory = stressMemory();
  ctx.skip(
    memory.bytes / GIB < NEED_GIB,
    `the run needs ${NEED_GIB} GiB; this host's ` +
      `${memory.measure} is ${(memory.bytes / GIB).toFixed(1)} GiB`,
  );
}

test("one row paired with exactly the bound is accepted", (ctx) => {
  skipWithoutMemory(ctx);
  const partnerRows = Array.from(
    { length: MAX_PARTNER_ROWS_OF_ONE_ROW },
    (_, row) => row,
  );
  expect(
    oneRowTable(partnerRows, MAX_PARTNER_ROWS_OF_ONE_ROW + 1),
  ).not.toThrow();
});

test("one row paired past the bound with a repeat in its last entry is refused as a repeat", (ctx) => {
  skipWithoutMemory(ctx);
  const partnerRows = Array.from(
    { length: MAX_PARTNER_ROWS_OF_ONE_ROW + 1 },
    (_, entry) => (entry === MAX_PARTNER_ROWS_OF_ONE_ROW ? 0 : entry),
  );
  let failure: unknown;
  try {
    oneRowTable(partnerRows, MAX_PARTNER_ROWS_OF_ONE_ROW + 1)();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ConnectionError);
  expect(failure).not.toBeInstanceOf(UsageError);
  expect((failure as ConnectionError).kind).toBe("protocol");
  expect((failure as Error).message).toMatch(
    /names one row twice for one record of the other side/,
  );
});

test("a run past the bound naming row 2^32 beside row 0 is not read as a repeat", (ctx) => {
  skipWithoutMemory(ctx);
  const partnerRows = Array.from(
    { length: MAX_PARTNER_ROWS_OF_ONE_ROW + 1 },
    (_, entry) => (entry === MAX_PARTNER_ROWS_OF_ONE_ROW ? 2 ** 32 : entry),
  );
  expect(oneRowTable(partnerRows, 2 ** 32 + 1)).toThrow(UsageError);
});
