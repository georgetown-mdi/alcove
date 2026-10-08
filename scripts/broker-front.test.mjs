import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The broker's TLS front (infra/broker): the template's logging, the renderer,
// and renew.sh and install.sh against a fixture host with `lego`, `systemctl`
// and `docker` stubs on PATH.

const here = dirname(fileURLToPath(import.meta.url));
const BROKER = resolve(here, "..", "infra/broker");
const TEMPLATE = join(BROKER, "nginx.conf.tmpl");
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";

// The fields PRIVACY.md lists for the front's access log. A signaling URL's
// query string contains the rendezvous identifier and the client token, so no
// variable that includes it ($request, $request_uri, $args, $query_string,
// $is_args, $arg_*) may join this list.
const ALLOWED_LOG_VARIABLES = [
  "time_iso8601",
  "remote_addr",
  "request_method",
  "uri",
  "server_protocol",
  "status",
  "http_upgrade",
  "bytes_sent",
  "request_time",
];

/** Directives of an nginx configuration, each with the blocks enclosing it. */
const directives = (text) => {
  const tokens = [];
  const pattern = /#[^\n]*|'([^']*)'|"([^"]*)"|([{};])|([^\s{};'"#]+)/g;
  for (const match of text.matchAll(pattern)) {
    if (match[0].startsWith("#")) continue;
    if (match[3] !== undefined) tokens.push({ punct: match[3] });
    else tokens.push({ word: match[1] ?? match[2] ?? match[4] });
  }
  const found = [];
  const stack = [];
  let words = [];
  for (const token of tokens) {
    if (token.word !== undefined) {
      words.push(token.word);
    } else if (token.punct === "{") {
      stack.push(words[0]);
      words = [];
    } else if (token.punct === "}") {
      stack.pop();
      words = [];
    } else {
      found.push({ name: words[0], args: words.slice(1), context: [...stack] });
      words = [];
    }
  }
  return found;
};

const template = () => directives(readFileSync(TEMPLATE, "utf8"));

/** Variables each log_format writes, in both the `$name` and `${name}` forms. */
const logFormatVariables = (parsed) =>
  parsed
    .filter(({ name }) => name === "log_format")
    .map(({ args }) =>
      [
        ...args
          .slice(1)
          .join("")
          .matchAll(/\$(?:\{(\w+)\}|(\w+))/g),
      ].map((match) => match[1] ?? match[2]),
    );

describe("nginx.conf.tmpl logging", () => {
  it("logs only the documented fields, so no line contains the query string", () => {
    const formats = logFormatVariables(template());
    expect(formats.length).toBeGreaterThan(0);
    for (const variables of formats) {
      expect(variables.length).toBeGreaterThan(0);
      for (const variable of variables) {
        expect(ALLOWED_LOG_VARIABLES, `$${variable}`).toContain(variable);
      }
    }
  });

  it.each([
    ["log_format f '$request';", "request"],
    ["log_format f '${request}';", "request"],
    ["log_format f '$uri?${args}';", "args"],
  ])("finds the undocumented variable in %s", (text, variable) => {
    const found = logFormatVariables(directives(`http { ${text} }`)).flat();
    expect(found).toContain(variable);
    expect(ALLOWED_LOG_VARIABLES).not.toContain(variable);
  });

  it("names one of its own formats on every access log, at the http level too", () => {
    // Without an access_log in http, nginx falls back to its built-in
    // `combined` format, which writes $request and so the query string.
    const formats = template()
      .filter(({ name }) => name === "log_format")
      .map(({ args }) => args[0]);
    const accessLogs = template().filter(({ name }) => name === "access_log");
    expect(accessLogs.some(({ context }) => context.join(" ") === "http")).toBe(
      true,
    );
    for (const { args } of accessLogs) {
      if (args[0] === "off") continue;
      expect(formats).toContain(args[1]);
    }
  });

  it("keeps the error log at warnings and above", () => {
    const errorLogs = template().filter(({ name }) => name === "error_log");
    expect(errorLogs.length).toBeGreaterThan(0);
    for (const { args } of errorLogs) {
      expect(["warn", "error", "crit", "alert", "emerg"]).toContain(args[1]);
    }
  });
});

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

const fixtureDir = (prefix) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(root);
  return root;
};

const writeStub = (path, body) => {
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
};

describe("render-config.sh", () => {
  const render = (name) => {
    const root = fixtureDir("broker-render-");
    const envFile = join(root, "broker.env");
    writeFileSync(envFile, `ALCOVE_BROKER_NAME='${name}'\n`);
    return spawnSync(BASH, [join(BROKER, "render-config.sh")], {
      encoding: "utf8",
      env: { ...process.env, ALCOVE_BROKER_ENV_FILE: envFile },
    });
  };

  it("substitutes the name and leaves no placeholder", () => {
    const result = render("broker.example.org");
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("__ALCOVE_BROKER_NAME__");
    const serverNames = directives(result.stdout).filter(
      ({ name }) => name === "server_name",
    );
    expect(serverNames.map(({ args }) => args)).toEqual([
      ["broker.example.org"],
    ]);
  });

  it.each([[""], ["broker.example.org; access_log /x combined"], ["a b"]])(
    "refuses the name %j",
    (name) => {
      const result = render(name);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("ABORTING");
    },
  );
});

/** The FROM reference of a Dockerfile: the front image's one home. */
const fromReference = (dockerfile) =>
  [...readFileSync(dockerfile, "utf8").matchAll(/^FROM (.*)$/gm)].map(
    (match) => match[1],
  );

