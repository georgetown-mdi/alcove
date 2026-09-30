import { describe, expect, test } from "vitest";
import { getDefaultLinkageTerms, inferMetadata } from "@alcove/core";

import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";
import { prepareManagedRerunExchange } from "@psi/managed/managedPreparedExchange";

import type { CSVRow } from "@alcove/core";

// The re-run's prepared-exchange assembly, tested in Node: the persisted document's
// own-perspective terms bind to this run's rows, and the terms-side commitment is
// threaded from the record's persisted `expectedPartnerDeduplicate`.

const columns = ["first_name", "last_name", "date_of_birth"];
const rows: Array<CSVRow> = [
  { first_name: "Ada", last_name: "Lovelace", date_of_birth: "12/10/1815" },
];

// The terms a deposit composed from this party's own file: the built-in rule set
// narrowed to the keys these columns support, which is what a re-run's own
// columns then have to satisfy in full.
const standingTerms = (identity: string) =>
  getDefaultLinkageTerms(identity, inferMetadata(columns, []));

function exchangeFile() {
  return composeManagedExchangeFile({
    connection: { channel: "webrtc", host: "signaling.example.org" },
    linkageTerms: standingTerms("County Health Dept"),
  });
}

describe("prepareManagedRerunExchange", () => {
  test("binds the persisted terms to this run's rows and identity", () => {
    const prepared = prepareManagedRerunExchange(exchangeFile(), rows, columns);
    expect(prepared.linkageTerms.identity).toBe("County Health Dept");
    expect(prepared.rowCount).toBe(1);
  });

  test("runs under the terms' own payload.receive", () => {
    // The list the terms exchange compares against the partner's stated send.
    const terms = standingTerms("County Health Dept");
    const receive = [{ name: "shared_id" }, { name: "zip" }];
    const document = composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: { ...terms, payload: { receive } },
    });
    const prepared = prepareManagedRerunExchange(document, rows, columns);
    expect(prepared.linkageTerms.payload?.receive).toEqual(receive);
  });

  test("threads the persisted terms-side commitment onto the prepared exchange", () => {
    // A managed re-run holds no invitation token, so the declaration it binds the
    // inviter to comes from the record's own document. Both booleans: `false` is a
    // real declaration, and the one an inviter would widen away from by presenting
    // `true` at a later re-run's terms exchange.
    for (const declared of [false, true]) {
      const document = composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms: standingTerms("County Health Dept"),
        expectedPartnerDeduplicate: declared,
      });
      const prepared = prepareManagedRerunExchange(document, rows, columns);
      expect(prepared.expectedPartnerDeduplicate).toBe(declared);
    }
  });

  test("a record with no declaration binds nothing", () => {
    // An inviter's record, or one composed from no acceptance: nothing was
    // declared to this party, so the partner's presented value is unconstrained.
    const prepared = prepareManagedRerunExchange(exchangeFile(), rows, columns);
    expect(prepared.expectedPartnerDeduplicate).toBeUndefined();
  });
});
