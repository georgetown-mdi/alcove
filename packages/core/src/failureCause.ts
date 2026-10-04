// The catalog of failure causes every front end names the same way. Core holds
// the facts and one plain sentence per cause saying what happened; each app
// binds its own remedy (a CLI flag, a console control) through a total map
// keyed on FailureCauseKind, so a cause added here fails to compile in an app
// that has no remedy for it. No flag, control or command name belongs here.

import { formatCount } from "./utils/formatCount";

/** Where the two parties were to meet when a partner did not arrive. */
export type PartnerMeetingChannel = "filedrop" | "sftp" | "webrtc";

/** The errno codes a missing or unusable shared folder is reported under. */
export type FolderMissingCode = "ENOENT" | "ENOTDIR";

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
    };

/** The discriminant of {@link FailureCause}. */
export type FailureCauseKind = FailureCause["kind"];

/** The {@link FailureCause} member whose kind is `K`. */
export type FailureCauseOfKind<K extends FailureCauseKind> = Extract<
  FailureCause,
  { kind: K }
>;

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
