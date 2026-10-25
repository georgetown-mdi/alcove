import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { get } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// The WebSocket relay's deployment in infra/relay: websocket-pair.py, verify.sh's
// probe, driven against the real relay (packages/websocket-relay), started as
// alcove-relay-websocket.service starts it, with keys written by
// register-exchange.sh, behind a TLS server here standing in for the 443
// front's WebSocket relay server; and the unit and install.sh as text. No
// nginx or systemd runs here; the front and the unit on the host are the host
// run's to measure (infra/relay/README.md, The WebSocket relay).

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const RELAY = join(ROOT, "infra/relay");
const PROBE = join(RELAY, "websocket-pair.py");
const LIMIT_PROBE = join(RELAY, "websocket-address-limit.py");
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";
const NAME = "wsrelay.example";
const REALM = "turn.example";
const EXCHANGE_ID = "probe-exchange";
const KEY = "3".repeat(64);
const OTHER_KEY = "4".repeat(64);
const HEX64 = /[0-9a-f]{64}/;
const TURN_SECRET_SCHEMA =
  "CREATE TABLE turn_secret (realm varchar(127) default '', value varchar(256), primary key (realm,value))";

const read = (name) => readFileSync(join(RELAY, name), "utf8");

let dir;
let relay;
let relayPort;
const servers = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "relay-websocket-"));
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
      `/CN=${NAME}`,
      "-addext",
      `subjectAltName=DNS:${NAME}`,
      "-keyout",
      join(dir, "privkey.pem"),
      "-out",
      join(dir, "fullchain.pem"),
    ],
    { encoding: "utf8" },
  );
  expect(made.status, made.stderr).toBe(0);

  const turndb = join(dir, "turndb");
  const created = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      `import sqlite3, sys\nconn = sqlite3.connect(sys.argv[1])\nconn.execute(${JSON.stringify(TURN_SECRET_SCHEMA)})\nconn.commit()`,
      turndb,
    ],
    { encoding: "utf8" },
  );
  expect(created.status, created.stderr).toBe(0);
  const envFile = join(dir, "relay.env");
  writeFileSync(envFile, `ALCOVE_RELAY_REALM=${REALM}\n`);
  const registered = spawnSync(
    BASH,
    [join(RELAY, "register-exchange.sh"), EXCHANGE_ID, "none"],
    {
      encoding: "utf8",
      input: `${KEY}\n`,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        ALCOVE_RELAY_ENV_FILE: envFile,
        ALCOVE_RELAY_TURNDB: turndb,
      },
    },
  );
  expect(registered.status, registered.stderr).toBe(0);

  relay = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "packages/websocket-relay/src/standalone.ts",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--key-table",
      turndb,
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  relayPort = await new Promise((done, fail) => {
    let stdout = "";
    let stderr = "";
    const deadline = setTimeout(
      () => fail(new Error(`the relay did not listen within 30 s: ${stderr}`)),
      30000,
    );
    relay.stderr.on("data", (chunk) => (stderr += chunk));
    relay.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = /^alcove-websocket-relay (\d+)$/m.exec(stdout);
      if (match) {
        clearTimeout(deadline);
        done(Number(match[1]));
      }
    });
    relay.on("exit", (code) =>
      fail(new Error(`the relay exited ${code}: ${stderr}`)),
    );
  });
}, 60000);

afterAll(async () => {
  if (relay && relay.exitCode === null) {
    const exited = new Promise((done) => relay.on("exit", done));
    relay.kill("SIGTERM");
    await exited;
  }
  rmSync(dir, { recursive: true, force: true });
});

afterEach(async () => {
  while (servers.length > 0) {
    await new Promise((done) => servers.pop().close(done));
  }
});

/**
 * A TLS server on loopback under the test certificate. By default it passes
 * each connection's bytes to the relay, as the front's WebSocket relay server
 * does; `onSecure` replaces that.
 */
