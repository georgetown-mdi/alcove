import {
  shellJoinCommand,
  windowsJoinCommand,
} from "@psi/managed/recurringHandoff";

import {
  CONTAINER_WORK_FOLDER,
  alcoveArgs,
  dockerRunArgv,
  mountOption,
  unmountableBindPaths,
} from "@psi/dockerRunCommand";

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
import type { HandoffBindPath } from "@jobs/handoff";
import type { RunSchedule } from "./scheduleTemplates";

export {
  SECRETS_FOLDER_PLACEHOLDER,
  WORKING_FOLDER_PLACEHOLDER,
  buildImageReference,
  dockerRunArgv,
  unmountableBindPaths,
  workingFolderCommand,
} from "@psi/dockerRunCommand";
export type {
  ScheduledRunSource,
  UnmountableBindPath,
  UnmountableReason,
} from "@psi/dockerRunCommand";

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

/** Where the Docker client is installed on Linux. */
const POSIX_DOCKER_PROGRAM = "/usr/bin/docker";

/** The installed program's placeholder, for the line that runs it directly. */
export const INSTALLED_ALCOVE_PLACEHOLDER = "/path/to/alcove";

/** A crontab line running `command` on `schedule` (daily at 2am without
 * one). cron ends a command at an unescaped `%` and passes the rest as its
 * input, so each one the command holds is escaped. */
function cronLine(command: string, schedule: RunSchedule | undefined): string {
  const guarded = cronIntervalGuard(schedule) + command;
  return `${cronScheduleFields(schedule)} ${guarded.replaceAll("%", "\\%")}`;
}

/** The command a person runs once by hand: the image over the exchange folder,
 * with `docker` as their shell finds it. Undefined when a bind path cannot be
 * mounted. */
export function dockerRunCommand(
  source: ScheduledRunSource,
): string | undefined {
  const argv = dockerRunArgv(source, "docker", EXCHANGE_FOLDER_PLACEHOLDER);
  return argv === undefined ? undefined : shellJoinCommand(argv);
}

/** The command a person runs once by hand from the exchange folder with an
 * installed `alcove`. */
export function installedRunCommand({ argv }: ScheduledRunSource): string {
  return shellJoinCommand(["alcove", ...alcoveArgs(argv)]);
}

/** The crontab line running the image over the exchange folder on
 * `schedule`. Undefined when a bind path cannot be mounted. */
export function dockerCronLine(
  source: ScheduledRunSource,
  schedule?: RunSchedule,
): string | undefined {
  const argv = dockerRunArgv(
    source,
    POSIX_DOCKER_PROGRAM,
    EXCHANGE_FOLDER_PLACEHOLDER,
  );
  return argv === undefined
    ? undefined
    : cronLine(shellJoinCommand(argv), schedule);
}

/** The crontab line running an installed `alcove` from the exchange folder on
 * `schedule`. */
export function installedCronLine(
  { argv }: ScheduledRunSource,
  schedule?: RunSchedule,
): string {
  return cronLine(
    `cd ${EXCHANGE_FOLDER_PLACEHOLDER} && ` +
      shellJoinCommand([INSTALLED_ALCOVE_PLACEHOLDER, ...alcoveArgs(argv)]),
    schedule,
  );
}

/**
 * The Task Scheduler registration running the image over the exchange folder.
 * It mounts the folder alone, since a Windows path cannot be mounted at the
 * same path inside the container; the panel names each bind path to mount by
 * hand. Undefined when a bind path cannot be mounted.
 */
export function dockerTaskSchedulerLine(
  source: ScheduledRunSource,
  schedule?: RunSchedule,
): string | undefined {
  if (unmountableBindPaths(source.bindPaths).length > 0) return undefined;
  return taskSchedulerLine(
    windowsJoinCommand([
      "docker",
      "run",
      "--rm",
      ...mountOption(
        WINDOWS_EXCHANGE_FOLDER_PLACEHOLDER,
        CONTAINER_WORK_FOLDER,
        false,
      ),
      source.image,
      ...alcoveArgs(source.argv),
    ]),
    schedule,
  );
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
  comma: "contains a comma, which a --mount option cannot hold",
  quote: "contains a double quote, which a --mount option cannot hold",
  dots: "is not a plain path: write the path without . or .. segments, repeated slashes, or a trailing slash",
  root: "is the filesystem root, which is too broad to mount",
  workFolder: `is inside ${CONTAINER_WORK_FOLDER}, where the image mounts the exchange folder`,
};

/** The panel's sentence naming each path the Docker lines cannot mount and why. */
export function unmountableBindPathsNotice(
  unmountable: ReadonlyArray<UnmountableBindPath>,
): string {
  const named = unmountable
    .map(({ path, reason }) => `${path} ${UNMOUNTABLE_REASON_TEXT[reason]}`)
    .join("; ");
  return (
    `The Docker commands are not shown because ${named}. To run Alcove ` +
    "from its image, write the docker run command yourself and mount that " +
    "path by hand, or run an installed Alcove with the commands below."
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
    `The Docker commands mount ${paths} at the same path inside the ` +
    "container, so Alcove finds each where this hand-off names it. When you " +
    "set one of these paths, set it the same way in the Docker commands. The " +
    "Task Scheduler line mounts only the exchange folder: for each path, add " +
    "--mount type=bind,src=FILE,dst=PATH before the image name, with FILE " +
    "the folder or file on your machine and PATH the path named here."
  );
}
