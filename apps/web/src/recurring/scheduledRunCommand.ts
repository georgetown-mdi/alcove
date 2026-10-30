import { sanitizeForDisplay } from "@alcove/core";

import {
  shellJoinCommand,
  windowsJoinCommand,
} from "@psi/managed/recurringHandoff";

import {
  CONTAINER_WORK_FOLDER,
  alcoveArgs,
  dockerRunArgv,
  shellJoinRunArgv,
  unmountableBindPaths,
} from "@psi/dockerRunCommand";

import { IMAGE_ACCOUNT_ID, OPERATOR_USER_FLAG } from "@psi/containerAccount";
import { HANDOFF_PATH_PLACEHOLDERS } from "@jobContract/handoffBindPaths";

import {
  cronIntervalGuard,
  cronScheduleFields,
  taskSchedulerLine,
} from "./scheduleTemplates";

import type {
  ScheduledRunSource,
  UnmountableBindPath,
  UnmountableReason,
} from "@psi/dockerRunCommand";
import type { ContainerEngine } from "@psi/containerAccount";
import type { HandoffBindPath } from "@jobContract/handoffBindPaths";
import type { RunSchedule } from "./scheduleTemplates";

/**
 * The command lines the recurring-run hand-offs show -- the console's and the
 * managed exchange's command-line export -- composed from an `alcove` argv:
 * the published image run by `docker` over the operator's exchange folder by
 * default, and an installed `alcove` as the alternative. The `docker run`
 * argv is composed by `@psi/dockerRunCommand`, which the console's copy naming
 * any other command-line step uses too.
 *
 * Every scheduled line names its program by absolute path and appends to a log
 * file, so a scheduled run does not fail to find its program under the
 * scheduler's PATH.
 */

/** The exchange folder placeholder on a POSIX scheduling machine. */
export const EXCHANGE_FOLDER_PLACEHOLDER = "/path/to/your/exchange-folder";

/** The exchange folder placeholder on a Windows scheduling machine. */
const WINDOWS_EXCHANGE_FOLDER_PLACEHOLDER =
  "C:\\path\\to\\your\\exchange-folder";

/** The panels' sentence naming the crontab the cron lines go in. */
export const CRONTAB_ACCOUNT_NOTE =
  "Add a cron line with crontab -e as the account that will run the " +
  "schedule, not with sudo: a line in root's crontab runs Alcove as root.";

/** The sentence on what a POSIX shell still reads inside the double quotes a
 * pasted path or name goes between. */
export const PASTED_TEXT_ESCAPING_NOTE =
  'In a Linux or macOS command, put a \\ before each $, `, \\, or " in a ' +
  "path or name you paste between double quotes.";

/** The sentence on a pasted path's `%` in a cron line, which cron reads as
 * the end of the command ({@link cronLine}). */
export const CRON_PERCENT_NOTE =
  "In a cron line, also write each % in a path as \\%.";

/** The panels' sentence on the Docker lines' account option, for a folder
 * handed to the image's own account. */
export const FOLDER_OWNED_BY_IMAGE_ACCOUNT_NOTE =
  `If the exchange folder belongs to user ${IMAGE_ACCOUNT_ID} (you ran chown ` +
  `${IMAGE_ACCOUNT_ID}:${IMAGE_ACCOUNT_ID} on it), leave out ` +
  `${OPERATOR_USER_FLAG} from the Docker command and cron line.`;

/** Where each engine's client is installed on Linux. */
const POSIX_ENGINE_PROGRAMS: Record<ContainerEngine, string> = {
  docker: "/usr/bin/docker",
  podman: "/usr/bin/podman",
};

/** The installed program's placeholder, for the line that runs it directly. */
export const INSTALLED_ALCOVE_PLACEHOLDER = "/path/to/alcove";

/** The path placeholders a POSIX line names, which the operator replaces. */
const POSIX_PATH_PLACEHOLDERS: ReadonlyArray<string> = [
  EXCHANGE_FOLDER_PLACEHOLDER,
  INSTALLED_ALCOVE_PLACEHOLDER,
  ...HANDOFF_PATH_PLACEHOLDERS,
];

/** Whether a POSIX line's token holds a path placeholder, which is
 * double-quoted so the path the operator puts in its place may hold a space
 * or a single quote. */
function holdsPathPlaceholder(token: string): boolean {
  return POSIX_PATH_PLACEHOLDERS.some((placeholder) =>
    token.includes(placeholder),
  );
}

/** A crontab line running `command` on `schedule` (daily at 2am without
 * one). cron ends a command at an unescaped `%` and passes the rest as its
 * input, so each one the command holds is escaped. */
function cronLine(command: string, schedule: RunSchedule | undefined): string {
  const guarded = cronIntervalGuard(schedule) + command;
  return `${cronScheduleFields(schedule)} ${guarded.replaceAll("%", "\\%")}`;
}

