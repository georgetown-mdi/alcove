import {
  getDefaultLinkageTerms,
  getDefaultStandardization,
} from "@alcove/core";

// The completion run's synthetic population and the result a run with no size
// limit returns over it. A row's SSN serial and the first four letters of its
// last name together name the row, so no two rows agree on any built-in key,
// the SSN4 keys included, and the only rows that match are the shared ones.

// Row k is serial 1 + k % 9999 of block floor(k / 9999). A block is one SSN
// area and group, and three letters of the last name: never serial 0000 or
// group 00, which the built-in standardization drops.
const SERIALS_PER_BLOCK = 9_999;
const GROUPS_PER_AREA = 99;
const FIRST_AREA = 100;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const BLOCKS = LETTERS.length ** 3;

// Past this many rows, two rows would share a serial and a last name.
const POPULATION_SIZE = BLOCKS * SERIALS_PER_BLOCK;

function blockOf(k: number): number {
  if (!Number.isInteger(k) || k < 0 || k >= POPULATION_SIZE)
    throw new RangeError(
      `population row ${k} is outside 0 to ${POPULATION_SIZE - 1}`,
    );
  return Math.floor(k / SERIALS_PER_BLOCK);
}

/** The SSN of population row `k`, one distinct value a row. */
export function populationSsn(k: number): string {
  const block = blockOf(k);
  const area = FIRST_AREA + Math.floor(block / GROUPS_PER_AREA);
  const group = String(1 + (block % GROUPS_PER_AREA)).padStart(2, "0");
  const serial = String(1 + (k % SERIALS_PER_BLOCK)).padStart(4, "0");
  return `${area}-${group}-${serial}`;
}

/** The population row an SSN of nine digits is, or undefined if none is. */
function populationRowOfSsn(digits: string): number | undefined {
  const area = Number(digits.slice(0, 3));
  const group = Number(digits.slice(3, 5));
  const serial = Number(digits.slice(5));
  if (area < FIRST_AREA || group < 1 || serial < 1) return undefined;
  const block = (area - FIRST_AREA) * GROUPS_PER_AREA + group - 1;
  const k = block * SERIALS_PER_BLOCK + serial - 1;
  return k < POPULATION_SIZE ? k : undefined;
}

// Q followed by the block in three letters: no listed placeholder or affix.
function populationLastName(k: number): string {
  const block = blockOf(k);
  const letter = (place: number) =>
    LETTERS[Math.floor(block / LETTERS.length ** place) % LETTERS.length];
  return `Q${letter(2)}${letter(1)}${letter(0)}`;
}

// The day runs from 2, so no date is 1 January, which no key reads.
function populationDob(k: number): string {
  return `${1 + (k % 12)}/${2 + (k % 27)}/${1940 + (k % 60)}`;
}

/**
 * Population row `k` as the input's `SSN,LastName,DOB` cells, which a party's
 * input writes after its own `Person_ID`.
 */
export function populationRow(k: number): string {
  return `${populationSsn(k)},${populationLastName(k)},${populationDob(k)}`;
}

/**
 * The SSNs the built-in standardization nulls, read off its `null_if` steps
 * for the `ssn` field, so the population rows holding one match on no key.
 */
export function builtInNulledSsns(): string[] {
  const terms = getDefaultLinkageTerms(undefined);
  const standardization = getDefaultStandardization(
    [{ name: "SSN", type: "ssn", role: "linkage", isPayload: false }],
    terms,
  );
  const nulled: string[] = [];
  for (const transformation of standardization) {
    if (transformation.output !== "ssn") continue;
    for (const step of transformation.steps ?? []) {
      if (step.function !== "null_if") continue;
      const { value, values } = step.params ?? {};
      if (typeof value === "string") nulled.push(value);
      if (Array.isArray(values))
        for (const v of values) if (typeof v === "string") nulled.push(v);
    }
  }
  return nulled;
}

/**
 * The population rows below `populationSize` whose SSN the built-in
 * standardization nulls.
 */
export function nulledPopulationRows(populationSize: number): number[] {
  return builtInNulledSsns()
    .filter((ssn) => /^\d{9}$/.test(ssn))
    .map(populationRowOfSsn)
    .filter((k): k is number => k !== undefined && k < populationSize)
    .sort((a, b) => a - b);
}

/**
 * How many rows a party's result holds when `rows` records a side are
 * exchanged: the starter's input is population rows 0 to rows - 1 and the
 * joiner's starts at `shared`, so the shared rows are population rows
 * `shared` to rows - 1, less any in `nulledRows`.
 */
export function expectedResultCount(
  rows: number,
  shared: number,
  nulledRows: readonly number[],
): number {
  return (
    rows - shared - nulledRows.filter((k) => k >= shared && k < rows).length
  );
}

/**
 * The rows of a party's result, in the order of its own 1-based Person_ID,
 * over the shared rows {@link expectedResultCount} counts. A result row is the
 * party's own Person_ID, then the partner's 0-based row index.
 */
export function* expectedResultPairs(
  rows: number,
  shared: number,
  party: "starter" | "joiner",
  nulledRows: readonly number[],
): Generator<[number, number]> {
  for (let j = 0; j < rows - shared; j++) {
    if (nulledRows.includes(shared + j)) continue;
    yield party === "starter" ? [shared + j + 1, j] : [j + 1, shared + j];
  }
}
