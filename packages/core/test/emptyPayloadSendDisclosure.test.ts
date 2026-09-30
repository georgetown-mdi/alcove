import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { prepareForExchange, runExchange } from "../src/exchange";
import {
  deriveAcceptedLinkageTerms,
  validateCompatibility,
} from "../src/linkageTermsNegotiation";
import { disclosedColumnNames } from "../src/config/metadata";
import { createMessagePipe } from "../src/connection/messageConnection";
import { ProtocolRefusalError } from "../src/errors";
import { termsStatingDeclaredPayloadSend } from "../src/payloadExchange";

import type { LinkageTerms } from "../src/config/linkageTermsSchema";
import type { Metadata } from "../src/config/metadata";
import type { MessageConnection } from "../src/connection/messageConnection";

// An inviter that declares `payload.receive: []` mirrors to a present, empty
// `payload.send` on the acceptor. The acceptor's own metadata may still
// declare payload columns.
// These tests assert that no payload column reaches the wire before the
// partner's runtime reconciliation would catch it, which fires only after
// values arrive.

const psiLibrary = await PSI();

const inviterTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "Inviter Co",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "firstName", type: "first_name" }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
  payload: { receive: [] },
};

// The same strict declaration with the inviting party entitled to no result. The
// mirror gives the acceptor the same empty `send` beside `shareWithPartner:
// false`, and runExchange builds no payload at all for a partner that expects
// none -- so the acceptor's disclosed columns cannot reach the wire whatever its
// metadata says, and there is no disclosure left for the guard to control.
const inviterTermsWithoutOutput: LinkageTerms = {
  ...inviterTerms,
  output: { expectsOutput: false, shareWithPartner: true },
};

// The lazy direction, unchanged by any of this: the inviter authors no payload
// block, so the mirror leaves the acceptor's `send` absent and its metadata alone
// governs what it transmits.
const inviterTermsWithoutPayload: LinkageTerms = { ...inviterTerms };
delete inviterTermsWithoutPayload.payload;

// The inviter holds a linkage column only, so it discloses nothing of its own and
// the assertions below isolate the acceptor's direction.
const inviterRows = [
  { first_name: "Carol" },
  { first_name: "Elizabeth" },
  { first_name: "Henry" },
];
const inviterColumns = ["first_name"];

const acceptorRows = [
  { first_name: "Alice", diagnosis: "A-hypertension", notes: "A-note" },
  { first_name: "Carol", diagnosis: "C-diabetes", notes: "C-note" },
  { first_name: "Elizabeth", diagnosis: "E-asthma", notes: "E-note" },
];
const acceptorColumns = ["first_name", "diagnosis", "notes"];
const acceptorMetadata: Metadata = [
  { name: "first_name", type: "first_name", role: "linkage", isPayload: false },
  { name: "diagnosis", type: "other", role: "payload", isPayload: true },
  { name: "notes", type: "other", role: "payload", isPayload: true },
];

function acceptorPreparedFor(inviter: LinkageTerms) {
  return prepareForExchange(
    {
      metadata: acceptorMetadata,
      linkageTerms: deriveAcceptedLinkageTerms(inviter, "Acceptor Co"),
    },
    "Acceptor Co",
    acceptorRows,
    acceptorColumns,
  );
}

function acceptorPrepared() {
  return acceptorPreparedFor(inviterTerms);
}

function recordSends(conn: MessageConnection): {
  conn: MessageConnection;
  sent: unknown[];
} {
  const sent: unknown[] = [];
  return {
    sent,
    conn: {
      send: async (data) => {
        sent.push(data);
        return conn.send(data);
      },
      receive: (timeoutMs?: number) => conn.receive(timeoutMs),
      close: () => conn.close(),
    },
  };
}

/**
 * Assert that no message the acceptor put on the wire names a payload column or
 * holds one of its values.
 */
function expectNoPayloadOnWire(sent: unknown[]): void {
  const payloadColumnsOnWire = sent.flatMap((message) =>
    typeof message === "object" && message !== null && "columns" in message
      ? ((message as { columns?: string[] }).columns ?? [])
      : [],
  );
  expect(payloadColumnsOnWire).toEqual([]);
  expect(JSON.stringify(sent)).not.toContain("C-diabetes");
  expect(JSON.stringify(sent)).not.toContain("E-asthma");
}

