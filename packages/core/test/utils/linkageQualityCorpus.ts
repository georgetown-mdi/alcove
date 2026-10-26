// A synthetic two-party corpus with known truth, for the linkage-quality
// regression guard (linkageQualityCorpus.test.ts). Every record holds the id of
// the person it describes, so every cross-file pair is labeled. It is built in
// memory from a fixed seed and never written out: names are made of syllables,
// phones are 555-01XX numbers, emails are at reserved example domains, and SSNs
// are random numbers the default `ssn` cleaning keeps. What the guard covers and
// what it cannot show: docs/notes/linkage-rule-grounding.md, The synthetic
// regression corpus.

import { SSN4_FROM_SSN_STEPS, SSN_STEPS } from "../../src/defaults/ssnSteps";
import { runPipeline } from "../../src/standardization";

/** The input columns, each named for the field type it is inferred as. */
export const CORPUS_COLUMNS = [
  "ssn",
  "first_name",
  "last_name",
  "date_of_birth",
  "phone_number",
  "email_address",
  "zip_code",
  "state",
  "county",
  "street_number",
] as const;

/** One input column of the corpus. */
export type CorpusColumn = (typeof CORPUS_COLUMNS)[number];

/** One party's record: its input row, and the person it describes. */
export interface CorpusRecord {
  personId: number;
  row: Record<CorpusColumn, string>;
}

/** The two parties' files, and the pair class each record was built for. */
export interface Corpus {
  a: Array<CorpusRecord>;
  b: Array<CorpusRecord>;
  /** Each instance of each class: the class name and the row of its record in
   * each file, or `undefined` for a file the class puts no record in. */
  instances: Array<{
    className: string;
    aRow: number | undefined;
    bRow: number | undefined;
  }>;
  classes: ReadonlyArray<PairClass>;
}

/**
 * Where a class's count comes from. `cited` is a prevalence the linkage notes
 * give, quoted with its source; `reasoning` is a share the notes do not give,
 * chosen here, with what it rests on.
 */
export type ClassShare =
  | { basis: "cited"; share: number; citation: string }
  | { basis: "reasoning"; share: number; note: string };

/** How one pair class builds its records. */
export interface PairClass {
  name: string;
  /** Whether the class's two records describe one person. A `single` class
   * puts one record in one file and labels no pair. */
  truth: "same person" | "different people" | "single";
  /** The note and section the error mode or look-alike comes from. */
  source: string;
  share: ClassShare;
  /** Builds the class's `instance`th instance, counting from 0: the A and B
   * record, either absent. */
  build: (
    people: PeopleSource,
    instance: number,
  ) => {
    a: PersonRecord | undefined;
    b: PersonRecord | undefined;
  };
}

/** The values one record states, before each party writes them as cells. */
export interface PersonRecord {
  personId: number;
  firstName: string;
  lastName: string;
  /** `MM/DD/YYYY`, or empty for none. */
  dateOfBirth: string;
  /** Nine digits, `XXX-XX-` and the last four for a masked SSN, or empty. */
  ssn: string;
  /** Ten digits, or empty. */
  phone: string;
  email: string;
  zip: string;
  state: string;
  county: string;
  streetNumber: string;
}

/** The true pairs a class's share is taken of, so a share of 0.05 is ten
 * instances. Sized to keep the run to seconds. */
export const SHARE_SCALE = 200;

/** The fewest instances of any class, so a single-key regression moves more
 * than one pair. */
export const MIN_INSTANCES = 3;

/** The seed the corpus is built from. */
export const CORPUS_SEED = 0x2806_0468;

/** A deterministic PRNG (mulberry32). */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Consonants with no H, W or Y and vowels between every pair of them, so a
// name's Soundex code is its first letter and the codes of its next three
// consonants, and a vowel change leaves the code alone.
const CONSONANTS = "BDGKLMNPRSTVZ";
const VOWELS = "AEIOU";
const SOUNDEX_CODE: Record<string, string> = {
  B: "1",
  P: "1",
  V: "1",
  G: "2",
  K: "2",
  S: "2",
  Z: "2",
  D: "3",
  T: "3",
  L: "4",
  M: "5",
  N: "5",
  R: "6",
};

// The ZIP areas the corpus's addresses fall in, all in the one state.
const ZIP_AREAS = ["206", "207", "208", "209", "210", "211", "212", "214"];
const AREA_CODES = Array.from({ length: 40 }, (_unused, i) => String(220 + i));

/** The draws a class builds its records from. */
export class PeopleSource {
  private readonly random: () => number;
  private readonly usedNames = new Set<string>();
  private readonly usedSsns = new Set<string>();
  private nextPersonId = 0;
  private nextPhone = 0;
  private counties: Array<string>;

  constructor(seed: number) {
    this.random = seededRandom(seed);
    this.counties = Array.from({ length: 6 }, () => this.syllables(3));
  }

  /** A whole number from `low` to `high`, both included. */
  int(low: number, high: number): number {
    return low + Math.floor(this.random() * (high - low + 1));
  }

  pick<T>(values: ReadonlyArray<T>): T {
    return values[this.int(0, values.length - 1)];
  }

  private syllables(count: number): string {
    let out = "";
    for (let i = 0; i < count; i++)
      out += this.pick([...CONSONANTS]) + this.pick([...VOWELS]);
    return out;
  }

  /** A name no other draw returned: three consonant-vowel syllables, and a
   * closing consonant for a last name. */
  name(kind: "first" | "last"): string {
    for (;;) {
      let candidate = this.syllables(3);
      if (kind === "last") candidate += this.pick([...CONSONANTS]);
      if (!this.usedNames.has(candidate)) {
        this.usedNames.add(candidate);
        return candidate;
      }
    }
  }

  /** A name starting with a letter other than `name`'s, so the two agree on no
   * prefix and no Soundex code. */
  otherName(kind: "first" | "last", name: string): string {
    for (;;) {
      const candidate = this.name(kind);
      if (candidate[0] !== name[0]) return candidate;
    }
  }

