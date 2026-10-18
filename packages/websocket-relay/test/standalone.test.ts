import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, describe, expect, it } from "vitest";

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

async function startRunner(keyTablePath: string): Promise<Runner> {
  const child = spawn(
    process.execPath,
    [
      require.resolve("tsx/cli"),
      "src/standalone.ts",
      "--key-table",
      keyTablePath,
    ],
    { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
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
});
