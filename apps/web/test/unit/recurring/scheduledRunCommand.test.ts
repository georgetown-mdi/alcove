import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import {
  CRONTAB_ACCOUNT_NOTE,
  EXCHANGE_FOLDER_PLACEHOLDER,
  FOLDER_OWNED_BY_IMAGE_ACCOUNT_NOTE,
  INSTALLED_ALCOVE_PLACEHOLDER,
  dockerCronLine,
  dockerRunCommand,
  dockerTaskSchedulerLine,
  dockerWindowsRunCommand,
  handoffInputName,
  podmanCronLine,
  podmanRunCommand,
  runLines,
  unmountableBindPathsNotice,
} from "@recurring/scheduledRunCommand";
import {
  dockerRunArgv,
  unmountableBindPaths,
  workingFolderCommand,
} from "@psi/dockerRunCommand";
import { HANDOFF_PATH_PLACEHOLDERS } from "@jobContract/handoffBindPaths";
import { parseHandoff } from "@psi/managed/recurringHandoff";
import { runScheduleFor } from "@recurring/scheduleTemplates";

import type { ScheduledRunSource } from "@psi/dockerRunCommand";

// The lines the console's hand-off shows, as the operator pastes them. The
// installed-program cron line is run for real in the console interop suite
// (consoleScheduledHandoff.test.ts); these pin the text of every line.

const IMAGE = "ghcr.io/georgetown-mdi/alcove:1.2.3";

const SOURCE: ScheduledRunSource = {
  argv: ["alcove", "exchange", "--log-file=exchange.log", "clients.csv", "./"],
  bindPaths: [
    { path: "/path/to/your/shared-directory", readOnly: false },
    { path: "/path/to/your/signing-identity.json", readOnly: true },
  ],
  image: IMAGE,
};

const DOCKER_USER = '--user "$(id -u):$(id -g)"';
const PODMAN_USER = "--userns=keep-id:uid=1000,gid=1000";

const MOUNTS =
  '--mount "type=bind,src=/path/to/your/exchange-folder,dst=/work" ' +
  '--mount "type=bind,src=/path/to/your/shared-directory,' +
  'dst=/path/to/your/shared-directory" ' +
  '--mount "type=bind,src=/path/to/your/signing-identity.json,' +
  'dst=/path/to/your/signing-identity.json,readonly"';

/** The lines for `source`, failing the test where they are withheld. */
function shownLines(source: ScheduledRunSource) {
  const lines = runLines(source);
  if (lines.kind !== "shown")
    throw new Error(`the lines were withheld: ${lines.notice}`);
  return lines;
}

/** The source with `path` as its one bind path. */
function sourceBinding(path: string): ScheduledRunSource {
  return { ...SOURCE, bindPaths: [{ path, readOnly: false }] };
}

describe("the scheduled-run panels' notes", () => {
  test("name the crontab to use and the account option to leave out", () => {
    expect(CRONTAB_ACCOUNT_NOTE).toBe(
      "Add a cron line with crontab -e as the account that will run the " +
        "schedule, not with sudo: a line in root's crontab runs Alcove as root.",
    );
    expect(FOLDER_OWNED_BY_IMAGE_ACCOUNT_NOTE).toBe(
      "If the exchange folder belongs to user 1000 (you ran chown 1000:1000 " +
        'on it), leave out --user "$(id -u):$(id -g)" from the Docker command ' +
        "and cron line.",
    );
  });
});

