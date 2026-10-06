import { expect, test } from "vitest";

import { MAX_PSI_DECODE_ELEMENTS } from "../../src/connection/frameSize";
import { RoundSetLimitError, UsageError } from "../../src/errors";
import {
  assertFirstRoundWithinSetMaximum,
  roundOneSetOverMaximumMessage,
} from "../../src/exchange";
import { sanitizeErrorForDisplay } from "../../src/utils/sanitizeErrorForDisplay";
import { DISPLAY_TRUNCATION_MARKER } from "../../src/utils/sanitizeForDisplay";
import {
  StandardizedDataset,
  StandardizedField,
} from "../../src/standardization";

import type { LinkageStrategy } from "../../src/config/linkageTermsSchema";
import type { CSVRow } from "../../src/file";
import { prepared } from "../utils/support";

// The first-round check every channel runs reads the prepared dataset,
// before any connection. The per-set maximum is lowered so the boundary is
// reached with a few hundred values.

function letters(i: number): string {
  let out = "";
  let n = i;
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  // A prefix no first-name cleaning shortens or maps onto another name.
  return `zq${out}`;
}

function preparedWith(
  firstNames: Array<string>,
  strategy: LinkageStrategy = "cascade",
  deduplicate = false,
) {
  return prepared(
    "Tester",
    firstNames.map((name) => ({ first_name: name })),
    { terms: { linkageStrategy: strategy, deduplicate } },
  );
}

test("the check's bound is the protocol's per-set maximum", () => {
  expect(MAX_PSI_DECODE_ELEMENTS).toBe(2 ** 24);
  expect(roundOneSetOverMaximumMessage(MAX_PSI_DECODE_ELEMENTS + 1)).toContain(
    `at least ${MAX_PSI_DECODE_ELEMENTS + 1} values to send, over the ` +
      `${MAX_PSI_DECODE_ELEMENTS} one PSI set can hold`,
  );
});

/** What the check under a per-set maximum of `maxValues` rejects with, or undefined. */
async function refusalOf(
  prepared: Parameters<typeof assertFirstRoundWithinSetMaximum>[0],
  maxValues: number,
): Promise<unknown> {
  try {
    await assertFirstRoundWithinSetMaximum(prepared, { maxValues });
  } catch (err) {
    return err;
  }
  return undefined;
}

test("the check refuses one value over the bound and admits one under and at it", async () => {
  // 300 values held by one record each, beside 40 records sharing 20 values:
  // the round drops a shared value, so 300 is the count the check weighs.
  const unique = Array.from({ length: 301 }, (_unused, i) => letters(i));
  const shared = Array.from({ length: 20 }, (_unused, i) => letters(1000 + i));
  const rows = (uniqueCount: number) => [
    ...unique.slice(0, uniqueCount),
    ...shared,
    ...shared,
  ];
  const bound = 300;

  expect(await refusalOf(preparedWith(rows(299)), bound)).toBeUndefined();
  expect(await refusalOf(preparedWith(rows(300)), bound)).toBeUndefined();
  const refusal = await refusalOf(preparedWith(rows(301)), bound);
  expect(refusal).toBeInstanceOf(RoundSetLimitError);
  expect((refusal as RoundSetLimitError).alcoveRecoveryHintEmitted).toBe(true);
  expect((refusal as RoundSetLimitError).reason).toBe("over-set-maximum");
  expect((refusal as Error).message).toMatch(
    /^Too large to send: .*at least 301 values to send, over the 300 one PSI set can hold\. Nothing was sent\. Split the input/,
  );
});

test("the first-round check counts every distinct value a deduplicating party sends", async () => {
  // 400 values each held by two records: a party that drops a shared value
  // sends none of them, one whose terms set deduplicate sends all 400.
  const values = Array.from({ length: 400 }, (_unused, i) => letters(i));
  const rows = [...values, ...values];
  const bound = 300;

  expect(
    await refusalOf(preparedWith(rows, "cascade", false), bound),
  ).toBeUndefined();
  const refusal = await refusalOf(preparedWith(rows, "cascade", true), bound);
  expect(refusal).toBeInstanceOf(RoundSetLimitError);
  expect((refusal as Error).message).toMatch(/at least 400 values to send/);
});

test("the check leaves a single-pass exchange to its dataset ceiling", async () => {
  const rows = Array.from({ length: 50 }, (_unused, i) => letters(i));
  expect(
    await refusalOf(preparedWith(rows, "single-pass"), 10),
  ).toBeUndefined();
  expect(await refusalOf(preparedWith(rows), 10)).toBeInstanceOf(
    RoundSetLimitError,
  );
});

/**
 * `prepared` reading its one field from `rowCount` rows, each of which throws
 * `failure` when read.
 */
function withThrowingRows(
  prepared: ReturnType<typeof preparedWith>,
  rowCount: number,
  failure: Error,
) {
  const rows = new Proxy<Array<CSVRow>>([], {
    get: (target, prop, receiver) => {
      if (prop === "length") return rowCount;
      if (typeof prop === "string" && /^[0-9]+$/.test(prop)) throw failure;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  const field = new StandardizedField("firstName", "first_name", [], rows);
  return {
    ...prepared,
    dataset: new StandardizedDataset(
      [field],
      prepared.linkageTerms.linkageKeys,
    ),
    rowCount,
  };
}

test("the check refuses, with the failure as its cause, when the count throws", async () => {
  const rowCount = 50;
  const prepared = preparedWith(
    Array.from({ length: rowCount }, (_unused, i) => letters(i)),
  );
  const failure = new RangeError("out of memory");
  const refusal = await refusalOf(
    withThrowingRows(prepared, rowCount, failure),
    10,
  );
  expect(refusal).toBeInstanceOf(RoundSetLimitError);
  expect((refusal as RoundSetLimitError).reason).toBe("uncounted");
  expect((refusal as Error).message).toMatch(
    /could not count .* one PSI set can hold them\. Nothing was sent\./,
  );
  expect((refusal as Error).cause).toBe(failure);
});

test("the check raises a refusal the count throws in both roles as it is", async () => {
  const rowCount = 50;
  const prepared = preparedWith(
    Array.from({ length: rowCount }, (_unused, i) => letters(i)),
  );
  const refusal = new UsageError("a refusal the round would raise");
  expect(
    await refusalOf(withThrowingRows(prepared, rowCount, refusal), 10),
  ).toBe(refusal);
});

test("the refusal survives the display boundary whole at the real bound", () => {
  // The remedy is the last sentence, and the render boundary truncates a link,
  // so a message that grows past it loses the part the operator acts on.
  const refusal = new RoundSetLimitError(
    roundOneSetOverMaximumMessage(MAX_PSI_DECODE_ELEMENTS * 10),
    "over-set-maximum",
  );
  const shown = sanitizeErrorForDisplay(refusal);
  expect(shown).not.toContain(DISPLAY_TRUNCATION_MARKER);
  expect(shown).toContain(
    "Split the input into smaller files and run one exchange for each.",
  );
});
