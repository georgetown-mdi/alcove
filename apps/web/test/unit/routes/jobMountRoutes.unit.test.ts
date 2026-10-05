import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { route as FolderEntriesRoute } from "../../../server/console/routes/mounts/folder/entries";
import { route as SecretsEntriesRoute } from "../../../server/console/routes/mounts/secrets/entries";

import { STUB_CLI_PATH } from "../../utils/jobFixtures";

const dirs: Array<string> = [];

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `alcove-${label}-`));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
  (globalThis as { jobSecretsDirConfig?: unknown }).jobSecretsDirConfig =
    undefined;
});

type Handlers = Record<
  string,
  (ctx: { request: Request; params: Record<string, string> }) => unknown
>;

function handlersOf(route: { handlers: unknown }): Handlers {
  const handlers = route.handlers;
  if (typeof handlers !== "object" || handlers === null)
    throw new Error("route exposes no plain handlers object");
  return handlers as Handlers;
}

/** Enable the job API (console build + data root). Returns the data root. */
function enable(secretsDir?: string): string {
  const dataRoot = tempDir("mount-data");
  vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
  vi.stubEnv("JOB_DATA_ROOT", dataRoot);
  vi.stubEnv("JOB_CLI_BINARY", STUB_CLI_PATH);
  if (secretsDir !== undefined) vi.stubEnv("JOB_SECRETS_DIR", secretsDir);
  return dataRoot;
}

/** A secrets mount holding a loose file and an .ssh dir with a key. */
function secretsMount(): string {
  const mount = tempDir("secrets");
  fs.writeFileSync(path.join(mount, "partner-password"), "s3cret\n");
  fs.mkdirSync(path.join(mount, ".ssh"));
  fs.writeFileSync(path.join(mount, ".ssh", "id_ed25519"), "PRIVATE\n");
  return mount;
}

/** Build the entries request with each subPath segment as a repeated param. */
function entriesRequest(segments: Array<string>): Request {
  const url = new URL("http://localhost/api/jobs/mounts/secrets/entries");
  for (const segment of segments) url.searchParams.append("subPath", segment);
  // A synthetic Request sets no Host; the gate's loopback allowlist needs one.
  return new Request(url, { headers: { host: "localhost" } });
}

async function entries(segments: Array<string> = []): Promise<Response> {
  return (await handlersOf(SecretsEntriesRoute).GET({
    request: entriesRequest(segments),
    params: {},
  })) as Response;
}

describe("GET /api/jobs/mounts/secrets/entries", () => {
  test("is 404 when the API is disabled", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    expect((await entries()).status).toBe(404);
  });

  test("unconfigured mount is configured:false, the input-listing shape family", async () => {
    enable();
    const response = await entries();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      configured: false,
      readable: true,
      entries: [],
    });
  });

  test("lists the mount root with kinds, dot-dir included", async () => {
    const mount = secretsMount();
    enable(mount);
    const response = await entries();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: true,
      readable: true,
      entries: [
        { name: ".ssh", kind: "dir" },
        { name: "partner-password", kind: "file" },
      ],
    });
  });

  test("navigates into a dot-prefixed subdirectory via repeated subPath", async () => {
    const mount = secretsMount();
    enable(mount);
    const response = await entries([".ssh"]);
    expect(await response.json()).toEqual({
      configured: true,
      readable: true,
      entries: [{ name: "id_ed25519", kind: "file" }],
    });
  });

  test("an escaping subpath is readable:false, empty", async () => {
    const mount = secretsMount();
    enable(mount);
    const response = await entries([".."]);
    expect(await response.json()).toEqual({
      configured: true,
      readable: false,
      entries: [],
    });
  });
});

async function folderEntries(segments: Array<string> = []): Promise<Response> {
  const url = new URL("http://localhost/api/jobs/mounts/folder/entries");
  for (const segment of segments) url.searchParams.append("subPath", segment);
  return (await handlersOf(FolderEntriesRoute).GET({
    request: new Request(url, { headers: { host: "localhost" } }),
    params: {},
  })) as Response;
}

describe("GET /api/jobs/mounts/folder/entries", () => {
  test("is 404 when the API is disabled", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    expect((await folderEntries()).status).toBe(404);
  });

  test("lists the working folder, whether or not a secrets mount is set", async () => {
    const dataRoot = enable();
    fs.writeFileSync(path.join(dataRoot, "sftp-password.txt"), "x");
    fs.mkdirSync(path.join(dataRoot, "keys"));
    const response = await folderEntries();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      configured: true,
      readable: true,
      entries: [
        { name: "keys", kind: "dir" },
        { name: "sftp-password.txt", kind: "file" },
      ],
    });
  });

  test("leaves out the console's own files and job directories", async () => {
    const dataRoot = enable();
    fs.writeFileSync(path.join(dataRoot, ".alcove.key"), "secret");
    fs.writeFileSync(path.join(dataRoot, "alcove.yaml"), "x");
    fs.writeFileSync(path.join(dataRoot, "alcove.yaml.previous"), "x");
    fs.writeFileSync(path.join(dataRoot, "alcove-certificate.json"), "x");
    fs.mkdirSync(path.join(dataRoot, "0b9b3a0e-6f0d-4c58-9a57-3f0e1f3c7a11"));
    fs.writeFileSync(path.join(dataRoot, "sftp-password.txt"), "x");
    expect(await (await folderEntries()).json()).toEqual({
      configured: true,
      readable: true,
      entries: [{ name: "sftp-password.txt", kind: "file" }],
    });
  });

  test("an escaping subpath is readable:false, empty", async () => {
    enable();
    expect(await (await folderEntries([".."])).json()).toEqual({
      configured: true,
      readable: false,
      entries: [],
    });
  });
});
