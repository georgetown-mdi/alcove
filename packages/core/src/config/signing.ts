import { z } from "zod";
import { camelizeKeys } from "../utils/camelizeKeys.js";
import { safeParseCamelized } from "./safeParseCamelized.js";

// Signing configuration for exchange receipts: the optional `signing` block
// on the ExchangeSpec (alcove.yaml); see EXCHANGE_REFERENCE.md. Carries only
// non-secret references -- signing identity file path, receipt mode, and pinned
// partner certificate fingerprint. The signing private key stays out of the
// config and the rotating key file; see docs/SECURITY_DESIGN.md.

/**
 * Canonical form of a certificate fingerprint: an unpadded base64url
 * SHA-256 digest, exactly 43 characters (32 bytes). The stable string a
 * party shares with its partner out-of-band and pins here; the exact
 * length lets a truncated or mistyped paste fail with a clear error.
 *
 * The final character is constrained to the canonical set (base64url
 * values that are a multiple of 4: A E I M Q U Y c g k o s w 0 4 8), since
 * a 43-character base64url string carries 258 bits but a SHA-256 digest is
 * only 256 -- the last character's low 2 bits are unused and zero in what
 * `alcove fingerprint` emits. This keeps the pin string a 1:1 image of the
 * digest and rejects a near-miss paste rather than silently accepting one.
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
 * The `signing` block of an {@link ExchangeSpec}. All paths are local to the
 * party that holds the config; `partnerFingerprint` is the only field that
 * crosses the trust boundary, and it is a public value (a hash of a public
 * certificate) obtained from the partner over a trusted out-of-band channel.
 */
export interface SigningConfig {
  /** Receipt signing mode for this exchange. */
  mode: SigningMode;
  /**
   * Path to this party's signing identity file (private key + self-signed
   * certificate). Owner-read-only; the identity is a credential, so the CLI
   * resolves no path of its own when this is omitted. Optional in shape but
   * required in `certificate` mode -- a cross-field rule enforced at the
   * CLI's certificate-mode pre-flight, not in this schema, so a
   * partially-authored config still parses. Stored verbatim: a leading `~`
   * is not resolved here (a host concern); a consumer that opens this path
   * must tilde-expand it at use time (`expandTilde`), as `alcove
   * fingerprint` does.
   */
  identityFile?: string;
  /**
   * The partner's pinned certificate fingerprint (unpadded base64url
   * SHA-256): set in advance from a value exchanged out of band, or recorded
   * by the first authenticated contact from the certificate the partner
   * presents there. A presented partner certificate is trusted only if its
   * fingerprint matches this value; a later contact whose certificate
   * differs is refused. Long-lived: valid until the partner regenerates its
   * identity.
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
 * Schema for the optional `signing` block, exported so
 * {@link ExchangeSpecSchema} can embed it. Field-shape validation only:
 * `certificate` mode's cross-field requirements -- a pinned partner
 * fingerprint to verify against, an `identity_file` to sign with -- are
 * enforced at the pre-exchange gate instead, so a partially-authored
 * config still parses. `alcove fingerprint`, which needs only
 * `identity_file`, reads it from the raw config text rather than this
 * schema.
 */
export { SigningConfigSchema };

/**
 * Whether a partner certificate fingerprint is pinned at all; its absence
 * is what the terms exchange treats as a first authenticated contact, and
 * what leaves a certificate presented anywhere else untrustable. Shared by
 * four readings that must agree: the verification-time rejection of a
 * certificate against no pin (`assertPartnerCertificateTrusted`), the
 * terms-time resolution deciding between a comparison and an adoption
 * (`resolvePartnerCertificateOrAbort`), the gate refusing a run that can
 * neither pin nor establish one (`assertCertificateModePinsPartner`), and the
 * CLI pre-flight that holds a first contact to a configuration it can record
 * the adopted pin into (`assertPartnerFingerprintRecordable`).
 *
 * An empty string counts as no pin alongside `undefined`: {@link
 * FINGERPRINT_REGEX} cannot produce one, so it arrives only from a
 * {@link SigningConfig} assembled in code, as a pin nobody set.
 */
export function partnerPinIsPresent(
  pinnedFingerprint: string | undefined,
): pinnedFingerprint is string {
  return pinnedFingerprint !== undefined && pinnedFingerprint.length > 0;
}

/** The spellings of the retired receipt-path setting under `signing`. */
const RETIRED_RECEIPT_OUTPUT_FORMS = ["receipt_output", "receiptOutput"];

/**
 * The retired receipt-path setting a raw exchange document's `signing` block
 * still states, as the file writes it (`signing.receipt_output`), or
 * `undefined` when it states none.
 */
export function retiredSigningSetting(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return undefined;
  const signing = (raw as Record<string, unknown>)["signing"];
  if (signing === null || typeof signing !== "object" || Array.isArray(signing))
    return undefined;
  const key = RETIRED_RECEIPT_OUTPUT_FORMS.find((form) =>
    Object.hasOwn(signing, form),
  );
  return key === undefined ? undefined : `signing.${key}`;
}

/**
 * The warning for a file stating the retired receipt-path `setting`, named as
 * the file writes it. The setting is accepted and ignored: a signed run writes
 * its receipt into the output folder under the run's time stamp.
 */
export function retiredSettingNotice(setting: string): string {
  return (
    `the setting "${setting}" is ignored: a signed run writes its ` +
    "receipt into the output folder as alcove-receipt-<time>.json, with the " +
    "same time stamp as the run's result and record. Delete the setting " +
    "from the file."
  );
}

/**
 * The warning for a raw exchange document whose `signing` block still names a
 * receipt path ({@link retiredSettingNotice}), or `undefined` when it names
 * none.
 */
export function retiredSigningSettingNotice(raw: unknown): string | undefined {
  const setting = retiredSigningSetting(raw);
  return setting === undefined ? undefined : retiredSettingNotice(setting);
}

/**
 * A raw exchange document with the retired receipt-path setting removed from
 * its `signing` block, so the whole-file parse accepts a file still holding it
 * instead of refusing it as an unread key; {@link retiredSigningSettingNotice}
 * is the warning that goes with it. Any other value is returned unchanged.
 */
export function withoutRetiredSigningSetting(raw: unknown): unknown {
  if (retiredSigningSetting(raw) === undefined) return raw;
  const document = raw as Record<string, unknown>;
  const signing = Object.fromEntries(
    Object.entries(document["signing"] as Record<string, unknown>).filter(
      ([key]) => !RETIRED_RECEIPT_OUTPUT_FORMS.includes(key),
    ),
  );
  return { ...document, signing };
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
