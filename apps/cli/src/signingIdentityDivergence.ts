import {
  OperatorConfigError,
  certificateAuthorizesIdentity,
  reasonTermsCannotStateIdentity,
  redactAndDisplayPartyIdentity,
} from "@alcove/core";
import type { CertificateBody } from "@alcove/core";

// Compares the identity a signing certificate is bound to against
// `linkage_terms.identity`, with the partner's own predicate: `alcove exchange`
// refuses a divergence, `alcove fingerprint` warns
// (docs/CLI.md#signing-identity-and-the-agreed-terms,
// docs/CLI.md#the-identity-bound-into-the-certificate).

// The config edit comes first: re-keying invalidates the partner's pin.
const RECONCILE_GUIDANCE =
  "Set linkage_terms.identity to the name the identity is bound to, or " +
  "create a new identity with 'alcove fingerprint --force --identity' " +
  "under the terms identity; a new identity changes your fingerprint, so " +
  "your partner must pin the new one.";

// For a certificate bound to a label the terms cannot state
// (reasonTermsCannotStateIdentity in @alcove/core), where only a re-key helps.
const REKEY_GUIDANCE =
  "Create a new signing identity with 'alcove fingerprint --force " +
  "--identity' under a name linkage_terms.identity can hold, then have " +
  "every partner pin the new fingerprint.";

const DIVERGENCE_CONSEQUENCE =
  "Your partner verifies a receipt against the identity in the agreed terms, " +
  "so they will reject a receipt signed under this certificate, and an " +
  "exchange configured this way is refused before it runs.";

/**
 * Whether `certificate` is bound to an identity other than `termsIdentity`;
 * false when `termsIdentity` is absent or empty.
 */
function divergesFromAgreedTerms(
  certificate: CertificateBody,
  termsIdentity: string | undefined,
): termsIdentity is string {
  if (termsIdentity === undefined || termsIdentity.length === 0) return false;
  return !certificateAuthorizesIdentity(certificate, termsIdentity);
}

/**
 * `alcove fingerprint`'s disposition: warn when
 * {@link divergesFromAgreedTerms}, naming both values and the remedy. A label
 * the terms cannot state is not named. Both values are escaped here, since
 * neither becomes an `Error`.
 */
export function warnOnIdentityDivergence(
  certificate: CertificateBody,
  termsIdentity: string | undefined,
  log: { warn: (message: string) => void },
): void {
  if (!divergesFromAgreedTerms(certificate, termsIdentity)) return;
  const termsLabel = redactAndDisplayPartyIdentity(termsIdentity);
  const unstatable = reasonTermsCannotStateIdentity(certificate.identity);
  if (unstatable !== undefined) {
    log.warn(
      "the signing identity is bound to a label the linkage terms cannot " +
        `state -- ${unstatable} -- so it differs from ` +
        `linkage_terms.identity "${termsLabel}" in the config, and no edit ` +
        "of that field can bring the two into agreement. " +
        `${DIVERGENCE_CONSEQUENCE} ${REKEY_GUIDANCE}`,
    );
    return;
  }
  log.warn(
    `the signing identity is bound to "${redactAndDisplayPartyIdentity(
      certificate.identity,
    )}", which differs from linkage_terms.identity "${termsLabel}" in the ` +
      `config. ${DIVERGENCE_CONSEQUENCE} ${RECONCILE_GUIDANCE}`,
  );
}

/**
 * `alcove exchange`'s disposition: refuse when {@link divergesFromAgreedTerms},
 * as soon as the certificate is loaded and before anything is sent. Both values
 * are the operator's own, composed raw and last so the fixed text survives the
 * renderer's per-link budget
 * (docs/spec/CHANNEL_SECURITY.md#display-sanitization-escape-format).
 *
 * @throws {OperatorConfigError} when the certificate is bound to a different
 *   identity than the run's agreed terms hold.
 */
export function assertIdentityMatchesAgreedTerms(
  certificate: CertificateBody,
  termsIdentity: string | undefined,
): void {
  if (!divergesFromAgreedTerms(certificate, termsIdentity)) return;
  const unstatable = reasonTermsCannotStateIdentity(certificate.identity);
  if (unstatable !== undefined)
    throw new OperatorConfigError(
      "this exchange signs receipts (signing.mode: certificate), but the " +
        "signing identity is bound to a name linkage terms cannot hold " +
        `(${unstatable}), so your partner would refuse the certificate. ` +
        `${REKEY_GUIDANCE} ` +
        `linkage_terms.identity is "${termsIdentity}".`,
    );
  throw new OperatorConfigError(
    "this exchange signs receipts (signing.mode: certificate), but the " +
      "signing identity is bound to a name other than linkage_terms.identity, " +
      "so your partner would refuse the certificate before any data is sent. " +
      `${RECONCILE_GUIDANCE} ` +
      `The certificate is bound to "${certificate.identity}"; ` +
      `linkage_terms.identity is "${termsIdentity}".`,
  );
}
