import {
  shellJoinCommand,
  windowsJoinCommand,
} from "@psi/managed/recurringHandoff";

import { taskSchedulerLine } from "./scheduleTemplates";

import type { HandoffBindPath } from "@jobs/handoff";

/**
 * The command lines the console's recurring-run hand-off shows, composed from
 * the hand-off's `alcove` argv: the published image run by `docker` over the
 * operator's exchange folder by default, since that is how a console user has
 * Alcove, and an installed `alcove` as the alternative.
 *
 * Every scheduled line names its program by absolute path, appends to a log
 * file, and gives each run its own result file, so a scheduled run neither
 * fails to find its program under the scheduler's PATH nor overwrites the last
 * run's result.
 */

/** The exchange folder placeholder on a POSIX scheduling machine. */
export const EXCHANGE_FOLDER_PLACEHOLDER = "/path/to/your/exchange-folder";

/** The exchange folder placeholder on a Windows scheduling machine. */
const WINDOWS_EXCHANGE_FOLDER_PLACEHOLDER =
  "C:\\path\\to\\your\\exchange-folder";

/** The image's working directory, where the exchange folder is mounted. */
const CONTAINER_WORK_FOLDER = "/work";

/** Where the Docker client is installed on Linux. */
const POSIX_DOCKER_PROGRAM = "/usr/bin/docker";

/** The installed program's placeholder, for the line that runs it directly. */
export const INSTALLED_ALCOVE_PLACEHOLDER = "/path/to/alcove";

/** The schedule the lines use: daily at 2am, which the operator changes to the
 * time agreed with their partner. */
const CRON_SCHEDULE = "0 2 * * *";

/** An output positional the POSIX lines give a per-run name. */
const PER_RUN_OUTPUT_NAME = /^([A-Za-z0-9_-]+)\.csv$/;

/** What the lines are composed from: the hand-off's argv and bind paths, and
 * the image reference this build names. */
export interface ScheduledRunSource {
  /** `alcove`, its arguments, and the input and output positionals last. */
  argv: ReadonlyArray<string>;
  bindPaths: ReadonlyArray<HandoffBindPath>;
  image: string;
}

/** The argv's arguments, without the program token it starts on. */
function alcoveArgs(argv: ReadonlyArray<string>): Array<string> {
  if (argv[0] !== "alcove" || argv.length < 3)
    throw new Error("a hand-off argv starts on alcove and ends on two files");
  return argv.slice(1);
}

/**
 * The `docker run` argv over `folder`: the folder mounted at the image's
 * working directory and each bind path at its own path, so every path the
 * configuration names resolves inside the container as it does outside.
 */
export function dockerRunArgv(
  { argv, bindPaths, image }: ScheduledRunSource,
  program: string,
  folder: string,
): Array<string> {
  return [
    program,
    "run",
    "--rm",
    "-v",
    `${folder}:${CONTAINER_WORK_FOLDER}`,
    ...bindPaths.flatMap(({ path, readOnly }) => [
      "-v",
      `${path}:${path}${readOnly ? ":ro" : ""}`,
    ]),
    image,
    ...alcoveArgs(argv),
  ];
}

/**
 * `argv` joined for a POSIX shell with its last token, the output file, given
 * the run's date and time: `results.csv` becomes
 * `results-$(date +%Y%m%d-%H%M%S).csv`, which the shell expands at each run.
 * An output name of another shape is kept as it is.
 */
export function posixCommandLine(argv: ReadonlyArray<string>): string {
  const output = argv.at(-1) ?? "";
  const stem = PER_RUN_OUTPUT_NAME.exec(output)?.[1];
  const outputToken =
    stem === undefined
      ? shellJoinCommand([output])
      : `${stem}-$(date +%Y%m%d-%H%M%S).csv`;
  return `${shellJoinCommand(argv.slice(0, -1))} ${outputToken}`;
}

/** A crontab line running `command`. cron ends a command at an unescaped `%`
 * and passes the rest as its input, so each is escaped. */
function cronLine(command: string): string {
  return `${CRON_SCHEDULE} ${command.replaceAll("%", "\\%")}`;
}

/** The command a person runs once by hand: the image over the exchange folder,
 * with `docker` as their shell finds it. */
export function dockerRunCommand(source: ScheduledRunSource): string {
  return posixCommandLine(
    dockerRunArgv(source, "docker", EXCHANGE_FOLDER_PLACEHOLDER),
  );
}

/** The crontab line running the image over the exchange folder. */
export function dockerCronLine(source: ScheduledRunSource): string {
  return cronLine(
    posixCommandLine(
      dockerRunArgv(source, POSIX_DOCKER_PROGRAM, EXCHANGE_FOLDER_PLACEHOLDER),
    ),
  );
}

/** The crontab line running an installed `alcove` from the exchange folder. */
export function installedCronLine({ argv }: ScheduledRunSource): string {
  return cronLine(
    `cd ${EXCHANGE_FOLDER_PLACEHOLDER} && ` +
      posixCommandLine([INSTALLED_ALCOVE_PLACEHOLDER, ...alcoveArgs(argv)]),
  );
}

/**
 * The Task Scheduler registration running the image over the exchange folder.
 * It mounts the folder alone, since a Windows path cannot be mounted at the
 * same path inside the container; the panel names each bind path to mount by
 * hand. `cmd` has no portable date expansion, so the output name is fixed.
 */
export function dockerTaskSchedulerLine(source: ScheduledRunSource): string {
  return taskSchedulerLine(
    windowsJoinCommand(
      dockerRunArgv(
        { ...source, bindPaths: [] },
        "docker",
        WINDOWS_EXCHANGE_FOLDER_PLACEHOLDER,
      ),
    ),
  );
}

/** The input file the hand-off's command reads, which the panel asks the
 * operator to put in the exchange folder. */
export function handoffInputName(argv: ReadonlyArray<string>): string {
  return alcoveArgs(argv).at(-2) ?? "";
}
