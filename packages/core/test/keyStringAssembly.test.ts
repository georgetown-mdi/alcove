import { afterEach, describe, expect, test, vi } from "vitest";

import {
  assembleKeyStrings,
  buildKeyStrings,
  StandardizedDataset,
  StandardizedField,
} from "../src/standardization";
import type { LinkageKey } from "../src/config/linkageTermsSchema";
import {
  MAX_KEY_ELEMENTS,
  safeParseLinkageTerms,
} from "../src/config/linkageTermsSchema";
import { MAX_KEY_CANDIDATE_WIDTH } from "../src/fanOutFunctions";
import {
  ESC,
  PRINTABLE_ASCII,
  RLO,
} from "../src/consent/displayEscapingFixtures";
import { UsageError } from "../src/errors";
import { getLogger } from "../src/utils/logger";

// The array-product form the assembler replaced, kept as the reference: every
// combination of one candidate per element, joined in element order.
function referenceKeyStrings(candidates: string[][]): string[] {
  return candidates
    .reduce<string[][]>(
      (acc, arr) => acc.flatMap((prefix) => arr.map((v) => [...prefix, v])),
      [[]],
    )
    .map((parts) => parts.join(""));
}

// A seeded generator, so a failing shape reproduces.
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

// Empty strings, duplicates, a combining mark, and a surrogate pair, so the
// comparison also covers the candidates a set would collapse.
const CANDIDATE_POOL = ["", "A", "B", "AB", "é", "\u{1F600}", "123"];

function candidateLists(
  widths: readonly number[],
  random: () => number,
): string[][] {
  return widths.map((width) =>
    Array.from(
      { length: width },
      (_unused, i) =>
        `${CANDIDATE_POOL[Math.floor(random() * CANDIDATE_POOL.length)]}${i % 3 === 0 ? "" : i}`,
    ),
  );
}

// The per-row count cap is the key candidate width, so these are the shapes a
// row can reach assembly with.
const MAX_COMBINATIONS = MAX_KEY_CANDIDATE_WIDTH;

function widthShapes(elementCount: number): number[][] {
  const narrow = (): number[] => new Array<number>(elementCount).fill(1);
  const shapes: number[][] = [narrow()];
  for (const wide of [2, 33, 991, MAX_COMBINATIONS]) {
    const wideFirst = narrow();
    wideFirst[0] = wide;
    const wideLast = narrow();
    wideLast[elementCount - 1] = wide;
    shapes.push(wideFirst, wideLast);
  }
  if (elementCount >= 3) {
    const spread = narrow();
    spread[0] = 4;
    spread[Math.floor(elementCount / 2)] = 16;
    spread[elementCount - 1] = 16;
    shapes.push(spread);
  }
  return shapes;
}

describe("assembleKeyStrings", () => {
  test("yields the reference form's key strings, in its order", () => {
    const random = seededRandom(20261107);
    for (const elementCount of [1, 2, 3, 5, 16, 64, 255, MAX_KEY_ELEMENTS]) {
      const shapes = widthShapes(elementCount);
      // A random shape within the cap: each element's width divides what the
      // ones before it left.
      for (let trial = 0; trial < 4; trial++) {
        let room = MAX_COMBINATIONS;
        shapes.push(
          Array.from({ length: elementCount }, () => {
            const width = 1 + Math.floor(random() * Math.min(room, 6));
            room = Math.floor(room / width);
            return width;
          }),
        );
      }
      for (const widths of shapes) {
        const product = widths.reduce((total, width) => total * width, 1);
        expect(product).toBeLessThanOrEqual(MAX_COMBINATIONS);
        const candidates = candidateLists(widths, random);
        expect(
          [...assembleKeyStrings(candidates)],
          `${elementCount} elements, widths ${widths.filter((w) => w > 1).join("x")}`,
        ).toEqual(referenceKeyStrings(candidates));
      }
    }
  });

  test("agrees with the reference form at its edges", () => {
    expect([...assembleKeyStrings([])]).toEqual(referenceKeyStrings([]));
    expect([...assembleKeyStrings([])]).toEqual([""]);
    for (const candidates of [[[]], [["A"], []], [[], ["A", "B"]]])
      expect([...assembleKeyStrings(candidates)]).toEqual(
        referenceKeyStrings(candidates),
      );
  });
});

