import { DatabaseSync } from "node:sqlite";

// The relay reads the per-exchange keys from the SQLite file coturn reads its
// own secrets from, written by infra/relay/relay_table.py: coturn's turn_secret
// table holds each key, and relay_table.py's alcove_exchange table maps an
// exchange id to it (infra/relay/README.md, Per-exchange keys).

/** Where the relay host keeps the key table, as relay_table.py reads it. */
export const DEFAULT_KEY_TABLE_PATH = "/var/lib/alcove-relay/turndb";

/** The environment variable relay_table.py reads the key table's path from. */
export const KEY_TABLE_PATH_ENV = "ALCOVE_RELAY_TURNDB";

/** How long (ms) a lookup waits for a writer holding the table's lock. */
export const KEY_TABLE_BUSY_TIMEOUT_MS = 1000;

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

/**
 * The key table in the SQLite file at `path`, opened read-only for each
 * lookup, so a file replaced under a running relay is read as it stands. A
 * file with no `alcove_exchange` table holds no enrolled exchange.
 */
export function openRelayKeyTable(path: string): RelayKeyTable {
  return {
    lookup(exchangeId) {
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
      try {
        if (database.prepare(MAPPING_TABLE).get() === undefined) {
          return undefined;
        }
        const row = database.prepare(LOOKUP).get(exchangeId);
        const key = row?.key;
        return typeof key === "string" ? key : undefined;
      } catch (error) {
        throw new RelayKeyTableError(
          `could not read the key table ${path}`,
          error,
        );
      } finally {
        database.close();
      }
    },
  };
}
