/**
 * The terms an acceptance adopts from an invitation, the comparison of those
 * terms against a configuration that already exists, and the fail-closed
 * records an acceptance writes into that configuration:
 * `expected_payload_columns` and `expected_partner_deduplicate`.
 *
 * Every entry point takes what it needs as arguments, so any command that
 * records consent to an invitation's terms drives the same derivation and the
 * same writes. A record these writes lose disables a check a later
 * `alcove exchange` makes, with no signal at run time, so a caller either
 * lets the write throw or takes {@link writeAcceptanceRecordReportingLoss},
 * which sets the persistence-loss exit code.
 */

import {
  deriveAcceptedLinkageTerms,
  redactAndRenderOperatorSuppliedText,
  redactAndSanitizeForDisplay,
  operatorSuppliedText,
  sanitizeErrorForDisplay,
} from "@alcove/core";
import type {
  ExchangeSpec,
  InvitationToken,
  LinkageTerms,
  RelayLocator,
} from "@alcove/core";

import {
  diffLinkageTerms,
  linkageTermsStandingOf,
  type TermsUpdateWrite,
  persistExpectedPartnerDeduplicate,
  persistExpectedPayloadColumns,
  warnOnLinkageRuleSetCitationDrift,
  type CitationDriftAlternative,
  type ReconcileDiff,
} from "./config";
import { reportPersistenceLoss, type EventStreamEmitter } from "./eventStream";

/** What an acceptance takes from the invitation it consents to. */
export interface AcceptedInvitationTerms {
  /**
   * This party's linkage terms: the invitation's agreed fields, keys and
   * algorithm, under this party's own identity, with the output direction
   * mirrored (see `deriveAcceptedLinkageTerms` in core).
   */
  linkageTerms: LinkageTerms;
  /**
   * The columns the invitation declared the inviting party sends, recorded as
   * `expected_payload_columns`. Undefined where the invitation declared no
   * disclosed subset, which records no commitment.
   */
  expectedPayloadColumns: string[] | undefined;
  /**
   * The `deduplicate` the invitation declared for the inviting party's own
   * side, recorded as `expected_partner_deduplicate`.
   */
  expectedPartnerDeduplicate: boolean;
  /** The relay the invitation's webrtc endpoint names, if any. */
  invitationRelay: RelayLocator | undefined;
}

/**
 * Derive {@link AcceptedInvitationTerms} from a validated invitation, or a
 * verified terms update, and the identity this party runs under. Throws where
 * core refuses the terms for an acceptor (see `deriveAcceptedLinkageTerms`).
 *
 * `ownDeduplicate` is this party's own side of the cardinality, `false` where
 * omitted: an acceptance offers no control over it, while an applied terms
 * update keeps the value the configuration already holds.
 */
export function deriveAcceptedInvitationTerms(
  token: Pick<
    InvitationToken,
    "linkageTerms" | "disclosedPayloadColumns" | "connectionEndpoint"
  >,
  identity: string,
  ownDeduplicate = false,
): AcceptedInvitationTerms {
  return {
    linkageTerms: deriveAcceptedLinkageTerms(
      token.linkageTerms,
      identity,
      ownDeduplicate,
    ),
    expectedPayloadColumns: token.disclosedPayloadColumns,
    expectedPartnerDeduplicate: token.linkageTerms.deduplicate,
    invitationRelay:
      token.connectionEndpoint?.channel === "webrtc"
        ? token.connectionEndpoint.relay
        : undefined,
  };
}

/**
 * Compare the linkage terms of a configuration already at `configPath`
 * against the terms an acceptance adopts, returning the disagreements that
 * must refuse keeping it. The soft mismatches are logged as warnings.
 *
 * A stale rule-set citation in the kept configuration is reported first,
 * whether or not the terms agree, judged on the file as it stands before this
 * acceptance records itself on it.
 */
export function diffKeptLinkageTerms(params: {
  configPath: string;
  existing: ExchangeSpec;
  accepted: LinkageTerms;
  citationDriftAlternative: CitationDriftAlternative;
  log: { warn: (message: string) => void };
}): ReconcileDiff[] {
  const { configPath, existing, accepted, citationDriftAlternative, log } =
    params;
  warnOnLinkageRuleSetCitationDrift(
    existing.linkageTerms,
    configPath,
    log,
    linkageTermsStandingOf(existing),
    citationDriftAlternative,
  );
  const { conflicts, warnings } = diffLinkageTerms(
    existing.linkageTerms,
    accepted,
  );
  for (const w of warnings) log.warn(w);
  return conflicts;
}

/**
 * The warning an acceptance owes before it removes a recorded
 * `expected_payload_columns` because its invitation declares no disclosed
 * subset, or `undefined` where nothing is removed. Each column name is the
 * partner's, so it is redacted, escaped, and listed one per line.
 */