const PINNED_NGINX = /^docker\.io\/library\/nginx:[^@\s]+@sha256:[0-9a-f]{64}$/;

const NAME = "broker.example.org";
const FRONT_UNIT = "alcove-broker-tls.service";
const BROKER_UNIT = "alcove-broker.service";
const TIMER_UNIT = "alcove-broker-cert.timer";
const UNITS = [
  BROKER_UNIT,
  FRONT_UNIT,
  "alcove-broker-cert.service",
  TIMER_UNIT,
];

// The tracked tag pinned to a fixture digest, so these runs do not depend on
// the tracked pin.
const pinnedImage = (digestByte = "a") =>
  `${fromReference(join(BROKER, "Dockerfile"))[0].replace(/@.*$/, "")}@sha256:${digestByte.repeat(64)}`;

// Longer than a kernel tick, so a file written after a unit starts has a later
// mtime than the start, as on a host where runs are minutes apart.
const pause = () =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);

// systemd as the scripts see it: the copy of each unit file it loaded at the
// last daemon-reload (NeedDaemonReload when the file differs), each unit's
// start time, and a line in STARTS for every broker or front start naming
// whether it ran the unit file on disk and the image and certificate it read.
const SYSTEMCTL_STUB = String.raw`
printf 'systemctl token=%s\n' "$(printenv CLOUDFLARE_DNS_API_TOKEN || echo unset)" >> "$ENVLOG"
for unit; do :; done
load() { [ -f "$S/loaded/$1" ] || [ ! -f "$U/$1" ] || cp "$U/$1" "$S/loaded/$1"; }
start() {
  load "$1"
  date +%s%6N > "$S/started/$1"
  : > "$S/active/$1"
  case "$1" in alcove-broker.service | alcove-broker-tls.service) ;; *) return 0 ;; esac
  def=current
  if [ ! -f "$U/$1" ]; then def=none; elif ! cmp -s "$U/$1" "$S/loaded/$1"; then def=stale; fi
  printf '%s def=%s image=%s cert=%s\n' "$1" "$def" \
    "$(sed -n 's/^ALCOVE_BROKER_FRONT_IMAGE=//p' "$E/front-image.env" 2>/dev/null)" \
    "$(cat "$E/tls/fullchain.pem" 2>/dev/null)" >> "$STARTS"
}
case "$1" in
  show)
    case "$3" in
      ActiveEnterTimestamp)
        [ -f "$S/started/$unit" ] || { echo; exit 0; }
        at="$(sed 's/\(......\)$/.\1/' "$S/started/$unit")"
        format='+%a %Y-%m-%d %H:%M:%S UTC'
        case " $* " in *" --timestamp=us+utc "*) format='+%a %Y-%m-%d %H:%M:%S.%6N UTC' ;; esac
        date -u -d "@$at" "$format" ;;
      NeedDaemonReload)
        if [ -f "$S/loaded/$unit" ] && ! cmp -s "$U/$unit" "$S/loaded/$unit"; then echo yes; else echo no; fi ;;
      *) exit 1 ;;
    esac
    exit 0 ;;
  is-active) [ -f "$S/active/$unit" ]; exit ;;
esac
printf 'systemctl %s\n' "$*" >> "$CALLS"
case "$1" in
  daemon-reload)
    [ ! -f "$FAIL_RELOAD" ] || exit 1
    for file in "$U"/*; do
      [ ! -f "$file" ] || cp "$file" "$S/loaded/"
    done
    [ ! -f "$STOP_FRONT_ON_RELOAD" ] || rm -f "$S/active/alcove-broker-tls.service" ;;
  restart|try-restart)
    [ ! -f "$FAIL_RESTART" ] || exit 1
    [ "$1" = restart ] || [ -f "$S/active/$unit" ] || exit 0
    start "$unit"
    # The front Requires= the broker.
    if [ "$unit" = alcove-broker.service ] && [ -f "$S/active/alcove-broker-tls.service" ]; then
      start alcove-broker-tls.service
    fi ;;
  start) [ -f "$S/active/$unit" ] || start "$unit" ;;
  enable) if [ "$2" = --now ] && [ ! -f "$S/active/$unit" ]; then start "$unit"; fi ;;
  stop) rm -f "$S/active/$unit" ;;
esac
exit 0
`;

// lego: fails while FAIL_LEGO exists, and waits up to 10 s while HOLD_LEGO
// exists.
const LEGO_STUB = String.raw`
printf 'lego token=%s\n' "$(printenv CLOUDFLARE_DNS_API_TOKEN || echo unset)" >> "$ENVLOG"
printf 'lego\n' >> "$CALLS"
n=0
while [ -f "$HOLD_LEGO" ] && [ "$n" -lt 500 ]; do n=$((n + 1)); sleep 0.02; done
[ ! -f "$FAIL_LEGO" ] || exit 1
mkdir -p "$E/acme/certificates"
printf 'certificate %s\n' "$(cat "$SERIAL")" > "$E/acme/certificates/$NAME.crt"
printf 'key %s\n' "$(cat "$SERIAL")" > "$E/acme/certificates/$NAME.key"
`;

