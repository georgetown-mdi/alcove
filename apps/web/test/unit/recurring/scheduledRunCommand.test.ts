import { execFileSync } from "node:child_process";

import { describe, expect, test } from "vitest";

import {
  dockerCronLine,
  dockerRunCommand,
  dockerTaskSchedulerLine,
  handoffInputName,
  installedCronLine,
  installedRunCommand,
  posixCommandLine,
  unmountableBindPaths,
  unmountableBindPathsNotice,
} from "@recurring/scheduledRunCommand";
import { parseHandoff } from "@psi/managed/recurringHandoff";

import type { ScheduledRunSource } from "@recurring/scheduledRunCommand";

// The lines the console's hand-off shows, as the operator pastes them. The
// installed-program cron line is run for real in the console interop suite
// (consoleScheduledHandoff.test.ts); these pin the text of every line.

const IMAGE = "ghcr.io/georgetown-mdi/alcove:1.2.3";

const SOURCE: ScheduledRunSource = {
  argv: [
    "alcove",
    "exchange",
    "--log-file=exchange.log",
    "clients.csv",
    "results.csv",
  ],
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
        "clients.csv results-$(date +%Y%m%d-%H%M%S).csv",
    );
  });

  test("the cron line names docker by path and escapes each percent sign", () => {
    expect(dockerCronLine(SOURCE)).toBe(
      `0 2 * * * /usr/bin/docker run --rm ${MOUNTS} ${IMAGE} exchange ` +
        "--log-file=exchange.log clients.csv " +
        "results-$(date +\\%Y\\%m\\%d-\\%H\\%M\\%S).csv",
    );
  });

  test("the installed-program cron line runs from the exchange folder", () => {
    expect(installedCronLine(SOURCE)).toBe(
      "0 2 * * * cd /path/to/your/exchange-folder && /path/to/alcove " +
        "exchange --log-file=exchange.log clients.csv " +
        "results-$(date +\\%Y\\%m\\%d-\\%H\\%M\\%S).csv",
    );
  });

  test("a percent sign in an argument is escaped for cron as well", () => {
    const line = installedCronLine({
      ...SOURCE,
      argv: ["alcove", "exchange", "--identity=50% Agency", "in.csv", "r.csv"],
    });
    expect(line).toContain("'--identity=50\\% Agency'");
  });

  test("the Task Scheduler line mounts the folder alone and keeps a fixed result", () => {
    const line = dockerTaskSchedulerLine(SOURCE);
    expect(line).toContain(
      "docker run --rm --mount " +
        "type=bind,src=C:\\path\\to\\your\\exchange-folder,dst=/work " +
        `${IMAGE} exchange --log-file=exchange.log clients.csv results.csv`,
    );
    expect(line).not.toContain("shared-directory");
  });

  test("an output name of another shape is kept and quoted", () => {
    expect(posixCommandLine(["alcove", "in.csv", "my results.txt"])).toBe(
      "alcove in.csv 'my results.txt'",
    );
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

  test("a path with a comma, or under /work, leaves out every Docker line", () => {
    for (const [path, reason] of [
      ["/srv/a,b", "comma"],
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
        "alcove exchange --log-file=exchange.log clients.csv " +
          "results-$(date +%Y%m%d-%H%M%S).csv",
      );
    }
    expect(
      unmountableBindPaths([{ path: "/workshop", readOnly: false }]),
    ).toEqual([]);
    expect(
      unmountableBindPathsNotice([{ path: "/srv/a,b", reason: "comma" }]),
    ).toContain("/srv/a,b contains a comma");
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
