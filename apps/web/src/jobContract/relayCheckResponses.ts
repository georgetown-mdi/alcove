import type {
  RelayCheckFields,
  RelayHostStatement,
  RelayHostStatementEntry,
} from "@alcove/core";

/**
 * The relay check's response types and closed sets, which the console server
 * sends and the browser client accepts (`/api/jobs/relay-check`,
 * docs/spec/SERVER_JOB_API.md, Checking the relay).
 */

/** The status of one check, as the CLI's verdict states it. */
export type RelayCheckStatus = RelayCheckFields["status"];

const STATUS_MEMBERS: Record<RelayCheckStatus, true> = {
  ok: true,
  warn: true,
  fail: true,
  skipped: true,
};

const STATUSES: ReadonlySet<string> = new Set(Object.keys(STATUS_MEMBERS));

/** Whether `value` is a status a verdict's check may have. */
export function isRelayCheckStatus(value: unknown): value is RelayCheckStatus {
  return typeof value === "string" && STATUSES.has(value);
}

/** Why the working folder holds nothing this check applies to. */
export type RelayCheckUnavailableReason =
  | "no-configuration"
  | "configuration-refused"
  | "not-webrtc"
  | "ice-provision"
  | "no-turn-url"
  | "turn-urls-left-out"
  | "key-file";

const REASON_MEMBERS: Record<RelayCheckUnavailableReason, true> = {
  "no-configuration": true,
  "configuration-refused": true,
  "not-webrtc": true,
  "ice-provision": true,
  "no-turn-url": true,
  "turn-urls-left-out": true,
  "key-file": true,
};

const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set(
  Object.keys(REASON_MEMBERS),
);

/** Whether `value` is a reason the check may be unavailable for. */
export function isRelayCheckUnavailableReason(
  value: unknown,
): value is RelayCheckUnavailableReason {
  return typeof value === "string" && UNAVAILABLE_REASONS.has(value);
}

/** One host of the statement, with the lines that explain it. */
export type RelayCheckHost = RelayHostStatementEntry;

/** The hosts a check contacts, then those it does not, as the CLI states them. */
export type RelayCheckStatement = RelayHostStatement;

/** One check of a verdict: every string escaped and bounded by the server. */
export interface RelayCheckLine {
  id: string;
  status: RelayCheckStatus;
  headline: string;
  meaning?: string;
  action?: string;
}
