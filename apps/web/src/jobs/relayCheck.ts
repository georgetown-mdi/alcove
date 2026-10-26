import crypto from "node:crypto";

import {
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  INVITATION_RELAY_ENROLLMENT_WAIT_MS,
  RELAY_CHECK_BOUND_MS,
  parseBoundedJson,
  relayCheckHeadline,
  relayCheckPlan,
  relayHostStatement,
  sanitizeForDisplay,
  selectRunRelay,
} from "@alcove/core";
import {
  DOCTOR_FINDINGS_EXIT_CODE,
  USAGE_EXIT_CODE,
} from "@alcove/cli-contract";

import { JOB_FILE_NAMES } from "@jobContract/intentSchemas";

import {
  ConfigurationLoadRefusedError,
  mountedExchangeDocument,
} from "./configLoad";
import { mountedKeyFileFault } from "./mountedKeyFile";
import { resolveWorkdirFile } from "./workdir";
import { runCapturedCliChild } from "./capturedCliChild";

import type {
  RelayCheckFields,
  RelayHostStatement,
  RelayTransport,
} from "@alcove/core";

import type { CapturedChildStop } from "./capturedCliChild";

/**
 * The console's relay check driver. It spawns the CLI's `doctor relay --json`
 * against the working folder's `alcove.yaml` and `.alcove.key` -- the files a
 * run of the exchange uses -- so the check asks the relay from where the run
 * connects. Before the spawn, the console states the hosts the check
 * contacts, from core's plan of the same file ({@link relayCheckOffer}); the
 * child's own statement goes to its stderr, which is discarded.
 *
 * Every verdict field is re-validated at this boundary: the check id, the
 * statuses, the transport, and the lapse against closed sets; each check's
 * headline composed by core's `relayCheckHeadline` from those fields, and it
 * and the `meaning` and `action` escaped and bounded. A url or a registrar
 * can come from the partner's invitation, so none crosses unescaped.
 * Contract: docs/spec/SERVER_JOB_API.md, Checking the relay.
 */

/**
 * The server-side watchdog: SIGTERM the child at this point, above the
 * check's own request bound plus its enrollment's wait, with room for the
 * child to start and load the configuration; SIGKILL after a grace. A
 * watchdog kill is reported as a `timeout`.
 */
export const RELAY_CHECK_SIGTERM_MS = 45_000;
/** The grace before the watchdog escalates SIGTERM to SIGKILL. */
const RELAY_CHECK_SIGKILL_GRACE_MS = 5_000;

/** What the child spends before the watchdog has cause to stop it. */
export const RELAY_CHECK_CHILD_BUDGET_MS =
  RELAY_CHECK_BOUND_MS + INVITATION_RELAY_ENROLLMENT_WAIT_MS;

/**
 * The cap on the verdict line, in UTF-16 code units: one check per TURN url
 * the configuration lists, each with its url, `meaning` and `action`. A
 * configuration whose verdict is longer is reported as an `error`.
 */
export const RELAY_CHECK_STDOUT_CAP = 65_536;

/** The most checks one verdict is read with. */
const MAX_RELAY_CHECKS = 256;

/** The display bound on each line that crosses to the browser. */
export const RELAY_CHECK_TEXT_MAX_DISPLAY_LENGTH =
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH;

/** The status of one check, as the CLI's verdict states it. */
export type RelayCheckStatus = "ok" | "warn" | "fail" | "skipped";

/** One check as the browser is given it: every string escaped and bounded. */
export interface RelayCheckLine {
  id: string;
  status: RelayCheckStatus;
  headline: string;
  meaning?: string;
  action?: string;
}

/**
 * How a relay check ended:
 * - `verdict`: the child printed a verdict this boundary accepts.
 * - `refused`: the CLI refused the configuration (exit 64) and contacted
 *   nothing.
 * - `timeout`: the watchdog stopped the child.
 * - `error`: the child exited another way, printed no verdict this boundary
 *   accepts, or could not be spawned.
 */
export type RelayCheckResult =
  | {
      kind: "verdict";
      overall: "ok" | "fix_and_retry";
      checks: Array<RelayCheckLine>;
    }
  | { kind: "refused" }
  | { kind: "timeout" }
  | { kind: "error" };

/** Why the working folder holds no configuration this check applies to. */
export type RelayCheckUnavailableReason =
  | "no-configuration"
  | "configuration-refused"
  | "not-webrtc"
  | "ice-provision"
  | "no-turn-url"
  | "turn-urls-left-out"
  | "key-file";

