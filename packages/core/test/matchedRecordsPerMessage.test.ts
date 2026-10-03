import { describe, expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";

import { MAX_FRAME_SIZE_BYTES } from "../src/connection/frameSize";
import { createMessagePipe } from "../src/connection/messageConnection";
import { UsageError } from "../src/errors";
import {
  matchedRecordsOverMessageMessage,
  mostMatchedRecordsOneSide,
  prepareForExchange,
  runExchange,
} from "../src/exchange";

import type { MessageConnection } from "../src/connection/messageConnection";
import type { LinkageStrategy } from "../src/config/linkageTermsSchema";
import type { PreparedExchange } from "../src/exchange";

// A file-sync cascade lists each party's matched records in one message, held
// to the receiver's per-list bound (docs/spec/PROTOCOL.md, One list of matched
// records per message). The bound is lowered here so a handful of records
// reaches it.
const LIST_BOUND = 4;
vi.mock("../src/utils/boundedJson", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/boundedJson")>()),
  MAX_JSON_ARRAY_ELEMENTS: 4,
}));

const psiLibrary = await PSI();

describe("the most records one side of a cascade can match", () => {
  test("is the smaller count where neither side keeps its duplicates", () => {
    expect(mostMatchedRecordsOneSide("one-to-one", 10, 7)).toBe(7);
    expect(mostMatchedRecordsOneSide("one-to-one", 3, 7)).toBe(3);
  });

  test("is the count of the side that keeps its duplicates", () => {
    expect(mostMatchedRecordsOneSide("many-to-one", 10, 7)).toBe(10);
    expect(mostMatchedRecordsOneSide("many-to-one", 3, 7)).toBe(3);
    expect(mostMatchedRecordsOneSide("one-to-many", 10, 7)).toBe(7);
  });

  test("is the larger count where both sides keep their duplicates", () => {
    expect(mostMatchedRecordsOneSide("many-to-many", 3, 7)).toBe(7);
  });

  test("is the same figure for the two mirror labels of one exchange", () => {
    expect(mostMatchedRecordsOneSide("many-to-one", 10, 7)).toBe(
      mostMatchedRecordsOneSide("one-to-many", 7, 10),
    );
  });
});

function prepared(
  identity: string,
  rowCount: number,
  linkageStrategy: LinkageStrategy = "cascade",
): PreparedExchange {
  return prepareForExchange(
    {
      linkageTerms: {
        version: "1.0.0",
        date: "2026-01-01",
        algorithm: "psi",
        deduplicate: false,
        linkageStrategy,
        identity,
        output: { expectsOutput: true, shareWithPartner: true },
        linkageFields: [{ name: "firstName", type: "first_name" }],
        linkageKeys: [
          { name: "firstName", elements: [{ field: "firstName" }] },
        ],
      },
    },
    identity,
    Array.from({ length: rowCount }, (_unused, i) => ({
      first_name: `zq${String.fromCharCode(97 + (i % 26))}${Math.floor(i / 26)}`,
    })),
    ["first_name"],
  );
}

// `conn`, stating a file-sync message bound where `fileSync` is set, and
// recording every frame this party sends.
function over(
  conn: MessageConnection,
  fileSync: boolean,
  sent: Array<unknown>,
): MessageConnection {
  return {
    send: (data) => {
      sent.push(data);
      return conn.send(data);
    },
    receive: (timeoutMs?: number) => conn.receive(timeoutMs),
    close: () => conn.close(),
    ...(fileSync
      ? { outboundFileSyncFrameBound: () => MAX_FRAME_SIZE_BYTES }
      : {}),
  };
}

async function runPair(params: {
  localRows: number;
  partnerRows: number;
  fileSync: boolean;
  strategy?: LinkageStrategy;
}) {
  const [local, partner] = createMessagePipe();
  const sent: Array<unknown> = [];
  const outcomes = await Promise.allSettled([
    runExchange(
      over(local, params.fileSync, sent),
      "initiator",
      prepared("Local Co", params.localRows, params.strategy),
      { psiLibrary },
    ),
    runExchange(
      over(partner, params.fileSync, []),
      "responder",
      prepared("Partner Co", params.partnerRows, params.strategy),
      { psiLibrary },
    ),
  ]);
  return { local: outcomes[0], partner: outcomes[1], sent };
}

test("a file-sync cascade that could match more records than one message lists is refused by both parties after the terms", async () => {
  const { local, partner, sent } = await runPair({
    localRows: LIST_BOUND + 1,
    partnerRows: LIST_BOUND + 2,
    fileSync: true,
  });
  for (const outcome of [local, partner]) {
    expect(outcome.status).toBe("rejected");
    const reason = (outcome as PromiseRejectedResult).reason as Error;
    expect(reason).toBeInstanceOf(UsageError);
    expect(reason.message).toBe(
      matchedRecordsOverMessageMessage(LIST_BOUND + 1, LIST_BOUND),
    );
  }
  // The terms and the compatibility decision, and nothing after them.
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual({ decision: "proceed" });
});

test("a file-sync cascade whose smaller side is within one message runs", async () => {
  const { local, partner } = await runPair({
    localRows: LIST_BOUND,
    partnerRows: LIST_BOUND + 2,
    fileSync: true,
  });
  expect(local.status).toBe("fulfilled");
  expect(partner.status).toBe("fulfilled");
});

test("a transport with no file-sync message bound is not held to it", async () => {
  const { local, partner } = await runPair({
    localRows: LIST_BOUND + 1,
    partnerRows: LIST_BOUND + 2,
    fileSync: false,
  });
  expect(local.status).toBe("fulfilled");
  expect(partner.status).toBe("fulfilled");
});

test("a single-pass exchange is left to its dataset ceiling", async () => {
  const { local, partner } = await runPair({
    localRows: LIST_BOUND + 1,
    partnerRows: LIST_BOUND + 2,
    fileSync: true,
    strategy: "single-pass",
  });
  expect(local.status).toBe("fulfilled");
  expect(partner.status).toBe("fulfilled");
});
