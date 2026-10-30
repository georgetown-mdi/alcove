import { describe, expect, test } from "vitest";
import PSI from "@openmined/psi.js";

import {
  prepareForExchange,
  runExchange,
  type ExchangeResult,
} from "../src/exchange";
import { createMessagePipe } from "../src/connection/messageConnection";
import {
  LinkageTermsUnsatisfiableError,
  RoundSetLimitError,
} from "../src/errors";
import {
  assertFirstRoundWithinPartnerCeiling,
  assertFirstRoundWithinSetMaximum,
} from "../src/exchange/firstRoundCapacity";
import {
  parseLinkageTerms,
  referencedLinkageFieldNames,
  safeParseLinkageTerms,
} from "../src/config/linkageTermsSchema";
import {
  KEY_CONDITION_REFUSALS,
  linkageRounds,
  roundMatchedKeyName,
} from "../src/linkageKeyCondition";
import { validateCompatibility } from "../src/linkageTermsNegotiation";
import { declaredEffectiveKeyCount } from "../src/fanOutFunctions";
import { decideLinkageTermsVerdict } from "../src/linkageSatisfiability";
import { isFillerDateOfBirth } from "../src/defaults/dateOfBirthFiller";
import { getDefaultStandardization } from "../src/defaults/builtInStandardization";
import { inferMetadata } from "../src/config/metadata";
import {
  buildKeyStrings,
  buildStandardizedDataset,
} from "../src/standardization";
import type {
  LinkageKey,
  LinkageTerms,
} from "../src/config/linkageTermsSchema";

const psiLibrary = await PSI();

const NO_DATE_KEY: LinkageKey = {
  name: "FN + LN + SSN4",
  elements: [
    { field: "first_name" },
    { field: "last_name" },
    { field: "ssn4" },
  ],
  condition: { missingField: "date_of_birth" },
};

// The SSN4 date rules ahead of the conditioned one, in the built-in set's
// order: exact, then one year, one day, and day and month exchanged.
const TERMS: LinkageTerms = {
  version: "1.0.0",
  date: "2026-10-20",
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
      name: "SSN4 + LN + FN + DOB +/-1 year",
      elements: [
        { field: "ssn4" },
        { field: "last_name" },
        { field: "first_name" },
        { field: "date_of_birth", generateFuzzyComparisons: "adjacent_years" },
      ],
    },
    {
      name: "SSN4 + LN + FN + DOB +/-1 day",
      elements: [
        { field: "ssn4" },
        { field: "last_name" },
        { field: "first_name" },
        { field: "date_of_birth", generateFuzzyComparisons: "adjacent_days" },
      ],
    },
    {
      name: "SSN4 + LN + FN + DOB day/month exchanged",
      elements: [
        { field: "ssn4" },
        { field: "last_name" },
        { field: "first_name" },
        { field: "date_of_birth", generateFuzzyComparisons: "day_month_swaps" },
      ],
    },
    NO_DATE_KEY,
  ],
};

const COLUMNS = ["first_name", "last_name", "ssn4", "dob"];

type Row = Record<string, string>;
const person = (
  first_name: string,
  last_name: string,
  ssn4: string,
  dob: string,
): Row => ({ first_name, last_name, ssn4, dob });

// One pair per case, at the same row on both sides.
const CASES: ReadonlyArray<{
  label: string;
  initiator: Row;
  responder: Row;
}> = [
  {
    label: "one side has no date of birth",
    initiator: person("Maria", "Lopez", "4821", ""),
    responder: person("Maria", "Lopez", "4821", "07/22/1991"),
  },
  {
    label: "both dates valid and agreeing",
    initiator: person("Ahmed", "Khan", "7364", "03/14/1980"),
    responder: person("Ahmed", "Khan", "7364", "03/14/1980"),
  },
  {
    label: "both dates valid, five years apart",
    initiator: person("Grace", "Park", "5927", "06/02/1975"),
    responder: person("Grace", "Park", "5927", "06/02/1980"),
  },
  {
    label: "an unparseable date on one side",
    initiator: person("Olu", "Adeyemi", "8193", "02/30/1990"),
    responder: person("Olu", "Adeyemi", "8193", "11/05/1990"),
  },
  {
    label: "a placeholder date on one side",
    initiator: person("Lena", "Weiss", "3378", "01/01/1900"),
    responder: person("Lena", "Weiss", "3378", "09/09/1966"),
  },
  {
    label: "a filler date on one side",
    initiator: person("Tomas", "Silva", "6642", "01/01/1985"),
    responder: person("Tomas", "Silva", "6642", "03/04/1985"),
  },
  {
    label: "the same filler date on both sides",
    initiator: person("Nina", "Rossi", "2759", "01/01/1980"),
    responder: person("Nina", "Rossi", "2759", "01/01/1980"),
  },
  {
    label: "both dates valid, one year apart",
    initiator: person("Kofi", "Mensah", "9416", "08/19/1979"),
    responder: person("Kofi", "Mensah", "9416", "08/19/1980"),
  },
];

