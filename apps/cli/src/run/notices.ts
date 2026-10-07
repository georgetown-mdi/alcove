import {
  describeUndeclaredColumns,
  redactPrivateKeyMaterial,
  termsStatingDeclaredPayloadSend,
} from "@alcove/core";
import type { PreparedExchange } from "@alcove/core";

import { raiseInactivityLimit } from "../connection/timeoutGuidance";

/**
 * Operator guidance appended to the file-sync peer-silence timeout error, used
 * when no valid cross-party abort marker (`<id>-abort.json`, armed in the run loop
 * after the handshake) is present to upgrade the failure to a definitive
 * {@link PeerAbortError}. The marker holds no cause and cannot exist for a
 * peer whose exchange directory has gone unwritable (the same condition that
 * stops it writing the marker) or that was hard-killed, so this text states
 * the likely receiver-side causes without naming one as certain, and hedges
 * ("may have") to cover the slow-peer case too. See docs/spec/FILE_SYNC.md
 * ("Sender-side peer-silence attribution"). `limitNamed` is whether the error
 * already names inactivity_timeout_ms.
 */
export const peerSilenceGuidance = (limitNamed: boolean): string =>
  "The peer completed the rendezvous but has sent nothing since. The likely " +
  "cause is on the peer's side: its process may have exited, or its exchange " +
  "directory may have become unwritable (for example a read-only or full " +
  "filesystem, or revoked permissions) -- and a peer that cannot write its " +
  "next message also cannot record why, so this side cannot name the cause. " +
  "Check the peer's own logs for the underlying error. If the peer is instead " +
  `still working on a large dataset, ${raiseInactivityLimit(limitNamed)}.`;

/**
 * Operator guidance replacing {@link peerSilenceGuidance} when the peer hello
 * this run rendezvoused against was already in the folder at entry and nothing
 * has confirmed a live peer behind it since (`unconfirmedEntryPeerHello`).
 *
 * An entry-present hello is byte-identical whether a partner wrote it or an
 * interrupted run in this same folder left it behind, so this text does not
 * accuse the peer's side; it hedges ("may be") and prescribes a re-run before
 * removal, since a partner that died mid-handshake leaves the same shape a
 * merely slow one clears on retry.
 *
 * Kept short, with the filename LAST: this line rides behind the core layer's
 * own peer-silence sentence inside one cause-chain link, and the rendered
 * boundary truncates each link, so every fixed character here is one the
 * filename does not get. The truncation budget is pinned by a test, not
 * asserted here.
 */
export const entryHelloResidueGuidance = (helloName: string): string =>
  "No partner was confirmed; the hello found at start may be left over. " +
  "Re-run; remove only if it persists: " +
  helloName;

/**
 * Operator guidance for a run that swept the shared folder at entry and then
 * timed out waiting for the partner.
 *
 * `--sweep-exchange-files` fires when both operators reach for it at once:
 * the second sweep deletes the first party's live rendezvous files, so each
 * side times out with no mention of sweeping in its own error. The text is
 * identical for both parties and prescribes the same action, so recovering
 * needs no contact between them; it hedges ("appear to have") since only the
 * party that swept first can confirm it, and the prescribed retry is correct
 * even if the timeout had an unrelated cause.
 *
 * Claiming the folder is empty is licensed only for a clean delete-mode
 * timeout: a sweep that could not delete every file, or a retain-mode run
 * that keeps every protocol file it wrote, does not reach this text -- see
 * the gate at the emission site. Operator-facing description:
 * docs/EXCHANGE_REFERENCE.md ("Directory exclusivity").
 */
export const BOTH_SWEPT_GUIDANCE =
  "Both sides appear to have cleared the folder at the same time, removing " +
  "each other's files. The folder should be empty now -- run the exchange " +
  "again on both sides, without --sweep-exchange-files.";

/**
 * Operator guidance for a run that configures a signing identity while record
 * writing is off (`--no-record`).
 *
 * The receipt is bound to its run by a binder the exchange record holds, so a
 * receipt with no record beside it verifies at most `INCOMPLETE` everywhere,
 * forever -- the salts and binder are minted during the exchange and stored
 * nowhere else, so this is only correctable before the run, which is why it
 * fires here rather than at the receipt write.
 *
 * Warns rather than refuses: a receipt kept for its signatures alone is a
 * legitimate use, so the text names both consequences and both ways out (keep
 * the record, or drop the signing block). See docs/CLI.md ("Signing without an
 * exchange record") and docs/spec/EXCHANGE_RECORD.md.
 */
export const SIGNING_WITHOUT_RECORD_WARNING =
  "A signing identity is configured but record writing is off (--no-record). " +
  "This run still writes its signed receipt, and that receipt can never " +
  "verify above INCOMPLETE on any verifier: pairing it to this run needs the " +
  "exchange record, and the record cannot be reconstructed after the " +
  "exchange. Keep the record (drop --no-record) if you retain receipts as " +
  "evidence, or drop the signing block if you do not.";

/**
 * The remedy {@link undeclaredColumnsNotice} ends with on a run that read a
 * configuration: the metadata block of that file.
 */
export const UNDECLARED_COLUMNS_CONFIG_REMEDY =
  "To send one, declare it in the configuration's metadata block with " +
  "is_payload: true; to leave one out without this notice, declare it " +
  "with role: ignored.";