/**
 * Whether the working folder's pair can be checked, and the hosts a check of
 * it contacts and does not, escaped and bounded. `configurationDigest`
 * names the `alcove.yaml` the statement is of, so a check started from it
 * runs only while the file is unchanged.
 */
export type RelayCheckOffer =
  | {
      kind: "available";
      configurationDigest: string;
      statement: RelayHostStatement;
      /** Whether a run lists a WebSocket relay, which the check does not ask. */
      websocketRelayNotChecked: boolean;
    }
  | {
      kind: "unavailable";
      reason: RelayCheckUnavailableReason;
      websocketRelayNotChecked?: true;
    };

function shown(text: string): string {
  return sanitizeForDisplay(text, {
    maxLength: RELAY_CHECK_TEXT_MAX_DISPLAY_LENGTH,
  });
}

function shownStatement(statement: RelayHostStatement): RelayHostStatement {
  const entries = (hosts: RelayHostStatement["contacted"]) =>
    hosts.map(({ host, explanation }) => ({
      host: shown(host),
      explanation: explanation.map(shown),
    }));
  return {
    contactedHeading: statement.contactedHeading,
    contacted: entries(statement.contacted),
    ...(statement.notContacted !== undefined && {
      notContacted: {
        heading: statement.notContacted.heading,
        hosts: entries(statement.notContacted.hosts),
      },
    }),
    closing: statement.closing,
  };
}

function configurationDigestOf(source: string): string {
  return crypto.createHash("sha256").update(source).digest("hex");
}

/**
 * What a relay check of the working folder's pair would contact, read from
 * the `alcove.yaml` there through the schema the CLI loads it with, or why
 * there is nothing to check. Reads the folder and contacts nothing.
 */
export function relayCheckOffer(dataRoot: string): RelayCheckOffer {
  let read: ReturnType<typeof mountedExchangeDocument>;
  try {
    read = mountedExchangeDocument(dataRoot);
  } catch (error) {
    if (error instanceof ConfigurationLoadRefusedError)
      return { kind: "unavailable", reason: "configuration-refused" };
    throw error;
  }
  if (read === null) return { kind: "unavailable", reason: "no-configuration" };
  const { connection } = read.document;
  if (connection.channel !== "webrtc")
    return { kind: "unavailable", reason: "not-webrtc" };
  if (connection.iceProvision !== undefined)
    return { kind: "unavailable", reason: "ice-provision" };
  const { turn, turnLeftOut, websocket } = selectRunRelay(connection);
  const websocketRelayNotChecked = (websocket ?? []).length > 0;
  if ((turn ?? []).length === 0)
    return {
      kind: "unavailable",
      reason: turnLeftOut === undefined ? "no-turn-url" : "turn-urls-left-out",
      ...(websocketRelayNotChecked && { websocketRelayNotChecked: true }),
    };
  if (mountedKeyFileFault(dataRoot) !== undefined)
    return { kind: "unavailable", reason: "key-file" };
  return {
    kind: "available",
    configurationDigest: configurationDigestOf(read.source),
    statement: shownStatement(
      relayHostStatement(relayCheckPlan(connection), connection),
    ),
    websocketRelayNotChecked,
  };
}

const STATUSES: ReadonlySet<string> = new Set([
  "ok",
  "warn",
  "fail",
  "skipped",
]);
const TRANSPORTS: ReadonlySet<string> = new Set(["udp", "tcp", "tls"]);
const CHECK_ID = /^(?:enrollment|turn_[1-9][0-9]{0,3})$/;
const LAPSE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

const STRING_FIELDS = [
  "url",
  "registrar",
  "lapses_at",
  "meaning",
  "action",
] as const;

/** One check of the verdict re-validated, or null where it fails a bound. */
function checkLineOf(value: unknown): RelayCheckLine | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const record = value as Record<string, unknown>;
  const { id, status, transport } = record;
  if (typeof id !== "string" || !CHECK_ID.test(id)) return null;
  if (typeof status !== "string" || !STATUSES.has(status)) return null;
  if (
    transport !== undefined &&
    (typeof transport !== "string" || !TRANSPORTS.has(transport))
  )
    return null;
  const strings: Partial<Record<(typeof STRING_FIELDS)[number], string>> = {};
  for (const key of STRING_FIELDS) {
    const field = record[key];
    if (field === undefined) continue;
    if (typeof field !== "string") return null;
    strings[key] = field;
  }
  const { url, registrar, meaning, action } = strings;
  const lapse = strings.lapses_at;
  if (lapse !== undefined && !LAPSE.test(lapse)) return null;
  const fields: RelayCheckFields = {
    id,
    status: status as RelayCheckStatus,
    ...(url !== undefined && { url }),
    ...(transport !== undefined && { transport: transport as RelayTransport }),
    ...(registrar !== undefined && { registrar }),
    ...(lapse !== undefined && { lapses_at: lapse }),
  };
  const headline = relayCheckHeadline(fields);
  if (headline === undefined) return null;
  return {
    id,
    status: fields.status,
    headline: shown(headline),
    ...(meaning !== undefined && { meaning: shown(meaning) }),
    ...(action !== undefined && { action: shown(action) }),
  };
}