interface PartyRun {
  result: ExchangeResult;
  role: "sender" | "receiver";
}

async function runBothParties(
  initiatorTerms: LinkageTerms = TERMS,
  responderTerms: LinkageTerms = TERMS,
): Promise<[PartyRun, PartyRun]> {
  const [initiatorConn, responderConn] = createMessagePipe();
  const run = async (
    conn: typeof initiatorConn,
    handshake: "initiator" | "responder",
    terms: LinkageTerms,
    rows: Row[],
  ): Promise<PartyRun> => {
    const identity =
      handshake === "initiator" ? "Initiator Co" : "Responder Co";
    const prepared = prepareForExchange(
      {
        linkageTerms: { ...terms, identity },
        // The single-pass sender holds no round to name a key by.
        includeMatchingKey: terms.linkageStrategy === "cascade",
      },
      identity,
      rows,
      COLUMNS,
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
    run(
      initiatorConn,
      "initiator",
      initiatorTerms,
      CASES.map((c) => c.initiator),
    ),
    run(
      responderConn,
      "responder",
      responderTerms,
      CASES.map((c) => c.responder),
    ),
  ]);
}

// The key each case's pair matched on, from one party's side, or undefined
// where the pair did not match.
function matchedKeyByCase(run: PartyRun): Array<string | undefined> {
  const table = run.result.associationTable;
  const names = run.result.matchedKeyOfPair;
  if (table === undefined || names === undefined)
    throw new Error("the run returned no table or no matching keys");
  return CASES.map((_, row) => {
    const pair = table[0].indexOf(row);
    if (pair === -1) return undefined;
    expect(table[1][pair]).toBe(row);
    return names[pair];
  });
}

const OWN = "FN + LN + SSN4 (your record has no valid date of birth)";
const PARTNER = "FN + LN + SSN4 (partner's record has no valid date of birth)";

describe("an exchange running FN + LN + SSN4 under a missing-date condition", () => {
  test("matches each case through the rule its dates call for, and names the half that fired", async () => {
    const [initiator, responder] = await runBothParties();

    // A pair both of whose dates are fillers is claimed by the receiver's half,
    // which runs first.
    const bothFiller = (run: PartyRun) =>
      run.role === "receiver" ? OWN : PARTNER;

    expect(matchedKeyByCase(initiator)).toEqual([
      OWN,
      "SSN4 + LN + DOB",
      undefined,
      OWN,
      OWN,
      OWN,
      bothFiller(initiator),
      "SSN4 + LN + FN + DOB +/-1 year",
    ]);
    expect(matchedKeyByCase(responder)).toEqual([
      PARTNER,
      "SSN4 + LN + DOB",
      undefined,
      PARTNER,
      PARTNER,
      PARTNER,
      bothFiller(responder),
      "SSN4 + LN + FN + DOB +/-1 year",
    ]);
    expect(initiator.role).not.toBe(responder.role);
  });

  test("names the condition's field in both parties' matching basis", async () => {
    const [initiator, responder] = await runBothParties();
    for (const run of [initiator, responder])
      expect(
        run.result.audit?.record.governance.matchingBasis.map((f) => f.name),
      ).toEqual(["date_of_birth", "first_name", "last_name", "ssn4"]);
  });

  test("single-pass matches the pairs the cascade does", async () => {
    const singlePass: LinkageTerms = {
      ...TERMS,
      linkageStrategy: "single-pass",
    };
    const [cascadeInitiator, cascadeResponder] = await runBothParties();
    const [initiator, responder] = await runBothParties(singlePass, singlePass);
    expect(initiator.result.associationTable).toEqual(
      cascadeInitiator.result.associationTable,
    );
    expect(responder.result.associationTable).toEqual(
      cascadeResponder.result.associationTable,
    );
  });

  test("a party whose key states no condition is refused at the terms exchange", async () => {
    const withoutCondition: LinkageTerms = {
      ...TERMS,
      linkageKeys: TERMS.linkageKeys.map(({ condition: _, ...key }) => key),
    };
    await expect(runBothParties(TERMS, withoutCondition)).rejects.toThrow(
      /linkage keys do not match/,
    );
  });
});

