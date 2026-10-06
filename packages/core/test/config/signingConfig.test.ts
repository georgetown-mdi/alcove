import { describe, expect, test } from "vitest";

import {
  parseSigningConfig,
  retiredSigningSetting,
  retiredSigningSettingNotice,
  safeParseSigningConfig,
} from "../../src/config/signing";
import {
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

describe("retired signing.receipt_output", () => {
  test("a spec holding the key parses, drops it, and draws the notice", () => {
    const raw = {
      ...baseSpec,
      signing: { mode: "certificate", receipt_output: "./r.json" },
    };
    const spec = parseExchangeSpec(raw);
    expect(spec.signing).toEqual({ mode: "certificate" });
    expect(spec.signing).not.toHaveProperty("receiptOutput");
    expect(safeParseExchangeSpec(raw).data?.signing).toEqual({
      mode: "certificate",
    });
    expect(raw.signing).toHaveProperty("receipt_output");
    expect(retiredSigningSetting(raw)).toBe("signing.receipt_output");
    expect(retiredSigningSettingNotice(raw)).toContain(
      '"signing.receipt_output" is ignored',
    );
  });

  test("the camelCase spelling parses and is dropped too", () => {
    const spec = parseExchangeSpec({
      ...baseSpec,
      signing: { mode: "none", receiptOutput: "./r.json" },
    });
    expect(spec.signing).toEqual({ mode: "none" });
  });
});

describe("retiredSigningSettingNotice", () => {
  test("names the receipt path setting and where the receipt goes", () => {
    expect(
      retiredSigningSettingNotice({
        signing: { mode: "certificate", receipt_output: "./r.json" },
      }),
    ).toBe(
      'the setting "signing.receipt_output" is ignored: a signed run writes ' +
        "its receipt into the output folder as alcove-receipt-<time>.json, " +
        "with the same time stamp as the run's result and record. Delete the " +
        "setting from the file.",
    );
  });

  test("names the key as the file spells it", () => {
    expect(
      retiredSigningSettingNotice({
        signing: { mode: "none", receiptOutput: "./r.json" },
      }),
    ).toContain('"signing.receiptOutput"');
  });

  test("is undefined for a file without the setting", () => {
    expect(
      retiredSigningSettingNotice({ signing: { mode: "certificate" } }),
    ).toBeUndefined();
    expect(retiredSigningSettingNotice({})).toBeUndefined();
    expect(retiredSigningSettingNotice({ signing: null })).toBeUndefined();
    expect(retiredSigningSettingNotice(null)).toBeUndefined();
    expect(
      retiredSigningSettingNotice({ receipt_output: "./r.json" }),
    ).toBeUndefined();
  });
});
