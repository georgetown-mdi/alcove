import { imageReference, releaseVersion } from "@utils/alcoveImage";
import { alcoveVersion } from "@utils/clientConfig";

import {
  OPERATOR_ACCOUNT_VALUE,
  operatorAccountOption,
} from "./containerAccount";
import {
  shellJoinCommand,
  windowsJoinCommand,
} from "./managed/recurringHandoff";

import type { ContainerEngine } from "./containerAccount";
import type { HandoffBindPath } from "@jobContract/handoffBindPaths";

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

/** A control character, or a bidirectional override or isolate character. */
const CONTROL_OR_DIRECTION_CHARACTER =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

/** Why a bind path cannot be mounted at its own path by a `--mount` option. */
export type UnmountableReason =
  "control" | "comma" | "quote" | "dots" | "workFolder" | "root";

/** A bind path the Docker lines cannot mount, and why. */
export interface UnmountableBindPath {
  path: string;
  reason: UnmountableReason;
}

/**
 * The bind paths a `--mount` option cannot state at their own path: `--mount`
 * is a comma-separated list read as CSV, so a `,` ends the path and a `"`
 * starts a quoted field, and a path at or under `/work` lands inside the
 * exchange folder's mount. A control or text-direction character is refused:
 * a crontab ends an entry at a line break whatever the shell quoting, and the
 * path can come from a partner's invitation. The filesystem root `/` is
 * refused too: binding it would give the container the whole host
 * filesystem. A path not written
 * plainly is refused rather than rewritten, so the mount binds exactly the
 * path the configuration names.
 */
