import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, expect, test } from "vitest";

/**
 * `alcove invite` to a web app address prints the app's accept link on stdout,
 * and `alcove accept` given that link writes what the bare invitation code
 * writes. Both commands run as real child processes; the invite is stopped
 * once its link is read, since no partner is ever going to answer it.
 */

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(here, "../../../src/index.ts");

/** An address nothing listens on: the invite prints its link before it dials. */
const WEB_APP_ADDRESS = "https://127.0.0.1:9/";
const ACCEPT_LINK_PREFIX = "https://127.0.0.1:9/accept#";

const PARTY_DEADLINE_MS = 60_000;

const INPUT_CSV =
  "ssn,last_name,first_name,date_of_birth\n" +
  "123456789,SMITH,JOHN,19900115\n";

let work: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-accept-link-"));
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

/** The first line `alcove invite` writes to stdout; the process is then
 * stopped. tsx is loaded in-process so the kill reaches the CLI itself, not a
 * launcher that would leave it running. */
function inviteLink(cwd: string): Promise<string> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      require.resolve("tsx"),
      cliEntry,
      "invite",
      "--identity",
      "Agency A",
      "--accept-timeout",
      "30s",
      "--log-level",
      "silent",
      WEB_APP_ADDRESS,
      "input.csv",
    ],
    { cwd, stdio: ["ignore", "pipe", "ignore"] },
  );
  const deadline = setTimeout(() => child.kill("SIGKILL"), PARTY_DEADLINE_MS);
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(deadline);
      child.kill("SIGKILL");
      resolve(stdout.slice(0, newline));
    });
    child.once("close", (exitCode) => {
      clearTimeout(deadline);
      reject(new Error(`invite ended (${exitCode}) before printing a line`));
    });
  });
}

/** Run `alcove accept` in `cwd` on `invitation` with advance consent and no
 * input file, so it writes the configuration and key file and dials nothing. */
function accept(
  cwd: string,
  invitation: string,
): Promise<{ exitCode: number | null; stderr: string }> {
  const child = spawn(
    process.execPath,
    [
      require.resolve("tsx/cli"),
      cliEntry,
      "accept",
      "--identity",
      "Agency B",
      "--consent-to-terms",
      invitation,
    ],
    { cwd, stdio: ["ignore", "ignore", "pipe"] },
  );
  const deadline = setTimeout(() => child.kill("SIGKILL"), PARTY_DEADLINE_MS);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve) => {
    child.once("close", (exitCode) => {
      clearTimeout(deadline);
      resolve({ exitCode, stderr });
    });
  });
}

test(
  "accept given the invite's printed link writes what the bare code writes",
  { timeout: 3 * PARTY_DEADLINE_MS },
  async () => {
    fs.writeFileSync(path.join(work, "input.csv"), INPUT_CSV);
    const link = await inviteLink(work);
    expect(link.startsWith(ACCEPT_LINK_PREFIX)).toBe(true);
    const code = link.slice(ACCEPT_LINK_PREFIX.length);

    const byLink = path.join(work, "by-link");
    const byCode = path.join(work, "by-code");
    fs.mkdirSync(byLink);
    fs.mkdirSync(byCode);
    const [linkRun, codeRun] = await Promise.all([
      accept(byLink, link),
      accept(byCode, code),
    ]);
    expect(linkRun.exitCode, linkRun.stderr).toBe(0);
    expect(codeRun.exitCode, codeRun.stderr).toBe(0);

    for (const name of ["alcove.yaml", ".alcove.key"]) {
      expect(fs.readFileSync(path.join(byLink, name), "utf8")).toBe(
        fs.readFileSync(path.join(byCode, name), "utf8"),
      );
    }
    expect(linkRun.stderr).not.toContain("127.0.0.1:9/accept");
  },
);
