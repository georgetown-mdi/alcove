import { describe, expect, test } from "vitest";

// What an exchange's result does NOT change with, driven end to end: the same
// two inputs exchanged again, and exchanged with the roles swapped. Both parties
// expect output and hold equal declared counts, so the party that initiates is
// the receiver (resolveRole) and swapping the initiator swaps the roles with the
// data unchanged. The ways the table does change with the role are stated limits
// (docs/spec/PROTOCOL.md, Record-level resolution and Which party expands), and
// docs/notes/psi-run-to-run-determinism.md measures them; this file pins the
// properties the note found to hold beside them.

import PSI from "@openmined/psi.js";

import {
  prepareForExchange,
  runExchange,
  type ExchangeResult,
} from "../src/exchange";
import { createMessagePipe } from "../src/connection/messageConnection";
import { UsageError } from "../src/errors";
import type {
  LinkageStrategy,
  LinkageTerms,
} from "../src/config/linkageTermsSchema";

const psiLibrary = await PSI();

type Algorithm = LinkageTerms["algorithm"];
type Initiator = "a" | "b";

interface Side {
  readonly rows: ReadonlyArray<string>;
  readonly deduplicate?: boolean;
}

// One key over the last name split on the space the default name cleaning
// leaves where a hyphen was, so a hyphenated surname enters the round as each
// of its parts.
function splitSurnameTerms(
  algorithm: Algorithm,
  linkageStrategy: LinkageStrategy,
  deduplicate: boolean,
): LinkageTerms {
  return {
    version: "1.0.0",
    identity: "Role Swap Test",
    date: "2026-01-01",
    algorithm,
    linkageStrategy,
    output: { expectsOutput: true, shareWithPartner: true },
    deduplicate,
    linkageFields: [{ name: "last_name", type: "last_name" }],
    linkageKeys: [
      {
        name: "surname parts",
        elements: [
          {
            field: "last_name",
            transform: [{ function: "split_on", params: { delimiter: " " } }],
          },
        ],
      },
    ],
  };
}

/** Party a's result, with `initiator` initiating and so the receiver. */
async function exchangeAs(
  initiator: Initiator,
  a: Side,
  b: Side,
  algorithm: Algorithm,
  strategy: LinkageStrategy,
): Promise<ExchangeResult> {
  const prepare = (identity: string, side: Side) =>
    prepareForExchange(
      {
        linkageTerms: {
          ...splitSurnameTerms(algorithm, strategy, side.deduplicate ?? false),
          identity,
        },
      },
      identity,
      side.rows.map((last_name) => ({ last_name })),
      ["last_name"],
    );
  const [first, second] =
    initiator === "a"
      ? [prepare("A Co", a), prepare("B Co", b)]
      : [prepare("B Co", b), prepare("A Co", a)];
  const [initiatorConn, responderConn] = createMessagePipe();
  const [initiated, responded] = await Promise.all([
    runExchange(initiatorConn, "initiator", first, { psiLibrary }),
    runExchange(responderConn, "responder", second, { psiLibrary }),
  ]);
  const result = initiator === "a" ? initiated : responded;
  expect(result.resolvedRole).toBe(initiator === "a" ? "receiver" : "sender");
  return result;
}

// Six candidate pairs in one cycle over three records a side, numbered so that
// each role assignment keeps a different one of the cycle's two largest
// pairings: a0-b1, a1-b2, a2-b0 as party a sends, and a0-b2, a1-b0, a2-b1 as
// it receives. Every part is held by one record a side, so none is dropped.
const CYCLE_A: Side = {
  rows: ["Papa-Uniform", "Sierra-Tango", "Quebec-Romeo"],
};
const CYCLE_B: Side = {
  rows: ["Romeo-Sierra", "Papa-Quebec", "Tango-Uniform"],
};

// Party a deduplicates, so it is the many side: each of its two records fans
// out onto two of party b's, and the relaxed sweep keeps one pair per many-side
// record. The third row of party a meets nothing and evens the counts.
const MANY_A: Side = {
  rows: ["Papa-Quebec", "Quebec-Romeo", "Zulu"],
  deduplicate: true,
};
const ONE_B: Side = { rows: ["Papa", "Quebec", "Romeo"] };

const pairsOf = (result: ExchangeResult): Array<[number, number]> => {
  const table = result.associationTable;
  expect(table).toBeDefined();
  return table![0].map((local, i) => [local, table![1][i]]);
};

