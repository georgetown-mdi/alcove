import { deriveRelayKey, relayRegistrarAuthorization } from "@alcove/core";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect as netConnect } from "node:net";
import { request } from "node:https";
import { connect, getCACertificates, setDefaultCACertificates } from "node:tls";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { registerRelayKey } from "../apps/cli/src/relayKeyRotation.ts";
import { enrollRelayKey } from "../apps/cli/src/relayRegistrar.ts";

// The relay's secrets-table module, the key scripts and the sweep that call
// it, the registrar service and the CLI's client of it, verify.sh's registrar
// probe and cleanup, and the configuration render, driven against a fixture
// host whose turndb is a real SQLite file holding coturn's turn_secret table.
// The table's shape here is the one relay-turn-secret-schema.test.mjs holds
// against the pinned image;
// what coturn does with the rows is verify.sh's to drive against a running
// relay.

const here = dirname(fileURLToPath(import.meta.url));
const relay = resolve(here, "..", "infra/relay");
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";
const REALM = "relay.example";

const KEY_A = "a".repeat(64);
const KEY_B = "0123456789abcdef".repeat(4);
const KEY_C = "fedcba9876543210".repeat(4);
// A row every fixture table starts with and no exchange maps: the scripts must
// never print it.
const KEY_LISTED = "5".repeat(64);
const DAY = 86400;
const HEX64 = /[0-9a-f]{64}/;

// The module refuses to run as root against a root-owned table, and a root
// process ignores the file modes the failure tests set.
const runningAsRoot = process.getuid?.() === 0;

const TURN_SECRET_SCHEMA =
  "CREATE TABLE turn_secret (realm varchar(127) default '', value varchar(256), primary key (realm,value))";

// Runs Python against the fixture's module with the given arguments and returns
// its JSON output.
const python = (code, args = [], env = {}) => {
  const result = spawnSync("python3", ["-B", "-c", code, ...args], {
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: relay, ...env },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim() === "" ? undefined : JSON.parse(result.stdout);
};

const READ_TABLE = `
import json, sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
rows = sorted(conn.execute("SELECT realm, value FROM turn_secret").fetchall())
try:
    mapping = conn.execute(
        "SELECT exchange_id, realm, key, registered_at, max_age_days FROM alcove_exchange ORDER BY exchange_id"
    ).fetchall()
except sqlite3.OperationalError:
    mapping = []
print(json.dumps({"rows": rows, "mapping": mapping}))
`;

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    spawnSync("chmod", ["-R", "u+rwx", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

const fixtureHost = () => {
  const root = mkdtempSync(join(tmpdir(), "relay-exchange-keys-"));
  tmpDirs.push(root);
  const turndb = join(root, "turndb");
  python(
    `import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.execute(${JSON.stringify(TURN_SECRET_SCHEMA)})
conn.execute("INSERT INTO turn_secret VALUES (?, ?)", (sys.argv[2], sys.argv[3]))
conn.commit()`,
    [turndb, REALM, KEY_LISTED],
  );
  // verify.sh's TURNS client runs through the runtime; it gets no answer. The
  // runtime stubs and the python3 wrapper record every argument list they are
  // started with.
  const argvLog = join(root, "python-argv.log");
  writeFileSync(argvLog, "");
  const runtimeLog = join(root, "runtime-argv.log");
  writeFileSync(runtimeLog, "");
  for (const runtime of ["docker", "podman"]) {
    const stub = join(root, runtime);
    writeFileSync(
      stub,
      `#!/bin/bash\nprintf '%s %s\\n' '${runtime}' "$*" >> '${runtimeLog}'\nexit 0\n`,
    );
    chmodSync(stub, 0o755);
  }
  const realPython = process.env.PATH.split(":")
    .map((dir) => join(dir, "python3"))
    .find(existsSync);
  const pythonStub = join(root, "python3");
  writeFileSync(
    pythonStub,
    `#!/bin/bash\nprintf '%s\\n' "$*" >> '${argvLog}'\nexec ${realPython} "$@"\n`,
  );
  chmodSync(pythonStub, 0o755);
  const ipHelper = join(root, "external-ip");
  writeFileSync(ipHelper, "#!/bin/bash\necho 192.0.2.10/10.0.0.5\n");
  chmodSync(ipHelper, 0o755);
  const envFile = join(root, "relay.env");
  writeFileSync(
    envFile,
    [
      `ALCOVE_RELAY_REALM=${REALM}`,
      "ALCOVE_RELAY_RUNTIME=docker",
      `ALCOVE_RELAY_EXTERNAL_IP_HELPER=${ipHelper}`,
      "",
    ].join("\n"),
  );
  const secretFile = join(root, "static-auth-secret");
  const conf = join(root, "turnserver.conf");
  const env = {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    PYTHONDONTWRITEBYTECODE: "1",
    ALCOVE_RELAY_ENV_FILE: envFile,
    ALCOVE_RELAY_TURNDB: turndb,
    ALCOVE_RELAY_SECRET_FILE: secretFile,
    ALCOVE_RELAY_CONF: conf,
    ALCOVE_RELAY_REGISTRAR_TOKEN_FILE: join(root, "registrar-token"),
  };
  const runWith = (extraEnv, script, args, input = "") => {
    const result = spawnSync(BASH, [join(relay, script), ...args], {
      encoding: "utf8",
      env: { ...env, ...extraEnv },
      input,
    });
    for (const stream of [result.stdout, result.stderr]) {
      expect(stream).not.toContain(KEY_LISTED);
    }
    return result;
  };
  const state = () => python(READ_TABLE, [turndb]);
  return {
    register: (id, key, days = "none", extraEnv = {}) =>
      runWith(extraEnv, "register-exchange.sh", [id, days], `${key}\n`),
    registerArgs: (args, input) =>
      runWith({}, "register-exchange.sh", args, input),
    revoke: (id) => runWith({}, "revoke-exchange.sh", [id]),
    sweep: () => runWith({}, "sweep-exchanges.sh", []),
    // Every run of the import is held to printing no key, on any path.
    importLegacy: (mapFile) => {
      const result = runWith(
        { ALCOVE_RELAY_LEGACY_MAPPING: mapFile },
        "import-legacy-mapping.sh",
        [],
      );
      for (const stream of [result.stdout, result.stderr]) {
        expect(stream).not.toMatch(HEX64);
      }
      return result;
    },
    render: () => runWith({}, "render-config.sh", []),
    // No listener answers on the connect target, so the network probes fail
    // at once and the run reaches the secrets-table steps and its cleanup.
    verify: (extraEnv = {}) =>
      runWith(
        {
          ALCOVE_RELAY_VERIFY_CONNECT: "127.0.0.1",
          ALCOVE_RELAY_VERIFY_WAIT: "0",
          ...extraEnv,
        },
        "verify.sh",
        [],
      ),
    rows: () => state().rows.map(([realm, value]) => `${value}[${realm}]`),
    mapping: () =>
      state().mapping.map(([id, realm, key, at, days]) => ({
        id,
        realm,
        key,
        at,
        days,
      })),
    stamp: (id, registeredAt) =>
      python(
        `import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.execute("UPDATE alcove_exchange SET registered_at = ? WHERE exchange_id = ?", (int(sys.argv[3]), sys.argv[2]))
conn.commit()`,
        [turndb, id, String(registeredAt)],
      ),
    pythonArgv: () => readFileSync(argvLog, "utf8"),
    runtimeRuns: () =>
      readFileSync(runtimeLog, "utf8").split("\n").filter(Boolean),
    useRuntime: (runtime) =>
      writeFileSync(
        envFile,
        readFileSync(envFile, "utf8").replace(
          /^ALCOVE_RELAY_RUNTIME=.*$/m,
          `ALCOVE_RELAY_RUNTIME=${runtime}`,
        ),
      ),
    makeTableReadOnly: () => chmodSync(turndb, 0o444),
    makeTableUnopenable: () => chmodSync(turndb, 0o000),
    removeTable: () => rmSync(turndb),
    env,
    root,
    turndb,
    secretFile,
    conf: () => readFileSync(conf, "utf8"),
  };
};

const listed = (key) => `${key}[${REALM}]`;
const nowSeconds = () => Math.floor(Date.now() / 1000);

// The managed-exchange record's max-age ceiling, read from core rather than
// restated, so the module's bound cannot drift from the record's.
const MAX_TOKEN_MAX_AGE_DAYS = Number(
  /export const MAX_TOKEN_MAX_AGE_DAYS = (\d+);/.exec(
    readFileSync(
      resolve(here, "..", "packages/core/src/config/connection.ts"),
      "utf8",
    ),
  )[1],
);

describe.skipIf(runningAsRoot)("register-exchange.sh", () => {
  it("adds the key's row under the realm and maps the exchange to it", () => {
    const host = fixtureHost();
    const before = nowSeconds();
    const result = host.register("exchange-1", KEY_A, "30");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("registered exchange exchange-1");
    expect(result.stdout).toMatch(/lapses 30 day\(s\) after this registration/);
    expect(host.rows()).toEqual([listed(KEY_LISTED), listed(KEY_A)].sort());
    const [row] = host.mapping();
    expect(row).toMatchObject({
      id: "exchange-1",
      realm: REALM,
      key: KEY_A,
      days: 30,
    });
    expect(row.at).toBeGreaterThanOrEqual(before);
    expect(row.at).toBeLessThanOrEqual(nowSeconds());
  });

  it("never puts the key on a command line", () => {
    const host = fixtureHost();
    expect(host.register("exchange-1", KEY_A).status).toBe(0);
    expect(host.revoke("exchange-1").status).toBe(0);
    const argv = host.pythonArgv();
    expect(argv).toContain("register exchange-1 none");
    expect(argv).toContain("revoke exchange-1");
    expect(argv).not.toContain(KEY_A);
  });

  it("replaces the exchange's prior key in the same write", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    host.register("exchange-2", KEY_B);
    const result = host.register("exchange-1", KEY_C);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("replacing its prior key");
    expect(host.rows()).toEqual(
      [listed(KEY_LISTED), listed(KEY_B), listed(KEY_C)].sort(),
    );
    expect(host.mapping().map(({ id, key }) => [id, key])).toEqual([
      ["exchange-1", KEY_C],
      ["exchange-2", KEY_B],
    ]);
  });

  it("renews the stamp and lapse when the exchange already holds the key", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A, "30");
    host.stamp("exchange-1", 1000);
    const renewed = host.register("exchange-1", KEY_A, "7");
    expect(renewed.status, renewed.stderr).toBe(0);
    expect(renewed.stdout).toContain("renewed exchange exchange-1");
    expect(renewed.stdout).not.toContain(KEY_A);
    const [row] = host.mapping();
    expect(row.days).toBe(7);
    expect(row.at).toBeGreaterThan(1000);
    const cleared = host.register("exchange-1", KEY_A, "none");
    expect(cleared.stdout).toContain("it has no lapse");
    expect(host.mapping()[0].days).toBeNull();
    expect(host.rows()).toEqual([listed(KEY_LISTED), listed(KEY_A)].sort());
  });

  it("refuses a key another exchange holds and changes nothing", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    const result = host.register("exchange-2", KEY_A);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain(
      "already registered for exchange exchange-1",
    );
    expect(host.mapping().map(({ id }) => id)).toEqual(["exchange-1"]);
  });

  it.each([
    ["1.0", "1"],
    ["1e0", "1"],
    ["01", "1"],
    ["123e4567", "123e4568"],
  ])("registers %s as its own exchange beside %s", (id, registered) => {
    const host = fixtureHost();
    host.register(registered, KEY_A);
    const result = host.register(id, KEY_B);
    expect(result.status, result.stderr).toBe(0);
    expect(host.mapping().map(({ id: mapped }) => mapped)).toEqual(
      [registered, id].sort(),
    );
  });

  it.each([
    ["an id starting with '-'", "-s", KEY_A, "exchange-id"],
    ["an id with a space", "a b", KEY_A, "exchange-id"],
    ["an id with a slash", "a/b", KEY_A, "exchange-id"],
    ["an id over 128 characters", "x".repeat(129), KEY_A, "exchange-id"],
    ["an uppercase key", "exchange-1", KEY_A.toUpperCase(), "key"],
    ["a 63-character key", "exchange-1", KEY_A.slice(1), "key"],
    ["a base64 key", "exchange-1", "q".repeat(43) + "=", "key"],
    ["no key", "exchange-1", "", "key"],
    ["a key given as the id", KEY_B, KEY_A, "exchange-id"],
    ["an id of a name and a key", `name-${KEY_B}`, KEY_A, "exchange-id"],
    ["an id of an uppercase key", KEY_B.toUpperCase(), KEY_A, "exchange-id"],
  ])("refuses %s, naming the argument", (_, id, key, argument) => {
    const host = fixtureHost();
    const result = host.register(id, key);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain(`ABORTING: ${argument} must`);
    const rejected = argument === "exchange-id" ? id : key;
    if (rejected !== "") {
      expect(result.stdout).not.toContain(rejected);
      expect(result.stderr).not.toContain(rejected);
    }
    expect(host.rows()).toEqual([listed(KEY_LISTED)]);
    expect(host.mapping()).toEqual([]);
  });

  it("registers an id holding a run of 63 hex characters", () => {
    const host = fixtureHost();
    const id = `x${KEY_B.slice(1)}.${KEY_C.slice(1).toUpperCase()}`;
    const result = host.register(id, KEY_A);
    expect(result.status, result.stderr).toBe(0);
    expect(host.mapping()[0].id).toBe(id);
  });

  it("refuses an id under verify.sh's prefix unless verify.sh registers it", () => {
    const host = fixtureHost();
    const refused = host.register("alcove-verify-a", KEY_A);
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain(
      "exchange-id may not start with 'alcove-verify-'",
    );
    expect(host.mapping()).toEqual([]);
    const verifying = host.register("alcove-verify-a", KEY_A, "none", {
      ALCOVE_RELAY_VERIFY_RUN: "1",
    });
    expect(verifying.status, verifying.stderr).toBe(0);
  });

  it("accepts the managed-exchange record's largest max age and refuses one day more", () => {
    const host = fixtureHost();
    const most = host.register(
      "exchange-1",
      KEY_A,
      `${MAX_TOKEN_MAX_AGE_DAYS}`,
    );
    expect(most.status, most.stderr).toBe(0);
    const over = host.register(
      "exchange-2",
      KEY_B,
      `${MAX_TOKEN_MAX_AGE_DAYS + 1}`,
    );
    expect(over.status).toBe(3);
    expect(over.stderr).toContain("max-age-days");
  });

  it.each(["", "0", "007", "1.5", "-1", "1e3", "None", "99999999999999999999"])(
    "refuses max-age-days %j before touching the table",
    (days) => {
      const host = fixtureHost();
      const result = host.register("exchange-1", KEY_A, days);
      expect(result.status).toBe(3);
      expect(result.stderr).toContain("max-age-days");
      expect(host.mapping()).toEqual([]);
    },
  );

  it.each([[["exchange-1"]], [["exchange-1", KEY_A, "30"]], [[]]])(
    "prints usage on the wrong argument count (%j)",
    (args) => {
      const result = fixtureHost().registerArgs(args, `${KEY_A}\n`);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("usage: register-exchange.sh");
      expect(result.stderr).not.toContain(KEY_A);
    },
  );

  it("changes nothing and exits 1 when the table is read-only", () => {
    const host = fixtureHost();
    host.makeTableReadOnly();
    const result = host.register("exchange-1", KEY_A);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("nothing changed");
    expect(result.stderr).not.toContain(KEY_A);
    chmodSync(host.turndb, 0o644);
    expect(host.rows()).toEqual([listed(KEY_LISTED)]);
  });

  it("refuses to create a table coturn has not", () => {
    const host = fixtureHost();
    host.removeTable();
    const result = host.register("exchange-1", KEY_A);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "alcove-relay.service creates it at its first start",
    );
    expect(existsSync(host.turndb)).toBe(false);
  });

  it("refuses a file that holds no turn_secret table", () => {
    const host = fixtureHost();
    python(
      `import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.execute("DROP TABLE turn_secret")
conn.commit()`,
      [host.turndb],
    );
    const result = host.register("exchange-1", KEY_A);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("has no turn_secret table");
  });
});

