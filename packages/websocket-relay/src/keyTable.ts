import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// The relay reads the per-exchange keys from the SQLite file coturn reads its
// own secrets from, written by infra/relay/relay_table.py: coturn's turn_secret
// table holds each key, and relay_table.py's alcove_exchange table maps an
// exchange id to it (infra/relay/README.md, Per-exchange keys).

/** Where the relay host keeps the key table, as relay_table.py reads it. */
export const DEFAULT_KEY_TABLE_PATH = "/var/lib/alcove-relay/turndb";

/** The environment variable relay_table.py reads the key table's path from. */
export const KEY_TABLE_PATH_ENV = "ALCOVE_RELAY_TURNDB";

/**
 * How long (ms) a lookup waits for a writer holding the table's lock. A lookup
 * runs synchronously, so this is also how long one hello can hold up every
 * pairing the relay forwards for.
 */
export const KEY_TABLE_BUSY_TIMEOUT_MS = 100;

// A key counts only while coturn's own table still holds it, so the relay
// admits exactly the keys coturn does.
const LOOKUP = `SELECT e.key AS key FROM alcove_exchange AS e
  JOIN turn_secret AS t ON t.realm = e.realm AND t.value = e.key
  WHERE e.exchange_id = ?`;

const MAPPING_TABLE = `SELECT 1 FROM sqlite_master
  WHERE type = 'table' AND name = 'alcove_exchange'`;

/** The relay's read of the per-exchange keys. */
export interface RelayKeyTable {
  /**
   * The relay key enrolled under `exchangeId`, or undefined when none is.
   *
   * @throws {RelayKeyTableError} when the table cannot be read.
   */
  lookup(exchangeId: string): string | undefined;
}

/**
 * The key table could not be read. The message ends with SQLite's own reason
 * and holds no key.
 */
export class RelayKeyTableError extends Error {
  constructor(message: string, cause: unknown) {
    super(
      `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "RelayKeyTableError";
  }
}

/** What {@link openRelayKeyTable} takes beside the file's path. */
export interface RelayKeyTableOptions {
  /** @internal */
  testing?: { opened?: () => void };
}

interface HeldHandle {
  database: DatabaseSync;
  device: bigint;
  inode: bigint;
}

/**
 * The key table in the SQLite file at `path`, read through one read-only
 * handle opened at the first lookup and kept. The handle is opened again
 * after a lookup that failed, and when the file at `path` is no longer the
 * file it holds, so a file replaced under a running relay is read as it
 * stands. A file with no `alcove_exchange` table holds no enrolled exchange.
 */
export function openRelayKeyTable(
  path: string,
  options: RelayKeyTableOptions = {},
): RelayKeyTable {
  const { testing = {} } = options;
  let held: HeldHandle | undefined;

  function release(): void {
    const database = held?.database;
    held = undefined;
    database?.close();
  }

  // A handle on a file renamed away keeps reading that file and never fails,
  // so the file at `path` is compared with the held one at each lookup.
  function handle(): DatabaseSync {
    let file;
    try {
      file = statSync(path, { bigint: true });
    } catch (error) {
      release();
      throw new RelayKeyTableError(
        `could not open the key table ${path}`,
        error,
      );
    }
    if (held?.device === file.dev && held.inode === file.ino) {
      return held.database;
    }
    release();
    let database: DatabaseSync;
    try {
      database = new DatabaseSync(path, {
        readOnly: true,
        timeout: KEY_TABLE_BUSY_TIMEOUT_MS,
      });
    } catch (error) {
      throw new RelayKeyTableError(
        `could not open the key table ${path}`,
        error,
      );
    }
    held = { database, device: file.dev, inode: file.ino };
    testing.opened?.();
    return database;
  }

  return {
    lookup(exchangeId) {
      const database = handle();
      try {
        if (database.prepare(MAPPING_TABLE).get() === undefined) {
          return undefined;
        }
        const row = database.prepare(LOOKUP).get(exchangeId);
        const key = row?.key;
        return typeof key === "string" ? key : undefined;
      } catch (error) {
        release();
        throw new RelayKeyTableError(
          `could not read the key table ${path}`,
          error,
        );
      }
    },
  };
}
