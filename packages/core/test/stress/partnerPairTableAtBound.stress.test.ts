import { expect, test } from "vitest";

import {
  assertPartnerPairTable,
  MAX_PARTNER_ROWS_OF_ONE_ROW,
} from "../../src/utils/partnerIndices";
import { stressMemory } from "./stressMemory";

// A both-sided table's partner rows paired with one of this party's rows are
// checked in one V8 Set, which holds 2^24 entries (docs/spec/PROTOCOL.md, The
// limits over file-sync). The run at the bound fills one Set to 2^24 entries
// on the running engine: a few seconds and about 0.7 GB, which is why it is the
// opt-in tier. The refusal past the bound fills no Set and is in
// test/partnerPairTableRowLimit.test.ts.

const GIB = 1024 ** 3;
const NEED_GIB = 1;

test("one row paired with exactly the bound is accepted", (ctx) => {
  const memory = stressMemory();
  ctx.skip(
    memory.bytes / GIB < NEED_GIB,
    `the run at the bound needs ${NEED_GIB} GiB; this host's ` +
      `${memory.measure} is ${(memory.bytes / GIB).toFixed(1)} GiB`,
  );
  const partnerRows = Array.from(
    { length: MAX_PARTNER_ROWS_OF_ONE_ROW },
    (_, row) => row,
  );
  expect(() =>
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
        exclusiveBound: MAX_PARTNER_ROWS_OF_ONE_ROW + 1,
      },
      BigInt(MAX_PARTNER_ROWS_OF_ONE_ROW + 1),
    ),
  ).not.toThrow();
});
