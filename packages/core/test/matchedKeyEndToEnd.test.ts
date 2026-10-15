import { expect, test } from "vitest";
import PSI from "@openmined/psi.js";

import {
  prepareForExchange,
  runExchange,
  type ExchangeResult,
} from "../src/exchange";
import { createMessagePipe } from "../src/connection/messageConnection";
import type { LinkageTerms } from "../src/config/linkageTermsSchema";

const psiLibrary = await PSI();

const COLUMNS = ["last_name", "first_name"];

// Most precise first: a record whose full name matches pairs on the first key,
// and one whose first name alone matches pairs on the second.
const TERMS: LinkageTerms = {
  version: "1.0.0",
  identity: "Matching Key Test",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "last_name", type: "last_name" },
    { name: "first_name", type: "first_name" },
  ],
  linkageKeys: [
    {
      name: "full name",
      elements: [{ field: "last_name" }, { field: "first_name" }],
    },
    { name: "first name", elements: [{ field: "first_name" }] },
  ],
};

const initiatorRows = [
  { last_name: "Brown", first_name: "Carol" },
  { last_name: "Taylor", first_name: "Frank" },
  { last_name: "Nguyen", first_name: "Linh" },
];

const responderRows = [
  { last_name: "Wilson", first_name: "Frank" },
  { last_name: "Brown", first_name: "Carol" },
];

async function runBothParties(asks: {
  initiator: boolean;
  responder: boolean;
}): Promise<[ExchangeResult, ExchangeResult]> {
  const [initiatorConn, responderConn] = createMessagePipe();
  const prepare = (
    identity: string,
    rows: Array<Record<string, string>>,
    includeMatchingKey: boolean,
  ) => {
    const prepared = prepareForExchange(
      { linkageTerms: { ...TERMS, identity } },
      identity,
      rows,
      COLUMNS,
    );
    if (includeMatchingKey) prepared.includeMatchingKey = true;
    return prepared;
  };
  return Promise.all([
    runExchange(
      initiatorConn,
      "initiator",
      prepare("Initiator Co", initiatorRows, asks.initiator),
      { psiLibrary },
    ),
    runExchange(
      responderConn,
      "responder",
      prepare("Responder Co", responderRows, asks.responder),
      { psiLibrary },
    ),
  ]);
}

test("each party is told the key every one of its pairs matched on", async () => {
  const [initiator, responder] = await runBothParties({
    initiator: true,
    responder: true,
  });

  expect(initiator.associationTable).toEqual([
    [0, 1],
    [1, 0],
  ]);
  expect(initiator.matchedKeyOfPair).toEqual(["full name", "first name"]);

  expect(responder.associationTable).toEqual([
    [0, 1],
    [1, 0],
  ]);
  expect(responder.matchedKeyOfPair).toEqual(["first name", "full name"]);
});

test("the matching key is local: a party that does not ask is told nothing, and its table is unchanged", async () => {
  const [baselineInitiator, baselineResponder] = await runBothParties({
    initiator: false,
    responder: false,
  });
  const [initiator, responder] = await runBothParties({
    initiator: true,
    responder: false,
  });

  expect(initiator.matchedKeyOfPair).toEqual(["full name", "first name"]);
  expect(responder).not.toHaveProperty("matchedKeyOfPair");
  expect(baselineInitiator).not.toHaveProperty("matchedKeyOfPair");

  expect(initiator.associationTable).toEqual(
    baselineInitiator.associationTable,
  );
  expect(responder.associationTable).toEqual(
    baselineResponder.associationTable,
  );
  // The agreed terms the record binds do not change with a local setting.
  expect(initiator.audit).toBeDefined();
  expect(initiator.audit!.record.termsHash).toBe(
    baselineInitiator.audit!.record.termsHash,
  );
});