describe("buildKeyStrings assembly", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const silenceWideRowAdvisory = () =>
    vi.spyOn(getLogger("cleaning"), "warn").mockImplementation(() => {});

  // The candidates one element realizes alone, read through the builder so the
  // reference below assembles exactly what the key's own elements produce.
  const elementCandidates = (
    element: LinkageKey["elements"][number],
    dataset: StandardizedDataset,
    isReceiver: boolean,
  ): string[] => [
    ...(buildKeyStrings(
      { name: "one", elements: [element] },
      dataset,
      0,
      isReceiver,
    ) ?? []),
  ];

  const expectedKeyStrings = (lists: string[][]): Set<string> =>
    new Set(referenceKeyStrings(lists).map((s) => s.normalize("NFC")));

  test("a wide element first or last derives the reference set for both roles", () => {
    silenceWideRowAdvisory();
    const wideValue = Array.from({ length: 45 }, (_unused, i) =>
      String.fromCodePoint(0x41 + i),
    ).join("");
    const rows = [{ W: wideValue, N: "x" }];
    const wide = {
      field: "w",
      transform: [{ function: "substring", params: { start: 1, length: 45 } }],
      generateFuzzyComparisons: "transpositions" as const,
    };
    const narrow = { field: "n" };
    for (const wideFirst of [true, false]) {
      const narrowElements = new Array(MAX_KEY_ELEMENTS - 1).fill(narrow);
      const key: LinkageKey = {
        name: "K",
        elements: wideFirst
          ? [wide, ...narrowElements]
          : [...narrowElements, wide],
      };
      const dataset = new StandardizedDataset(
        [
          new StandardizedField("w", "W", [], rows),
          new StandardizedField("n", "N", [], rows),
        ],
        [key],
      );
      for (const isReceiver of [false, true]) {
        const lists = key.elements.map((element) =>
          elementCandidates(element, dataset, isReceiver),
        );
        // The receiver alone expands transpositions: 45 * 44 / 2 + 1.
        expect(lists[wideFirst ? 0 : MAX_KEY_ELEMENTS - 1]).toHaveLength(
          isReceiver ? 991 : 1,
        );
        expect(
          buildKeyStrings(key, dataset, 0, isReceiver),
          `wideFirst=${wideFirst} isReceiver=${isReceiver}`,
        ).toEqual(expectedKeyStrings(lists));
      }
    }
  });

  test("a swap key derives the reference set in each order it assembles", () => {
    const split = [{ function: "split_on", params: { delimiter: "," } }];
    const key: LinkageKey = {
      name: "FN+LN+N",
      elements: [
        { field: "first_name", transform: split },
        { field: "last_name", transform: split },
        { field: "n" },
      ],
      swap: ["first_name", "last_name"],
    };
    const rows = [{ FN: "JANE,J,JAYNE", LN: "SMITH,SMYTH,S,SM", N: "é" }];
    const dataset = new StandardizedDataset(
      [
        new StandardizedField("first_name", "FN", [], rows),
        new StandardizedField("last_name", "LN", [], rows),
        new StandardizedField("n", "N", [], rows),
      ],
      [key],
    );
    for (const isReceiver of [false, true]) {
      const [first, last, n] = key.elements.map((element) =>
        elementCandidates(element, dataset, isReceiver),
      );
      expect(first).toHaveLength(3);
      expect(last).toHaveLength(4);
      const authored = expectedKeyStrings([first, last, n]);
      const expected = isReceiver
        ? new Set([...expectedKeyStrings([last, first, n]), ...authored])
        : authored;
      expect(
        buildKeyStrings(key, dataset, 0, isReceiver),
        `${isReceiver}`,
      ).toEqual(expected);
    }
  });
});

describe("an element transform that does not compile at the run", () => {
  test("is refused naming its function and no parameter value", () => {
    // A document parsed afresh has not been through the accept boundary's
    // compile check, so the run is where its transforms first compile.
    const algorithm = `metaphone${ESC}[31m${RLO}x`;
    const decoded = safeParseLinkageTerms({
      version: "1.0.0",
      identity: "Test Party",
      date: "2025-01-01",
      algorithm: "psi",
      output: { expectsOutput: true, shareWithPartner: false },
      deduplicate: false,
      linkageFields: [{ name: "ssn", type: "ssn" }],
      linkageKeys: [
        {
          name: "SSN",
          elements: [
            {
              field: "ssn",
              transform: [{ function: "phonetic", params: { algorithm } }],
            },
          ],
        },
      ],
    });
    expect(decoded.success).toBe(true);
    if (!decoded.success) return;
    const terms = decoded.data;
    expect(terms.linkageKeys[0].elements[0].transform?.[0].params).toEqual({
      algorithm,
    });
    const dataset = new StandardizedDataset(
      [new StandardizedField("ssn", "SSN", [], [{ SSN: "123456789" }])],
      terms.linkageKeys,
    );
    let raised: unknown;
    try {
      buildKeyStrings(terms.linkageKeys[0], dataset, 0);
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeInstanceOf(UsageError);
    const message = (raised as Error).message;
    expect(message).toBe(
      'a transform step cannot be built from the parameters it declares ("phonetic"). ' +
        "Correct that step's parameters, or remove the step.",
    );
    expect(message).toMatch(PRINTABLE_ASCII);
    expect((raised as Error).cause).toBeUndefined();
  });
});
