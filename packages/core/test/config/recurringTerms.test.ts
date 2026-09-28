import { expect, test } from "vitest";

import { recurringTermsLackDeclaredReceive } from "../../src/config/recurringTerms";
import type { LinkageTerms } from "../../src/config/linkageTermsSchema";

const terms: LinkageTerms = {
  version: "1.0.0",
  identity: "Inviting Org",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

test("terms with no payload.receive lack the list a recurring exchange requires", () => {
  expect(recurringTermsLackDeclaredReceive(terms)).toBe(true);
  expect(
    recurringTermsLackDeclaredReceive({
      ...terms,
      payload: { send: [{ name: "enrollment_date" }] },
    }),
  ).toBe(true);
});

test("an explicit empty receive list states receive nothing and satisfies the rule", () => {
  expect(
    recurringTermsLackDeclaredReceive({ ...terms, payload: { receive: [] } }),
  ).toBe(false);
});

test("a non-empty receive list satisfies the rule", () => {
  expect(
    recurringTermsLackDeclaredReceive({
      ...terms,
      payload: { receive: [{ name: "enrollment_date" }] },
    }),
  ).toBe(false);
});

test("terms under which the partner sends this party no payload need no list", () => {
  expect(
    recurringTermsLackDeclaredReceive({ ...terms, algorithm: "psi-c" }),
  ).toBe(false);
  expect(
    recurringTermsLackDeclaredReceive({
      ...terms,
      output: { expectsOutput: false, shareWithPartner: true },
    }),
  ).toBe(false);
});
