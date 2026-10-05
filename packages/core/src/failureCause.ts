// The catalog of failure causes every front end names the same way. Core holds
// the facts and one plain sentence per cause saying what happened; each app
// binds its own remedy (a CLI flag, a console control) through a total map
// keyed on FailureCauseKind, so a cause added here fails to compile in an app
// that has no remedy for it. No flag, control or command name belongs here.

import { formatCount } from "./utils/formatCount";

/** Every {@link PartnerMeetingChannel}. */
export const PARTNER_MEETING_CHANNELS = ["filedrop", "sftp", "webrtc"] as const;

/** Where the two parties were to meet when a partner did not arrive. */
export type PartnerMeetingChannel = (typeof PARTNER_MEETING_CHANNELS)[number];

/**
 * The display cap on a path a failure cause states: Linux's `PATH_MAX`, so a
 * deep path is not cut at the per-value default.
 */
export const FAILURE_CAUSE_PATH_MAX_LENGTH = 4096;

/** Every {@link FolderMissingCode}. */
export const FOLDER_MISSING_CODES = ["ENOENT", "ENOTDIR"] as const;

/** The errno codes a missing or unusable shared folder is reported under. */
export type FolderMissingCode = (typeof FOLDER_MISSING_CODES)[number];

/** The network error codes under which no connection to a relay registrar was made. */
export const RELAY_REGISTRAR_NO_CONNECTION_CODES = [
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
] as const;

/** The network error codes under which a relay registrar's host name did not resolve. */
export const RELAY_REGISTRAR_NAME_NOT_RESOLVED_CODES = [
  "ENOTFOUND",
  "EAI_AGAIN",
] as const;

/**
 * Why a relay registrar did not answer, by class:
 *
 * - `no-connection`: no connection to its host and port was made;
 * - `name-not-resolved`: its host name did not resolve to an address;
 * - `no-answer`: the connection was reset, or the request timed out, before
 *   it answered.
 */
export type RelayRegistrarUnreachableFailure =
  | {
      readonly failure: "no-connection";
      readonly code: (typeof RELAY_REGISTRAR_NO_CONNECTION_CODES)[number];
    }
  | {
      readonly failure: "name-not-resolved";
      readonly code: (typeof RELAY_REGISTRAR_NAME_NOT_RESOLVED_CODES)[number];
    }
  | { readonly failure: "no-answer"; readonly code: "ECONNRESET" }
  | {
      readonly failure: "no-answer";
      /** The request's timeout, which ran out with no answer. */
      readonly timedOutMs: number;
    };

/**
 * A failure whose cause the catalog names. Members hold facts only: a channel,
 * a path, an errno code, a duration. A path is composed into the sentence raw
 * and escaped where the message is shown, like every other error fragment.
 */
export type FailureCause =
  | {
      /** The partner did not arrive before this party stopped waiting. */
      readonly kind: "partner-never-arrived";
      /** Unset when the raise site cannot tell; the sentence then names no place. */
      readonly channel?: PartnerMeetingChannel;
      /** How long this party waited, when the raise site knows it. */
      readonly waitedMs?: number;
    }
  | {
      /** The shared folder named for a file-drop exchange is not usable. */
      readonly kind: "folder-missing";
      readonly path: string;
      /** `ENOENT`: nothing at the path. `ENOTDIR`: something that is not a folder. */
      readonly code: FolderMissingCode;
    }
  | ({
      /** The relay registrar did not answer, for the reason `failure` names. */
      readonly kind: "relay-registrar-unreachable";
      readonly host: string;
      readonly port: number;
    } & RelayRegistrarUnreachableFailure);

/** The discriminant of {@link FailureCause}. */
export type FailureCauseKind = FailureCause["kind"];

/** The {@link FailureCause} member whose kind is `K`. */
export type FailureCauseOfKind<K extends FailureCauseKind> = Extract<
  FailureCause,
  { kind: K }
>;

/**
 * Every {@link FailureCauseKind}: the allowlist a consumer of a cause read
 * from outside this process checks the kind against
 * ({@link failureCauseFromUntrusted}).
 */
export const FAILURE_CAUSE_KINDS = [
  "partner-never-arrived",
  "folder-missing",
] as const satisfies ReadonlyArray<FailureCauseKind>;

const FAILURE_CAUSE_TAG = "alcoveFailureCause";

/**
 * Attach `cause` to `error` as a property tag, leaving its message and class
 * alone, so the exit-code classification that reads the class is unchanged.
 */
export function markFailureCause<E extends object>(
  error: E,
  cause: FailureCause,
): E {
  return Object.assign(error, { [FAILURE_CAUSE_TAG]: cause });
}

/**
 * The cause {@link markFailureCause} attached to `error` or to the nearest link
 * of its `cause` chain that has one, else `undefined`.
 */
