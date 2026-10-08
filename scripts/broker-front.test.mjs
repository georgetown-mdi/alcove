import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The broker's TLS front (infra/broker): the template's logging, the renderer,
// and renew.sh against a fixture host with `lego` and `systemctl` stubs on PATH.

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

describe("nginx.conf.tmpl logging", () => {
  it("logs only the documented fields, so no line contains the query string", () => {
    const formats = template().filter(({ name }) => name === "log_format");
    expect(formats.length).toBeGreaterThan(0);
    for (const { args } of formats) {
      const variables = [
        ...args
          .slice(1)
          .join("")
          .matchAll(/\$(\w+)/g),
      ].map((match) => match[1]);
      expect(variables.length).toBeGreaterThan(0);
      for (const variable of variables) {
        expect(ALLOWED_LOG_VARIABLES, `$${variable}`).toContain(variable);
      }
    }
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
      tls,
      startFront: () => writeFileSync(active, ""),
      renewTo: (next) => writeFileSync(serial, next),
      run: () => {
        writeFileSync(calls, "");
        const result = spawnSync(BASH, [join(BROKER, "renew.sh")], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            ALCOVE_BROKER_ENV_FILE: envFile,
            ALCOVE_BROKER_ACME_HOME: acmeHome,
            ALCOVE_BROKER_TLS_DIR: tls,
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
  });

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