// nginx -t in a throwaway container: records the candidate's mode and whether
// a certificate was mounted, and fails on broken_directive. A pull waits up to
// 10 s while HOLD_DOCKER exists.
const DOCKER_STUB = String.raw`
printf 'docker %s\n' "$*" >> "$CALLS"
n=0
while [ "$1" = pull ] && [ -f "$HOLD_DOCKER" ] && [ "$n" -lt 500 ]; do n=$((n + 1)); sleep 0.02; done
[ "$1" = run ] || exit 0
conf=; tls=
for arg in "$@"; do
  case "$arg" in
    *:/etc/nginx/nginx.conf:ro) conf="$(printf '%s' "$arg" | sed 's/:.*//')" ;;
    *:/etc/nginx/tls:ro) tls="$(printf '%s' "$arg" | sed 's/:.*//')" ;;
  esac
done
cert=no; [ -s "$tls/fullchain.pem" ] && cert=yes
printf 'nginx -t mode=%s cert=%s\n' "$(stat -c %a "$conf")" "$cert" >> "$CALLS"
! grep -q broken_directive "$conf"
`;

// mv, recording each target with the time the rename had completed; it fails
// after renaming the live configuration while STOP_AFTER_CONF exists.
const MV_STUB = String.raw`
for real in /usr/bin/mv /bin/mv; do [ -x "$real" ] && break; done
"$real" "$@" || exit
for target; do :; done
printf '%s %s\n' "$target" "$(date +%s%6N)" >> "$RENAMES"
case "$target" in */nginx.conf) [ ! -f "$STOP_AFTER_CONF" ] || exit 1 ;; esac
`;

/**
 * A host under a fixture root: infra/broker copied with a fixture pin, stubs
 * for systemctl, lego, docker, curl and id on PATH, and the broker workspace
 * install.sh checks for.
 */
