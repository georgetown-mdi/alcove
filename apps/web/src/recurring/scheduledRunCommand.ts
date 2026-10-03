import { posix } from "node:path";

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
  /** `alcove`, its command, and the input and output positionals last, as
   * `parseHandoff` admits it. */
  argv: ReadonlyArray<string>;
  bindPaths: ReadonlyArray<HandoffBindPath>;
  image: string;
}

/** The argv's arguments, without the program token it starts on. */
function alcoveArgs(argv: ReadonlyArray<string>): Array<string> {
  return argv.slice(1);
}

/** A bind path as the mount states it: `.` and `..` segments resolved and a
 * trailing slash dropped, so the checks and the rendered mount agree. */
function normalizedBindPath(bindPath: string): string {
  const normalized = posix.normalize(bindPath);
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
}

/** Why a bind path cannot be mounted at its own path by a `--mount` option. */
export type UnmountableReason = "comma" | "quote" | "workFolder" | "root";

/** A bind path the Docker lines cannot mount, and why. */
export interface UnmountableBindPath {
  path: string;
  reason: UnmountableReason;
}

/**
 * The bind paths a `--mount` option cannot state at their own path: `--mount`
 * is a comma-separated list read as CSV, so a `,` ends the path and a `"`
 * starts a quoted field, and a path at or under `/work` lands inside the
 * exchange folder's mount. The filesystem root `/` is refused too: binding it
 * would give the container the whole host filesystem.
 */
export function unmountableBindPaths(
  bindPaths: ReadonlyArray<HandoffBindPath>,
): Array<UnmountableBindPath> {
  return bindPaths.flatMap(({ path: raw }): Array<UnmountableBindPath> => {
    const bound = normalizedBindPath(raw);
    if (bound.includes(",")) return [{ path: raw, reason: "comma" }];
    if (bound.includes('"')) return [{ path: raw, reason: "quote" }];
    if (bound === "/") return [{ path: raw, reason: "root" }];
    if (
      bound === CONTAINER_WORK_FOLDER ||
      bound.startsWith(`${CONTAINER_WORK_FOLDER}/`)
    )
      return [{ path: raw, reason: "workFolder" }];
    return [];
  });
}

/** The `--mount` option binding `source` on the host at `target`. */
function mountOption(
  source: string,
  target: string,
  readOnly: boolean,
): Array<string> {
  return [
    "--mount",
    `type=bind,src=${source},dst=${target}${readOnly ? ",readonly" : ""}`,
  ];
}

/**
 * The `docker run` argv over `folder`: the folder mounted at the image's
 * working directory and each bind path at its own path, so every path the
 * configuration names resolves inside the container as it does outside.
 * Undefined when a bind path cannot be mounted ({@link unmountableBindPaths}).
 */
export function dockerRunArgv(
  { argv, bindPaths, image }: ScheduledRunSource,
  program: string,
  folder: string,
): Array<string> | undefined {
  if (unmountableBindPaths(bindPaths).length > 0) return undefined;
  return [
    program,
    "run",
    "--rm",
    ...mountOption(folder, CONTAINER_WORK_FOLDER, false),
    ...bindPaths.flatMap(({ path: raw, readOnly }) => {
      const bound = normalizedBindPath(raw);
      return mountOption(bound, bound, readOnly);
    }),
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
 * with `docker` as their shell finds it. Undefined when a bind path cannot be
 * mounted. */
export function dockerRunCommand(
  source: ScheduledRunSource,
): string | undefined {
  const argv = dockerRunArgv(source, "docker", EXCHANGE_FOLDER_PLACEHOLDER);
  return argv === undefined ? undefined : posixCommandLine(argv);
}

/** The command a person runs once by hand from the exchange folder with an
 * installed `alcove`. */
export function installedRunCommand({ argv }: ScheduledRunSource): string {
  return posixCommandLine(["alcove", ...alcoveArgs(argv)]);
}

/** The crontab line running the image over the exchange folder. Undefined
 * when a bind path cannot be mounted. */
export function dockerCronLine(source: ScheduledRunSource): string | undefined {
  const argv = dockerRunArgv(
    source,
    POSIX_DOCKER_PROGRAM,
    EXCHANGE_FOLDER_PLACEHOLDER,
  );
  return argv === undefined ? undefined : cronLine(posixCommandLine(argv));
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
 * Undefined when a bind path cannot be mounted.
 */
export function dockerTaskSchedulerLine(
  source: ScheduledRunSource,
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
