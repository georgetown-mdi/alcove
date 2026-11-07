import { spawnSync } from "node:child_process";

import { expect, test } from "vitest";

import { resolveAcceptPositionals } from "../../../src/commands/accept";
import { partnerAcceptInstructions } from "../../../src/commands/invite";
import {
  BOOTSTRAP_CREDENTIAL_FLAGS,
  commandLineLiteralCredentials,
} from "../../../src/literalCredentials";

const TEMPLATES = [
  { name: "offline", online: undefined },
  {
    name: "web app link",
    online: { url: new URL("https://app.example.org/"), channel: "webrtc" },
  },
  {
    name: "WebRTC",
    online: { url: new URL("wss://peers.example.org/psi"), channel: "webrtc" },
  },
  {
    name: "SFTP server",
    online: { url: new URL("sftp://host/drop"), channel: "sftp" },
  },
  {
    name: "shared folder",
    online: { url: new URL("file:///srv/drop"), channel: "filedrop" },
  },
] as const;

/** The template's accept command with each placeholder filled in as a partner
 * would fill it. */
function filledAcceptCommand(instructions: string): string {
  const command = instructions
    .split("\n")
    .find((line) => line.startsWith("  alcove accept "));
  expect(command).toBeDefined();
  const filled = (command ?? "")
    .trim()
    .replace("<YOUR NAME, YOUR ORGANIZATION>", '"Agency B"')
    .replace("<YOUR PATH TO THE SHARED FOLDER>", "/srv/drop")
    .replace("<INVITATION FILE>", "invitation.txt")
    .replace("<INPUT_FILE>", "input.csv");
  expect(filled).not.toMatch(/[<>]/);
  return filled;
}

/** The words a POSIX shell hands `alcove` for `command`, from a stand-in
 * printing each argument it receives on a line of its own. */
function shellWords(command: string): Array<string> {
  const run = spawnSync(
    "sh",
    [
      "-c",
      `alcove() { for argument in "$@"; do printf '%s\\n' "$argument"; done; }; ${command}`,
    ],
    { encoding: "utf8" },
  );
  expect(run.status, run.stderr).toBe(0);
  return run.stdout.split("\n").filter((line) => line.length > 0);
}

test.each(TEMPLATES)(
  "the $name accept template tells the partner to save the invitation in the file it names",
  ({ online }) => {
    const instructions = partnerAcceptInstructions(online);
    expect(instructions).toContain(' "@<INVITATION FILE>" <INPUT_FILE>\n');
    expect(instructions).toMatch(
      /after saving the (invitation|link) printed above in <INVITATION FILE>\./,
    );
  },
);

test.skipIf(process.platform === "win32").each(TEMPLATES)(
  "following the $name accept template draws no command-line credential notice",
  ({ online }) => {
    const words = shellWords(
      filledAcceptCommand(partnerAcceptInstructions(online)),
    );
    expect(words.slice(0, 3)).toEqual(["accept", "--identity", "Agency B"]);
    const resolved = resolveAcceptPositionals(words.slice(3));
    expect(resolved.invitation).toBe("@invitation.txt");
    const url = resolved.mode === "online" ? resolved.url : undefined;
    const argv = { identity: "Agency B" };
    expect(
      commandLineLiteralCredentials(argv, url, BOOTSTRAP_CREDENTIAL_FLAGS, {
        value: resolved.invitation,
      }),
    ).toBeUndefined();
    // The same command with the invitation typed in place of its file does
    // draw the notice, so the check above is not vacuous.
    expect(
      commandLineLiteralCredentials(argv, url, BOOTSTRAP_CREDENTIAL_FLAGS, {
        value: "invitation.txt",
      }),
    ).toBeDefined();
  },
);