const brokerHost = ({ client = "lego" } = {}) => {
  const root = fixtureDir("broker-host-");
  const source = join(root, "broker");
  cpSync(BROKER, source, { recursive: true });
  const pinFront = (image) =>
    writeFileSync(join(source, "Dockerfile"), `FROM ${image}\n`);
  pinFront(pinnedImage());
  const bin = join(root, "bin");
  const usrBin = join(root, "usr/bin");
  const etc = join(root, "etc/alcove-broker");
  const unitDir = join(root, "etc/systemd/system");
  const src = join(root, "opt/alcove-broker/src");
  const state = join(root, "systemd");
  for (const dir of [
    bin,
    usrBin,
    unitDir,
    join(root, "usr/local/bin"),
    join(src, "node_modules/.bin"),
    join(src, "packages/core/dist"),
    join(state, "loaded"),
    join(state, "started"),
    join(state, "active"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  mkdirSync(etc, { recursive: true, mode: 0o700 });
  writeStub(join(root, "usr/local/bin/npm"), "exit 0");
  writeStub(join(src, "node_modules/.bin/tsx"), "exit 0");
  writeFileSync(join(src, "packages/core/dist/untrusted-text.esm.js"), "//\n");

  const calls = join(root, "calls.log");
  const starts = join(root, "starts.log");
  const envLog = join(root, "env.log");
  const renames = join(root, "renames.log");
  const failRestart = join(root, "fail-restart");
  const holdDocker = join(root, "hold-docker");
  const failReload = join(root, "fail-daemon-reload");
  const failLego = join(root, "fail-lego");
  const holdLego = join(root, "hold-lego");
  const stopFrontOnReload = join(root, "stop-front-on-reload");
  const stopAfterConf = join(root, "stop-after-conf");
  const serial = join(root, "serial");
  const clearLogs = () => {
    for (const log of [calls, starts, envLog, renames]) writeFileSync(log, "");
  };
  clearLogs();
  writeFileSync(serial, "1");
  const paths = [
    ["S", state],
    ["U", unitDir],
    ["E", etc],
    ["CALLS", calls],
    ["STARTS", starts],
    ["ENVLOG", envLog],
    ["RENAMES", renames],
    ["FAIL_RESTART", failRestart],
    ["HOLD_DOCKER", holdDocker],
    ["FAIL_RELOAD", failReload],
    ["FAIL_LEGO", failLego],
    ["HOLD_LEGO", holdLego],
    ["STOP_FRONT_ON_RELOAD", stopFrontOnReload],
    ["STOP_AFTER_CONF", stopAfterConf],
    ["SERIAL", serial],
    ["NAME", NAME],
  ]
    .map(([name, value]) => `${name}='${value}'`)
    .join("\n");
  writeStub(join(bin, "systemctl"), `${paths}\n${SYSTEMCTL_STUB}`);
  writeStub(join(bin, "lego"), `${paths}\n${LEGO_STUB}`);
  writeStub(join(usrBin, "docker"), `${paths}\n${DOCKER_STUB}`);
  writeStub(join(bin, "mv"), `${paths}\n${MV_STUB}`);
  writeStub(join(bin, "curl"), "exit 0");
  writeStub(
    join(bin, "id"),
    `if [ "$1" = -u ]; then echo 0; else exec /usr/bin/id "$@"; fi`,
  );

  const acmeEnv = join(root, "acme.env");
  writeFileSync(
    join(etc, "broker.env"),
    `ALCOVE_BROKER_NAME=${NAME}\nALCOVE_BROKER_ACME_ENV=${acmeEnv}\n`,
  );
  writeFileSync(
    acmeEnv,
    [
      "ALCOVE_RELAY_ACME_EMAIL=ops@example.org",
      `ALCOVE_RELAY_ACME_CLIENT=${client}`,
      "ALCOVE_RELAY_DNS_PROVIDER=cloudflare",
      "CLOUDFLARE_DNS_API_TOKEN=fixture-token",
      "",
    ].join("\n"),
  );
  const brokenTemplate = join(root, "broken.tmpl");
  writeFileSync(
    brokenTemplate,
    readFileSync(TEMPLATE, "utf8").replace(
      "worker_processes 1;",
      "worker_processes 1;\nbroken_directive on;",
    ),
  );

  const lines = (path) => readFileSync(path, "utf8").split("\n").slice(0, -1);
  const scriptEnv = (extra = {}) => ({
    ...process.env,
    PATH: `${usrBin}:${bin}:${process.env.PATH}`,
    ALCOVE_BROKER_INSTALL_ROOT: root,
    ...extra,
  });
  const runScript = (args, extra) => {
    clearLogs();
    pause();
    const result = spawnSync(BASH, args, {
      encoding: "utf8",
      env: scriptEnv(extra),
    });
    pause();
    return {
      ...result,
      calls: lines(calls),
      starts: lines(starts),
      env: lines(envLog),
    };
  };
  const spawnScript = (args) => {
    const child = spawn(BASH, args, {
      env: scriptEnv(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exit = new Promise((done) => {
      child.on("close", (status) => done({ status, stderr }));
    });
    return { child, exit, stderr: () => stderr };
  };
  const setFront = (active) => {
    if (active) {
      writeFileSync(join(state, "active", FRONT_UNIT), "");
      writeFileSync(join(state, "started", FRONT_UNIT), `${Date.now()}000\n`);
      pause();
    } else {
      rmSync(join(state, "active", FRONT_UNIT), { force: true });
    }
  };
  const flag = (path) => (on) =>
    on ? writeFileSync(path, "") : rmSync(path, { force: true });

  return {
    conf: join(etc, "nginx.conf"),
    etc,
    source,
    tls: join(etc, "tls"),
    unitDir,
    pinFront,
    startFront: () => setFront(true),
    stopFront: () => setFront(false),
    renewTo: (next) => writeFileSync(serial, next),
    failDaemonReload: flag(failReload),
    failLego: flag(failLego),
    holdLego: flag(holdLego),
    stopFrontOnReload: flag(stopFrontOnReload),
    failRestart: flag(failRestart),
    holdDocker: flag(holdDocker),
    stopAfterConf: flag(stopAfterConf),
    calls: () => lines(calls),
    // The time, in microseconds, at which each target's last rename completed.
    renames: () =>
      new Map(
        lines(renames).map((line) => {
          const at = line.lastIndexOf(" ");
          return [line.slice(0, at), BigInt(line.slice(at + 1))];
        }),
      ),
    clearLogs,
    run: ({ broken = false } = {}) =>
      runScript(
        [join(source, "install.sh")],
        broken ? { ALCOVE_BROKER_TEMPLATE: brokenTemplate } : {},
      ),
    // renew.sh from the tracked tree, before any install.
    runRenew: (args = []) => runScript([join(BROKER, "renew.sh"), ...args]),
    // The renewal timer: the installed renew.sh with no argument.
    runTimer: () => runScript([join(etc, "renew.sh")]),
    spawnInstall: () => spawnScript([join(source, "install.sh")]),
    spawnTimer: () => spawnScript([join(etc, "renew.sh")]),
  };
};

const waitFor = async (condition) => {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((done) => setTimeout(done, 20));
  }
};

const frontStart = (image, cert) =>
  `${FRONT_UNIT} def=current image=${image} cert=certificate ${cert}`;
const brokerStart = (image, cert) =>
  `${BROKER_UNIT} def=current image=${image} cert=certificate ${cert}`;

// A start, stop, restart or reload of the front; enabling it is none of these.
const frontActions = (calls) =>
  calls.filter(
    (call) =>
      /^systemctl (try-restart|reload|start|stop|enable --now)\b.*alcove-broker-tls/.test(
        call,
      ) || /^docker exec alcove-broker-tls nginx /.test(call),
  );

const touchesFront = (call) =>
  /^systemctl (try-restart|reload|start|enable|stop)\b.*alcove-broker-tls/.test(
    call,
  ) || /^docker exec /.test(call);

const candidatesLeft = (etc) =>
  readdirSync(etc).filter((entry) => entry.startsWith("nginx.conf."));

const stagedLeft = (dir) =>
  readdirSync(dir).filter((entry) => entry.startsWith("."));

const mtimeUs = (path) => statSync(path, { bigint: true }).mtimeNs / 1000n;

/** Each target went live by a rename and was stamped no earlier than `live`. */
const expectStampedAfterRename = (renames, targets, live) => {
  for (const target of targets) {
    expect(renames.has(target), `${target} renamed into place`).toBe(true);
    const wentLive = live ?? renames.get(target);
    expect(
      mtimeUs(target) >= wentLive,
      `${target} stamped after it went live`,
    ).toBe(true);
  }
};

// Each case runs the scripts up to five times, about half a second each on a
// loaded machine.
const SCRIPT_TIMEOUT = 30_000;

describe("renew.sh", { timeout: SCRIPT_TIMEOUT }, () => {
  it("installs a first certificate without starting a stopped front", () => {
    const host = brokerHost();
    const result = host.runRenew();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(host.tls, "fullchain.pem"), "utf8")).toBe(
      "certificate 1\n",
    );
    expect(result.calls).toEqual(["lego"]);
  });

  it("leaves a running front alone when the certificate is unchanged", () => {
    const host = brokerHost();
    host.runRenew();
    host.startFront();
    const result = host.runRenew();
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual(["lego"]);
    expect(result.stderr).toContain("the certificate is unchanged");
  });

  it("restarts a running front onto a renewed certificate", () => {
    const host = brokerHost();
    host.runRenew();
    host.startFront();
    host.renewTo("2");
    const result = host.runRenew();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(host.tls, "privkey.pem"), "utf8")).toBe("key 2\n");
    expect(result.calls).toEqual([
      "lego",
      `systemctl try-restart ${FRONT_UNIT}`,
    ]);
  });

  it("installs a new certificate without a restart under --no-restart, and the next run restarts the front", () => {
    const host = brokerHost();
    host.runRenew();
    host.startFront();
    host.renewTo("2");
    const renewed = host.runRenew(["--no-restart"]);
    expect(renewed.status, renewed.stderr).toBe(0);
    expect(readFileSync(join(host.tls, "fullchain.pem"), "utf8")).toBe(
      "certificate 2\n",
    );
    expect(renewed.calls).toEqual(["lego"]);
    const next = host.runRenew();
    expect(next.status, next.stderr).toBe(0);
    expect(next.calls).toEqual(["lego", `systemctl try-restart ${FRONT_UNIT}`]);
    expect(host.runRenew().calls).toEqual(["lego"]);
  });

  it("installs a renewed key and certificate by rename, both stamped after the later rename", () => {
    const host = brokerHost();
    host.runRenew();
    host.startFront();
    host.renewTo("2");
    const result = host.runRenew();
    expect(result.status, result.stderr).toBe(0);
    const key = join(host.tls, "privkey.pem");
    const cert = join(host.tls, "fullchain.pem");
    const renames = host.renames();
    expectStampedAfterRename(renames, [key, cert]);
    const pairLive =
      renames.get(key) > renames.get(cert)
        ? renames.get(key)
        : renames.get(cert);
    expectStampedAfterRename(renames, [key, cert], pairLive);
    expect(readFileSync(key, "utf8")).toBe("key 2\n");
    expect(readFileSync(cert, "utf8")).toBe("certificate 2\n");
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(statSync(cert).mode & 0o777).toBe(0o644);
    expect(stagedLeft(host.tls)).toEqual([]);
  });

  it.each([[["--no-restart", "x"]], [["--defer-restart"]], [["x"]]])(
    "refuses the arguments %j before running lego",
    (args) => {
      const result = brokerHost().runRenew(args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("usage: renew.sh");
      expect(result.calls).toEqual([]);
    },
  );

  it("exports the provider credential to lego and to nothing after it", () => {
    const host = brokerHost();
    host.startFront();
    const result = host.runRenew();
    expect(result.status, result.stderr).toBe(0);
    expect(result.env).toContain("lego token=fixture-token");
    const systemctlCalls = result.env.filter((line) =>
      line.startsWith("systemctl"),
    );
    expect(systemctlCalls.length).toBeGreaterThan(0);
    for (const call of systemctlCalls) {
      expect(call).toBe("systemctl token=unset");
    }
  });

  it("refuses an ACME client other than lego", () => {
    const host = brokerHost({ client: "acme.sh" });
    const result = host.runRenew();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("drives lego only");
    expect(result.calls).not.toContain("lego");
  });
});

describe("install.sh", { timeout: SCRIPT_TIMEOUT }, () => {
  it("checks a first install's configuration against the certificate before writing it", () => {
    const host = brokerHost();
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    const check = result.calls.indexOf("nginx -t mode=600 cert=yes");
    expect(check).toBeGreaterThan(result.calls.indexOf("lego"));
    expect(readFileSync(host.conf, "utf8")).toContain(`server_name ${NAME};`);
    expect(statSync(host.conf).mode & 0o777).toBe(0o644);
    expect(statSync(join(host.etc, "lock")).mode & 0o777).toBe(0o600);
    expect(candidatesLeft(host.etc)).toEqual([]);
    expect(result.starts).toEqual([
      brokerStart(pinnedImage(), 1),
      frontStart(pinnedImage(), 1),
    ]);
  });

  it("leaves no live file when a first install's configuration fails nginx -t", () => {
    const host = brokerHost();
    const result = host.run({ broken: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("fails nginx -t");
    expect(existsSync(host.conf)).toBe(false);
    expect(result.calls.filter(touchesFront)).toEqual([]);
    expect(candidatesLeft(host.etc)).toEqual([]);
  });

  it("keeps the live file and the running front when a change fails nginx -t", () => {
    const host = brokerHost();
    expect(host.run().status).toBe(0);
    const before = readFileSync(host.conf, "utf8");
    host.renewTo("2");
    const result = host.run({ broken: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("fails nginx -t");
    expect(result.calls).toContain("nginx -t mode=600 cert=yes");
    expect(readFileSync(host.conf, "utf8")).toBe(before);
    expect(result.calls).not.toContain("lego");
    expect(result.calls.filter(touchesFront)).toEqual([]);
    expect(candidatesLeft(host.etc)).toEqual([]);
  });

  it("replaces the live file with a checked change and restarts the front onto it", () => {
    const host = brokerHost();
    expect(host.run().status).toBe(0);
    writeFileSync(host.conf, "# an earlier configuration\n");
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(host.conf, "utf8")).toContain(`server_name ${NAME};`);
    expect(statSync(host.conf).mode & 0o777).toBe(0o644);
    expect(frontActions(result.calls)).toEqual([
      `systemctl try-restart ${FRONT_UNIT}`,
    ]);
    expect(candidatesLeft(host.etc)).toEqual([]);
    expect(frontActions(host.run().calls)).toEqual([]);
  });

  it("puts each changed file a unit reads in place by a rename and stamps it after the rename", () => {
    const host = brokerHost();
    expect(host.run().status).toBe(0);
    for (const unit of UNITS) {
      appendFileSync(join(host.source, unit), "# revision 2\n");
    }
    host.pinFront(pinnedImage("b"));
    writeFileSync(host.conf, "# an earlier configuration\n");
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    expectStampedAfterRename(host.renames(), [
      host.conf,
      join(host.etc, "front-image.env"),
      ...UNITS.map((unit) => join(host.unitDir, unit)),
    ]);
    for (const unit of UNITS) {
      expect(readFileSync(join(host.unitDir, unit), "utf8")).toContain(
        "# revision 2",
      );
      expect(statSync(join(host.unitDir, unit)).mode & 0o777).toBe(0o644);
    }
    expect(stagedLeft(host.unitDir)).toEqual([]);
    expect(stagedLeft(host.etc)).toEqual([]);
  });

  it("stamps the live configuration when it goes live, so a front started during the renewal restarts onto it", async () => {
    const host = brokerHost();
    expect(host.run().status).toBe(0);
    const template = join(host.source, "nginx.conf.tmpl");
    writeFileSync(template, `${readFileSync(template, "utf8")}# changed\n`);
    host.clearLogs();
    host.holdLego(true);
    const install = host.spawnInstall();
    await waitFor(() => host.calls().includes("lego"));
    host.startFront();
    host.holdLego(false);
    const installed = await install.exit;
    expect(installed.status, installed.stderr).toBe(0);
    expect(readFileSync(host.conf, "utf8")).toContain("# changed");
    expect(frontActions(host.calls())).toEqual([
      `systemctl try-restart ${FRONT_UNIT}`,
    ]);
  });

  it("stamps the staged configuration just before the rename, so a run killed after the rename leaves it newer than the wait", async () => {
    const host = brokerHost();
    expect(host.run().status).toBe(0);
    const template = join(host.source, "nginx.conf.tmpl");
    writeFileSync(template, `${readFileSync(template, "utf8")}# changed\n`);
    host.clearLogs();
    host.holdLego(true);
    host.stopAfterConf(true);
    const install = host.spawnInstall();
    await waitFor(() => host.calls().includes("lego"));
    const waited = BigInt(Date.now()) * 1000n;
    await new Promise((done) => setTimeout(done, 100));
    host.holdLego(false);
    const installed = await install.exit;
    expect(installed.status).not.toBe(0);
    expect(readFileSync(host.conf, "utf8")).toContain("# changed");
    expect(mtimeUs(host.conf) > waited + 50_000n).toBe(true);
  });

  it("puts the unit-state.sh a new renew.sh calls in place before renew.sh", () => {
    const host = brokerHost();
    expect(host.run().status).toBe(0);
    for (const file of ["renew.sh", "unit-state.sh"]) {
      appendFileSync(join(host.source, file), "# revision 2\n");
    }
    host.clearLogs();
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    const order = [...host.renames().entries()]
      .filter(([target]) => /\/(renew|unit-state)\.sh$/.test(target))
      .sort((a, b) => Number(a[1] - b[1]))
      .map(([target]) => basename(target));
    expect(order).toEqual(["unit-state.sh", "renew.sh"]);
  });

  it("does not start through a restart a front stopped after the staleness check", () => {
    const host = brokerHost();
    expect(host.run().status).toBe(0);
    writeFileSync(host.conf, "# an earlier configuration\n");
    host.stopFrontOnReload(true);
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    expect(frontActions(result.calls)).toEqual([
      `systemctl try-restart ${FRONT_UNIT}`,
      `systemctl enable --now ${FRONT_UNIT}`,
    ]);
    expect(result.starts).toEqual([frontStart(pinnedImage(), 1)]);
  });

  it("issues no action when nothing changed, from a re-run or the renewal timer", () => {
    const host = brokerHost();
    expect(host.run().status).toBe(0);
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain("lego");
    expect(frontActions(result.calls)).toEqual([]);
    expect(result.starts).toEqual([]);
    const timer = host.runTimer();
    expect(timer.status, timer.stderr).toBe(0);
    expect(timer.calls).toEqual(["lego"]);
  });

  it("starts a stopped front, and the renewal timer leaves it stopped", () => {
    const host = brokerHost();
    expect(host.run().status).toBe(0);
    host.stopFront();
    host.renewTo("2");
    const timer = host.runTimer();
    expect(timer.status, timer.stderr).toBe(0);
    expect(timer.calls).toEqual(["lego"]);
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    expect(frontActions(result.calls)).toEqual([
      `systemctl enable --now ${FRONT_UNIT}`,
    ]);
    expect(result.starts).toEqual([frontStart(pinnedImage(), 2)]);
  });

  it("restarts the front once, onto the new image and certificate, when the pin moves with a renewal due", () => {
    const host = brokerHost();
    expect(host.run().status).toBe(0);
    host.pinFront(pinnedImage("b"));
    host.renewTo("2");
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    expect(frontActions(result.calls)).toEqual([
      `systemctl try-restart ${FRONT_UNIT}`,
    ]);
    expect(result.starts).toEqual([frontStart(pinnedImage("b"), 2)]);
    expect(
      result.calls.indexOf(`systemctl try-restart ${FRONT_UNIT}`),
    ).toBeGreaterThan(result.calls.indexOf("lego"));
  });

  it("restarts the front through a changed broker unit and not again", () => {
    const host = brokerHost();
    expect(host.run().status).toBe(0);
    appendFileSync(join(host.unitDir, BROKER_UNIT), "# an earlier unit\n");
    host.pinFront(pinnedImage("b"));
    host.renewTo("2");
    writeFileSync(host.conf, "# an earlier configuration\n");
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    expect(frontActions(result.calls)).toEqual([]);
    expect(result.starts).toEqual([
      brokerStart(pinnedImage("b"), 2),
      frontStart(pinnedImage("b"), 2),
    ]);
    const reload = result.calls.indexOf("systemctl daemon-reload");
    expect(reload).toBeGreaterThanOrEqual(0);
    expect(
      result.calls.indexOf(`systemctl try-restart ${BROKER_UNIT}`),
    ).toBeGreaterThan(reload);
  });

  it("restarts nothing and renews nothing when a change fails nginx -t, even with a changed broker unit", () => {
    const host = brokerHost();
    expect(host.run().status).toBe(0);
    const brokerUnit = join(host.unitDir, BROKER_UNIT);
    appendFileSync(brokerUnit, "# an earlier unit\n");
    const brokerUnitBefore = readFileSync(brokerUnit, "utf8");
    const frontUnitBefore = readFileSync(
      join(host.unitDir, FRONT_UNIT),
      "utf8",
    );
    host.renewTo("2");
    const result = host.run({ broken: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("fails nginx -t");
    expect(
      result.calls.filter((call) =>
        /^systemctl (try-restart|start|stop)\b/.test(call),
      ),
    ).toEqual([]);
    expect(result.calls).not.toContain("lego");
    expect(result.calls.filter(touchesFront)).toEqual([]);
    expect(readFileSync(brokerUnit, "utf8")).toBe(brokerUnitBefore);
    expect(readFileSync(join(host.unitDir, FRONT_UNIT), "utf8")).toBe(
      frontUnitBefore,
    );
    expect(readFileSync(join(host.tls, "fullchain.pem"), "utf8")).toBe(
      "certificate 1\n",
    );
  });

  it("checks a change before restarting a changed broker unit", () => {
    const host = brokerHost();
    expect(host.run().status).toBe(0);
    appendFileSync(join(host.unitDir, BROKER_UNIT), "# an earlier unit\n");
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    const check = result.calls.indexOf("nginx -t mode=600 cert=yes");
    const restart = result.calls.indexOf(
      `systemctl try-restart ${BROKER_UNIT}`,
    );
    expect(check).toBeGreaterThanOrEqual(0);
    expect(restart).toBeGreaterThan(check);
  });

  it("refuses to obtain a certificate under a running front", () => {
    const host = brokerHost();
    host.startFront();
    const result = host.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("has no certificate");
    expect(result.calls).not.toContain("lego");
    expect(result.calls.filter(touchesFront)).toEqual([]);
  });

  it("refuses a front image without a digest before touching anything", () => {
    const host = brokerHost();
    host.pinFront(pinnedImage().replace(/@.*$/, ""));
    const result = host.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("pinned by digest");
    expect(result.calls).toEqual([]);
  });

  it("runs the front on the image it checked, and restarts it when the pin moves", () => {
    const host = brokerHost();
    expect(host.run().status).toBe(0);
    host.pinFront(pinnedImage("b"));
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain(`docker pull -q ${pinnedImage("b")}`);
    expect(result.calls).toContainEqual(
      expect.stringMatching(
        new RegExp(` --entrypoint nginx ${pinnedImage("b")} -t$`),
      ),
    );
    expect(readFileSync(join(host.etc, "front-image.env"), "utf8")).toBe(
      `ALCOVE_BROKER_FRONT_IMAGE=${pinnedImage("b")}\n`,
    );
    expect(result.starts).toEqual([frontStart(pinnedImage("b"), 1)]);
  });

  it("leaves the target state unwritten when the renewal fails, and nothing for the timer to restart", () => {
    const host = brokerHost();
    expect(host.run().status).toBe(0);
    host.pinFront(pinnedImage("b"));
    host.failLego(true);
    const result = host.run();
    expect(result.status).not.toBe(0);
    expect(result.calls).toContain("lego");
    expect(readFileSync(join(host.etc, "front-image.env"), "utf8")).toBe(
      `ALCOVE_BROKER_FRONT_IMAGE=${pinnedImage()}\n`,
    );
    expect(result.calls.filter((call) => call.startsWith("systemctl"))).toEqual(
      [],
    );
    const timer = host.runTimer();
    expect(timer.status).not.toBe(0);
    expect(timer.calls).toEqual(["lego"]);
  });

  // A run that wrote its changes and died at daemon-reload, before any restart.
  const interrupted = (change) => {
    const host = brokerHost();
    expect(host.run().status).toBe(0);
    change(host);
    host.failDaemonReload(true);
    const failed = host.run();
    expect(failed.status).not.toBe(0);
    expect(failed.starts).toEqual([]);
    host.failDaemonReload(false);
    return host;
  };

  it.each([
    ["the renewal timer", (host) => host.runTimer()],
    ["a re-run of install.sh", (host) => host.run()],
  ])(
    "has %s restart the front onto a unit file whose daemon-reload a failed run lost",
    (_, next) => {
      const host = interrupted((h) =>
        appendFileSync(join(h.source, FRONT_UNIT), "# revision 2\n"),
      );
      expect(readFileSync(join(host.unitDir, FRONT_UNIT), "utf8")).toContain(
        "# revision 2",
      );
      const result = next(host);
      expect(result.status, result.stderr).toBe(0);
      expect(result.starts).toEqual([frontStart(pinnedImage(), 1)]);
      const reload = result.calls.indexOf("systemctl daemon-reload");
      expect(reload).toBeGreaterThanOrEqual(0);
      expect(
        result.calls.indexOf(`systemctl try-restart ${FRONT_UNIT}`),
      ).toBeGreaterThan(reload);
      expect(host.runTimer().calls).toEqual(["lego"]);
    },
  );

  it("has the renewal timer restart the front onto a certificate a failed run installed, while lego fails, and exit non-zero", () => {
    const host = interrupted((h) => h.renewTo("2"));
    expect(readFileSync(join(host.tls, "fullchain.pem"), "utf8")).toBe(
      "certificate 2\n",
    );
    host.failLego(true);
    const result = host.runTimer();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("lego did not renew");
    expect(result.starts).toEqual([frontStart(pinnedImage(), 2)]);
    expect(host.runTimer().starts).toEqual([]);
  });

  it("restarts the broker on the run after one that died before restarting it", () => {
    const host = interrupted((h) =>
      appendFileSync(join(h.source, BROKER_UNIT), "# revision 2\n"),
    );
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.starts).toEqual([
      brokerStart(pinnedImage(), 1),
      frontStart(pinnedImage(), 1),
    ]);
    expect(frontActions(result.calls)).toEqual([]);
    expect(host.run().starts).toEqual([]);
  });

  it("restarts the renewal timer onto its unit file on the run after one that died before restarting it", () => {
    const timerRestarts = (calls) =>
      calls.filter((call) =>
        new RegExp(`^systemctl (try-)?restart ${TIMER_UNIT}$`).test(call),
      );
    const host = brokerHost();
    expect(host.run().status).toBe(0);
    appendFileSync(join(host.source, BROKER_UNIT), "# revision 2\n");
    appendFileSync(join(host.source, TIMER_UNIT), "# revision 2\n");
    host.failRestart(true);
    const failed = host.run();
    expect(failed.status).not.toBe(0);
    expect(failed.calls).toContain("systemctl daemon-reload");
    expect(timerRestarts(failed.calls)).toEqual([]);
    host.failRestart(false);
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    expect(timerRestarts(result.calls)).toHaveLength(1);
    expect(timerRestarts(host.run().calls)).toEqual([]);
  });

  it("runs install.sh and the renewal timer one at a time", async () => {
    const host = brokerHost();
    expect(host.run().status).toBe(0);
    host.clearLogs();
    host.holdLego(true);
    const install = host.spawnInstall();
    await waitFor(() => host.calls().includes("lego"));
    const timer = host.spawnTimer();
    await new Promise((done) => setTimeout(done, 300));
    expect(host.calls().filter((call) => call === "lego")).toHaveLength(1);
    expect(timer.child.exitCode).toBe(null);
    host.holdLego(false);
    const [installed, renewed] = await Promise.all([install.exit, timer.exit]);
    expect(installed.status, installed.stderr).toBe(0);
    expect(renewed.status, renewed.stderr).toBe(0);
    expect(renewed.stderr).toContain("waiting for another install.sh");
    const calls = host.calls();
    const legoRuns = calls.flatMap((call, at) => (call === "lego" ? [at] : []));
    expect(legoRuns).toHaveLength(2);
    expect(legoRuns[1]).toBeGreaterThan(
      calls.lastIndexOf("systemctl enable alcove-broker-cert.timer"),
    );
  });

  it("has a renewal timer run that waited on install.sh act with the unit-state.sh install.sh put in place", async () => {
    const host = brokerHost();
    expect(host.run().status).toBe(0);
    appendFileSync(
      join(host.source, "unit-state.sh"),
      'log "unit-state revision 2"\n',
    );
    host.clearLogs();
    host.holdDocker(true);
    const install = host.spawnInstall();
    await waitFor(() =>
      host.calls().some((call) => call.startsWith("docker pull")),
    );
    const timer = host.spawnTimer();
    await waitFor(() =>
      timer.stderr().includes("waiting for another install.sh"),
    );
    host.holdDocker(false);
    const [installed, renewed] = await Promise.all([install.exit, timer.exit]);
    expect(installed.status, installed.stderr).toBe(0);
    expect(renewed.status, renewed.stderr).toBe(0);
    expect(renewed.stderr).toContain("unit-state revision 2");
  });
});

describe("the front image pin", () => {
  const unit = readFileSync(
    join(BROKER, "alcove-broker-tls.service"),
    "utf8",
  ).replace(/\\\n/g, " ");

  it("is one registry-qualified nginx reference with an index digest", () => {
    const references = fromReference(join(BROKER, "Dockerfile"));
    expect(references).toHaveLength(1);
    expect(references[0]).toMatch(PINNED_NGINX);
  });

  it("is what the front unit runs, from the file install.sh writes", () => {
    expect(unit).toMatch(
      /^EnvironmentFile=\/etc\/alcove-broker\/front-image\.env$/m,
    );
    const execStart = /^ExecStart=(.*)$/m.exec(unit)?.[1].trim().split(/\s+/);
    expect(execStart?.at(-1)).toBe("${ALCOVE_BROKER_FRONT_IMAGE}");
  });

  it("is named nowhere else in infra/broker", () => {
    for (const entry of readdirSync(BROKER, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name === "Dockerfile") continue;
      expect(
        readFileSync(join(BROKER, entry.name), "utf8"),
        entry.name,
      ).not.toMatch(/nginx:\d/);
    }
  });
});