export function unmountableBindPaths(
  bindPaths: ReadonlyArray<HandoffBindPath>,
): Array<UnmountableBindPath> {
  return bindPaths.flatMap(({ path }): Array<UnmountableBindPath> => {
    if (CONTROL_OR_DIRECTION_CHARACTER.test(path))
      return [{ path, reason: "control" }];
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
 * A command's argv joined into one line for a POSIX shell, with the operator
 * account value left for the shell to expand ({@link operatorAccountOption})
 * and each token `alwaysQuote` accepts double-quoted ({@link shellJoinCommand}).
 */
export function shellJoinRunArgv(
  argv: ReadonlyArray<string>,
  alwaysQuote?: (token: string) => boolean,
): string {
  return shellJoinCommand(
    argv,
    (token) => token === OPERATOR_ACCOUNT_VALUE,
    alwaysQuote,
  );
}

/**
 * The `docker run` argv over `folder`: the folder mounted at the image's
 * working directory and, unless `mountBindPaths` is false, each bind path at
 * its own path, so every path the configuration names resolves inside the
 * container as it does outside. `interactive` gives the run a terminal.
 * `operatorAccountFor` runs the container as the operator's own account under
 * that engine, for a Linux host, whose mounted folder the image's own account
 * cannot write. Undefined when a bind path cannot be mounted
 * ({@link unmountableBindPaths}).
 */
export function dockerRunArgv(
  { argv, bindPaths, image }: ScheduledRunSource,
  program: string,
  folder: string,
  {
    interactive = false,
    mountBindPaths = true,
    operatorAccountFor,
    bindPathSource = (path) => path,
  }: {
    interactive?: boolean;
    mountBindPaths?: boolean;
    operatorAccountFor?: ContainerEngine;
    /** The host side of a bind path's mount, its own path unless given. */
    bindPathSource?: (path: string) => string;
  } = {},
): Array<string> | undefined {
  if (unmountableBindPaths(bindPaths).length > 0) return undefined;
  return [
    program,
    "run",
    "--rm",
    ...(interactive ? ["-it"] : []),
    ...(operatorAccountFor !== undefined
      ? operatorAccountOption(operatorAccountFor)
      : []),
    ...mountOption(folder, CONTAINER_WORK_FOLDER, false),
    ...(mountBindPaths
      ? bindPaths.flatMap(({ path, readOnly }) =>
          mountOption(bindPathSource(path), path, readOnly),
        )
      : []),
    image,
    ...alcoveArgs(argv),
  ];
}

/** A folder a working-folder command mounts besides the working folder: a
 * placeholder, mounted at its own path on Linux and macOS, and from
 * `windowsPath` on Windows. */
export interface WorkingFolderBindPath extends HandoffBindPath {
  windowsPath: string;
}

/** The console's working folder placeholder on Windows. */
export const WINDOWS_WORKING_FOLDER_PLACEHOLDER =
  "C:\\path\\to\\your\\working-folder";

/** The console's secrets folder placeholder on Windows. */
export const WINDOWS_SECRETS_FOLDER_PLACEHOLDER =
  "C:\\path\\to\\your\\secrets-folder";

/** The argument a one-off command names for the identity string, which the
 * operator replaces with their name. */
export const IDENTITY_NAME_PLACEHOLDER = "NAME";

/** The path placeholders a one-off command names, which the operator replaces
 * with paths of their own. */
export const WORKING_FOLDER_PATH_PLACEHOLDERS: ReadonlyArray<string> = [
  WORKING_FOLDER_PLACEHOLDER,
  SECRETS_FOLDER_PLACEHOLDER,
  WINDOWS_WORKING_FOLDER_PLACEHOLDER,
  WINDOWS_SECRETS_FOLDER_PLACEHOLDER,
];

/** Whether a one-off command's token holds a placeholder the operator
 * replaces, which is double-quoted so what they put in its place may hold a
 * space. */
function holdsOneOffPlaceholder(token: string): boolean {
  return (
    token === IDENTITY_NAME_PLACEHOLDER ||
    WORKING_FOLDER_PATH_PLACEHOLDERS.some((placeholder) =>
      token.includes(placeholder),
    )
  );
}

/**
 * A one-off command over the operator's working folder, per shell: Docker on
 * Linux and macOS, as the operator's own account; Docker Desktop on Windows in
 * PowerShell, which takes no account option; and rootless Podman.
 */
export interface WorkingFolderCommandLines {
  runCommand: string;
  windowsRunCommand: string;
  podmanRunCommand: string;
}

/**
 * Whether PowerShell needs `token` quoted though cmd would not: a `--mount`
 * value, whose commas PowerShell reads as an array, a leading `@`, which it
 * reads as splatting, and a token holding a placeholder the operator replaces.
 */
function powerShellQuotes(token: string): boolean {
  return (
    token.startsWith("type=bind,") ||
    token.startsWith("@") ||
    holdsOneOffPlaceholder(token)
  );
}

/**
 * The command running `alcove` with `args` once from the image over the
 * operator's working folder, as the console's copy names a command-line step:
 * the folder mounted at the image's working directory, so a file name in
 * `args` is read from it, and each of `bindPaths` at its own path inside the
 * container. `interactive` gives the run a terminal, for a command that asks
 * before it writes. Each token holding a placeholder the operator replaces is
 * double-quoted in every shell.
 */
export function workingFolderCommand(
  args: ReadonlyArray<string>,
  {
    interactive = false,
    bindPaths = [],
    image = buildImageReference(),
  }: {
    interactive?: boolean;
    bindPaths?: ReadonlyArray<WorkingFolderBindPath>;
    image?: string;
  } = {},
): WorkingFolderCommandLines {
  const source: ScheduledRunSource = {
    argv: ["alcove", ...args],
    bindPaths,
    image,
  };
  const windowsPaths = new Map(
    bindPaths.map(({ path, windowsPath }) => [path, windowsPath]),
  );
  const posix = dockerRunArgv(source, "docker", WORKING_FOLDER_PLACEHOLDER, {
    interactive,
    operatorAccountFor: "docker",
  });
  const podman = dockerRunArgv(source, "podman", WORKING_FOLDER_PLACEHOLDER, {
    interactive,
    operatorAccountFor: "podman",
  });
  const windows = dockerRunArgv(
    source,
    "docker",
    WINDOWS_WORKING_FOLDER_PLACEHOLDER,
    {
      interactive,
      bindPathSource: (path) => windowsPaths.get(path) ?? path,
    },
  );
  if (posix === undefined || podman === undefined || windows === undefined)
    throw new Error("a working-folder command names an unmountable path");
  return {
    runCommand: shellJoinRunArgv(posix, holdsOneOffPlaceholder),
    windowsRunCommand: windowsJoinCommand(windows, powerShellQuotes),
    podmanRunCommand: shellJoinRunArgv(podman, holdsOneOffPlaceholder),
  };
}