describe("the condition in the terms cross-check", () => {
  test("two documents stating the same condition are compatible", () => {
    expect(validateCompatibility(TERMS, structuredClone(TERMS)).errors).toEqual(
      [],
    );
  });

  test("a condition one side states and the other does not is a key difference, seen alike from both sides", () => {
    const without: LinkageTerms = {
      ...TERMS,
      linkageKeys: TERMS.linkageKeys.map(({ condition: _, ...key }) => key),
    };
    for (const [local, partner] of [
      [TERMS, without],
      [without, TERMS],
    ] as const) {
      const { errors } = validateCompatibility(local, partner);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/linkage keys do not match/);
      expect(errors[0]).toMatch(/FN \+ LN \+ SSN4/);
    }
  });
});

describe("the terms schema", () => {
  const withKeys = (...linkageKeys: LinkageKey[]): unknown => ({
    ...TERMS,
    linkageKeys,
  });
  const refusal = (raw: unknown) => {
    const parsed = safeParseLinkageTerms(raw);
    expect(parsed.success).toBe(false);
    return parsed.error?.issues.map((issue) => issue.message);
  };

  test("reads the condition from snake_case", () => {
    const { linkageKeys: _, ...rest } = TERMS;
    const terms = parseLinkageTerms({
      ...rest,
      linkage_keys: [
        {
          name: "FN + LN + SSN4",
          elements: [{ field: "first_name" }, { field: "ssn4" }],
          condition: { missing_field: "date_of_birth" },
        },
      ],
    });
    expect(terms.linkageKeys[0].condition).toEqual({
      missingField: "date_of_birth",
    });
  });

  test("refuses a condition naming a field outside the agreed linkage fields", () => {
    expect(
      refusal(
        withKeys({ ...NO_DATE_KEY, condition: { missingField: "birth_day" } }),
      ),
    ).toContain(KEY_CONDITION_REFUSALS.undeclared);
  });

  test("refuses a condition naming a field of a type other than date of birth", () => {
    expect(
      refusal(
        withKeys({
          name: "FN + SSN4, no last name",
          elements: [{ field: "first_name" }, { field: "ssn4" }],
          condition: { missingField: "last_name" },
        }),
      ),
    ).toContain(KEY_CONDITION_REFUSALS.fieldType);
  });

  test("refuses a key that matches on the field its condition requires missing", () => {
    expect(
      refusal(
        withKeys({
          ...NO_DATE_KEY,
          elements: [...NO_DATE_KEY.elements, { field: "date_of_birth" }],
        }),
      ),
    ).toContain(KEY_CONDITION_REFUSALS.readsField);
  });

  test("admits a condition under the count-only algorithm", () => {
    expect(
      safeParseLinkageTerms({
        ...(withKeys(NO_DATE_KEY) as object),
        algorithm: "psi-c",
      }).success,
    ).toBe(true);
  });

  test("counts the condition's field among the fields the keys read", () => {
    expect([...referencedLinkageFieldNames([NO_DATE_KEY])].sort()).toEqual([
      "date_of_birth",
      "first_name",
      "last_name",
      "ssn4",
    ]);
  });
});

