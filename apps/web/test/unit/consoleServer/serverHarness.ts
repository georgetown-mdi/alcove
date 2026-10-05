import fs from "node:fs";
import http from "node:http";
import net from "node:net";

import { vi } from "vitest";

import {
  createConsoleHandler,
  createConsoleServer,
  listenConsoleServer,
} from "../../../server/console/app";
import { jobRoutes } from "../../../server/console/routeTable";

import { tempDataRoot } from "../../utils/jobFixtures";

import type { JobManager } from "@jobs/jobManager";
import type { JobRouteDefinition } from "../../../server/console/routeTable";

const servers: Array<http.Server> = [];
const dirs: Array<string> = [];

/** A created scratch directory, removed by {@link resetConsoleServerTests}. */
export function scratchDir(label: string): string {
  const dir = tempDataRoot(label);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

/** Enable the job API on the console profile, with a data root and a
 * rendezvous mount of its own. */
export function enableJobApi(): string {
  const dataRoot = scratchDir("console-server-root");
  vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
  vi.stubEnv("JOB_DATA_ROOT", dataRoot);
  vi.stubEnv("JOB_RENDEZVOUS_DIR", scratchDir("console-server-rvz"));
  return dataRoot;
}

/** Stop every server started here, drop the job API's memoized state, and
 * remove the scratch directories. */
export async function resetConsoleServerTests(): Promise<void> {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const memo = globalThis as {
    jobManagerInstance?: JobManager;
  } & Record<string, unknown>;
  await memo.jobManagerInstance?.shutdown();
  for (const key of [
    "jobManagerInstance",
    "jobSftpServer",
    "jobInputDirConfig",
    "jobRendezvousProvisioning",
    "jobSecretsDirConfig",
    "jobSftpCredentialScratchDir",
  ])
    memo[key] = undefined;
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
}

/** Start the console server on a loopback port, serving `routes` (every job
 * route by default) and the client under `staticRoot` when given, and resolve
 * with its port. */
export async function startServer(
  routes: ReadonlyArray<JobRouteDefinition> = jobRoutes,
  staticRoot?: string,
): Promise<number> {
  const server = createConsoleServer(
    createConsoleHandler(
      staticRoot === undefined ? { routes } : { routes, staticRoot },
    ),
  );
  servers.push(server);
  await listenConsoleServer(server, { port: 0, host: "127.0.0.1" });
  return (server.address() as net.AddressInfo).port;
}

/** What a request came back with. */
export interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Send one request over a fresh connection. `headers` defaults `Host` to the
 * loopback name the job gate accepts. */
export function send(
  port: number,
  options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  },
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path,
        agent: false,
        headers: { host: `localhost:${port}`, ...options.headers },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(options.body);
  });
}

/** Write `text` on a fresh connection as it stands and resolve with every byte
 * the server sends before it closes the connection or `idleMs` passes. */
export function sendRaw(
  port: number,
  text: string,
  idleMs = 1000,
): Promise<string> {
  return new Promise((resolve) => {
    let received = "";
    const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
    const timer = setTimeout(() => socket.destroy(), idleMs);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (received += chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(received);
    });
  });
}

/** The status code on the first line of a raw HTTP answer, or null when the
 * server sent nothing. */
export function rawStatus(answer: string): number | null {
  const match = /^HTTP\/1\.1 (\d{3}) /.exec(answer);
  return match === null ? null : Number(match[1]);
}

/** Resolve once `condition` holds. */
export async function waitUntil(
  condition: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
