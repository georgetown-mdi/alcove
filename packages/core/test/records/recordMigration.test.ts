import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { FormatMigrationError } from "../../src/config/formatMigration";
import {
  EXCHANGE_KEYS_MIGRATIONS,
  EXCHANGE_KEYS_VERSION,
  EXCHANGE_RECORD_MIGRATIONS,
  EXCHANGE_RECORD_VERSION,
  parseExchangeRecord,
  parseVerificationKeys,
} from "../../src/records/exchangeRecord";
import { recordedVersionReadable } from "../../src/records/recordVerification";
import {
  SIGNED_RECEIPT_MIGRATIONS,
  SIGNED_RECEIPT_VERSION,
  parseDualSignedRecord,
} from "../../src/records/signedReceipt";
import { verifyDualSignedRecord } from "../../src/records/signedReceiptVerification";

import type { FormatMigrations } from "../../src/config/formatMigration";

// Records, keys files and receipts are never rewritten, so each format is
// tested on its read alone: a made-up previous version, whose step renames
// one member back, migrated in memory with the document unchanged, and a
// failed step refused naming its cause.

function readVectors(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../vectors/${name}`, import.meta.url), "utf8"),
  );
}

const recordVector = (
  readVectors("exchange-record-vectors.json") as {
    vectors: Array<{ record: Record<string, unknown>; keys: unknown }>;
  }
).vectors[0];

const receiptBundle = (
  readVectors("signed-receipt-vectors.json") as {
    bundle: {
      expected: {
        initiatorFingerprint: string;
        responderFingerprint: string;
        initiatorIdentity: string;
        responderIdentity: string;
      };
      record: Record<string, unknown>;
    };
  }
).bundle;

function renamingStep(
  current: string,
  previous: string,
  stored: string,
  read: string,
): FormatMigrations<string>["steps"][number] {
  return {
    from: previous,
    to: current,
    migrate: ({ [stored]: value, ...rest }) => {
      if (value === undefined)
        throw new Error(`the previous version has no ${stored}`);
      return { ...rest, [read]: value };
    },
  };
}

function previousVersionOf(
  document: Record<string, unknown>,
  previous: string,
  read: string,
  stored: string,
): Record<string, unknown> {
  const { [read]: value, ...rest } = document;
  return { ...rest, version: previous, [stored]: value };
}

function expectMigrationRefused(read: () => unknown, cause: string): void {
  let caught: unknown;
  try {
    read();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(FormatMigrationError);
  expect((caught as Error).message).toContain(cause);
  expect((caught as Error).message).toContain("The file was not changed.");
}

// `<family>/v0` comes before every current literal of its family, and the
// tables below have no step from it.
function unchainedEarlierVersion(current: string): string {
  return `${current.slice(0, current.lastIndexOf("/"))}/v0`;
}

function expectUnchainedVersionRefused(
  stored: Record<string, unknown>,
  current: string,
  parse: (raw: unknown) => unknown,
): void {
  const earlier = { ...stored, version: unchainedEarlierVersion(current) };
  const before = JSON.stringify(earlier);
  let caught: unknown;
  try {
    parse(earlier);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(FormatMigrationError);
  expect((caught as Error).message).toContain(
    `is format version ${earlier.version}, and this version of Alcove could ` +
      `not move it to version ${current}: it has no migration from version ` +
      `${earlier.version}.`,
  );
  expect(JSON.stringify(earlier)).toBe(before);
}

describe("exchange record migration on read", () => {
  const previous = "alcove-exchange-record/v0-synthetic";
  const migrations: FormatMigrations<string> = {
    ...EXCHANGE_RECORD_MIGRATIONS,
    steps: [
      renamingStep(EXCHANGE_RECORD_VERSION, previous, "created", "createdAt"),
    ],
  };
  const stored = previousVersionOf(
    recordVector.record,
    previous,
    "createdAt",
    "created",
  );

  test("reads a previous version migrated in memory, the document unchanged", () => {
    const before = JSON.stringify(stored);
    expect(parseExchangeRecord(stored, migrations)).toEqual(
      parseExchangeRecord(recordVector.record),
    );
    expect(JSON.stringify(stored)).toBe(before);
    expect(recordedVersionReadable(stored, migrations)).toBe(true);
    expect(recordedVersionReadable(stored, EXCHANGE_RECORD_MIGRATIONS)).toBe(
      false,
    );
  });

  test("refuses a failed migration naming the cause, the document unchanged", () => {
    const { created: _created, ...broken } = stored;
    const before = JSON.stringify(broken);
    expectMigrationRefused(
      () => parseExchangeRecord(broken, migrations),
      "the previous version has no created",
    );
    expect(JSON.stringify(broken)).toBe(before);
  });

  test("this build reads only its own version", () => {
    expect(() => parseExchangeRecord(stored)).toThrow();
  });

  test("refuses an earlier version no step leads from, by name, the document unchanged", () => {
    expectUnchainedVersionRefused(stored, EXCHANGE_RECORD_VERSION, (raw) =>
      parseExchangeRecord(raw, migrations),
    );
  });
});

describe("verification keys migration on read", () => {
  const previous = "alcove-exchange-keys/v0-synthetic";
  const migrations: FormatMigrations<string> = {
    ...EXCHANGE_KEYS_MIGRATIONS,
    steps: [renamingStep(EXCHANGE_KEYS_VERSION, previous, "salt", "salts")],
  };
  const stored = previousVersionOf(
    recordVector.keys as Record<string, unknown>,
    previous,
    "salts",
    "salt",
  );

  test("reads a previous version migrated in memory, the document unchanged", () => {
    const before = JSON.stringify(stored);
    expect(parseVerificationKeys(stored, migrations)).toEqual(
      parseVerificationKeys(recordVector.keys),
    );
    expect(JSON.stringify(stored)).toBe(before);
  });

  test("refuses a failed migration naming the cause, the document unchanged", () => {
    const { salt: _salt, ...broken } = stored;
    const before = JSON.stringify(broken);
    expectMigrationRefused(
      () => parseVerificationKeys(broken, migrations),
      "the previous version has no salt",
    );
    expect(JSON.stringify(broken)).toBe(before);
  });

  test("refuses an earlier version no step leads from, by name, the document unchanged", () => {
    expectUnchainedVersionRefused(stored, EXCHANGE_KEYS_VERSION, (raw) =>
      parseVerificationKeys(raw, migrations),
    );
  });
});

describe("signed receipt migration on read", () => {
  const previous = "alcove-signed-receipt/v0-synthetic";
  const migrations: FormatMigrations<string> = {
    ...SIGNED_RECEIPT_MIGRATIONS,
    steps: [
      renamingStep(
        SIGNED_RECEIPT_VERSION,
        previous,
        "responderBlock",
        "responder",
      ),
    ],
  };
  const stored = previousVersionOf(
    receiptBundle.record,
    previous,
    "responder",
    "responderBlock",
  );

  test("reads a previous version migrated in memory whose signatures still verify, the document unchanged", async () => {
    const before = JSON.stringify(stored);
    const record = parseDualSignedRecord(stored, migrations);
    expect(record).toEqual(parseDualSignedRecord(receiptBundle.record));
    expect(JSON.stringify(stored)).toBe(before);
    const report = await verifyDualSignedRecord(record, {
      pinnedFingerprints: [
        receiptBundle.expected.responderFingerprint,
        receiptBundle.expected.initiatorFingerprint,
      ],
      expectedIdentities: [
        receiptBundle.expected.initiatorIdentity,
        receiptBundle.expected.responderIdentity,
      ],
      expectedTermsHash: record.content.termsHash,
      recordReceiptBinder: record.content.binder,
    });
    expect(report.outcome).toBe("verified");
  });

  test("refuses a failed migration naming the cause, the document unchanged", () => {
    const { responderBlock: _responder, ...broken } = stored;
    const before = JSON.stringify(broken);
    expectMigrationRefused(
      () => parseDualSignedRecord(broken, migrations),
      "the previous version has no responderBlock",
    );
    expect(JSON.stringify(broken)).toBe(before);
  });

  test("refuses an earlier version no step leads from, by name, the document unchanged", () => {
    expectUnchainedVersionRefused(stored, SIGNED_RECEIPT_VERSION, (raw) =>
      parseDualSignedRecord(raw, migrations),
    );
  });
});
