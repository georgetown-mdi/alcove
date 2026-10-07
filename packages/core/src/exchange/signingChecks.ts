import { OperatorConfigError, markStatesItsOwnNextStep } from "../errors.js";
import { reasonTermsCannotStateIdentity } from "../config/linkageTermsSchema.js";
import { partnerPinIsPresent } from "../config/signing.js";
import { sendAbort } from "../protocolSetup.js";
import { ReceiptVerificationError } from "../records/signedReceipt.js";
import {
  certificateAuthorizesIdentity,
  computeCertificateFingerprint,
  matchesPinnedFingerprint,
  verifyCertificateSelfSignature,
  withPartnerCertificateCondition,
} from "../records/signingIdentity.js";

import type { LinkageTerms } from "../config/linkageTermsSchema.js";
import type { SigningConfig, SigningMode } from "../config/signing.js";
import type { MessageConnection } from "../connection/messageConnection.js";
import type {
  CertificateBody,
  PartnerCertificateCondition,
  SigningCertificate,
} from "../records/signingIdentity.js";

// The receipt-signing checks an exchange applies: the config gates run before
// it starts, the receipt bindings held at the terms exchange and again at the
// signature swap, and the terms-time resolution of the partner's certificate pin.

/**
 * Refuse a `signing.mode` the exchange has no run path for, before it
 * runs. Allowlists `certificate` (signs and swaps a dual-signed receipt)
 * and `none`; `session-derived` and any other value would otherwise
 * complete the exchange and leave the operator the ordinary unsigned
 * record with no signal that the receipt it asked for was never produced.
 * An {@link OperatorConfigError}: `signing` is always this party's own
 * config, never adopted from the partner.
 */
export function assertSigningModeImplemented(
  mode: SigningMode | undefined,
): void {
  if (mode === undefined || mode === "none" || mode === "certificate") return;
  throw new OperatorConfigError(
    'this signing.mode is not supported: only "certificate" produces a ' +
      'receipt, and "session-derived" is not built. Set signing.mode to ' +
      '"certificate" to sign receipts, or to "none" to run unsigned.',
  );
}

/**
 * Refuse a `certificate`-mode exchange that pins no partner fingerprint and
 * cannot establish one, before it runs. A run that signs in band presents and
 * reads a certificate at the terms exchange, so a first authenticated contact
 * pins there ({@link resolvePartnerCertificateOrAbort}) and needs no pin on
 * file. A run that does not sign in band -- one holding no session key, and so
 * no authenticated setup step to present a certificate on -- has no such
 * route: it would reach a signature swap that rejects unconditionally on an
 * absent pin, after this party's data had crossed, keeping at most the
 * self-attested record of that disclosure
 * ({@link exchangeRecordFromFailure}). An {@link OperatorConfigError}:
 * `signing` is always this party's own config. Scoped to `certificate`
 * mode; `none` and an absent block need no pin.
 *
 * @param signsInBand Whether this run presents and reads a certificate at the
 *   terms exchange, which is the signing identity and session key
 *   {@link runExchange} holds.
 */
export function assertCertificateModePinsPartner(
  signing: SigningConfig | undefined,
  signsInBand: boolean,
): void {
  if (signing?.mode !== "certificate") return;
  if (signsInBand) return;
  if (partnerPinIsPresent(signing.partnerFingerprint)) return;
  throw new OperatorConfigError(
    "this exchange signs receipts (signing.mode: certificate) but has no " +
      "partner fingerprint, and this run cannot get one because it does not " +
      "use an authenticated connection. It would send your data and then " +
      "stop with no result and no receipt, keeping at most the exchange " +
      "record of that disclosure, or nothing where record writing is off. " +
      "Run this exchange over an " +
      "authenticated connection, or ask your partner for the fingerprint " +
      "'alcove fingerprint' prints and set signing.partner_fingerprint, or " +
      'set signing.mode to "none" to run unsigned until you have it.',
  );
}

/**
 * Refuse a `certificate`-mode exchange whose own agreed terms name no
 * party, before it runs. A certificate is trusted by the identity its
 * holder used in the agreed terms, so an unnamed party has nothing for
 * its partner to authorize the certificate against. Held to the resolved
 * `localTerms`, not the identity argument {@link prepareForExchange}
 * takes, since that is what the run puts on the wire. The partner's half
 * is decided at the terms exchange, by
 * {@link assertSignedReceiptNamesBothParties}. An {@link OperatorConfigError}.
 */
