import { z } from "zod";
import { camelizeKeys } from "../utils/camelizeKeys.js";
import { safeParseCamelized } from "./safeParseCamelized.js";

// Signing configuration for exchange receipts: the optional `signing` block of
// alcove.yaml (docs/EXCHANGE_REFERENCE.md, Signing). It contains only
// non-secret references; the signing private key stays out of the config and
// the rotating key file (docs/SECURITY_DESIGN.md).

/**
 * Canonical form of a certificate fingerprint: an unpadded base64url SHA-256
 * digest, exactly 43 characters, so a truncated or mistyped paste fails. The
 * last character is limited to values whose two unused low bits are zero, as
 * `alcove fingerprint` emits them, so the pin is a 1:1 image of the digest.
 */
export const FINGERPRINT_REGEX = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/**
 * Receipt signing mode. Mirrors the two modes in
 * docs/spec/PROTOCOL.md#third-party-verifiable-proof-of-a-data-flow, plus
 * an explicit `none`:
 * - `none` -- no receipt is signed (only the unsigned self-attested record).
 * - `session-derived` -- a MAC under the shared session key: tamper-evident,
 *   not non-repudiation, not third-party verifiable.
 * - `certificate` -- a signature under this party's long-lived signing
 *   identity: the only mode with third-party-verifiable non-repudiation.
 */
export type SigningMode = "none" | "session-derived" | "certificate";

const SigningModeSchema: z.ZodType<SigningMode> = z.enum([
  "none",
  "session-derived",
  "certificate",
]);

/**
 * The `signing` block of an {@link ExchangeSpec}. Paths are local to the party
 * holding the config; `partnerFingerprint`, the one field from the partner, is
 * a public value obtained over a trusted out-of-band channel.
 */
export interface SigningConfig {
  /** Receipt signing mode for this exchange. */
  mode: SigningMode;
  /**
   * Path to this party's signing identity file (private key and self-signed
   * certificate); the CLI resolves no default. Required in `certificate` mode,
   * checked at the CLI's pre-flight so a partially authored config parses.
   * Stored verbatim: a consumer opening it tilde-expands it (`expandTilde`).
   */
  identityFile?: string;
  /**
   * The partner's pinned certificate fingerprint: set in advance from a value
   * exchanged out of band, or recorded at the first authenticated contact. A
   * partner certificate is trusted only if its fingerprint matches this value.
   */
  partnerFingerprint?: string;
}

const SigningConfigSchema: z.ZodType<SigningConfig> = z.object({
  mode: SigningModeSchema,
  identityFile: z.string().min(1).optional(),
  partnerFingerprint: z
    .string()
    .regex(
      FINGERPRINT_REGEX,
      "partner_fingerprint must be an unpadded base64url SHA-256 digest (43 " +
        "characters); obtain it from your partner via 'alcove fingerprint' and " +
        "a trusted out-of-band channel",
    )
    .optional(),
});

/**
 * Schema for the optional `signing` block, embedded by
 * {@link ExchangeSpecSchema}. Field shapes only: `certificate` mode's
 * cross-field requirements are enforced at the pre-exchange gate, so a
 * partially authored config parses.
 */
export { SigningConfigSchema };

/**
 * Whether a partner certificate fingerprint is pinned; its absence marks a
 * first authenticated contact. The one reading that
 * `assertPartnerCertificateTrusted`, `resolvePartnerCertificateOrAbort`,
 * `assertCertificateModePinsPartner` and `assertPartnerFingerprintRecordable`
 * must agree on. An empty string, which {@link FINGERPRINT_REGEX} cannot
 * produce, counts as no pin.
 */
export function partnerPinIsPresent(
  pinnedFingerprint: string | undefined,
): pinnedFingerprint is string {
  return pinnedFingerprint !== undefined && pinnedFingerprint.length > 0;
}

/**
 * Parse and validate a raw value as a {@link SigningConfig}. Snake_case keys are
 * converted to camelCase before validation, so JSON/YAML from disk can be passed
 * directly.
 *
 * @throws {ZodError} if validation fails.
 */
export function parseSigningConfig(raw: unknown): SigningConfig {
  return SigningConfigSchema.parse(camelizeKeys(raw));
}

/**
 * Non-throwing version of {@link parseSigningConfig}. Honors the "safe" contract
 * for the {@link camelizeKeys} bounds too -- see {@link safeParseCamelized}.
 */
export function safeParseSigningConfig(raw: unknown) {
  return safeParseCamelized(SigningConfigSchema, raw);
}