/** The command a person runs once by hand under `engine`: the image over the
 * exchange folder, as the operator's own account, with the engine's program as
 * their shell finds it. Undefined when a bind path cannot be mounted. */
function engineRunCommand(
  source: ScheduledRunSource,
  engine: ContainerEngine,
): string | undefined {
  const argv = dockerRunArgv(source, engine, EXCHANGE_FOLDER_PLACEHOLDER, {
    operatorAccountFor: engine,
  });
  return argv === undefined
    ? undefined
    : shellJoinRunArgv(argv, holdsPathPlaceholder);
}

/** The `docker run` command a person runs once by hand. Undefined when a bind
 * path cannot be mounted. */
export function dockerRunCommand(
  source: ScheduledRunSource,
): string | undefined {
  return engineRunCommand(source, "docker");
}

/** The `podman run` command for rootless Podman, which maps the operator onto
 * the image's account with a user namespace rather than `--user`. Undefined
 * when a bind path cannot be mounted. */
export function podmanRunCommand(
  source: ScheduledRunSource,
): string | undefined {
  return engineRunCommand(source, "podman");
}

/** The command a person runs once by hand from the exchange folder with an
 * installed `alcove`. */
function installedRunCommand({ argv }: ScheduledRunSource): string {
  return shellJoinCommand(
    ["alcove", ...alcoveArgs(argv)],
    () => false,
    holdsPathPlaceholder,
  );
}

/** The crontab line running the image over the exchange folder on
 * `schedule` under `engine`, as the operator's own account. Undefined when a
 * bind path cannot be mounted. */
function engineCronLine(
  source: ScheduledRunSource,
  engine: ContainerEngine,
  schedule: RunSchedule | undefined,
): string | undefined {
  const argv = dockerRunArgv(
    source,
    POSIX_ENGINE_PROGRAMS[engine],
    EXCHANGE_FOLDER_PLACEHOLDER,
    { operatorAccountFor: engine },
  );
  return argv === undefined
    ? undefined
    : cronLine(shellJoinRunArgv(argv, holdsPathPlaceholder), schedule);
}

/** The crontab line running the image with Docker over the exchange folder on
 * `schedule`. Undefined when a bind path cannot be mounted. */
export function dockerCronLine(
  source: ScheduledRunSource,
  schedule?: RunSchedule,
): string | undefined {
  return engineCronLine(source, "docker", schedule);
}

/** The crontab line running the image with rootless Podman over the exchange
 * folder on `schedule`. Undefined when a bind path cannot be mounted. */
export function podmanCronLine(
  source: ScheduledRunSource,
  schedule?: RunSchedule,
): string | undefined {
  return engineCronLine(source, "podman", schedule);
}

/** The crontab line running an installed `alcove` from the exchange folder on
 * `schedule`. */
function installedCronLine(
  { argv }: ScheduledRunSource,
  schedule?: RunSchedule,
): string {
  const join = (tokens: ReadonlyArray<string>) =>
    shellJoinCommand(tokens, () => false, holdsPathPlaceholder);
  return cronLine(
    join(["cd", EXCHANGE_FOLDER_PLACEHOLDER]) +
      " && " +
      join([INSTALLED_ALCOVE_PLACEHOLDER, ...alcoveArgs(argv)]),
    schedule,
  );
}

/**
 * The `docker run` command a person runs once by hand on Windows, which
 * Docker Desktop runs without an account option. It mounts the folder alone,
 * since a Windows path cannot be mounted at the same path inside the
 * container; the panel names each bind path to mount by hand. The mount naming
 * the folder is quoted, so a folder path with a space stays one argument.
 * Undefined when a bind path cannot be mounted.
 */
export function dockerWindowsRunCommand(
  source: ScheduledRunSource,
): string | undefined {
  const argv = dockerRunArgv(
    source,
    "docker",
    WINDOWS_EXCHANGE_FOLDER_PLACEHOLDER,
    { mountBindPaths: false },
  );
  return argv === undefined
    ? undefined
    : windowsJoinCommand(argv, (token) =>
        token.includes(WINDOWS_EXCHANGE_FOLDER_PLACEHOLDER),
      );
}

/** The Task Scheduler registration running the image over the exchange folder
 * ({@link dockerWindowsRunCommand}). Undefined when a bind path cannot be
 * mounted. */
export function dockerTaskSchedulerLine(
  source: ScheduledRunSource,
  schedule?: RunSchedule,
): string | undefined {
  const command = dockerWindowsRunCommand(source);
  return command === undefined
    ? undefined
    : taskSchedulerLine(command, schedule);
}

/**
 * The lines running an invocation, or why none is shown. A bind path holding a
 * control or text-direction character withholds every line, the installed
 * `alcove` ones included, since the operator moves that folder rather than run
 * against a path they cannot read; any other unmountable path withholds the
 * Docker lines alone.
 */
export type RunLines = WithheldRunLines | ShownRunLines;

