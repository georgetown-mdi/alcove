import { describe, expect, test } from "vitest";
import PSI from "@openmined/psi.js";

import {
  prepareForExchange,
  runExchange,
  type ExchangeResult,
} from "../src/exchange";
import { createMessagePipe } from "../src/connection/messageConnection";
import { inferMetadata } from "../src/config/metadata";
import { getDefaultLinkageTerms } from "../src/defaults/builtInLinkageTerms";
import { decideLinkageTermsVerdict } from "../src/linkageSatisfiability";
import { validateCompatibility } from "../src/linkageTermsNegotiation";
import { summarizeInvitation } from "../src/consent/invitationSummary";
import { missingFieldConditionStatement } from "../src/consent/consentFacts";

import type { LinkageTerms } from "../src/config/linkageTermsSchema";

// The built-in contact rules without a date of birth, run as the built-in
// terms derive them: each under the missing-date condition, after the rules
// that compare the date.

const psiLibrary = await PSI();

const CONTACT_RULES = [
  "LN + FN + PHONE",
  "PHONE + soundex(LN) + FN",
  "FN + PHONE",
  "LN + FN + EMAIL",
  "EMAIL + soundex(LN) + FN",
];

const DATED_COLUMNS = ["first_name", "last_name", "dob", "phone", "email"];
const UNDATED_COLUMNS = ["first_name", "last_name", "phone", "email"];

type Row = Record<string, string>;
const person = (
  first_name: string,
  last_name: string,
  dob: string,
  phone: string,
  email: string,
): Row => ({ first_name, last_name, dob, phone, email });

const termsFor = (columns: string[]): LinkageTerms =>
  getDefaultLinkageTerms("Party", inferMetadata(columns, []));

interface PartyRun {
  result: ExchangeResult;
  role: "sender" | "receiver";
}

async function runBothParties(
  initiator: { terms: LinkageTerms; columns: string[]; rows: Row[] },
  responder: { terms: LinkageTerms; columns: string[]; rows: Row[] },
): Promise<[PartyRun, PartyRun]> {
  const [initiatorConn, responderConn] = createMessagePipe();
  const run = async (
    conn: typeof initiatorConn,
    handshake: "initiator" | "responder",
    party: { terms: LinkageTerms; columns: string[]; rows: Row[] },
  ): Promise<PartyRun> => {
    const identity =
      handshake === "initiator" ? "Initiator Co" : "Responder Co";
    const prepared = prepareForExchange(
      {
        linkageTerms: { ...party.terms, identity },
        includeMatchingKey: true,
      },
      identity,
      party.rows.map((row) =>
        Object.fromEntries(
          party.columns.map((column) => [column, row[column]]),
        ),
      ),
      party.columns,
    );
    let role: "sender" | "receiver" | undefined;
    const result = await runExchange(conn, handshake, prepared, {
      psiLibrary,
      onProtocolConfirmed: (_partner, resolvedRole) => {
        role = resolvedRole;
      },
    });
    if (role === undefined) throw new Error("no role was resolved");
    return { result, role };
  };
  return Promise.all([
    run(initiatorConn, "initiator", initiator),
    run(responderConn, "responder", responder),
  ]);
}

// The key each row's pair matched on, from one party's side, or undefined
// where the row matched nothing.
function matchedKeyByRow(run: PartyRun, rowCount: number) {
  const table = run.result.associationTable;
  const names = run.result.matchedKeyOfPair;
  if (table === undefined || names === undefined)
    throw new Error("the run returned no table or no matching keys");
  return Array.from({ length: rowCount }, (_, row) => {
    const pair = table[0].indexOf(row);
    if (pair === -1) return undefined;
    expect(table[1][pair]).toBe(row);
    return names[pair];
  });
}

const own = (rule: string) =>
  `${rule} (your record has no valid date of birth)`;
const partners = (rule: string) =>
  `${rule} (partner's record has no valid date of birth)`;

