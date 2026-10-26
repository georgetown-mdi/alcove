import { beforeAll, expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { getDefaultLinkageTerms } from "../src/defaults/builtInLinkageTerms";
import { runExchange } from "../src/exchange";
import { createMessagePipe } from "../src/connection/messageConnection";

import type { ExchangeResult } from "../src/exchange";
import { prepared } from "./utils/support";
import {
  buildCorpus,
  CORPUS_COLUMNS,
  type Corpus,
} from "./utils/linkageQualityCorpus";

// The linkage-quality regression guard: the shipped default terms run end to
// end over a synthetic corpus whose true pairs are known. Tier 1 pins what each
// pair class gets, tier 2 the precision, recall and per-key attribution of the
// whole run. Synthetic truth flatters, so neither is band evidence: what it
// covers is in docs/notes/linkage-rule-grounding.md, The synthetic regression
// corpus.

const UNMATCHED = "unmatched";

/**
 * Tier 1: what the default terms do with each pair class -- the key that first
 * claims each instance's two records, or `unmatched`. A key claiming one of an
 * instance's records with a record of another instance is recorded as
 * `<key> with another record`.
 */
const EXPECTED_OUTCOME: Readonly<Record<string, string>> = {
  "no error, full SSN on both sides": "SSN + LN + DOB",
  "no error, last four SSN digits on one side": "SSN4 + LN + DOB",
  "no error, no SSN on one side": "LN + FN + DOB + street number + ZIP5",
  "name suffix on one side, no SSN": "LN + FN + DOB + street number + ZIP5",
  "surname typo after its fourth letter, full SSN": "SSN + LN4 + DOB",
  "surname typo in its fourth letter, full SSN": "SSN + LN3 + DOB",
  "surname change, full SSN": "SSN + DOB + FN",
  "surname change, last four on one side": "SSN4 + FN + DOB",
  "surname change, no SSN, same phone": "FN + DOB + PHONE",
  "surname change, no SSN, new phone, same email": "FN + DOB + EMAIL",
  "surname change, no SSN, no shared contact": UNMATCHED,
  "surname change and first name variant, full SSN": "SSN + FN3 + DOB",
  "name swap, full SSN": "SSN + DOB",
  "name swap, last four on one side": "SSN4 + swap(LN, FN) + DOB",
  "name swap, no SSN": "swap(LN, FN) + DOB",
  "hyphenated surname on one side, full SSN": "SSN + LN4 + DOB",
  "hyphenated surname on one side, last four on one side":
    "SSN4 + split(LN) + FN + DOB",
  "hyphenated surname on one side, no SSN": "split(LN) + FN + DOB",
  "birth year off by one, full SSN": "SSN + FN + LN",
  "birth year off by one, last four on one side":
    "SSN4 + LN + FN + DOB +/-1 year",
  "birth year off by one, no SSN": "ZIP5 + LN + FN + DOB +/-1 year",
  "birth day off by one, full SSN": "SSN + FN + LN",
  "birth day off by one, last four on one side":
    "SSN4 + LN + FN + DOB +/-1 day",
  "birth day off by one, no SSN": "LN + FN + YOB + MOB + ZIP5",
  "day and month exchanged, full SSN": "SSN + FN + LN",
  "day and month exchanged, last four on one side":
    "SSN4 + LN + FN + DOB day/month exchanged",
  "day and month exchanged, no SSN": UNMATCHED,
  "another day of the month and a surname change, full SSN":
    "SSN + FN + YOB + MOB",
  "another day of the month, a surname change and a first name variant, full SSN":
    "SSN + FN3 + YOB + MOB",
  "another day of the month and another first name, full SSN":
    "SSN + LN4 + YOB + MOB",
  "another day of the month and another first name, last four on one side":
    "SSN4 + LN4 + YOB + MOB",
  "another day of the month, no SSN": "LN + FN + YOB + MOB + ZIP5",
  "unrelated date and a surname change, full SSN": "SSN + FN",
  "filler date on one side, full SSN": "SSN + FN + LN",
  "surname spelling variant and birth year off by one, full SSN":
    "SSN + soundex(FN) + soundex(LN)",
  "short first name and birth year off by one, full SSN": "SSN + LN + FN1",
  "short first name, surname typo and birth year off by one, full SSN":
    "SSN + LN3 + FN1",
  "SSN digit wrong in its first five": "SSN4 + LN + DOB",
  "SSN digit wrong in its last four": "LN + FN + DOB + street number + ZIP5",
  "new street address in the same ZIP, no SSN": "LN + FN + DOB + ZIP5",
  "moved to another ZIP, same phone, no SSN": "LN + FN + DOB + PHONE",
  "moved within the ZIP area, new phone, no SSN": "LN + FN + DOB + ZIP3",
  "moved out of the ZIP area, new phone, no SSN": "LN + FN + DOB + STATE",
  "no state on one side, moved out of the ZIP area, no phone, no SSN":
    "LN + FN + DOB + COUNTY",
  "no address or phone on one side, no SSN": "LN + FN + DOB",
  "surname spelling variant, same ZIP, no SSN": "ZIP5 + soundex(LN) + FN + DOB",
  "filler date on one side, same phone, no SSN": "LN + FN + PHONE",
  "no date on one side, surname spelling variant, same phone, no SSN":
    "PHONE + soundex(LN) + FN",
  "no date on one side, surname change, same phone, no SSN": "FN + PHONE",
  "no date on one side, same email, no phone, no SSN": "LN + FN + EMAIL",
  "no date on one side, surname spelling variant, same email, no phone, no SSN":
    "EMAIL + soundex(LN) + FN",
  "a made-up name one person gives both agencies, no SSN":
    "LN + FN + DOB + STATE",
  "a made-up name two people were each recorded under, filler dates of one year":
    UNMATCHED,
  "placeholder first name on twins, one in each file": UNMATCHED,
  "placeholder SSN both agencies hold, shared first name": UNMATCHED,
  "ZIP filler both agencies hold, shared name and birth month": UNMATCHED,
  "phone filler both agencies hold, shared first name, no date on one side":
    UNMATCHED,
  "two people sharing a name and date of birth": "LN + FN + DOB + STATE",
  "parent and child of one name at one address and phone, given each other's date":
    "LN + FN + DOB + street number + ZIP5",
  "parent and child of one name at one address and phone, no date on one side":
    "LN + FN + PHONE",
  "parent and child of one name at one address and phone, own dates": UNMATCHED,
  "twins at one address and phone, one in each file": UNMATCHED,
  "wife recorded under her husband's SSN, another initial": UNMATCHED,
  "wife recorded under her husband's SSN, the same initial": "SSN + LN + FN1",
  "in party A's file only": UNMATCHED,
  "in party B's file only": UNMATCHED,
};

/**
 * Default keys no true pair of the corpus is first claimed by, each with the
 * reason it cannot claim one in its position. Empty: every key claims one.
 */
const KEYS_NO_TRUE_PAIR_REACHES: Readonly<Record<string, string>> = {};

/** Tier 2: the pairs the default terms claim, true and false, per key, in
 * cascade order. */
const EXPECTED_ATTRIBUTION: Readonly<
  Record<string, { true: number; false: number }>
> = {
  "SSN + LN + DOB": { true: 50, false: 0 },
  "SSN + LN4 + DOB": { true: 9, false: 0 },
  "SSN + LN3 + DOB": { true: 3, false: 0 },
  "SSN + DOB + FN": { true: 4, false: 0 },
  "SSN + FN3 + DOB": { true: 3, false: 0 },
  "SSN + DOB": { true: 3, false: 0 },
  "SSN + FN + LN": { true: 12, false: 0 },
  "SSN + soundex(FN) + soundex(LN)": { true: 3, false: 0 },
  "SSN + LN + FN1": { true: 3, false: 3 },
  "SSN + LN3 + FN1": { true: 3, false: 0 },
  "SSN + FN + YOB + MOB": { true: 3, false: 0 },
  "SSN + FN3 + YOB + MOB": { true: 3, false: 0 },
  "SSN + LN4 + YOB + MOB": { true: 3, false: 0 },
  "SSN4 + LN + DOB": { true: 13, false: 0 },
  "SSN4 + split(LN) + FN + DOB": { true: 6, false: 0 },
  "SSN4 + FN + DOB": { true: 4, false: 0 },
  "SSN4 + LN + FN + DOB +/-1 year": { true: 3, false: 0 },
  "SSN4 + LN + FN + DOB +/-1 day": { true: 3, false: 0 },
  "SSN4 + LN + FN + DOB day/month exchanged": { true: 3, false: 0 },
  "SSN4 + swap(LN, FN) + DOB": { true: 3, false: 0 },
  "LN + FN + DOB + street number + ZIP5": { true: 56, false: 3 },
  "LN + FN + DOB + ZIP5": { true: 4, false: 0 },
  "LN + FN + DOB + PHONE": { true: 4, false: 0 },
  "FN + DOB + PHONE": { true: 3, false: 0 },
  "SSN + FN": { true: 3, false: 0 },
  "SSN4 + LN4 + YOB + MOB": { true: 3, false: 0 },
  "LN + FN + DOB + ZIP3": { true: 3, false: 0 },
  "ZIP5 + soundex(LN) + FN + DOB": { true: 3, false: 0 },
  "ZIP5 + LN + FN + DOB +/-1 year": { true: 3, false: 0 },
  "LN + FN + DOB + STATE": { true: 6, false: 3 },
  "LN + FN + DOB + COUNTY": { true: 3, false: 0 },
  "LN + FN + DOB": { true: 4, false: 0 },
  "swap(LN, FN) + DOB": { true: 3, false: 0 },
  "split(LN) + FN + DOB": { true: 6, false: 0 },
  "LN + FN + YOB + MOB + ZIP5": { true: 6, false: 0 },
  "LN + FN + PHONE": { true: 3, false: 3 },
  "PHONE + soundex(LN) + FN": { true: 3, false: 0 },
  "FN + PHONE": { true: 3, false: 0 },
  "FN + DOB + EMAIL": { true: 3, false: 0 },
  "LN + FN + EMAIL": { true: 3, false: 0 },
  "EMAIL + soundex(LN) + FN": { true: 3, false: 0 },
};

/** Tier 2: the counts the precision and recall are taken from: 265 of 271
 * true pairs claimed (recall 97.8%), beside 12 false pairs (precision
 * 95.7%). */
const EXPECTED_TOTALS = {
  truePairs: 271,
  truePairsClaimed: 265,
  falsePairsClaimed: 12,
};

/**
 * The floors no pin moves. The precision floor is the catalog's lowest band,
 * which the default selection takes (docs/notes/linkage-rule-catalog.md,
 * Bands). The notes set no recall floor; this one is a choice, not a
 * measurement.
 */
const PRECISION_FLOOR = 0.95;
const RECALL_FLOOR = 0.95;

const psiLibrary = await PSI();
const corpus: Corpus = buildCorpus();
const defaultKeyNames = getDefaultLinkageTerms("Party A").linkageKeys.map(
  (key) => key.name,
);

/** One claimed pair: its rows in each file and the key that claimed it. */
interface ClaimedPair {
  aRow: number;
  bRow: number;
  key: string;
}

let claimed: Array<ClaimedPair> = [];

async function runDefaultTerms(): Promise<ExchangeResult> {
  const [connA, connB] = createMessagePipe();
  const columns = [...CORPUS_COLUMNS];
  const side = (identity: string, rows: Corpus["a"]) => ({
    ...prepared(
      identity,
      rows.map((record) => record.row),
      { linkageTerms: getDefaultLinkageTerms(identity), columns },
    ),
    includeMatchingKey: true,
  });
  const [resultA] = await Promise.all([
    runExchange(connA, "initiator", side("Party A", corpus.a), { psiLibrary }),
    runExchange(connB, "responder", side("Party B", corpus.b), { psiLibrary }),
  ]);
  return resultA;
}

beforeAll(async () => {
  const result = await runDefaultTerms();
  const table = result.associationTable;
  const keys = result.matchedKeyOfPair;
  if (table === undefined || keys === undefined)
    throw new Error("the run returned no association table or matched keys");
  claimed = table[0].map((aRow, i) => ({
    aRow,
    bRow: table[1][i],
    key: keyOfRoundLabel(keys[i]),
  }));
}, 120_000);

/** The key a matched-key label names: a conditioned key's round appends whose
 * record lacked the field to the key's name. */
function keyOfRoundLabel(label: string): string {
  const key = defaultKeyNames.find(
    (name) => label === name || label.startsWith(`${name} (`),
  );
  if (key === undefined)
    throw new Error(`the matched-key label "${label}" names no default key`);
  return key;
}

function isTruePair(pair: ClaimedPair): boolean {
  return corpus.a[pair.aRow].personId === corpus.b[pair.bRow].personId;
}

/** Each instance's outcome, as {@link EXPECTED_OUTCOME} states it. */
function instanceOutcomes(): Array<{ className: string; outcome: string }> {
  const byA = new Map(claimed.map((pair) => [pair.aRow, pair]));
  const byB = new Map(claimed.map((pair) => [pair.bRow, pair]));
  return corpus.instances.map(({ className, aRow, bRow }) => {
    const pairOfA = aRow === undefined ? undefined : byA.get(aRow);
    if (pairOfA !== undefined && pairOfA.bRow === bRow)
      return { className, outcome: pairOfA.key };
    const elsewhere =
      pairOfA ?? (bRow === undefined ? undefined : byB.get(bRow));
    return {
      className,
      outcome:
        elsewhere === undefined
          ? UNMATCHED
          : `${elsewhere.key} with another record`,
    };
  });
}

test("the corpus is the same from one build to the next", () => {
  expect(buildCorpus()).toEqual(corpus);
});

test("every instance's records are labeled as its class's truth states", () => {
  const truthOf = new Map(
    corpus.classes.map((pairClass) => [pairClass.name, pairClass.truth]),
  );
  const mislabeled = corpus.instances.filter(({ className, aRow, bRow }) => {
    const truth = truthOf.get(className);
    if (aRow === undefined || bRow === undefined) return truth !== "single";
    const samePerson = corpus.a[aRow].personId === corpus.b[bRow].personId;
    return truth !== (samePerson ? "same person" : "different people");
  });
  expect(mislabeled).toEqual([]);
});

test("every phone and email in the corpus is a fictional one or a filler", () => {
  const records = [...corpus.a, ...corpus.b];
  const phones = records
    .map((record) => record.row.phone_number.replace(/\D/g, ""))
    .filter((phone) => phone !== "" && !/^\d*(?:9{7}|0{7})\d*$/.test(phone));
  expect(phones.filter((phone) => !/^\d{3}55501\d{2}$/.test(phone))).toEqual(
    [],
  );
  const emails = records.map((record) =>
    record.row.email_address.toLowerCase(),
  );
  expect(
    emails.filter((email) => email !== "" && !email.endsWith("@example.org")),
  ).toEqual([]);
});

test("every pair class gets the outcome pinned for it", () => {
  // Every class pinned, and nothing pinned for a class the corpus lacks.
  expect(Object.keys(EXPECTED_OUTCOME).sort()).toEqual(
    corpus.classes.map((pairClass) => pairClass.name).sort(),
  );

  const moved = new Map<string, Map<string, number>>();
  for (const { className, outcome } of instanceOutcomes()) {
    if (outcome === EXPECTED_OUTCOME[className]) continue;
    const outcomes = moved.get(className) ?? new Map<string, number>();
    outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
    moved.set(className, outcomes);
  }
  const report = [...moved].flatMap(([className, outcomes]) =>
    [...outcomes].map(
      ([outcome, count]) =>
        `"${className}": expected ${EXPECTED_OUTCOME[className]}, got ${outcome} for ${count}`,
    ),
  );
  expect(report).toEqual([]);
});

test("every default key first claims a true pair, or is listed with the reason it cannot", () => {
  const keysClaimingTruePairs = new Set(
    claimed.filter(isTruePair).map((pair) => pair.key),
  );
  const unreached = defaultKeyNames.filter(
    (key) => !keysClaimingTruePairs.has(key),
  );
  expect(unreached).toEqual(Object.keys(KEYS_NO_TRUE_PAIR_REACHES));
});

function attribution(): Record<string, { true: number; false: number }> {
  const perKey: Record<string, { true: number; false: number }> = {};
  for (const key of defaultKeyNames) perKey[key] = { true: 0, false: 0 };
  for (const pair of claimed) {
    const counts = perKey[pair.key];
    if (isTruePair(pair)) counts.true++;
    else counts.false++;
  }
  return perKey;
}

function totals(): typeof EXPECTED_TOTALS {
  const bPeople = new Set(corpus.b.map((record) => record.personId));
  const truePairsClaimed = claimed.filter(isTruePair).length;
  return {
    truePairs: corpus.a.filter((record) => bPeople.has(record.personId)).length,
    truePairsClaimed,
    falsePairsClaimed: claimed.length - truePairsClaimed,
  };
}

test("the precision, recall and per-key attribution of the default terms are the pinned ones", () => {
  // A change that moves these updates the pin in the same commit.
  expect(attribution()).toEqual(EXPECTED_ATTRIBUTION);
  expect(totals()).toEqual(EXPECTED_TOTALS);
});

test("the default terms keep precision and recall above their floors", () => {
  const { truePairs, truePairsClaimed, falsePairsClaimed } = totals();
  const precision = truePairsClaimed / (truePairsClaimed + falsePairsClaimed);
  const recall = truePairsClaimed / truePairs;
  expect(precision).toBeGreaterThanOrEqual(PRECISION_FLOOR);
  expect(recall).toBeGreaterThanOrEqual(RECALL_FLOOR);
});
