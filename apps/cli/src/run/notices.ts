import {
  describeUndeclaredColumns,
  redactPrivateKeyMaterial,
  termsStatingDeclaredPayloadSend,
} from "@alcove/core";
import type { PreparedExchange } from "@alcove/core";

import { raiseInactivityLimit } from "../connection/timeoutGuidance";

/**
 * Guidance appended to the file-sync peer-silence timeout when no abort marker
 * names the failure; it hedges, since this side cannot know the cause:
 * docs/spec/FILE_SYNC.md#sender-side-peer-silence-attribution. `limitNamed` is
 * whether the error already names inactivity_timeout_ms.
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
 * Guidance replacing {@link peerSilenceGuidance} when the peer hello was
 * already in the folder at entry and no live peer has confirmed it since. Such
 * a hello may be left over from an interrupted run here, so the text hedges and
 * prescribes a re-run before removal. Kept short with the filename last: it
 * shares one cause-chain link, which the display truncates.
 */
export const entryHelloResidueGuidance = (helloName: string): string =>
  "No partner was confirmed; the hello found at start may be left over. " +
  "Re-run; remove only if it persists: " +
  helloName;

/**
 * Guidance for a run that swept the shared folder at entry and then timed out
 * waiting for the partner, the result of both sides sweeping at once. Both
 * sides get the same text and action, so recovery needs no contact. Only a
 * clean delete-mode sweep reaches it, since it says the folder is empty:
 * docs/EXCHANGE_REFERENCE.md#directory-exclusivity.
 */
export const BOTH_SWEPT_GUIDANCE =
  "Both sides appear to have cleared the folder at the same time, removing " +
  "each other's files. The folder should be empty now -- run the exchange " +
  "again on both sides, without --sweep-exchange-files.";

/**
 * Warning for a run with a signing identity and `--no-record`: its receipt can
 * never verify above `INCOMPLETE`, which is correctable only before the run.
 * A warning, not a refusal, since a receipt kept for its signatures alone is a
 * legitimate use: docs/CLI.md#signing-without-an-exchange-record.
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
 * The notice naming the columns the metadata sends that the authored
 * `payload.send` does not list, or `undefined` when it lists every one or
 * lists none. The remedy precedes the names, so truncation cuts names first.
 * Composed raw; each sink escapes it.
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
 * The event-stream warning for a run that failed after disclosing and could
 * not build its exchange record. Not a persistence loss: the run keeps its own
 * failure exit code.
 */
export const TERMINATED_RECORD_UNBUILT_WARNING =
  "no exchange record could be built for this exchange, so none was written; " +
  "the exchange had already disclosed when it failed, so that disclosure has " +
  "no local record";

/**
 * What the "terms agreed" line adds on a recorded run whose partner supplied
 * no `linkage_terms.identity`, so the record will name no recipient:
 * docs/COMPLIANCE.md#hipaa-considerations.
 */
export const UNNAMED_PARTNER_ACCOUNTING_NOTE =
  "-- this exchange's record will hold no partner name, so an accounting of " +
  "disclosures drawn from it must take the recipient from your own records of " +
  "who this exchange was with.";

/**
 * The notice for a run that pins the partner's certificate on first contact,
 * asking for an out-of-band fingerprint comparison:
 * docs/CLI.md#pinning-the-partners-certificate. The fingerprint is a digest
 * this party derived, so it contains no partner-authored text.
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
