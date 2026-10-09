import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "vitest";

import { startBrokerProcess } from "../../signaling/brokerProcess";

import type { AddressInfo } from "node:net";
import type { BrokerProcess } from "../../signaling/brokerProcess";

/**
 * `alcove invite` to a web app address reads the coordination server the app
 * publishes, prints the app's accept link on stdout once that server has
 * accepted its registration, and `alcove accept` given that link writes what
 * the bare invitation code writes. The commands, the broker and the app's
 * static file all run for real; the invite is stopped once its link is read,
 * since no partner is ever going to answer it.
 */

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(here, "../../../src/index.ts");

const PARTY_DEADLINE_MS = 60_000;

let broker: BrokerProcess;
const apps: Array<{ close: () => Promise<void> }> = [];

beforeAll(async () => {
  broker = await startBrokerProcess();
}, 60_000);

afterAll(async () => {
  await broker.stop();
});

/** A web app at a loopback address whose /alcove.json answers `document`
 * (`undefined`: a 404). Resolves to the app's address. */
async function webApp(document: unknown): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url === "/alcove.json" && document !== undefined) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(document));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  apps.push({
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

const INPUT_CSV =
  "ssn,last_name,first_name,date_of_birth\n" +
  "123456789,SMITH,JOHN,19900115\n";

let work: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-accept-link-"));
});

afterEach(async () => {
  fs.rmSync(work, { recursive: true, force: true });
  for (const app of apps.splice(0)) await app.close();
});

/** The first line `alcove invite` at `address` writes to stdout, the process
 * then stopped; or, when it exits first, its exit code and stdout. tsx is
 * loaded in-process so the kill reaches the CLI itself, not a launcher that
 * would leave it running. */
function inviteLink(
  cwd: string,
  address: string,
): Promise<string | { exitCode: number | null; stdout: string }> {
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
      address,
      "input.csv",
    ],
    { cwd, stdio: ["ignore", "pipe", "ignore"] },
  );
  const deadline = setTimeout(() => child.kill("SIGKILL"), PARTY_DEADLINE_MS);
  return new Promise((resolve) => {
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
      resolve({ exitCode, stdout });
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
    const address = await webApp({
      signaling_server: `ws://127.0.0.1:${broker.port}${broker.path}/`,
    });
    const acceptLinkPrefix = `${address}accept#`;
    const link = await inviteLink(work, address);
    if (typeof link !== "string")
      throw new Error(`invite ended (${link.exitCode}) before printing a line`);
    expect(link.startsWith(acceptLinkPrefix)).toBe(true);
    const code = link.slice(acceptLinkPrefix.length);

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
    expect(linkRun.stderr).not.toContain(acceptLinkPrefix);
    expect(fs.readFileSync(path.join(byLink, "alcove.yaml"), "utf8")).toContain(
      `port: ${broker.port}`,
    );
  },
);

test(
  "an invite whose published server does not answer prints nothing",
  { timeout: 2 * PARTY_DEADLINE_MS },
  async () => {
    fs.writeFileSync(path.join(work, "input.csv"), INPUT_CSV);
    // Port 9 (discard): nothing listens there on a test host.
    const address = await webApp({ signaling_server: "ws://127.0.0.1:9/api/" });
    const result = await inviteLink(work, address);
    expect(result).toEqual({ exitCode: 69, stdout: "" });
  },
);

test(
  "an invite at an app that publishes no server is refused before printing",
  { timeout: 2 * PARTY_DEADLINE_MS },
  async () => {
    fs.writeFileSync(path.join(work, "input.csv"), INPUT_CSV);
    const result = await inviteLink(work, await webApp(undefined));
    expect(result).toEqual({ exitCode: 64, stdout: "" });
    expect(fs.existsSync(path.join(work, ".alcove.key"))).toBe(false);
  },
);
