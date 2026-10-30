import { execFileSync } from "node:child_process";

import { describe, expect, test } from "vitest";

import {
  IDENTITY_NAME_PLACEHOLDER,
  SECRETS_FOLDER_PLACEHOLDER,
  WORKING_FOLDER_PATH_PLACEHOLDERS,
  WORKING_FOLDER_PLACEHOLDER,
  workingFolderCommand,
} from "@psi/dockerRunCommand";
import {
  PICKED_IDENTITY_CREATE_COMMAND,
  fingerprintCommand,
} from "@psi/receiptsModel";
import { PASTED_TEXT_ESCAPING_NOTE } from "@recurring/scheduledRunCommand";

import type { WorkingFolderCommandLines } from "@psi/dockerRunCommand";

/** The file name a picked-identity command names inside the secrets folder. */
const FILE_PLACEHOLDER = "FILE";

/** Each one-off command the console's copy names, by what it does. */
const COMMANDS: Record<string, WorkingFolderCommandLines> = {
  update: workingFolderCommand(["update"]),
  "apply a run's proposal": workingFolderCommand(
    ["apply", "@job-1/alcove.proposed-terms"],
    { interactive: true },
  ),
  "fingerprint the default identity": fingerprintCommand(false),
  "fingerprint a picked identity": fingerprintCommand(true),
  "create a picked identity": PICKED_IDENTITY_CREATE_COMMAND,
  "replace a picked identity": fingerprintCommand(true, [
    "--force",
    "--identity",
    IDENTITY_NAME_PLACEHOLDER,
  ]),
};

/** What an operator puts in place of each placeholder: a space and a single
 * quote in each. */
const REPLACEMENTS: ReadonlyArray<[string, string]> = [
  [WORKING_FOLDER_PLACEHOLDER, "/home/pat/Alcove Working's"],
  [SECRETS_FOLDER_PLACEHOLDER, "/home/pat/Alcove Secrets's"],
  [FILE_PLACEHOLDER, "pat's key.json"],
  [IDENTITY_NAME_PLACEHOLDER, "Pat O'Neil, Example Agency"],
];

/** The arguments `/bin/sh` splits `line` into. */
function shellArguments(line: string): Array<string> {
  return execFileSync("/bin/sh", ["-c", `printf '%s\\n' ${line}`], {
    encoding: "utf8",
  })
    .split("\n")
    .slice(0, -1);
}

const POSIX_LINES = Object.entries(COMMANDS).flatMap(
  ([name, { runCommand, podmanRunCommand }]) => [
    [`${name} with Docker`, runCommand],
    [`${name} with rootless Podman`, podmanRunCommand],
  ],
);

describe("a one-off command over the working folder", () => {
  test.each(POSIX_LINES)(
    "%s keeps each pasted path and name one argument under sh",
    (_name, line) => {
      const placeholderArguments = shellArguments(line);
      for (const [placeholder, replacement] of REPLACEMENTS) {
        expect(
          shellArguments(line.replaceAll(placeholder, replacement)),
          placeholder,
        ).toEqual(
          placeholderArguments.map((argument) =>
            argument.replaceAll(placeholder, replacement),
          ),
        );
      }
    },
  );

  test('a pasted path keeps its $, `, \\, and " under sh when each has the \\ the guide names', () => {
    const path = '/home/pat/a$HOME`id`\\b"c';
    const escaped = path.replace(/["$`\\]/g, "\\$&");
    const line = COMMANDS.update.runCommand.replaceAll(
      WORKING_FOLDER_PLACEHOLDER,
      escaped,
    );
    expect(PASTED_TEXT_ESCAPING_NOTE).toContain('$, `, \\, or "');
    expect(shellArguments(line)).toContain(`type=bind,src=${path},dst=/work`);
  });

  test("names no placeholder the quoting does not know", () => {
    const known = new Set([
      ...WORKING_FOLDER_PATH_PLACEHOLDERS,
      FILE_PLACEHOLDER,
      IDENTITY_NAME_PLACEHOLDER,
    ]);
    const placeholderShaped =
      /\/path\/to\/your\/[\w-]+|C:\\path\\to\\your\\[\w-]+|\b[A-Z]{2,}\b/g;
    for (const lines of Object.values(COMMANDS))
      for (const line of Object.values(lines))
        for (const [found] of line.matchAll(placeholderShaped))
          expect(known, line).toContain(found);
  });

  // No PowerShell runs here, so the Windows line is checked by its quotes.
  test.each(Object.entries(COMMANDS))(
    "%s on Windows double-quotes each token holding a placeholder",
    (_name, { windowsRunCommand }) => {
      const tokens = windowsRunCommand.match(/"(?:[^"]|"")*"|[^\s"]+/g) ?? [];
      for (const token of tokens)
        if (
          REPLACEMENTS.some(([placeholder]) => token.includes(placeholder)) ||
          WORKING_FOLDER_PATH_PLACEHOLDERS.some((placeholder) =>
            token.includes(placeholder),
          )
        )
          expect(token, windowsRunCommand).toMatch(/^".*"$/);
    },
  );
});
