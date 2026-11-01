import { describe, expect, test } from "vitest";

import {
  FormatMigrationError,
  declaresLaterFormatVersion,
  formatVersionFollows,
  formatVersionPrecedes,
  migrateOnRead,
  migrationChainEnd,
  readableFormatVersions,
} from "../../src/config/formatMigration";
import { KEY_FILE_MIGRATIONS } from "../../src/config/keyFile";
import {
  EXCHANGE_KEYS_MIGRATIONS,
  EXCHANGE_RECORD_MIGRATIONS,
} from "../../src/records/exchangeRecord";
import { SIGNED_RECEIPT_MIGRATIONS } from "../../src/records/signedReceipt";

import type { FormatMigrations } from "../../src/config/formatMigration";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const member of Object.values(value)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}

const MIGRATIONS: FormatMigrations<number> = {
  fileName: "The test file",
  versionField: "version",
  absentVersion: 1,
  current: 3,
  steps: [
    {
      from: 1,
      to: 2,
      migrate: ({ old, ...rest }) => ({ ...rest, renamed: old }),
    },
    {
      from: 2,
      to: 3,
      migrate: (document) => {
        if (document["renamed"] === "unmovable")
          throw new Error("the renamed field cannot be split");
        return { ...document, added: true };
      },
    },
  ],
  failureRemedy: "Use the version that wrote it.",
};

describe("migrateOnRead", () => {
  test("moves an earlier version to the current one on a copy, the input unchanged", () => {
    const raw = deepFreeze({ version: 1, old: "x", kept: { a: [1] } });
    const before = JSON.stringify(raw);
    const migrated = migrateOnRead(raw, MIGRATIONS);
    expect(migrated).toEqual({
      version: 3,
      kept: { a: [1] },
      renamed: "x",
      added: true,
    });
    expect(JSON.stringify(raw)).toBe(before);
    expect((migrated as { kept: unknown }).kept).not.toBe(raw.kept);
  });

  test("reads an absent version as the format's absent version", () => {
    expect(migrateOnRead({ old: "x" }, MIGRATIONS)).toEqual({
      renamed: "x",
      version: 3,
      added: true,
    });
  });

  test("returns the current version, an unreadable one, and a non-object as they are", () => {
    const current = { version: 3 };
    const newer = { version: 4 };
    const unknown = { version: "one" };
    expect(migrateOnRead(current, MIGRATIONS)).toBe(current);
    expect(migrateOnRead(newer, MIGRATIONS)).toBe(newer);
    expect(migrateOnRead(unknown, MIGRATIONS)).toBe(unknown);
    expect(migrateOnRead([1], MIGRATIONS)).toEqual([1]);
    expect(migrateOnRead(null, MIGRATIONS)).toBeNull();
  });

  test("refuses a failed step naming the file, both versions and the cause, the input unchanged", () => {
    const raw = deepFreeze({ version: 2, renamed: "unmovable" });
    const before = JSON.stringify(raw);
    let caught: unknown;
    try {
      migrateOnRead(raw, MIGRATIONS);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FormatMigrationError);
    expect((caught as Error).message).toBe(
      "The test file is format version 2, and this version of Alcove could " +
        "not move it to version 3: the renamed field cannot be split. The " +
        "file was not changed. Use the version that wrote it.",
    );
    expect(JSON.stringify(raw)).toBe(before);
  });

  test("states what was left unchanged in the format's own words", () => {
    expect(() =>
      migrateOnRead(
        { version: 2, renamed: "unmovable" },
        { ...MIGRATIONS, unchangedStatement: "The stored copy was kept." },
      ),
    ).toThrow(
      "could not move it to version 3: the renamed field cannot be split. " +
        "The stored copy was kept. Use the version that wrote it.",
    );
  });
});

describe("an earlier version no chain of steps leads from", () => {
  const BROKEN_CHAIN: FormatMigrations<number> = {
    ...MIGRATIONS,
    steps: [MIGRATIONS.steps[1]],
  };

  test("is refused naming both versions, the input unchanged", () => {
    const raw = deepFreeze({ version: 1, old: "x" });
    const before = JSON.stringify(raw);
    expect(() => migrateOnRead(raw, BROKEN_CHAIN)).toThrow(
      new FormatMigrationError(
        BROKEN_CHAIN as FormatMigrations<unknown>,
        1,
        3,
        "it has no migration from version 1",
      ),
    );
    expect(() => migrateOnRead(raw, BROKEN_CHAIN)).toThrow(
      "The test file is format version 1, and this version of Alcove could " +
        "not move it to version 3: it has no migration from version 1. The " +
        "file was not changed. Use the version that wrote it.",
    );
    expect(JSON.stringify(raw)).toBe(before);
  });

  test("leaves a version a step leads from to migrate", () => {
    expect(migrateOnRead({ version: 2, renamed: "x" }, BROKEN_CHAIN)).toEqual({
      version: 3,
      renamed: "x",
      added: true,
    });
  });

  test("is refused for a literal of the current one's family", () => {
    const literals: FormatMigrations<string> = {
      fileName: "The test file",
      versionField: "version",
      current: "alcove-test/v3",
      steps: [
        { from: "alcove-test/v2", to: "alcove-test/v3", migrate: (d) => d },
      ],
      failureRemedy: "Use the version that wrote it.",
    };
    expect(() =>
      migrateOnRead({ version: "alcove-test/v1" }, literals),
    ).toThrow(FormatMigrationError);
    const otherFamily = { version: "alcove-other/v1" };
    expect(migrateOnRead(otherFamily, literals)).toBe(otherFamily);
  });
});