describe("the console hand-off's command lines", () => {
  test("the one-off command runs the image as the operator over the folder", () => {
    expect(dockerRunCommand(SOURCE)).toBe(
      `docker run --rm ${DOCKER_USER} ${MOUNTS} ${IMAGE} exchange ` +
        "--log-file=exchange.log clients.csv ./",
    );
  });

  test("the cron line names docker by path and runs it as the operator", () => {
    const line = dockerCronLine(SOURCE);
    expect(line).toBe(
      `0 2 * * * /usr/bin/docker run --rm ${DOCKER_USER} ${MOUNTS} ${IMAGE} ` +
        "exchange --log-file=exchange.log clients.csv ./",
    );
    expect(line).not.toMatch(/[%`\\]/);
  });

  test("the Podman command and cron line map the operator with a user namespace, not --user", () => {
    expect(podmanRunCommand(SOURCE)).toBe(
      `podman run --rm ${PODMAN_USER} ${MOUNTS} ${IMAGE} exchange ` +
        "--log-file=exchange.log clients.csv ./",
    );
    expect(podmanCronLine(SOURCE)).toBe(
      `0 2 * * * /usr/bin/podman run --rm ${PODMAN_USER} ${MOUNTS} ${IMAGE} ` +
        "exchange --log-file=exchange.log clients.csv ./",
    );
    expect(podmanRunCommand(SOURCE)).not.toContain("--user ");
    expect(podmanCronLine(SOURCE)).not.toContain("--user ");
  });

  test("the shell expands the account to the operator's own ids, as one argument", () => {
    const command = dockerRunCommand(SOURCE);
    if (command === undefined) throw new Error("no docker command");
    const tokens = execFileSync(
      "/bin/sh",
      ["-c", `printf '%s\\n' ${command}`],
      { encoding: "utf8" },
    ).split("\n");
    const operator =
      `${execFileSync("id", ["-u"], { encoding: "utf8" }).trim()}:` +
      execFileSync("id", ["-g"], { encoding: "utf8" }).trim();
    expect(tokens.slice(0, 4)).toEqual(["docker", "run", "--rm", "--user"]);
    expect(tokens[4]).toBe(operator);
  });

  test("the lines carry both engines' forms where the Docker lines are shown", () => {
    const lines = shownLines(SOURCE);
    expect(lines.runCommand).toBe(dockerRunCommand(SOURCE));
    expect(lines.dockerCronLine).toBe(dockerCronLine(SOURCE));
    expect(lines.podmanRunCommand).toBe(podmanRunCommand(SOURCE));
    expect(lines.podmanCronLine).toBe(podmanCronLine(SOURCE));
  });

  test("the installed-program cron line runs from the exchange folder", () => {
    const line = shownLines(SOURCE).installedCronLine;
    expect(line).toBe(
      '0 2 * * * cd "/path/to/your/exchange-folder" && "/path/to/alcove" ' +
        "exchange --log-file=exchange.log clients.csv ./",
    );
    expect(line).not.toMatch(/[$%`\\]/);
  });

  test("a percent sign in an argument is escaped for cron as well", () => {
    const line = shownLines({
      ...SOURCE,
      argv: ["alcove", "exchange", "--identity=50% Agency", "in.csv", "r.csv"],
    }).installedCronLine;
    expect(line).toContain("'--identity=50\\% Agency'");
  });

  test("the Task Scheduler line mounts the folder alone and names each run's result the same way", () => {
    const line = dockerTaskSchedulerLine(SOURCE);
    expect(line).toContain(
      "docker run --rm --mount " +
        '""type=bind,src=C:\\path\\to\\your\\exchange-folder,dst=/work"" ' +
        `${IMAGE} exchange --log-file=exchange.log clients.csv ./")`,
    );
    expect(line).not.toContain("shared-directory");
    expect(line).not.toContain("--user");
    expect(line).not.toContain("--userns");
  });

  test("the run command is shown for each shell: the operator's account on macOS and Linux, none on Windows", () => {
    const lines = shownLines(SOURCE);
    expect(lines.runCommand).toContain(DOCKER_USER);
    expect(lines.windowsRunCommand).toBe(dockerWindowsRunCommand(SOURCE));
    expect(lines.windowsRunCommand).toBe(
      "docker run --rm --mount " +
        '"type=bind,src=C:\\path\\to\\your\\exchange-folder,dst=/work" ' +
        `${IMAGE} exchange --log-file=exchange.log clients.csv ./`,
    );
    expect(lines.windowsRunCommand).not.toContain("--user");
    expect(lines.windowsRunCommand).not.toContain("$(");
    expect(lines.windowsRunCommand).not.toContain("shared-directory");
  });

  test("no Windows run command is shown where a path cannot be mounted", () => {
    const lines = shownLines(sourceBinding("/srv/a,b"));
    expect(lines.windowsRunCommand).toBeUndefined();
    expect(lines.runCommand).not.toContain("docker");
  });

  test("the input name is the positional before the output", () => {
    expect(handoffInputName(SOURCE.argv)).toBe("clients.csv");
    expect(
      handoffInputName(["alcove", "exchange", "./-x.csv", "results.csv"]),
    ).toBe("-x.csv");
  });

  test("a path with a colon is mounted whole", () => {
    expect(dockerRunCommand(sourceBinding("/srv/a:b"))).toContain(
      " --mount type=bind,src=/srv/a:b,dst=/srv/a:b ",
    );
  });

  test("a path with a space and a single quote stays one shell token", () => {
    const command = dockerRunCommand(sourceBinding("/srv/it's here"));
    if (command === undefined) throw new Error("no docker command");
    const tokens = execFileSync(
      "/bin/sh",
      ["-c", `printf '%s\\n' ${command}`],
      {
        encoding: "utf8",
      },
    ).split("\n");
    expect(tokens).toContain("type=bind,src=/srv/it's here,dst=/srv/it's here");
  });

  test.each(["/srv/$HOME dir", "/srv/it's here"])(
    "a path %s stays one argument in the installed cron command",
    (path) => {
      const line = shownLines({
        ...SOURCE,
        argv: [
          "alcove",
          "exchange",
          `--outbound-path=${path}`,
          "in.csv",
          "r.csv",
        ],
      }).installedCronLine;
      const command = line
        .slice(line.indexOf("&& ") + 3)
        .replaceAll("\\%", "%");
      const tokens = execFileSync(
        "/bin/sh",
        ["-c", `printf '%s\\n' ${command}`],
        { encoding: "utf8" },
      ).split("\n");
      expect(tokens).toContain(`--outbound-path=${path}`);
    },
  );

  test("a path with a comma, or under /work, leaves out every Docker line", () => {
    for (const [path, reason] of [
      ["/srv/a,b", "comma"],
      ['/srv/a"b', "quote"],
      ["/", "root"],
      ["/work", "workFolder"],
      ["/work/shared", "workFolder"],
    ] as const) {
      const source = sourceBinding(path);
      expect(unmountableBindPaths(source.bindPaths)).toEqual([
        { path, reason },
      ]);
      expect(dockerRunCommand(source)).toBeUndefined();
      expect(dockerCronLine(source)).toBeUndefined();
      expect(dockerTaskSchedulerLine(source)).toBeUndefined();
      const lines = shownLines(source);
      expect(lines.runCommand).toBe(
        "alcove exchange --log-file=exchange.log clients.csv ./",
      );
      expect(lines.installedCronLine).toContain(
        'cd "/path/to/your/exchange-folder" && "/path/to/alcove" exchange',
      );
      expect(lines.dockerLinesNotice).toBe(
        unmountableBindPathsNotice([{ path, reason }]),
      );
    }
    expect(
      unmountableBindPaths([{ path: "/workshop", readOnly: false }]),
    ).toEqual([]);
    expect(
      unmountableBindPathsNotice([{ path: "/srv/a,b", reason: "comma" }]),
    ).toContain("/srv/a,b contains a comma");
    expect(
      unmountableBindPathsNotice([{ path: "/", reason: "root" }]),
    ).toContain("too broad to mount");
  });

  test.each([
    "/.",
    "/..",
    "/srv/..",
    "/srv/a/../b",
    "/work/./x",
    "/work/",
    "//",
    "/srv//b",
  ])("the path %s, not written plainly, is refused", (path) => {
    const source = sourceBinding(path);
    expect(unmountableBindPaths(source.bindPaths)).toEqual([
      { path, reason: "dots" },
    ]);
    expect(dockerRunCommand(source)).toBeUndefined();
    expect(dockerCronLine(source)).toBeUndefined();
    expect(dockerTaskSchedulerLine(source)).toBeUndefined();
    expect(
      unmountableBindPathsNotice(unmountableBindPaths(source.bindPaths)),
    ).toContain("without . or .. segments");
  });

  test.each([
    ["a newline", "/srv/a\nb"],
    ["a carriage return", "/srv/a\rb"],
    ["a tab", "/srv/a\tb"],
    ["a direction override", "/srv/a\u202eb"],
    ["a direction isolate", "/srv/a\u2066b"],
    ["a delete", "/srv/a\u007fb"],
  ])("a path with %s is refused", (_name, path) => {
    const source = sourceBinding(path);
    expect(unmountableBindPaths(source.bindPaths)).toEqual([
      { path, reason: "control" },
    ]);
    expect(dockerRunCommand(source)).toBeUndefined();
    expect(dockerCronLine(source)).toBeUndefined();
    expect(dockerTaskSchedulerLine(source)).toBeUndefined();
    const notice = unmountableBindPathsNotice(
      unmountableBindPaths(source.bindPaths),
    );
    expect(runLines(source)).toEqual({ kind: "withheld", notice });
    expect(notice).toMatch(/^No command to run or schedule this exchange/);
    expect(notice).toContain("Move that folder to a path without");
    // eslint-disable-next-line no-control-regex
    expect(notice).not.toMatch(/[\u0000-\u001f\u202a-\u202e\u2066-\u2069]/);
  });

  test("a path whose second line is a crontab entry yields no cron line", () => {
    const path = "/x\n* * * * * touch /tmp/pwned #";
    const source = sourceBinding(path);
    expect(unmountableBindPaths(source.bindPaths)).toEqual([
      { path, reason: "control" },
    ]);
    expect(dockerCronLine(source)).toBeUndefined();
    const lines = runLines(source);
    if (lines.kind !== "withheld") throw new Error("the lines were shown");
    expect(lines.notice).toBe(
      "No command to run or schedule this exchange is shown because " +
        "/x\\x0a* * * * * touch " +
        "/tmp/pwned # contains a line break, another control character, or " +
        "a text-direction character, which a scheduled command cannot hold. " +
        "Move that folder to a path without such a character, and set the " +
        "new path in the configuration.",
    );
  });

  test("a path with a space and a single quote is still mounted", () => {
    const source = sourceBinding("/srv/it's a folder");
    expect(unmountableBindPaths(source.bindPaths)).toEqual([]);
    expect(dockerCronLine(source)).toContain(
      "'type=bind,src=/srv/it'\\''s a folder,dst=/srv/it'\\''s a folder'",
    );
  });

  test("a plain path is mounted at the path as written", () => {
    const source = sourceBinding("/srv/b");
    expect(unmountableBindPaths(source.bindPaths)).toEqual([]);
    expect(dockerRunCommand(source)).toContain(
      "--mount type=bind,src=/srv/b,dst=/srv/b",
    );
  });
});