describe.skipIf(runningAsRoot)("revoke-exchange.sh", () => {
  it("deletes the exchange's row and its mapping", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    host.register("exchange-2", KEY_B);
    const result = host.revoke("exchange-1");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      `revoked exchange exchange-1 (realm ${REALM})\n`,
    );
    expect(host.rows()).toEqual([listed(KEY_LISTED), listed(KEY_B)].sort());
    expect(host.mapping().map(({ id }) => id)).toEqual(["exchange-2"]);
  });

  it("revokes only the exact id among ids equal as numbers", () => {
    const host = fixtureHost();
    host.register("1", KEY_A);
    host.register("1e0", KEY_B);
    host.register("01", KEY_C);
    const result = host.revoke("01");
    expect(result.status, result.stderr).toBe(0);
    expect(host.mapping().map(({ id }) => id)).toEqual(["1", "1e0"]);
    expect(host.rows()).not.toContain(listed(KEY_C));
  });

  it("refuses an exchange that is not registered", () => {
    const host = fixtureHost();
    const result = host.revoke("exchange-1");
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("exchange-id exchange-1 is not registered");
  });

  it("says so when the exchange's key was already gone from the table", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    python(
      `import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.execute("DELETE FROM turn_secret WHERE value = ?", (sys.argv[2],))
conn.commit()`,
      [host.turndb, KEY_A],
    );
    const result = host.revoke("exchange-1");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("its key was not in the secrets table");
    expect(host.mapping()).toEqual([]);
  });

  it.each([
    ["read-only", (host) => host.makeTableReadOnly()],
    ["unopenable", (host) => host.makeTableUnopenable()],
  ])("keeps the row and mapping when the table is %s", (_, spoil) => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    spoil(host);
    const result = host.revoke("exchange-1");
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain(KEY_A);
    chmodSync(host.turndb, 0o644);
    expect(host.mapping().map(({ id }) => id)).toEqual(["exchange-1"]);
    expect(host.rows()).toContain(listed(KEY_A));
  });

  it("refuses a registered key given as the id, without printing it", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    const result = host.revoke(KEY_A);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("exchange-id must");
    expect(result.stderr).not.toContain(KEY_A);
    expect(host.mapping().map(({ id }) => id)).toEqual(["exchange-1"]);
  });
});

describe.skipIf(runningAsRoot)("sweep-exchanges.sh", () => {
  it("revokes a lapsed row and leaves a younger one and one with no lapse", () => {
    const host = fixtureHost();
    host.register("lapsed", KEY_A, "1");
    host.register("young", KEY_B, "1");
    host.register("forever", KEY_C, "none");
    host.stamp("lapsed", nowSeconds() - DAY - 5);
    host.stamp("forever", 1);
    const result = host.sweep();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      `revoked exchange lapsed (realm ${REALM}): its registration lapsed\nswept 1 lapsed exchange(s)\n`,
    );
    expect(host.mapping().map(({ id }) => id)).toEqual(["forever", "young"]);
    expect(host.rows()).toEqual(
      [listed(KEY_LISTED), listed(KEY_B), listed(KEY_C)].sort(),
    );
  });

  it("exits 1 and revokes nothing when the table is read-only", () => {
    const host = fixtureHost();
    host.register("lapsed", KEY_A, "1");
    host.stamp("lapsed", 1);
    host.makeTableReadOnly();
    const result = host.sweep();
    expect(result.status).toBe(1);
    chmodSync(host.turndb, 0o644);
    expect(host.mapping().map(({ id }) => id)).toEqual(["lapsed"]);
  });
});

// The module's functions against a temporary table, with the clock given.
const MODULE = `
import json, sys, relay_table
conn = relay_table.open_table(sys.argv[1])
`;

