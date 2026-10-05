import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium } from "playwright";

import type { ChildProcess } from "node:child_process";

// The integration project rather than the unit one: the case launches a real
// Chromium, which CI installs (eb_build_and_test.yaml) before this project
// runs. It builds the console client and server itself, into a directory of
// its own, through the package scripts an operator runs.

const APP_ROOT = path.resolve(import.meta.dirname, "../..");

let scratch: string;
let server: ChildProcess | undefined;
let url: string;

/** This process's environment without vitest's own variables, so a build or
 * server started from here behaves as one started from a shell. */
function shellEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.startsWith("VITEST"),
      ),
    ),
    ...extra,
  };
}

/** Run `command` in the app directory and resolve once it exits 0. */
function run(command: string, args: Array<string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: APP_ROOT,
      env: shellEnv({}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${args.join(" ")} exited ${code}:\n${output}`)),
    );
  });
}

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "console-bundle-"));
  const clientDir = path.join(scratch, "dist", "console");
  const serverDir = path.join(scratch, "dist", "console-server");
  await run("npm", ["run", "build:console", "--", "--outDir", clientDir]);
  await run("npm", [
    "run",
    "build:console-server",
    "--",
    "--outDir",
    serverDir,
  ]);
  for (const dir of ["data", "rendezvous"])
    fs.mkdirSync(path.join(scratch, dir));

  server = spawn("node", [path.join(serverDir, "main.mjs")], {
    cwd: scratch,
    env: shellEnv({
      VITE_DEPLOYMENT_PROFILE: "console",
      PORT: "0",
      HOST: "127.0.0.1",
      JOB_DATA_ROOT: path.join(scratch, "data"),
      JOB_RENDEZVOUS_DIR: path.join(scratch, "rendezvous"),
      JOB_SFTP_CREDENTIAL_DIR: path.join(scratch, "credentials"),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  url = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`the console server did not start:\n${output}`)),
      30_000,
    );
    const check = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = /Listening on (http:\/\/\S+)/.exec(output);
      if (match === null) return;
      clearTimeout(timer);
      resolve(match[1]);
    };
    server!.stdout!.on("data", check);
    server!.stderr!.on("data", check);
    server!.on("exit", () =>
      reject(new Error(`the console server exited:\n${output}`)),
    );
  });
}, 240_000);

afterAll(() => {
  server?.kill("SIGKILL");
  fs.rmSync(scratch, { recursive: true, force: true });
});

test("the built console client renders the console's routes from the built server", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const pageErrors: Array<string> = [];
    const failedResponses: Array<string> = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      if (response.url().startsWith(url) && response.status() >= 400)
        failedResponses.push(`${response.status()} ${response.url()}`);
    });

    await page.goto(`${url}/`);
    await page
      .getByText("Start a private data exchange")
      .waitFor({ timeout: 30_000 });
    expect(await page.title()).toBe("Alcove - encrypted matching and sharing");

    // A client route loaded directly is answered with the index document,
    // and the console profile is baked into the bundle.
    await page.goto(`${url}/exchange`);
    await page
      .getByRole("button", { name: "Open the configuration in my folder" })
      .waitFor({ timeout: 30_000 });

    expect(pageErrors).toEqual([]);
    expect(failedResponses).toEqual([]);
  } finally {
    await browser.close();
  }
}, 90_000);