describe("a path with a space and a single quote put in place of each placeholder", () => {
  const FOLDER_NAME = "it's my folder";
  const SHELLS = ["/bin/sh", "/bin/bash"];
  const PLACEHOLDERS = [
    EXCHANGE_FOLDER_PLACEHOLDER,
    INSTALLED_ALCOVE_PLACEHOLDER,
    ...HANDOFF_PATH_PLACEHOLDERS,
  ];

  /** `text` with each placeholder replaced by a path holding a space and a
   * single quote. */
  function replaced(text: string): string {
    return PLACEHOLDERS.reduce(
      (current, placeholder) =>
        current.replaceAll(
          placeholder,
          `/srv/it's my ${placeholder.split("/").at(-1) ?? ""}`,
        ),
      text,
    );
  }

  /** An argv naming each hand-off placeholder in a flag or locator, as the
   * hand-off composes them, and mounting each. */
  const PLACEHOLDER_SOURCE: ScheduledRunSource = {
    argv: [
      "alcove",
      "file:///path/to/your/shared-directory",
      "--server-password=@/path/to/your/credential-file",
      "--server-private-key-passphrase=@/path/to/your/passphrase-file",
      "--outbound-path=/path/to/your/outbound-directory",
      "--log-file=exchange.log",
      "clients.csv",
      "./",
    ],
    bindPaths: HANDOFF_PATH_PLACEHOLDERS.map((path) => ({
      path,
      readOnly: false,
    })),
    image: IMAGE,
  };

  /** The operator's own ids, as the shell expands the account option. */
  function operatorAccount(): string {
    return (
      `${execFileSync("id", ["-u"], { encoding: "utf8" }).trim()}:` +
      execFileSync("id", ["-g"], { encoding: "utf8" }).trim()
    );
  }

  test.each(SHELLS)(
    "leaves every argument of each Docker and Podman line whole under %s",
    (shell) => {
      const lines = shownLines(PLACEHOLDER_SOURCE);
      for (const [engine, program, command] of [
        ["docker", "docker", lines.runCommand],
        ["podman", "podman", lines.podmanRunCommand],
        ["docker", "/usr/bin/docker", cronCommand(lines.dockerCronLine)],
        ["podman", "/usr/bin/podman", cronCommand(lines.podmanCronLine)],
      ] as const) {
        const argv =
          dockerRunArgv(
            PLACEHOLDER_SOURCE,
            program,
            EXCHANGE_FOLDER_PLACEHOLDER,
            { operatorAccountFor: engine },
          ) ?? [];
        expect(shellWords(shell, replaced(command ?? ""))).toEqual(
          argv.map((token) =>
            token === '"$(id -u):$(id -g)"'
              ? operatorAccount()
              : replaced(token),
          ),
        );
      }
    },
  );

  test.each(SHELLS)(
    "leaves every argument of the installed program's lines whole under %s",
    (shell) => {
      const command = cronCommand(
        shownLines(PLACEHOLDER_SOURCE).installedCronLine,
      );
      const run = command.slice(command.indexOf(" && ") + 4);
      expect(shellWords(shell, replaced(run))).toEqual(
        [INSTALLED_ALCOVE_PLACEHOLDER, ...PLACEHOLDER_SOURCE.argv.slice(1)].map(
          replaced,
        ),
      );
      const unmountable = shownLines({
        ...PLACEHOLDER_SOURCE,
        bindPaths: [{ path: "/srv/a,b", readOnly: false }],
      });
      expect(shellWords(shell, replaced(unmountable.runCommand))).toEqual(
        PLACEHOLDER_SOURCE.argv.map(replaced),
      );
    },
  );

  /** The words `shell` splits `command` into. */
  function shellWords(shell: string, command: string): Array<string> {
    return execFileSync(shell, ["-c", `printf '%s\\n' ${command}`], {
      encoding: "utf8",
    })
      .split("\n")
      .slice(0, -1);
  }

  /** The command of a cron line with no interval guard, as cron hands it to
   * the shell. */
  function cronCommand(line: string | undefined): string {
    if (line === undefined) throw new Error("no cron line");
    return line.replace(/^(\S+ ){5}/, "").replaceAll("\\%", "%");
  }

  let root: string | undefined;
  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  test.each(SHELLS)(
    "is the folder the installed cron line changes to under %s",
    (shell) => {
      root = mkdtempSync(join(tmpdir(), "alcove-scheduled-run-"));
      const folder = join(root, FOLDER_NAME);
      mkdirSync(folder);
      const line = shownLines(SOURCE).installedCronLine;
      const changeFolder = cronCommand(line)
        .slice(0, cronCommand(line).indexOf(" && "))
        .replace(EXCHANGE_FOLDER_PLACEHOLDER, folder);
      expect(changeFolder).toBe(`cd "${folder}"`);
      const reached = execFileSync(shell, ["-c", `${changeFolder} && pwd -P`], {
        encoding: "utf8",
      });
      expect(reached).toBe(`${realpathSync(folder)}\n`);
    },
  );
});

