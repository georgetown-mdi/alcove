// Independent generator for test/vectors/receipt-terms-derivation-vectors.json.
//
// Known answers for the values derived from a secret that no other vectors file
// pins: the signed receipt's per-direction payload MAC keys and payload MACs
// (docs/spec/EXCHANGE_RECORD.md, "Receipt content"), and the terms update's
// partnership identifier, MAC key and MAC (docs/spec/EXCHANGE_FILE.md, "Terms
// update").
//
// It imports nothing from packages/core and reuses no Alcove helper: every
// expected value is computed here from fixed input bytes with Node's
// OpenSSL-backed `crypto` (hkdfSync, createHmac), a different code path from the
// module under test, which uses WebCrypto. Each payload's canonical bytes are
// the RFC 8785 text written out below, not the output of Alcove's encoder, so a
// change to either the derivation or the encoding of the MACed bytes moves a
// value Alcove no longer reproduces. receiptTermsDerivationVectors.test.ts runs
// Alcove's own functions on the same inputs and asserts this file's bytes.
//
// Run:  node packages/core/test/vectors/generate-receipt-terms-derivation-vectors.mjs
// It prints the JSON to stdout; redirect into
// receipt-terms-derivation-vectors.json to refresh, then run `npm run format`.

import { createHmac, hkdfSync } from "node:crypto";

const RECEIPT_PAYLOAD_MAC_LABEL = "alcove-signed-receipt-payload-v2";
const RECEIPT_DIRECTIONS = ["initiator-to-responder", "responder-to-initiator"];
const TERMS_UPDATE_LABEL_PREFIX = "alcove-terms-update-v2:";

const hex = (bytes) => Buffer.from(bytes).toString("hex");
// HKDF-SHA-256 with a 32-byte zero salt.
const hkdf = (ikm, info, length) =>
  Buffer.from(
    hkdfSync(
      "sha256",
      ikm,
      Buffer.alloc(32),
      Buffer.from(info, "utf8"),
      length,
    ),
  );
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const counting = (start) =>
  Buffer.from(Array.from({ length: 32 }, (_, i) => start + i));

// --- Receipt payload MACs ----------------------------------------------------

const sessionKey = counting(0x20);

// The canonical form of each committed payload, as RFC 8785 text: members in
// code-point order, no insignificant whitespace, strings as the shortest JSON
// escape. A payload is `{"columns": [...], "rows": [[...]]}`.
const payloadCases = [
  {
    name: "two columns, a missing value and non-ASCII text",
    initiatorToResponder: {
      payload: {
        columns: ["case_id", "outcome"],
        rows: [
          ["A-100", "enrolled"],
          ["A-101", null],
          ["A-102", 'Zoë Müller "quoted" \\ back'],
        ],
      },
      canonicalJson:
        '{"columns":["case_id","outcome"],"rows":[["A-100","enrolled"],' +
        '["A-101",null],["A-102","Zoë Müller \\"quoted\\" \\\\ back"]]}',
    },
    responderToInitiator: {
      payload: { columns: ["case_id"], rows: [["B-7"], ["B-8"]] },
      canonicalJson: '{"columns":["case_id"],"rows":[["B-7"],["B-8"]]}',
    },
  },
  {
    name: "initiator sends nothing, responder sends one row",
    initiatorToResponder: {
      payload: { columns: [], rows: [] },
      canonicalJson: '{"columns":[],"rows":[]}',
    },
    responderToInitiator: {
      payload: { columns: ["status"], rows: [["active"]] },
      canonicalJson: '{"columns":["status"],"rows":[["active"]]}',
    },
  },
];

const directionKeys = Object.fromEntries(
  RECEIPT_DIRECTIONS.map((direction) => [
    direction,
    hkdf(sessionKey, `${RECEIPT_PAYLOAD_MAC_LABEL}:${direction}`, 32),
  ]),
);

