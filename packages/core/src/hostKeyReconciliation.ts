import { DEFAULT_MAX_DISPLAY_LENGTH } from "./utils/sanitizeForDisplay.js";
import { redactAndFitUnescaped } from "./utils/sanitizeErrorForDisplay.js";
import type { PresentedHostKey } from "./connection/fileSyncConnection.js";

const fittedObservedValue = (value: string): string =>
  redactAndFitUnescaped(value, DEFAULT_MAX_DISPLAY_LENGTH);

/**
 * Compare the two parties' observed SFTP host keys and, on a divergence,
 * return an operator-facing warning naming both observed values; return
 * `undefined` when there is nothing to flag.
 *
 * Each party pins or observes the rendezvous server's host key
 * independently, at different times on different machines, so nothing else
 * compares the two views: a one-sided interception -- one party trusts an
 * attacker's key while the other trusts the real one -- is invisible to
 * both until their fingerprints are reconciled here. Reconciliation rides
 * the authenticated post-handshake terms exchange (see
 * {@link exchangeTerms}), so an unauthenticated party cannot forge the
 * advertised value.
 *
 * Returns `undefined` when either side observed no host key (a file-drop
 * mount, the browser/proxy SFTP path, or an unauthenticated exchange
 * advertises nothing, so a one-sided absence is not a divergence) or when
 * both fingerprints are equal. Otherwise returns a warning naming both
 * observed values and the two honest causes (a server rekey, or a one-sided
 * interception), noting the benign multiple-host-key case when the key
 * types also differ. The check never aborts the exchange -- the threat
 * model is honest-but-curious and the operator disambiguates out-of-band --
 * it only reports the divergence.
 *
 * The fingerprint comparison is plain string equality, not constant-time: a
 * host key and its fingerprint are both public, and the result drives only
 * a warning, not a trust decision.
 *
 * The warning is composed RAW: the caller escapes it once, at the sink that
 * shows it (CONTRIBUTING.md, Operator-facing escaping). Both key types and
 * both fingerprints are still redacted and fitted to the per-value budget
 * before they enter it ({@link redactAndFitUnescaped}) -- the partner's values
 * arrive over the wire under a length bound alone, and a server's key type is
 * server-controlled (see {@link PresentedHostKey.keyType}). That redaction
 * runs ahead of the explanation and the out-of-band-confirm step, so the
 * party this warning is ABOUT cannot delete them with a planted `BEGIN`
 * marker at a sink that redacts whole lines.
 *
 * @param local   This party's observed host key, or `undefined` if none.
 * @param partner The partner's advertised observed host key, or `undefined`.
 */
export function reconcileHostKeyFingerprints(
  local: PresentedHostKey | undefined,
  partner: PresentedHostKey | undefined,
): string | undefined {
  if (local === undefined || partner === undefined) return undefined;
  if (local.fingerprint === partner.fingerprint) return undefined;

  const localFp = fittedObservedValue(local.fingerprint);
  const partnerFp = fittedObservedValue(partner.fingerprint);
  const localType = fittedObservedValue(local.keyType);
  const partnerType = fittedObservedValue(partner.keyType);

  const sameType = local.keyType === partner.keyType;
  const observed = sameType
    ? `Both observed key type '${localType}', but this party observed ` +
      `fingerprint ${localFp} while the partner observed ${partnerFp}.`
    : `This party observed a '${localType}' key with fingerprint ${localFp}, ` +
      `while the partner observed a '${partnerType}' key with fingerprint ` +
      `${partnerFp}.`;

  // A same-type difference cannot be the benign multiple-host-key case (that
  // shows different types), so it is narrowed to rekey-or-interception; a
  // different-type difference adds the benign possibility up front.
  const causes = sameType
    ? `Because the key types match, this is either a server host-key rotation ` +
      `between the two parties' setups or a one-sided interception, in which ` +
      `one party's connection is intercepted while the other reaches the real ` +
      `server.`
    : `Different key types can be benign -- a server that presents multiple ` +
      `host keys may show each party a different one -- but the difference can ` +
      `also be a server host-key rotation between the two parties' setups or a ` +
      `one-sided interception, in which one party's connection is intercepted ` +
      `while the other reaches the real server.`;

  return (
    `WARNING: the two parties observed different SFTP host keys. ${observed} ` +
    `${causes} Confirm the server's current host key out-of-band with both ` +
    `parties before trusting this result; if the key was legitimately rotated, ` +
    `re-pin it on both sides.`
  );
}