  /** A date of birth from 1940 to 2005, its day from 2 to 28 and never the
   * filler 1 January. */
  birth(): { year: number; month: number; day: number } {
    return {
      year: this.int(1940, 2005),
      month: this.int(1, 12),
      day: this.int(2, 28),
    };
  }

  /** A nine-digit SSN the default `ssn` and `ssn4` cleaning both keep, distinct
   * from every other drawn. */
  ssn(): string {
    for (;;) {
      const area = this.int(1, 899);
      const group = this.int(1, 99);
      const serial = this.int(1, 9999);
      const candidate = `${String(area).padStart(3, "0")}${String(group).padStart(2, "0")}${String(serial).padStart(4, "0")}`;
      if (this.usedSsns.has(candidate) || !keptByDefaultCleaning(candidate))
        continue;
      this.usedSsns.add(candidate);
      return candidate;
    }
  }

  /** A fictional 555-01XX number no other draw returned. */
  phone(): string {
    const index = this.nextPhone++;
    const area = AREA_CODES[Math.floor(index / 100)];
    if (area === undefined)
      throw new Error("the corpus ran out of 555-01XX numbers");
    return `${area}55501${String(index % 100).padStart(2, "0")}`;
  }

  zip(area: string = this.pick(ZIP_AREAS)): string {
    return `${area}${String(this.int(10, 99))}`;
  }

  /** A ZIP in the same area as `zip` and differing from it. */
  zipInArea(zip: string): string {
    for (;;) {
      const candidate = this.zip(zip.slice(0, 3));
      if (candidate !== zip) return candidate;
    }
  }

  /** A ZIP in an area other than `zip`'s. */
  zipOutsideArea(zip: string): string {
    return this.zip(
      this.pick(ZIP_AREAS.filter((area) => area !== zip.slice(0, 3))),
    );
  }

  county(): string {
    return this.pick(this.counties);
  }

  personId(): number {
    return this.nextPersonId++;
  }

  /** A new person, as a record holding every field. */
  person(): PersonRecord {
    const firstName = this.name("first");
    const lastName = this.name("last");
    const birth = this.birth();
    const personId = this.personId();
    return {
      personId,
      firstName,
      lastName,
      dateOfBirth: formatDate(birth),
      ssn: this.ssn(),
      phone: this.phone(),
      email: `${firstName}.${lastName}.${personId}@example.org`.toLowerCase(),
      zip: this.zip(),
      state: "MD",
      county: this.county(),
      streetNumber: String(this.int(1, 9999)),
    };
  }
}

/** Whether the default cleaning keeps all nine digits of `digits` as the
 * `ssn` value and its last four as the `ssn4` value. */
function keptByDefaultCleaning(digits: string): boolean {
  return (
    runPipeline(digits, SSN_STEPS) === digits &&
    runPipeline(digits, SSN4_FROM_SSN_STEPS) === digits.slice(5)
  );
}

function formatDate(date: {
  year: number;
  month: number;
  day: number;
}): string {
  return `${String(date.month).padStart(2, "0")}/${String(date.day).padStart(2, "0")}/${date.year}`;
}

function parseDate(value: string): {
  year: number;
  month: number;
  day: number;
} {
  const [month, day, year] = value.split("/").map(Number);
  return { year, month, day };
}

function otherVowel(people: PeopleSource, vowel: string): string {
  return people.pick([...VOWELS].filter((candidate) => candidate !== vowel));
}

function consonantOfOtherCode(people: PeopleSource, consonant: string): string {
  return people.pick(
    [...CONSONANTS].filter(
      (candidate) => SOUNDEX_CODE[candidate] !== SOUNDEX_CODE[consonant],
    ),
  );
}

function replaceAt(name: string, index: number, letter: string): string {
  return name.slice(0, index) + letter + name.slice(index + 1);
}

// The name edits the classes build from. Names alternate consonant and vowel,
// a consonant first, so index 1, 3 and 5 hold vowels.

/** A spelling variant with the same Soundex code, differing in the second
 * letter, so it shares no three-letter prefix with `name`. */
function soundexVariant(people: PeopleSource, name: string): string {
  return replaceAt(name, 1, otherVowel(people, name[1]));
}

/** `name` with its fourth letter changed: the first three letters agree. */
function fourthLetterTypo(people: PeopleSource, name: string): string {
  return replaceAt(name, 3, otherVowel(people, name[3]));
}

/** `name` with its sixth letter changed: the first four letters agree. */
function sixthLetterTypo(people: PeopleSource, name: string): string {
  return replaceAt(name, 5, otherVowel(people, name[5]));
}

/** `name` with its fifth letter, a consonant, changed to one of another Soundex
 * code: the first four letters agree and the codes differ. */
function fifthLetterOtherCode(people: PeopleSource, name: string): string {
  return replaceAt(name, 4, consonantOfOtherCode(people, name[4]));
}

/** A first name sharing `name`'s initial alone, with another Soundex code, as
 * a short form of a name often is. */
function sameInitialOtherCode(people: PeopleSource, name: string): string {
  return replaceAt(
    replaceAt(name, 2, consonantOfOtherCode(people, name[2])),
    1,
    otherVowel(people, name[1]),
  ).slice(0, 4);
}

/** The person with their last name replaced by one sharing nothing with it,
 * as after a marriage. */
function withNewLastName(
  people: PeopleSource,
  record: PersonRecord,
): PersonRecord {
  return { ...record, lastName: people.otherName("last", record.lastName) };
}

/** `value` moved by whole years or days, the day kept within its month by the
 * caller. */
function shiftDate(
  value: string,
  shift: { years?: number; days?: number },
): string {
  const date = parseDate(value);
  return formatDate({
    year: date.year + (shift.years ?? 0),
    month: date.month,
    day: date.day + (shift.days ?? 0),
  });
}

/** A date of birth whose day and month can be exchanged into another valid
 * date: both from 2 to 12 and different. */
function exchangeableBirth(people: PeopleSource): string {
  const month = people.int(2, 12);
  let day = people.int(2, 12);
  while (day === month) day = people.int(2, 12);
  return formatDate({ year: people.int(1940, 2005), month, day });
}