describe.each<LinkageStrategy>(["cascade", "single-pass"])(
  "under %s",
  (strategy) => {
    test("the cycle's pair count is the same in both role assignments", async () => {
      const asReceiver = await exchangeAs(
        "a",
        CYCLE_A,
        CYCLE_B,
        "psi",
        strategy,
      );
      const asSender = await exchangeAs("b", CYCLE_A, CYCLE_B, "psi", strategy);
      expect(pairsOf(asReceiver)).toHaveLength(3);
      expect(pairsOf(asSender)).toHaveLength(3);
      // The fixture is one where the pairs themselves differ (the stated
      // limit), so the equal count is not two copies of one table.
      expect(pairsOf(asSender)).not.toEqual(pairsOf(asReceiver));
    });

    test("a many-to-one table is the same in both role assignments", async () => {
      // Each many-side record keeps the pair with its lowest-row partner, as
      // the canonical order reaches that pair first whichever side sends.
      const expected: Array<[number, number]> = [
        [0, 0],
        [1, 1],
      ];
      for (const initiator of ["a", "b"] as const)
        expect(
          pairsOf(await exchangeAs(initiator, MANY_A, ONE_B, "psi", strategy)),
        ).toEqual(expected);
    });

    test("a second run in the same role gives the same table", async () => {
      // Each run draws fresh PSI keys, so every masked element differs between
      // the two runs while the table does not.
      for (const initiator of ["a", "b"] as const) {
        const first = await exchangeAs(
          initiator,
          CYCLE_A,
          CYCLE_B,
          "psi",
          strategy,
        );
        const second = await exchangeAs(
          initiator,
          CYCLE_A,
          CYCLE_B,
          "psi",
          strategy,
        );
        expect(pairsOf(second)).toEqual(pairsOf(first));
      }
    });
  },
);

// An adjacent-years element behind a transform that strips a leading 1990, so
// party x's 1990 birth date reaches the element as the four digits 0115 while
// party y's values stay canonical. Each side holds two rows, so the initiator
// receives.
function strippedYearTerms(
  linkageStrategy: LinkageStrategy,
  identity: string,
): LinkageTerms {
  return {
    version: "1.0.0",
    identity,
    date: "2026-01-01",
    algorithm: "psi",
    linkageStrategy,
    output: { expectsOutput: true, shareWithPartner: true },
    deduplicate: false,
    linkageFields: [{ name: "dob", type: "date_of_birth" }],
    linkageKeys: [
      {
        name: "birth date",
        elements: [
          {
            field: "dob",
            transform: [
              {
                function: "replace_regex",
                params: { pattern: "^1990", replacement: "" },
              },
            ],
            generateFuzzyComparisons: "adjacent_years",
          },
        ],
      },
    ],
  };
}

const STRIPPED_YEAR_X = ["01/15/1990", "01/15/1985"];
const STRIPPED_YEAR_Y = ["01/15/1985", "06/15/1950"];

/** Party x's outcome, with `initiator` initiating and so the receiver. */
async function strippedYearExchange(
  initiator: "x" | "y",
  strategy: LinkageStrategy,
): Promise<PromiseSettledResult<ExchangeResult>> {
  const prepare = (identity: string, rows: ReadonlyArray<string>) =>
    prepareForExchange(
      { linkageTerms: strippedYearTerms(strategy, identity) },
      identity,
      rows.map((date_of_birth) => ({ date_of_birth })),
      ["date_of_birth"],
    );
  const x = prepare("X Co", STRIPPED_YEAR_X);
  const y = prepare("Y Co", STRIPPED_YEAR_Y);
  const [initiatorConn, responderConn] = createMessagePipe();
  // A failed party closes its connection, as a transport caller does, so the
  // partner meets the end of the run rather than awaiting a frame.
  const run = (
    conn: typeof initiatorConn,
    role: "initiator" | "responder",
    party: typeof x,
  ) =>
    runExchange(conn, role, party, { psiLibrary }).catch(async (err) => {
      await conn.close();
      throw err;
    });
  const [initiated, responded] = await Promise.allSettled([
    run(initiatorConn, "initiator", initiator === "x" ? x : y),
    run(responderConn, "responder", initiator === "x" ? y : x),
  ]);
  return initiator === "x" ? initiated : responded;
}

describe.each<LinkageStrategy>(["cascade", "single-pass"])(
  "under %s",
  (strategy) => {
    test("a date value that is not eight digits is refused in both roles", async () => {
      const refusals: string[] = [];
      for (const initiator of ["x", "y"] as const) {
        const outcome = await strippedYearExchange(initiator, strategy);
        expect(outcome.status).toBe("rejected");
        const reason = (outcome as PromiseRejectedResult).reason as unknown;
        expect(reason).toBeInstanceOf(UsageError);
        refusals.push((reason as UsageError).message);
      }
      expect(refusals[0]).toMatch(/not a canonical YYYYMMDD date/);
      expect(refusals[1]).toBe(refusals[0]);
    });
  },
);

test("the count-only count over the cycle is the same in both role assignments", async () => {
  for (const initiator of ["a", "b"] as const) {
    const result = await exchangeAs(
      initiator,
      CYCLE_A,
      CYCLE_B,
      "psi-c",
      "cascade",
    );
    expect(result.intersectionCount).toBe(3);
  }
});
