import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { connect as connectTcp } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  SIGNALING_HEADERS_TIMEOUT_MS,
  SIGNALING_PREHANDSHAKE_IDLE_MS,
  SIGNALING_REQUEST_TIMEOUT_MS,
} from "@alcove/peerjs-broker/standaloneUpgradeBounds";

import { RELAY_COUNTER_NAMES } from "../src/countersFile.ts";
import {
  PAIRED_FRAME,
  RELAY_PATH,
  RelayCloseCode,
  START_FRAME,
} from "../src/protocol.ts";

import {
  EXCHANGE_ID,
  RELAY_KEY,
  connect,
  eventually,
  helloFrame,
} from "./harness.ts";

import type { ChildProcess } from "node:child_process";

// The standalone runner as a process, with a key table in coturn's SQLite
// shape, and two real `ws` parties through it: what a deployment runs.

const require = createRequire(import.meta.url);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const READY_LINE = /^alcove-websocket-relay (\d+)\n$/;
const START_TIMEOUT_MS = 20_000;

const directory = mkdtempSync(join(tmpdir(), "websocket-relay-standalone-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  }
});

function enrolledTurndb(): string {
  const path = join(mkdtempSync(join(directory, "run-")), "turndb");
  const database = new DatabaseSync(path);
  database.exec(
    "CREATE TABLE turn_secret (realm varchar(127) default '', value varchar(256), primary key (realm,value))",
  );
  database.exec(
    "CREATE TABLE alcove_exchange (exchange_id TEXT PRIMARY KEY NOT NULL, realm TEXT NOT NULL, " +
      "key TEXT NOT NULL UNIQUE, registered_at INTEGER NOT NULL, max_age_days INTEGER, fixed_lapse_at INTEGER)",
  );
  database
    .prepare("INSERT INTO turn_secret VALUES (?, ?)")
    .run("relay.example", RELAY_KEY);
  database
    .prepare(
      "INSERT INTO alcove_exchange VALUES (?, ?, ?, 1767225600, NULL, NULL)",
    )
    .run(EXCHANGE_ID, "relay.example", RELAY_KEY);
  database.close();
  return path;
}

interface Runner {
  url: string;
  stderr: () => string;
  child: ChildProcess;
}

// Reports the bounds on the runner's own HTTP server (`probeLine` below).
const SERVER_BOUNDS_PROBE = join(packageRoot, "test", "serverBoundsProbe.mjs");

async function startRunner(
  keyTablePath: string,
  extraArgs: ReadonlyArray<string> = [],
  { probeServerBounds = false } = {},
): Promise<Runner> {
  const env = probeServerBounds
    ? {
        ...process.env,
        NODE_OPTIONS: `--import=${pathToFileURL(SERVER_BOUNDS_PROBE).href}`,
      }
    : process.env;
  const child = spawn(
    process.execPath,
    [
      require.resolve("tsx/cli"),
      "src/standalone.ts",
      "--key-table",
      keyTablePath,
      ...extraArgs,
    ],
    { cwd: packageRoot, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no ready line within ${START_TIMEOUT_MS} ms`)),
      START_TIMEOUT_MS,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = READY_LINE.exec(stdout);
      if (match !== null) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(`the runner exited ${code} before listening: ${stderr}`),
      );
    });
  });
  return {
    url: `ws://127.0.0.1:${port}${RELAY_PATH}`,
    stderr: () => stderr,
    child,
  };
}

/** What the server bounds probe wrote about `subject`, once it has. */
async function probeLine(
  runner: Runner,
  subject: "server" | "connection",
): Promise<unknown> {
  const prefix = `probe ${subject} `;
  const line = () =>
    runner
      .stderr()
      .split("\n")
      .find((candidate) => candidate.startsWith(prefix));
  await eventually(() => line() !== undefined);
  return JSON.parse((line() ?? "").slice(prefix.length));
}

describe("the standalone runner", () => {
  it(
    "pairs two parties under a key it reads from the table, forwards their frames and their close",
    { timeout: 60_000 },
    async () => {
      const runner = await startRunner(enrolledTurndb());
      const inviter = await connect(runner.url);
      const acceptor = await connect(runner.url);
      inviter.send(await helloFrame({ role: "inviter" }));
      acceptor.send(await helloFrame({ role: "acceptor" }));
      inviter.send('{"type":"start"}');
      acceptor.send('{"type":"start"}');
      expect(await inviter.receivedCount(2)).toEqual([
        { text: PAIRED_FRAME },
        { text: START_FRAME },
      ]);
      expect(await acceptor.receivedCount(2)).toEqual([
        { text: PAIRED_FRAME },
        { text: START_FRAME },
      ]);

      const chunks = Array.from({ length: 32 }, (_, index) =>
        Buffer.alloc(16_358, index),
      );
      for (const chunk of chunks) inviter.send(chunk);
      acceptor.send(Buffer.from("acknowledged"));
      const received = await acceptor.receivedCount(2 + chunks.length);
      expect(
        received
          .slice(2)
          .every((message, index) => message.binary?.equals(chunks[index])),
      ).toBe(true);
      expect((await inviter.receivedCount(3))[2]).toEqual({
        binary: Buffer.from("acknowledged"),
      });

      acceptor.socket.close(1000);
      expect((await inviter.closed).code).toBe(RelayCloseCode.normal);
      expect(runner.stderr()).toBe("");

      runner.child.kill("SIGTERM");
      const [code] = await once(runner.child, "exit");
      expect(code).toBe(0);
    },
  );

  it(
    "warns at start when the key table cannot be read and refuses each hello with 1011",
    { timeout: 60_000 },
    async () => {
      const runner = await startRunner(join(directory, "missing"));
      // stderr and stdout are separate pipes, so the warning may arrive after
      // the ready line though it was written first.
      await eventually(() =>
        /\[WARN\] \[websocket-relay\] could not open the key table .*missing/.test(
          runner.stderr(),
        ),
      );
      const party = await connect(runner.url);
      party.send(await helloFrame({ role: "inviter" }));
      expect((await party.closed).code).toBe(RelayCloseCode.internalError);
    },
  );

  it(
    "applies the signaling broker's pre-upgrade bounds to its server",
    { timeout: 60_000 },
    async () => {
      const runner = await startRunner(enrolledTurndb(), [], {
        probeServerBounds: true,
      });
      expect(await probeLine(runner, "server")).toEqual({
        headersTimeout: SIGNALING_HEADERS_TIMEOUT_MS,
        requestTimeout: SIGNALING_REQUEST_TIMEOUT_MS,
      });
      const socket = connectTcp(Number(new URL(runner.url).port), "127.0.0.1");
      try {
        await once(socket, "connect");
        expect(await probeLine(runner, "connection")).toEqual({
          timeout: SIGNALING_PREHANDSHAKE_IDLE_MS,
        });
      } finally {
        socket.destroy();
      }
    },
  );

  it(
    "writes its counters file at start, with every count at 0",
    { timeout: 60_000 },
    async () => {
      const countersPath = join(
        mkdtempSync(join(directory, "run-")),
        "counters",
      );
      const runner = await startRunner(enrolledTurndb(), [
        "--counters-file",
        countersPath,
      ]);
      await eventually(() => existsSync(countersPath));
      expect(readFileSync(countersPath, "utf8")).toMatch(
        new RegExp(
          "^started=\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ\\n" +
            "updated=\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ\\n" +
            RELAY_COUNTER_NAMES.map((name) => `${name}=0\\n`).join("") +
            "$",
        ),
      );
      expect(runner.stderr()).toBe("");
    },
  );
});