function dayMonthExchanged(value: string): string {
  const date = parseDate(value);
  return formatDate({ year: date.year, month: date.day, day: date.month });
}

/** A date in the same year and month and a day more than one away. */
function otherDayOfMonth(people: PeopleSource, value: string): string {
  const date = parseDate(value);
  for (;;) {
    const day = people.int(2, 28);
    if (Math.abs(day - date.day) > 1) return formatDate({ ...date, day });
  }
}

/** A date in another year and month. */
function unrelatedDate(people: PeopleSource, value: string): string {
  const date = parseDate(value);
  return formatDate({
    year: date.year + people.int(3, 12) * (people.int(0, 1) === 0 ? -1 : 1),
    month: (date.month % 12) + 1,
    day: date.day,
  });
}

function fillerDate(value: string): string {
  return `01/01/${parseDate(value).year}`;
}

function masked(ssn: string): string {
  return `XXX-XX-${ssn.slice(5)}`;
}

/** `ssn` with one digit among `positions` changed, kept valid. */
function ssnKeyingError(
  people: PeopleSource,
  ssn: string,
  positions: ReadonlyArray<number>,
): string {
  for (;;) {
    const position = people.pick(positions);
    const digit = String(people.int(0, 9));
    const candidate = replaceAt(ssn, position, digit);
    if (candidate !== ssn && keptByDefaultCleaning(candidate)) return candidate;
  }
}

/** How the full SSN reaches each side of a true pair. */
type SsnArrangement = "full" | "last four" | "none";

/** `b` with its SSN as `arrangement` leaves it: whole, masked to its last four,
 * or absent. */
function arrange(arrangement: SsnArrangement, b: PersonRecord): PersonRecord {
  switch (arrangement) {
    case "full":
      return b;
    case "last four":
      return { ...b, ssn: masked(b.ssn) };
    case "none":
      return { ...b, ssn: "" };
  }
}

/** A true pair: the person as party A holds them, and as party B does after
 * `change`, the SSN as `arrangement` leaves it. */
function truePair(
  people: PeopleSource,
  arrangement: SsnArrangement,
  change: (a: PersonRecord) => { a?: PersonRecord; b: PersonRecord },
  base: PersonRecord = people.person(),
): { a: PersonRecord; b: PersonRecord } {
  const changed = change(base);
  return { a: changed.a ?? base, b: arrange(arrangement, changed.b) };
}

const noContact = { phone: "", email: "" };

// Section names the classes cite.
const GROUNDING = "linkage-rule-grounding.md";
const CATALOG = "linkage-rule-catalog.md";

// The shares the corpus composes classes from. A date discrepancy's own
// prevalence is not given, only how discrepancies split (Just et al. 2016).
const DATE_DISCREPANCY_SHARE = 0.05;
const SSN_KEYING_ERROR_SHARE = 0.017;
const NAME_SWAP_SHARE = 0.0175;
const SPLIT_SURNAME_SHARE = 0.091;

const dateShare = (split: number, citation: string): ClassShare => ({
  basis: "reasoning",
  share: DATE_DISCREPANCY_SHARE * split,
  note: `an assumed 5% of true pairs with a date discrepancy, times ${citation}`,
});

const reasoned = (share: number, note: string): ClassShare => ({
  basis: "reasoning",
  share,
  note,
});

/**
 * The pair classes, in no order the guard reads. Each builds its records the
 * same way every instance, so each has one expected outcome.
 */
