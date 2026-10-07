import { afterEach, expect, test, vi } from "vitest";

import { RoundSetLimitError, UsageError } from "../../src/errors";
import { prepareForExchange } from "../../src/exchange";
import { assertFirstRoundWithinSetMaximum } from "../../src/exchange/firstRoundCapacity";
import {
  fanOutReachedMatchingRefusal,
  StandardizedDataset,
  StandardizedField,
  StandardizedKeyIterable,
} from "../../src/standardization";
import { getLogger } from "../../src/utils/logger";

import type { LinkageStrategy } from "../../src/config/linkageTermsSchema";
import type { CSVRow } from "../../src/file";
import type { PsiProgress } from "../../src/psi/participant";
import { prepared } from "../utils/support";

// The first-round count reads the prepared dataset, before any connection.
// The per-set maximum is lowered so the bound is reached with a few hundred
// values.

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

/** What `check` rejects with, or undefined where it resolves. */
async function refusalOf(check: Promise<void>): Promise<unknown> {
  try {
    await check;
  } catch (err) {
    return err;
  }
  return undefined;
}

test("a deduplicating party's count stops once its set is over the bound", async () => {
  // 3000 distinct values against a bound of 300: the size only grows, so the
  // count stops at the first clock check past the bound, in each role.
  const rows = Array.from({ length: 3000 }, (_unused, i) => letters(i));
  const reports: Array<PsiProgress> = [];
  const refusal = await refusalOf(
    assertFirstRoundWithinSetMaximum(preparedWith(rows, "cascade", true), {
      maxValues: 300,
      onProgress: (progress) => reports.push(progress),
    }),
  );
  expect(refusal).toBeInstanceOf(RoundSetLimitError);
  expect((refusal as Error).message).toMatch(/at least 1024 values to send/);
  expect(reports.map((report) => report.state)).toEqual([
    "started",
    "finished",
    "started",
    "finished",
  ]);
  // The settle reports carry the rows the count actually walked (1024, the
  // first clock check past the bound), not the dataset's full row count.
  expect(
    reports
      .filter((report) => report.state === "finished")
      .map((report) => report.elements),
  ).toEqual([1024, 1024]);
});

test("the first-round count reports its progress through both roles", async () => {
  const rowCount = 5000;
  const rows = Array.from({ length: rowCount }, (_unused, i) => letters(i));
  const reports: Array<PsiProgress> = [];
  const refusal = await refusalOf(
    assertFirstRoundWithinSetMaximum(preparedWith(rows), {
      maxValues: 300,
      onProgress: (progress) => reports.push(progress),
      progressIntervalMs: 0,
    }),
  );
  expect(refusal).toBeInstanceOf(RoundSetLimitError);
  const pass = [
    { state: "started" },
    { state: "progress", processed: 1024 },
    { state: "progress", processed: 2048 },
    { state: "progress", processed: 3072 },
    { state: "progress", processed: 4096 },
    { state: "finished" },
  ];
  expect(reports.map(({ state, processed }) => ({ state, processed }))).toEqual(
    [...pass, ...pass].map((report) => ({ processed: undefined, ...report })),
  );
  for (const report of reports) {
    expect(report.operation).toBe("countFirstRoundValues");
    expect(report.elements).toBe(rowCount);
    expect(report.durationMs !== undefined).toBe(report.state === "finished");
  }
});

test("the first-round count reports nothing for an input whose records cannot reach the bound", async () => {
  const reports: Array<PsiProgress> = [];
  await assertFirstRoundWithinSetMaximum(
    preparedWith(Array.from({ length: 50 }, (_unused, i) => letters(i))),
    {
      maxValues: 300,
      onProgress: (progress) => reports.push(progress),
    },
  );
  expect(reports).toEqual([]);
});

