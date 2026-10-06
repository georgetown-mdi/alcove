import { imageReference, releaseVersion } from "@utils/alcoveImage";
import { alcoveVersion } from "@utils/clientConfig";

import { shellJoinCommand } from "./managed/recurringHandoff";

import type { HandoffBindPath } from "@jobs/handoffBindPaths";

/**
 * The `docker run` command running Alcove's published image over a folder,
 * which every command line the app shows a console operator is composed
 * through: the recurring-run hand-offs' and each command-line step the
 * console's copy names ({@link workingFolderCommand}).
 */

/** The image's working directory, where the folder is mounted. */
export const CONTAINER_WORK_FOLDER = "/work";

/** The console's working folder placeholder, in a one-off command its copy
 * names. */
export const WORKING_FOLDER_PLACEHOLDER = "/path/to/your/working-folder";

/** The console's secrets folder placeholder, in a one-off command its copy
 * names. */
export const SECRETS_FOLDER_PLACEHOLDER = "/path/to/your/secrets-folder";

/** The image this build's commands name: its own release, else the floating
 * tag. */
export function buildImageReference(): string {
  return imageReference(releaseVersion(alcoveVersion()));
}

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
export function alcoveArgs(argv: ReadonlyArray<string>): Array<string> {
  return argv.slice(1);
}

/** Whether a bind path is written plainly: no `.` or `..` segment, no
 * repeated slash, and no trailing slash other than the root itself. */
function isPlainBindPath(bindPath: string): boolean {
  if (bindPath === "/") return true;
  return bindPath
    .split("/")
    .slice(1)
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Why a bind path cannot be mounted at its own path by a `--mount` option. */
export type UnmountableReason =
  "comma" | "quote" | "dots" | "workFolder" | "root";

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
 * would give the container the whole host filesystem. A path not written
 * plainly is refused rather than rewritten, so the mount binds exactly the
 * path the configuration names.
 */
export function unmountableBindPaths(
  bindPaths: ReadonlyArray<HandoffBindPath>,
): Array<UnmountableBindPath> {
  return bindPaths.flatMap(({ path }): Array<UnmountableBindPath> => {
    if (path.includes(",")) return [{ path, reason: "comma" }];
    if (path.includes('"')) return [{ path, reason: "quote" }];
    if (!isPlainBindPath(path)) return [{ path, reason: "dots" }];
    if (path === "/") return [{ path, reason: "root" }];
    if (
      path === CONTAINER_WORK_FOLDER ||
      path.startsWith(`${CONTAINER_WORK_FOLDER}/`)
    )
      return [{ path, reason: "workFolder" }];
    return [];
  });
}

/** The `--mount` option binding `source` on the host at `target`. */
export function mountOption(
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
    ...bindPaths.flatMap(({ path, readOnly }) =>
      mountOption(path, path, readOnly),
    ),
    image,
    ...alcoveArgs(argv),
  ];
}

/**
 * The command running `alcove` with `args` once from the image over the
 * operator's working folder, as the console's copy names a command-line step:
 * the folder mounted at the image's working directory, so a file name in
 * `args` is read from it, and each of `bindPaths` at its own path. `interactive`
 * gives the run a terminal, for a command that asks before it writes.
 */
export function workingFolderCommand(
  args: ReadonlyArray<string>,
  {
    interactive = false,
    bindPaths = [],
    image = buildImageReference(),
  }: {
    interactive?: boolean;
    bindPaths?: ReadonlyArray<HandoffBindPath>;
    image?: string;
  } = {},
): string {
  const argv = dockerRunArgv(
    { argv: ["alcove", ...args], bindPaths, image },
    "docker",
    WORKING_FOLDER_PLACEHOLDER,
  );
  if (argv === undefined)
    throw new Error("a working-folder command names an unmountable path");
  if (interactive) argv.splice(3, 0, "-it");
  return shellJoinCommand(argv);
}