export function failureCauseOf(error: unknown): FailureCause | undefined {
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  while (typeof cursor === "object" && cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const tagged = (cursor as Record<string, unknown>)[FAILURE_CAUSE_TAG];
    if (typeof tagged === "object" && tagged !== null)
      return tagged as FailureCause;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

const oneOf = <T extends string>(
  allowed: ReadonlyArray<T>,
  value: unknown,
): value is T => typeof value === "string" && allowed.includes(value as T);

const FROM_UNTRUSTED: {
  readonly [K in FailureCauseKind]: (
    fields: Record<string, unknown>,
  ) => FailureCauseOfKind<K> | undefined;
} = {
  "partner-never-arrived": ({ channel, waitedMs }) => {
    if (channel !== undefined && !oneOf(PARTNER_MEETING_CHANNELS, channel))
      return undefined;
    if (
      waitedMs !== undefined &&
      (typeof waitedMs !== "number" ||
        !Number.isSafeInteger(waitedMs) ||
        waitedMs < 0)
    )
      return undefined;
    return {
      kind: "partner-never-arrived",
      ...(channel !== undefined ? { channel } : {}),
      ...(waitedMs !== undefined ? { waitedMs: waitedMs as number } : {}),
    };
  },
  "folder-missing": ({ path, code }) =>
    typeof path === "string" && oneOf(FOLDER_MISSING_CODES, code)
      ? { kind: "folder-missing", path, code }
      : undefined,
};

/**
 * `value` as a {@link FailureCause} when it is one -- its `kind` on
 * {@link FAILURE_CAUSE_KINDS} and every fact that kind holds of the type and
 * value set the catalog declares -- rebuilt from those facts alone, else
 * `undefined`. A string fact is returned as it arrived: the caller escapes it
 * where it shows it.
 */
export function failureCauseFromUntrusted(
  value: unknown,
): FailureCause | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const fields = value as Record<string, unknown>;
  if (!oneOf(FAILURE_CAUSE_KINDS, fields.kind)) return undefined;
  return FROM_UNTRUSTED[fields.kind](fields);
}

/**
 * A wait as a count and a unit, in the largest whole unit that states it
 * exactly -- hours, then minutes, else seconds with any fraction kept -- the
 * count grouped by {@link formatCount}: "1 hour", "90 seconds", "0.15 seconds".
 */
export function formatWaitDuration(ms: number): string {
  const [count, unit] =
    ms > 0 && ms % 3_600_000 === 0
      ? [ms / 3_600_000, "hour"]
      : ms > 0 && ms % 60_000 === 0
        ? [ms / 60_000, "minute"]
        : [ms / 1000, "second"];
  return `${formatCount(count)} ${unit}${count === 1 ? "" : "s"}`;
}

const MEETING_PLACE: Record<PartnerMeetingChannel | "unknown", string> = {
  filedrop: "arrive in the shared folder",
  sftp: "arrive in the shared folder on the SFTP server",
  webrtc: "connect",
  unknown: "arrive",
};

function relayRegistrarUnreachableSentence(
  cause: FailureCauseOfKind<"relay-registrar-unreachable">,
): string {
  const { host, port } = cause;
  if (cause.failure === "name-not-resolved")
    return `The relay registrar's host name ${host} did not resolve to an address (${cause.code}).`;
  const at = `The relay registrar at ${host} port ${port}`;
  if (cause.failure === "no-connection")
    return `${at} could not be reached (${
      cause.code === "UND_ERR_CONNECT_TIMEOUT"
        ? "connection timed out"
        : cause.code
    }).`;
  return "timedOutMs" in cause
    ? `${at} did not answer within ${formatWaitDuration(cause.timedOutMs)}.`
    : `${at} closed the connection without answering (${cause.code}).`;
}

const SENTENCES: {
  readonly [K in FailureCauseKind]: (cause: FailureCauseOfKind<K>) => string;
} = {
  "partner-never-arrived": ({ channel, waitedMs }) =>
    `Your partner did not ${MEETING_PLACE[channel ?? "unknown"]} ` +
    (waitedMs === undefined
      ? "in the time this run waited."
      : `within ${formatWaitDuration(waitedMs)}.`),
  "folder-missing": ({ path, code }) =>
    code === "ENOENT"
      ? `The shared folder ${path} does not exist (ENOENT).`
      : `The shared folder path ${path} does not name a folder (ENOTDIR).`,
  "relay-registrar-unreachable": relayRegistrarUnreachableSentence,
};

/**
 * The one sentence stating what happened for `cause`: plain ASCII words ending
 * in a period, with the errno code in parentheses where there is one. It names
 * no flag or control; the app appends its own remedy.
 */
export function failureCauseSentence(cause: FailureCause): string {
  return (SENTENCES[cause.kind] as (c: FailureCause) => string)(cause);
}

/**
 * An `Error` whose message is {@link failureCauseSentence} of `cause`, tagged
 * with it by {@link markFailureCause}.
 */
export function failureCauseError(cause: FailureCause): Error {
  return markFailureCause(new Error(failureCauseSentence(cause)), cause);
}
