import logLibrary from "loglevel";
import { describe, expect, it } from "vitest";

import {
  describeExchangeOutcome,
  outcomeLineWriter,
  zeroMatchWarning,
} from "../../src/exchangeOutcome";

describe("describeExchangeOutcome", () => {
  it("names the count, the result and record paths, and the rotated key", () => {
    expect(
      describeExchangeOutcome({
        result: { kind: "file", matchedRows: 1204, path: "/data/matched.csv" },
        record: { kind: "written", path: "/data/alcove-record.json" },
        rotatedKeyFilePath: "/data/.alcove.key",
      }),
    ).toBe(
      "exchange complete: 1,204 records matched, result written to " +
        "/data/matched.csv; exchange record written to " +
        "/data/alcove-record.json; shared secret rotated and saved to " +
        "/data/.alcove.key",
    );
  });

  it("states a stdout result, a disabled record and no rotation", () => {
    expect(
      describeExchangeOutcome({
        result: { kind: "stdout", matchedRows: 1 },
        record: { kind: "disabled" },
        rotatedKeyFilePath: undefined,
      }),
    ).toBe(
      "exchange complete: 1 record matched, result written to standard " +
        "output; no exchange record (--no-record); no shared secret was " +
        "rotated",
    );
  });

  it("states a count-only result and a withheld one", () => {
    const count = describeExchangeOutcome({
      result: {
        kind: "count",
        intersectionCount: 42,
        reportedByPartner: false,
      },
      record: { kind: "notWritten" },
      rotatedKeyFilePath: undefined,
    });
    expect(count).toContain(
      "exchange complete: 42 records in common, no result file (count only)",
    );
    expect(count).not.toContain("only your partner computed");
    expect(count).toContain("exchange record not written");

    expect(
      describeExchangeOutcome({
        result: {
          kind: "count",
          intersectionCount: 42,
          reportedByPartner: true,
        },
        record: { kind: "disabled" },
        rotatedKeyFilePath: undefined,
      }),
    ).toContain(
      "exchange complete: your partner reported 42 records in common (only " +
        "your partner computed this count; Alcove does not check it against " +
        "a run of its own), no result file (count only)",
    );

    expect(
      describeExchangeOutcome({
        result: { kind: "withheld" },
        record: { kind: "disabled" },
        rotatedKeyFilePath: undefined,
      }),
    ).toContain("no result file for you under the agreed terms");
  });

  it("escapes a control character in a path", () => {
    const line = describeExchangeOutcome({
      result: { kind: "file", matchedRows: 2, path: "/data/\x1b[31m.csv" },
      record: { kind: "disabled" },
      rotatedKeyFilePath: undefined,
    });
    expect(line).not.toContain("\x1b");
    expect(line).toContain("/data/<1b>[31m.csv");
  });
});

describe("zeroMatchWarning", () => {
  it("warns on a written result or a count of zero", () => {
    expect(zeroMatchWarning({ kind: "stdout", matchedRows: 0 })).toMatch(
      /^no records matched/,
    );
    expect(
      zeroMatchWarning({ kind: "file", matchedRows: 0, path: "/r.csv" }),
    ).toBeDefined();
    expect(
      zeroMatchWarning({
        kind: "count",
        intersectionCount: 0,
        reportedByPartner: false,
      }),
    ).toBeDefined();
  });

  it("says nothing when something matched or no result was received", () => {
    expect(zeroMatchWarning({ kind: "stdout", matchedRows: 1 })).toBe(
      undefined,
    );
    expect(
      zeroMatchWarning({
        kind: "count",
        intersectionCount: 3,
        reportedByPartner: true,
      }),
    ).toBe(undefined);
    expect(zeroMatchWarning({ kind: "withheld" })).toBe(undefined);
  });
});

describe("outcomeLineWriter", () => {
  it("writes at every level but silent", () => {
    for (const [level, expected] of [
      [logLibrary.levels.TRACE, 1],
      [logLibrary.levels.INFO, 1],
      [logLibrary.levels.ERROR, 1],
      [logLibrary.levels.SILENT, 0],
    ] as const) {
      const lines: string[] = [];
      outcomeLineWriter({ getLevel: () => level }, (line) => lines.push(line))(
        "exchange complete",
      );
      expect(lines).toHaveLength(expected);
    }
  });
});