/**
 * Parse and re-validate the child's verdict line against the exit it made:
 * `overall` must be the one the exit code states and the one its checks roll
 * up to. Anything malformed is an `error`, never a partial verdict.
 *
 * @internal exported for testing
 */
export function parseRelayVerdict(
  stdout: string,
  overall: "ok" | "fix_and_retry",
): RelayCheckResult {
  const line = stdout.trim();
  if (line.length === 0) return { kind: "error" };
  let parsed: unknown;
  try {
    parsed = parseBoundedJson(line);
  } catch {
    return { kind: "error" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return { kind: "error" };
  const verdict = parsed as Record<string, unknown>;
  const { checks } = verdict;
  if (
    verdict["version"] !== 1 ||
    verdict["mode"] !== "relay" ||
    verdict["overall"] !== overall ||
    !Array.isArray(checks) ||
    checks.length === 0 ||
    checks.length > MAX_RELAY_CHECKS
  )
    return { kind: "error" };
  const lines: Array<RelayCheckLine> = [];
  for (const check of checks) {
    const checked = checkLineOf(check);
    if (checked === null) return { kind: "error" };
    lines.push(checked);
  }
  const failed = lines.some((check) => check.status === "fail");
  if (failed !== (overall === "fix_and_retry")) return { kind: "error" };
  return { kind: "verdict", overall, checks: lines };
}

/**
 * Reconcile the child's exit: 0 and 78 read the verdict they state, 64 is the
 * CLI's refusal, and any other exit is an `error`. `stdout` is undefined when
 * the read overflowed its cap.
 *
 * @internal exported for testing
 */
export function reconcileRelayCheckExit(
  code: number | null,
  stdout: string | undefined,
): RelayCheckResult {
  if (code === USAGE_EXIT_CODE) return { kind: "refused" };
  if (stdout === undefined) return { kind: "error" };
  if (code === 0) return parseRelayVerdict(stdout, "ok");
  if (code === DOCTOR_FINDINGS_EXIT_CODE)
    return parseRelayVerdict(stdout, "fix_and_retry");
  return { kind: "error" };
}

/**
 * Spawn `doctor relay --json` over the working folder's pair through the
 * shared captured-child boundary and reconcile what it printed. The argv is
 * a fixed template plus the two server-resolved paths; the child runs in the
 * working folder, as `alcove doctor relay` run there does. `stop` ends the
 * child before its watchdog, as server shutdown does.
 */
export async function runRelayCheck(args: {
  dataRoot: string;
  binaryPath: string;
  childEnv?: NodeJS.ProcessEnv;
  sigtermMs?: number;
  sigkillGraceMs?: number;
  stop?: CapturedChildStop;
}): Promise<RelayCheckResult> {
  const configPath = resolveWorkdirFile(args.dataRoot, JOB_FILE_NAMES.config);
  const keyPath = resolveWorkdirFile(args.dataRoot, JOB_FILE_NAMES.key);
  if (configPath === null || keyPath === null) return { kind: "error" };
  const outcome = await runCapturedCliChild({
    argv: [
      args.binaryPath,
      "doctor",
      "relay",
      "--json",
      `--config-file=${configPath}`,
      `--key-file=${keyPath}`,
    ],
    cwd: args.dataRoot,
    ...(args.childEnv !== undefined ? { childEnv: args.childEnv } : {}),
    sigtermMs: args.sigtermMs ?? RELAY_CHECK_SIGTERM_MS,
    sigkillGraceMs: args.sigkillGraceMs ?? RELAY_CHECK_SIGKILL_GRACE_MS,
    stdoutCap: RELAY_CHECK_STDOUT_CAP,
    ...(args.stop !== undefined ? { stop: args.stop } : {}),
  });
  if (outcome.kind === "spawnFailed") return { kind: "error" };
  if (outcome.kind === "timedOut") return { kind: "timeout" };
  return reconcileRelayCheckExit(outcome.code, outcome.stdout);
}
