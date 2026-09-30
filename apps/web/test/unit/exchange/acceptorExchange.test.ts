import { describe, expect, test } from "vitest";

import { acceptorInitialColumnsState } from "@exchange/acceptorColumnsModel";
import { prepareAcceptorExchange } from "@exchange/acceptorExchange";

import type { CSVRow, LinkageTerms, Metadata } from "@alcove/core";
import type { AcceptorDataEdits } from "@psi/acceptInvitation";

// Two single-element name keys plus a payload the inviter sends, adopted verbatim
// from the invitation. The identity is the INVITER's; the acceptor substitutes its
// own name through acceptorExchangeDataSpec / deriveAcceptedLinkageTerms.
const inviterTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "firstName", type: "first_name" },
    { name: "lastName", type: "last_name" },
  ],
  linkageKeys: [
    { name: "first", elements: [{ field: "firstName" }] },
    { name: "last", elements: [{ field: "lastName" }] },
  ],
  payload: {
    send: [{ name: "program_code" }],
    receive: [],
  },
};

const columns = ["first_name", "last_name"];
const rawRows: Array<CSVRow> = [
  { first_name: "Alice", last_name: "Smith" },
  { first_name: "Bob", last_name: "Jones" },
];

// The confirm-columns edits the run assembles the spec from: the file-derived
// metadata (normalized for the editor, as acceptorInitialColumnsState seeds it)
// and its recommended cleaning, standing in for the launch payload.
function editsFor(metadata: Metadata): AcceptorDataEdits {
  return { metadata, standardization: [] };
}

// The file-derived seed metadata the columns step starts from.
const seedMetadata = acceptorInitialColumnsState(columns).metadata;

describe("prepareAcceptorExchange", () => {
  const baseEdits = editsFor(seedMetadata);

  test("adopts the invitation's terms under the committed name", () => {
    const prepared = prepareAcceptorExchange({
      deduplicate: false,
      linkageTerms: inviterTerms,
      acceptorName: "Sam Alvarez",
      edits: baseEdits,
      rawRows,
      columns,
    });
    // The acceptor's identity replaces the inviter's; the adopted fields and keys
    // are the invitation's exactly.
    expect(prepared.linkageTerms.identity).toBe("Sam Alvarez");
    expect(prepared.linkageTerms.linkageFields).toEqual(
      inviterTerms.linkageFields,
    );
    expect(prepared.linkageTerms.linkageKeys).toEqual(inviterTerms.linkageKeys);
    // The run binds to the acquired CSV with no re-parse.
    expect(prepared.rawRows).toBe(rawRows);
    expect(prepared.rowCount).toBe(2);
  });

  test("leaves this party one-to-one under a deduplicating invitation", () => {
    // The web accept entry point derives the acceptor's own terms
    // (deriveAcceptedLinkageTerms) as it prepares the exchange, ahead of any
    // connection, and that derivation takes this party's own deduplicate from
    // the seat rather than reading it off the invitation -- so what the inviter
    // declares, or goes on to present at the terms exchange, cannot make this
    // party the "many" side. An operator that left the seat's control closed
    // gets the run it got before the control existed.
    const prepared = prepareAcceptorExchange({
      deduplicate: false,
      linkageTerms: { ...inviterTerms, deduplicate: true },
      acceptorName: "Sam Alvarez",
      edits: baseEdits,
      rawRows,
      columns,
    });
    expect(prepared.linkageTerms.deduplicate).toBe(false);
  });

  test("receives the invitation's declared send as its own payload.receive", () => {
    const prepared = prepareAcceptorExchange({
      deduplicate: false,
      linkageTerms: inviterTerms,
      acceptorName: "Sam Alvarez",
      edits: baseEdits,
      rawRows,
      columns,
    });
    // The consent screen's send set is the list the terms exchange compares
    // against the send set the inviter states there.
    expect(prepared.linkageTerms.payload?.receive).toEqual([
      { name: "program_code" },
    ]);
  });

  test("retains the invitation's declared deduplicate as the partner's expected value", () => {
    // The terms-side commitment: the acceptor's own value is derived as false, so
    // the invitation's declaration for the INVITER's side would otherwise be
    // lost between the consent screen and the terms exchange. Both values the
    // invitation can hold are retained as-is -- never defaulted -- so the run
    // holds the partner to what this acceptance consented to.
    for (const declared of [false, true]) {
      const prepared = prepareAcceptorExchange({
        deduplicate: false,
        linkageTerms: { ...inviterTerms, deduplicate: declared },
        acceptorName: "Sam Alvarez",
        edits: baseEdits,
        rawRows,
        columns,
      });
      expect(prepared.linkageTerms.deduplicate).toBe(false);
      expect(prepared.expectedPartnerDeduplicate).toBe(declared);
    }
  });

  test("threads the confirm-columns edits into the prepared metadata", () => {
    // Mark last_name ignored: the edited metadata drives the prepared metadata,
    // proving the confirm-columns edits (not a CSV-inferred default) reach the run.
    // These terms key on firstName alone, so taking last_name out of linkage costs
    // no agreed key -- a run that cannot produce one is refused before it prepares.
    const firstNameOnlyTerms: LinkageTerms = {
      ...inviterTerms,
      linkageFields: [{ name: "firstName", type: "first_name" }],
      linkageKeys: [{ name: "first", elements: [{ field: "firstName" }] }],
    };
    const edited = seedMetadata.map((column) =>
      column.name === "last_name"
        ? { ...column, role: "ignored" as const }
        : column,
    );
    const prepared = prepareAcceptorExchange({
      deduplicate: false,
      linkageTerms: firstNameOnlyTerms,
      acceptorName: "Sam Alvarez",
      edits: editsFor(edited),
      rawRows,
      columns,
    });
    expect(
      prepared.metadata.find((column) => column.name === "last_name")?.role,
    ).toBe("ignored");
  });
});

describe("the accepting party's own deduplicate in the prepared exchange", () => {
  const baseEdits = editsFor(seedMetadata);

  test.each([false, true])(
    "carries the operator's value into the presented terms (invitation declares %s)",
    (declared) => {
      const prepared = prepareAcceptorExchange({
        deduplicate: true,
        linkageTerms: { ...inviterTerms, deduplicate: declared },
        acceptorName: "Sam Alvarez",
        edits: baseEdits,
        rawRows,
        columns,
      });
      // Presented, not derived away: the terms this party hands the partner at
      // the terms exchange hold the value the operator set.
      expect(prepared.linkageTerms.deduplicate).toBe(true);
      // And the binding on the PARTNER's value stays the invitation's own
      // declaration, so this party's choice binds the inviter to nothing.
      expect(prepared.expectedPartnerDeduplicate).toBe(declared);
    },
  );
});
