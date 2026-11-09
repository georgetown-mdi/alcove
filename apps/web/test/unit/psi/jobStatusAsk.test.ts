import { describe, expect, test } from "vitest";

import { fetchJobExchangeRecordOffer } from "@psi/jobClient/jobExchangeRecord";
import { fetchJobLogState } from "@psi/jobClient/jobDiagnosticLog";
import { fetchJobReceiptOffer } from "@psi/jobClient/jobReceipt";

/** A fetch answering with `body` as a 200 JSON status body. */
const statusResponse =
  (body: unknown): typeof fetch =>
  () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

// Readable bodies that are not a JSON object, an array among them, each
// holding a field a reader would answer on were it an object.
const NOT_AN_OBJECT: ReadonlyArray<unknown> = [
  null,
  "the status body",
  42,
  true,
  [],
  [{ receiptAvailable: true, recordAvailable: true, logAvailable: true }],
];

describe("each job-status reader's answer to a body that is not an object", () => {
  test.each(NOT_AN_OBJECT)(
    "the receipt reader answers none for %j",
    async (body) => {
      await expect(
        fetchJobReceiptOffer("job-1", statusResponse(body)),
      ).resolves.toEqual({ kind: "none" });
    },
  );

  test.each(NOT_AN_OBJECT)(
    "the record reader answers none for %j",
    async (body) => {
      await expect(
        fetchJobExchangeRecordOffer("job-1", statusResponse(body)),
      ).resolves.toEqual({ kind: "none" });
    },
  );

  test.each(NOT_AN_OBJECT)(
    "the log reader answers unanswered for %j",
    async (body) => {
      await expect(
        fetchJobLogState("job-1", statusResponse(body)),
      ).resolves.toBe("unanswered");
    },
  );
});