export const PAIR_CLASSES: ReadonlyArray<PairClass> = [
  // --- Pairs agreeing on every field they hold -------------------------------
  {
    name: "no error, full SSN on both sides",
    truth: "same person",
    source: `${CATALOG}, Rules with a full SSN`,
    share: {
      basis: "cited",
      share: 0.25,
      citation:
        "SSN availability of 50% (Culbertson et al. 2017) on each side, computed as independent",
    },
    build: (people) => truePair(people, "full", (a) => ({ b: a })),
  },
  {
    name: "no error, last four SSN digits on one side",
    truth: "same person",
    source: `${GROUNDING}, The last four SSN digits`,
    share: reasoned(0.05, "HUD requires only the last four; no share is given"),
    build: (people) => truePair(people, "last four", (a) => ({ b: a })),
  },
  {
    name: "no error, no SSN on one side",
    truth: "same person",
    source: `${CATALOG}, Rules with a full SSN`,
    share: reasoned(
      0.25,
      "SSN availability of 50% (Culbertson et al. 2017) puts one side missing at 50%, held to 25% to keep the run short",
    ),
    build: (people) => truePair(people, "none", (a) => ({ b: a })),
  },

  // --- Name suffixes ----------------------------------------------------------
  {
    name: "name suffix on one side, no SSN",
    truth: "same person",
    source: `${GROUNDING}, Name suffixes`,
    share: {
      basis: "cited",
      share: 0.003,
      citation:
        "students with a suffix were 0.3% of a sample (Dynarski et al. 2013)",
    },
    build: (people) =>
      truePair(people, "none", (a) => ({
        a: { ...a, lastName: `${a.lastName} Jr.` },
        b: a,
      })),
  },

  // --- Surname typos and changes ---------------------------------------------
  {
    name: "surname typo after its fourth letter, full SSN",
    truth: "same person",
    source: `${CATALOG}, 2. \`SSN + LN4 + DOB\``,
    share: reasoned(0.01, "no prevalence of surname typos is given"),
    build: (people) =>
      truePair(people, "full", (a) => ({
        b: { ...a, lastName: sixthLetterTypo(people, a.lastName) },
      })),
  },
  {
    name: "surname typo in its fourth letter, full SSN",
    truth: "same person",
    source: `${CATALOG}, 3. \`SSN + LN3 + DOB\``,
    share: reasoned(0.01, "no prevalence of surname typos is given"),
    build: (people) =>
      truePair(people, "full", (a) => ({
        b: { ...a, lastName: fourthLetterTypo(people, a.lastName) },
      })),
  },
  ...(["full", "last four"] as const).map((arrangement): PairClass => ({
    name: `surname change, ${arrangement === "full" ? "full SSN" : "last four on one side"}`,
    truth: "same person",
    source: `${CATALOG}, 16. \`SSN4 + FN + DOB\``,
    share: reasoned(
      0.02,
      "a last-name change is a share of missed matches (Ross et al. 2020), not of true pairs",
    ),
    build: (people) =>
      truePair(people, arrangement, (a) => ({ b: withNewLastName(people, a) })),
  })),
  {
    name: "surname change, no SSN, same phone",
    truth: "same person",
    source: `${CATALOG}, 24. \`FN + DOB + PHONE\``,
    share: reasoned(0.01, "a last-name change, with the household phone kept"),
    build: (people) =>
      truePair(people, "none", (a) => ({
        b: { ...withNewLastName(people, a), zip: people.zipOutsideArea(a.zip) },
      })),
  },
  {
    name: "surname change, no SSN, new phone, same email",
    truth: "same person",
    source: `${CATALOG}, 37. \`FN + DOB + EMAIL\``,
    share: reasoned(0.01, "a last-name change and a phone change together"),
    build: (people) =>
      truePair(people, "none", (a) => ({
        b: {
          ...withNewLastName(people, a),
          phone: people.phone(),
          zip: people.zipOutsideArea(a.zip),
        },
      })),
  },
  {
    name: "surname change, no SSN, no shared contact",
    truth: "same person",
    source: `${GROUNDING}, What transfers to two-party exact matching`,
    share: reasoned(0.01, "a last-name change with no other field to link on"),
    build: (people) =>
      truePair(people, "none", (a) => ({
        b: {
          ...withNewLastName(people, a),
          ...noContact,
          zip: people.zipOutsideArea(a.zip),
        },
      })),
  },
  {
    name: "surname change and first name variant, full SSN",
    truth: "same person",
    source: `${CATALOG}, 5. \`SSN + FN3 + DOB\``,
    share: reasoned(0.005, "a last-name change beside a first-name variant"),
    build: (people) =>
      truePair(people, "full", (a) => ({
        b: {
          ...withNewLastName(people, a),
          firstName: sixthLetterTypo(people, a.firstName),
        },
      })),
  },

  // --- Name swaps ------------------------------------------------------------
  ...(["full", "last four", "none"] as const).map((arrangement): PairClass => ({
    name: `name swap, ${arrangement === "full" ? "full SSN" : arrangement === "last four" ? "last four on one side" : "no SSN"}`,
    truth: "same person",
    source: `${GROUNDING}, Why one loosened element`,
    share: {
      basis: "cited",
      share: NAME_SWAP_SHARE / 3,
      citation:
        "name swaps were about 1.75% of true pairs (Just et al. 2016), split across three SSN arrangements",
    },
    build: (people) =>
      truePair(people, arrangement, (a) => ({
        b: {
          ...a,
          firstName: a.lastName,
          lastName: a.firstName,
          ...(arrangement === "none"
            ? { zip: people.zipOutsideArea(a.zip), phone: "" }
            : {}),
        },
      })),
  })),

  // --- Hyphenated surnames ---------------------------------------------------
  ...(["full", "last four", "none"] as const).map((arrangement): PairClass => ({
    name: `hyphenated surname on one side, ${arrangement === "full" ? "full SSN" : arrangement === "last four" ? "last four on one side" : "no SSN"}`,
    truth: "same person",
    source: `${CATALOG}, 33. \`split(LN) + FN + DOB\``,
    share: {
      basis: "cited",
      share: SPLIT_SURNAME_SHARE / 3,
      citation:
        "splitting names added up to 9.1% of a statewide match (Barrat and Berliner 2013), an upper bound, split across three SSN arrangements",
    },
    build: (people) =>
      truePair(people, arrangement, (a) => ({
        a: { ...a, lastName: `${a.lastName}-${people.name("last")}` },
        b:
          arrangement === "none"
            ? { ...a, zip: people.zipOutsideArea(a.zip), phone: "" }
            : a,
      })),
  })),

  // --- Date discrepancies ----------------------------------------------------
  ...(["full", "last four", "none"] as const).map((arrangement): PairClass => ({
    name: `birth year off by one, ${arrangement === "full" ? "full SSN" : arrangement === "last four" ? "last four on one side" : "no SSN"}`,
    truth: "same person",
    source: `${CATALOG}, 17. \`SSN4 + LN + FN + DOB +/-1 year\``,
    share: dateShare(
      0.4 / 3,
      "the year differing in 40.0% of them (Just et al. 2016), split across three SSN arrangements",
    ),
    build: (people) =>
      truePair(people, arrangement, (a) => ({
        b: { ...a, dateOfBirth: shiftDate(a.dateOfBirth, { years: 1 }) },
      })),
  })),
  ...(["full", "last four", "none"] as const).map((arrangement): PairClass => ({
    name: `birth day off by one, ${arrangement === "full" ? "full SSN" : arrangement === "last four" ? "last four on one side" : "no SSN"}`,
    truth: "same person",
    source: `${CATALOG}, 18. \`SSN4 + LN + FN + DOB +/-1 day\``,
    share: dateShare(
      0.483 / 2 / 3,
      "the day differing in 48.3% of them (Just et al. 2016), half by one day, split across three SSN arrangements",
    ),
    build: (people) =>
      truePair(people, arrangement, (a) => {
        const birth = parseDate(a.dateOfBirth);
        const base =
          birth.day === 28
            ? { ...a, dateOfBirth: formatDate({ ...birth, day: 27 }) }
            : a;
        return {
          a: base,
          b: { ...base, dateOfBirth: shiftDate(base.dateOfBirth, { days: 1 }) },
        };
      }),
  })),
  ...(["full", "last four", "none"] as const).map((arrangement): PairClass => ({
    name: `day and month exchanged, ${arrangement === "full" ? "full SSN" : arrangement === "last four" ? "last four on one side" : "no SSN"}`,
    truth: "same person",
    source: `${CATALOG}, 19. \`SSN4 + LN + FN + DOB day/month exchanged\``,
    share: dateShare(
      0.026 / 3,
      "day and month exchanged in 2.6% of them (Just et al. 2016), split across three SSN arrangements",
    ),
    build: (people) =>
      truePair(people, arrangement, (a) => {
        const base = { ...a, dateOfBirth: exchangeableBirth(people) };
        return {
          a: base,
          b: { ...base, dateOfBirth: dayMonthExchanged(base.dateOfBirth) },
        };
      }),
  })),
  {
    name: "another day of the month and a surname change, full SSN",
    truth: "same person",
    source: `${CATALOG}, 11. \`SSN + FN + YOB + MOB\``,
    share: dateShare(
      0.483 / 2 / 5,
      "the day differing in 48.3% of them (Just et al. 2016), half by more than one day, split five ways",
    ),
    build: (people) =>
      truePair(people, "full", (a) => ({
        b: {
          ...withNewLastName(people, a),
          dateOfBirth: otherDayOfMonth(people, a.dateOfBirth),
        },
      })),
  },
  {
    name: "another day of the month, a surname change and a first name variant, full SSN",
    truth: "same person",
    source: `${CATALOG}, 12. \`SSN + FN3 + YOB + MOB\``,
    share: dateShare(
      0.483 / 2 / 5,
      "the day differing in 48.3% of them (Just et al. 2016), half by more than one day, split five ways",
    ),
    build: (people) =>
      truePair(people, "full", (a) => ({
        b: {
          ...withNewLastName(people, a),
          firstName: sixthLetterTypo(people, a.firstName),
          dateOfBirth: otherDayOfMonth(people, a.dateOfBirth),
        },
      })),
  },
  ...(["full", "last four"] as const).map((arrangement): PairClass => ({
    name: `another day of the month and another first name, ${arrangement === "full" ? "full SSN" : "last four on one side"}`,
    truth: "same person",
    source: `${CATALOG}, ${arrangement === "full" ? "13. `SSN + LN4 + YOB + MOB`" : "26. `SSN4 + LN4 + YOB + MOB`"}`,
    share: dateShare(
      0.483 / 2 / 5,
      "the day differing in 48.3% of them (Just et al. 2016), half by more than one day, split five ways",
    ),
    build: (people) =>
      truePair(people, arrangement, (a) => ({
        b: {
          ...a,
          firstName: people.otherName("first", a.firstName),
          dateOfBirth: otherDayOfMonth(people, a.dateOfBirth),
        },
      })),
  })),
  {
    name: "another day of the month, no SSN",
    truth: "same person",
    source: `${CATALOG}, 34. \`LN + FN + YOB + MOB + ZIP5\``,
    share: dateShare(
      0.483 / 2 / 5,
      "the day differing in 48.3% of them (Just et al. 2016), half by more than one day, split five ways",
    ),
    build: (people) =>
      truePair(people, "none", (a) => ({
        b: { ...a, dateOfBirth: otherDayOfMonth(people, a.dateOfBirth) },
      })),
  },
  {
    name: "unrelated date and a surname change, full SSN",
    truth: "same person",
    source: `${CATALOG}, 25. \`SSN + FN\``,
    share: reasoned(
      0.005,
      "a date wrong in year and month beside a last-name change",
    ),
    build: (people) =>
      truePair(people, "full", (a) => ({
        b: {
          ...withNewLastName(people, a),
          dateOfBirth: unrelatedDate(people, a.dateOfBirth),
        },
      })),
  },
  {
    name: "filler date on one side, full SSN",
    truth: "same person",
    source: `${GROUNDING}, What transfers to two-party exact matching`,
    share: reasoned(0.01, "HUD's filler month and day; no share is given"),
    build: (people) =>
      truePair(people, "full", (a) => ({
        b: { ...a, dateOfBirth: fillerDate(a.dateOfBirth) },
      })),
  },

  // --- Phonetic and short-form names beside a full SSN -----------------------
  {
    name: "surname spelling variant and birth year off by one, full SSN",
    truth: "same person",
    source: `${CATALOG}, 8. \`SSN + soundex(FN) + soundex(LN)\``,
    share: reasoned(0.005, "a spelling variant beside a date discrepancy"),
    build: (people) =>
      truePair(people, "full", (a) => ({
        b: {
          ...a,
          lastName: soundexVariant(people, a.lastName),
          dateOfBirth: shiftDate(a.dateOfBirth, { years: 1 }),
        },
      })),
  },
  {
    name: "short first name and birth year off by one, full SSN",
    truth: "same person",
    source: `${CATALOG}, 9. \`SSN + LN + FN1\``,
    share: reasoned(
      0.005,
      "a short form of the first name beside a date discrepancy",
    ),
    build: (people) =>
      truePair(people, "full", (a) => ({
        b: {
          ...a,
          firstName: sameInitialOtherCode(people, a.firstName),
          dateOfBirth: shiftDate(a.dateOfBirth, { years: 1 }),
        },
      })),
  },
  {
    name: "short first name, surname typo and birth year off by one, full SSN",
    truth: "same person",
    source: `${CATALOG}, 10. \`SSN + LN3 + FN1\``,
    share: reasoned(0.005, "three errors in one pair"),
    build: (people) =>
      truePair(people, "full", (a) => ({
        b: {
          ...a,
          firstName: sameInitialOtherCode(people, a.firstName),
          lastName: fifthLetterOtherCode(people, a.lastName),
          dateOfBirth: shiftDate(a.dateOfBirth, { years: 1 }),
        },
      })),
  },

  // --- SSN keying errors -----------------------------------------------------
  {
    name: "SSN digit wrong in its first five",
    truth: "same person",
    source: `${GROUNDING}, No SSN conflict veto by default`,
    share: {
      basis: "cited",
      share: (SSN_KEYING_ERROR_SHARE * 5) / 9,
      citation:
        "a one- or two-digit SSN difference in about 1.7% of true pairs (Just et al. 2016), five ninths of them before the last four",
    },
    build: (people) =>
      truePair(people, "full", (a) => ({
        b: { ...a, ssn: ssnKeyingError(people, a.ssn, [0, 1, 2, 3, 4]) },
      })),
  },
  {
    name: "SSN digit wrong in its last four",
    truth: "same person",
    source: `${GROUNDING}, No SSN conflict veto by default`,
    share: {
      basis: "cited",
      share: (SSN_KEYING_ERROR_SHARE * 4) / 9,
      citation:
        "a one- or two-digit SSN difference in about 1.7% of true pairs (Just et al. 2016), four ninths of them in the last four",
    },
    build: (people) =>
      truePair(people, "full", (a) => ({
        b: { ...a, ssn: ssnKeyingError(people, a.ssn, [5, 6, 7, 8]) },
      })),
  },

  // --- Addresses and contact fields with no SSN ------------------------------
  {
    name: "new street address in the same ZIP, no SSN",
    truth: "same person",
    source: `${CATALOG}, 22. \`LN + FN + DOB + ZIP5\``,
    share: reasoned(0.02, "a move within one ZIP; no share is given"),
    build: (people) =>
      truePair(people, "none", (a) => ({
        b: { ...a, streetNumber: String(people.int(1, 9999)) },
      })),
  },
  {
    name: "moved to another ZIP, same phone, no SSN",
    truth: "same person",
    source: `${GROUNDING}, The person's own ZIP`,
    share: reasoned(
      0.02,
      "ZIP change is a share of missed matches (Naessens et al. 2015), not of true pairs",
    ),
    build: (people) =>
      truePair(people, "none", (a) => ({
        b: { ...a, zip: people.zipOutsideArea(a.zip) },
      })),
  },
  {
    name: "moved within the ZIP area, new phone, no SSN",
    truth: "same person",
    source: `${CATALOG}, 27. \`LN + FN + DOB + ZIP3\``,
    share: reasoned(0.01, "a move and a phone change together"),
    build: (people) =>
      truePair(people, "none", (a) => ({
        b: { ...a, zip: people.zipInArea(a.zip), phone: people.phone() },
      })),
  },
  {
    name: "moved out of the ZIP area, new phone, no SSN",
    truth: "same person",
    source: `${CATALOG}, 30. \`LN + FN + DOB + STATE\` or \`LN + FN + DOB + COUNTY\``,
    share: reasoned(0.01, "a move and a phone change together"),
    build: (people) =>
      truePair(people, "none", (a) => ({
        b: { ...a, zip: people.zipOutsideArea(a.zip), phone: people.phone() },
      })),
  },
  {
    name: "no state on one side, moved out of the ZIP area, no phone, no SSN",
    truth: "same person",
    source: `${CATALOG}, 30. \`LN + FN + DOB + STATE\` or \`LN + FN + DOB + COUNTY\``,
    share: reasoned(0.005, "a record holding a county and no state"),
    build: (people) =>
      truePair(people, "none", (a) => ({
        b: { ...a, zip: people.zipOutsideArea(a.zip), state: "", phone: "" },
      })),
  },
  {
    name: "no address or phone on one side, no SSN",
    truth: "same person",
    source: `${GROUNDING}, The person's own ZIP`,
    share: reasoned(
      0.02,
      "a party recording no client address, as HMIS does; no share is given",
    ),
    build: (people) =>
      truePair(people, "none", (a) => ({
        b: {
          ...a,
          zip: "",
          state: "",
          county: "",
          streetNumber: "",
          phone: "",
        },
      })),
  },
  {
    name: "surname spelling variant, same ZIP, no SSN",
    truth: "same person",
    source: `${CATALOG}, 28. \`ZIP5 + soundex(LN) + FN + DOB\``,
    share: reasoned(0.01, "no prevalence of spelling variants is given"),
    build: (people) =>
      truePair(people, "none", (a) => ({
        b: { ...a, lastName: soundexVariant(people, a.lastName), phone: "" },
      })),
  },

  // --- No date of birth on one side ------------------------------------------
  {
    name: "filler date on one side, same phone, no SSN",
    truth: "same person",
    source: `${CATALOG}, 35. \`LN + FN + PHONE\``,
    share: reasoned(0.01, "HUD's filler month and day; no share is given"),
    build: (people) =>
      truePair(people, "none", (a) => ({
        b: {
          ...a,
          dateOfBirth: fillerDate(a.dateOfBirth),
          zip: people.zipOutsideArea(a.zip),
        },
      })),
  },
  {
    name: "no date on one side, surname spelling variant, same phone, no SSN",
    truth: "same person",
    source: `${CATALOG}, 36. \`PHONE + soundex(LN) + FN\``,
    share: reasoned(0.005, "a missing date beside a spelling variant"),
    build: (people) =>
      truePair(people, "none", (a) => ({
        b: {
          ...a,
          dateOfBirth: "",
          lastName: soundexVariant(people, a.lastName),
          zip: people.zipOutsideArea(a.zip),
        },
      })),
  },
  {
    name: "no date on one side, surname change, same phone, no SSN",
    truth: "same person",
    source: `${CATALOG}, 36a. \`FN + PHONE\``,
    share: reasoned(0.005, "a missing date beside a last-name change"),
    build: (people) =>
      truePair(people, "none", (a) => ({
        b: {
          ...withNewLastName(people, a),
          dateOfBirth: "",
          zip: people.zipOutsideArea(a.zip),
        },
      })),
  },
  {
    name: "no date on one side, same email, no phone, no SSN",
    truth: "same person",
    source: `${CATALOG}, 38. \`LN + FN + EMAIL\``,
    share: reasoned(0.005, "a missing date with an email and no phone"),
    build: (people) =>
      truePair(people, "none", (a) => ({
        b: {
          ...a,
          dateOfBirth: "",
          phone: "",
          zip: people.zipOutsideArea(a.zip),
        },
      })),
  },
  {
    name: "no date on one side, surname spelling variant, same email, no phone, no SSN",
    truth: "same person",
    source: `${CATALOG}, 39. \`EMAIL + soundex(LN) + FN\``,
    share: reasoned(0.005, "a missing date beside a spelling variant"),
    build: (people) =>
      truePair(people, "none", (a) => ({
        b: {
          ...a,
          dateOfBirth: "",
          lastName: soundexVariant(people, a.lastName),
          phone: "",
          zip: people.zipOutsideArea(a.zip),
        },
      })),
  },

  // --- Shared-error modes ----------------------------------------------------
  {
    name: "a made-up name one person gives both agencies, no SSN",
    truth: "same person",
    source: `${GROUNDING}, What a two-party exact-key evaluation must add`,
    share: reasoned(0.005, "HUD admits made-up names; no share is given"),
    build: (people) =>
      truePair(people, "none", (a) => ({
        b: { ...a, phone: "", zip: people.zipOutsideArea(a.zip) },
      })),
  },
  {
    name: "a made-up name two people were each recorded under, filler dates of one year",
    truth: "different people",
    source: `${GROUNDING}, What a two-party exact-key evaluation must add`,
    share: reasoned(
      0.006,
      "HUD admits made-up names and a filler month and day; no share is given",
    ),
    build: (people) => {
      const a = people.person();
      const b = people.person();
      const dateOfBirth = fillerDate(a.dateOfBirth);
      return {
        a: { ...a, dateOfBirth, ssn: "" },
        b: {
          ...b,
          firstName: a.firstName,
          lastName: a.lastName,
          dateOfBirth,
          ssn: "",
        },
      };
    },
  },
  {
    name: "placeholder first name on twins, one in each file",
    truth: "different people",
    source: `${GROUNDING}, What transfers to two-party exact matching`,
    share: reasoned(0.006, "HUD admits placeholder names; no share is given"),
    build: (people) => {
      const a = people.person();
      const b = people.person();
      const household = {
        lastName: a.lastName,
        dateOfBirth: a.dateOfBirth,
        phone: a.phone,
        zip: a.zip,
        streetNumber: a.streetNumber,
      };
      return {
        a: { ...a, firstName: "Baby Girl", ssn: "" },
        b: { ...b, ...household, firstName: "Baby Girl", ssn: "" },
      };
    },
  },
  {
    name: "placeholder SSN both agencies hold, shared first name",
    truth: "different people",
    source: `${GROUNDING}, Fillers the default cleaning drops`,
    share: reasoned(
      0.008,
      "no share is given; each instance takes another placeholder, since one file holding a value twice drops it anyway",
    ),
    build: (people, instance) => {
      const placeholders = [
        "078-05-1120",
        "219-09-9999",
        "111-22-3333",
        "129-99-9999",
      ];
      const ssn = placeholders[instance % placeholders.length];
      const a = people.person();
      const b = people.person();
      return { a: { ...a, ssn }, b: { ...b, ssn, firstName: a.firstName } };
    },
  },
  {
    name: "ZIP filler both agencies hold, shared name and birth month",
    truth: "different people",
    source: `${GROUNDING}, Fillers the default cleaning drops`,
    share: reasoned(0.006, "no share is given"),
    build: (people, instance) => {
      const fillers = ["00000", "99999", "88888"];
      const zip = fillers[instance % fillers.length];
      const a = people.person();
      const b = people.person();
      return {
        a: { ...a, zip, ssn: "" },
        b: {
          ...b,
          zip,
          ssn: "",
          firstName: a.firstName,
          lastName: a.lastName,
          dateOfBirth: otherDayOfMonth(people, a.dateOfBirth),
        },
      };
    },
  },
  {
    name: "phone filler both agencies hold, shared first name, no date on one side",
    truth: "different people",
    source: `${GROUNDING}, Fillers the default cleaning drops`,
    share: reasoned(
      0.008,
      "no share is given; each instance takes another filler, so the shared-value screen is not what drops it",
    ),
    build: (people, instance) => {
      const fillers = ["9999999999", "0000000000", "2029999999", "3010000000"];
      const phone = fillers[instance % fillers.length];
      const a = people.person();
      const b = people.person();
      return {
        a: { ...a, phone, ssn: "" },
        b: { ...b, phone, ssn: "", firstName: a.firstName, dateOfBirth: "" },
      };
    },
  },

  // --- Look-alike false pairs ------------------------------------------------
  {
    name: "two people sharing a name and date of birth",
    truth: "different people",
    source: `${GROUNDING}, Coverage and file size`,
    share: {
      basis: "cited",
      share: 0.0018,
      citation:
        "0.18% of individuals sharing first name, last name and date of birth with someone else (Zech et al. 2016)",
    },
    build: (people) => {
      const a = people.person();
      const b = people.person();
      return {
        a,
        b: {
          ...b,
          firstName: a.firstName,
          lastName: a.lastName,
          dateOfBirth: a.dateOfBirth,
          zip: people.zipOutsideArea(a.zip),
        },
      };
    },
  },
  ...(
    ["given each other's date", "no date on one side", "own dates"] as const
  ).map((dates): PairClass => ({
    name: `parent and child of one name at one address and phone, ${dates}`,
    truth: "different people",
    source: `${GROUNDING}, Name suffixes`,
    share:
      dates === "given each other's date"
        ? {
            basis: "cited",
            share: 0.0125,
            citation:
              "same-name, same-date, same-address duplicates were about 1.25% of records in Mississippi (Goel et al. 2020)",
          }
        : reasoned(
            0.006,
            "the floor of the contact rules; no source measures it",
          ),
    build: (people) => {
      const parent = people.person();
      const child = people.person();
      const childDate =
        dates === "given each other's date"
          ? parent.dateOfBirth
          : dates === "no date on one side"
            ? ""
            : shiftDate(parent.dateOfBirth, { years: 25 });
      return {
        a: { ...parent, lastName: `${parent.lastName} Sr`, ssn: "" },
        b: {
          ...child,
          firstName: parent.firstName,
          lastName: `${parent.lastName} Jr`,
          dateOfBirth: childDate,
          phone: parent.phone,
          zip: parent.zip,
          county: parent.county,
          streetNumber: parent.streetNumber,
          ssn: "",
        },
      };
    },
  })),
  {
    name: "twins at one address and phone, one in each file",
    truth: "different people",
    source: `${CATALOG}, Not offered`,
    share: reasoned(
      0.006,
      "infant twins share a birth date and phone (Bernstam et al. 2022); no share is given",
    ),
    build: (people) => {
      const a = people.person();
      const b = people.person();
      return {
        a: { ...a, ssn: "" },
        b: {
          ...b,
          lastName: a.lastName,
          dateOfBirth: a.dateOfBirth,
          phone: a.phone,
          zip: a.zip,
          county: a.county,
          streetNumber: a.streetNumber,
          ssn: "",
        },
      };
    },
  },
  ...(["another initial", "the same initial"] as const).map(
    (initial): PairClass => ({
      name: `wife recorded under her husband's SSN, ${initial}`,
      truth: "different people",
      source: `${GROUNDING}, What transfers to two-party exact matching`,
      share: reasoned(
        0.006,
        "the most common SSN error in Grannis et al. (2002); no share is given",
      ),
      build: (people) => {
        const husband = people.person();
        const wife = people.person();
        return {
          a: {
            ...wife,
            firstName:
              initial === "the same initial"
                ? sameInitialOtherCode(people, husband.firstName)
                : people.otherName("first", husband.firstName),
            lastName: husband.lastName,
            ssn: husband.ssn,
          },
          b: husband,
        };
      },
    }),
  ),

  // --- People in one file only -----------------------------------------------
  ...(["a", "b"] as const).map((party): PairClass => ({
    name: `in party ${party.toUpperCase()}'s file only`,
    truth: "single",
    source: `${GROUNDING}, What a two-party exact-key evaluation must add`,
    share: reasoned(0.1, "the people one file holds and the other does not"),
    build: (people) => {
      const person = people.person();
      return party === "a"
        ? { a: person, b: undefined }
        : { a: undefined, b: person };
    },
  })),
];

