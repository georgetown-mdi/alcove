import { describe, expect, test } from "vitest";
import PSI from "@openmined/psi.js";

import { prepareForExchange } from "../../src/exchange";
import { phaseResult, runPsiPhasePair } from "../utils/psiPhasePair";

import type { LinkageTerms } from "../../src/config/linkageTermsSchema";
import type { PreparedExchange } from "../../src/exchange";

// A key with a missing-field condition under the every-key count-only
// construction, run through the PSI phase both parties enter once the agreed
// terms are resolved (docs/spec/PROTOCOL.md, PSI-C: "A key with a
// missing-field condition", "Uniqueness over every record the round is built
// for"). The terms-exchange parse still refuses these terms under psi-c, so the
// phase is driven directly, each party's role fixed by the test.

const psiLibrary = await PSI();

const PSI_TERMS: LinkageTerms = {
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
    { name: "date_of_birth", type: "date_of_birth" },
  ],
  linkageKeys: [
    {
      name: "SSN4 + LN + DOB",
      elements: [
        { field: "ssn4" },
        { field: "last_name" },
        { field: "date_of_birth" },
      ],
    },
    {
      name: "FN + LN + SSN4",
      elements: [
        { field: "first_name" },
        { field: "last_name" },
        { field: "ssn4" },
      ],
      condition: { missingField: "date_of_birth" },
    },
    {
      name: "FN + SSN4",
      elements: [{ field: "first_name" }, { field: "ssn4" }],
    },
  ],
};
const COUNT_ONLY_TERMS: LinkageTerms = { ...PSI_TERMS, algorithm: "psi-c" };

// The rounds the terms run as: the conditioned key's two halves, the
// receiver's first, between the keys either side of it.
const ROUND_COUNT = 4;
const RECEIVER_FILTERED_ROUND = 1;
const SENDER_FILTERED_ROUND = 2;

const COLUMNS = ["first_name", "last_name", "ssn4", "dob"];
type Row = Record<string, string>;
const person = (
  first_name: string,
  last_name: string,
  ssn4: string,
  dob: string,
): Row => ({ first_name, last_name, ssn4, dob });

// Prepared under the psi terms, which the local prepare step admits; the
// dataset a party builds does not depend on the algorithm.
function preparedParty(identity: string, rows: Array<Row>): PreparedExchange {
  return prepareForExchange(
    { linkageTerms: { ...PSI_TERMS, identity } },
    identity,
    rows,
    COLUMNS,
  );
}

async function countOnlyAndPsi(
  receiver: PreparedExchange,
  sender: PreparedExchange,
): Promise<{
  count: number | undefined;
  senderCount: number | undefined;
  pairs: number | undefined;
}> {
  const counted = await runPsiPhasePair(
    psiLibrary,
    COUNT_ONLY_TERMS,
    receiver,
    sender,
  );
  const matched = await runPsiPhasePair(
    psiLibrary,
    PSI_TERMS,
    receiver,
    sender,
  );
  return {
    count: phaseResult(counted.receiver).intersectionCount,
    senderCount: phaseResult(counted.sender).intersectionCount,
    pairs: phaseResult(matched.receiver).associationTable?.[0].length,
  };
}

// One pair per case at the same row, then one record only the second party
// holds.
const FIRST: Array<Row> = [
  person("Maria", "Lopez", "4821", ""),
  person("Ahmed", "Khan", "7364", ""),
  person("Grace", "Park", "5927", "06/02/1975"),
  person("Kofi", "Mensah", "9416", "08/19/1979"),
  person("Olu", "Adeyemi", "8193", "02/30/1990"),
  person("Zed", "Quinn", "1111", "01/02/1960"),
];
const SECOND: Array<Row> = [
  person("Maria", "Lopez", "4821", "07/22/1991"),
  person("Ahmed", "Khan", "7364", ""),
  person("Grace", "Park", "5927", "06/02/1975"),
  person("Kofi", "Mensah", "9416", "08/19/1984"),
  person("Olu", "Adeyemi", "8193", "11/05/1990"),
  person("Yan", "Reyes", "2222", "03/04/1961"),
  person("Ivy", "Stone", "3333", "05/06/1962"),
];
// The first party's record lacks the date; both lack it; the dates agree;
// the dates differ and the last key matches; an unparseable date; no match.
const CASE_PAIRS = 5;