export function assertCertificateModeNamesLocalParty(
  signing: SigningConfig | undefined,
  localTerms: LinkageTerms,
): void {
  if (signing?.mode !== "certificate") return;
  if (localTerms.identity !== undefined) return;
  throw new OperatorConfigError(
    "this exchange signs receipts (signing.mode: certificate) but your " +
      "linkage terms name no identity, and a signed receipt names both " +
      "parties. Set linkage_terms.identity to your name, or pass --identity " +
      'where the command takes it, or set signing.mode to "none" to run ' +
      "unsigned.",
  );
}

/**
 * Refuse a run that will sign a receipt when either party's agreed terms
 * hold no identity: a certificate is trusted by the identity its holder
 * used in the agreed terms, so an unnamed party has nothing for the pin to
 * authorize. Called at two points over the same pair -- the terms
 * exchange, before the bootstrap frame or any key or payload moves, and
 * the signature swap itself. A {@link ReceiptVerificationError}: the
 * failing binding may be the partner's, not this party's config. Returns
 * the two names it held to being present.
 */
export function assertSignedReceiptNamesBothParties(
  localTerms: LinkageTerms,
  partnerTerms: LinkageTerms,
): { local: string; partner: string } {
  if (localTerms.identity !== undefined && partnerTerms.identity !== undefined)
    return { local: localTerms.identity, partner: partnerTerms.identity };
  throw new ReceiptVerificationError(
    "a signed receipt names both parties, and " +
      (localTerms.identity === undefined
        ? partnerTerms.identity === undefined
          ? "neither party's agreed terms name an identity"
          : "your agreed terms name none"
        : "your partner's agreed terms name none") +
      ". Set linkage_terms.identity on both sides, or run without receipt " +
      "signing.",
  );
}

/**
 * Refuse a run whose own signing certificate does not authorize the
 * identity in this party's agreed terms: a certificate bound to
 * any other name signs a receipt that verifies nowhere, including its own
 * `verify-receipt`. Applied at the terms exchange, before any linkage key
 * or payload row crosses, and again at the swap
 * ({@link assertReceiptBindingsOrAbort}). An {@link OperatorConfigError},
 * not {@link ReceiptVerificationError}: both disagreeing values are this
 * party's own, nothing partner-controlled. The message names both values,
 * last, after the remedy.
 *
 * A certificate bound to a label a terms document cannot state
 * ({@link reasonTermsCannotStateIdentity}, config/linkageTermsSchema.ts)
 * takes a message of its own: no terms document can name that label, so the
 * remedy above is one its holder cannot perform, and the exit is a re-key
 * under a label the terms admit followed by a re-pin at every partner. It
 * names no part of the label, for the reason that predicate gives.
 */
export function assertLocalCertificateAuthorizesAgreedIdentity(
  certificate: CertificateBody,
  agreedIdentity: string,
): void {
  if (certificateAuthorizesIdentity(certificate, agreedIdentity)) return;
  const unstatable = reasonTermsCannotStateIdentity(certificate.identity);
  if (unstatable !== undefined)
    throw new OperatorConfigError(
      "your signing certificate is bound to a name linkage terms cannot " +
        `hold (${unstatable}), so your partner cannot accept it. Create a ` +
        "new signing identity with 'alcove fingerprint --force --identity' " +
        "under a name linkage_terms.identity can hold, then have every " +
        "partner pin the new fingerprint. The agreed terms name " +
        `"${agreedIdentity}".`,
    );
  throw new OperatorConfigError(
    "your signing certificate is bound to a name other than the identity " +
      "in your agreed linkage terms, so your partner would refuse it. Set " +
      "linkage_terms.identity to the name on the certificate, or sign " +
      "with an identity bound to the name in the agreed terms. The " +
      `certificate is bound to "${certificate.identity}"; the agreed terms ` +
      `name "${agreedIdentity}".`,
  );
}

// The abort reasons the two local receipt bindings send. Fixed literals, as
// every reason on this frame must be (see sendAbort): the frame is a
// disclosure to the partner like any other, so neither names a value.
const UNNAMED_PARTY_ABORT_REASON =
  "a signed receipt names both parties and one side's agreed terms name no " +
  "identity";
const CERTIFICATE_DIVERGENCE_ABORT_REASON =
  "a signing certificate does not authorize the identity its holder agreed " +
  "terms under";