/** How many instances of `pairClass` the corpus builds. */
export function instanceCount(pairClass: PairClass): number {
  return Math.max(
    MIN_INSTANCES,
    Math.round(pairClass.share.share * SHARE_SCALE),
  );
}

const STATE_NAMES: Record<string, string> = { MD: "Maryland" };

/** `record` as party `party` writes its cells: A in mixed case with
 * punctuation, B in upper case with fewer separators, so each value passes
 * through the default cleaning rather than arriving clean. */
function cells(
  record: PersonRecord,
  party: "a" | "b",
): Record<CorpusColumn, string> {
  const titleCase = (value: string): string =>
    value
      .toLowerCase()
      .replace(
        /(^|[\s-])([a-z])/g,
        (_match, gap: string, letter: string) => gap + letter.toUpperCase(),
      );
  const ssn = /^\d{9}$/.test(record.ssn)
    ? party === "a"
      ? `${record.ssn.slice(0, 3)}-${record.ssn.slice(3, 5)}-${record.ssn.slice(5)}`
      : record.ssn
    : record.ssn;
  const phone =
    record.phone.length === 10
      ? party === "a"
        ? `(${record.phone.slice(0, 3)}) ${record.phone.slice(3, 6)}-${record.phone.slice(6)}`
        : `${record.phone.slice(0, 3)}-${record.phone.slice(3, 6)}-${record.phone.slice(6)}`
      : record.phone;
  return {
    ssn,
    first_name:
      party === "a"
        ? titleCase(record.firstName)
        : record.firstName.toUpperCase(),
    last_name:
      party === "a"
        ? titleCase(record.lastName)
        : record.lastName.toUpperCase(),
    date_of_birth: record.dateOfBirth,
    phone_number: phone,
    email_address: party === "a" ? record.email : record.email.toUpperCase(),
    zip_code: record.zip,
    state:
      party === "a"
        ? (STATE_NAMES[record.state] ?? record.state)
        : record.state,
    county:
      record.county === ""
        ? ""
        : party === "a"
          ? `${titleCase(record.county)} County`
          : record.county.toUpperCase(),
    street_number:
      record.streetNumber === ""
        ? ""
        : party === "a"
          ? `${record.streetNumber} Main St`
          : record.streetNumber,
  };
}