describe.skipIf(runningAsRoot)("relay_table.py", () => {
  it("lapses a row at exactly max-age-days, and not a second before", () => {
    const host = fixtureHost();
    const result = python(
      `${MODULE}
relay_table.register(conn, "${REALM}", "exchange-1", "${KEY_A}", 1, 1000)
early = relay_table.sweep(conn, 1000 + 86400 - 1)
due = relay_table.sweep(conn, 1000 + 86400)
print(json.dumps([early, due]))`,
      [host.turndb],
    );
    expect(result).toEqual([
      [],
      [{ exchange_id: "exchange-1", realm: REALM, key_was_listed: true }],
    ]);
  });

  it("counts a renewal from its own stamp and max age", () => {
    const host = fixtureHost();
    const result = python(
      `${MODULE}
relay_table.register(conn, "${REALM}", "exchange-1", "${KEY_A}", 1, 0)
relay_table.register(conn, "${REALM}", "exchange-1", "${KEY_A}", 2, 86000)
kept = relay_table.sweep(conn, 86000 + 2 * 86400 - 1)
due = relay_table.sweep(conn, 86000 + 2 * 86400)
print(json.dumps([len(kept), len(due)]))`,
      [host.turndb],
    );
    expect(result).toEqual([0, 1]);
  });

  it("returns the registration's lapse as the write's own result", () => {
    const host = fixtureHost();
    const result = python(
      `${MODULE}
lapsing = relay_table.register(conn, "${REALM}", "exchange-1", "${KEY_A}", 30, 0)
forever = relay_table.register(conn, "${REALM}", "exchange-2", "${KEY_B}", None, 0)
print(json.dumps([lapsing, forever, relay_table.describe_registration(lapsing)]))`,
      [host.turndb],
    );
    expect(result[0]).toMatchObject({
      outcome: "registered",
      max_age_days: 30,
      lapses_at: 30 * DAY,
    });
    expect(result[1]).toMatchObject({ max_age_days: null, lapses_at: null });
    expect(result[2]).toContain("at 1970-01-31T00:00:00Z");
  });

  it("rolls the whole registration back when any part of it fails", () => {
    const host = fixtureHost();
    const result = python(
      `${MODULE}
relay_table.register(conn, "${REALM}", "exchange-1", "${KEY_A}", None, 0)
conn.execute("CREATE TRIGGER refuse BEFORE INSERT ON alcove_exchange BEGIN SELECT RAISE(ABORT, 'refused'); END")
try:
    relay_table.register(conn, "${REALM}", "exchange-1", "${KEY_B}", None, 0)
    print(json.dumps("registered"))
except relay_table.TableError as error:
    print(json.dumps(str(error)))`,
      [host.turndb],
    );
    expect(result).toContain("nothing changed");
    expect(host.rows()).toEqual([listed(KEY_LISTED), listed(KEY_A)].sort());
    expect(host.mapping().map(({ key }) => key)).toEqual([KEY_A]);
  });

  it("imports the text mapping an earlier install kept, once", () => {
    const host = fixtureHost();
    const mapFile = join(host.root, "exchange-keys");
    writeFileSync(
      mapFile,
      `old-1 ${KEY_A} 1790000000 30\nold-2 ${KEY_B}\nold-3 ${KEY_C} 1790000000 -\n`,
    );
    const env = { ...host.env };
    const first = spawnSync(
      "python3",
      [join(relay, "relay_table.py"), "import-mapping", mapFile],
      { encoding: "utf8", env: { ...env, ALCOVE_RELAY_REALM: REALM } },
    );
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("imported 3 exchange(s)");
    const again = spawnSync(
      "python3",
      [join(relay, "relay_table.py"), "import-mapping", mapFile],
      { encoding: "utf8", env: { ...env, ALCOVE_RELAY_REALM: REALM } },
    );
    expect(again.stdout).toContain("imported 0 exchange(s)");
    expect(again.stdout).toContain("3 already registered");
    expect(host.mapping().map(({ id, days }) => [id, days])).toEqual([
      ["old-1", 30],
      ["old-2", null],
      ["old-3", null],
    ]);
    expect(host.mapping()[0].at).toBe(1790000000);
    expect(host.rows()).toEqual(
      [listed(KEY_LISTED), listed(KEY_A), listed(KEY_B), listed(KEY_C)].sort(),
    );
  });

  it("skips a legacy row under verify.sh's prefix and reports the count", () => {
    const host = fixtureHost();
    const mapFile = join(host.root, "exchange-keys");
    writeFileSync(mapFile, `old-1 ${KEY_A}\nalcove-verify-a ${KEY_B}\n`);
    const result = spawnSync(
      "python3",
      [join(relay, "relay_table.py"), "import-mapping", mapFile],
      { encoding: "utf8", env: { ...host.env, ALCOVE_RELAY_REALM: REALM } },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("imported 1 exchange(s)");
    expect(result.stdout).toMatch(
      /skipped 1 row\(s\) under verify\.sh's 'alcove-verify-' prefix/,
    );
    expect(host.mapping().map(({ id }) => id)).toEqual(["old-1"]);
    expect(host.rows()).toEqual([listed(KEY_LISTED), listed(KEY_A)].sort());
  });

  it("refuses a malformed mapping line without printing it", () => {
    const host = fixtureHost();
    const mapFile = join(host.root, "exchange-keys");
    writeFileSync(mapFile, `old-1 ${KEY_A}\n${KEY_B}\n`);
    const result = spawnSync(
      "python3",
      [join(relay, "relay_table.py"), "import-mapping", mapFile],
      { encoding: "utf8", env: { ...host.env, ALCOVE_RELAY_REALM: REALM } },
    );
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("line 2 of the mapping");
    expect(result.stderr).not.toMatch(HEX64);
    expect(host.mapping()).toEqual([]);
  });

  const nowSeconds = () => Math.floor(Date.now() / 1000);
  it.each([
    [
      "a stamp later than now",
      () => `old-2 ${KEY_B} ${nowSeconds() + 86400} 30`,
      "later than now",
    ],
    [
      "a stamp past a 64-bit integer",
      () => `old-2 ${KEY_B} 99999999999999999999 30`,
      "later than now",
    ],
  ])("refuses the whole mapping on %s", (_, line, reason) => {
    const host = fixtureHost();
    const mapFile = join(host.root, "exchange-keys");
    writeFileSync(mapFile, `old-1 ${KEY_A} 1790000000 30\n${line()}\n`);
    const result = spawnSync(
      "python3",
      [join(relay, "relay_table.py"), "import-mapping", mapFile],
      { encoding: "utf8", env: { ...host.env, ALCOVE_RELAY_REALM: REALM } },
    );
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("line 2 of the mapping");
    expect(result.stderr).toContain(reason);
    expect(result.stderr).not.toMatch(HEX64);
    expect(host.mapping()).toEqual([]);
    expect(host.rows()).toEqual([listed(KEY_LISTED)]);
  });

  it("counts a line by its newline, not a form feed inside it", () => {
    const host = fixtureHost();
    const mapFile = join(host.root, "exchange-keys");
    // The form feed splits "old-2"/KEY_B into two fields just like a space
    // would, so this row still parses; str.splitlines() also treats it as a
    // line break, which used to drift the refusal below to "line 4".
    writeFileSync(mapFile, `old-1 ${KEY_A}\nold-2\f${KEY_B}\n${KEY_C}\n`);
    const result = spawnSync(
      "python3",
      [join(relay, "relay_table.py"), "import-mapping", mapFile],
      { encoding: "utf8", env: { ...host.env, ALCOVE_RELAY_REALM: REALM } },
    );
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("line 3 of the mapping");
    expect(result.stderr).not.toMatch(HEX64);
    expect(host.mapping()).toEqual([]);
  });

  it("imports a mapping stamped a moment ago", () => {
    const host = fixtureHost();
    const mapFile = join(host.root, "exchange-keys");
    const stamp = nowSeconds() - 5;
    writeFileSync(mapFile, `old-1 ${KEY_A} ${stamp} 30\n`);
    const result = spawnSync(
      "python3",
      [join(relay, "relay_table.py"), "import-mapping", mapFile],
      { encoding: "utf8", env: { ...host.env, ALCOVE_RELAY_REALM: REALM } },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(host.mapping()).toMatchObject([
      { id: "old-1", at: stamp, days: 30 },
    ]);
    expect(host.rows()).toEqual([listed(KEY_LISTED), listed(KEY_A)].sort());
  });

  it("reports status of a mapping and its row, reading the key from stdin", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    const status = (id, key) =>
      spawnSync("python3", [join(relay, "relay_table.py"), "status", id], {
        encoding: "utf8",
        env: { ...host.env, ALCOVE_RELAY_REALM: REALM },
        input: `${key}\n`,
      }).status;
    expect(status("exchange-1", KEY_A)).toBe(0);
    expect(status("exchange-1", KEY_B)).toBe(3);
    expect(status("exchange-9", KEY_A)).toBe(4);
  });

  it.each(["status exchange-1", "forget-key"])(
    "refuses %s with no realm, naming the variable, and changes nothing",
    (command) => {
      const host = fixtureHost();
      host.register("exchange-1", KEY_A);
      const before = { rows: host.rows(), mapping: host.mapping() };
      const result = spawnSync(
        "python3",
        [join(relay, "relay_table.py"), ...command.split(" ")],
        {
          encoding: "utf8",
          env: { ...host.env, ALCOVE_RELAY_REALM: "" },
          input: `${KEY_A}\n`,
        },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("ALCOVE_RELAY_REALM is unset");
      expect({ rows: host.rows(), mapping: host.mapping() }).toEqual(before);
    },
  );

  it.each(["status exchange-1", "forget-key"])(
    "refuses %s with no realm before opening a missing table, and leaves an existing one's bytes alone",
    (command) => {
      const host = fixtureHost();
      const run = (turndb) =>
        spawnSync(
          "python3",
          [join(relay, "relay_table.py"), ...command.split(" ")],
          {
            encoding: "utf8",
            env: {
              ...host.env,
              ALCOVE_RELAY_TURNDB: turndb,
              ALCOVE_RELAY_REALM: "",
            },
            input: `${KEY_A}\n`,
          },
        );
      const missing = join(host.root, "no-such-table");
      const result = run(missing);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("ALCOVE_RELAY_REALM is unset");
      expect(existsSync(missing)).toBe(false);
      const existing = host.env.ALCOVE_RELAY_TURNDB;
      const before = readFileSync(existing);
      expect(run(existing).status).toBe(2);
      expect(readFileSync(existing).equals(before)).toBe(true);
    },
  );

  it("forgets a mapped key's mapping and row together, and leaves another realm's alone", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    python(
      `${MODULE}
relay_table.register(conn, "other.example", "exchange-2", "${KEY_B}", None, 0)`,
      [host.turndb],
    );
    const forget = (key) =>
      spawnSync("python3", [join(relay, "relay_table.py"), "forget-key"], {
        encoding: "utf8",
        env: { ...host.env, ALCOVE_RELAY_REALM: REALM },
        input: `${key}\n`,
      });
    const forgotten = forget(KEY_A);
    expect(forgotten.status, forgotten.stderr).toBe(0);
    const untouched = forget(KEY_B);
    expect(untouched.status, untouched.stderr).toBe(0);
    expect(untouched.stdout).toBe(`no row in realm ${REALM} held the key\n`);
    expect(host.mapping().map(({ id, realm }) => [id, realm])).toEqual([
      ["exchange-2", "other.example"],
    ]);
    expect(host.rows()).toEqual(
      [listed(KEY_LISTED), `${KEY_B}[other.example]`].sort(),
    );
  });

  it("forgets a row no exchange maps, by the key on stdin", () => {
    const host = fixtureHost();
    const result = spawnSync(
      "python3",
      [join(relay, "relay_table.py"), "forget-key"],
      {
        encoding: "utf8",
        env: { ...host.env, ALCOVE_RELAY_REALM: REALM },
        input: `${KEY_LISTED}\n`,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`removed the key's row (realm ${REALM})\n`);
    expect(host.rows()).toEqual([]);
  });
});

describe.skipIf(runningAsRoot)("import-legacy-mapping.sh", () => {
  const legacyFile = (host, name, text) => {
    const file = join(host.root, name);
    writeFileSync(file, text);
    return file;
  };

  it("does nothing on a host with no legacy mapping", () => {
    const host = fixtureHost();
    const result = host.importLegacy(join(host.root, "exchange-keys"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(host.mapping()).toEqual([]);
  });

  it("deletes the mapping and its lock once the table reads back every row", () => {
    const host = fixtureHost();
    const mapFile = legacyFile(
      host,
      "exchange-keys",
      `old-1 ${KEY_A} 1790000000 30\nold-2 ${KEY_B}\n`,
    );
    const lock = legacyFile(host, "exchange-keys.lock", "");
    const result = host.importLegacy(mapFile);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("read back: the secrets table accounts");
    expect(result.stdout).toContain(`deleted ${mapFile}`);
    expect(existsSync(mapFile)).toBe(false);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${mapFile}.imported`)).toBe(false);
    expect(host.mapping().map(({ id }) => id)).toEqual(["old-1", "old-2"]);
    expect(host.rows()).toEqual(
      [listed(KEY_LISTED), listed(KEY_A), listed(KEY_B)].sort(),
    );
  });

  it.each([
    ["the table is read-only", 1, (host) => host.makeTableReadOnly()],
    ["the table is unopenable", 1, (host) => host.makeTableUnopenable()],
    ["coturn has not created the table", 1, (host) => host.removeTable()],
  ])(
    "keeps the mapping unchanged and says so when %s",
    (_, status, breakTable) => {
      const host = fixtureHost();
      const text = `old-1 ${KEY_A}\n`;
      const mapFile = legacyFile(host, "exchange-keys", text);
      const lock = legacyFile(host, "exchange-keys.lock", "");
      breakTable(host);
      const result = host.importLegacy(mapFile);
      expect(result.status).toBe(status);
      expect(result.stderr).toContain(`kept ${mapFile}, unchanged`);
      expect(result.stdout).not.toContain("deleted");
      expect(readFileSync(mapFile, "utf8")).toBe(text);
      expect(existsSync(lock)).toBe(true);
    },
  );

  it("keeps a mapping it refuses unchanged", () => {
    const host = fixtureHost();
    const text = `old-1 ${KEY_A}\n${KEY_B}\n`;
    const mapFile = legacyFile(host, "exchange-keys", text);
    const result = host.importLegacy(mapFile);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain(`kept ${mapFile}, unchanged`);
    expect(readFileSync(mapFile, "utf8")).toBe(text);
    expect(host.mapping()).toEqual([]);
  });

  it("keeps the mapping while the table lists one of its keys with no exchange mapping it", () => {
    const host = fixtureHost();
    // A verify run's row is skipped, never mapped; its key is the fixture's
    // unmapped row, so only this file still names it.
    const text = `old-1 ${KEY_A}\nalcove-verify-a ${KEY_LISTED}\n`;
    const mapFile = legacyFile(host, "exchange-keys", text);
    const result = host.importLegacy(mapFile);
    expect(result.status).toBe(4);
    expect(result.stderr).toContain(
      "does not account for 1 row(s) of " +
        `${mapFile} (exchange id(s): alcove-verify-a)`,
    );
    expect(result.stderr).toContain("forget-key");
    expect(result.stderr).toContain(`moved ${mapFile} to ${mapFile}.imported`);
    expect(existsSync(mapFile)).toBe(false);
    expect(readFileSync(`${mapFile}.imported`, "utf8")).toBe(text);
    expect(host.mapping().map(({ id }) => id)).toEqual(["old-1"]);
  });

  it("deletes a mapping an earlier install set aside, without importing it again", () => {
    const host = fixtureHost();
    host.register("old-1", KEY_A);
    const setAside = legacyFile(
      host,
      "exchange-keys.imported",
      `old-1 ${KEY_A}\nold-2 ${KEY_B}\n`,
    );
    const result = host.importLegacy(join(host.root, "exchange-keys"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`deleted ${setAside}`);
    expect(existsSync(setAside)).toBe(false);
    // old-2 was revoked after the earlier import; it stays revoked.
    expect(host.mapping().map(({ id }) => id)).toEqual(["old-1"]);
    expect(host.rows()).toEqual([listed(KEY_LISTED), listed(KEY_A)].sort());
  });

  it("deletes the lock with a set-aside mapping the table accounts for", () => {
    const host = fixtureHost();
    host.register("old-1", KEY_A);
    const setAside = legacyFile(
      host,
      "exchange-keys.imported",
      `old-1 ${KEY_A}\n`,
    );
    const lock = legacyFile(host, "exchange-keys.lock", "");
    const result = host.importLegacy(join(host.root, "exchange-keys"));
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(setAside)).toBe(false);
    expect(existsSync(lock)).toBe(false);
  });

  it("keeps a set-aside mapping naming a key the table lists unmapped", () => {
    const host = fixtureHost();
    const text = `old-9 ${KEY_LISTED}\n`;
    const setAside = legacyFile(host, "exchange-keys.imported", text);
    const lock = legacyFile(host, "exchange-keys.lock", "");
    const result = host.importLegacy(join(host.root, "exchange-keys"));
    expect(result.status).toBe(4);
    expect(existsSync(lock)).toBe(true);
    expect(result.stderr).toContain("(exchange id(s): old-9)");
    expect(readFileSync(setAside, "utf8")).toBe(text);
    expect(host.mapping()).toEqual([]);
  });

  it("keeps the mapping when two of its rows share a key the import can map to only one", () => {
    const host = fixtureHost();
    const text = `dup-1 ${KEY_A}\ndup-2 ${KEY_A}\n`;
    const mapFile = legacyFile(host, "exchange-keys", text);
    const setAside = `${mapFile}.imported`;
    const imported = host.importLegacy(mapFile);
    expect(imported.status).toBe(4);
    expect(imported.stderr).toContain(
      "does not account for 1 row(s) of " +
        `${mapFile} (exchange id(s): dup-2)`,
    );
    expect(imported.stderr).toContain(`moved ${mapFile} to ${setAside}`);
    expect(existsSync(mapFile)).toBe(false);
    expect(readFileSync(setAside, "utf8")).toBe(text);
    expect(host.mapping().map(({ id }) => id)).toEqual(["dup-1"]);
    // The next run checks the set-aside file rather than importing it.
    const checked = host.importLegacy(mapFile);
    expect(checked.status).toBe(4);
    expect(checked.stderr).toContain(
      "does not account for 1 row(s) of " +
        `${setAside} (exchange id(s): dup-2)`,
    );
    expect(readFileSync(setAside, "utf8")).toBe(text);
    // With the disagreeing row deleted from the file, the check passes.
    writeFileSync(setAside, `dup-1 ${KEY_A}\n`);
    const fixed = host.importLegacy(mapFile);
    expect(fixed.status, fixed.stderr).toBe(0);
    expect(existsSync(setAside)).toBe(false);
    expect(host.mapping().map(({ id }) => id)).toEqual(["dup-1"]);
  });

  it("never imports a file again once its import has landed", () => {
    const host = fixtureHost();
    const mapFile = legacyFile(
      host,
      "exchange-keys",
      `old-1 ${KEY_A}\nold-2 ${KEY_B}\ndup-2 ${KEY_B}\n`,
    );
    const imported = host.importLegacy(mapFile);
    expect(imported.status).toBe(4);
    expect(host.mapping().map(({ id }) => id)).toEqual(["old-1", "old-2"]);
    expect(host.revoke("old-2").status).toBe(0);
    const again = host.importLegacy(mapFile);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).not.toMatch(/^imported /m);
    expect(again.stdout).toContain(`deleted ${mapFile}.imported`);
    // old-2 was revoked after the import; it stays revoked and unlisted.
    expect(host.mapping().map(({ id }) => id)).toEqual(["old-1"]);
    expect(host.rows()).toEqual([listed(KEY_LISTED), listed(KEY_A)].sort());
  });

  it("appends a landed file to a set-aside copy already there", () => {
    const host = fixtureHost();
    host.register("old-1", KEY_A);
    const setAside = legacyFile(
      host,
      "exchange-keys.imported",
      `old-1 ${KEY_A}`,
    );
    const mapFile = legacyFile(
      host,
      "exchange-keys",
      `dup-1 ${KEY_B}\ndup-2 ${KEY_B}\n`,
    );
    const result = host.importLegacy(mapFile);
    expect(result.status).toBe(4);
    expect(existsSync(mapFile)).toBe(false);
    expect(readFileSync(setAside, "utf8")).toBe(
      `old-1 ${KEY_A}\ndup-1 ${KEY_B}\ndup-2 ${KEY_B}\n`,
    );
  });
});

describe("relay_table.py", () => {
  // The relay README states the module runs no container and so never puts a
  // key on a command line. This pins the module's static import surface:
  // Python's own parser lists every import statement, at any depth, and the
  // set must be exactly the modules it uses today; os, the one of them that
  // can start a process, must be imported only as `import os`, with no alias
  // and no `from os import`. The source must not hold getattr on os,
  // __import__, or importlib. A process-starting name read off os by
  // attribute, or code built from a string and run through eval or exec, is
  // outside this check.
  it("imports only modules that start no process", () => {
    const path = join(relay, "relay_table.py");
    const imported = python(
      `import ast, json, sys
tree = ast.parse(open(sys.argv[1], encoding="utf-8").read())
modules, os_aliases, from_os = set(), [], []
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for alias in node.names:
            modules.add(alias.name)
            if alias.name == "os" and alias.asname is not None:
                os_aliases.append(alias.asname)
    elif isinstance(node, ast.ImportFrom):
        module = "." * node.level + (node.module or "")
        modules.add(module)
        if module == "os" or module.startswith("os."):
            from_os.extend(alias.name for alias in node.names)
print(json.dumps({"modules": sorted(modules), "osAliases": os_aliases, "fromOs": from_os}))`,
      [path],
    );
    expect(imported.modules).toEqual([
      "datetime",
      "os",
      "re",
      "sqlite3",
      "sys",
      "time",
      "urllib.parse",
    ]);
    expect(imported.osAliases).toEqual([]);
    expect(imported.fromOs).toEqual([]);
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(/\bgetattr\s*\(\s*os\b/);
    expect(source).not.toMatch(/__import__|\bimportlib\b/);
  });
});

describe.skipIf(runningAsRoot)(
  "relay_table.py enrollment and proven writes",
  () => {
    // A proves_possession stand-in accepting exactly one key, recording each key
    // it was asked about.
    const HOLDS = `
asked = []
def holds(expected):
    def check(current):
        asked.append(current)
        return current == expected
    return check
def attempt(write):
    try:
        return write()
    except relay_table.ProofRefused as error:
        return {"proof_refused": str(error)}
    except relay_table.Refused as error:
        return {"refused": str(error)}
`;

    it("enrolls an exchange once, accepts the same key again unchanged, and refuses another key", () => {
      const host = fixtureHost();
      const result = python(
        `${MODULE}${HOLDS}
first = relay_table.enroll(conn, "${REALM}", "exchange-1", "${KEY_A}", 30, 0)
same = relay_table.enroll(conn, "${REALM}", "exchange-1", "${KEY_A}", None, 5)
other = attempt(lambda: relay_table.enroll(conn, "${REALM}", "exchange-1", "${KEY_B}", None, 5))
taken = attempt(lambda: relay_table.enroll(conn, "${REALM}", "exchange-2", "${KEY_A}", None, 5))
print(json.dumps([first["outcome"], same, relay_table.describe_registration(same), other, taken]))`,
        [host.turndb],
      );
      const [first, same, described, other, taken] = result;
      expect(first).toBe("registered");
      expect(same).toMatchObject({
        outcome: "unchanged",
        registered_at: 0,
        max_age_days: 30,
      });
      expect(described).toContain(
        "exchange exchange-1 (realm relay.example) is already enrolled with this key; nothing changed",
      );
      expect(other.refused).toContain(
        "exchange-id exchange-1 is already enrolled on this relay with another key",
      );
      expect(taken.refused).toContain(
        "the key is already registered for exchange exchange-1",
      );
      expect(JSON.stringify(result)).not.toMatch(HEX64);
      expect(host.rows()).toEqual([listed(KEY_LISTED), listed(KEY_A)].sort());
      expect(host.mapping()).toEqual([
        { id: "exchange-1", realm: REALM, key: KEY_A, at: 0, days: 30 },
      ]);
    });

    it("rotates under a proof of the held key, and refuses one under any other", () => {
      const host = fixtureHost();
      const result = python(
        `${MODULE}${HOLDS}
relay_table.enroll(conn, "${REALM}", "exchange-1", "${KEY_A}", None, 0)
wrong = attempt(lambda: relay_table.rotate(conn, "${REALM}", "exchange-1", "${KEY_C}", None, 5, holds("${KEY_B}")))
rotated = relay_table.rotate(conn, "${REALM}", "exchange-1", "${KEY_B}", 7, 10, holds("${KEY_A}"))["outcome"]
stale = attempt(lambda: relay_table.rotate(conn, "${REALM}", "exchange-1", "${KEY_C}", None, 20, holds("${KEY_A}")))
print(json.dumps([wrong, rotated, stale, asked]))`,
        [host.turndb],
      );
      const [wrong, rotated, stale, asked] = result;
      expect(wrong.proof_refused).toBe(
        "the request's proof does not verify against the key exchange exchange-1 holds on this relay",
      );
      expect(rotated).toBe("replaced");
      expect(stale.proof_refused).toBeDefined();
      expect(asked).toEqual([KEY_A, KEY_A, KEY_B]);
      expect(host.rows()).toEqual([listed(KEY_LISTED), listed(KEY_B)].sort());
      expect(host.mapping()).toEqual([
        { id: "exchange-1", realm: REALM, key: KEY_B, at: 10, days: 7 },
      ]);
    });

    it("renews the row when the rotation names the key already held", () => {
      const host = fixtureHost();
      const result = python(
        `${MODULE}${HOLDS}
relay_table.enroll(conn, "${REALM}", "exchange-1", "${KEY_A}", 1, 0)
first = relay_table.rotate(conn, "${REALM}", "exchange-1", "${KEY_B}", 30, 10, holds("${KEY_A}"))
second = relay_table.rotate(conn, "${REALM}", "exchange-1", "${KEY_B}", 30, 20, holds("${KEY_B}"))
print(json.dumps([first["outcome"], second["outcome"]]))`,
        [host.turndb],
      );
      expect(result).toEqual(["replaced", "renewed"]);
      expect(host.mapping()).toEqual([
        { id: "exchange-1", realm: REALM, key: KEY_B, at: 20, days: 30 },
      ]);
    });

    it("refuses a proven write to an exchange not enrolled, asking for no proof", () => {
      const host = fixtureHost();
      const result = python(
        `${MODULE}${HOLDS}
rotated = attempt(lambda: relay_table.rotate(conn, "${REALM}", "exchange-1", "${KEY_A}", None, 0, holds("${KEY_A}")))
revoked = attempt(lambda: relay_table.revoke_with_proof(conn, "exchange-1", holds("${KEY_A}")))
print(json.dumps([rotated, revoked, asked]))`,
        [host.turndb],
      );
      for (const refusal of result.slice(0, 2)) {
        expect(refusal.refused).toBe(
          "exchange-id exchange-1 is not enrolled on this relay; enroll it with the relay-owner token",
        );
      }
      expect(result[2]).toEqual([]);
      expect(host.rows()).toEqual([listed(KEY_LISTED)]);
    });

    it("accepts a proof only on an exact True, not any truthy answer", () => {
      const host = fixtureHost();
      const result = python(
        `${MODULE}${HOLDS}
relay_table.enroll(conn, "${REALM}", "exchange-1", "${KEY_A}", None, 0)
print(json.dumps(attempt(lambda: relay_table.rotate(conn, "${REALM}", "exchange-1", "${KEY_B}", None, 5, lambda current: b"mac"))))`,
        [host.turndb],
      );
      expect(result.proof_refused).toBeDefined();
      expect(host.mapping().map(({ key }) => key)).toEqual([KEY_A]);
    });

    it("revokes under a proof of the held key, and refuses one under any other", () => {
      const host = fixtureHost();
      const result = python(
        `${MODULE}${HOLDS}
relay_table.enroll(conn, "${REALM}", "exchange-1", "${KEY_A}", None, 0)
wrong = attempt(lambda: relay_table.revoke_with_proof(conn, "exchange-1", holds("${KEY_B}")))
kept = [row[0] for row in conn.execute("SELECT key FROM alcove_exchange")]
revoked = relay_table.revoke_with_proof(conn, "exchange-1", holds("${KEY_A}"))
print(json.dumps([wrong, kept, revoked]))`,
        [host.turndb],
      );
      expect(result[0].proof_refused).toBeDefined();
      expect(result[1]).toEqual([KEY_A]);
      expect(result[2]).toEqual({
        exchange_id: "exchange-1",
        realm: REALM,
        key_was_listed: true,
      });
      expect(host.rows()).toEqual([listed(KEY_LISTED)]);
      expect(host.mapping()).toEqual([]);
    });

    it("lets only one of two rotations proven under the same key succeed", () => {
      const host = fixtureHost();
      // Rotation A holds the write lock inside its proof check while rotation B
      // starts on a second connection; B's check must not run until A commits,
      // and must then see A's key.
      const result = python(
        `${MODULE}
import threading, time
relay_table.enroll(conn, "${REALM}", "exchange-1", "${KEY_A}", None, 0)
a_checking, release_a = threading.Event(), threading.Event()
asked, outcome = {"a": [], "b": []}, {}
def check(name, pause):
    def run(current):
        asked[name].append(current)
        if pause:
            a_checking.set()
            release_a.wait(10)
        return current == "${KEY_A}"
    return run
def rotate(name, key, pause):
    own = relay_table.open_table(sys.argv[1])
    try:
        outcome[name] = relay_table.rotate(own, "${REALM}", "exchange-1", key, None, 1, check(name, pause))["outcome"]
    except relay_table.ProofRefused:
        outcome[name] = "proof refused"
    finally:
        own.close()
a = threading.Thread(target=rotate, args=("a", "${KEY_B}", True))
b = threading.Thread(target=rotate, args=("b", "${KEY_C}", False))
a.start()
a_checking.wait(10)
b.start()
time.sleep(0.5)
b_checked_while_a_held_lock = len(asked["b"]) > 0
release_a.set()
a.join()
b.join()
print(json.dumps([outcome, asked, b_checked_while_a_held_lock]))`,
        [host.turndb],
      );
      const [outcome, asked, bCheckedEarly] = result;
      expect(outcome).toEqual({ a: "replaced", b: "proof refused" });
      expect(asked).toEqual({ a: [KEY_A], b: [KEY_B] });
      expect(bCheckedEarly).toBe(false);
      expect(host.rows()).toEqual([listed(KEY_LISTED), listed(KEY_B)].sort());
      expect(host.mapping().map(({ key }) => key)).toEqual([KEY_B]);
    });
  },
);

const REGISTRAR_TOKEN = "7".repeat(64);
let certDir;

beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), "relay-registrar-cert-"));
  const made = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=relay.example",
      "-addext",
      "subjectAltName=DNS:relay.example,IP:127.0.0.1",
      "-keyout",
      join(certDir, "privkey.pem"),
      "-out",
      join(certDir, "fullchain.pem"),
    ],
    { encoding: "utf8" },
  );
  expect(made.status, made.stderr).toBe(0);
});

afterAll(() => {
  rmSync(certDir, { recursive: true, force: true });
});

const registrars = [];

afterEach(() => {
  while (registrars.length > 0) registrars.pop().kill();
});

const registrarEnv = (host, token = REGISTRAR_TOKEN) => {
  const tokenFile = join(host.root, "registrar-token");
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  return {
    ...host.env,
    ALCOVE_RELAY_REALM: REALM,
    ALCOVE_RELAY_REGISTRAR_TOKEN_FILE: tokenFile,
    ALCOVE_RELAY_CERT_DIR: certDir,
  };
};

// A start takes well under a second; this bounds one that never listens, and
// once one has failed that way every later start fails at once, so a registrar
// that cannot start costs the file one bound rather than one per test.
const REGISTRAR_START_SECONDS = 15;
let registrarStartTimedOut = false;

// Starts the registrar on a free port and resolves once it is listening.
// `bounds` replaces module constants, by name, before it starts.
const startRegistrarWith = (env, bounds = {}) =>
  new Promise((resolvePort, reject) => {
    if (registrarStartTimedOut) {
      reject(
        new Error(
          `an earlier registrar.py start in this file did not listen within ${REGISTRAR_START_SECONDS}s`,
        ),
      );
      return;
    }
    const assignments = Object.entries(bounds)
      .map(([name, value]) => `registrar.${name} = ${JSON.stringify(value)}\n`)
      .join("");
    const child = spawn(
      "python3",
      Object.keys(bounds).length === 0
        ? [join(relay, "registrar.py")]
        : ["-B", "-c", `import registrar\n${assignments}registrar.main()`],
      { env: { ...env, PYTHONPATH: relay, ALCOVE_RELAY_REGISTRAR_PORT: "0" } },
    );
    registrars.push(child);
    const log = { stderr: "" };
    const deadline = setTimeout(() => {
      registrarStartTimedOut = true;
      child.kill();
      reject(
        new Error(
          `registrar.py did not listen within ${REGISTRAR_START_SECONDS}s: ${log.stderr}`,
        ),
      );
    }, REGISTRAR_START_SECONDS * 1000);
    child.stderr.on("data", (chunk) => {
      log.stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      const match = /listening on port (\d+)/.exec(String(chunk));
      if (match) {
        clearTimeout(deadline);
        resolvePort({ port: Number(match[1]), log });
      }
    });
    child.on("exit", (code) => {
      clearTimeout(deadline);
      reject(new Error(`registrar exited ${code}: ${log.stderr}`));
    });
  });

const startRegistrar = (host, bounds = {}) =>
  startRegistrarWith(registrarEnv(host), bounds);

// Every response header block the registrar sent in this test file, for the
// check that none of them allows credentials.
const seenHeaders = [];

const call = (port, method, path, { token, body, headers = {} } = {}) =>
  new Promise((resolveResponse, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        servername: "relay.example",
        ca: readFileSync(join(certDir, "fullchain.pem")),
        headers: {
          ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
          ...(payload === undefined
            ? {}
            : { "Content-Length": String(payload.length) }),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          seenHeaders.push(res.headers);
          resolveResponse({
            status: res.statusCode,
            headers: res.headers,
            text,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });

// Writes raw requests on one connection and resolves with everything the
// registrar sends back once it closes the connection.
const callRaw = (port, requests) =>
  new Promise((resolveText, reject) => {
    const socket = connect(
      {
        host: "127.0.0.1",
        port,
        servername: "relay.example",
        ca: readFileSync(join(certDir, "fullchain.pem")),
      },
      () => socket.write(requests.join("")),
    );
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk;
    });
    socket.on("end", () => {
      seenHeaders.push(text);
      resolveText(text);
    });
    socket.on("error", reject);
  });

const rawRequest = (method, path, headers, body = "") =>
  [
    `${method} ${path} HTTP/1.1`,
    "Host: relay.example",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n");

const keyBody = (key, maxAgeDays = "null") =>
  `{"key": ${JSON.stringify(key)}, "maxAgeDays": ${maxAgeDays}}`;
const ID_REFUSAL =
  "exchange-id must be 1 to 128 of [A-Za-z0-9._-], not starting with '-' and not containing a run of 64 hex characters";
const KEY_REFUSAL = "key must be 64 lowercase hex characters [0-9a-f]";
const MAX_AGE_REFUSAL =
  "maxAgeDays must be a whole number of days from 1 to 36500, or null for no lapse";
const TABLE_FAILURE =
  "the registrar could not read or write the relay's secrets table, and nothing changed; try again later, and if it persists ask the relay's operator, whose registrar log names the cause";
const BUSY_REFUSAL =
  "the registrar is answering as many requests as it can; try again in a few seconds";
const BODY_REFUSAL =
  'the request body must be {"key": "<key-hex64>", "maxAgeDays": <days> | null}; maxAgeDays is required';

// Each test starts a Python process; a loaded host takes longer than the
// default five seconds.
describe.skipIf(runningAsRoot)("registrar.py", { timeout: 60000 }, () => {
  it.each([
    ["PUT", undefined, {}],
    ["PUT", "8".repeat(64), {}],
    ["PUT", undefined, { Authorization: `Basic ${REGISTRAR_TOKEN}` }],
    ["PUT", undefined, { Authorization: REGISTRAR_TOKEN }],
    ["PUT", undefined, { Cookie: `token=${REGISTRAR_TOKEN}` }],
    ["PUT", undefined, { "X-Authorization": `Bearer ${REGISTRAR_TOKEN}` }],
    ["DELETE", undefined, {}],
    ["DELETE", REGISTRAR_TOKEN.slice(1), {}],
    ["GET", undefined, {}],
    ["POST", undefined, {}],
  ])(
    "refuses %s without the token (%j, %j) and writes nothing",
    async (method, token, headers) => {
      const host = fixtureHost();
      host.register("exchange-1", KEY_A);
      const { port } = await startRegistrar(host);
      const before = host.mapping();
      const response = await call(port, method, "/exchanges/exchange-1", {
        token,
        headers,
        body: keyBody(KEY_B),
      });
      expect(response.status).toBe(401);
      expect(response.headers["www-authenticate"]).toContain("Bearer");
      expect(host.mapping()).toEqual(before);
    },
  );

  it("refuses the token given in the query string", async () => {
    const host = fixtureHost();
    const { port } = await startRegistrar(host);
    const response = await call(
      port,
      "DELETE",
      `/exchanges/exchange-1?token=${REGISTRAR_TOKEN}`,
    );
    expect(response.status).toBe(401);
  });

  it("answers a CORS preflight without the token, allowing no credentials", async () => {
    const host = fixtureHost();
    const { port } = await startRegistrar(host);
    const response = await call(port, "OPTIONS", "/exchanges/exchange-1");
    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-methods"]).toBe(
      "POST, PUT, DELETE",
    );
    expect(response.headers["access-control-allow-headers"]).toBe(
      "Authorization, Content-Type",
    );
    expect(host.mapping()).toEqual([]);
  });

  it("registers, replaces the prior row, and revokes, stating each lapse", async () => {
    const host = fixtureHost();
    const { port, log } = await startRegistrar(host);
    const first = await call(port, "PUT", "/exchanges/exchange-1", {
      token: REGISTRAR_TOKEN,
      body: keyBody(KEY_A, "30"),
    });
    expect(first.status, first.text).toBe(200);
    const firstBody = JSON.parse(first.text);
    expect(firstBody.message).toContain("registered exchange exchange-1");
    expect(firstBody.maxAgeDays).toBe(30);
    expect(
      Date.parse(firstBody.lapsesAt) - (Date.now() + 30 * DAY * 1000),
    ).toBeLessThan(60000);
    expect(host.mapping()).toMatchObject([
      { id: "exchange-1", key: KEY_A, days: 30 },
    ]);
    expect(host.rows()).toContain(listed(KEY_A));

    const second = await call(port, "PUT", "/exchanges/exchange-1", {
      token: REGISTRAR_TOKEN,
      body: keyBody(KEY_B, "null"),
    });
    expect(second.status, second.text).toBe(200);
    const secondBody = JSON.parse(second.text);
    expect(secondBody.message).toContain("it has no lapse");
    expect(secondBody.maxAgeDays).toBeNull();
    expect(secondBody.lapsesAt).toBeNull();
    expect(host.mapping()).toMatchObject([
      { id: "exchange-1", key: KEY_B, days: null },
    ]);
    expect(host.rows()).toEqual([listed(KEY_LISTED), listed(KEY_B)].sort());

    const revoked = await call(port, "DELETE", "/exchanges/exchange-1", {
      token: REGISTRAR_TOKEN,
    });
    expect(revoked.status, revoked.text).toBe(200);
    expect(host.mapping()).toEqual([]);
    expect(host.rows()).toEqual([listed(KEY_LISTED)]);

    await vi.waitFor(() => {
      expect(log.stderr).toMatch(
        /credential issuance: exchange=exchange-1 \S+ outcome=registered authority=relay-owner-token/,
      );
      expect(log.stderr).toMatch(
        /credential issuance: exchange=exchange-1 time=\S+ outcome=revoked authority=relay-owner-token\n/,
      );
    });
    for (const text of [first.text, second.text, revoked.text, log.stderr]) {
      expect(text).not.toMatch(HEX64);
      expect(text).not.toContain(REGISTRAR_TOKEN);
    }
  });

  it("refuses a body without maxAgeDays, so a re-registration keeps its lapse", async () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A, "30");
    const { port } = await startRegistrar(host);
    const response = await call(port, "PUT", "/exchanges/exchange-1", {
      token: REGISTRAR_TOKEN,
      body: JSON.stringify({ key: KEY_B }),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.text).error).toBe(BODY_REFUSAL);
    expect(host.mapping()).toMatchObject([{ key: KEY_A, days: 30 }]);
  });

  it("refuses an id under verify.sh's prefix unless the request is verify.sh's", async () => {
    const host = fixtureHost();
    const { port } = await startRegistrar(host);
    const refused = await call(port, "PUT", "/exchanges/alcove-verify-x", {
      token: REGISTRAR_TOKEN,
      body: keyBody(KEY_A),
    });
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.text).error).toContain(
      "may not start with 'alcove-verify-'",
    );
    expect(host.mapping()).toEqual([]);
    const verifying = await call(port, "PUT", "/exchanges/alcove-verify-x", {
      token: REGISTRAR_TOKEN,
      body: keyBody(KEY_A),
      headers: { "Alcove-Relay-Verify-Run": "1" },
    });
    expect(verifying.status, verifying.text).toBe(200);
  });

  it("answers a refusal of the exchange's state 409 and never the key", async () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    const { port, log } = await startRegistrar(host);
    const held = await call(port, "PUT", "/exchanges/exchange-2", {
      token: REGISTRAR_TOKEN,
      body: keyBody(KEY_A),
    });
    expect(held.status).toBe(409);
    expect(JSON.parse(held.text).error).toContain(
      "already registered for exchange exchange-1",
    );
    const unregistered = await call(port, "DELETE", "/exchanges/exchange-9", {
      token: REGISTRAR_TOKEN,
    });
    expect(unregistered.status).toBe(409);
    expect(JSON.parse(unregistered.text).error).toContain(
      "exchange-id exchange-9 is not registered",
    );
    for (const text of [held.text, log.stderr]) {
      expect(text).not.toContain(KEY_A);
    }
  });

  it("answers a fixed 500 when the table cannot be written, and logs the cause", async () => {
    const host = fixtureHost();
    const { port, log } = await startRegistrar(host);
    host.makeTableReadOnly();
    const response = await call(port, "PUT", "/exchanges/exchange-1", {
      token: REGISTRAR_TOKEN,
      body: keyBody(KEY_A),
    });
    expect(response.status).toBe(500);
    expect(JSON.parse(response.text)).toEqual({ error: TABLE_FAILURE });
    await vi.waitFor(() =>
      expect(log.stderr).toMatch(
        /could not \S+ the secrets table .*readonly database; nothing changed/,
      ),
    );
    expect(log.stderr).not.toContain(KEY_A);
  });

  it("answers the same fixed 500 to any caller when the table is missing, naming no path", async () => {
    const host = fixtureHost();
    const { port, log } = await startRegistrar(host);
    host.removeTable();
    const responses = [
      await call(port, "PUT", "/exchanges/exchange-1", {
        token: REGISTRAR_TOKEN,
        body: keyBody(KEY_A),
      }),
      await call(port, "PUT", "/exchanges/exchange-1", {
        body: keyBody(KEY_A),
        headers: {
          Authorization: `Alcove-Relay-Proof ts=${nowSeconds()},mac=${"0".repeat(64)}`,
        },
      }),
    ];
    for (const response of responses) {
      expect(response.status).toBe(500);
      expect(JSON.parse(response.text)).toEqual({ error: TABLE_FAILURE });
      expect(response.text).not.toContain(host.root);
    }
    await vi.waitFor(() =>
      expect(log.stderr).toContain(`no secrets table at ${host.turndb}`),
    );
  });

  it("checks a proof before opening the table for writing", async () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    const { port } = await startRegistrar(host);
    host.makeTableReadOnly();
    const refused = await call(port, "DELETE", "/exchanges/exchange-1", {
      headers: {
        Authorization: `Alcove-Relay-Proof ts=${nowSeconds()},mac=${"0".repeat(64)}`,
      },
    });
    expect(refused.status, refused.text).toBe(409);
    expect(JSON.parse(refused.text).error).toBe(
      "the request's proof does not verify against the key exchange exchange-1 holds on this relay",
    );
  });

  it("closes a connection whose request trickles in past the deadline, and keeps answering others", async () => {
    const host = fixtureHost();
    const { port, log } = await startRegistrar(host, {
      REQUEST_DEADLINE_SECONDS: 2,
    });
    const started = Date.now();
    const closedAfter = await new Promise((resolveClosed, reject) => {
      const socket = connect(
        {
          host: "127.0.0.1",
          port,
          servername: "relay.example",
          ca: readFileSync(join(certDir, "fullchain.pem")),
        },
        () => {
          const line = "DELETE /exchanges/exchange-1 HTTP/1.1\r\n";
          let sent = 0;
          const trickle = setInterval(() => {
            if (sent < line.length && !socket.destroyed) {
              socket.write(line[sent]);
              sent += 1;
            }
          }, 250);
          socket.on("close", () => {
            clearInterval(trickle);
            resolveClosed(Date.now() - started);
          });
        },
      );
      socket.on("error", () => {});
      setTimeout(() => {
        socket.destroy();
        reject(new Error("the registrar did not close a trickling connection"));
      }, 8000);
    });
    expect(closedAfter).toBeGreaterThanOrEqual(1500);
    expect(closedAfter).toBeLessThan(5000);
    await vi.waitFor(() =>
      expect(log.stderr).toContain(
        "request timed out: it did not arrive whole within 2 s",
      ),
    );
    const fresh = await call(port, "DELETE", "/exchanges/exchange-1");
    expect(fresh.status).toBe(401);
  });

  it("answers a write 200 after its read deadline lapsed, and a request whose table wait outlasts the deadline 503 with no write", async () => {
    const host = fixtureHost();
    const { port } = await startRegistrar(host, {
      REQUEST_DEADLINE_SECONDS: 2,
      RESPONSE_DEADLINE_SECONDS: 5,
      "relay_table.BUSY_TIMEOUT_SECONDS": 8,
    });
    const holder = spawn("python3", [
      "-B",
      "-c",
      `import sqlite3, sys, time
conn = sqlite3.connect(sys.argv[1], isolation_level=None)
conn.execute("BEGIN IMMEDIATE")
print("held", flush=True)
time.sleep(4)
conn.execute("ROLLBACK")`,
      host.turndb,
    ]);
    try {
      await new Promise((resolveHeld) =>
        holder.stdout.once("data", resolveHeld),
      );
      const slow = call(port, "PUT", "/exchanges/exchange-1", {
        token: REGISTRAR_TOKEN,
        body: keyBody(KEY_A),
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      const starved = await call(port, "PUT", "/exchanges/exchange-2", {
        token: REGISTRAR_TOKEN,
        body: keyBody(KEY_B),
      });
      expect(starved.status).toBe(503);
      expect(starved.headers["retry-after"]).toBe("5");
      const answered = await slow;
      expect(answered.status, answered.text).toBe(200);
      expect(host.mapping().map((row) => row.id)).toEqual(["exchange-1"]);
    } finally {
      holder.kill();
    }
  });

  // Bounds a registrar that never frees a slot, well inside the describe's
  // timeout.
  const SLOT_FREED_WAIT = { timeout: 20_000, interval: 50 };

  it("answers 503 past the handler cap, closes past the busy cap, and serves again once a slot frees", async () => {
    const host = fixtureHost();
    // Deadlines past the test's own timeout, so no held connection lapses and
    // frees its slot between the cap assertions on a loaded host.
    const { port } = await startRegistrar(host, {
      MAX_HANDLERS: 2,
      MAX_BUSY_ANSWERS: 1,
      REQUEST_DEADLINE_SECONDS: 120,
      BUSY_DEADLINE_SECONDS: 120,
    });
    const silent = () =>
      new Promise((resolveSocket, reject) => {
        const socket = connect(
          {
            host: "127.0.0.1",
            port,
            servername: "relay.example",
            ca: readFileSync(join(certDir, "fullchain.pem")),
          },
          () => resolveSocket(socket),
        );
        socket.on("error", reject);
      });
    const held = [await silent(), await silent()];
    try {
      const busy = await call(port, "DELETE", "/exchanges/exchange-1");
      expect(busy.status).toBe(503);
      expect(JSON.parse(busy.text)).toEqual({ error: BUSY_REFUSAL });
      expect(busy.headers["retry-after"]).toBe("5");
      // The registrar frees the busy slot just after closing the 503's
      // connection, so a connection made at once can still find it taken and be
      // closed unanswered; one that completes a handshake holds the slot.
      held.push(await vi.waitFor(() => silent(), SLOT_FREED_WAIT));
      await expect(
        call(port, "DELETE", "/exchanges/exchange-1"),
      ).rejects.toThrow();
    } finally {
      for (const socket of held) socket.destroy();
    }
    await vi.waitFor(async () => {
      const served = await call(port, "DELETE", "/exchanges/exchange-1");
      expect(served.status).toBe(401);
    }, SLOT_FREED_WAIT);
  });

  it("refuses a request whose headers exceed the bound", async () => {
    const host = fixtureHost();
    const { port } = await startRegistrar(host);
    const response = await call(port, "DELETE", "/exchanges/exchange-1", {
      token: REGISTRAR_TOKEN,
      headers: { "X-Padding": "p".repeat(9000) },
    });
    expect(response.status).toBe(431);
    expect(host.mapping()).toEqual([]);
  });

  it("accepts the managed-exchange record's largest max age", async () => {
    const host = fixtureHost();
    const { port } = await startRegistrar(host);
    const response = await call(port, "PUT", "/exchanges/exchange-1", {
      token: REGISTRAR_TOKEN,
      body: keyBody(KEY_A, `${MAX_TOKEN_MAX_AGE_DAYS}`),
    });
    expect(response.status, response.text).toBe(200);
    expect(host.mapping()[0].days).toBe(MAX_TOKEN_MAX_AGE_DAYS);
  });

  it.each([
    ["an id of $(id)", "PUT", "/exchanges/$(id)", keyBody(KEY_A), ID_REFUSAL],
    ["an id of $(id)", "DELETE", "/exchanges/$(id)", "", ID_REFUSAL],
    [
      "an id with a semicolon",
      "PUT",
      "/exchanges/a;b",
      keyBody(KEY_A),
      ID_REFUSAL,
    ],
    [
      "a 3000-character id",
      "PUT",
      `/exchanges/${"a".repeat(3000)}`,
      keyBody(KEY_A),
      ID_REFUSAL,
    ],
    ["an id starting with '-'", "DELETE", "/exchanges/-rf", "", ID_REFUSAL],
    [
      "an id shaped like a key",
      "PUT",
      `/exchanges/${KEY_B}`,
      keyBody(KEY_A),
      ID_REFUSAL,
    ],
    [
      "an id of a name and a key",
      "PUT",
      `/exchanges/name-${KEY_B}`,
      keyBody(KEY_A),
      ID_REFUSAL,
    ],
    [
      "a key with a newline",
      "PUT",
      "/exchanges/exchange-1",
      keyBody(`${KEY_A.slice(1)}\n`),
      KEY_REFUSAL,
    ],
    [
      "an uppercase key",
      "PUT",
      "/exchanges/exchange-1",
      keyBody(KEY_A.toUpperCase()),
      KEY_REFUSAL,
    ],
    [
      "maxAgeDays 0",
      "PUT",
      "/exchanges/exchange-1",
      keyBody(KEY_A, "0"),
      MAX_AGE_REFUSAL,
    ],
    [
      "maxAgeDays as a string",
      "PUT",
      "/exchanges/exchange-1",
      keyBody(KEY_A, '"3"'),
      MAX_AGE_REFUSAL,
    ],
    [
      "maxAgeDays as a boolean",
      "PUT",
      "/exchanges/exchange-1",
      keyBody(KEY_A, "true"),
      MAX_AGE_REFUSAL,
    ],
    [
      "a fractional maxAgeDays",
      "PUT",
      "/exchanges/exchange-1",
      keyBody(KEY_A, "1.5"),
      MAX_AGE_REFUSAL,
    ],
    [
      "one day over the largest maxAgeDays",
      "PUT",
      "/exchanges/exchange-1",
      keyBody(KEY_A, `${MAX_TOKEN_MAX_AGE_DAYS + 1}`),
      MAX_AGE_REFUSAL,
    ],
    [
      "an unknown field",
      "PUT",
      "/exchanges/exchange-1",
      JSON.stringify({ key: KEY_A, maxAgeDays: null, label: "x" }),
      BODY_REFUSAL,
    ],
    [
      "no key",
      "PUT",
      "/exchanges/exchange-1",
      JSON.stringify({ maxAgeDays: 3 }),
      BODY_REFUSAL,
    ],
    [
      "an array",
      "PUT",
      "/exchanges/exchange-1",
      JSON.stringify([KEY_A, null]),
      BODY_REFUSAL,
    ],
    [
      "not JSON",
      "PUT",
      "/exchanges/exchange-1",
      "{",
      "the request body is not JSON",
    ],
  ])(
    "refuses %s (%s) 400 naming the field and writes nothing",
    async (_, method, path, body, refusal) => {
      const host = fixtureHost();
      const { port } = await startRegistrar(host);
      const response = await call(port, method, path, {
        token: REGISTRAR_TOKEN,
        body: body === "" ? undefined : body,
      });
      expect(response.status).toBe(400);
      expect(JSON.parse(response.text).error).toBe(refusal);
      expect(response.text).not.toContain(KEY_A);
      expect(host.mapping()).toEqual([]);
      expect(host.rows()).toEqual([listed(KEY_LISTED)]);
    },
  );

  it("journals no path that can carry a key", async () => {
    const host = fixtureHost();
    const { port, log } = await startRegistrar(host);
    const put = await call(port, "PUT", `/exchanges/${KEY_A}`, {
      token: REGISTRAR_TOKEN,
      body: keyBody(KEY_B),
    });
    expect(put.status).toBe(400);
    const deleted = await call(port, "DELETE", `/exchanges/${KEY_A}`, {
      token: REGISTRAR_TOKEN,
    });
    expect(deleted.status).toBe(400);
    const unauthorized = await call(port, "DELETE", `/exchanges/${KEY_A}`);
    expect(unauthorized.status).toBe(401);
    const malformed = await Promise.all(
      [
        `PUT /exchanges/${KEY_A} HTTP/1.1 extra\r\n\r\n`,
        `${KEY_A} /exchanges/exchange-1 HTTP/1.1\r\nConnection: close\r\n\r\n`,
        `PUT ${KEY_A}\r\n\r\n`,
        `PUT /exchanges/exchange-1 HTTP/${KEY_A}\r\n\r\n`,
      ].map((line) => callRaw(port, [line])),
    );
    for (const text of malformed) {
      expect(text).not.toContain(KEY_A);
    }
    await vi.waitFor(() => {
      expect(
        log.stderr.split("\n").filter((line) => / 40\d$/.test(line)),
      ).toHaveLength(7);
    });
    expect(log.stderr).toContain("(path withheld) 400");
    expect(log.stderr).not.toMatch(HEX64);
    const registered = await call(port, "DELETE", "/exchanges/exchange-1", {
      token: REGISTRAR_TOKEN,
    });
    expect(registered.status).toBe(409);
    await vi.waitFor(() =>
      expect(log.stderr).toContain("DELETE /exchanges/exchange-1 409"),
    );
  });

  it.each(["TRACE", "PROPFIND", "CONNECT", "GET"])(
    "refuses %s in JSON, 401 without the token and 405 with it",
    async (method) => {
      const host = fixtureHost();
      host.register("exchange-1", KEY_A);
      const { port } = await startRegistrar(host);
      for (const [headers, status] of [
        [{}, "401"],
        [{ Authorization: `Bearer ${REGISTRAR_TOKEN}` }, "405"],
      ]) {
        const text = await callRaw(port, [
          rawRequest(method, "/exchanges/exchange-1", {
            ...headers,
            Connection: "close",
          }),
        ]);
        expect(text).toMatch(new RegExp(`^HTTP/1\\.1 ${status} `));
        expect(text).toMatch(/^Content-Type: application\/json\r$/im);
        expect(
          JSON.parse(text.slice(text.indexOf("\r\n\r\n") + 4)),
        ).toHaveProperty("error");
      }
      expect(host.mapping().map(({ id }) => id)).toEqual(["exchange-1"]);
    },
  );

  it("refuses an oversized or unsized body before reading it", async () => {
    const host = fixtureHost();
    const { port } = await startRegistrar(host);
    const oversized = await call(port, "PUT", "/exchanges/exchange-1", {
      token: REGISTRAR_TOKEN,
      body: JSON.stringify({ key: KEY_A, pad: "x".repeat(2000) }),
    });
    expect(oversized.status).toBe(413);
    const chunked = await call(port, "PUT", "/exchanges/exchange-1", {
      token: REGISTRAR_TOKEN,
      headers: { "Transfer-Encoding": "chunked" },
    });
    expect(chunked.status).toBe(411);
    expect(host.mapping()).toEqual([]);
  });

  it.each(["/exchanges/", "/exchanges/a/b", "/exchanges/a?b=c", "/other"])(
    "answers %s 404 with the token and writes nothing",
    async (path) => {
      const host = fixtureHost();
      const { port } = await startRegistrar(host);
      const response = await call(port, "DELETE", path, {
        token: REGISTRAR_TOKEN,
      });
      expect(response.status).toBe(404);
    },
  );

  it("reads a DELETE's and a preflight's body so the next request parses", async () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    const { port } = await startRegistrar(host);
    const auth = { Authorization: `Bearer ${REGISTRAR_TOKEN}` };
    const text = await callRaw(port, [
      rawRequest("DELETE", "/exchanges/exchange-1", auth, '{"ignored": 1}'),
      rawRequest("OPTIONS", "/exchanges/exchange-2", {}, '{"ignored": 2}'),
      rawRequest(
        "PUT",
        "/exchanges/exchange-2",
        { ...auth, Connection: "close" },
        keyBody(KEY_B),
      ),
    ]);
    expect(
      [...text.matchAll(/^HTTP\/1\.1 (\d{3})/gm)].map((match) => match[1]),
    ).toEqual(["200", "204", "200"]);
    expect(host.mapping().map(({ id }) => id)).toEqual(["exchange-2"]);
  });

  it("ends the connection after a DELETE whose body it does not read", async () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    const { port } = await startRegistrar(host);
    const text = await callRaw(port, [
      rawRequest(
        "DELETE",
        "/exchanges/exchange-1",
        { Authorization: `Bearer ${REGISTRAR_TOKEN}` },
        "x".repeat(2000),
      ),
    ]);
    expect(text).toMatch(/^HTTP\/1\.1 200/);
    expect(text).toMatch(/^Connection: close\r$/im);
    expect(host.mapping()).toEqual([]);
  });

  it.each([
    ["a short token", "a".repeat(31)],
    ["a token with punctuation", `${"a".repeat(40)}!`],
    ["an empty token", ""],
  ])("refuses to start with %s", (_, token) => {
    const host = fixtureHost();
    const result = spawnSync("python3", [join(relay, "registrar.py")], {
      encoding: "utf8",
      env: { ...registrarEnv(host, token), ALCOVE_RELAY_REGISTRAR_PORT: "0" },
      timeout: 10000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("registrar-token");
  });

  it("binds its port without looking up a hostname", () => {
    python(`import socket
import registrar
def refuse(*args):
    raise AssertionError("looked up a hostname")
socket.getfqdn = socket.gethostbyaddr = refuse
registrar.RegistrarServer(("127.0.0.1", 0), registrar.RegistrarHandler).server_close()`);
  });

  it("reads the token and certificate from systemd's credentials directory", async () => {
    const host = fixtureHost();
    const credentials = join(host.root, "credentials");
    rmSync(credentials, { recursive: true, force: true });
    spawnSync("cp", ["-r", certDir, credentials]);
    writeFileSync(join(credentials, "registrar-token"), `${REGISTRAR_TOKEN}\n`);
    const env = registrarEnv(host);
    delete env.ALCOVE_RELAY_REGISTRAR_TOKEN_FILE;
    delete env.ALCOVE_RELAY_CERT_DIR;
    env.CREDENTIALS_DIRECTORY = credentials;
    const { port } = await startRegistrarWith(env);
    const response = await call(port, "PUT", "/exchanges/exchange-1", {
      token: REGISTRAR_TOKEN,
      body: keyBody(KEY_A),
    });
    expect(response.status, response.text).toBe(200);
  });
});

// The vector block under docs/spec/PROTOCOL.md's "The registrar request
// proof": a group of shared fields, then one group per request.
const protocolVectors = () => {
  const text = readFileSync(
    resolve(here, "..", "docs/spec/PROTOCOL.md"),
    "utf8",
  );
  const section = text.slice(text.indexOf("\n### The registrar request proof"));
  const open = section.indexOf("\n```text\n");
  const block = section.slice(open + 9, section.indexOf("\n```", open + 9));
  const [shared, ...requests] = block.split("\n\n").map((group) =>
    Object.fromEntries(
      group.split("\n").map((line) => {
        const match = /^([a-z0-9_]+) +=(?: (.*))?$/.exec(line);
        if (match === null) throw new Error(`unparsed vector line: ${line}`);
        return [match[1], match[2] ?? ""];
      }),
    ),
  );
  return { shared, requests };
};

describe("registrar.py proof verifier", () => {
  it("derives and checks PROTOCOL.md's vectors, and no other key's or request's proof", () => {
    const { shared, requests } = protocolVectors();
    expect(requests.map(({ method }) => method)).toEqual(["PUT", "DELETE"]);
    const result = python(
      `import json, sys
import registrar
shared, requests = json.loads(sys.argv[1]), json.loads(sys.argv[2])
key, exchange_id, ts = shared["relay_key"], shared["exchange_id"], int(shared["ts"])
out = {"proof_key": registrar.proof_key(key).hex(), "requests": []}
for request in requests:
    body = request["body"].encode("utf-8")
    scheme, _, parameters = request["authorization"].partition(" ")
    match = registrar.PROOF_PARAMETERS.fullmatch(parameters)
    proof = registrar.Proof(int(match.group(1)), match.group(2))
    other_method = "DELETE" if request["method"] == "PUT" else "PUT"
    out["requests"].append({
        "scheme": scheme,
        "body_sha256": registrar.hashlib.sha256(body).hexdigest(),
        "mac": registrar.proof_mac(key, request["method"], exchange_id, body, ts),
        "verifies": proof.made_under(key, request["method"], exchange_id, body),
        "under_other_key": proof.made_under("0" * 64, request["method"], exchange_id, body),
        "for_other_method": proof.made_under(key, other_method, exchange_id, body),
        "for_other_id": proof.made_under(key, request["method"], "exchange-2", body),
        "for_other_body": proof.made_under(key, request["method"], exchange_id, body + b" "),
    })
print(json.dumps(out))`,
      [JSON.stringify(shared), JSON.stringify(requests)],
      { PYTHONDONTWRITEBYTECODE: "1" },
    );
    expect(result.proof_key).toBe(shared.proof_key);
    for (const [i, request] of requests.entries()) {
      expect(result.requests[i]).toEqual({
        scheme: "Alcove-Relay-Proof",
        body_sha256: request.body_sha256,
        mac: request.mac,
        verifies: true,
        under_other_key: false,
        for_other_method: false,
        for_other_id: false,
        for_other_body: false,
      });
    }
  });
});

// The routine rotation and revocation, each signed by core's helper and sent
// with no relay-owner token.
const proven = async (
  port,
  method,
  exchangeId,
  relayKey,
  { body = "", now = new Date(), headers = {} } = {},
) =>
  call(port, method, `/exchanges/${exchangeId}`, {
    body: body === "" ? undefined : body,
    headers: {
      Authorization: await relayRegistrarAuthorization({
        relayKey,
        method,
        exchangeId,
        body,
        now,
      }),
      ...headers,
    },
  });

const enroll = async (port, exchangeId, key, maxAgeDays = "null") =>
  call(port, "POST", `/exchanges/${exchangeId}`, {
    token: REGISTRAR_TOKEN,
    body: keyBody(key, maxAgeDays),
  });

describe.skipIf(runningAsRoot)(
  "registrar.py enrollment and proofs",
  { timeout: 60000 },
  () => {
    it("enrolls under the token, accepts the same key again unchanged, and refuses another key", async () => {
      const host = fixtureHost();
      const { port, log } = await startRegistrar(host);
      const first = await enroll(port, "exchange-1", KEY_A, "30");
      expect(first.status, first.text).toBe(200);
      expect(JSON.parse(first.text).message).toContain(
        "registered exchange exchange-1",
      );
      const before = host.mapping();
      const same = await enroll(port, "exchange-1", KEY_A, "null");
      expect(same.status, same.text).toBe(200);
      expect(JSON.parse(same.text)).toMatchObject({
        maxAgeDays: 30,
        message: expect.stringContaining(
          "already enrolled with this key; nothing changed",
        ),
      });
      const other = await enroll(port, "exchange-1", KEY_B);
      expect(other.status).toBe(409);
      expect(JSON.parse(other.text).error).toContain(
        "already enrolled on this relay with another key",
      );
      expect(host.mapping()).toEqual(before);
      expect(host.rows()).toEqual([listed(KEY_LISTED), listed(KEY_A)].sort());
      await vi.waitFor(() =>
        expect(log.stderr).toMatch(
          /credential issuance: exchange=exchange-1 \S+ outcome=registered authority=relay-owner-token/,
        ),
      );
      for (const text of [first.text, same.text, other.text, log.stderr]) {
        expect(text).not.toMatch(HEX64);
      }
    });

    // docs/notes/webrtc-relay-deployment.md, What the relay host keeps,
    // states this line's format.
    it("journals one issuance line a registration, naming the exchange and the time and nothing about the caller", async () => {
      const host = fixtureHost();
      const { port, log } = await startRegistrar(host);
      const started = Date.now();
      const responses = [
        await enroll(port, "exchange-1", KEY_A),
        await enroll(port, "exchange-1", KEY_A),
        await proven(port, "PUT", "exchange-1", KEY_A, {
          body: keyBody(KEY_B),
        }),
        await proven(port, "PUT", "exchange-1", KEY_B, {
          body: keyBody(KEY_B),
        }),
      ];
      for (const response of responses) {
        expect(response.status, response.text).toBe(200);
      }
      const issuance = () =>
        log.stderr
          .split("\n")
          .filter((line) => line.startsWith("credential issuance:"));
      await vi.waitFor(() => expect(issuance()).toHaveLength(4));
      const lines = issuance();
      const shape =
        /^credential issuance: exchange=exchange-1 time=(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) outcome=(\w+) authority=([\w-]+)$/;
      expect(lines.map((line) => shape.exec(line)?.slice(2))).toEqual([
        ["registered", "relay-owner-token"],
        ["unchanged", "relay-owner-token"],
        ["replaced", "proof"],
        ["renewed", "proof"],
      ]);
      for (const line of lines) {
        const at = Date.parse(shape.exec(line)[1]);
        expect(at).toBeGreaterThanOrEqual(Math.floor(started / 1000) * 1000);
        expect(at).toBeLessThanOrEqual(Date.now());
      }
      // The whole journal, not only the issuance lines: the request lines
      // beside them name no caller either.
      expect(log.stderr).not.toContain("127.0.0.1");
      expect(log.stderr).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
      expect(log.stderr).not.toMatch(/\[?::1\]?|::ffff:/);
      expect(log.stderr).not.toMatch(HEX64);
      expect(log.stderr).not.toContain(REGISTRAR_TOKEN);
      expect(log.stderr).not.toContain("Alcove-Relay-Proof");
      // Revocation, refusals and connection errors write to the same journal.
      const revokedUnderToken = await call(
        port,
        "DELETE",
        "/exchanges/exchange-1",
        { token: REGISTRAR_TOKEN },
      );
      expect(revokedUnderToken.status, revokedUnderToken.text).toBe(200);
      expect((await enroll(port, "exchange-2", KEY_A)).status).toBe(200);
      const revokedUnderProof = await proven(
        port,
        "DELETE",
        "exchange-2",
        KEY_A,
      );
      expect(revokedUnderProof.status, revokedUnderProof.text).toBe(200);
      expect((await enroll(port, "exchange-3", KEY_A)).status).toBe(200);
      const badToken = await call(port, "POST", "/exchanges/exchange-4", {
        token: REGISTRAR_TOKEN.slice(1),
        body: keyBody(KEY_A),
      });
      expect(badToken.status).toBe(401);
      const wrongKey = await proven(port, "PUT", "exchange-3", KEY_B, {
        body: keyBody(KEY_C),
      });
      expect(wrongKey.status).toBe(409);
      await new Promise((resolveDone) => {
        const plain = netConnect({ host: "127.0.0.1", port }, () =>
          plain.write("GET /exchanges/exchange-3 HTTP/1.1\r\nHost: x\r\n\r\n"),
        );
        plain.on("error", () => {});
        plain.on("close", resolveDone);
        setTimeout(() => plain.destroy(), 1000);
      });
      await new Promise((resolveDone) => {
        const bare = netConnect({ host: "127.0.0.1", port }, () =>
          bare.destroy(),
        );
        bare.on("error", () => {});
        bare.on("close", resolveDone);
        setTimeout(() => bare.destroy(), 1000);
      });
      await new Promise((resolveDone) => {
        const truncated = connect(
          {
            host: "127.0.0.1",
            port,
            servername: "relay.example",
            ca: readFileSync(join(certDir, "fullchain.pem")),
          },
          () => {
            truncated.write(
              [
                "POST /exchanges/exchange-5 HTTP/1.1",
                "Host: relay.example",
                `Authorization: Bearer ${REGISTRAR_TOKEN}`,
                "Content-Length: 500",
                "",
                '{"key": "',
              ].join("\r\n"),
            );
            truncated.end();
          },
        );
        truncated.on("error", () => {});
        truncated.on("close", resolveDone);
        setTimeout(() => truncated.destroy(), 1000);
      });
      await vi.waitFor(() => {
        expect(issuance()).toHaveLength(8);
        expect(log.stderr).toContain("POST /exchanges/exchange-4 401");
        expect(log.stderr).toContain("PUT /exchanges/exchange-3 409");
      });
      expect(
        issuance().filter((line) => line.includes("outcome=revoked")),
      ).toHaveLength(2);
      expect(log.stderr).not.toMatch(
        /(?<![\d:])\d{1,3}(\.\d{1,3}){3}(?![\d:])/,
      );
      expect(log.stderr).not.toMatch(
        /(?<![\d:])(\p{AHex}{0,4}:){2,7}\p{AHex}{0,4}(?![\d:])(?<!\d\d:\d\d:\d\d)/u,
      );
      expect(log.stderr).not.toMatch(/::/);
      expect(log.stderr).not.toMatch(HEX64);
      expect(log.stderr).not.toContain(REGISTRAR_TOKEN);
      expect(log.stderr).not.toContain(REGISTRAR_TOKEN.slice(1));
      expect(log.stderr.toLowerCase()).not.toContain("alcove-relay-proof");
    });

    it("refuses to enroll under a proof", async () => {
      const host = fixtureHost();
      const { port } = await startRegistrar(host);
      const response = await call(port, "POST", "/exchanges/exchange-1", {
        body: keyBody(KEY_A),
        headers: {
          Authorization: await relayRegistrarAuthorization({
            relayKey: KEY_A,
            method: "PUT",
            exchangeId: "exchange-1",
            body: keyBody(KEY_A),
            now: new Date(),
          }),
        },
      });
      expect(response.status).toBe(401);
      expect(JSON.parse(response.text).error).toContain(
        "enroll with Authorization: Bearer",
      );
      expect(host.mapping()).toEqual([]);
    });

    it("rotates and revokes under proofs alone, never the token", async () => {
      const host = fixtureHost();
      const { port, log } = await startRegistrar(host);
      await enroll(port, "exchange-1", KEY_A);
      const rotated = await proven(port, "PUT", "exchange-1", KEY_A, {
        body: keyBody(KEY_B, "7"),
      });
      expect(rotated.status, rotated.text).toBe(200);
      expect(JSON.parse(rotated.text)).toMatchObject({
        maxAgeDays: 7,
        message: expect.stringContaining("replacing its prior key"),
      });
      expect(host.mapping()).toMatchObject([{ key: KEY_B, days: 7 }]);
      expect(host.rows()).toEqual([listed(KEY_LISTED), listed(KEY_B)].sort());
      const revoked = await proven(port, "DELETE", "exchange-1", KEY_B);
      expect(revoked.status, revoked.text).toBe(200);
      expect(host.mapping()).toEqual([]);
      expect(host.rows()).toEqual([listed(KEY_LISTED)]);
      await vi.waitFor(() => {
        expect(log.stderr).toMatch(
          /credential issuance: exchange=exchange-1 \S+ outcome=replaced authority=proof/,
        );
        expect(log.stderr).toMatch(
          /credential issuance: exchange=exchange-1 time=\S+ outcome=revoked authority=proof\n/,
        );
      });
      expect(log.stderr).not.toMatch(HEX64);
    });

    it("refuses a proof under a key the exchange does not hold, and a forged one", async () => {
      const host = fixtureHost();
      const { port } = await startRegistrar(host);
      await enroll(port, "exchange-1", KEY_A);
      const refusals = [
        await proven(port, "PUT", "exchange-1", KEY_C, {
          body: keyBody(KEY_B),
        }),
        await proven(port, "DELETE", "exchange-1", KEY_C),
        await call(port, "PUT", "/exchanges/exchange-1", {
          body: keyBody(KEY_B),
          headers: {
            Authorization: `Alcove-Relay-Proof ts=${nowSeconds()},mac=${"0".repeat(64)}`,
          },
        }),
      ];
      for (const refused of refusals) {
        expect(refused.status).toBe(409);
        expect(JSON.parse(refused.text).error).toBe(
          "the request's proof does not verify against the key exchange exchange-1 holds on this relay",
        );
      }
      expect(host.mapping().map(({ key }) => key)).toEqual([KEY_A]);
    });

    const enrollVerifyRun = async (port) => {
      const enrolled = await call(port, "POST", "/exchanges/alcove-verify-x", {
        token: REGISTRAR_TOKEN,
        body: keyBody(KEY_A),
        headers: { "Alcove-Relay-Verify-Run": "1" },
      });
      expect(enrolled.status, enrolled.text).toBe(200);
    };

    it("rotates a verify.sh id under a proof sent with the verify-run header", async () => {
      const host = fixtureHost();
      const { port } = await startRegistrar(host);
      await enrollVerifyRun(port);
      const rotated = await proven(port, "PUT", "alcove-verify-x", KEY_A, {
        body: keyBody(KEY_B),
        headers: { "Alcove-Relay-Verify-Run": "1" },
      });
      expect(rotated.status, rotated.text).toBe(200);
      expect(host.mapping().map(({ key }) => key)).toEqual([KEY_B]);
    });

    it("refuses to rotate a verify.sh id under a proof sent without the verify-run header", async () => {
      const host = fixtureHost();
      const { port } = await startRegistrar(host);
      await enrollVerifyRun(port);
      const refused = await proven(port, "PUT", "alcove-verify-x", KEY_A, {
        body: keyBody(KEY_B),
      });
      expect(refused.status).toBe(400);
      expect(JSON.parse(refused.text).error).toContain(
        "may not start with 'alcove-verify-'",
      );
      expect(host.mapping().map(({ key }) => key)).toEqual([KEY_A]);
    });

    it("refuses a proof signed for another request", async () => {
      const host = fixtureHost();
      const { port } = await startRegistrar(host);
      await enroll(port, "exchange-1", KEY_A);
      const signedFor = async (method, exchangeId, body) =>
        relayRegistrarAuthorization({
          relayKey: KEY_A,
          method,
          exchangeId,
          body,
          now: new Date(),
        });
      const cases = [
        // A rotation's proof presented with another body.
        [
          "PUT",
          "exchange-1",
          keyBody(KEY_B, "30"),
          await signedFor("PUT", "exchange-1", keyBody(KEY_B, "null")),
        ],
        // A rotation's proof presented as a revocation.
        [
          "DELETE",
          "exchange-1",
          undefined,
          await signedFor("PUT", "exchange-1", ""),
        ],
      ];
      for (const [method, exchangeId, body, authorization] of cases) {
        const response = await call(port, method, `/exchanges/${exchangeId}`, {
          body,
          headers: { Authorization: authorization },
        });
        expect(response.status, `${method} ${exchangeId}`).toBe(409);
      }
      expect(host.mapping().map(({ key }) => key)).toEqual([KEY_A]);
    });

    it.each([
      ["305 s behind", -305],
      ["305 s ahead of", 305],
    ])(
      "refuses a proof %s the registrar's clock with 401 and its time",
      async (_, offsetSeconds) => {
        const host = fixtureHost();
        const { port } = await startRegistrar(host);
        await enroll(port, "exchange-1", KEY_A);
        const now = new Date(Date.now() + offsetSeconds * 1000);
        for (const response of [
          await proven(port, "PUT", "exchange-1", KEY_A, {
            body: keyBody(KEY_B),
            now,
          }),
          await proven(port, "DELETE", "exchange-1", KEY_A, { now }),
        ]) {
          expect(response.status).toBe(401);
          const answer = JSON.parse(response.text);
          expect(answer.error).toContain(
            "more than 300 s from the registrar's clock",
          );
          expect(Math.abs(answer.serverTime - nowSeconds())).toBeLessThan(30);
          expect(response.headers["www-authenticate"]).toContain(
            "Alcove-Relay-Proof",
          );
        }
        expect(host.mapping().map(({ key }) => key)).toEqual([KEY_A]);
      },
    );

    it("accepts a proof inside the window on either side", async () => {
      const host = fixtureHost();
      const { port } = await startRegistrar(host);
      await enroll(port, "exchange-1", KEY_A);
      const behind = await proven(port, "PUT", "exchange-1", KEY_A, {
        body: keyBody(KEY_B),
        now: new Date(Date.now() - 280 * 1000),
      });
      expect(behind.status, behind.text).toBe(200);
      const ahead = await proven(port, "PUT", "exchange-1", KEY_B, {
        body: keyBody(KEY_C),
        now: new Date(Date.now() + 280 * 1000),
      });
      expect(ahead.status, ahead.text).toBe(200);
      expect(host.mapping().map(({ key }) => key)).toEqual([KEY_C]);
    });

    it.each([
      ["no mac", `Alcove-Relay-Proof ts=${1767225600}`],
      ["an uppercase mac", `Alcove-Relay-Proof ts=1,mac=${"A".repeat(64)}`],
      ["a leading-zero ts", `Alcove-Relay-Proof ts=01,mac=${"a".repeat(64)}`],
      [
        "a space after the comma",
        `Alcove-Relay-Proof ts=1, mac=${"a".repeat(64)}`,
      ],
      [
        "the token beside a proof",
        `Alcove-Relay-Proof ts=1,mac=${"a".repeat(64)},token=${REGISTRAR_TOKEN}`,
      ],
    ])("refuses a proof header with %s, 401", async (_, authorization) => {
      const host = fixtureHost();
      const { port } = await startRegistrar(host);
      await enroll(port, "exchange-1", KEY_A);
      const response = await call(port, "PUT", "/exchanges/exchange-1", {
        body: keyBody(KEY_B),
        headers: { Authorization: authorization },
      });
      expect(response.status).toBe(401);
      expect(JSON.parse(response.text).error).toContain(
        "send the proof as Authorization: Alcove-Relay-Proof",
      );
      expect(response.text).not.toContain(REGISTRAR_TOKEN);
      expect(host.mapping().map(({ key }) => key)).toEqual([KEY_A]);
    });

    it("matches the proof scheme without regard to case", async () => {
      const host = fixtureHost();
      const { port } = await startRegistrar(host);
      await enroll(port, "exchange-1", KEY_A);
      const authorization = await relayRegistrarAuthorization({
        relayKey: KEY_A,
        method: "DELETE",
        exchangeId: "exchange-1",
        body: "",
        now: new Date(),
      });
      const response = await call(port, "DELETE", "/exchanges/exchange-1", {
        headers: {
          Authorization: authorization.replace(
            "Alcove-Relay-Proof",
            "alcove-relay-proof",
          ),
        },
      });
      expect(response.status, response.text).toBe(200);
    });

    it("refuses a proven write to an exchange not enrolled", async () => {
      const host = fixtureHost();
      const { port } = await startRegistrar(host);
      for (const response of [
        await proven(port, "PUT", "exchange-1", KEY_A, {
          body: keyBody(KEY_A),
        }),
        await proven(port, "DELETE", "exchange-1", KEY_A),
      ]) {
        expect(response.status).toBe(409);
        expect(JSON.parse(response.text).error).toBe(
          "exchange-id exchange-1 is not enrolled on this relay; enroll it with the relay-owner token",
        );
      }
      expect(host.mapping()).toEqual([]);
    });

    it("renews the row when the second party registers the key its partner already did", async () => {
      const host = fixtureHost();
      const { port } = await startRegistrar(host);
      await enroll(port, "exchange-1", KEY_A);
      // Both parties rotate from KEY_A to KEY_B and each registers KEY_B under
      // a proof made with KEY_A, the key it held.
      const first = await proven(port, "PUT", "exchange-1", KEY_A, {
        body: keyBody(KEY_B, "30"),
      });
      expect(first.status, first.text).toBe(200);
      host.stamp("exchange-1", 100);
      const second = await proven(port, "PUT", "exchange-1", KEY_A, {
        body: keyBody(KEY_B, "30"),
      });
      expect(second.status, second.text).toBe(200);
      expect(JSON.parse(second.text).message).toContain(
        "renewed exchange exchange-1",
      );
      const [row] = host.mapping();
      expect(row).toMatchObject({ key: KEY_B, days: 30 });
      expect(row.at).toBeGreaterThan(100);
      // A renewal under a proof made with the held key is the same write.
      const third = await proven(port, "PUT", "exchange-1", KEY_B, {
        body: keyBody(KEY_B, "30"),
      });
      expect(third.status, third.text).toBe(200);
    });

    it("refuses a rotation replayed after the key has moved on, and a replayed revocation", async () => {
      const host = fixtureHost();
      const { port } = await startRegistrar(host);
      await enroll(port, "exchange-1", KEY_A);
      const body = keyBody(KEY_B);
      const captured = await relayRegistrarAuthorization({
        relayKey: KEY_A,
        method: "PUT",
        exchangeId: "exchange-1",
        body,
        now: new Date(),
      });
      const replay = () =>
        call(port, "PUT", "/exchanges/exchange-1", {
          body,
          headers: { Authorization: captured },
        });
      expect((await replay()).status).toBe(200);
      const onward = await proven(port, "PUT", "exchange-1", KEY_B, {
        body: keyBody(KEY_C),
      });
      expect(onward.status, onward.text).toBe(200);
      expect((await replay()).status).toBe(409);
      expect(host.mapping().map(({ key }) => key)).toEqual([KEY_C]);

      const revocation = await relayRegistrarAuthorization({
        relayKey: KEY_C,
        method: "DELETE",
        exchangeId: "exchange-1",
        body: "",
        now: new Date(),
      });
      const revoke = () =>
        call(port, "DELETE", "/exchanges/exchange-1", {
          headers: { Authorization: revocation },
        });
      expect((await revoke()).status).toBe(200);
      await enroll(port, "exchange-1", KEY_A);
      expect((await revoke()).status).toBe(409);
      expect(host.mapping().map(({ key }) => key)).toEqual([KEY_A]);
    });

    it("lets only one of two concurrent rotations proven under one key land", async () => {
      const host = fixtureHost();
      const { port } = await startRegistrar(host);
      await enroll(port, "exchange-1", KEY_A);
      const racing = await Promise.all(
        [KEY_B, KEY_C].map((key) =>
          proven(port, "PUT", "exchange-1", KEY_A, { body: keyBody(key) }),
        ),
      );
      const statuses = racing.map(({ status }) => status);
      expect([...statuses].sort()).toEqual([200, 409]);
      const winner = statuses[0] === 200 ? KEY_B : KEY_C;
      expect(host.mapping().map(({ key }) => key)).toEqual([winner]);
      expect(host.rows()).toEqual([listed(KEY_LISTED), listed(winner)].sort());
    });

    it("hashes a proven revocation's body, so one signed empty is refused with a body", async () => {
      const host = fixtureHost();
      const { port } = await startRegistrar(host);
      await enroll(port, "exchange-1", KEY_A);
      const withBody = await call(port, "DELETE", "/exchanges/exchange-1", {
        body: "{}",
        headers: {
          Authorization: await relayRegistrarAuthorization({
            relayKey: KEY_A,
            method: "DELETE",
            exchangeId: "exchange-1",
            body: "",
            now: new Date(),
          }),
        },
      });
      expect(withBody.status).toBe(409);
      const signedBody = await proven(port, "DELETE", "exchange-1", KEY_A, {
        body: "{}",
      });
      expect(signedBody.status, signedBody.text).toBe(200);
    });

    it("keeps the token's register and revoke as the operator's recovery route", async () => {
      const host = fixtureHost();
      const { port } = await startRegistrar(host);
      await enroll(port, "exchange-1", KEY_A);
      const replaced = await call(port, "PUT", "/exchanges/exchange-1", {
        token: REGISTRAR_TOKEN,
        body: keyBody(KEY_B),
      });
      expect(replaced.status, replaced.text).toBe(200);
      expect(host.mapping().map(({ key }) => key)).toEqual([KEY_B]);
      const revoked = await call(port, "DELETE", "/exchanges/exchange-1", {
        token: REGISTRAR_TOKEN,
      });
      expect(revoked.status, revoked.text).toBe(200);
      expect(host.mapping()).toEqual([]);
    });
  },
);

// The CLI's registrar client, whose unit tests answer from a fake, sent to the
// real registrar. The client reaches it by address, as a configured
// relay_registrar.url does, and trusts the fixture certificate through the
// process's default CA list, since the client takes no CA of its own.
describe.skipIf(runningAsRoot)(
  "the CLI registrar client against registrar.py",
  { timeout: 60000 },
  () => {
    let defaultCertificates;

    beforeAll(() => {
      defaultCertificates = getCACertificates("default");
      setDefaultCACertificates([
        ...defaultCertificates,
        readFileSync(join(certDir, "fullchain.pem"), "utf8"),
      ]);
    });

    afterAll(() => {
      setDefaultCACertificates(defaultCertificates);
    });

    const sharedSecret = () => randomBytes(32).toString("base64url");

    it("enrolls, rotates under a proof, and is refused a rotation signed with the replaced key", async () => {
      const host = fixtureHost();
      const { port, log } = await startRegistrar(host);
      const registrar = {
        url: `https://127.0.0.1:${port}`,
        exchangeId: "exchange-1",
      };
      const enrolledSecret = sharedSecret();
      const rotatedSecret = sharedSecret();
      const enrolledKey = await deriveRelayKey(enrolledSecret);
      const rotatedKey = await deriveRelayKey(rotatedSecret);
      const noRetries = { retryDelaysMs: [] };

      const enrolled = await enrollRelayKey({
        registrar,
        sharedSecret: enrolledSecret,
        maxAgeDays: 30,
        ownerToken: REGISTRAR_TOKEN,
        replace: false,
      });
      expect(enrolled, log.stderr).toMatchObject({
        kind: "registered",
        maxAgeDays: 30,
        lapsesAt: expect.stringMatching(/Z$/),
      });
      expect(host.mapping()).toMatchObject([
        { id: "exchange-1", key: enrolledKey, days: 30 },
      ]);

      const rotated = await registerRelayKey(
        {
          registrar,
          signingSecret: enrolledSecret,
          registeredSecret: rotatedSecret,
          maxAgeDays: null,
        },
        noRetries,
      );
      expect(rotated, log.stderr).toEqual({
        kind: "registered",
        maxAgeDays: null,
        lapsesAt: null,
      });
      expect(host.mapping()).toMatchObject([
        { id: "exchange-1", key: rotatedKey, days: null },
      ]);
      expect(host.rows()).toEqual(
        [listed(KEY_LISTED), listed(rotatedKey)].sort(),
      );

      const stale = await registerRelayKey(
        {
          registrar,
          signingSecret: enrolledSecret,
          registeredSecret: sharedSecret(),
          maxAgeDays: 30,
        },
        noRetries,
      );
      expect(stale).toEqual({
        kind: "refused",
        status: 409,
        reason:
          "the request's proof does not verify against the key exchange exchange-1 holds on this relay",
      });
      expect(host.mapping()).toMatchObject([
        { id: "exchange-1", key: rotatedKey, days: null },
      ]);
      expect(host.rows()).toEqual(
        [listed(KEY_LISTED), listed(rotatedKey)].sort(),
      );
    });
  },
);

// The CORS invariant: the registrar authenticates on the Authorization header
// alone, and no answer allows credentials, so a browser's ambient cookies or
// client certificate can never authenticate a cross-origin call.
describe("registrar.py CORS invariant", () => {
  it("reads only the Authorization header when authenticating, and no Cookie anywhere", () => {
    const reads = python(
      `import ast, json, sys
tree = ast.parse(open(sys.argv[1]).read())
constants = {
    target.id: node.value.value
    for node in tree.body
    if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant)
    for target in node.targets
    if isinstance(target, ast.Name)
}
def header_name(node):
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name) and node.id in constants:
        return constants[node.id]
    return ast.dump(node)
reads = []
for function in ast.walk(tree):
    if not isinstance(function, ast.FunctionDef):
        continue
    for node in ast.walk(function):
        name = None
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "get":
            target = node.func.value
            if isinstance(target, ast.Attribute) and target.attr == "headers" and node.args:
                name = node.args[0]
        elif isinstance(node, ast.Subscript) and isinstance(node.value, ast.Attribute) and node.value.attr == "headers":
            name = node.slice.value if isinstance(node.slice, ast.Index) else node.slice
        elif isinstance(node, ast.Compare) and any(
            isinstance(c, ast.Attribute) and c.attr == "headers" for c in node.comparators
        ):
            name = node.left
        if name is not None:
            reads.append([function.name, header_name(name)])
print(json.dumps(reads))`,
      [join(relay, "registrar.py")],
    );
    expect(reads.filter(([fn]) => fn === "credential")).toEqual([
      ["credential", "Authorization"],
    ]);
    for (const [, header] of reads) {
      expect(typeof header === "string" && /^[A-Za-z-]+$/.test(header)).toBe(
        true,
      );
      expect(header.toLowerCase()).not.toBe("cookie");
    }
    expect(readFileSync(join(relay, "registrar.py"), "utf8")).not.toMatch(
      /allow-credentials/i,
    );
  });

  it.skipIf(runningAsRoot)(
    "sends Access-Control-Allow-Credentials on no answer",
    async () => {
      const host = fixtureHost();
      host.register("exchange-1", KEY_A);
      const { port } = await startRegistrar(host);
      await call(port, "OPTIONS", "/exchanges/exchange-1");
      await call(port, "PUT", "/exchanges/exchange-2", {
        token: REGISTRAR_TOKEN,
        body: keyBody(KEY_B),
      });
      await call(port, "PUT", "/exchanges/exchange-2", {
        token: REGISTRAR_TOKEN,
        body: "{",
      });
      await call(port, "DELETE", "/exchanges/exchange-9", {
        token: REGISTRAR_TOKEN,
      });
      await call(port, "DELETE", "/exchanges/exchange-1", {
        headers: { Origin: "https://elsewhere.example", Cookie: "a=b" },
      });
      await call(port, "GET", "/exchanges/exchange-1", {
        token: REGISTRAR_TOKEN,
      });
      await call(port, "DELETE", "/other", { token: REGISTRAR_TOKEN });
      await callRaw(port, ["PUT /x HTTP/1.1 junk\r\n\r\n"]);
      expect(seenHeaders.length).toBeGreaterThanOrEqual(8);
      for (const headers of seenHeaders) {
        if (typeof headers === "string") {
          expect(headers).not.toMatch(/access-control-allow-credentials/i);
        } else {
          expect(headers).not.toHaveProperty(
            "access-control-allow-credentials",
          );
        }
      }
    },
  );
});

describe.skipIf(runningAsRoot)(
  "verify.sh registrar probe",
  { timeout: 60000 },
  () => {
    it("says it skipped the registrar on a host with no token", () => {
      const result = fixtureHost().verify();
      expect(result.stdout).toContain(
        "SKIP     the registrar is not configured on this host",
      );
    });

    it("passes against a registrar that refuses without the token and writes with it", async () => {
      const host = fixtureHost();
      const { port } = await startRegistrar(host);
      const result = spawnSync(BASH, [join(relay, "verify.sh")], {
        encoding: "utf8",
        env: {
          ...registrarEnv(host),
          ALCOVE_RELAY_REGISTRAR_PORT: String(port),
          ALCOVE_RELAY_VERIFY_CONNECT: "127.0.0.1",
          ALCOVE_RELAY_VERIFY_WAIT: "0",
          CURL_CA_BUNDLE: join(certDir, "fullchain.pem"),
        },
      });
      const registrarLines = result.stdout.slice(
        result.stdout.lastIndexOf(
          "\n",
          result.stdout.indexOf("a registration with the token"),
        ) + 1,
      );
      const expected = [
        "PASS     a registration with the token was answered 200",
        "PASS     the registration is in the mapping and the secrets table",
        "PASS     a registration with no token was answered 401",
        "PASS     a registration with a wrong token was answered 401",
        "PASS     a revocation with no token was answered 401",
        "PASS     the refused calls left the mapping and the secrets table unchanged",
        "PASS     a revocation with the token was answered 200",
        "PASS     the revocation removed the key from the mapping and the secrets table",
      ];
      expect(
        registrarLines
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("PASS")),
      ).toEqual(expected);
      expect(registrarLines).not.toMatch(/FAIL|UNCLEAR/);
      for (const stream of [result.stdout, result.stderr]) {
        expect(stream).not.toMatch(HEX64);
        expect(stream).not.toContain(REGISTRAR_TOKEN);
      }
      expect(host.mapping()).toEqual([]);
      expect(host.rows()).toEqual([listed(KEY_LISTED)]);
    });

    it("reports a registrar that does not answer as unclear", () => {
      const host = fixtureHost();
      const result = spawnSync(BASH, [join(relay, "verify.sh")], {
        encoding: "utf8",
        env: {
          ...registrarEnv(host),
          ALCOVE_RELAY_REGISTRAR_PORT: "1",
          ALCOVE_RELAY_VERIFY_CONNECT: "127.0.0.1",
          ALCOVE_RELAY_VERIFY_WAIT: "0",
        },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        "UNCLEAR  a registration with the token got no answer",
      );
      expect(result.stdout).not.toContain("SKIP     the registrar");
    });
  },
);

describe.skipIf(runningAsRoot)("verify.sh cleanup", { timeout: 60000 }, () => {
  it("removes every key the run registered from the table", () => {
    const host = fixtureHost();
    const result = host.verify();
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("WARNING");
    expect(host.rows()).toEqual([listed(KEY_LISTED)]);
    expect(host.mapping()).toEqual([]);
  });

  it("replaces a key an earlier run left under its id, then removes it", () => {
    const host = fixtureHost();
    host.register("alcove-verify-a", KEY_A, "none", {
      ALCOVE_RELAY_VERIFY_RUN: "1",
    });
    const result = host.verify();
    expect(result.stderr).not.toContain("WARNING");
    expect(host.rows()).toEqual([listed(KEY_LISTED)]);
    expect(host.mapping()).toEqual([]);
  });

  it("warns naming the exchange id, not the key, when the table cannot be written", () => {
    const host = fixtureHost();
    host.register("alcove-verify-a", KEY_A, "none", {
      ALCOVE_RELAY_VERIFY_RUN: "1",
    });
    host.makeTableReadOnly();
    const result = host.verify();
    expect(result.stdout).toContain(
      "could not register alcove-verify-a for this run",
    );
    expect(result.stderr).toContain(
      "WARNING: could not revoke alcove-verify-a",
    );
    for (const stream of [result.stdout, result.stderr]) {
      expect(stream).not.toMatch(HEX64);
    }
  });
});

describe.skipIf(runningAsRoot)(
  "verify.sh TURNS client runs",
  { timeout: 60000 },
  () => {
    const clientRuns = (host) =>
      host.runtimeRuns().filter((run) => run.includes("turnutils_uclient"));

    it("keep podman's event log off, so no credential reaches the journal", () => {
      const host = fixtureHost();
      host.useRuntime("podman");
      host.verify();
      const runs = clientRuns(host);
      expect(runs.length).toBeGreaterThan(0);
      for (const run of runs) {
        expect(run).toMatch(/^podman --events-backend=none run --rm /);
      }
    });

    it("pass docker no podman-only flag", () => {
      const host = fixtureHost();
      host.verify();
      const runs = clientRuns(host);
      expect(runs.length).toBeGreaterThan(0);
      for (const run of runs) {
        expect(run).toMatch(/^docker run --rm /);
      }
    });
  },
);

describe("render-config.sh and the secrets table", () => {
  it("renders the table and no static secret when the host holds none", () => {
    const host = fixtureHost();
    const result = host.render();
    expect(result.status, result.stderr).toBe(0);
    const settings = host
      .conf()
      .split("\n")
      .filter((line) => !line.startsWith("#"));
    expect(settings).toContain("use-auth-secret");
    expect(settings).toContain("userdb=/var/lib/coturn/turndb");
    expect(settings.some((line) => line.startsWith("static-auth-secret"))).toBe(
      false,
    );
  });

  it("renders the static secret beside the table when the host holds one", () => {
    const host = fixtureHost();
    writeFileSync(host.secretFile, "c".repeat(64));
    const result = host.render();
    expect(result.status, result.stderr).toBe(0);
    expect(host.conf()).toContain(`static-auth-secret=${"c".repeat(64)}\n`);
    expect(host.conf()).toContain("userdb=/var/lib/coturn/turndb\n");
  });
});

// install.sh fills these in when it renders the two units that run as the
// relay image's account; a unit that still names a placeholder, or one of the
// two missing its sandbox, would start as root or unconfined.
describe("the units that run as the relay image's account", () => {
  const unit = (name) => readFileSync(join(relay, name), "utf8");
  const directives = (text) =>
    text
      .split("\n")
      .filter((line) => /^[A-Z][A-Za-z]+=/.test(line))
      .filter(
        (line) =>
          !/^(Description|Documentation|After|Wants|ConditionPathExists|Type|ExecStart|Restart|RestartSec|WantedBy|EnvironmentFile|LoadCredential|StandardInput)=/.test(
            line,
          ),
      );

  it("run as the image's uid and gid, which install.sh renders into both", () => {
    const install = readFileSync(join(relay, "install.sh"), "utf8");
    for (const name of [
      "alcove-relay-registrar.service",
      "alcove-relay-sweep.service",
    ]) {
      expect(unit(name)).toContain("User=__ALCOVE_RELAY_IMAGE_UID__\n");
      expect(unit(name)).toContain("Group=__ALCOVE_RELAY_IMAGE_GID__\n");
      expect(install).toContain(name);
    }
    expect(install).toContain("s/__ALCOVE_RELAY_IMAGE_UID__/$IMAGE_UID/g");
    expect(install).toContain("s/__ALCOVE_RELAY_IMAGE_GID__/$IMAGE_GID/g");
  });

  it("carry the same sandbox, the sweep adding only its lack of a network", () => {
    const registrar = directives(unit("alcove-relay-registrar.service"));
    const sweep = directives(unit("alcove-relay-sweep.service"));
    expect(sweep.filter((line) => !registrar.includes(line))).toEqual([
      "PrivateNetwork=true",
      "RestrictAddressFamilies=AF_UNIX",
    ]);
    expect(registrar.filter((line) => !sweep.includes(line))).toEqual([
      "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX",
    ]);
    for (const line of [
      "NoNewPrivileges=true",
      "ProtectSystem=strict",
      "ReadWritePaths=/var/lib/alcove-relay",
      "ProtectControlGroups=true",
      "CapabilityBoundingSet=",
    ]) {
      expect(registrar).toContain(line);
    }
  });
});
