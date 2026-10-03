import { describe, expect, test } from "vitest";

import {
  dockerCronLine,
  dockerRunCommand,
  dockerTaskSchedulerLine,
  handoffInputName,
  installedCronLine,
  posixCommandLine,
} from "@recurring/scheduledRunCommand";

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
  "-v /path/to/your/exchange-folder:/work " +
  "-v /path/to/your/shared-directory:/path/to/your/shared-directory " +
  "-v /path/to/your/signing-identity.json:" +
  "/path/to/your/signing-identity.json:ro";

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
      "docker run --rm -v C:\\path\\to\\your\\exchange-folder:/work " +
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
    expect(() => handoffInputName(["docker", "a", "b"])).toThrow();
  });
});
