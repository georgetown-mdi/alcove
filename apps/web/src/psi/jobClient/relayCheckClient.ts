import {
  MAX_JOB_LISTING_RESPONSE_BYTES,
  MAX_JOB_STATUS_RESPONSE_BYTES,
  isRecord,
  readJsonOrNull,
} from "./jobApiBody";

/**
 * The console's relay check (`GET` and `POST /api/jobs/relay-check`,
 * docs/spec/SERVER_JOB_API.md, Checking the relay): the hosts a check of the
 * working folder's configuration contacts, and the verdict of one. Every
 * string the server sends is already escaped and bounded there, so it is
 * shown as given.
 */

/** One host of the statement, with the lines that explain it. */
export interface RelayCheckHost {
  host: string;
  explanation: Array<string>;
}

/** The hosts a check contacts, then those it does not, as the CLI states them. */
export interface RelayCheckStatement {
  contactedHeading: string;
  contacted: Array<RelayCheckHost>;
  notContacted?: { heading: string; hosts: Array<RelayCheckHost> };
  closing: string;
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

const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  "no-configuration",
  "configuration-refused",
  "not-webrtc",
  "ice-provision",
  "no-turn-url",
  "turn-urls-left-out",
  "key-file",
]);

/** What `GET /api/jobs/relay-check` answered, or `error` for anything else. */
export type RelayCheckOffer =
  | {
      kind: "available";
      configurationDigest: string;
      statement: RelayCheckStatement;
      websocketRelayNotChecked: boolean;
    }
  | {
      kind: "unavailable";
      reason: RelayCheckUnavailableReason;
      websocketRelayNotChecked: boolean;
    }
  | { kind: "error" };

/** The status of one check, as the CLI's verdict states it. */
export type RelayCheckStatus = "ok" | "warn" | "fail" | "skipped";

const STATUSES: ReadonlySet<string> = new Set([
  "ok",
  "warn",
  "fail",
  "skipped",
]);

/** One check of a verdict, its headline composed by core on the server. */
export interface RelayCheckLine {
  id: string;
  status: RelayCheckStatus;
  headline: string;
  meaning?: string;
  action?: string;
}

/**
 * How a started check ended:
 * - `verdict`: the CLI's verdict.
 * - `refused`: the CLI refused the configuration and contacted nothing.
 * - `timeout`: the console stopped a check that ran past its watchdog.
 * - `configuration-changed`: the file changed since its hosts were shown.
 * - `unavailable`: the file is no longer one the check applies to.
 * - `busy`: another check is running.
 * - `exchange-running`: an exchange's child is running over the files.
 * - `error`: anything else, a request that did not complete included.
 */
export type RelayCheckOutcome =
  | {
      kind: "verdict";
      overall: "ok" | "fix_and_retry";
      checks: Array<RelayCheckLine>;
    }
  | { kind: "unavailable"; reason: RelayCheckUnavailableReason }
  | {
      kind:
        | "refused"
        | "timeout"
        | "configuration-changed"
        | "busy"
        | "exchange-running"
        | "error";
    };

function strings(value: unknown): Array<string> | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

function hostsOf(value: unknown): Array<RelayCheckHost> | null {
  if (!Array.isArray(value)) return null;
  const hosts: Array<RelayCheckHost> = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.host !== "string") return null;
    const explanation = strings(item.explanation);
    if (explanation === null) return null;
    hosts.push({ host: item.host, explanation });
  }
  return hosts;
}

function statementOf(value: unknown): RelayCheckStatement | null {
  if (!isRecord(value)) return null;
  const { contactedHeading, closing } = value;
  const contacted = hostsOf(value.contacted);
  if (
    typeof contactedHeading !== "string" ||
    typeof closing !== "string" ||
    contacted === null
  )
    return null;
  if (value.notContacted === undefined)
    return { contactedHeading, contacted, closing };
  if (!isRecord(value.notContacted)) return null;
  const { heading } = value.notContacted;
  const hosts = hostsOf(value.notContacted.hosts);
  if (typeof heading !== "string" || hosts === null) return null;
  return {
    contactedHeading,
    contacted,
    notContacted: { heading, hosts },
    closing,
  };
}

