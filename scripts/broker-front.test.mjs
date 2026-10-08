import { spawnSync } from "node:child_process";
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
import { dirname, join, resolve } from "node:path";
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

describe("renew.sh", () => {
  const NAME = "broker.example.org";

  const fixtureHost = ({ client = "lego" } = {}) => {
    const root = fixtureDir("broker-renew-");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const calls = join(root, "calls.log");
    const active = join(root, "front-active");
    const serial = join(root, "serial");
    const acmeHome = join(root, "acme");
    const tls = join(root, "tls");
    const pending = join(root, "front-action-pending");
    writeFileSync(calls, "");
    writeFileSync(serial, "1");
    writeStub(
      join(bin, "systemctl"),
      [
        `printf 'systemctl %s token=%s\\n' "$*" "\${CLOUDFLARE_DNS_API_TOKEN-unset}" >> '${calls}'`,
        `if [ "$1" = is-active ]; then [ -f '${active}' ]; fi`,
      ].join("\n"),
    );
    writeStub(
      join(bin, "lego"),
      [
        `printf 'lego token=%s\\n' "\${CLOUDFLARE_DNS_API_TOKEN-unset}" >> '${calls}'`,
        `mkdir -p '${acmeHome}/certificates'`,
        `printf 'certificate %s\\n' "$(cat '${serial}')" > '${acmeHome}/certificates/${NAME}.crt'`,
        `printf 'key %s\\n' "$(cat '${serial}')" > '${acmeHome}/certificates/${NAME}.key'`,
      ].join("\n"),
    );
    const envFile = join(root, "broker.env");
    const acmeEnv = join(root, "acme.env");
    writeFileSync(
      envFile,
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
    return {
      root,
      tls,
      pending,
      startFront: () => writeFileSync(active, ""),
      renewTo: (next) => writeFileSync(serial, next),
      run: (args = []) => {
        writeFileSync(calls, "");
        const result = spawnSync(BASH, [join(BROKER, "renew.sh"), ...args], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            ALCOVE_BROKER_ENV_FILE: envFile,
            ALCOVE_BROKER_ACME_HOME: acmeHome,
            ALCOVE_BROKER_TLS_DIR: tls,
            ALCOVE_BROKER_FRONT_PENDING: pending,
          },
        });
        return {
          ...result,
          calls: readFileSync(calls, "utf8").trim().split("\n"),
        };
      },
    };
  };

  it("installs a first certificate without starting a stopped front", () => {
    const host = fixtureHost();
    const result = host.run();
    expect(result.status).toBe(0);
    expect(readFileSync(join(host.tls, "fullchain.pem"), "utf8")).toBe(
      "certificate 1\n",
    );
    expect(result.calls.filter((call) => /restart|start /.test(call))).toEqual(
      [],
    );
    expect(existsSync(host.pending)).toBe(false);
  });

  it("leaves a running front alone when the certificate is unchanged", () => {
    const host = fixtureHost();
    host.run();
    host.startFront();
    const result = host.run();
    expect(result.status).toBe(0);
    expect(result.calls.some((call) => call.includes("restart"))).toBe(false);
    expect(result.stderr).toContain("certificate unchanged");
  });

  it("restarts a running front onto a renewed certificate", () => {
    const host = fixtureHost();
    host.run();
    host.startFront();
    host.renewTo("2");
    const result = host.run();
    expect(result.status).toBe(0);
    expect(readFileSync(join(host.tls, "privkey.pem"), "utf8")).toBe("key 2\n");
    expect(result.calls).toContainEqual(
      expect.stringMatching(/^systemctl restart alcove-broker-tls\.service /),
    );
    expect(existsSync(host.pending)).toBe(false);
  });

  it("records a new certificate as a restart owed under --defer-restart, and does not restart", () => {
    const host = fixtureHost();
    host.run();
    host.startFront();
    const unchanged = host.run(["--defer-restart"]);
    expect(unchanged.status).toBe(0);
    expect(existsSync(host.pending)).toBe(false);
    host.renewTo("2");
    const renewed = host.run(["--defer-restart"]);
    expect(renewed.status).toBe(0);
    expect(readFileSync(join(host.tls, "fullchain.pem"), "utf8")).toBe(
      "certificate 2\n",
    );
    expect(readFileSync(host.pending, "utf8")).toBe("restart\n");
    expect(renewed.calls.some((call) => call.includes("restart"))).toBe(false);
  });

  it("restarts a running front for a restart an earlier run left owed, with the certificate unchanged", () => {
    const host = fixtureHost();
    host.run();
    host.startFront();
    writeFileSync(host.pending, "restart\n");
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    expect(
      result.calls.filter((call) => call.startsWith("systemctl restart")),
    ).toEqual([
      expect.stringMatching(/^systemctl restart alcove-broker-tls\.service /),
    ]);
    expect(existsSync(host.pending)).toBe(false);
  });

  it("clears an owed restart without starting a stopped front", () => {
    const host = fixtureHost();
    host.run();
    writeFileSync(host.pending, "restart\n");
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.filter((call) => /restart|start /.test(call))).toEqual(
      [],
    );
    expect(existsSync(host.pending)).toBe(false);
  });

  it("leaves an owed reload to install.sh", () => {
    const host = fixtureHost();
    host.run();
    host.startFront();
    writeFileSync(host.pending, "reload\n");
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.some((call) => call.includes("restart"))).toBe(false);
    expect(result.stderr).toContain("run install.sh again");
    expect(readFileSync(host.pending, "utf8")).toBe("reload\n");
  });

  it.each([[["--defer-restart", "x"]], [["--restart", "x"]], [["x"]]])(
    "refuses the arguments %j before running lego",
    (args) => {
      const result = fixtureHost().run(args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("usage: renew.sh");
      expect(result.calls).toEqual([""]);
    },
  );

  it("exports the provider credential to lego and to nothing after it", () => {
    const host = fixtureHost();
    host.startFront();
    const result = host.run();
    expect(result.status).toBe(0);
    expect(result.calls).toContain("lego token=fixture-token");
    const systemctlCalls = result.calls.filter((call) =>
      call.startsWith("systemctl"),
    );
    expect(systemctlCalls.length).toBeGreaterThan(0);
    for (const call of systemctlCalls) expect(call).toMatch(/token=unset$/);
  });

  it("refuses an ACME client other than lego", () => {
    const host = fixtureHost({ client: "acme.sh" });
    const result = host.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("drives lego only");
    expect(result.calls).toEqual([""]);
  });
});