/**
 * Hold the two receipt bindings that follow from the agreed terms alone --
 * both parties named ({@link assertSignedReceiptNamesBothParties}) and
 * this party's own certificate authorizing the name it agreed terms under
 * ({@link assertLocalCertificateAuthorizesAgreedIdentity}) -- sending the
 * partner a best-effort abort before either refusal propagates. Applied at
 * the terms exchange and again at the signature swap, over the same three
 * values, so the two points cannot drift into different predicates or
 * abort reasons. Returns the two names.
 *
 * @internal exported for the swap-side abort test, which cannot reach this
 *   point through `runExchange`: the terms-exchange application refuses
 *   the same inputs first.
 */
export async function assertReceiptBindingsOrAbort(
  conn: MessageConnection,
  localTerms: LinkageTerms,
  partnerTerms: LinkageTerms,
  certificate: CertificateBody,
): Promise<{ local: string; partner: string }> {
  let namedParties: { local: string; partner: string };
  try {
    namedParties = assertSignedReceiptNamesBothParties(
      localTerms,
      partnerTerms,
    );
  } catch (err) {
    await sendAbort(conn, [UNNAMED_PARTY_ABORT_REASON]);
    throw err;
  }
  try {
    assertLocalCertificateAuthorizesAgreedIdentity(
      certificate,
      namedParties.local,
    );
  } catch (err) {
    await sendAbort(conn, [CERTIFICATE_DIVERGENCE_ABORT_REASON]);
    throw err;
  }
  return namedParties;
}

// The abort reason a caller that could not record the pin it adopted sends.
// Outside the refusal table below: the run ends on this party's own failure,
// not on anything the partner presented, and the caller's error is what
// propagates. A fixed literal, as every reason on this frame must be (see
// sendAbort).
const PARTNER_CERTIFICATE_UNRECORDED_ABORT_REASON =
  "a party could not record the fingerprint it pinned on this first contact";

/**
 * The five refusals the terms-time pin resolution raises, by the condition the
 * partner's certificate met, each holding the abort reason its refusal sends
 * the partner and the message it raises to this party's operator.
 *
 * Both are fixed literals holding no byte from the partner's frame. The abort
 * reason reads correctly from either side -- the frame is a disclosure to the
 * partner like any other, so none of them names a fingerprint, a certificate
 * field, or any other value. The message states that the run stopped before
 * any linkage key or payload row was sent, which is what the refusal buys over
 * the same failure at the signature swap, and then names its own next step.
 *
 * Keyed on the vocabulary the swap's own refusals use
 * (PARTNER_CERTIFICATE_MISMATCH_OBSERVED, records/signingIdentity.ts), so one
 * name means one condition wherever it is raised and a key here that no
 * condition matches does not compile. Partial: nothing is pinned yet at the
 * terms exchange, so `unpinned` has no refusal here.
 */
const PARTNER_CERTIFICATE_REFUSALS = {
  unreadable: {
    abortReason:
      "a party presented a signing certificate the wire format does not admit",
    message:
      "your partner presented a signing certificate this version of Alcove " +
      "cannot read. The run stopped before any linkage key or payload row " +
      "was sent. Ask your partner to share an identity made by " +
      "'alcove fingerprint' again, or set signing.mode to \"none\" to run " +
      "unsigned.",
  },
  absent: {
    abortReason:
      "a party signs receipts and its partner presented no signing certificate",
    message:
      "this exchange signs receipts (signing.mode: certificate), but your " +
      "partner presented no signing certificate. The run stopped before any " +
      "linkage key or payload row was sent. Ask your partner to set " +
      'signing.mode to "certificate" with a signing identity of their own, ' +
      'or set signing.mode to "none" to run unsigned.',
  },
  unverified: {
    abortReason:
      "a party presented a signing certificate that does not verify under its own " +
      "key",
    message:
      "your partner's signing certificate does not verify under its own key, " +
      "so nothing was pinned. The run stopped before any linkage key or " +
      "payload row was sent. Ask your partner to share an identity made by " +
      "'alcove fingerprint' again.",
  },
  unauthorizedIdentity: {
    abortReason:
      "a party presented a signing certificate that does not authorize the " +
      "identity its holder agreed terms under",
    message:
      "your partner's signing certificate is bound to a name other than the " +
      "identity in their agreed linkage terms, so nothing was pinned. The " +
      "run stopped before any linkage key or payload row was sent. Ask your " +
      "partner to sign with the certificate bound to the identity in their " +
      "terms, or to set that identity to the name their certificate holds.",
  },
  divergent: {
    abortReason:
      "a party presented a signing certificate that is not the one its partner " +
      "pinned",
    message:
      "your partner's signing certificate is not the one pinned in " +
      "signing.partner_fingerprint. The run stopped before any linkage key " +
      "or payload row was sent, and the pin on file is unchanged. Confirm " +
      "your partner's fingerprint with them directly (they print it with " +
      "'alcove fingerprint'), and if they made a new signing identity, " +
      "replace signing.partner_fingerprint with the new value.",
  },
} as const satisfies Partial<
  Record<PartnerCertificateCondition, { abortReason: string; message: string }>
