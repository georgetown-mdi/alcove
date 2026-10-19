import { describe, expect, it } from "vitest";
import {
  capList,
  citedItemIds,
  citedRulings,
  excerpt,
  hitRank,
  holdsAllWords,
  rulingLines,
  rulingMarkerIndex,
} from "./find-rulings.mjs";

describe("holdsAllWords", () => {
  it("matches every word case-insensitively, a suffix included", () => {
    expect(
      holdsAllWords("Polling Intervals default to five seconds.", [
        "poll",
        "interval",
      ]),
    ).toBe(true);
  });

  it("refuses when one word is missing", () => {
    expect(holdsAllWords("a poll timer", ["poll", "interval"])).toBe(false);
  });

  it("does not match a word that only ends another word", () => {
    expect(holdsAllWords("consent to the poll", ["poll", "sent"])).toBe(false);
  });

  it("treats regex characters in a word literally", () => {
    expect(holdsAllWords("pass --log-level debug", ["--log-level"])).toBe(true);
    expect(holdsAllWords("a.b", ["a*b"])).toBe(false);
  });

  it("matches nothing for no words or no text", () => {
    expect(holdsAllWords("anything", [])).toBe(false);
    expect(holdsAllWords(null, ["x"])).toBe(false);
  });
});

describe("rulingMarkerIndex", () => {
  it.each([
    "## Ruling (2026-01-05)",
    "Ruled 2026-01-05; see Ruling.",
    "The owner decided both questions.",
    "The placement question is settled.",
    "Decision 3 is ratified.",
    "Keep it. Not to be re-raised.",
    "Owner, 2026-01-05, verbatim:",
    'the owner said "keep five seconds"',
    "the owner said “keep five seconds”",
  ])("finds a marker in %j", (line) => {
    expect(rulingMarkerIndex(line)).toBeGreaterThanOrEqual(0);
  });

  it.each([
    "The owner's preference is unknown.",
    "An owner reviews the board.",
    "Overrule nothing; the rules stand.",
    "Undecided.",
  ])("finds none in %j", (line) => {
    expect(rulingMarkerIndex(line)).toBe(-1);
  });

  it("returns the earliest marker's position", () => {
    expect(rulingMarkerIndex("x settled, then ruled")).toBe(2);
  });
});

describe("excerpt", () => {
  it("keeps a short line whole, trimmed", () => {
    expect(excerpt("   a ruling  ", 3)).toBe("a ruling");
  });

  it("windows a long line around the index", () => {
    const line = `${"a".repeat(500)} ruling ${"b".repeat(500)}`;
    const out = excerpt(line, 501);
    expect(out).toContain("ruling");
    expect(out.startsWith("...")).toBe(true);
    expect(out.endsWith("...")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(246);
  });
});

describe("rulingLines", () => {
  it("returns only the marker lines", () => {
    const body = [
      "## Summary",
      "Poll every five seconds.",
      "## Ruling (2026-01-05)",
      "Keep five seconds. Not to be re-raised.",
    ].join("\n");
    expect(rulingLines(body)).toEqual([
      "## Ruling (2026-01-05)",
      "Keep five seconds. Not to be re-raised.",
    ]);
  });

  it("brings a marker heading's section and a colon line's next line", () => {
    const body = [
      "## Ruling (2026-01-05)",
      "",
      "Keep the five second wait between checks. Not to be",
      "re-raised.",
      "## Notes",
      "Unrelated.",
      "Owner, 2026-01-05, verbatim:",
      "",
      '"Any wait under two seconds is refused."',
      "Trailing line.",
    ].join("\n");
    expect(rulingLines(body)).toEqual([
      "## Ruling (2026-01-05)",
      "Keep the five second wait between checks. Not to be",
      "re-raised.",
      "Owner, 2026-01-05, verbatim:",
      '"Any wait under two seconds is refused."',
    ]);
  });

  it("caps a section and keeps scanning past it", () => {
    const body = [
      "## Ruling",
      ...Array.from({ length: 12 }, (_, n) => `line ${n}`),
      "later: settled",
    ].join("\n");
    const out = rulingLines(body);
    expect(out).toHaveLength(10);
    expect(out.at(-1)).toBe("later: settled");
  });

  it("returns none for a missing body", () => {
    expect(rulingLines(null)).toEqual([]);
  });
});

describe("cited rulings", () => {
  const item = (id, title, lines) => ({
    board: 9,
    id,
    status: "Done",
    title,
    lines,
  });

  it("reads item ids, not PR numbers, from ruling lines", () => {
    expect(
      citedItemIds(["agrees with the ruling on 9/100000002 (PR #1234)"]),
    ).toEqual(new Set([100000002]));
  });

  it("adds a cited item holding a ruling, once, naming every citer", () => {
    const earlier = item(100000002, "Earlier", ["## Ruling (2026-01-05)"]);
    const hits = [
      item(100000003, "Later", ["the 2026-01-05 ruling on 9/100000002"]),
      item(100000004, "Other", ["the ruling on 100000002 set the remedy"]),
    ];
    const noRuling = item(111111111, "Plain", []);
    const cited = citedRulings(hits, [...hits, earlier, noRuling]);
    expect(cited.map((entry) => entry.id)).toEqual([100000002]);
    expect(cited[0].citedBy).toEqual(["9/100000003", "9/100000004"]);
  });

  it("skips a cited item that is already a hit or holds no ruling", () => {
    const hits = [
      item(1, "A", ["ruled on 222222222 and 333333333"]),
      item(333333333, "Also a hit", ["## Ruling"]),
    ];
    const items = [...hits, item(222222222, "Plain", [])];
    expect(citedRulings(hits, items)).toEqual([]);
  });
});

describe("hitRank", () => {
  const words = ["poll", "interval"];
  it("puts a title holding every word above a ruling line", () => {
    const titled = { title: "Set the poll interval", lines: [] };
    const ruled = { title: "Other", lines: ["ruling: poll stays"] };
    const plain = { title: "Other", lines: ["settled"] };
    expect(hitRank(titled, words)).toBeGreaterThan(hitRank(ruled, words));
    expect(hitRank(ruled, words)).toBeGreaterThan(hitRank(plain, words));
    expect(hitRank(plain, words)).toBeGreaterThan(
      hitRank({ title: "Other", lines: [] }, words),
    );
  });
});

describe("capList", () => {
  it("keeps the first entries and counts the rest", () => {
    expect(capList([1, 2, 3, 4, 5], 3)).toEqual({ shown: [1, 2, 3], more: 2 });
  });

  it("cuts nothing at or under the limit", () => {
    expect(capList([1, 2, 3], 3)).toEqual({ shown: [1, 2, 3], more: 0 });
    expect(capList([], 3)).toEqual({ shown: [], more: 0 });
  });
});
