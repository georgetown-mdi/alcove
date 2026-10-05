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

test("the dev script starts the console server with the client and shuts it down on SIGTERM", async () => {
  const dataRoot = scratchDir("console-dev-root");
  // `exec env` makes the server the shell's own process, so the signal below
  // reaches it rather than the shell.
  child = spawn("sh", ["-c", `exec env ${devScript()}`], {
    cwd: APP_ROOT,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !name.startsWith("VITEST"),
        ),
      ),
      PORT: "0",
      JOB_DATA_ROOT: dataRoot,
      JOB_RENDEZVOUS_DIR: scratchDir("console-dev-rvz"),
      JOB_SFTP_CREDENTIAL_DIR: path.join(
        scratchDir("console-dev-scratch"),
        "credentials",
      ),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolve) =>
    child!.on("exit", (code) => resolve(code)),
  );

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the dev server did not start:\n${output}`)),
      60_000,
    );
    const check = (): void => {
      const match = /Listening on (http:\/\/\S+)/.exec(output);
      if (match === null) return;
      clearTimeout(timer);
      resolve(match[1]);
    };
    child!.stdout!.on("data", check);
    child!.stderr!.on("data", check);
    void exited.then(() =>
      reject(new Error(`the dev server exited:\n${output}`)),
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

  child.kill("SIGTERM");
  expect(await exited).toBe(0);
}, 90_000);