const startTlsServer = async (onSecure) => {
  const server = tls.createServer(
    {
      key: readFileSync(join(dir, "privkey.pem")),
      cert: readFileSync(join(dir, "fullchain.pem")),
    },
    onSecure ??
      ((socket) => {
        const upstream = net.connect(relayPort, "127.0.0.1");
        socket.on("error", () => upstream.destroy());
        upstream.on("error", () => socket.destroy());
        socket.pipe(upstream).pipe(socket);
      }),
  );
  server.on("tlsClientError", () => {});
  servers.push(server);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return server.address().port;
};

/**
 * A TLS server on every loopback address standing in for the front's
 * WebSocket relay server and its bound for each client address: a connection
 * past `limit` under the key `keyOf` gives its address is closed before its
 * TLS handshake, and every other is passed to the relay.
 */
const startBoundedServer = async (keyOf, limit) => {
  const held = new Map();
  const server = tls.createServer(
    {
      key: readFileSync(join(dir, "privkey.pem")),
      cert: readFileSync(join(dir, "fullchain.pem")),
    },
    (socket) => {
      const upstream = net.connect(relayPort, "127.0.0.1");
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      socket.pipe(upstream).pipe(socket);
    },
  );
  server.on("connection", (socket) => {
    const key = keyOf(socket.remoteAddress);
    const count = held.get(key) ?? 0;
    if (count >= limit) {
      socket.destroy();
      return;
    }
    held.set(key, count + 1);
    socket.on("close", () => held.set(key, held.get(key) - 1));
  });
  server.on("tlsClientError", () => {});
  servers.push(server);
  await new Promise((done) => server.listen(0, "::", done));
  return server.address().port;
};