describe("a hand-off whose argv is not an alcove command line", () => {
  test.each([[["x"]], [["alcove"]], [["alcove", "exchange", "results.csv"]]])(
    "argv %j is a malformed body",
    (argv) => {
      expect(
        parseHandoff({
          mode: "zeroSetup",
          channel: "filedrop",
          usedKeyFile: false,
          keyFileBesideConfiguration: false,
          credentialPasted: false,
          usedSigningIdentity: false,
          pathsAsRead: {
            credential: false,
            sharedDirectory: false,
            signing: false,
          },
          bindPaths: [],
          template: { kind: "command", argv },
        }),
      ).toBeNull();
    },
  );
});

describe("a command-line step the console's copy names", () => {
  const WORKING_FOLDER_MOUNT =
    "--mount type=bind,src=/path/to/your/working-folder,dst=/work";
  const WINDOWS_WORKING_FOLDER_MOUNT =
    '--mount "type=bind,src=C:\\path\\to\\your\\working-folder,dst=/work"';

  test("runs the image once over the operator's working folder, as the operator, in each shell", () => {
    expect(workingFolderCommand(["update"], { image: IMAGE })).toEqual({
      runCommand: `docker run --rm ${DOCKER_USER} ${WORKING_FOLDER_MOUNT} ${IMAGE} update`,
      windowsRunCommand: `docker run --rm ${WINDOWS_WORKING_FOLDER_MOUNT} ${IMAGE} update`,
      podmanRunCommand: `podman run --rm ${PODMAN_USER} ${WORKING_FOLDER_MOUNT} ${IMAGE} update`,
    });
  });

  test("one that asks before it writes gets a terminal, and PowerShell gets its @ argument quoted", () => {
    expect(
      workingFolderCommand(["apply", "@run/alcove.proposed-terms"], {
        image: IMAGE,
        interactive: true,
      }),
    ).toEqual({
      runCommand:
        `docker run --rm -it ${DOCKER_USER} ${WORKING_FOLDER_MOUNT} ` +
        `${IMAGE} apply @run/alcove.proposed-terms`,
      windowsRunCommand:
        `docker run --rm -it ${WINDOWS_WORKING_FOLDER_MOUNT} ` +
        `${IMAGE} apply "@run/alcove.proposed-terms"`,
      podmanRunCommand:
        `podman run --rm -it ${PODMAN_USER} ${WORKING_FOLDER_MOUNT} ` +
        `${IMAGE} apply @run/alcove.proposed-terms`,
    });
  });

  test("a folder outside the working folder is mounted at its own path, from its Windows path on Windows", () => {
    const lines = workingFolderCommand(
      ["fingerprint", "--identity-file", "/path/to/your/secrets-folder/FILE"],
      {
        image: IMAGE,
        bindPaths: [
          {
            path: "/path/to/your/secrets-folder",
            windowsPath: "C:\\path\\to\\your\\secrets-folder",
            readOnly: true,
          },
        ],
      },
    );
    const mount =
      "--mount type=bind,src=/path/to/your/secrets-folder," +
      "dst=/path/to/your/secrets-folder,readonly";
    const args =
      "fingerprint --identity-file /path/to/your/secrets-folder/FILE";
    expect(lines).toEqual({
      runCommand: `docker run --rm ${DOCKER_USER} ${WORKING_FOLDER_MOUNT} ${mount} ${IMAGE} ${args}`,
      windowsRunCommand:
        `docker run --rm ${WINDOWS_WORKING_FOLDER_MOUNT} ` +
        '--mount "type=bind,src=C:\\path\\to\\your\\secrets-folder,' +
        `dst=/path/to/your/secrets-folder,readonly" ${IMAGE} ${args}`,
      podmanRunCommand: `podman run --rm ${PODMAN_USER} ${WORKING_FOLDER_MOUNT} ${mount} ${IMAGE} ${args}`,
    });
  });

  test("the Windows line carries no account option and nothing for a POSIX shell to expand", () => {
    const { windowsRunCommand } = workingFolderCommand(["update"], {
      image: IMAGE,
      interactive: true,
    });
    expect(windowsRunCommand).not.toContain("--user");
    expect(windowsRunCommand).not.toContain("--userns");
    expect(windowsRunCommand).not.toContain("$(");
  });

  test("the shell expands the account to the operator's own ids, as one argument", () => {
    const { runCommand } = workingFolderCommand(["update"], { image: IMAGE });
    const tokens = execFileSync(
      "/bin/sh",
      ["-c", `printf '%s\\n' ${runCommand}`],
      { encoding: "utf8" },
    ).split("\n");
    const operator =
      `${execFileSync("id", ["-u"], { encoding: "utf8" }).trim()}:` +
      execFileSync("id", ["-g"], { encoding: "utf8" }).trim();
    expect(tokens.slice(0, 4)).toEqual(["docker", "run", "--rm", "--user"]);
    expect(tokens[4]).toBe(operator);
  });
});

