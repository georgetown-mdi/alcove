import YAML from "yaml";
import { expect, test } from "vitest";

import {
  payloadReceiveFilledNotice,
  payloadReceiveFillsOnFirstRun,
} from "../../src/config/recurringTerms";
import {
  annotateUnsetPayloadReceive,
  removeUnsetPayloadReceiveNote,
} from "../../src/config/exchangeDocument";
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

test("terms with no payload.receive fill it on the first run", () => {
  expect(payloadReceiveFillsOnFirstRun(terms)).toBe(true);
  expect(
    payloadReceiveFillsOnFirstRun({
      ...terms,
      payload: { send: [{ name: "enrollment_date" }] },
    }),
  ).toBe(true);
});

test("a stated receive list, empty or not, is not filled", () => {
  expect(
    payloadReceiveFillsOnFirstRun({ ...terms, payload: { receive: [] } }),
  ).toBe(false);
  expect(
    payloadReceiveFillsOnFirstRun({
      ...terms,
      payload: { receive: [{ name: "enrollment_date" }] },
    }),
  ).toBe(false);
});

test("terms under which the partner sends this party no payload fill nothing", () => {
  expect(payloadReceiveFillsOnFirstRun({ ...terms, algorithm: "psi-c" })).toBe(
    false,
  );
  expect(
    payloadReceiveFillsOnFirstRun({
      ...terms,
      output: { expectsOutput: false, shareWithPartner: true },
    }),
  ).toBe(false);
});

test("the fill notice names each column escaped, or states that none were declared", () => {
  expect(payloadReceiveFilledNotice(["program", "a\u202eb"])).toContain(
    '"program", "a\\u202eb"',
  );
  expect(payloadReceiveFilledNotice([])).toContain("no payload columns");
});

function documentFor(value: unknown): YAML.Document {
  return new YAML.Document(value);
}

test("an unset receive list is stated at the end of linkage_terms, or of payload", () => {
  const noPayload = documentFor({ linkage_terms: { version: "1.0.0" } });
  annotateUnsetPayloadReceive(noPayload, terms);
  expect(noPayload.toString()).toMatch(
    /version: 1\.0\.0\n {2}# payload\.receive is not set: the first exchange/,
  );

  const withSend = documentFor({
    linkage_terms: { payload: { send: [{ name: "x" }] } },
  });
  annotateUnsetPayloadReceive(withSend, {
    ...terms,
    payload: { send: [{ name: "x" }] },
  });
  expect(withSend.toString()).toMatch(
    /- name: x\n {4}# receive is not set: the first exchange/,
  );
});

test("no note where the terms state a receive list or the fill does not apply", () => {
  for (const stated of [
    { ...terms, payload: { receive: [] } },
    { ...terms, algorithm: "psi-c" as const },
  ]) {
    const doc = documentFor({ linkage_terms: { version: "1.0.0" } });
    annotateUnsetPayloadReceive(doc, stated);
    expect(doc.toString()).not.toContain("#");
  }
});

test("the note is removed once the list is set, and an operator's own comment is kept", () => {
  const doc = documentFor({ linkage_terms: { version: "1.0.0" } });
  annotateUnsetPayloadReceive(doc, terms);
  const reparsed = YAML.parseDocument(doc.toString());
  removeUnsetPayloadReceiveNote(reparsed);
  expect(reparsed.toString()).not.toContain("payload.receive is not set");

  const own = YAML.parseDocument(
    "linkage_terms:\n  version: 1.0.0\n  # my own note\n",
  );
  removeUnsetPayloadReceiveNote(own);
  expect(own.toString()).toContain("# my own note");
});