describe("a key with a missing-field condition under the every-key construction", () => {
  test.each([
    ["the first party", FIRST, SECOND],
    ["the second party", SECOND, FIRST],
  ])(
    "%s receiving: the count is a psi run's on the same terms and data",
    async (_label, receiverRows, senderRows) => {
      const outcome = await countOnlyAndPsi(
        preparedParty("Receiver Co", receiverRows),
        preparedParty("Sender Co", senderRows),
      );

      expect(outcome.pairs).toBe(CASE_PAIRS);
      expect(outcome.count).toBe(CASE_PAIRS);
      expect(outcome.senderCount).toBe(CASE_PAIRS);
    },
  );

  test.each([0, 3, 6])(
    "every round's sets have the declared record counts with %i receiver record(s) lacking the date",
    async (lacking) => {
      const people = Array.from({ length: 6 }, (_, index) =>
        person(`Name${"abcdef"[index]!}`, "Lee", `${4000 + index}`, ""),
      );
      const dated = (row: Row, index: number): Row => ({
        ...row,
        dob: `0${String(index + 1)}/15/1980`,
      });
      const receiverRows = people.map((row, index) =>
        index < lacking ? row : dated(row, index),
      );
      const senderRows = [
        ...people.map(dated),
        person("Ivy", "Stone", "3333", "05/06/1962"),
      ];
      const counted = await runPsiPhasePair(
        psiLibrary,
        COUNT_ONLY_TERMS,
        preparedParty("Receiver Co", receiverRows),
        preparedParty("Sender Co", senderRows),
      );

      const requests = counted.receiver.sets.filter(
        (set) => set.kind === "request",
      );
      const setups = counted.sender.sets.filter((set) => set.kind === "setup");
      expect(requests.map((set) => set.values.length)).toEqual(
        Array(ROUND_COUNT).fill(receiverRows.length),
      );
      expect(setups.map((set) => set.values.length)).toEqual(
        Array(ROUND_COUNT).fill(senderRows.length),
      );
      // A real element carries its round's prefix; a dummy holds no colon. The
      // round filtering the receiver is built for the records lacking the date
      // alone, and the round filtering the sender for none of the sender's.
      const reals = (values: ReadonlyArray<string>) =>
        values.filter((value) => value.includes(":")).length;
      expect(reals(requests[RECEIVER_FILTERED_ROUND]!.values)).toBe(lacking);
      expect(reals(requests[SENDER_FILTERED_ROUND]!.values)).toBe(
        receiverRows.length,
      );
      expect(reals(setups[SENDER_FILTERED_ROUND]!.values)).toBe(0);
      expect(
        requests[RECEIVER_FILTERED_ROUND]!.values.filter((value) =>
          value.includes(":"),
        ).every((value) => value.startsWith(`${RECEIVER_FILTERED_ROUND}:`)),
      ).toBe(true);
      expect(phaseResult(counted.receiver).intersectionCount).toBe(
        people.length,
      );
    },
  );

  // The two Rosa records share the value of the conditioned key and of the last
  // key, and the dated one's date is not the partner's, so the conditioned
  // round is the only one the partner's Rosa can match in. A uniqueness test
  // over the whole dataset would make the value a dummy there.
  describe("a value a record lacking the date shares only with records having it", () => {
    const partner = [
      person("Rosa", "Diaz", "5150", "05/05/1972"),
      person("Ivy", "Stone", "3333", "05/06/1962"),
    ];

    test.each([
      [
        "takes part, whichever party receives",
        [
          person("Rosa", "Diaz", "5150", ""),
          person("Rosa", "Diaz", "5150", "04/04/1970"),
        ],
        1,
      ],
      [
        "takes no part once a second record lacking the date shares it",
        [
          person("Rosa", "Diaz", "5150", ""),
          person("Rosa", "Diaz", "5150", "04/04/1970"),
          person("Rosa", "Diaz", "5150", ""),
        ],
        0,
      ],
    ])("%s", async (_label, rows, expected) => {
      for (const [receiver, sender] of [
        [rows, partner],
        [partner, rows],
      ]) {
        const outcome = await countOnlyAndPsi(
          preparedParty("Receiver Co", receiver),
          preparedParty("Sender Co", sender),
        );
        expect(outcome.count).toBe(expected);
        expect(outcome.pairs).toBe(expected);
      }
    });
  });
});
