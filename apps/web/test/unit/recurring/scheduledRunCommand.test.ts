import { execFileSync } from "node:child_process";

import { describe, expect, test } from "vitest";

import {
  dockerCronLine,
  dockerRunCommand,
  dockerTaskSchedulerLine,
  handoffInputName,
  installedCronLine,
  installedRunCommand,
  unmountableBindPathsNotice,
} from "@recurring/scheduledRunCommand";
import {
  dockerRunArgv,
  unmountableBindPaths,
  workingFolderCommand,
} from "@psi/dockerRunCommand";
import { parseHandoff } from "@psi/managed/recurringHandoff";

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

const MOUNTS =
  "--mount type=bind,src=/path/to/your/exchange-folder,dst=/work " +
  "--mount type=bind,src=/path/to/your/shared-directory," +
  "dst=/path/to/your/shared-directory " +
  "--mount type=bind,src=/path/to/your/signing-identity.json," +
  "dst=/path/to/your/signing-identity.json,readonly";

/** The source with `path` as its one bind path. */
function sourceBinding(path: string): ScheduledRunSource {
  return { ...SOURCE, bindPaths: [{ path, readOnly: false }] };
}

describe("the console hand-off's command lines", () => {
  test("the one-off command runs the image over the folder with a per-run result", () => {
    expect(dockerRunCommand(SOURCE)).toBe(
      `docker run --rm ${MOUNTS} ${IMAGE} exchange --log-file=exchange.log ` +
        "clients.csv ./",
    );
  });

  test("the cron line names docker by path and needs no shell expansion or escape", () => {
    const line = dockerCronLine(SOURCE);
    expect(line).toBe(
      `0 2 * * * /usr/bin/docker run --rm ${MOUNTS} ${IMAGE} exchange ` +
        "--log-file=exchange.log clients.csv ./",
    );
    expect(line).not.toMatch(/[$%`\\]/);
  });

  test("the installed-program cron line runs from the exchange folder", () => {
    const line = installedCronLine(SOURCE);
    expect(line).toBe(
      "0 2 * * * cd /path/to/your/exchange-folder && /path/to/alcove " +
        "exchange --log-file=exchange.log clients.csv ./",
    );
    expect(line).not.toMatch(/[$%`\\]/);
  });

  test("a percent sign in an argument is escaped for cron as well", () => {
    const line = installedCronLine({
      ...SOURCE,
      argv: ["alcove", "exchange", "--identity=50% Agency", "in.csv", "r.csv"],
    });
    expect(line).toContain("'--identity=50\\% Agency'");
  });

  test("the Task Scheduler line mounts the folder alone and names each run's result the same way", () => {
    const line = dockerTaskSchedulerLine(SOURCE);
    expect(line).toContain(
      "docker run --rm --mount " +
        "type=bind,src=C:\\path\\to\\your\\exchange-folder,dst=/work " +
        `${IMAGE} exchange --log-file=exchange.log clients.csv ./"`,
    );
    expect(line).not.toContain("shared-directory");
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
      const line = installedCronLine({
        ...SOURCE,
        argv: [
          "alcove",
          "exchange",
          `--outbound-path=${path}`,
          "in.csv",
          "r.csv",
        ],
      });
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
      expect(installedRunCommand(source)).toBe(
        "alcove exchange --log-file=exchange.log clients.csv ./",
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
    expect(installedCronLine(source)).not.toContain("pwned");
    expect(
      unmountableBindPathsNotice(unmountableBindPaths(source.bindPaths)),
    ).toBe(
      "The Docker commands are not shown because /x\\x0a* * * * * touch " +
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
  test("runs the image once over the operator's working folder", () => {
    expect(workingFolderCommand(["update"], { image: IMAGE })).toBe(
      "docker run --rm --mount " +
        "type=bind,src=/path/to/your/working-folder,dst=/work " +
        `${IMAGE} update`,
    );
  });

  test("one that asks before it writes gets a terminal", () => {
    expect(
      workingFolderCommand(["apply", "@run/alcove.proposed-terms"], {
        image: IMAGE,
        interactive: true,
      }),
    ).toBe(
      "docker run --rm -it --mount " +
        "type=bind,src=/path/to/your/working-folder,dst=/work " +
        `${IMAGE} apply @run/alcove.proposed-terms`,
    );
  });

  test("a folder outside the working folder is mounted at its own path", () => {
    expect(
      workingFolderCommand(["fingerprint"], {
        image: IMAGE,
        bindPaths: [{ path: "/path/to/your/secrets-folder", readOnly: false }],
      }),
    ).toContain(
      "--mount type=bind,src=/path/to/your/secrets-folder," +
        "dst=/path/to/your/secrets-folder ",
    );
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
});