/** No line is shown ({@link RunLines}). */
export interface WithheldRunLines {
  kind: "withheld";
  /** Why no line is shown, and what to do. */
  notice: string;
}

/** The lines are shown ({@link RunLines}). */
export interface ShownRunLines {
  kind: "shown";
  /** The command running it once on macOS and Linux: the image over the
   * folder, or an installed `alcove` where a path cannot be mounted. */
  runCommand: string;
  /** The image command for Windows, which carries no account option; undefined
   * where a path cannot be mounted. */
  windowsRunCommand: string | undefined;
  /** The one-off command for rootless Podman; undefined where a path cannot
   * be mounted. */
  podmanRunCommand: string | undefined;
  /** Undefined where a path cannot be mounted. */
  dockerCronLine: string | undefined;
  /** The cron line for rootless Podman; undefined where a path cannot be
   * mounted. */
  podmanCronLine: string | undefined;
  /** Undefined where a path cannot be mounted. */
  dockerTaskSchedulerLine: string | undefined;
  installedCronLine: string;
  /** Why the Docker lines are not shown, where a path cannot be mounted. */
  dockerLinesNotice: string | undefined;
}

/** The lines running `source` on `schedule`, or why none is shown. */
export function runLines(
  source: ScheduledRunSource,
  schedule?: RunSchedule,
): RunLines {
  const unmountable = unmountableBindPaths(source.bindPaths);
  if (unmountable.some(({ reason }) => reason === "control"))
    return {
      kind: "withheld",
      notice: unmountableBindPathsNotice(unmountable),
    };
  return {
    kind: "shown",
    runCommand: dockerRunCommand(source) ?? installedRunCommand(source),
    windowsRunCommand: dockerWindowsRunCommand(source),
    podmanRunCommand: podmanRunCommand(source),
    dockerCronLine: dockerCronLine(source, schedule),
    podmanCronLine: podmanCronLine(source, schedule),
    dockerTaskSchedulerLine: dockerTaskSchedulerLine(source, schedule),
    installedCronLine: installedCronLine(source, schedule),
    dockerLinesNotice:
      unmountable.length > 0
        ? unmountableBindPathsNotice(unmountable)
        : undefined,
  };
}

/** The input file the hand-off's command reads, which the panel asks the
 * operator to put in the exchange folder: the positional before the output,
 * less the `./` a name starting with `-` is given. */
export function handoffInputName(argv: ReadonlyArray<string>): string {
  const positional = argv.at(-2) ?? "";
  return positional.startsWith("./-") ? positional.slice(2) : positional;
}

/** What stops the Docker lines mounting a path, as the panel words it. */
const UNMOUNTABLE_REASON_TEXT: Record<UnmountableReason, string> = {
  control:
    "contains a line break, another control character, or a text-direction character, which a scheduled command cannot hold",
  comma: "contains a comma, which a --mount option cannot hold",
  quote: "contains a double quote, which a --mount option cannot hold",
  dots: "is not a plain path: write the path without . or .. segments, repeated slashes, or a trailing slash",
  root: "is the filesystem root, which is too broad to mount",
  workFolder: `is inside ${CONTAINER_WORK_FOLDER}, where the image mounts the exchange folder`,
};

/** The panel's sentence naming each path the lines cannot use and why
 * ({@link RunLines}). */
export function unmountableBindPathsNotice(
  unmountable: ReadonlyArray<UnmountableBindPath>,
): string {
  const named = unmountable
    .map(
      ({ path, reason }) =>
        `${reason === "control" ? sanitizeForDisplay(path) : path} ` +
        UNMOUNTABLE_REASON_TEXT[reason],
    )
    .join("; ");
  if (unmountable.some(({ reason }) => reason === "control"))
    return (
      "No command to run or schedule this exchange is shown because " +
      `${named}. Move that folder to a path without such a character, and ` +
      "set the new path in the configuration."
    );
  return (
    `The Docker commands are not shown because ${named}. To run Alcove from ` +
    "its image, write the docker run command yourself and mount that path " +
    "by hand, or run an installed Alcove with the commands below."
  );
}

/**
 * The caveat for the paths outside the exchange folder the Docker lines mount
 * at their own path, which the Task Scheduler line leaves to the operator.
 */
export function bindPathsCaveat(
  bindPaths: ReadonlyArray<HandoffBindPath>,
): string {
  const paths = bindPaths.map(({ path }) => path).join(", ");
  return (
    `The Docker commands for Linux and macOS mount ${paths} at the same path inside the ` +
    "container, so Alcove finds each where this hand-off names it. When you " +
    "set one of these paths, set it the same way in the Docker commands. The " +
    "Windows command and the Task Scheduler line mount only the exchange " +
    "folder: for each path, add " +
    "--mount type=bind,src=FILE,dst=PATH before the image name, with FILE " +
    "the folder or file on your machine and PATH the path named here."
  );
}