>;

/**
 * The five terms-time pin refusals by what the partner's certificate did, so a
 * display layer composing its own remedy copy for one of them identifies it
 * from the literal core raised rather than from a fragment of it. The remedies
 * these messages name are configuration-file edits, which is the right
 * instruction for the command line and not one every seat's operator can take.
 *
 * Keyed rather than listed: a consumer's own copy is declared over this union,
 * so a refusal added to the table is a compile error there rather than a case
 * that falls through to the message it cannot act on.
 */
export const PARTNER_CERTIFICATE_REFUSAL_MESSAGES = Object.fromEntries(
  Object.entries(PARTNER_CERTIFICATE_REFUSALS).map(([condition, refusal]) => [
    condition,
    refusal.message,
  ]),
) as {
  [
    K in keyof typeof PARTNER_CERTIFICATE_REFUSALS
  ]: (typeof PARTNER_CERTIFICATE_REFUSALS)[K]["message"];
};

/** `K` unchanged, refusing any key the swap's condition vocabulary does not
 * hold: a projection whose keys widened to `string` fails this constraint,
 * rather than typing a consumer's copy table over `string`. */
type PartnerCertificateConditionKey<K extends PartnerCertificateCondition> = K;

/** Which of the five refusals {@link PARTNER_CERTIFICATE_REFUSAL_MESSAGES}
 * holds: the condition the terms-time pin resolution refused on. */
export type PartnerCertificateRefusalKind = PartnerCertificateConditionKey<
  keyof typeof PARTNER_CERTIFICATE_REFUSAL_MESSAGES
>;

/**
 * Send the partner the abort `condition` calls for and return the refusal to
 * raise for it, marked {@link markStatesItsOwnNextStep} per instance on the
 * convention `TransportPublishIndeterminateError` (`./errors.ts`) states: an
 * error is marked exactly when it holds its own next step, and each of these
 * messages ends in one. The mark suppresses the CLI's generic advisory and lets
 * a display layer show the message instead of fixed copy -- which is what
 * keeps a divergent pin from being reported as an ordinary failed partner
 * check.
 *
 * The mark is per instance rather than on {@link ReceiptVerificationError}: the
 * receipt step raises that class for a signature that does not verify too, and
 * that message prescribes no step of its own.
 *
 * Returning the refusal rather than raising it leaves the `throw` at the call
 * site, so the branch that refused reads whole. The abort goes first and is
 * best effort: the refusal is one-sided, so without that frame a peer deriving
 * no refusal of its own waits out its peer-inactivity budget.
 *
 * The refusal also holds the condition it refused on, on the vocabulary the
 * swap's own refusals use, so one name means one condition at both points. All
 * five fire before this party's payload crosses, so none of them reaches a
 * record build; holding them to the one vocabulary is what keeps that true of
 * the names rather than of where they happen to be raised.
 */
async function refusePartnerCertificate(
  conn: MessageConnection,
  condition: PartnerCertificateRefusalKind,
): Promise<ReceiptVerificationError> {
  const { abortReason, message } = PARTNER_CERTIFICATE_REFUSALS[condition];
  await sendAbort(conn, [abortReason]);
  return withPartnerCertificateCondition(
    markStatesItsOwnNextStep(new ReceiptVerificationError(message)),
    condition,
  );
}

/**
 * Inputs to {@link resolvePartnerCertificateOrAbort}: what the terms exchange
 * read off the partner's envelope, this party's configured pin, and the
 * callback that records a freshly adopted one.
 */
