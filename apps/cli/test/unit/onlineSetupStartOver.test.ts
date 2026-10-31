import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import YAML from "yaml";
import { parseExchangeSpec, PeerAbortError } from "@alcove/core";

// An online invite or accept that wrote its configuration and then read its
// partner's abort tells the operator how to start over from a new invitation
// if the partner's run asks for one. Each test here runs the online command
// through that ending, then follows the step it names with the configuration
// the run wrote, and the CLI accepts it.

vi.mock("../../src/protocol", async (importActual) => {
  const actual = await importActual<typeof import("../../src/protocol")>();
  return { ...actual, runProtocol: vi.fn() };
});

import { handler as acceptHandler } from "../../src/commands/accept";
import { handler as inviteHandler } from "../../src/commands/invite";
import { saveKeyFile } from "../../src/keyFile";
import { generateSharedSecret } from "../../src/onlineBootstrap";
import { runProtocol, type RunProtocolOptions } from "../../src/protocol";
import { captureProcessExit } from "../exitCapture";
import { captureStdio } from "../loggingTestSupport";

const PARTNER_ENDED = "Your partner ended the exchange";

let dir: string;
let input: string;
let dropUrl: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-start-over-"));
  input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  const drop = path.join(dir, "drop");
  fs.mkdirSync(drop);
  dropUrl = pathToFileURL(drop).href;
  // The exchange saves the rotated key, runs the configuration step, and then
  // reads the partner's abort.
  vi.mocked(runProtocol).mockImplementation((async (
    options: RunProtocolOptions,
  ) => {
    if (options.auth?.keyFilePath !== undefined)
      saveKeyFile(options.auth.keyFilePath, {
        sharedSecret: generateSharedSecret(),
      });
    await options.onlineSetup?.writeConfig();
    throw new PeerAbortError();
  }) as never);
});

afterEach(() => {
  vi.mocked(runProtocol).mockReset();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Run a command handler, returning the exit code it stopped on (undefined when
 * it returned), what it printed with console.log, where an invitation goes,
 * and what it wrote to stderr.
 */
async function runCommand(
  handler: (argv: Arguments) => Promise<void>,
  argv: Record<string, unknown>,
): Promise<{
  exitCode: number | undefined;
  printed: string[];
  stderr: string;
}> {
  const printed: string[] = [];
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...line: unknown[]) => {
      printed.push(line.map(String).join(" "));
    });
  const exit = captureProcessExit();
  const stdio = captureStdio();
  let exitCode: number | undefined;
  try {
    await handler({
      _: [],
      $0: "alcove",
      "log-level": "error",
      record: false,
      ...argv,
    } as unknown as Arguments).catch((err: unknown) => {
      const match = /^exit:(\d+)$/.exec((err as Error).message);
      if (match === null) throw err;
      exitCode = Number(match[1]);
    });
  } finally {
    stdio.restore();
    exit.mockRestore();
    logSpy.mockRestore();
  }
  return { exitCode, printed, stderr: stdio.stderrWrites.join("") };
}

/** The one note a run logged about its partner ending the exchange. */
function partnerEndedNote(stderr: string): string {
  const notes = stderr
    .split("\n")
    .filter((line) => line.includes(PARTNER_ENDED));
  expect(notes).toHaveLength(1);
  expect(stderr).not.toContain("recover without re-inviting");
  return notes[0];
}

test("an online inviter whose partner ended the run after its configuration step starts over with the offline invite", async () => {
  const configFile = path.join(dir, "alcove.yaml");
  const keyFile = path.join(dir, ".alcove.key");
  const files = { "config-file": configFile, "key-file": keyFile };

  const online = await runCommand(inviteHandler, {
    args: [dropUrl, input],
    identity: "Agency A",
    ...files,
  });
  expect(online.exitCode).toBe(76);
  expect(fs.existsSync(configFile)).toBe(true);
  expect(partnerEndedNote(online.stderr)).toContain(
    `delete ${keyFile}, then run 'alcove invite' without a URL to make a new invitation from ${configFile}.`,
  );

  // The key file has to go first: the invite refuses one already there.
  expect(
    (await runCommand(inviteHandler, { args: [], ...files })).exitCode,
  ).toBe(64);

  fs.rmSync(keyFile);
  const restarted = await runCommand(inviteHandler, { args: [], ...files });
  expect(restarted.exitCode).toBeUndefined();
  expect(fs.existsSync(keyFile)).toBe(true);
  expect(restarted.printed.length).toBeGreaterThan(0);
});

test("an online acceptor whose partner ended the run after its configuration step starts over by accepting the new invitation", async () => {
  // The partner invites from its input file, as an inviter with no
  // configuration does, both times.
  const partnerInvitation = async (name: string): Promise<string> => {
    const partnerDir = path.join(dir, name);
    fs.mkdirSync(partnerDir);
    const made = await runCommand(inviteHandler, {
      args: [input],
      identity: "Agency A",
      "config-file": path.join(partnerDir, "alcove.yaml"),
      "key-file": path.join(partnerDir, ".alcove.key"),
    });
    expect(made.exitCode).toBeUndefined();
    const invitation = made.printed.at(-1);
    expect(invitation).toBeTypeOf("string");
    return invitation as string;
  };
  const configFile = path.join(dir, "alcove.yaml");
  const keyFile = path.join(dir, ".alcove.key");
  const files = { "config-file": configFile, "key-file": keyFile };

  const online = await runCommand(acceptHandler, {
    args: [dropUrl, await partnerInvitation("partner-first"), input],
    identity: "Agency B",
    "consent-to-terms": true,
    ...files,
  });
  expect(online.exitCode).toBe(76);
  expect(fs.existsSync(configFile)).toBe(true);
  expect(partnerEndedNote(online.stderr)).toContain(
    `delete ${keyFile}, then accept the new invitation your partner sends with 'alcove accept'.`,
  );

  fs.rmSync(keyFile);
  const accepted = await runCommand(acceptHandler, {
    args: [await partnerInvitation("partner-again")],
    "consent-to-terms": true,
    ...files,
  });
  expect(accepted.exitCode).toBeUndefined();
  expect(fs.existsSync(keyFile)).toBe(true);
  // The acceptance kept the configuration the online run wrote.
  expect(
    parseExchangeSpec(YAML.parse(fs.readFileSync(configFile, "utf8")))
      .linkageTerms.identity,
  ).toBe("Agency B");
});