/** The FROM reference of a Dockerfile: the front image's one home. */
const fromReference = (dockerfile) =>
  [...readFileSync(dockerfile, "utf8").matchAll(/^FROM (.*)$/gm)].map(
    (match) => match[1],
  );

const PINNED_NGINX = /^docker\.io\/library\/nginx:[^@\s]+@sha256:[0-9a-f]{64}$/;

describe("install.sh", () => {
  const NAME = "broker.example.org";
  const FRONT_UNIT = "alcove-broker-tls.service";

  // A copy of infra/broker whose Dockerfile pins the tracked tag to a fixture
  // digest, so these runs do not depend on the tracked pin.
  const pinnedImage = (digestByte = "a") =>
    `${fromReference(join(BROKER, "Dockerfile"))[0].replace(/@.*$/, "")}@sha256:${digestByte.repeat(64)}`;

  const fixtureHost = () => {
    const root = fixtureDir("broker-install-");
    const broker = join(root, "broker");
    cpSync(BROKER, broker, { recursive: true });
    const pinFront = (image) =>
      writeFileSync(join(broker, "Dockerfile"), `FROM ${image}\n`);
    pinFront(pinnedImage());
    const bin = join(root, "bin");
    const usrBin = join(root, "usr/bin");
    const etc = join(root, "etc/alcove-broker");
    const src = join(root, "opt/alcove-broker/src");
    for (const dir of [
      bin,
      usrBin,
      join(root, "usr/local/bin"),
      join(root, "etc/systemd/system"),
      join(src, "node_modules/.bin"),
      join(src, "packages/core/dist"),
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    mkdirSync(etc, { recursive: true, mode: 0o700 });
    writeStub(join(root, "usr/local/bin/npm"), "exit 0");
    writeStub(join(src, "node_modules/.bin/tsx"), "exit 0");
    writeFileSync(
      join(src, "packages/core/dist/untrusted-text.esm.js"),
      "//\n",
    );

    const calls = join(root, "calls.log");
    const restarts = join(root, "restarts.log");
    const active = join(root, "front-active");
    const brokerActive = join(root, "broker-active");
    const failReload = join(root, "fail-daemon-reload");
    const failLego = join(root, "fail-lego");
    const serial = join(root, "serial");
    const acmeEnv = join(root, "acme.env");
    writeFileSync(calls, "");
    writeFileSync(serial, "1");
    writeStub(
      join(bin, "id"),
      `if [ "$1" = -u ]; then echo 0; else exec /usr/bin/id "$@"; fi`,
    );
    writeStub(join(bin, "curl"), "exit 0");
    writeStub(
      join(bin, "systemctl"),
      [
        `printf 'systemctl %s\\n' "$*" >> '${calls}'`,
        `if [ "$1" = daemon-reload ] && [ -f '${failReload}' ]; then exit 1; fi`,
        // What a restarted front starts on: its image and its certificate.
        `if [ "$1" = restart ]; then`,
        `  printf '%s image=%s cert=%s\\n' "$2" "$(sed -n 's/^ALCOVE_BROKER_FRONT_IMAGE=//p' '${etc}/front-image.env')" "$(cat '${etc}/tls/fullchain.pem')" >> '${restarts}'`,
        `fi`,
        `if [ "$1" = is-active ]; then`,
        `  case "$3" in`,
        `    alcove-broker-tls.service) [ -f '${active}' ] ;;`,
        `    alcove-broker.service) [ -f '${brokerActive}' ] ;;`,
        `    *) false ;;`,
        `  esac`,
        `fi`,
      ].join("\n"),
    );
    writeStub(
      join(bin, "lego"),
      [
        `printf 'lego\\n' >> '${calls}'`,
        `[ ! -f '${failLego}' ] || exit 1`,
        `mkdir -p '${etc}/acme/certificates'`,
        `printf 'certificate %s\\n' "$(cat '${serial}')" > '${etc}/acme/certificates/${NAME}.crt'`,
        `printf 'key %s\\n' "$(cat '${serial}')" > '${etc}/acme/certificates/${NAME}.key'`,
      ].join("\n"),
    );
    // nginx -t in a throwaway container: records the candidate's mode and
    // whether a certificate was mounted, and fails on `broken_directive`.
    writeStub(
      join(usrBin, "docker"),
      [
        `printf 'docker %s\\n' "$*" >> '${calls}'`,
        `[ "$1" = run ] || exit 0`,
        `conf=; tls=`,
        `for arg in "$@"; do`,
        `  case "$arg" in`,
        `    *:/etc/nginx/nginx.conf:ro) conf="\${arg%%:*}" ;;`,
        `    *:/etc/nginx/tls:ro) tls="\${arg%%:*}" ;;`,
        `  esac`,
        `done`,
        `cert=no; [ -s "$tls/fullchain.pem" ] && cert=yes`,
        `printf 'nginx -t mode=%s cert=%s\\n' "$(stat -c %a "$conf")" "$cert" >> '${calls}'`,
        `! grep -q broken_directive "$conf"`,
      ].join("\n"),
    );
    writeFileSync(
      join(etc, "broker.env"),
      `ALCOVE_BROKER_NAME=${NAME}\nALCOVE_BROKER_ACME_ENV=${acmeEnv}\n`,
    );
    writeFileSync(
      acmeEnv,
      "ALCOVE_RELAY_ACME_EMAIL=ops@example.org\nCLOUDFLARE_DNS_API_TOKEN=fixture-token\n",
    );
    const brokenTemplate = join(root, "broken.tmpl");
    writeFileSync(
      brokenTemplate,
      readFileSync(TEMPLATE, "utf8").replace(
        "worker_processes 1;",
        "worker_processes 1;\nbroken_directive on;",
      ),
    );

    const conf = join(etc, "nginx.conf");
    const unitDir = join(root, "etc/systemd/system");
    const pending = join(etc, "front-action-pending");
    const brokerPending = join(etc, "broker-restart-pending");
    const PATH = `${usrBin}:${bin}:${process.env.PATH}`;
    const runScript = (script, env) => {
      writeFileSync(calls, "");
      writeFileSync(restarts, "");
      const result = spawnSync(BASH, [script], {
        encoding: "utf8",
        env: { ...process.env, PATH, ...env },
      });
      return {
        ...result,
        calls: readFileSync(calls, "utf8").trim().split("\n"),
        restarts: readFileSync(restarts, "utf8").split("\n").slice(0, -1),
      };
    };
    return {
      conf,
      etc,
      unitDir,
      pending,
      pinFront,
      startFront: () => writeFileSync(active, ""),
      startBroker: () => writeFileSync(brokerActive, ""),
      renewTo: (next) => writeFileSync(serial, next),
      failDaemonReload: (fail) =>
        fail ? writeFileSync(failReload, "") : rmSync(failReload),
      failLego: () => writeFileSync(failLego, ""),
      marksLeft: () => [pending, brokerPending].filter(existsSync),
      run: ({ broken = false } = {}) =>
        runScript(join(broker, "install.sh"), {
          ALCOVE_BROKER_INSTALL_ROOT: root,
          ...(broken ? { ALCOVE_BROKER_TEMPLATE: brokenTemplate } : {}),
        }),
      // The renewal timer: the installed renew.sh with no argument.
      runTimer: () =>
        runScript(join(etc, "renew.sh"), {
          ALCOVE_BROKER_ENV_FILE: join(etc, "broker.env"),
          ALCOVE_BROKER_ACME_HOME: join(etc, "acme"),
          ALCOVE_BROKER_TLS_DIR: join(etc, "tls"),
          ALCOVE_BROKER_FRONT_PENDING: pending,
        }),
    };
  };

  // A start, stop, restart or reload of the front; enabling it is none of these.
  const frontActions = (calls) =>
    calls.filter(
      (call) =>
        /^systemctl (restart|reload|start|stop|enable --now)\b.*alcove-broker-tls/.test(
          call,
        ) || /^docker exec alcove-broker-tls nginx /.test(call),
    );

  const touchesFront = (call) =>
    /^systemctl (restart|reload|start|enable|stop)\b.*alcove-broker-tls/.test(
      call,
    ) || /^docker exec /.test(call);

  const candidatesLeft = (etc) =>
    readdirSync(etc).filter((entry) => entry.startsWith("nginx.conf."));

  it("checks a first install's configuration against the certificate before writing it", () => {
    const host = fixtureHost();
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    const check = result.calls.indexOf("nginx -t mode=600 cert=yes");
    expect(check).toBeGreaterThan(result.calls.indexOf("lego"));
    expect(readFileSync(host.conf, "utf8")).toContain(`server_name ${NAME};`);
    expect(statSync(host.conf).mode & 0o777).toBe(0o644);
    expect(candidatesLeft(host.etc)).toEqual([]);
    expect(host.marksLeft()).toEqual([]);
  });

  it("leaves no live file when a first install's configuration fails nginx -t", () => {
    const host = fixtureHost();
    const result = host.run({ broken: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("fails nginx -t");
    expect(existsSync(host.conf)).toBe(false);
    expect(result.calls.filter(touchesFront)).toEqual([]);
    expect(candidatesLeft(host.etc)).toEqual([]);
  });

  it("keeps the live file and the running front when a change fails nginx -t", () => {
    const host = fixtureHost();
    expect(host.run().status).toBe(0);
    host.startFront();
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

  it("copies a checked change over the live file in place and reloads the front", () => {
    const host = fixtureHost();
    writeFileSync(host.conf, "# an earlier configuration\n");
    const inode = statSync(host.conf).ino;
    expect(host.run().status).toBe(0);
    host.startFront();
    writeFileSync(host.conf, "# an earlier configuration\n");
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    expect(statSync(host.conf).ino).toBe(inode);
    expect(readFileSync(host.conf, "utf8")).toContain(`server_name ${NAME};`);
    expect(frontActions(result.calls)).toEqual([
      "docker exec alcove-broker-tls nginx -s reload",
    ]);
    expect(result.calls.some((call) => call.includes("restart"))).toBe(false);
    expect(host.marksLeft()).toEqual([]);
  });

  it("issues no front action when nothing changed", () => {
    const host = fixtureHost();
    expect(host.run().status).toBe(0);
    host.startBroker();
    host.startFront();
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain("lego");
    expect(frontActions(result.calls)).toEqual([]);
    expect(result.restarts).toEqual([]);
    expect(host.marksLeft()).toEqual([]);
  });

  it("restarts the front once, onto the new image and certificate, when the pin moves with a renewal due", () => {
    const host = fixtureHost();
    expect(host.run().status).toBe(0);
    host.startBroker();
    host.startFront();
    host.pinFront(pinnedImage("b"));
    host.renewTo("2");
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    expect(frontActions(result.calls)).toEqual([
      `systemctl restart ${FRONT_UNIT}`,
    ]);
    expect(result.restarts).toEqual([
      `${FRONT_UNIT} image=${pinnedImage("b")} cert=certificate 2`,
    ]);
    expect(
      result.calls.indexOf(`systemctl restart ${FRONT_UNIT}`),
    ).toBeGreaterThan(result.calls.indexOf("lego"));
    expect(host.marksLeft()).toEqual([]);
  });

  it("restarts the front through a changed broker unit and not again", () => {
    const host = fixtureHost();
    expect(host.run().status).toBe(0);
    host.startBroker();
    host.startFront();
    appendFileSync(
      join(host.unitDir, "alcove-broker.service"),
      "# an earlier unit\n",
    );
    host.pinFront(pinnedImage("b"));
    host.renewTo("2");
    writeFileSync(host.conf, "# an earlier configuration\n");
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    expect(frontActions(result.calls)).toEqual([]);
    expect(result.restarts).toEqual([
      `alcove-broker.service image=${pinnedImage("b")} cert=certificate 2`,
    ]);
    const reload = result.calls.indexOf("systemctl daemon-reload");
    expect(reload).toBeGreaterThanOrEqual(0);
    expect(
      result.calls.indexOf("systemctl restart alcove-broker.service"),
    ).toBeGreaterThan(reload);
    expect(host.marksLeft()).toEqual([]);
  });

  it("restarts nothing and renews nothing when a change fails nginx -t, even with a changed broker unit", () => {
    const host = fixtureHost();
    expect(host.run().status).toBe(0);
    host.startBroker();
    host.startFront();
    const brokerUnit = join(host.unitDir, "alcove-broker.service");
    appendFileSync(brokerUnit, "# an earlier unit\n");
    const brokerUnitBefore = readFileSync(brokerUnit, "utf8");
    const frontUnitBefore = readFileSync(
      join(host.unitDir, FRONT_UNIT),
      "utf8",
    );
    const certBefore = readFileSync(
      join(host.etc, "tls/fullchain.pem"),
      "utf8",
    );
    host.renewTo("2");
    const result = host.run({ broken: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("fails nginx -t");
    expect(
      result.calls.filter((call) =>
        /^systemctl (restart|start|stop)\b/.test(call),
      ),
    ).toEqual([]);
    expect(result.calls).not.toContain("lego");
    expect(result.calls.filter(touchesFront)).toEqual([]);
    expect(readFileSync(brokerUnit, "utf8")).toBe(brokerUnitBefore);
    expect(readFileSync(join(host.unitDir, FRONT_UNIT), "utf8")).toBe(
      frontUnitBefore,
    );
    expect(readFileSync(join(host.etc, "tls/fullchain.pem"), "utf8")).toBe(
      certBefore,
    );
  });

  it("checks a change before restarting a changed broker unit", () => {
    const host = fixtureHost();
    expect(host.run().status).toBe(0);
    host.startBroker();
    appendFileSync(
      join(host.unitDir, "alcove-broker.service"),
      "# an earlier unit\n",
    );
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    const check = result.calls.indexOf("nginx -t mode=600 cert=yes");
    const restart = result.calls.indexOf(
      "systemctl restart alcove-broker.service",
    );
    expect(check).toBeGreaterThanOrEqual(0);
    expect(restart).toBeGreaterThan(check);
  });

  it("refuses to obtain a certificate under a running front", () => {
    const host = fixtureHost();
    host.startFront();
    const result = host.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("has no certificate");
    expect(result.calls).not.toContain("lego");
    expect(result.calls.filter(touchesFront)).toEqual([]);
  });

  it("refuses a front image without a digest before touching anything", () => {
    const host = fixtureHost();
    host.pinFront(pinnedImage().replace(/@.*$/, ""));
    const result = host.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("pinned by digest");
    expect(
      result.calls.filter((call) => /^(docker|systemctl|lego)\b/.test(call)),
    ).toEqual([]);
  });

  it("runs the front on the image it checked, and restarts it when the pin moves", () => {
    const host = fixtureHost();
    expect(host.run().status).toBe(0);
    host.startFront();
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
    expect(result.calls).toContain(`systemctl restart ${FRONT_UNIT}`);
    expect(host.marksLeft()).toEqual([]);
  });

  // A run that wrote the new image and certificate and died before restarting
  // the front: daemon-reload, the first systemctl action, fails.
  const interruptedAfterWrites = () => {
    const host = fixtureHost();
    expect(host.run().status).toBe(0);
    host.startBroker();
    host.startFront();
    host.pinFront(pinnedImage("b"));
    host.renewTo("2");
    host.failDaemonReload(true);
    const failed = host.run();
    expect(failed.status).not.toBe(0);
    expect(readFileSync(join(host.etc, "front-image.env"), "utf8")).toBe(
      `ALCOVE_BROKER_FRONT_IMAGE=${pinnedImage("b")}\n`,
    );
    expect(readFileSync(join(host.etc, "tls/fullchain.pem"), "utf8")).toBe(
      "certificate 2\n",
    );
    expect(failed.restarts).toEqual([]);
    expect(readFileSync(host.pending, "utf8")).toBe("restart\n");
    host.failDaemonReload(false);
    return host;
  };

  it("restarts the front once on the run after one that died with its restart owed", () => {
    const host = interruptedAfterWrites();
    const broken = host.run({ broken: true });
    expect(broken.status).not.toBe(0);
    expect(readFileSync(host.pending, "utf8")).toBe("restart\n");
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("an earlier run did not finish");
    expect(frontActions(result.calls)).toEqual([
      `systemctl restart ${FRONT_UNIT}`,
    ]);
    expect(result.restarts).toEqual([
      `${FRONT_UNIT} image=${pinnedImage("b")} cert=certificate 2`,
    ]);
    expect(host.marksLeft()).toEqual([]);
    const again = host.run();
    expect(again.status, again.stderr).toBe(0);
    expect(frontActions(again.calls)).toEqual([]);
  });

  it("has the renewal timer restart the front a failed run left owed", () => {
    const host = interruptedAfterWrites();
    const result = host.runTimer();
    expect(result.status, result.stderr).toBe(0);
    expect(result.restarts).toEqual([
      `${FRONT_UNIT} image=${pinnedImage("b")} cert=certificate 2`,
    ]);
    expect(host.marksLeft()).toEqual([]);
  });

  it("leaves nothing owed when the renewal fails before the writes", () => {
    const host = fixtureHost();
    expect(host.run().status).toBe(0);
    host.startBroker();
    host.startFront();
    host.pinFront(pinnedImage("b"));
    host.failLego();
    const result = host.run();
    expect(result.status).not.toBe(0);
    expect(result.calls).toContain("lego");
    expect(readFileSync(join(host.etc, "front-image.env"), "utf8")).toBe(
      `ALCOVE_BROKER_FRONT_IMAGE=${pinnedImage()}\n`,
    );
    expect(host.marksLeft()).toEqual([]);
  });

  it("restarts the broker on the run after one that died with its restart owed", () => {
    const host = fixtureHost();
    expect(host.run().status).toBe(0);
    host.startBroker();
    host.startFront();
    appendFileSync(
      join(host.unitDir, "alcove-broker.service"),
      "# an earlier unit\n",
    );
    host.failDaemonReload(true);
    expect(host.run().status).not.toBe(0);
    expect(host.marksLeft()).toEqual([
      join(host.etc, "broker-restart-pending"),
    ]);
    host.failDaemonReload(false);
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.restarts).toEqual([
      `alcove-broker.service image=${pinnedImage()} cert=certificate 1`,
    ]);
    expect(frontActions(result.calls)).toEqual([]);
    expect(host.marksLeft()).toEqual([]);
  });

  it("reloads the front on the run after one that died with its reload owed", () => {
    const host = fixtureHost();
    expect(host.run().status).toBe(0);
    host.startBroker();
    host.startFront();
    writeFileSync(host.conf, "# an earlier configuration\n");
    host.failDaemonReload(true);
    expect(host.run().status).not.toBe(0);
    expect(readFileSync(host.pending, "utf8")).toBe("reload\n");
    host.failDaemonReload(false);
    const result = host.run();
    expect(result.status, result.stderr).toBe(0);
    expect(frontActions(result.calls)).toEqual([
      "docker exec alcove-broker-tls nginx -s reload",
    ]);
    expect(host.marksLeft()).toEqual([]);
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