/** The corpus built from `seed`: every instance of every class, the two files
 * shuffled so a record's row says nothing about its class. */
export function buildCorpus(seed: number = CORPUS_SEED): Corpus {
  const people = new PeopleSource(seed);
  const built: Array<{
    className: string;
    a?: PersonRecord;
    b?: PersonRecord;
  }> = [];
  for (const pairClass of PAIR_CLASSES) {
    for (let i = 0; i < instanceCount(pairClass); i++) {
      const { a, b } = pairClass.build(people, i);
      built.push({ className: pairClass.name, a, b });
    }
  }

  const shuffled = (count: number): Array<number> => {
    const order = Array.from({ length: count }, (_unused, i) => i);
    for (let i = count - 1; i > 0; i--) {
      const j = people.int(0, i);
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
  };

  const placeParty = (party: "a" | "b"): Array<number | undefined> => {
    const holders = built.flatMap((instance, index) =>
      instance[party] === undefined ? [] : [index],
    );
    const rowOfInstance: Array<number | undefined> = new Array(built.length);
    const order = shuffled(holders.length);
    order.forEach((holder, row) => (rowOfInstance[holders[holder]] = row));
    return rowOfInstance;
  };

  const aRows = placeParty("a");
  const bRows = placeParty("b");
  const fileOf = (
    party: "a" | "b",
    rows: Array<number | undefined>,
  ): Array<CorpusRecord> => {
    const file: Array<CorpusRecord> = [];
    built.forEach((instance, index) => {
      const record = instance[party];
      const row = rows[index];
      if (record !== undefined && row !== undefined)
        file[row] = { personId: record.personId, row: cells(record, party) };
    });
    return file;
  };

  return {
    a: fileOf("a", aRows),
    b: fileOf("b", bRows),
    instances: built.map((instance, index) => ({
      className: instance.className,
      aRow: aRows[index],
      bRow: bRows[index],
    })),
    classes: PAIR_CLASSES,
  };
}
