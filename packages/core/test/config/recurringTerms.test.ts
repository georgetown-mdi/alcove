import { expect, test } from "vitest";

import {
  recurringTermsLackDeclaredReceive,
  termsReceiveNothing,
  withReceiveNothingWhereUnstated,
} from "../../src/config/recurringTerms";
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

test("the default states receive: [] only where the list is missing", () => {
  const sending: LinkageTerms = {
    ...terms,
    payload: { send: [{ name: "enrollment_date" }] },
  };
  expect(withReceiveNothingWhereUnstated(sending).payload).toStrictEqual({
    send: [{ name: "enrollment_date" }],
    receive: [],
  });
  expect(withReceiveNothingWhereUnstated(terms).payload).toStrictEqual({
    receive: [],
  });
  const stated: LinkageTerms = {
    ...terms,
    payload: { receive: [{ name: "case_manager" }] },
  };
  expect(withReceiveNothingWhereUnstated(stated)).toBe(stated);
  const countOnly: LinkageTerms = { ...terms, algorithm: "psi-c" };
  expect(withReceiveNothingWhereUnstated(countOnly)).toBe(countOnly);
});

test("terms receive nothing only under an explicit empty list the partner could send against", () => {
  expect(termsReceiveNothing(withReceiveNothingWhereUnstated(terms))).toBe(
    true,
  );
  expect(termsReceiveNothing(terms)).toBe(false);
  expect(
    termsReceiveNothing({
      ...terms,
      payload: { receive: [{ name: "case_manager" }] },
    }),
  ).toBe(false);
  expect(
    termsReceiveNothing({
      ...terms,
      output: { expectsOutput: false, shareWithPartner: true },
      payload: { receive: [] },
    }),
  ).toBe(false);
});