describe("the built-in contact rules without a date of birth", () => {
  test("are derived for a file with names, a date, a phone and an email, after the date rules", () => {
    const keys = termsFor(DATED_COLUMNS).linkageKeys.map((key) => key.name);
    for (const rule of CONTACT_RULES) expect(keys).toContain(rule);
    expect(keys.indexOf("LN + FN + PHONE")).toBeGreaterThan(
      keys.indexOf("LN + FN + DOB + PHONE"),
    );
  });

  // One pair per case, at the same row on both sides, the initiator's record
  // lacking the date where one does.
  const CASES: ReadonlyArray<{
    label: string;
    initiator: Row;
    responder: Row;
    expected: string | undefined;
  }> = [
    {
      label: "one side has no date of birth",
      initiator: person("Maria", "Lopez", "", "2025550101", ""),
      responder: person("Maria", "Lopez", "07/22/1991", "2025550101", ""),
      expected: "LN + FN + PHONE",
    },
    {
      label: "both dates valid and agreeing",
      initiator: person("Ahmed", "Khan", "03/14/1980", "2025550102", ""),
      responder: person("Ahmed", "Khan", "03/14/1980", "2025550102", ""),
      expected: "LN + FN + DOB + PHONE",
    },
    {
      label: "both dates valid and differing",
      initiator: person("Grace", "Park", "06/02/1975", "2025550103", ""),
      responder: person("Grace", "Park", "06/02/1980", "2025550103", ""),
      expected: undefined,
    },
    {
      label: "a filler date on one side",
      initiator: person("Tomas", "Silva", "01/01/1985", "2025550104", ""),
      responder: person("Tomas", "Silva", "03/04/1985", "2025550104", ""),
      expected: "LN + FN + PHONE",
    },
    {
      label: "a last name that keeps its Soundex code",
      initiator: person("Kofi", "Mensah", "", "2025550105", ""),
      responder: person("Kofi", "Mensa", "08/19/1979", "2025550105", ""),
      expected: "PHONE + soundex(LN) + FN",
    },
    {
      label: "a changed last name",
      initiator: person("Nina", "Rossi", "", "2025550106", ""),
      responder: person("Nina", "Conti", "05/05/1970", "2025550106", ""),
      expected: "FN + PHONE",
    },
    {
      label: "an email and no phone",
      initiator: person("Lena", "Weiss", "", "", "lena.weiss@example.org"),
      responder: person(
        "Lena",
        "Weiss",
        "09/09/1966",
        "",
        "LENA.WEISS@example.org",
      ),
      expected: "LN + FN + EMAIL",
    },
    {
      label: "an email and a last name that keeps its Soundex code",
      initiator: person("Olu", "Adeyemi", "", "", "olu@example.org"),
      responder: person("Olu", "Adeyemy", "11/05/1990", "", "olu@example.org"),
      expected: "EMAIL + soundex(LN) + FN",
    },
  ];

  test("match each case through the rule its dates call for, naming the side that had no date", async () => {
    const terms = termsFor(DATED_COLUMNS);
    const [initiator, responder] = await runBothParties(
      {
        terms,
        columns: DATED_COLUMNS,
        rows: CASES.map((c) => c.initiator),
      },
      {
        terms,
        columns: DATED_COLUMNS,
        rows: CASES.map((c) => c.responder),
      },
    );
    const named = (side: (rule: string) => string) =>
      CASES.map(({ expected }) =>
        expected === undefined
          ? undefined
          : CONTACT_RULES.includes(expected)
            ? side(expected)
            : expected,
      );
    expect(matchedKeyByRow(initiator, CASES.length)).toEqual(named(own));
    expect(matchedKeyByRow(responder, CASES.length)).toEqual(named(partners));
  });

  test("run for a party whose file has no date-of-birth column, every record in its half", async () => {
    const terms = termsFor(UNDATED_COLUMNS);
    expect(terms.linkageKeys.map((key) => key.name)).toStrictEqual(
      CONTACT_RULES,
    );
    expect(terms.linkageFields.map((field) => field.name)).toContain(
      "date_of_birth",
    );
    const verdict = decideLinkageTermsVerdict(UNDATED_COLUMNS, terms);
    expect(verdict.fullySatisfied).toBe(true);
    expect(verdict.unsatisfiedFieldColumns).toEqual([]);

    // The partner adopted the terms and holds a date for every record, so only
    // the round where the undated party's records are filtered can match.
    const undated = [
      person("Maria", "Lopez", "", "2025550101", ""),
      person("Lena", "Weiss", "", "", "lena.weiss@example.org"),
    ];
    const dated = [
      person("Maria", "Lopez", "07/22/1991", "2025550101", ""),
      person("Lena", "Weiss", "09/09/1966", "", "lena.weiss@example.org"),
    ];
    const [initiator, responder] = await runBothParties(
      { terms, columns: UNDATED_COLUMNS, rows: undated },
      { terms, columns: DATED_COLUMNS, rows: dated },
    );
    expect(matchedKeyByRow(initiator, 2)).toEqual([
      own("LN + FN + PHONE"),
      own("LN + FN + EMAIL"),
    ]);
    expect(matchedKeyByRow(responder, 2)).toEqual([
      partners("LN + FN + PHONE"),
      partners("LN + FN + EMAIL"),
    ]);
    for (const run of [initiator, responder])
      expect(
        run.result.audit?.record.governance.matchingBasis.map((f) => f.name),
      ).toEqual([
        "date_of_birth",
        "email_address",
        "first_name",
        "last_name",
        "phone_number",
      ]);
  });

  test("are derived identically on both sides, the condition with each", () => {
    const initiator = termsFor(DATED_COLUMNS);
    const responder = termsFor([...DATED_COLUMNS].reverse());
    expect(validateCompatibility(initiator, responder).errors).toEqual([]);
    expect(responder.linkageKeys).toStrictEqual(initiator.linkageKeys);
    for (const terms of [initiator, responder])
      for (const key of terms.linkageKeys)
        if (CONTACT_RULES.includes(key.name))
          expect(key.condition).toStrictEqual({
            missingField: "date_of_birth",
          });
  });

  test("are each named once in the terms review, with what a match tells the receiver", () => {
    const summary = summarizeInvitation({
      linkageTerms: termsFor(DATED_COLUMNS),
    });
    const statement = missingFieldConditionStatement("date of birth", "psi");
    expect(statement).toMatch(/which of the two records had none/);
    expect(statement).toContain(
      "Your partner also learns how many of your records not yet matched " +
        "have no valid date of birth.",
    );
    for (const rule of CONTACT_RULES) {
      const listed = summary.linkageKeys.filter((key) => key.name === rule);
      expect(listed).toHaveLength(1);
      expect(listed[0].condition).toBe(statement);
    }
    expect(
      summary.linkageKeys
        .filter((key) => key.condition !== undefined)
        .map((key) => key.name),
    ).toStrictEqual(CONTACT_RULES);
  });

  test("share one condition line naming all five, worded for several keys", () => {
    const summary = summarizeInvitation({
      linkageTerms: termsFor(DATED_COLUMNS),
    });
    expect(summary.conditionLines).toStrictEqual([
      {
        keyNames: CONTACT_RULES,
        statement: missingFieldConditionStatement("date of birth", "psi", 5),
      },
    ]);
    expect(summary.conditionLines[0].statement).toBe(
      "Each matches only where one of the two records has no valid date of " +
        "birth. A match through one of these keys tells a party receiving " +
        "the result which of the two records had none. Your partner also " +
        "learns how many of your records not yet matched have no valid date " +
        "of birth.",
    );
  });

  test("are stated on count-only terms with what the computing party's software learns", () => {
    const summary = summarizeInvitation({
      linkageTerms: { ...termsFor(DATED_COLUMNS), algorithm: "psi-c" },
    });
    const statement = missingFieldConditionStatement("date of birth", "psi-c");
    expect(statement).toBe(
      "Matches only where one of the two records has no valid date of birth. " +
        "In a count-only exchange you send one encrypted value for each of " +
        "your records in every round, so what you send does not tell your " +
        "partner how many of your records have no valid date of birth. The " +
        "software of the party that computes the count does learn, for each " +
        "match through this key, which of the two records had none.",
    );
    expect(
      missingFieldConditionStatement("date of birth", "psi-c", 5),
    ).toContain(
      "for each match through one of these keys, which of the two records " +
        "had none.",
    );
    for (const rule of CONTACT_RULES)
      expect(
        summary.linkageKeys.find((key) => key.name === rule)?.condition,
      ).toBe(statement);
    expect(summary.conditionLines).toStrictEqual([
      {
        keyNames: CONTACT_RULES,
        statement: missingFieldConditionStatement("date of birth", "psi-c", 5),
      },
    ]);
    const lines = [
      ...summary.linkageKeys.flatMap((key) => key.condition ?? []),
      ...summary.conditionLines.map((line) => line.statement),
    ];
    for (const line of lines) {
      expect(line).not.toMatch(/tells a party receiving the result/);
      expect(line).not.toMatch(/Your partner also learns/);
    }
  });
});