describe("the docker run argv", () => {
  test("places the terminal flag before the mounts only when asked", () => {
    const source: ScheduledRunSource = {
      argv: ["alcove", "update"],
      bindPaths: [],
      image: IMAGE,
    };
    const tail = [
      "--mount",
      "type=bind,src=/folder,dst=/work",
      IMAGE,
      "update",
    ];
    expect(dockerRunArgv(source, "docker", "/folder")).toEqual([
      "docker",
      "run",
      "--rm",
      ...tail,
    ]);
    expect(
      dockerRunArgv(source, "docker", "/folder", { interactive: true }),
    ).toEqual(["docker", "run", "--rm", "-it", ...tail]);
  });

  test("runs as the operator under the engine asked for, before the mounts", () => {
    const source: ScheduledRunSource = {
      argv: ["alcove", "update"],
      bindPaths: [],
      image: IMAGE,
    };
    const tail = [
      "--mount",
      "type=bind,src=/folder,dst=/work",
      IMAGE,
      "update",
    ];
    expect(
      dockerRunArgv(source, "docker", "/folder", {
        operatorAccountFor: "docker",
      }),
    ).toEqual([
      "docker",
      "run",
      "--rm",
      "--user",
      '"$(id -u):$(id -g)"',
      ...tail,
    ]);
    expect(
      dockerRunArgv(source, "podman", "/folder", {
        operatorAccountFor: "podman",
        interactive: true,
      }),
    ).toEqual([
      "podman",
      "run",
      "--rm",
      "-it",
      "--userns=keep-id:uid=1000,gid=1000",
      ...tail,
    ]);
  });
});

