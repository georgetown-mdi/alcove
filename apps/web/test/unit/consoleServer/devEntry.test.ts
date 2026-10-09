import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { afterEach, expect, test } from "vitest";

import { resetConsoleServerTests, scratchDir } from "./serverHarness";

import type { ChildProcess } from "node:child_process";

const APP_ROOT = path.resolve(import.meta.dirname, "../../..");
const SCRIPT_NAME = "dev:console";

let child: ChildProcess | undefined;

afterEach(async () => {
  child?.kill("SIGKILL");
  child = undefined;
  await resetConsoleServerTests();
});

/** The package script's command line, as npm would hand it to the shell. */
function devScript(): string {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8"),
  ) as { scripts: Partial<Record<string, string>> };
  const script = manifest.scripts[SCRIPT_NAME];
  if (script === undefined) throw new Error(`no ${SCRIPT_NAME} script`);
  return script;
}

/** A dev server spawned from the package script. */
interface DevRun {
  process: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
}

/** Spawn the dev script on a free port, with a data root and a rendezvous
 * mount of its own and `env` over the environment vitest runs in. */
function spawnDev(env: Record<string, string>): DevRun {
  // `exec env` makes the server the shell's own process, so a signal reaches
  // it rather than the shell.
  const spawned = spawn("sh", ["-c", `exec env ${devScript()}`], {
    cwd: APP_ROOT,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !name.startsWith("VITEST"),
        ),
      ),
      PORT: "0",
      JOB_DATA_ROOT: scratchDir("console-dev-root"),
      JOB_RENDEZVOUS_DIR: scratchDir("console-dev-rvz"),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = spawned;
  let output = "";
  spawned.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  spawned.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolve) =>
    spawned.on("exit", (code) => resolve(code)),
  );
  return { process: spawned, exited, output: () => output };
}

test("the dev script starts the console server with the client and shuts it down on SIGTERM", async () => {
  const dev = spawnDev({
    JOB_SFTP_CREDENTIAL_DIR: path.join(
      scratchDir("console-dev-scratch"),
      "credentials",
    ),
  });

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the dev server did not start:\n${dev.output()}`)),
      60_000,
    );
    const check = (): void => {
      const match = /Listening on (http:\/\/\S+)/.exec(dev.output());
      if (match === null) return;
      clearTimeout(timer);
      resolve(match[1]);
    };
    dev.process.stdout!.on("data", check);
    dev.process.stderr!.on("data", check);
    void dev.exited.then(() =>
      reject(new Error(`the dev server exited:\n${dev.output()}`)),
    );
  });
  expect(new URL(url).hostname).toBe("127.0.0.1");

  const slot = await fetch(`${url}/api/jobs/slot`);
  expect(slot.status).toBe(200);
  await slot.body?.cancel();

  for (const clientPath of ["/", "/exchange"]) {
    const page = await fetch(`${url}${clientPath}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(await page.text()).toContain('src="/src/spaClient.tsx"');
  }

  const unknownApi = await fetch(`${url}/api/nope`);
  expect(unknownApi.status).toBe(404);
  expect(await unknownApi.text()).toBe("");

  dev.process.kill("SIGTERM");
  expect(await dev.exited).toBe(0);
}, 90_000);

test("the dev script prints a boot refusal as one line and exits 1", async () => {
  const notADirectory = path.join(scratchDir("console-dev-scratch"), "file");
  fs.writeFileSync(notADirectory, "");
  const credentialDir = path.join(notADirectory, "credentials");
  const dev = spawnDev({ JOB_SFTP_CREDENTIAL_DIR: credentialDir });

  expect(await dev.exited).toBe(1);
  expect(dev.output().trim().split("\n")).toEqual([
    "The console did not start: the pasted-credential scratch directory " +
      `${credentialDir} could not be created (ENOTDIR); set ` +
      "JOB_SFTP_CREDENTIAL_DIR to a directory the account this server runs " +
      "as can create, outside every mounted folder",
  ]);
}, 90_000);
