import { describe, expect, test, vi } from "vitest";
import PSI from "@openmined/psi.js";

import { RoundSetLimitError } from "../../src/errors";
import {
  describeExchangeStages,
  prepareForExchange,
  type PreparedExchange,
} from "../../src/exchange";
import { assertFirstRoundWithinSetMaximum } from "../../src/exchange/firstRoundCapacity";
import { linkViaSinglePassPSI } from "../../src/psi/link";
import { phaseResult, runPsiPhasePair } from "../utils/psiPhasePair";

import type { LinkageTerms } from "../../src/config/linkageTermsSchema";

// Count-only terms declaring single-pass under the every-key construction run
// the cascade's rounds (docs/spec/PROTOCOL.md, PSI-C: "A declared
// `single-pass` runs the same rounds"). The terms-exchange parse still refuses
// these terms under psi-c, so the PSI phase both parties enter once the agreed
// terms are resolved is driven directly, each party's role fixed by the test.

// Every single-pass run here is over the single-pass dataset ceiling, so one
// that reached the single-pass link would be refused.
vi.mock("../../src/connection/frameSize", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/connection/frameSize")>()),
  singlePassCeilingBreach: () => "both",
}));
vi.mock("../../src/psi/link", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/psi/link")>();
  return {
    ...actual,
    linkViaSinglePassPSI: vi.fn(actual.linkViaSinglePassPSI),
  };
});

const psiLibrary = await PSI();

const CASCADE_TERMS: LinkageTerms = {
  version: "1.0.0",
  date: "2026-10-28",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "ssn4", type: "ssn4" },
    { name: "last_name", type: "last_name" },
    { name: "first_name", type: "first_name" },
  ],
  linkageKeys: [
    {
      name: "FN + LN + SSN4",
      elements: [
        { field: "first_name" },
        { field: "last_name" },
        { field: "ssn4" },
      ],
    },
    {
      name: "LN + SSN4",
      elements: [{ field: "last_name" }, { field: "ssn4" }],
    },
    {
      name: "FN + LN",
      elements: [{ field: "first_name" }, { field: "last_name" }],
    },
  ],
};
const countOnly = (
  linkageStrategy: LinkageTerms["linkageStrategy"],
): LinkageTerms => ({ ...CASCADE_TERMS, algorithm: "psi-c", linkageStrategy });

const COLUMNS = ["first_name", "last_name", "ssn4"];
type Row = Record<string, string>;
const person = (first_name: string, last_name: string, ssn4: string): Row => ({
  first_name,
  last_name,
  ssn4,
});

// Matches on each of the three keys, and on each party's side a value two of
// its records share for the second key.
const FIRST: Array<Row> = [
  person("Ann", "Moss", "1001"),
  person("Ben", "Moss", "2002"),
  person("Cal", "Hart", "3003"),
  person("Dee", "Hart", "3003"),
  person("Eve", "Lund", "5005"),
];
const SECOND: Array<Row> = [
  person("Ann", "Moss", "1001"),
  person("Ben", "Moss", "1001"),
  person("Cal", "Hart", "3003"),
  person("Eva", "Lund", "5005"),
  person("Fay", "Ross", "6006"),
  person("Gus", "Ross", "7007"),
];

// Prepared under the cascade terms, which the local prepare step admits; the
// dataset a party builds does not depend on the algorithm or the strategy.
function preparedParty(identity: string, rows: Array<Row>): PreparedExchange {
  return prepareForExchange(
    { linkageTerms: { ...CASCADE_TERMS, identity } },
    identity,
    rows,
    COLUMNS,
  );
}

// Each frame's shape: a binary frame's length, else the frame's keys.
const frameShapes = (frames: Array<unknown>): Array<unknown> =>
  frames.map((frame) =>
    frame instanceof Uint8Array
      ? frame.byteLength
      : Object.keys(frame as object).sort(),
  );

describe("count-only terms declaring single-pass under the every-key construction", () => {
  test.each([
    ["the first party", FIRST, SECOND],
    ["the second party", SECOND, FIRST],
  ])(
    "%s receiving: the count, frames and stages are those of the same terms declaring cascade",
    async (_label, receiverRows, senderRows) => {
      vi.mocked(linkViaSinglePassPSI).mockClear();
      const receiver = preparedParty("Receiver Co", receiverRows);
      const sender = preparedParty("Sender Co", senderRows);

      const singlePass = await runPsiPhasePair(
        psiLibrary,
        countOnly("single-pass"),
        receiver,
        sender,
      );
      const cascade = await runPsiPhasePair(
        psiLibrary,
        countOnly("cascade"),
        receiver,
        sender,
      );
      const matched = await runPsiPhasePair(
        psiLibrary,
        CASCADE_TERMS,
        receiver,
        sender,
      );

      const count = phaseResult(cascade.receiver).intersectionCount;
      expect(count).toBe(
        phaseResult(matched.receiver).associationTable?.[0].length,
      );
      expect(count).toBe(4);
      expect(phaseResult(singlePass.receiver).intersectionCount).toBe(count);
      expect(phaseResult(singlePass.sender).intersectionCount).toBe(count);
      expect(phaseResult(singlePass.receiver).associationTable).toBeUndefined();

      expect(linkViaSinglePassPSI).not.toHaveBeenCalled();
      for (const party of ["receiver", "sender"] as const) {
        expect(frameShapes(singlePass[party].sent)).toEqual(
          frameShapes(cascade[party].sent),
        );
        expect(singlePass[party].stages).toEqual(cascade[party].stages);
      }
      expect(singlePass.receiver.stages).toEqual([
        "stage 1 / 3",
        "stage 2 / 3",
        "stage 3 / 3",
      ]);
    },
  );

  test("a psi run declaring single-pass over the same data is held to the single-pass ceiling", async () => {
    vi.mocked(linkViaSinglePassPSI).mockClear();
    const outcome = await runPsiPhasePair(
      psiLibrary,
      { ...CASCADE_TERMS, linkageStrategy: "single-pass" },
      preparedParty("Receiver Co", FIRST),
      preparedParty("Sender Co", SECOND),
    );

    expect(linkViaSinglePassPSI).toHaveBeenCalled();
    expect(() => phaseResult(outcome.receiver)).toThrow(/single-pass/);
  });

  test("the stages listed before the run are the cascade's", () => {
    const prepared = preparedParty("Tester", FIRST);
    const stages = (terms: LinkageTerms) =>
      describeExchangeStages({ ...prepared, linkageTerms: terms }).map(
        ({ id }) => id,
      );

    expect(stages(countOnly("single-pass"))).toEqual(
      stages(countOnly("cascade")),
    );
    expect(stages(countOnly("single-pass"))).toHaveLength(4);
    expect(
      stages({ ...CASCADE_TERMS, linkageStrategy: "single-pass" }),
    ).toHaveLength(1);
  });

  test("the first round is held to the per-set maximum, as the cascade's is", async () => {
    const prepared = preparedParty("Tester", FIRST);
    const check = (terms: LinkageTerms) =>
      assertFirstRoundWithinSetMaximum(
        { ...prepared, linkageTerms: terms },
        { maxValues: 2 },
      );

    await expect(check(countOnly("single-pass"))).rejects.toBeInstanceOf(
      RoundSetLimitError,
    );
    await expect(check(countOnly("cascade"))).rejects.toBeInstanceOf(
      RoundSetLimitError,
    );
    await expect(
      check({ ...CASCADE_TERMS, linkageStrategy: "single-pass" }),
    ).resolves.toBeUndefined();
  });
});
