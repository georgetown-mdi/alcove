import { describe, expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";

import type { AssociationTable } from "../src/types";

// Each party's association table is fixed per identity, so a test states the
// pairs each side holds and the rows the sender's payload names follow from
// its own table, as a conforming sender's do.
const tables = vi.hoisted(() => new Map<string, AssociationTable>());

vi.mock("../src/exchange/psiPhase", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/exchange/psiPhase")>();
  return {
    ...original,
    runPsiPhase: (
      p: Parameters<typeof original.runPsiPhase>[0],
    ): ReturnType<typeof original.runPsiPhase> => {
      const table = tables.get(p.linkageTerms.identity ?? "");
      if (table === undefined)
        throw new Error("no association table fixed for this party");
      return Promise.resolve({
        associationTable: [[...table[0]], [...table[1]]],
        intersectionCount: undefined,
        entityClusters: undefined,
        matchedKeyOfPair: undefined,
      });
    },
  };
});

import { runExchange } from "../src/exchange";
import { ConnectionError } from "../src/errors";
import { createMessagePipe } from "../src/connection/messageConnection";
import { exchangeRecordFromFailure } from "../src/exchange/failureRecords";
import {
  assertPayloadRowsMatchPairedRows,
  buildOutputTable,
} from "../src/payloadExchange";
import {
  reconstructCommittedData,
  verifyExchangeRecord,
} from "../src/records/recordVerification";
import { sanitizeErrorForDisplay } from "../src/utils/sanitizeErrorForDisplay";
import { firstNameAndSentNote, prepared } from "./utils/support";

import type { CSVRow } from "../src/file";
import type { PartnerPayload } from "../src/payloadExchange";

const psiLibrary = await PSI();

const RECEIVER = "Receiver Co";
const SENDER = "Sender Co";

const receiverRows: CSVRow[] = [
  { first_name: "Carol" },
  { first_name: "Elizabeth" },
];
const senderRows: CSVRow[] = Array.from({ length: 10 }, (_, i) => ({
  first_name: `Name${i}`,
  note: `note-${i}`,
}));

/**
 * Run both parties, the receiver as initiator, so the receiver's own payload
 * send precedes its receive and its record of that send is owed whatever the
 * partner's payload holds.
 */
async function runPair(
  receiverTable: AssociationTable,
  senderTable: AssociationTable,
) {
  tables.set(RECEIVER, receiverTable);
  tables.set(SENDER, senderTable);
  const [receiverConn, senderConn] = createMessagePipe();
  const receiverPrepared = prepared(RECEIVER, receiverRows);
  const [receiver, sender] = await Promise.allSettled([
    runExchange(receiverConn, "initiator", receiverPrepared, {
      psiLibrary,
    }).finally(() => receiverConn.close()),
    runExchange(
      senderConn,
      "responder",
      prepared(SENDER, senderRows, {
        metadata: firstNameAndSentNote,
        columns: ["first_name", "note"],
      }),
      { psiLibrary },
    ).finally(() => senderConn.close()),
  ]);
  return { receiver, sender, receiverPrepared };
}

function refusal(outcome: PromiseSettledResult<unknown>): ConnectionError {
  expect(outcome.status).toBe("rejected");
  const reason = (outcome as PromiseRejectedResult).reason as unknown;
  expect(reason).toBeInstanceOf(ConnectionError);
  expect((reason as ConnectionError).kind).toBe("protocol");
  return reason as ConnectionError;
}

describe("a received payload whose rows are not the partner rows the table pairs", () => {
  test("a row for a record the table does not pair is refused before the receipt", async () => {
    const { receiver } = await runPair(
      [
        [0, 1],
        [5, 5],
      ],
      [
        [5, 9],
        [0, 1],
      ],
    );
    const error = refusal(receiver);
    const rendered = sanitizeErrorForDisplay(error);
    expect(rendered).toContain("the partner sent 2 payload rows");
    expect(rendered).toContain("name 1 of the partner's records");
    expect(rendered).not.toMatch(/[59]/);
    expect(rendered).not.toContain("note-");
    // The receiver's own payload had gone, so its record is owed and states
    // the run ended after that send.
    expect(exchangeRecordFromFailure(error)?.record.outcome).toBe(
      "receipt-swap-terminated",
    );
  });

  test("a row substituted for a paired one is refused before the receipt", async () => {
    const { receiver } = await runPair(
      [
        [0, 1],
        [5, 6],
      ],
      [
        [5, 9],
        [0, 1],
      ],
    );
    const error = refusal(receiver);
    expect(sanitizeErrorForDisplay(error)).toContain(
      "name 2 of the partner's records",
    );
    expect(exchangeRecordFromFailure(error)?.record.outcome).toBe(
      "receipt-swap-terminated",
    );
  });
});

describe("a conforming sender's payload", () => {
  test("is admitted where the two tables order the pairs differently, and the receiver's record verifies", async () => {
    // The receiver's table ascends by its own rows, so its partner half does
    // not ascend; the sender sends in its own ascending order.
    const { receiver, sender, receiverPrepared } = await runPair(
      [
        [0, 1],
        [6, 5],
      ],
      [
        [5, 6],
        [1, 0],
      ],
    );
    if (receiver.status !== "fulfilled") throw receiver.reason;
    expect(sender.status).toBe("fulfilled");
    const result = receiver.value;
    expect([...result.partnerPayload.rowIndices]).toEqual([5, 6]);

    const table = buildOutputTable(
      result.associationTable!,
      receiverPrepared.rawRows,
      receiverPrepared.metadata,
      result.partnerPayload,
    );
    // No cell here needs CSV escaping, so the built table is the result file
    // as read back.
    const audit = result.audit!;
    const { data } = reconstructCommittedData({
      record: audit.record,
      inputRows: receiverPrepared.rawRows,
      result: { headers: table.headers, rows: table.rows },
      ourIdColumn: undefined,
    });
    const report = await verifyExchangeRecord(audit.record, audit.keys, {
      data,
    });
    expect(report.commitments.partnerPayloadReceived).toBe("verified");
    expect(report.commitments.associationTable).toBe("verified");
    expect(
      Object.values(report.commitments).every((s) => s === "verified"),
    ).toBe(true);
  });
});

describe("assertPayloadRowsMatchPairedRows", () => {
  const payload = (rowIndices: number[]): PartnerPayload => ({
    columns: ["note"],
    rowIndices,
    rows: rowIndices.map(() => ["x"]),
  });

  test("admits the distinct paired rows in ascending order, a row paired twice once", () => {
    expect(() =>
      assertPayloadRowsMatchPairedRows(payload([2, 5, 7]), [7, 5, 5, 2]),
    ).not.toThrow();
  });

  test("refuses the paired rows out of ascending order", () => {
    expect(() =>
      assertPayloadRowsMatchPairedRows(payload([5, 2]), [2, 5]),
    ).toThrow(ConnectionError);
  });

  test("refuses a paired row left out", () => {
    expect(() =>
      assertPayloadRowsMatchPairedRows(payload([2]), [2, 5]),
    ).toThrow(ConnectionError);
  });

  test("admits a payload naming no column, whatever its rows", () => {
    expect(() =>
      assertPayloadRowsMatchPairedRows(
        { columns: [], rowIndices: [], rows: [] },
        [2, 5],
      ),
    ).not.toThrow();
  });

  test("refuses rows against a party holding no table", () => {
    expect(() => assertPayloadRowsMatchPairedRows(payload([0]), [])).toThrow(
      ConnectionError,
    );
  });
});
