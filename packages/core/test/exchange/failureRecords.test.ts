import { afterEach, describe, expect, test, vi } from "vitest";

import {
  carryingExchangeRecord,
  exchangeDisclosedWithoutPartnerPayload,
  exchangeRecordFromFailure,
  exchangeRecordOwedButUnbuilt,
} from "../../src/exchange/failureRecords";
import { buildOwedExchangeRecord } from "../../src/exchange/owedRecord";
import { getLogger } from "../../src/utils/logger";

import type { BuiltExchangeRecord } from "../../src/records/exchangeRecord";

vi.mock("../../src/records/exchangeRecord", () => ({
  buildExchangeRecord: () =>
    Promise.reject(new Error("the record could not be encoded")),
}));

const logger = getLogger("exchange");

const builtRecord = {
  record: { outcome: "receipt-swap-terminated" },
} as unknown as BuiltExchangeRecord;

const UNATTACHABLE_WARNING = "is not an object this run's self-attested record";

function warnSpy() {
  return vi.spyOn(logger, "warn").mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("carryingExchangeRecord", () => {
  test("an object failure takes the record and the one-direction mark", () => {
    const warn = warnSpy();
    const error = new Error("receipt swap failed");
    expect(carryingExchangeRecord(error, builtRecord, false)).toBe(error);
    expect(exchangeRecordFromFailure(error)).toBe(builtRecord);
    expect(exchangeRecordOwedButUnbuilt(error)).toBe(false);
    expect(exchangeDisclosedWithoutPartnerPayload(error)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  test("an object failure whose record did not build is marked unbuilt", () => {
    const error = new Error("receipt swap failed");
    carryingExchangeRecord(error, undefined, true);
    expect(exchangeRecordFromFailure(error)).toBeUndefined();
    expect(exchangeRecordOwedButUnbuilt(error)).toBe(true);
    expect(exchangeDisclosedWithoutPartnerPayload(error)).toBe(false);
  });

  test.each([["a string"], [42], [null], [undefined]])(
    "a thrown non-object (%s) is returned unmarked, with a warning that its record is lost",
    (thrown) => {
      const warn = warnSpy();
      expect(carryingExchangeRecord(thrown, builtRecord, false)).toBe(thrown);
      expect(exchangeRecordFromFailure(thrown)).toBeUndefined();
      expect(exchangeRecordOwedButUnbuilt(thrown)).toBe(false);
      expect(exchangeDisclosedWithoutPartnerPayload(thrown)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(UNATTACHABLE_WARNING);
    },
  );

  test("a thrown non-object whose record did not build warns once, at the build", async () => {
    const warn = warnSpy();
    const { audit } = await buildOwedExchangeRecord({
      localTerms: {},
      partnerTerms: {},
      postDisclosureFailure: { error: "a thrown string" },
      rowCount: 0,
      dataset: { fieldNames: [] },
      bothExpectOutput: false,
      attestedResultSize: undefined,
      retentionDisposition: undefined,
      heldResult: false,
      associationTable: undefined,
      localPayload: { columns: [], rowIndices: [], rows: [] },
      countOnly: false,
      partnerPayload: { columns: [], rowIndices: [], rows: [] },
      receiptBinder: undefined,
    } as unknown as Parameters<typeof buildOwedExchangeRecord>[0]);
    expect(audit).toBeUndefined();

    carryingExchangeRecord("a thrown string", audit, false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(
      "record of that disclosure could not be built",
    );
  });
});