describe("the rounds a conditioned key runs as", () => {
  test("two adjacent rounds at the key's position, the receiver's half first", () => {
    expect(
      linkageRounds(TERMS.linkageKeys).map(
        (round) => `${round.keyIndex}:${round.lackingRole ?? "all"}`,
      ),
    ).toEqual(["0:all", "1:all", "2:all", "3:all", "4:receiver", "4:sender"]);
  });

  test("count the key's width once per round", () => {
    const one: LinkageTerms = { ...TERMS, linkageKeys: [NO_DATE_KEY] };
    expect(declaredEffectiveKeyCount(one)).toBe(2);
  });

  test("name the half from each party's side", () => {
    const [receiverHalf, senderHalf] = linkageRounds([NO_DATE_KEY]);
    const fields = TERMS.linkageFields;
    expect(roundMatchedKeyName(receiverHalf, true, fields)).toBe(OWN);
    expect(roundMatchedKeyName(receiverHalf, false, fields)).toBe(PARTNER);
    expect(roundMatchedKeyName(senderHalf, false, fields)).toBe(OWN);
    expect(roundMatchedKeyName(senderHalf, true, fields)).toBe(PARTNER);
  });

  test("an input with no column for the condition's field can run the key", () => {
    const verdict = decideLinkageTermsVerdict(
      ["first_name", "last_name", "ssn4"],
      { ...TERMS, linkageKeys: [NO_DATE_KEY] },
    );
    expect(verdict.keys).toEqual([
      { key: NO_DATE_KEY, fitness: "satisfiable" },
    ]);
    expect(verdict.unsatisfiedFieldColumns).toEqual([]);
    expect(verdict.fullySatisfied).toBe(true);
  });

  test("an input whose explicit standardization binds the condition's field to no column can run the key", () => {
    const verdict = decideLinkageTermsVerdict(
      ["first_name", "last_name", "ssn4"],
      { ...TERMS, linkageKeys: [NO_DATE_KEY] },
      [
        { output: "first_name", input: "first_name" },
        { output: "last_name", input: "last_name" },
        { output: "ssn4", input: "ssn4" },
      ],
    );
    expect(verdict.unsatisfiedFieldColumns).toEqual([]);
    expect(verdict.fullySatisfied).toBe(true);
  });

  describe("an input lacking the column the condition's field is bound to", () => {
    const columns = ["first_name", "last_name", "ssn4"];
    const terms: LinkageTerms = { ...TERMS, linkageKeys: [NO_DATE_KEY] };
    const DATE_FIELD = { name: "date_of_birth", type: "date_of_birth" };
    const bindings = {
      "an explicit standardization": {
        standardization: [
          { output: "first_name", input: "first_name" },
          { output: "last_name", input: "last_name" },
          { output: "ssn4", input: "ssn4" },
          { output: "date_of_birth", input: "dob" },
        ],
        metadata: undefined,
      },
      "a metadata block": {
        standardization: undefined,
        metadata: [
          ...inferMetadata(columns, []),
          {
            name: "dob",
            type: "date_of_birth" as const,
            role: "linkage" as const,
            isPayload: false,
          },
        ],
      },
    };

    for (const [label, { standardization, metadata }] of Object.entries(
      bindings,
    )) {
      test(`reports the column and cannot run the key, bound by ${label}`, () => {
        const verdict = decideLinkageTermsVerdict(
          columns,
          terms,
          standardization,
          metadata,
        );
        expect(verdict.unsatisfiedFieldColumns).toEqual([
          { field: DATE_FIELD, column: "dob" },
        ]);
        expect(verdict.keys).toEqual([
          {
            key: NO_DATE_KEY,
            fitness: "unsatisfiable",
            missingField: "date_of_birth",
          },
        ]);
        expect(verdict.fullySatisfied).toBe(false);
      });

      test(`is refused before anything is sent, bound by ${label}`, () => {
        expect(() =>
          prepareForExchange(
            {
              linkageTerms: terms,
              ...(standardization !== undefined ? { standardization } : {}),
              ...(metadata !== undefined ? { metadata } : {}),
            },
            "Initiator Co",
            [{ first_name: "Maria", last_name: "Lopez", ssn4: "4821" }],
            columns,
          ),
        ).toThrow(LinkageTermsUnsatisfiableError);
      });
    }
  });

  test("an input with no column for a field a key element also reads cannot run that key, and can run the conditioned one", () => {
    const verdict = decideLinkageTermsVerdict(
      ["first_name", "last_name", "ssn4"],
      { ...TERMS, linkageKeys: [TERMS.linkageKeys[0], NO_DATE_KEY] },
    );
    expect(verdict.keys.map((graded) => graded.fitness)).toEqual([
      "unsatisfiable",
      "satisfiable",
    ]);
    expect(
      verdict.unsatisfiedFieldColumns.map(({ field }) => field.name),
    ).toEqual(["date_of_birth"]);
  });

  test("a condition naming an undeclared field cannot run the key", () => {
    const verdict = decideLinkageTermsVerdict(
      ["first_name", "last_name", "ssn4", "dob"],
      {
        ...TERMS,
        linkageKeys: [
          { ...NO_DATE_KEY, condition: { missingField: "birth_day" } },
        ],
      },
    );
    expect(verdict.keys).toEqual([
      {
        key: { ...NO_DATE_KEY, condition: { missingField: "birth_day" } },
        fitness: "unsatisfiable",
        missingField: "birth_day",
      },
    ]);
  });
});