/**
 * The notice naming the input columns this run does not send because its
 * metadata does not declare them, ending with `remedy` (by default
 * {@link UNDECLARED_COLUMNS_CONFIG_REMEDY}), or `undefined` when there are
 * none. Composed raw: the names are the input file's header, escaped once at
 * each sink.
 */
export function undeclaredColumnsNotice(
  prepared: Pick<PreparedExchange, "undeclaredColumns">,
  remedy: string = UNDECLARED_COLUMNS_CONFIG_REMEDY,
): string | undefined {
  return describeUndeclaredColumns(prepared.undeclaredColumns ?? [], remedy);
}

const PAYLOAD_SEND_NOTICE_LISTED_COLUMNS = 10;

/**
 * The notice naming the columns this run states it sends that the
 * configuration's authored `payload.send` does not list, or `undefined` when
 * it lists every one or lists none. The run states its send set from its
 * metadata (`termsStatingDeclaredPayloadSend`), so without this notice a
 * column the configuration never listed reaches the partner unannounced on
 * this side. The remedy precedes the names, so a sink that truncates the
 * message cuts names rather than the remedy. Composed raw: the names are this
 * party's metadata, escaped once at each sink.
 */
export function payloadSendBeyondConfigurationNotice(
  prepared: Pick<PreparedExchange, "linkageTerms" | "metadata">,
): string | undefined {
  const authored = prepared.linkageTerms.payload?.send;
  if (authored === undefined) return undefined;
  const listed = new Set(authored.map(({ name }) => name));
  const beyond = (
    termsStatingDeclaredPayloadSend(prepared.linkageTerms, prepared.metadata)
      .payload?.send ?? []
  )
    .map(({ name }) => name)
    .filter((name) => !listed.has(name));
  if (beyond.length === 0) return undefined;
  const plural = beyond.length > 1;
  const remaining = beyond.length - PAYLOAD_SEND_NOTICE_LISTED_COLUMNS;
  const names =
    beyond
      .slice(0, PAYLOAD_SEND_NOTICE_LISTED_COLUMNS)
      .map(redactPrivateKeyMaterial)
      .join(", ") + (remaining > 0 ? `, and ${remaining} more` : "");
  return (
    `This run tells your partner it sends ${beyond.length} ` +
    `column${plural ? "s" : ""} that payload.send in the configuration does ` +
    `not list, because the metadata sends ${plural ? "them" : "it"}. To ` +
    `record ${plural ? "them" : "it"}, add ${plural ? "them" : "it"} to ` +
    `payload.send and send the change with alcove update. ` +
    `${plural ? "Columns" : "Column"}: ${names}.`
  );
}

/**
 * What a run reports when it disclosed, terminated after that, and owed a
 * self-attested record its build could not produce.
 *
 * Pairs with the completed path's missing-artifact report so a disclosure
 * that occurred is never left with no record and no notice: core warns at
 * the build with the cause, but only on the operator log, which an
 * unattended run discards -- so the machine stream states the fact here too.
 *
 * Names no destination, since nothing reached a write. Not a persistence
 * loss: this run failed and keeps its own exit code rather than the one that
 * tells a supervisor not to re-run.
 */
export const TERMINATED_RECORD_UNBUILT_WARNING =
  "no exchange record could be built for this exchange, so none was written; " +
  "the exchange had already disclosed when it failed, so that disclosure has " +
  "no local record";

/**
 * What the "terms agreed" line adds when the partner named nobody on a run that
 * files an exchange record.
 *
 * A record for a partner that supplied no `linkage_terms.identity` omits
 * `partnerIdentity` rather than inventing one, so it states every other
 * accounting element but not who the other party was -- an absence that is
 * treated as benign unless named here, at the point the operator can still
 * re-run with a named partner instead of finding the gap at audit time.
 *
 * One sentence, no advice about whether to proceed: an unnamed partner is
 * ordinary for a quick, unsigned run, and this fires only where a record is
 * being written. See docs/COMPLIANCE.md (HIPAA considerations).
 */
export const UNNAMED_PARTNER_ACCOUNTING_NOTE =
  "-- this exchange's record will hold no partner name, so an accounting of " +
  "disclosures drawn from it must take the recipient from your own records of " +
  "who this exchange was with.";

/**
 * What the operator is told when a run adopts the partner's certificate on a
 * first authenticated contact. It names the value pinned and the file it went
 * into, says plainly what that pin is authenticated by, and asks for the
 * out-of-band comparison that is the only thing which can strengthen it.
 *
 * The fingerprint is a digest this party derived from the presented
 * certificate, so no partner-authored text reaches the line through it.
 */
export function partnerCertificatePinnedNotice(
  fingerprint: string,
  configPath: string,
): string {
  return (
    "Pinned the partner's signing certificate on this first contact: " +
    `fingerprint ${fingerprint}, recorded as signing.partner_fingerprint in ` +
    `${configPath}. This pin is authenticated by the channel the invitation ` +
    "secret travelled and nothing else, so compare the fingerprint with the " +
    "one your partner's 'alcove fingerprint' prints, over a channel you " +
    "trust. Every later exchange refuses a certificate that does not match it."
  );
}