test("an acceptor declaring it sends nothing states the columns its metadata discloses", () => {
  expect(disclosedColumnNames(acceptorMetadata)).toEqual([
    "diagnosis",
    "notes",
  ]);

  // The partner, which receives nothing, sees the stated columns as a change
  // to its terms at the terms exchange; nothing refuses them locally.
  const prepared = acceptorPrepared();
  expect(
    termsStatingDeclaredPayloadSend(prepared.linkageTerms, prepared.metadata)
      .payload?.send,
  ).toStrictEqual([{ name: "diagnosis" }, { name: "notes" }]);
});

test("no payload column reaches the wire from an acceptor declaring it sends nothing", async () => {
  const [connInviter, connAcceptorRaw] = createMessagePipe();
  const { conn: connAcceptor, sent } = recordSends(connAcceptorRaw);

  const inviterPrepared = prepareForExchange(
    { linkageTerms: inviterTerms },
    "Inviter Co",
    inviterRows,
    inviterColumns,
  );

  const acceptorRun = (async () =>
    runExchange(connAcceptor, "responder", acceptorPrepared(), {
      psiLibrary,
    }))().finally(() => connAcceptorRaw.close());

  const [, acceptorResult] = await Promise.allSettled([
    runExchange(connInviter, "initiator", inviterPrepared, { psiLibrary }),
    acceptorRun,
  ]);

  // Nothing the acceptor put on the wire holds a payload column or a payload
  // value. A regression that let the disclosure through would transmit
  // {columns: [diagnosis, notes]} here, and these three assertions catch it even
  // though the partner-side reconciliation would still abort afterwards.
  expectNoPayloadOnWire(sent);

  // The inviter, which receives nothing, refuses the columns the acceptor's
  // terms state at the terms exchange, before any key or payload moves.
  expect(acceptorResult.status).toBe("rejected");
  if (acceptorResult.status === "rejected")
    expect(acceptorResult.reason).toBeInstanceOf(ProtocolRefusalError);
});

test("the same acceptor configuration runs to completion when the inviting party receives no result", async () => {
  const acceptorTerms = deriveAcceptedLinkageTerms(
    inviterTermsWithoutOutput,
    "Acceptor Co",
  );
  // The one thing that differs from the refused case: the same empty `send`, and
  // a partner entitled to nothing.
  expect(acceptorTerms.payload).toStrictEqual({ send: [] });
  expect(acceptorTerms.output.shareWithPartner).toBe(false);
  expect(
    validateCompatibility(acceptorTerms, inviterTermsWithoutOutput).errors,
  ).toEqual([]);

  const [connInviter, connAcceptorRaw] = createMessagePipe();
  const { conn: connAcceptor, sent } = recordSends(connAcceptorRaw);

  const inviterPrepared = prepareForExchange(
    { linkageTerms: inviterTermsWithoutOutput },
    "Inviter Co",
    inviterRows,
    inviterColumns,
  );
  const acceptorRun = (async () =>
    runExchange(
      connAcceptor,
      "responder",
      acceptorPreparedFor(inviterTermsWithoutOutput),
      { psiLibrary },
    ))().finally(() => connAcceptorRaw.close());

  const [inviterResult, acceptorResult] = await Promise.allSettled([
    runExchange(connInviter, "initiator", inviterPrepared, { psiLibrary }),
    acceptorRun,
  ]);

  // Rethrow rather than assert a status, so a regression reports the refusal it
  // reintroduced instead of a bare "fulfilled" mismatch.
  if (inviterResult.status === "rejected") throw inviterResult.reason;
  if (acceptorResult.status === "rejected") throw acceptorResult.reason;

  // The exchange produced the acceptor's matched result -- it ran, it was not
  // refused -- while nothing it disclosed left the machine.
  expect(acceptorResult.value.associationTable?.[0]).toHaveLength(2);
  expectNoPayloadOnWire(sent);
});

test("an inviter that authors no payload block leaves the acceptor lazy", () => {
  const acceptorTerms = deriveAcceptedLinkageTerms(
    inviterTermsWithoutPayload,
    "Acceptor Co",
  );
  // Absent, not empty: nothing to hold the acceptor's metadata to, in either
  // output direction.
  expect(acceptorTerms.payload).toBeUndefined();

  const prepared = acceptorPreparedFor(inviterTermsWithoutPayload);
  // The metadata the empty declaration refuses still transmits both columns here:
  // an unauthored dictionary is compared against nothing, in either direction.
  expect(disclosedColumnNames(prepared.metadata)).toEqual([
    "diagnosis",
    "notes",
  ]);
});
