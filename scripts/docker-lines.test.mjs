import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { SHARED_FOLDER_MOUNT_FLAGS } from "../apps/web/src/console/filedropRendezvousChoice.ts";

import { fencedBlocks } from "./lib/markdownFences.mjs";

// The docker lines README.md and docs/CONSOLE.md print, and the one the
// console's shared-folder notice gives, as each shell hands them to docker. A
// line written on one line is for every shell: it is split here under bash and
// sh, and written with the arguments it means to the file the Windows
// PowerShell 5.1 suite (support/maintainer-notes/DockerLines.Tests.ps1) runs;
// `npx vitest run -u` rewrites that file. A line continued with a trailing
// backslash is for a Mac or Linux shell only, and the document says so above it.

const README = fileURLToPath(new URL("../README.md", import.meta.url));
const CONSOLE_DOC = fileURLToPath(
  new URL("../docs/CONSOLE.md", import.meta.url),
);
const COMMANDS_FILE = "../support/maintainer-notes/docker-lines.txt";

/** The stand-in for the folder a command runs from, in the commands file. */
const WORKING_FOLDER = "<working folder>";

const readmeCommands = () => documentCommands(README);

/** Every docker command in a markdown file's sh blocks, each as printed, with
 * `lineAbove` the nearest non-blank line above its block. */
function documentCommands(path) {
  const source = readFileSync(path, "utf8");
  const lines = source.split("\n");
  return fencedBlocks(source)
    .filter((block) => block.language === "sh")
    .flatMap(({ code, startLine }) => {
      let above = startLine - 3;
      while (above >= 0 && lines[above].trim() === "") above--;
      const lineAbove = above >= 0 ? lines[above] : "";
      const commands = [];
      let current;
      for (const raw of code.split("\n")) {
        const line = raw.trim();
        if (current === undefined && !line.startsWith("docker ")) continue;
        current = current === undefined ? line : `${current}\n${line}`;
        if (!line.endsWith("\\")) {
          commands.push({ command: current, lineAbove });
          current = undefined;
        }
      }
      return commands;
    });
}

/** The console's own start command from README.md with the notice's flags
 * added just before the image name, as the notice tells the operator to. */
function consoleCommandWithSharedFolder() {
  const start = readmeCommands().find(
    ({ command }) =>
      !command.includes("\n") &&
      command.endsWith(" serve") &&
      !command.includes("JOB_RENDEZVOUS"),
  );
  expect(start).toBeDefined();
  const imageAt = start.command.indexOf(" docker.io/");
  expect(imageAt).toBeGreaterThan(0);
  return (
    `${start.command.slice(0, imageAt)} ${SHARED_FOLDER_MOUNT_FLAGS}` +
    start.command.slice(imageAt)
  );
}

const expandWorkingFolder = (text) =>
  text.replace(/\$\{PWD\}|\$PWD(?![A-Za-z0-9_])/g, WORKING_FOLDER);

/**
 * The words of a command after `docker`: what the reader means docker to
 * receive. Quotes group and are removed, a backslash outside quotes escapes the
 * next character, and `${PWD}` or `$PWD` outside single quotes is the working
 * folder, kept inside its word wherever it appears. A backslash inside double
 * quotes is kept, which is all the lines read here need.
 */
function intendedArguments(command) {
  const text = command.replace(/\\\n/g, " ");
  const words = [];
  let word;
  const append = (part) => {
    word = (word ?? "") + part;
  };
  let at = 0;
  while (at < text.length) {
    const character = text[at];
    if (/\s/.test(character)) {
      if (word !== undefined) words.push(word);
      word = undefined;
      at++;
    } else if (character === "'" || character === '"') {
      const end = text.indexOf(character, at + 1);
      expect(end, `an unclosed quote in: ${command}`).toBeGreaterThan(at);
      const quoted = text.slice(at + 1, end);
      append(character === '"' ? expandWorkingFolder(quoted) : quoted);
      at = end + 1;
    } else if (character === "\\") {
      append(text[at + 1] ?? "");
      at += 2;
    } else {
      let end = at;
      while (end < text.length && !/[\s'"\\]/.test(text[end])) end++;
      append(expandWorkingFolder(text.slice(at, end)));
      at = end;
    }
  }
  if (word !== undefined) words.push(word);
  expect(words[0], `not a docker command: ${command}`).toBe("docker");
  return words.slice(1);
}

/** Every command the documents print, then the console's with its notice's
 * flags added. */
const allCommands = () => [
  ...readmeCommands().map(({ command }) => command),
  consoleCommandWithSharedFolder(),
  ...documentCommands(CONSOLE_DOC).map(({ command }) => command),
];

/** Every command printed on one line, each once: the ones the PowerShell
 * suite runs. */
function oneLineCommands() {
  return [
    ...new Set(allCommands().filter((command) => !command.includes("\n"))),
  ];
}

describe("the README, docs/CONSOLE.md, and console docker lines", () => {
  test("a command continued over lines is labeled for a Mac or Linux shell", () => {
    const unlabeled = [...readmeCommands(), ...documentCommands(CONSOLE_DOC)]
      .filter(({ command }) => command.includes("\n"))
      .filter(({ lineAbove }) => !/\b(Mac|Linux|bash)\b/.test(lineAbove))
      .map(({ command }) => command.split("\n")[0]);
    expect(unlabeled).toEqual([]);
  });

  test("the console's shared-folder flags drop into a one-line command", () => {
    expect(consoleCommandWithSharedFolder()).not.toContain("\n");
  });

  test("match the lines the Windows CI suite runs", async () => {
    const text = oneLineCommands()
      .map((command) =>
        [
          command,
          ...intendedArguments(command).map((argument) => `  [${argument}]`),
        ].join("\n"),
      )
      .join("\n\n");
    await expect(`${text}\n`).toMatchFileSnapshot(COMMANDS_FILE);
  });

  test.each(["bash", "sh"])(
    "%s hands docker each word as one argument, from a folder with a space",
    (shell) => {
      const folder = realpathSync(
        mkdtempSync(join(tmpdir(), "alcove docker lines ")),
      );
      try {
        for (const command of allCommands()) {
          // A docker stand-in printing each argument it receives in brackets,
          // so an empty or space-edged one stays visible.
          const script =
            "docker() { for argument in \"$@\"; do printf '[%s]\\n' " +
            `"$argument"; done; }; ${command}`;
          const run = spawnSync(shell, ["-c", script], {
            cwd: folder,
            env: { ...process.env, PWD: folder },
            encoding: "utf8",
          });
          expect(run.status, run.stderr).toBe(0);
          const received = run.stdout
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => line.replace(/^\[(.*)\]$/, "$1"));
          expect(received, command).toEqual(
            intendedArguments(command).map((argument) =>
              argument.replaceAll(WORKING_FOLDER, folder),
            ),
          );
        }
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
  );
});