describe("the Task Scheduler lines the Windows CI suite registers", () => {
  // support/maintainer-notes/ScheduleLines.Tests.ps1 registers each line under
  // its shell and runs it, so the file it reads is kept equal to the lines.
  const LINES_FILE =
    "../../../../../support/maintainer-notes/schedule-lines.txt";
  const WINDOWS_FOLDER = "C:\\path\\to\\your\\exchange-folder";
  /** A Tuesday, in the past, so a start date on it is one already passed. */
  const AGREED = "2026-10-06T14:30:00.000Z";

  /** Each line's arguments and interval, and the trigger the suite expects
   * it to register: the interval, the time, the weekday of a weekly line and
   * the start date of a line that states one. */
  const FIXTURES: ReadonlyArray<{
    args: ReadonlyArray<string>;
    intervalDays?: number;
    trigger: string;
  }> = [
    { args: [], trigger: "interval=1 time=02:00 weekday=- start=-" },
    {
      args: ["--csv-delimiter=;", "--identity=Agency A"],
      intervalDays: 1,
      trigger: "interval=1 time=14:30 weekday=- start=-",
    },
    {
      args: ["--csv-delimiter=|", "--identity=Agency A & B"],
      intervalDays: 7,
      trigger: "interval=7 time=14:30 weekday=Tuesday start=-",
    },
    {
      args: ["--csv-delimiter=tab", "--identity=Agency A & B"],
      intervalDays: 3,
      trigger: "interval=3 time=14:30 weekday=- start=2026-10-06",
    },
    {
      args: ["--csv-delimiter=|", "--identity=O'Brien $HOME"],
      intervalDays: 2,
      trigger: "interval=2 time=14:30 weekday=- start=2026-10-06",
    },
  ];

  function entry({
    args,
    intervalDays,
    trigger,
  }: (typeof FIXTURES)[number]): string {
    const source: ScheduledRunSource = {
      argv: ["alcove", "exchange", ...args, "input.csv", "./"],
      bindPaths: [],
      image: IMAGE,
    };
    const schedule =
      intervalDays === undefined
        ? undefined
        : runScheduleFor({ anchor: AGREED, intervalDays });
    const tokens =
      dockerRunArgv(source, "docker", WINDOWS_FOLDER, {
        mountBindPaths: false,
      }) ?? [];
    return [
      "shell: PowerShell",
      `trigger: ${trigger}`,
      dockerTaskSchedulerLine(source, schedule) ?? "",
      ...tokens.slice(1).map((token) => `  [${token}]`),
    ].join("\n");
  }

  test("match the file the suite reads", async () => {
    const entries = FIXTURES.map(entry);
    await expect(`${entries.join("\n\n")}\n`).toMatchFileSnapshot(LINES_FILE);
  });
});