test("the first-round count drops a raise on a progress report, and a raise on any other reaches the caller", async () => {
  const rows = Array.from({ length: 5000 }, (_unused, i) => letters(i));
  const maxValues = 300;
  const display = new Error("display fault");
  const onProgress = (throwOn: PsiProgress["state"]) => (p: PsiProgress) => {
    if (p.state === throwOn) throw display;
  };
  const progressRefusal = await refusalOf(
    assertFirstRoundWithinSetMaximum(preparedWith(rows), {
      maxValues,
      onProgress: onProgress("progress"),
      progressIntervalMs: 0,
    }),
  );
  expect(progressRefusal).toBeInstanceOf(RoundSetLimitError);
  expect(
    await refusalOf(
      assertFirstRoundWithinSetMaximum(preparedWith(rows), {
        maxValues,
        onProgress: onProgress("started"),
      }),
    ),
  ).toBe(display);
});

test("the first-round count yields to the event loop as it reports", async () => {
  const rows = Array.from({ length: 5000 }, (_unused, i) => letters(i));
  let timerRan = false;
  let progressAfterTimer = false;
  setTimeout(() => {
    timerRan = true;
  }, 0);
  await refusalOf(
    assertFirstRoundWithinSetMaximum(preparedWith(rows), {
      maxValues: 300,
      onProgress: (progress) => {
        if (progress.state === "progress" && timerRan)
          progressAfterTimer = true;
      },
      progressIntervalMs: 0,
    }),
  );
  expect(progressAfterTimer).toBe(true);
});

