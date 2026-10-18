import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { RelayKeyTableError, openRelayKeyTable } from "../src/keyTable.ts";

import { OTHER_RELAY_KEY, RELAY_KEY } from "./harness.ts";

// The schemas relay_table.py and coturn create (infra/relay/relay_table.py;
// scripts/relay-exchange-keys.test.mjs holds the same turn_secret shape).
const TURN_SECRET_SCHEMA =
  "CREATE TABLE turn_secret (realm varchar(127) default '', value varchar(256), primary key (realm,value))";
const MAPPING_SCHEMA =
  "CREATE TABLE alcove_exchange (exchange_id TEXT PRIMARY KEY NOT NULL, realm TEXT NOT NULL, " +
  "key TEXT NOT NULL UNIQUE, registered_at INTEGER NOT NULL, max_age_days INTEGER, fixed_lapse_at INTEGER)";
const REALM = "relay.example";

const directory = mkdtempSync(join(tmpdir(), "websocket-relay-key-table-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

let fileCount = 0;

/** A turndb file holding coturn's table, and the mapping table unless told
 * not to. */
function turndb({ mapping = true } = {}): string {
  fileCount += 1;
  const path = join(directory, `turndb-${fileCount}`);
  const database = new DatabaseSync(path);
  database.exec(TURN_SECRET_SCHEMA);
  if (mapping) database.exec(MAPPING_SCHEMA);
  database.close();
  return path;
}

function write(path: string, statement: string, ...values: string[]): void {
  const database = new DatabaseSync(path);
  database.prepare(statement).run(...values);
  database.close();
}

function enroll(path: string, exchangeId: string, key: string): void {
  write(path, "INSERT INTO turn_secret VALUES (?, ?)", REALM, key);
  write(
    path,
    "INSERT INTO alcove_exchange VALUES (?, ?, ?, 1767225600, NULL, NULL)",
    exchangeId,
    REALM,
    key,
  );
}

describe("openRelayKeyTable", () => {
  it("reads the key enrolled under an exchange id", () => {
    const path = turndb();
    enroll(path, "exchange-1", RELAY_KEY);
    enroll(path, "exchange-2", OTHER_RELAY_KEY);
    const table = openRelayKeyTable(path);
    expect(table.lookup("exchange-1")).toBe(RELAY_KEY);
    expect(table.lookup("exchange-2")).toBe(OTHER_RELAY_KEY);
    expect(table.lookup("exchange-3")).toBeUndefined();
  });

  it("does not read a key coturn's table no longer holds", () => {
    const path = turndb();
    enroll(path, "exchange-1", RELAY_KEY);
    write(path, "DELETE FROM turn_secret WHERE value = ?", RELAY_KEY);
    expect(openRelayKeyTable(path).lookup("exchange-1")).toBeUndefined();
  });

  it("reads a key enrolled after the table was opened", () => {
    const path = turndb();
    const table = openRelayKeyTable(path);
    expect(table.lookup("exchange-1")).toBeUndefined();
    enroll(path, "exchange-1", RELAY_KEY);
    expect(table.lookup("exchange-1")).toBe(RELAY_KEY);
  });

  it("reads no exchange from a file with no mapping table", () => {
    const path = turndb({ mapping: false });
    write(path, "INSERT INTO turn_secret VALUES (?, ?)", REALM, RELAY_KEY);
    expect(openRelayKeyTable(path).lookup("exchange-1")).toBeUndefined();
  });

  it("throws RelayKeyTableError naming the file when it does not exist", () => {
    const path = join(directory, "missing");
    expect(() => openRelayKeyTable(path).lookup("exchange-1")).toThrow(
      RelayKeyTableError,
    );
    expect(() => openRelayKeyTable(path).lookup("exchange-1")).toThrow(
      `could not open the key table ${path}: `,
    );
  });

  it("throws RelayKeyTableError when the file holds no coturn table", () => {
    const path = join(directory, `not-coturn-${(fileCount += 1)}`);
    const database = new DatabaseSync(path);
    database.exec(MAPPING_SCHEMA);
    database.close();
    expect(() => openRelayKeyTable(path).lookup("exchange-1")).toThrow(
      `could not read the key table ${path}: `,
    );
  });
});