export interface PartnerCertificateResolution {
  /** The partner's presented certificate, shape-validated by the bounded wire
   * schema, or `undefined` when it presented none or presented a value that
   * failed that parse. */
  partnerCertificate: SigningCertificate | undefined;
  /** Whether that value was present on the wire and failed the bounded parse. */
  partnerCertificateMalformed: boolean;
  /** The configured `signing.partner_fingerprint`, absent on a first contact. */
  pinnedFingerprint: string | undefined;
  /** The identity the partner agreed terms under, which a certificate adopted
   * on a first contact has to authorize: the swap verifies the presented
   * certificate against this same name, so a fingerprint pinned against any
   * other one names a party whose receipts this exchange refuses. */
  partnerAgreedIdentity: string;
  /** Called with a freshly adopted fingerprint, at the moment of adoption and
   * before the run goes on. A caller persists the value here rather than after
   * the run, so a run that pins and then fails mid-round does not re-pin blind
   * on the next attempt. A throw stops the run, having sent the partner an
   * abort and disclosed no linkage key or payload row. */
  onPartnerCertificatePinned?: (fingerprint: string) => void;
}

/**
 * Resolve the partner certificate fingerprint this run verifies its receipt
 * against, from the certificate the partner presented on the terms exchange.
 * A configured pin governs when one is on file; otherwise this is the first
 * authenticated contact and the presented certificate's fingerprint is adopted
 * and handed to the caller to record. The resolved value is what the signature
 * swap checks the presented certificate against, so one value governs both
 * points.
 *
 * Five outcomes refuse, each sending the partner a best-effort abort first --
 * the refusal is one-sided, so without the frame a peer deriving no refusal of
 * its own waits out its peer-inactivity budget. A certificate the wire format
 * does not admit, no certificate at all, a certificate that on a first contact
 * either does not verify under its own key or does not authorize the identity
 * the partner agreed terms under, and a certificate diverging from the pin are
 * each a {@link ReceiptVerificationError}: the disagreeing value is the
 * partner's, not this party's config. All five fire at the terms exchange,
 * before the bootstrap frame and before any linkage key or payload row moves.
 *
 * A sixth outcome ends the run without being a refusal of the partner: an
 * `onPartnerCertificatePinned` that throws, which is a caller that could not
 * record the adopted pin. It sends its own abort and propagates the caller's
 * error unchanged.
 *
 * No path overwrites a pin on file: a divergence refuses, leaving the
 * configured value untouched.
 *
 * @returns the fingerprint the signature swap verifies against.
 * @throws {ReceiptVerificationError}
 */
export async function resolvePartnerCertificateOrAbort(
  conn: MessageConnection,
  resolution: PartnerCertificateResolution,
): Promise<string> {
  const { partnerCertificate, pinnedFingerprint } = resolution;
  if (resolution.partnerCertificateMalformed) {
    throw await refusePartnerCertificate(conn, "unreadable");
  }
  if (partnerCertificate === undefined) {
    throw await refusePartnerCertificate(conn, "absent");
  }
  if (partnerPinIsPresent(pinnedFingerprint)) {
    // Constant time over the decoded digest bytes, and a malformed configured
    // pin fails it rather than matching (matchesPinnedFingerprint). The
    // presented certificate's own self-signature is not checked here: the
    // fingerprint covers the body alone, so the swap is where the signature
    // beside that body is weighed.
    if (await matchesPinnedFingerprint(partnerCertificate, pinnedFingerprint))
      return pinnedFingerprint;
    throw await refusePartnerCertificate(conn, "divergent");
  }
  // First authenticated contact. The self-signature is checked before the
  // fingerprint is adopted: a certificate that does not verify under its own
  // key can never sign an acceptable receipt, and adopting its fingerprint
  // would write a pin onto the operator's configuration that no later run
  // could satisfy.
  if (!(await verifyCertificateSelfSignature(partnerCertificate))) {
    throw await refusePartnerCertificate(conn, "unverified");
  }
  // The certificate also has to name the party that agreed these terms: the
  // swap authorizes it against that same name, so adopting the fingerprint of
  // a certificate bound elsewhere would write a pin every later run refuses --
  // this one included, after its keys, payload and receipt had gone out.
  if (
    !certificateAuthorizesIdentity(
      partnerCertificate,
      resolution.partnerAgreedIdentity,
    )
  ) {
    throw await refusePartnerCertificate(conn, "unauthorizedIdentity");
  }
  const adopted = await computeCertificateFingerprint(partnerCertificate);
  try {
    resolution.onPartnerCertificatePinned?.(adopted);
  } catch (err) {
    await sendAbort(conn, [PARTNER_CERTIFICATE_UNRECORDED_ABORT_REASON]);
    throw err;
  }
  return adopted;
}
