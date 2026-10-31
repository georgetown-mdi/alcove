import { describe, expect, test } from "vitest";

import {
  parseSigningConfig,
  safeParseSigningConfig,
} from "../../src/config/signing";
import {
  NEWER_EXCHANGE_FILE_HINT,
  parseExchangeSpec,
  safeParseExchangeSpec,
} from "../../src/config/exchangeSpec";

// A valid 43-character base64url SHA-256 fingerprint (from the checked-in
// signing-cert vectors).
const FINGERPRINT = "iWD-ZB69Oz6gOpaX_OoC7sD8ohIZj2lETC9qbl-IbPg";

describe("parseSigningConfig", () => {
  test("accepts each signing mode", () => {
    for (const mode of ["none", "session-derived", "certificate"] as const) {
      expect(parseSigningConfig({ mode }).mode).toBe(mode);
    }
  });

  test("camelizes snake_case keys from YAML/JSON", () => {
    const cfg = parseSigningConfig({
      mode: "certificate",
      identity_file: "/keys/id.json",
      partner_fingerprint: FINGERPRINT,
    });
    expect(cfg).toEqual({
      mode: "certificate",
      identityFile: "/keys/id.json",
      partnerFingerprint: FINGERPRINT,
    });
  });

  test("rejects an unknown mode", () => {
    expect(safeParseSigningConfig({ mode: "x509" }).success).toBe(false);
  });

  test("rejects a missing mode", () => {
    expect(safeParseSigningConfig({ identity_file: "/k.json" }).success).toBe(
      false,
    );
  });

  test("rejects a fingerprint of the wrong length", () => {
    expect(
      safeParseSigningConfig({
        mode: "certificate",
        partner_fingerprint: FINGERPRINT.slice(0, 42),
      }).success,
    ).toBe(false);
  });

  test("rejects a fingerprint with non-base64url characters", () => {
    expect(
      safeParseSigningConfig({
        mode: "certificate",
        partner_fingerprint: "+".repeat(43),
      }).success,
    ).toBe(false);
  });

  test("rejects a non-canonical last character that decodes to the same digest", () => {
    // The real fingerprint ends in "g"; "h", "i", "j" decode to the same 32
    // bytes (the last char's low 2 bits are unused), so without a canonical
    // constraint they would be accepted as equivalent pins. They must be
    // rejected so the pin string is a 1:1 image of the digest Alcove prints.
    for (const lastChar of ["h", "i", "j"]) {
      const nonCanonical = FINGERPRINT.slice(0, 42) + lastChar;
      expect(
        safeParseSigningConfig({
          mode: "certificate",
          partner_fingerprint: nonCanonical,
        }).success,
      ).toBe(false);
    }
    expect(
      safeParseSigningConfig({
        mode: "certificate",
        partner_fingerprint: FINGERPRINT,
      }).success,
    ).toBe(true);
  });
});

const baseSpec = {
  connection: {
    channel: "filedrop",
    path: "/tmp/drop",
  },
  linkage_terms: {
    version: "1.0.0",
    identity: "Party A",
    date: "2025-01-01",
    algorithm: "psi",
    output: { expects_output: true, share_with_partner: true },
    deduplicate: false,
    linkage_fields: [{ name: "ssn", type: "ssn" }],
    linkage_keys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
  },
};
describe("ExchangeSpec signing block", () => {
  test("parses a spec without a signing block", () => {
    const spec = parseExchangeSpec(baseSpec);
    expect(spec.signing).toBeUndefined();
  });

  test("parses and camelizes a spec with a signing block", () => {
    const spec = parseExchangeSpec({
      ...baseSpec,
      signing: {
        mode: "certificate",
        identity_file: "/run/secrets/alcove-signing-identity.json",
        partner_fingerprint: FINGERPRINT,
      },
    });
    expect(spec.signing).toEqual({
      mode: "certificate",
      identityFile: "/run/secrets/alcove-signing-identity.json",
      partnerFingerprint: FINGERPRINT,
    });
  });
});

describe("signing.receipt_output", () => {
  test.each(["receipt_output", "receiptOutput"])(
    "a spec holding signing.%s is refused as an unrecognized key of the block",
    (key) => {
      const raw = {
        ...baseSpec,
        signing: { mode: "certificate", [key]: "./r.json" },
      };
      const expected = [
        {
          code: "unrecognized_keys",
          path: ["signing"],
          message: `Unrecognized key: "${key}"` + NEWER_EXCHANGE_FILE_HINT,
        },
      ];
      expect(() => parseExchangeSpec(raw)).toThrow();
      const result = safeParseExchangeSpec(raw);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toMatchObject(expected);
    },
  );
});
