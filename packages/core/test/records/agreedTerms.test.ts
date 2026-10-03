import { describe, expect, test } from "vitest";

import {
  AGREED_TERMS_VERSION,
  parseAgreedTerms,
  serializeAgreedTerms,
} from "../../src/records/agreedTerms";
import {
  buildExchangeRecord,
  computeTermsHash,
} from "../../src/records/exchangeRecord";

import type { ExchangeRecordInputs } from "../../src/records/exchangeRecord";
import type { LinkageTerms } from "../../src/config/linkageTermsSchema";

const localTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "Party A",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
  payload: { send: [{ name: "dose" }] },
};
const partnerTerms: LinkageTerms = {
  ...localTerms,
  identity: "Party B",
  payload: { send: [{ name: "status" }] },
};

const inputs: ExchangeRecordInputs = {
  localTerms,
  partnerTerms,
  contributedLinkageFields: ["ssn"],
  outcome: "completed",
  certificateMismatchObserved: false,
  recordsExposed: 1,
  localPayloadSent: { columns: ["dose"], rows: [["10mg"]] },
  partnerPayloadReceived: { columns: ["status"], rows: [["active"]] },
  createdAt: "2026-01-02T03:04:05.000Z",
};

describe("the agreed-terms file", () => {
  test("a build states the terms its hash is computed over", async () => {
    const { agreedTerms } = await buildExchangeRecord(inputs);
    expect(agreedTerms).toEqual({
      version: AGREED_TERMS_VERSION,
      localTerms,
      partnerTerms,
    });
  });

  test("written and read back, it re-derives the record's hash", async () => {
    const { record, agreedTerms } = await buildExchangeRecord(inputs);
    if (agreedTerms === undefined) throw new Error("the build stated no terms");
    const read = parseAgreedTerms(
      JSON.parse(serializeAgreedTerms(agreedTerms)),
    );
    expect(read).toEqual(agreedTerms);
    expect(await computeTermsHash(read.localTerms, read.partnerTerms)).toBe(
      record.termsHash,
    );
  });

  test("an unrecognized version is refused rather than read", () => {
    expect(() =>
      parseAgreedTerms({
        version: "alcove-agreed-terms-file/v0",
        localTerms,
        partnerTerms,
      }),
    ).toThrow();
  });

  test("terms the bounded schema refuses are refused whole", () => {
    expect(() =>
      parseAgreedTerms({
        version: AGREED_TERMS_VERSION,
        localTerms,
        partnerTerms: { ...partnerTerms, algorithm: "not-an-algorithm" },
      }),
    ).toThrow();
  });
});