export function receivedCommitmentRemovalWarning(params: {
  configPath: string;
  recorded: string[] | undefined;
  consented: string[] | undefined;
}): string | undefined {
  const { configPath, recorded, consented } = params;
  if (recorded === undefined || consented !== undefined) return undefined;
  return (
    `this invitation declares no disclosed columns, so accepting it clears ` +
    `the list of columns you previously agreed to receive, recorded in ` +
    `${redactAndRenderOperatorSuppliedText(
      operatorSuppliedText(configPath),
    )}. That list holds the partner's payload to ` +
    (recorded.length === 0
      ? "no columns at all (a strict receive-nothing consent)."
      : "exactly these columns:\n" +
        recorded
          .map((column) => `  - ${redactAndSanitizeForDisplay(column)}`)
          .join("\n")) +
    `\nWithout it the next 'alcove exchange' from this configuration ` +
    `accepts whatever columns the partner transmits. To keep the check, ask ` +
    `the inviting party for an invitation that declares the columns it sends.`
  );
}

/**
 * One fail-closed record written in place into an existing configuration.
 * An undefined value removes the field, except `expected_partner_deduplicate`,
 * which always has a value.
 */
export type TermsRecordWrite =
  | { record: "expected_payload_columns"; columns: string[] | undefined }
  | { record: "expected_partner_deduplicate"; declared: boolean };

/**
 * Write one record into the configuration at `configPath`, keeping the rest
 * of the file as it is. Throws where the file cannot be read, parsed, or
 * written.
 */
export function writeTermsRecord(
  configPath: string,
  write: TermsRecordWrite,
): void {
  switch (write.record) {
    case "expected_payload_columns":
      persistExpectedPayloadColumns(configPath, write.columns);
      return;
    case "expected_partner_deduplicate":
      persistExpectedPartnerDeduplicate(configPath, write.declared);
      return;
  }
}

/**
 * Refresh an acceptance's two records in a configuration it keeps, in order,
 * stopping at the first write that throws.
 */
export function refreshAcceptanceRecords(
  configPath: string,
  records: {
    expectedPayloadColumns: string[] | undefined;
    expectedPartnerDeduplicate: boolean;
  },
): void {
  writeTermsRecord(configPath, {
    record: "expected_payload_columns",
    columns: records.expectedPayloadColumns,
  });
  writeTermsRecord(configPath, {
    record: "expected_partner_deduplicate",
    declared: records.expectedPartnerDeduplicate,
  });
}

/**
 * What a lost write of each acceptance record leaves in force, for a run that
 * continues past the loss with the configuration it kept.
 */
function acceptanceRecordLossNotice(
  configPath: string,
  record: TermsRecordWrite["record"],
): string {
  switch (record) {
    case "expected_payload_columns":
      return (
        `the exchange continues and the existing configuration at ` +
        `${configPath} stands, but recording the columns you ` +
        `consented to receive in it failed; the next 'alcove ` +
        `exchange' holds the received payload to the set that ` +
        `configuration already records, and checks it against no ` +
        `consented set if it records none`
      );
    case "expected_partner_deduplicate":
      return (
        `the exchange continues and the existing configuration at ` +
        `${configPath} stands, but recording the duplicate ` +
        `matching your partner declared in it failed; the next ` +
        `'alcove exchange' holds your partner to the value that ` +
        `configuration already records, and to no value if it records ` +
        `none`
      );
  }
}

/**
 * Write one acceptance record without letting a failure stop the caller: a
 * lost write is logged with its cause, reported on the event
 * stream, and sets the persistence-loss exit code. Returns whether the record
 * was written.
 */
export function writeAcceptanceRecordReportingLoss(
  configPath: string,
  write: TermsRecordWrite,
  report: {
    log: { warn: (message: string) => void };
    eventStream: EventStreamEmitter | undefined;
  },
): boolean {
  try {
    writeTermsRecord(configPath, write);
    return true;
  } catch (err) {
    const notice = acceptanceRecordLossNotice(configPath, write.record);
    report.log.warn(`${notice}: ${sanitizeErrorForDisplay(err)}`);
    reportPersistenceLoss(notice, report.eventStream);
    return false;
  }
}

/**
 * What applying a verified terms update writes into the configuration it
 * changes (see `persistTermsUpdate`): the terms that update adopts, and the
 * acceptance records an acceptance of the same terms would write -- the
 * partner's disclosed columns and declared `deduplicate`.
 */
export function termsUpdateWrite(
  accepted: AcceptedInvitationTerms,
): TermsUpdateWrite {
  return {
    linkageTerms: accepted.linkageTerms,
    expectedPayloadColumns: accepted.expectedPayloadColumns,
    expectedPartnerDeduplicate: accepted.expectedPartnerDeduplicate,
  };
}
