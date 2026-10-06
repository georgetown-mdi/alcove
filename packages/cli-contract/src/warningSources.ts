/**
 * The closed vocabulary of `warning` `source` values, naming which of this
 * party's notices raised the warning. Like `type`, every value is this party's
 * own string and none is partner-derived, so a consumer switching on it can
 * tell the cross-party host-key divergence security signal from a routine
 * per-run notice without parsing `message` -- which an unattended supervisor
 * otherwise has to, to decide whether to alert.
 *
 * `persistenceLoss` is the one value tied to an exit code: it is stamped by
 * `reportPersistenceLoss` (apps/cli/src/eventStream.ts), the single call
 * site that also sets `PERSISTENCE_LOSS_EXIT_CODE`, so the source and the
 * code cannot part.
 *
 * docs/spec/CLI_EVENTS.md (Warning sources) is the registry every value is
 * described in, and where a new warning source claims one;
 * scripts/check-warning-sources.mjs fails when the two disagree.
 */
export const WARNING_SOURCES = [
  "termsExchange",
  "hostKeyDivergence",
  "partnerCertificatePinned",
  "unnamedPartnerRecord",
  "resolvedCardinality",
  "pairTableAdvisory",
  "signingWithoutRecord",
  "undeclaredColumns",
  "payloadSendBeyondConfiguration",
  "payloadReceiveTaken",
  "terminatedRunRecord",
  "persistenceLoss",
  "logFileLoss",
  "memoryShortfall",
] as const;

/** One {@link WARNING_SOURCES} value; see that list. */
export type WarningSource = (typeof WARNING_SOURCES)[number];