test("the first-round check raises the fan-out refusal for a candidate set a count-only round refuses", async () => {
  const split = [{ function: "split_on", params: { delimiter: " " } }];
  const cascade = prepareForExchange(
    {
      linkageTerms: {
        version: "1.0.0",
        date: "2026-01-01",
        algorithm: "psi",
        deduplicate: false,
        linkageStrategy: "cascade",
        identity: "Tester",
        output: { expectsOutput: true, shareWithPartner: true },
        linkageFields: [{ name: "firstName", type: "first_name" }],
        linkageKeys: [
          {
            name: "firstName",
            elements: [{ field: "firstName", transform: split }],
          },
        ],
      },
    },
    "Tester",
    Array.from({ length: 200 }, (_unused, i) => ({
      first_name: `${letters(2 * i)} ${letters(2 * i + 1)}`,
    })),
    ["first_name"],
  );
  // A count-only exchange assembled without the prepare step's refusal.
  const countOnly = {
    ...cascade,
    linkageTerms: { ...cascade.linkageTerms, algorithm: "psi-c" as const },
  };
  const maxValues = 100;

  await expect(
    assertFirstRoundWithinSetMaximum(cascade, { maxValues }),
  ).rejects.toThrow(RoundSetLimitError);
  await expect(
    assertFirstRoundWithinSetMaximum(countOnly, { maxValues }),
  ).rejects.toThrow(fanOutReachedMatchingRefusal().message);
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

test("the first-round check refuses, with the failure as its cause, when the count throws", async () => {
  const rowCount = 50;
  const prepared = preparedWith(
    Array.from({ length: rowCount }, (_unused, i) => letters(i)),
  );
  const failure = new RangeError("Map maximum size exceeded");
  const reports: Array<PsiProgress["state"]> = [];
  const refusal = await refusalOf(
    assertFirstRoundWithinSetMaximum(
      withThrowingRows(prepared, rowCount, failure),
      { maxValues: 2, onProgress: ({ state }) => reports.push(state) },
    ),
  );
  expect(reports).toEqual(["started", "failed"]);
  expect(refusal).toBeInstanceOf(RoundSetLimitError);
  expect((refusal as RoundSetLimitError).reason).toBe("uncounted");
  expect((refusal as Error).cause).toBe(failure);
});

test("the first-round check raises a refusal the count throws in both roles as it is", async () => {
  const rowCount = 50;
  const prepared = preparedWith(
    Array.from({ length: rowCount }, (_unused, i) => letters(i)),
  );
  const refusal = new UsageError("a refusal the round would raise");
  await expect(
    assertFirstRoundWithinSetMaximum(
      withThrowingRows(prepared, rowCount, refusal),
      { maxValues: 2 },
    ),
  ).rejects.toThrow(refusal);
});

afterEach(() => vi.restoreAllMocks());

test("the first-round check reports no row, so each row's warning comes once, from the round", async () => {
  // Two split elements: a row realizing 21 x 20 candidates is dropped from the
  // round, one realizing 21 x 1 is kept and warned as wide.
  const split = [{ function: "split_on", params: { delimiter: " " } }];
  const parts = (row: string, count: number) =>
    Array.from({ length: count }, (_unused, i) =>
      `${row}x${letters(i)}`.padEnd(8, "z"),
    ).join(" ");
  const prepared = prepareForExchange(
    {
      linkageTerms: {
        version: "1.0.0",
        date: "2026-01-01",
        algorithm: "psi",
        deduplicate: false,
        linkageStrategy: "cascade",
        identity: "Tester",
        output: { expectsOutput: true, shareWithPartner: true },
        linkageFields: [
          { name: "lastName", type: "last_name" },
          { name: "firstName", type: "first_name" },
        ],
        linkageKeys: [
          {
            name: "names",
            elements: [
              { field: "lastName", transform: split },
              { field: "firstName", transform: split },
            ],
          },
        ],
      },
    },
    "Tester",
    [
      { last_name: parts("dropped", 21), first_name: parts("dropped", 20) },
      { last_name: parts("wide", 21), first_name: "zqsole" },
      { last_name: "zqplain", first_name: "zqplain" },
    ],
    ["last_name", "first_name"],
  );
  const warn = vi
    .spyOn(getLogger("cleaning"), "warn")
    .mockImplementation(() => {});
  const rowLines = () =>
    warn.mock.calls
      .map(([line]) => String(line))
      .filter((line) => /^row \d+, key "names"/.test(line));

  // A bound the dataset's ceiling crosses, so the check reads the rows, and
  // the set the round sends fits.
  await expect(
    assertFirstRoundWithinSetMaximum(prepared, {
      maxValues: 100,
    }),
  ).resolves.toBeUndefined();
  expect(rowLines()).toEqual([]);

  const [key] = prepared.linkageTerms.linkageKeys;
  const firstRound = new StandardizedKeyIterable(
    key,
    prepared.dataset,
    prepared.rowCount,
    false,
    0,
  );
  expect(Array.from(firstRound)[0]).toBeUndefined();
  firstRound.closeRowReporting();
  const lines = rowLines();
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^row 0, key "names": .*contributes no value/);
  expect(lines[1]).toMatch(/^row 1, key "names": cross-product produced 21 /);
});

test("the first-round check refuses, with the failure as its cause, when the receiver-role count throws", async () => {
  const rowCount = 50;
  const prepared = preparedWith(
    Array.from({ length: rowCount }, (_unused, i) => letters(i)),
  );
  // The field cache holds each row once read, so the receiver-role pass fails
  // at its walk over the key's values instead of at a row.
  const failure = new RangeError("Map maximum size exceeded");
  const iterate = StandardizedKeyIterable.prototype[Symbol.iterator];
  let keyPasses = 0;
  vi.spyOn(
    StandardizedKeyIterable.prototype,
    Symbol.iterator,
  ).mockImplementation(function (this: StandardizedKeyIterable) {
    if (++keyPasses === 2) throw failure;
    return iterate.call(this);
  });
  const refusal = await refusalOf(
    assertFirstRoundWithinSetMaximum(prepared, { maxValues: 2 }),
  );
  expect(keyPasses).toBe(2);
  expect(refusal).toBeInstanceOf(RoundSetLimitError);
  expect((refusal as RoundSetLimitError).reason).toBe("uncounted");
  expect((refusal as Error).cause).toBe(failure);
});

test("an aborted first-round count rejects with the signal's reason and reports nothing further", async () => {
  const rows = Array.from({ length: 5000 }, (_unused, i) => letters(i));
  const controller = new AbortController();
  const reports: Array<PsiProgress> = [];
  const refusal = await refusalOf(
    assertFirstRoundWithinSetMaximum(preparedWith(rows), {
      maxValues: 300,
      onProgress: (progress) => {
        reports.push(progress);
        if (progress.state === "progress") controller.abort();
      },
      progressIntervalMs: 0,
      signal: controller.signal,
    }),
  );
  expect(refusal).toBe(controller.signal.reason);
  expect((refusal as Error).name).toBe("AbortError");
  expect(reports.map(({ state, processed }) => ({ state, processed }))).toEqual(
    [
      { state: "started", processed: undefined },
      { state: "progress", processed: 1024 },
    ],
  );
});