const receiptPayloads = payloadCases.map((c) => {
  const macOf = (direction, side) => {
    const bytes = Buffer.from(side.canonicalJson, "utf8");
    // The payload object must be what the canonical text says, so the test
    // feeds Alcove the object and this file the bytes MACed.
    if (JSON.stringify(side.payload) !== side.canonicalJson)
      throw new Error(`${c.name}: payload and canonical text disagree`);
    return {
      payload: side.payload,
      canonicalJson: side.canonicalJson,
      canonicalHex: hex(bytes),
      macHex: hex(hmac(directionKeys[direction], bytes)),
    };
  };
  return {
    name: c.name,
    initiatorToResponder: macOf(
      "initiator-to-responder",
      c.initiatorToResponder,
    ),
    responderToInitiator: macOf(
      "responder-to-initiator",
      c.responderToInitiator,
    ),
  };
});

// --- Terms update ------------------------------------------------------------

const sharedSecret = counting(0x40);
const partnership = hkdf(
  sharedSecret,
  `${TERMS_UPDATE_LABEL_PREFIX}partnership`,
  16,
);
const macKey = hkdf(sharedSecret, `${TERMS_UPDATE_LABEL_PREFIX}mac`, 32);

// A terms update body as the format states it: the member order is the one a
// body is written in, and the MAC covers exactly these bytes.
const termsUpdateBodyText = JSON.stringify({
  kind: "terms-update",
  version: "1",
  partnership: partnership.toString("base64url"),
  linkageTerms: {
    version: "1.0.0",
    identity: "Party A",
    date: "2025-01-01",
    algorithm: "psi",
    linkageStrategy: "single-pass",
    output: { expectsOutput: true, shareWithPartner: true },
    deduplicate: false,
    linkageFields: [
      { type: "ssn", name: "ssn" },
      { type: "last_name", name: "lastName" },
    ],
    linkageKeys: [
      { name: "SSN", elements: [{ field: "ssn" }] },
      { name: "LN", elements: [{ field: "lastName" }] },
    ],
  },
});
const termsUpdateBody = Buffer.from(termsUpdateBodyText, "utf8");

const vector = {
  description:
    "Known-answer vectors for the receipt payload MACs and the terms-update " +
    "partnership identifier, MAC key and MAC. Generated by " +
    "generate-receipt-terms-derivation-vectors.mjs with Node's crypto, from " +
    "fixed inputs and without importing the code under test; held by " +
    "receiptTermsDerivationVectors.test.ts.",
  receiptPayloadMacs: {
    construction: {
      key:
        `HKDF-SHA-256(ikm = session_key, salt = 0x00 * 32, info = ` +
        `"${RECEIPT_PAYLOAD_MAC_LABEL}:" + direction, 32)`,
      mac: "HMAC-SHA-256(key = direction_key, msg = utf8(canonical JSON of the committed payload))",
    },
    label: RECEIPT_PAYLOAD_MAC_LABEL,
    sessionKeyHex: hex(sessionKey),
    directionKeys: RECEIPT_DIRECTIONS.map((direction) => ({
      direction,
      info: `${RECEIPT_PAYLOAD_MAC_LABEL}:${direction}`,
      keyHex: hex(directionKeys[direction]),
    })),
    cases: receiptPayloads,
  },
  termsUpdate: {
    construction: {
      partnership:
        `base64url(HKDF-SHA-256(ikm = shared_secret, salt = 0x00 * 32, info = ` +
        `"${TERMS_UPDATE_LABEL_PREFIX}partnership", 16))`,
      macKey:
        `HKDF-SHA-256(ikm = shared_secret, salt = 0x00 * 32, info = ` +
        `"${TERMS_UPDATE_LABEL_PREFIX}mac", 32)`,
      mac: "HMAC-SHA-256(key = mac_key, msg = utf8(body))",
    },
    labelPrefix: TERMS_UPDATE_LABEL_PREFIX,
    sharedSecretHex: hex(sharedSecret),
    partnershipInfo: `${TERMS_UPDATE_LABEL_PREFIX}partnership`,
    partnershipHex: hex(partnership),
    macKeyInfo: `${TERMS_UPDATE_LABEL_PREFIX}mac`,
    macKeyHex: hex(macKey),
    bodyText: termsUpdateBodyText,
    bodyHex: hex(termsUpdateBody),
    macHex: hex(hmac(macKey, termsUpdateBody)),
  },
};

process.stdout.write(`${JSON.stringify(vector, null, 2)}\n`);