describe("formatVersionPrecedes", () => {
  test.each([
    [1, 3, true],
    [3, 3, false],
    [4, 3, false],
    ["alcove-x/v2", "alcove-x/v10", true],
    ["alcove-x/v10", "alcove-x/v2", false],
    ["alcove-y/v1", "alcove-x/v2", false],
    ["alcove-x/v1-synthetic", "alcove-x/v2", false],
    ["alcove-x/v01", "alcove-x/v2", false],
    ["alcove-x/v1", "alcove-x/v02", false],
    ["alcove-x/v0", "alcove-x/v2", true],
    [1.5, 3, false],
    ["1", 3, false],
  ])("%j before %j is %j", (version, current, expected) => {
    expect(formatVersionPrecedes(version, current)).toBe(expected);
  });
});

describe("a version number with a leading zero", () => {
  const literals: FormatMigrations<string> = {
    fileName: "The test file",
    versionField: "version",
    current: "alcove-test/v3",
    steps: [],
    failureRemedy: "Use the version that wrote it.",
  };

  test("is an unrecognized tag, returned as it is for the schema to refuse", () => {
    for (const version of ["alcove-test/v01", "alcove-test/v0000000002"]) {
      const raw = { version };
      expect(migrateOnRead(raw, literals)).toBe(raw);
    }
    expect(() =>
      migrateOnRead({ version: "alcove-test/v2" }, literals),
    ).toThrow(FormatMigrationError);
  });

  test("is not a later version either", () => {
    expect(
      declaresLaterFormatVersion({ version: "alcove-test/v04" }, literals),
    ).toBe(false);
  });
});

describe("formatVersionFollows", () => {
  test.each([
    [4, 3, true],
    [3, 3, false],
    [1, 3, false],
    ["alcove-x/v10", "alcove-x/v2", true],
    ["alcove-x/v2", "alcove-x/v10", false],
    ["alcove-x/v99999999999999999999", "alcove-x/v2", true],
    ["alcove-y/v9", "alcove-x/v2", false],
    ["alcove-x/v09", "alcove-x/v2", false],
    [4.5, 3, false],
  ])("%j after %j is %j", (version, current, expected) => {
    expect(formatVersionFollows(version, current)).toBe(expected);
  });
});

describe("declaresLaterFormatVersion", () => {
  test("reads the declared version, or the absent one, against the current", () => {
    expect(declaresLaterFormatVersion({ version: 4 }, MIGRATIONS)).toBe(true);
    expect(declaresLaterFormatVersion({ version: 3 }, MIGRATIONS)).toBe(false);
    expect(declaresLaterFormatVersion({ version: 1 }, MIGRATIONS)).toBe(false);
    expect(declaresLaterFormatVersion({}, MIGRATIONS)).toBe(false);
    expect(
      declaresLaterFormatVersion({}, { ...MIGRATIONS, absentVersion: 5 }),
    ).toBe(true);
  });

  test("is false for a value that is not a plain object", () => {
    for (const raw of [undefined, null, 4, "4", [{ version: 4 }]])
      expect(declaresLaterFormatVersion(raw, MIGRATIONS)).toBe(false);
  });
});

describe("readableFormatVersions", () => {
  test("lists the current version and each one a chain leads from", () => {
    expect(readableFormatVersions(MIGRATIONS)).toEqual([3, 1, 2]);
  });

  test("leaves out a step whose chain loops or stops short", () => {
    const broken: FormatMigrations<number> = {
      ...MIGRATIONS,
      steps: [
        { from: 1, to: 2, migrate: (d) => d },
        { from: 2, to: 1, migrate: (d) => d },
        { from: 5, to: 6, migrate: (d) => d },
      ],
    };
    expect(readableFormatVersions(broken)).toEqual([3]);
  });
});

describe("this build's migration tables", () => {
  test.each([
    ["key file", KEY_FILE_MIGRATIONS],
    ["exchange record", EXCHANGE_RECORD_MIGRATIONS],
    ["verification keys", EXCHANGE_KEYS_MIGRATIONS],
    ["signed receipt", SIGNED_RECEIPT_MIGRATIONS],
  ] as Array<[string, FormatMigrations<unknown>]>)(
    "every %s step leads from a distinct version to the current one",
    (_name, migrations) => {
      const froms = migrations.steps.map((step) => step.from);
      expect(new Set(froms).size).toBe(froms.length);
      expect(froms).not.toContain(migrations.current);
      for (const from of froms)
        expect(migrationChainEnd(migrations, from).reaches).toBe(true);
    },
  );
});