/** Runs websocket-address-limit.py from `host` and `otherHost`. */
const limitProbe = (port, host, otherHost) =>
  new Promise((done) => {
    const child = spawn(
      "python3",
      [
        "-B",
        LIMIT_PROBE,
        host,
        String(port),
        NAME,
        otherHost,
        "--cafile",
        join(dir, "fullchain.pem"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });

/** Runs the probe without blocking the servers' event loop. */
const probe = (port, { id = EXCHANGE_ID, key = KEY, name = NAME } = {}) =>
  new Promise((done) => {
    const child = spawn(
      "python3",
      [
        "-B",
        PROBE,
        "127.0.0.1",
        String(port),
        name,
        id,
        "--cafile",
        join(dir, "fullchain.pem"),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("close", (status) => {
      for (const stream of [stdout, stderr]) expect(stream).not.toMatch(HEX64);
      done({ status, stdout, stderr });
    });
    child.stdin.end(`${key}\n`);
  });

describe("websocket-pair.py against the relay", { timeout: 60000 }, () => {
  it("pairs two sockets under a key register-exchange.sh wrote and forwards one message and the close", async () => {
    const port = await startTlsServer();
    const result = await probe(port);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      `paired at wss://${NAME}/relay; a 32-byte message crossed from the inviter to the acceptor, and the close followed it\n`,
    );
  });

  it.each([
    ["an exchange id with no key", { id: "never-registered" }, "4003"],
    ["a proof under another key", { key: OTHER_KEY }, "4004"],
  ])(
    "exits 6 naming the relay's close code for %s",
    async (_, options, code) => {
      const port = await startTlsServer();
      const result = await probe(port, options);
      expect(result.status).toBe(6);
      expect(result.stderr).toContain(
        `the relay closed the inviter's socket with ${code}`,
      );
    },
  );

  it("exits 5 when the certificate does not verify for the server name", async () => {
    const port = await startTlsServer();
    const result = await probe(port, { name: "other.example" });
    expect(result.status).toBe(5);
    expect(result.stderr).toContain("does not verify for other.example");
  });

  it("exits 4 when the upgrade is not answered 101", async () => {
    const port = await startTlsServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", () =>
        socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"),
      );
    });
    const result = await probe(port);
    expect(result.status).toBe(4);
    expect(result.stderr).toContain(
      "upgrade was answered 'HTTP/1.1 404 Not Found'",
    );
  });

  it("exits 2 when nothing listens", async () => {
    const port = await startTlsServer();
    await new Promise((done) => servers.pop().close(done));
    const result = await probe(port);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("could not connect to 127.0.0.1");
  });

  it("refuses to run without a key on standard input", async () => {
    const result = await probe(1, { key: "" });
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("standard input has no relay key");
  });

  // install.sh waits for this answer before it says the relay started.
  it("finds the relay answering a plain request on its path 404, as install.sh waits for", async () => {
    const status = await new Promise((done, fail) =>
      get(`http://127.0.0.1:${relayPort}/relay`, (response) => {
        response.resume();
        done(response.statusCode);
      }).on("error", fail),
    );
    expect(status).toBe(404);
    expect(read("install.sh")).toContain(
      `"http://127.0.0.1:$WEBSOCKET_PORT/relay"`,
    );
    expect(read("install.sh")).toContain(
      '[ "$(websocket_answer)" = 404 ] && { websocket_answered=1; break; }',
    );
  });

  it("bounds install.sh's wait for that answer inside the host pull's cutoff for an install script", () => {
    const install = read("install.sh");
    const wait = Number(
      /^ {2}websocket_deadline=\$\(\(SECONDS \+ (\d+)\)\)$/m.exec(install)[1],
    );
    const probe = Number(
      /^ {2}websocket_answer\(\) \{ curl [^\n]*--max-time (\d+) /m.exec(
        install,
      )[1],
    );
    expect(install).toContain(
      'while [ "$SECONDS" -lt "$websocket_deadline" ]; do',
    );
    expect(install).toContain(
      `did not answer on 127.0.0.1 port $WEBSOCKET_PORT within ${wait} s;`,
    );
    const pull = readFileSync(join(ROOT, "infra/host-pull/pull.sh"), "utf8");
    const share = Number(/^INSTALL_SHARE=(\d+)$/m.exec(pull)[1]);
    const killAfter = Number(
      /^INSTALL_KILL_AFTER_DEFAULT=(\d+)$/m.exec(pull)[1],
    );
    // The last probe can start just before the deadline, then the sleep; the
    // wait leaves the rest of install.sh at least half the cutoff.
    expect(wait + probe + 1).toBeLessThan((share - killAfter) / 2);
  });
});

// The probe's two addresses here are 127.0.0.1 and ::1; on the host,
// verify.sh's are the host's own address and 127.0.0.1.
describe(
  "websocket-address-limit.py against the relay",
  { timeout: 60000 },
  () => {
    it("passes when 8 sockets from one address and one from another are upgraded and a ninth from the first is closed", async () => {
      const port = await startBoundedServer((address) => address, 8);
      const result = await limitProbe(port, "127.0.0.1", "::1");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(
        `the front upgraded 8 sockets from 127.0.0.1 and one from ::1 at wss://${NAME}/relay, and closed a ninth from 127.0.0.1 unanswered\n`,
      );
    });

    it("exits 6 when a front counting every client as one address closes the socket from the other", async () => {
      const port = await startBoundedServer(() => "one address", 8);
      const result = await limitProbe(port, "127.0.0.1", "::1");
      expect(result.status).toBe(6);
      expect(result.stderr).toBe(
        "the front closed the socket from ::1 while 127.0.0.1 held 8 unanswered\n",
      );
    });

    it("exits 7 when the ninth socket from one address is upgraded", async () => {
      const port = await startBoundedServer((address) => address, 9);
      const result = await limitProbe(port, "127.0.0.1", "::1");
      expect(result.status).toBe(7);
      expect(result.stderr).toBe(
        "the ninth socket from 127.0.0.1 was answered 'HTTP/1.1 101 Switching Protocols' rather than closed\n",
      );
    });

    it("exits 6 when the front closes a socket below the bound", async () => {
      const port = await startBoundedServer((address) => address, 3);
      const result = await limitProbe(port, "127.0.0.1", "::1");
      expect(result.status).toBe(6);
      expect(result.stderr).toBe(
        "the front closed socket 4 of 8 from 127.0.0.1 unanswered\n",
      );
    });

    it("exits 8 when both hosts are reached from the same local address", async () => {
      const port = await startBoundedServer((address) => address, 8);
      const result = await limitProbe(port, "127.0.0.1", "127.0.0.1");
      expect(result.status).toBe(8);
      expect(result.stderr).toBe(
        "127.0.0.1 and 127.0.0.1 were both reached from 127.0.0.1, so the probe cannot tell two client addresses apart\n",
      );
    });

    it("exits 2 when nothing listens, and 64 on a usage error", async () => {
      const port = await startBoundedServer((address) => address, 8);
      await new Promise((done) => servers.pop().close(done));
      const result = await limitProbe(port, "127.0.0.1", "::1");
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("could not connect to 127.0.0.1");
      const usage = await limitProbe("x", "127.0.0.1", "::1");
      expect(usage.status).toBe(64);
    });
  },
);

describe("alcove-relay-websocket.service", () => {
  const unit = read("alcove-relay-websocket.service");
  const install = read("install.sh");
  const directive = (name) =>
    [...unit.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))].map((m) => m[1]);

  it("runs the relay from the tree install.sh checks, as this test starts it, on loopback at the rendered port", () => {
    const tree = /^NODE_TREE=(\S+)$/m.exec(install)[1];
    expect(directive("WorkingDirectory")).toEqual([tree]);
    expect(directive("ExecStart")).toEqual([
      "/usr/local/bin/node --import tsx packages/websocket-relay/src/standalone.ts --host 127.0.0.1 --port __ALCOVE_RELAY_WEBSOCKET_PORT__ --key-table /var/lib/alcove-relay/turndb",
    ]);
    for (const needed of [
      "node_modules/tsx/package.json",
      "packages/websocket-relay/src/standalone.ts",
      "packages/core/dist/websocket-relay.esm.js",
    ]) {
      expect(install).toContain(needed);
    }
  });

  it("runs as the relay image's account, which install.sh fills in with the port", () => {
    expect(directive("User")).toEqual(["__ALCOVE_RELAY_IMAGE_UID__"]);
    expect(directive("Group")).toEqual(["__ALCOVE_RELAY_IMAGE_GID__"]);
    expect(install).toMatch(
      /for unit in [^\n]*alcove-relay-websocket\.service; do/,
    );
    expect(install).toContain(
      '-e "s/__ALCOVE_RELAY_WEBSOCKET_PORT__/$WEBSOCKET_PORT/g"',
    );
  });

  it("defaults the port to the same value in install.sh and render-front.sh", () => {
    const fallback =
      /^WEBSOCKET_PORT="\$\{ALCOVE_RELAY_WEBSOCKET_PORT:-(\d+)\}"$/m;
    const port = fallback.exec(install)[1];
    expect(fallback.exec(read("render-front.sh"))[1]).toBe(port);
    expect(read("relay.env.example")).toContain(
      `Defaults to ${port} where unset.\nALCOVE_RELAY_WEBSOCKET_PORT=\n`,
    );
  });

  // The relay writes nothing and opens no connection of its own: the sandbox
  // leaves it no writable path but its private /tmp, and loopback alone.
  it("reads the whole file system only and reaches loopback only", () => {
    expect(directive("ProtectSystem")).toEqual(["strict"]);
    expect(directive("ReadWritePaths")).toEqual([]);
    expect(directive("IPAddressDeny")).toEqual(["any"]);
    expect(directive("IPAddressAllow")).toEqual(["localhost"]);
    expect(directive("CapabilityBoundingSet")).toEqual([""]);
    expect(directive("NoNewPrivileges")).toEqual(["true"]);
  });

  // render-config.sh writes coturn's configuration, static-auth-secret
  // included, under this directory, owned by the account the relay runs as.
  it("cannot read the directory coturn's rendered configuration is in", () => {
    const etc = /^ETC=(\S+)$/m.exec(read("render-config.sh"))[1];
    expect(read("render-config.sh")).toContain(
      'OUT="${ALCOVE_RELAY_CONF:-$ETC/turnserver.conf}"',
    );
    expect(directive("InaccessiblePaths")).toEqual([etc]);
  });

  describe("the image uid install.sh fills in", () => {
    const STEP_START = "# The account the image runs as";
    const STEP_END = "# --- the secrets table ---";

    const probe = (uid) => {
      const start = install.indexOf(STEP_START);
      const end = install.indexOf(STEP_END);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const script = [
        "set -euo pipefail",
        `die() { printf 'ABORTING: %s\\n' "$*" >&2; exit 1; }`,
        `log() { printf '%s\\n' "$*" >&2; }`,
        `record_env_value() { printf 'recorded %s=%s\\n' "$1" "$2"; }`,
        `podman() { case "$*" in *' -u') echo '${uid}' ;; *' -g') echo 1000 ;; esac; }`,
        "RUNTIME=podman",
        "IMAGE=alcove-relay",
        install.slice(start, end),
      ].join("\n");
      return spawnSync(BASH, ["-c", script], { encoding: "utf8" });
    };

    it("is refused when the image reports root", () => {
      for (const uid of ["0", "00"]) {
        const r = probe(uid);
        expect(r.status, uid).toBe(1);
        expect(r.stderr).toContain(
          "the image alcove-relay reports uid 0 (root), and the relay will not run as root.",
        );
        expect(r.stdout).toBe("");
      }
    });

    it("is recorded when the image reports another account", () => {
      const r = probe("65534");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("recorded ALCOVE_RELAY_IMAGE_UID=65534\n");
    });
  });

  it("is started only where relay.env names the relay, and stopped otherwise", () => {
    const named = install.indexOf(
      'if [ -n "$WEBSOCKET_NAME" ]; then\n  systemctl enable alcove-relay-websocket.service',
    );
    expect(named).toBeGreaterThan(0);
    expect(
      install.indexOf("systemctl restart alcove-relay-websocket.service"),
    ).toBeGreaterThan(named);
    expect(install).toContain(
      "systemctl disable --now alcove-relay-websocket.service 2>/dev/null || true",
    );
  });

  it("is checked for before anything is installed or restarted", () => {
    const checks = [
      install.indexOf('[ -e "$NODE_TREE/$needed" ]'),
      install.indexOf(
        '[ -e "$NODE_TREE/packages/core/dist/websocket-relay.esm.js" ]',
      ),
    ];
    for (const check of checks) {
      expect(check).toBeGreaterThan(
        install.indexOf('"$HERE/render-front.sh" > /dev/null'),
      );
      for (const change of [
        "dnf -y install",
        "systemctl ",
        " build ",
        "install -d ",
      ]) {
        expect(install.indexOf(change), change).toBeGreaterThan(check);
      }
    }
  });

  // The host pull unpacks only the signed broker core build into a tree, so a
  // build packed before it included the relay's entry is the likely cause.
  it("names a broker core build without the relay's entry as the cause when it is missing", () => {
    expect(install).toContain(
      "has no websocket-relay.esm.js: the broker core build unpacked there predates the WebSocket relay's entry.",
    );
  });

  it("installs the probes verify.sh runs", () => {
    for (const probe of ["websocket-pair.py", "websocket-address-limit.py"]) {
      expect(install).toContain(`"$HERE/${probe}"`);
      expect(read("verify.sh")).toContain(`"$HERE/${probe}"`);
    }
  });
});