/** Ask the console which hosts a check of the working folder would contact. */
export async function fetchRelayCheckOffer(
  fetchImpl: typeof fetch = fetch,
): Promise<RelayCheckOffer> {
  let response: Response;
  try {
    response = await fetchImpl("/api/jobs/relay-check");
  } catch {
    return { kind: "error" };
  }
  if (!response.ok) return { kind: "error" };
  const body = await readJsonOrNull(response, MAX_JOB_LISTING_RESPONSE_BYTES);
  if (!isRecord(body)) return { kind: "error" };
  const websocketRelayNotChecked = body.websocketRelayNotChecked === true;
  if (body.status === "unavailable")
    return typeof body.reason === "string" &&
      UNAVAILABLE_REASONS.has(body.reason)
      ? {
          kind: "unavailable",
          reason: body.reason as RelayCheckUnavailableReason,
          websocketRelayNotChecked,
        }
      : { kind: "error" };
  const statement = statementOf(body.statement);
  if (
    body.status !== "available" ||
    typeof body.configurationDigest !== "string" ||
    statement === null
  )
    return { kind: "error" };
  return {
    kind: "available",
    configurationDigest: body.configurationDigest,
    statement,
    websocketRelayNotChecked,
  };
}

function checkLineOf(value: unknown): RelayCheckLine | null {
  if (!isRecord(value)) return null;
  const { id, status, headline, meaning, action } = value;
  if (
    typeof id !== "string" ||
    typeof status !== "string" ||
    !STATUSES.has(status) ||
    typeof headline !== "string" ||
    (meaning !== undefined && typeof meaning !== "string") ||
    (action !== undefined && typeof action !== "string")
  )
    return null;
  return {
    id,
    status: status as RelayCheckStatus,
    headline,
    ...(meaning !== undefined && { meaning }),
    ...(action !== undefined && { action }),
  };
}

type PlainOutcome = "refused" | "timeout" | "configuration-changed" | "error";

const PLAIN_OUTCOMES: ReadonlySet<string> = new Set<PlainOutcome>([
  "refused",
  "timeout",
  "configuration-changed",
  "error",
]);

/**
 * Start a check of the working folder's configuration, the one
 * `configurationDigest` names, and wait for its verdict.
 */
export async function startRelayCheck(
  configurationDigest: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RelayCheckOutcome> {
  let response: Response;
  try {
    response = await fetchImpl("/api/jobs/relay-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ configurationDigest }),
    });
  } catch {
    return { kind: "error" };
  }
  if (response.status === 409) {
    const busy = await readJsonOrNull(response, MAX_JOB_STATUS_RESPONSE_BYTES);
    return {
      kind:
        isRecord(busy) && busy.reason === "exchange-running"
          ? "exchange-running"
          : "busy",
    };
  }
  if (!response.ok) return { kind: "error" };
  const body = await readJsonOrNull(response, MAX_JOB_LISTING_RESPONSE_BYTES);
  if (!isRecord(body) || typeof body.status !== "string")
    return { kind: "error" };
  if (body.status === "unavailable")
    return typeof body.reason === "string" &&
      UNAVAILABLE_REASONS.has(body.reason)
      ? {
          kind: "unavailable",
          reason: body.reason as RelayCheckUnavailableReason,
        }
      : { kind: "error" };
  if (body.status !== "verdict")
    return PLAIN_OUTCOMES.has(body.status)
      ? { kind: body.status as PlainOutcome }
      : { kind: "error" };
  if (
    (body.overall !== "ok" && body.overall !== "fix_and_retry") ||
    !Array.isArray(body.checks)
  )
    return { kind: "error" };
  const checks: Array<RelayCheckLine> = [];
  for (const check of body.checks) {
    const line = checkLineOf(check);
    if (line === null) return { kind: "error" };
    checks.push(line);
  }
  return { kind: "verdict", overall: body.overall, checks };
}
