/**
 * The terms an acceptance adopts from an invitation, the comparison of those
 * terms against a configuration that already exists, and the fail-closed
 * record an acceptance writes into that configuration:
 * `expected_partner_deduplicate`.
 *
 * Every entry point takes what it needs as arguments, so any command that
 * records consent to an invitation's terms drives the same derivation and the
 * same write. A lost write of that record disables a check a later
 * `alcove exchange` makes, with no signal at run time, so a caller either
 * lets the write throw or takes {@link writeAcceptanceRecordReportingLoss},
 * which sets the persistence-loss exit code.
 */

import {
  deriveAcceptedLinkageTerms,
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
  token: Pick<InvitationToken, "linkageTerms" | "connectionEndpoint">,
  identity: string,
  ownDeduplicate = false,
): AcceptedInvitationTerms {
  return {
    linkageTerms: deriveAcceptedLinkageTerms(
      token.linkageTerms,
      identity,
      ownDeduplicate,
    ),
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

/** One fail-closed record written in place into an existing configuration. */
export type TermsRecordWrite = {
  record: "expected_partner_deduplicate";
  declared: boolean;
};

/**
 * Write one record into the configuration at `configPath`, keeping the rest
 * of the file as it is. Throws where the file cannot be read, parsed, or
 * written.
 */
export function writeTermsRecord(
  configPath: string,
  write: TermsRecordWrite,
): void {
  persistExpectedPartnerDeduplicate(configPath, write.declared);
}

/**
 * Refresh an acceptance's record in a configuration it keeps. Throws where
 * the write fails.
 */
export function refreshAcceptanceRecords(
  configPath: string,
  records: { expectedPartnerDeduplicate: boolean },
): void {
  writeTermsRecord(configPath, {
    record: "expected_partner_deduplicate",
    declared: records.expectedPartnerDeduplicate,
  });
}

/**
 * What a lost write of the acceptance record leaves in force, for a run that
 * continues past the loss with the configuration it kept.
 */
function acceptanceRecordLossNotice(configPath: string): string {
  return (
    `the exchange continues and the existing configuration at ` +
    `${configPath} stands, but recording the duplicate ` +
    `matching your partner declared in it failed; the next ` +
    `'alcove exchange' holds your partner to the value that ` +
    `configuration already records, and to no value if it records ` +
    `none`
  );
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
    const notice = acceptanceRecordLossNotice(configPath);
    report.log.warn(`${notice}: ${sanitizeErrorForDisplay(err)}`);
    reportPersistenceLoss(notice, report.eventStream);
    return false;
  }
}

/**
 * What applying a verified terms update writes into the configuration it
 * changes (see `persistTermsUpdate`): the terms that update adopts, and the
 * acceptance record an acceptance of the same terms would write -- the
 * partner's declared `deduplicate`.
 */
export function termsUpdateWrite(
  accepted: AcceptedInvitationTerms,
): TermsUpdateWrite {
  return {
    linkageTerms: accepted.linkageTerms,
    expectedPartnerDeduplicate: accepted.expectedPartnerDeduplicate,
  };
}
