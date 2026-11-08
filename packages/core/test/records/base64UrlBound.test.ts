import { readFileSync } from "node:fs";

import { expect, test } from "vitest";
import { z } from "zod";

import {
  parseExchangeRecord,
  parseVerificationKeys,
} from "../../src/records/exchangeRecord";
import {
  SIGNED_RECEIPT_VERSION,
  parseDualSignedRecord,
} from "../../src/records/signedReceipt";
import {
  SIGNING_CERTIFICATE_VERSION,
  SigningError,
  boundedWireCertificateSchema,
  parseCertificate,
} from "../../src/records/signingIdentity";

import type {
  ExchangeRecord,
  VerificationKeys,
} from "../../src/records/exchangeRecord";

// Every base64url crypto value a record file or a partner frame holds is held
// to 256 code units at parse, refused with Zod's own length issue. Each case
// varies one field of an otherwise valid document, at the cap and one past it.
const CAP = 256;

const { record: recordVector, keys: keysVector } = (
  JSON.parse(
    readFileSync(
      new URL("../vectors/exchange-record-vectors.json", import.meta.url),
      { encoding: "utf8" },
    ),
  ) as { vectors: Array<{ record: ExchangeRecord; keys: VerificationKeys }> }
).vectors[0];

const HASH = "A".repeat(43);

const certificate = {
  version: SIGNING_CERTIFICATE_VERSION,
  algorithm: "ecdsa-p256-sha256",
  identity: "Party A",
  publicKey: { kty: "EC", crv: "P-256", x: HASH, y: HASH },
  signature: "A".repeat(86),
};

const receipt = {
  version: SIGNED_RECEIPT_VERSION,
  content: {
    termsHash: HASH,
    initiatorToResponderPayload: HASH,
    responderToInitiatorPayload: HASH,
    binder: HASH,
  },
  initiator: { certificate, signature: "A".repeat(86) },
  responder: { certificate, signature: "A".repeat(86) },
};

function issuesThrownBy(parse: () => unknown): Array<z.core.$ZodIssue> {
  try {
    parse();
    return [];
  } catch (error) {
    if (error instanceof z.ZodError) return error.issues;
    throw error;
  }
}

// `document` with the value at `path` replaced by `value`.
function withValueAt(
  document: unknown,
  path: ReadonlyArray<string>,
  value: string,
): unknown {
  const [head, ...rest] = path;
  const object = document as Record<string, unknown>;
  return {
    ...object,
    [head]: rest.length === 0 ? value : withValueAt(object[head], rest, value),
  };
}

type Case = {
  what: string;
  path: ReadonlyArray<string>;
  issues: (document: unknown) => Array<z.core.$ZodIssue>;
  document: unknown;
};

const recordCases: Array<Case> = [
  ["termsHash"],
  ["bindingNonce"],
  ["receiptBinder"],
  ["commitments", "localPayloadSent"],
  ["commitments", "partnerPayloadReceived"],
  ["commitments", "associationTable"],
].map((path) => ({
  what: "the exchange record",
  path,
  document: recordVector,
  issues: (document) => issuesThrownBy(() => parseExchangeRecord(document)),
}));

const keysCases: Array<Case> = [
  ["salts", "localPayloadSent"],
  ["salts", "partnerPayloadReceived"],
  ["salts", "associationTable"],
].map((path) => ({
  what: "the verification keys",
  path,
  document: keysVector,
  issues: (document) => issuesThrownBy(() => parseVerificationKeys(document)),
}));

const receiptCases: Array<Case> = [
  ["content", "termsHash"],
  ["content", "initiatorToResponderPayload"],
  ["content", "responderToInitiatorPayload"],
  ["content", "binder"],
  ["initiator", "signature"],
  ["responder", "signature"],
  ["initiator", "certificate", "publicKey", "x"],
  ["responder", "certificate", "signature"],
].map((path) => ({
  what: "the dual-signed receipt",
  path,
  document: receipt,
  issues: (document) => issuesThrownBy(() => parseDualSignedRecord(document)),
}));

const certificateCases: Array<Case> = [
  ["publicKey", "x"],
  ["publicKey", "y"],
  ["signature"],
].map((path) => ({
  what: "the wire certificate",
  path,
  document: certificate,
  issues: (document) => {
    const result = boundedWireCertificateSchema.safeParse(document);
    return result.success ? [] : result.error.issues;
  },
}));

const CASES = [
  ...recordCases,
  ...keysCases,
  ...receiptCases,
  ...certificateCases,
];

test.each(CASES)(
  "$what admits a base64url value at the cap at $path",
  ({ path, document, issues }) => {
    expect(issues(withValueAt(document, path, "a".repeat(CAP)))).toEqual([]);
  },
);

test.each(CASES)(
  "$what refuses a base64url value one past the cap at $path",
  ({ path, document, issues }) => {
    expect(issues(withValueAt(document, path, "a".repeat(CAP + 1)))).toEqual([
      expect.objectContaining({
        code: "too_big",
        origin: "string",
        maximum: CAP,
        inclusive: true,
        path,
        message: `Too big: expected string to have <=${CAP} characters`,
      }),
    ]);
  },
);

test("an operator's own certificate file is not held to the cap", async () => {
  // The schema an identity file is read under bounds no base64url field, so
  // an over-long coordinate fails as a key, not as a length.
  await expect(
    parseCertificate(
      withValueAt(certificate, ["publicKey", "x"], "a".repeat(CAP + 1)),
    ),
  ).rejects.toBeInstanceOf(SigningError);
});
