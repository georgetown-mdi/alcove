import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stopChild } from "../stopChild";

/**
 * Starts the repository's WebSocket relay (packages/websocket-relay) as a
 * child process over a key table of its own, so the CLI's relay transport is
 * driven against the real relay rather than a stand-in. Runs under `tsx`'s
 * loader in one process, so a figure read from the child, its resident set
 * among them, is the relay's own and not a launcher's.
 */

/** What the runner prints once it is listening (packages/websocket-relay/src/standalone.ts). */
const READY_LINE = /^alcove-websocket-relay (\d+)\n/;

/** Longest to wait for the child to report its port before giving up. */
const START_TIMEOUT_MS = 30_000;

// coturn's turn_secret table and the registrar's alcove_exchange table, as
// infra/relay/relay_table.py writes them; the relay admits a key only while
// both hold it.
const TURN_SECRET_TABLE =
  "CREATE TABLE turn_secret (realm varchar(127) default '', value varchar(256), primary key (realm,value))";
const EXCHANGE_TABLE =
  "CREATE TABLE alcove_exchange (exchange_id TEXT PRIMARY KEY NOT NULL, realm TEXT NOT NULL, " +
  "key TEXT NOT NULL UNIQUE, registered_at INTEGER NOT NULL, max_age_days INTEGER, fixed_lapse_at INTEGER)";
const REALM = "relay.test";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const relayRoot = path.resolve(here, "../../../../packages/websocket-relay");
const runner = path.join(relayRoot, "src/standalone.ts");
const tsxLoader = pathToFileURL(require.resolve("tsx")).href;

function insertKeys(database: DatabaseSync, keys: Record<string, string>) {
  for (const [exchangeId, key] of Object.entries(keys)) {
    database.prepare("INSERT INTO turn_secret VALUES (?, ?)").run(REALM, key);
    database
      .prepare(
        "INSERT INTO alcove_exchange VALUES (?, ?, ?, 1767225600, NULL, NULL)",
      )
      .run(exchangeId, REALM, key);
  }
}

/** A running relay, and the handle to stop it. */
export interface WebSocketRelayProcess {
  /** The relay's `ws://` address on loopback, path included. */
  url: string;
  /** Everything the child has written to stderr so far. */
  stderr: () => string;
  /** Enroll more keys, exchange id to relay key, while the relay runs. */
  enroll: (keys: Record<string, string>) => void;
  /** Terminate the child, wait for it to exit, and remove its key table. */
  stop: () => Promise<void>;
}

/**
 * Spawn the relay with `keys` enrolled, exchange id to relay key, and resolve
 * once it reports its port. `env` is added to the child's environment.
 * Rejects, after killing the child, if it exits first or does not report
 * within {@link START_TIMEOUT_MS}.
 */
export function startWebSocketRelayProcess(
  keys: Record<string, string>,
  env: NodeJS.ProcessEnv = {},
): Promise<WebSocketRelayProcess> {
  const directory = mkdtempSync(path.join(tmpdir(), "alcove-ws-relay-"));
  const keyTable = path.join(directory, "turndb");
  const database = new DatabaseSync(keyTable);
  database.exec(TURN_SECRET_TABLE);
  database.exec(EXCHANGE_TABLE);
  insertKeys(database, keys);
  database.close();

  const child = spawn(
    process.execPath,
    [`--import=${tsxLoader}`, runner, "--key-table", keyTable],
    {
      cwd: relayRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const removeKeyTable = (): void =>
    rmSync(directory, { recursive: true, force: true });

  return new Promise<WebSocketRelayProcess>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      action();
    };
    const fail = (reason: string): void =>
      settle(() => {
        void stopChild(child).then(removeKeyTable);
        reject(new Error(`${reason}\n${stderr.trim()}`));
      });
    const timer = setTimeout(
      () =>
        fail(`the WebSocket relay did not start within ${START_TIMEOUT_MS}ms`),
      START_TIMEOUT_MS,
    );
    const onExit = (code: number | null): void =>
      fail(`the WebSocket relay exited with code ${code} before listening`);
    child.once("exit", onExit);
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
      const match = READY_LINE.exec(stdout);
      if (match === null) return;
      settle(() =>
        resolve({
          url: `ws://127.0.0.1:${match[1]}/relay`,
          stderr: () => stderr,
          enroll: (more) => {
            const writer = new DatabaseSync(keyTable);
            try {
              insertKeys(writer, more);
            } finally {
              writer.close();
            }
          },
          stop: async () => {
            await stopChild(child);
            removeKeyTable();
          },
        }),
      );
    });
  });
}