describe("the first-round check on a conditioned first key", () => {
  // Every record has a valid date, so in each role one half of the key is
  // built for no record and the other for all of them.
  const datedRows = (count: number): Row[] =>
    Array.from({ length: count }, (_, i) =>
      person(
        `F${String.fromCharCode(65 + (i % 26))}${i}`,
        `L${i}`,
        String(1000 + i),
        "03/14/1980",
      ),
    );
  const { condition: _, ...plainKey } = NO_DATE_KEY;
  const prepared = (key: LinkageKey, rows: Row[]) =>
    prepareForExchange(
      { linkageTerms: { ...TERMS, identity: "A", linkageKeys: [key] } },
      "A",
      rows,
      COLUMNS,
    );
  const refusalOf = async (
    check: Promise<void>,
  ): Promise<RoundSetLimitError | undefined> => {
    try {
      await check;
    } catch (err) {
      if (err instanceof RoundSetLimitError) return err;
      throw err;
    }
    return undefined;
  };

  test("refuses before contact exactly where the same key with no condition is refused", async () => {
    for (const key of [plainKey, NO_DATE_KEY]) {
      const refusal = await refusalOf(
        assertFirstRoundWithinSetMaximum(prepared(key, datedRows(50)), {
          maxValues: 10,
        }),
      );
      expect(refusal?.reason).toBe("over-set-maximum");
      expect(refusal?.message).toMatch(/at least 50 values to send/);
    }
  });

  test("admits a conditioned first key whose two rounds both fit", async () => {
    expect(
      await refusalOf(
        assertFirstRoundWithinSetMaximum(prepared(NO_DATE_KEY, datedRows(10)), {
          maxValues: 10,
        }),
      ),
    ).toBeUndefined();
  });

  test("holds both rounds to the partner's receive ceiling in the resolved role", async () => {
    for (const isReceiver of [true, false]) {
      const [conn] = createMessagePipe();
      const refusal = await refusalOf(
        assertFirstRoundWithinPartnerCeiling(
          conn,
          prepared(NO_DATE_KEY, datedRows(50)),
          isReceiver,
          10,
          undefined,
        ),
      );
      expect(refusal?.reason).toBe("over-partner-ceiling");
    }
  });
});

describe("the filler date of birth", () => {
  test("is a cleaned date whose month and day are both 01", () => {
    expect(isFillerDateOfBirth("19850101")).toBe(true);
    expect(isFillerDateOfBirth("19850102")).toBe(false);
    expect(isFillerDateOfBirth("19851001")).toBe(false);
    expect(isFillerDateOfBirth("01/01/1985")).toBe(false);
  });

  test("is kept in the cleaned field and read by no key", () => {
    const terms: LinkageTerms = {
      ...TERMS,
      linkageKeys: [TERMS.linkageKeys[0]],
    };
    const rows = [
      person("Nina", "Rossi", "2759", "01/01/1980"),
      person("Nina", "Rossi", "2759", "01/02/1980"),
    ];
    const metadata = inferMetadata(COLUMNS, []);
    const dataset = buildStandardizedDataset(
      getDefaultStandardization(metadata, terms),
      rows,
      metadata,
      terms,
    );
    expect(dataset.getField("date_of_birth")?.get(0)).toEqual(["19800101"]);
    expect(dataset.keyValues("date_of_birth", 0)).toEqual([]);
    expect(buildKeyStrings(terms.linkageKeys[0], dataset, 0)).toBeNull();
    expect(buildKeyStrings(terms.linkageKeys[0], dataset, 1)).not.toBeNull();
  });
});
