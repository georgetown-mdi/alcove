import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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

// The relay host's 443 front (infra/relay): render-front.sh's routes and
// refusals, the template's logging and its agreement with coturn's listener,
// the two front units, install.sh's order, and renew.sh's names. No nginx,
// coturn or ACME client runs here; what the front does with a real client is
// the host run's to measure (infra/relay/README.md, The 443 front).

const here = dirname(fileURLToPath(import.meta.url));
const RELAY = resolve(here, "..", "infra/relay");
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";
const REALM = "relay.example.org";

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

const fixtureDir = () => {
  const root = mkdtempSync(join(tmpdir(), "relay-front-"));
  tmpDirs.push(root);
  return root;
};

const read = (name) => readFileSync(join(RELAY, name), "utf8");

/** Lines that are not comments or blank. */
const settings = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

const render = (envLines) => {
  const root = fixtureDir();
  const envFile = join(root, "relay.env");
  writeFileSync(
    envFile,
    [`ALCOVE_RELAY_REALM=${REALM}`, ...envLines, ""].join("\n"),
  );
  return spawnSync(BASH, [join(RELAY, "render-front.sh")], {
    encoding: "utf8",
    env: { ...process.env, ALCOVE_RELAY_ENV_FILE: envFile },
  });
};

/** The map's entries in a rendered configuration, as [name, target] pairs. */
const mapEntries = (rendered) => {
  const map = rendered.slice(
    rendered.indexOf("map $ssl_preread_server_name"),
    rendered.indexOf("}", rendered.indexOf("map $ssl_preread_server_name")),
  );
  return settings(map)
    .slice(1)
    .map((line) => line.replace(/;$/, "").split(/\s+/));
};

describe("render-front.sh", () => {
  it("sends every connection to coturn when the host routes no name", () => {
    const result = render([]);
    expect(result.status, result.stderr).toBe(0);
    expect(mapEntries(result.stdout)).toEqual([["default", "127.0.0.1:5349"]]);
    expect(result.stdout).not.toContain("__ROUTES__");
  });

  it("routes the registrar's name to its port and each listed name to its own", () => {
    const result = render([
      "ALCOVE_RELAY_REGISTRAR_NAME=registrar.example.org",
      "ALCOVE_RELAY_REGISTRAR_PORT=8444",
      'ALCOVE_RELAY_FRONT_ROUTES="signal.example.org=8443  ws.example.org=9500"',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(mapEntries(result.stdout)).toEqual([
      ["default", "127.0.0.1:5349"],
      ["registrar.example.org", "127.0.0.1:8444"],
      ["signal.example.org", "127.0.0.1:8443"],
      ["ws.example.org", "127.0.0.1:9500"],
    ]);
  });

  it("routes the registrar's name to 8443 when its port is unset", () => {
    const result = render([
      "ALCOVE_RELAY_REGISTRAR_NAME=registrar.example.org",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(mapEntries(result.stdout)).toContainEqual([
      "registrar.example.org",
      "127.0.0.1:8443",
    ]);
  });

  it.each([
    [
      ["ALCOVE_RELAY_REGISTRAR_NAME=Registrar.example.org"],
      "not a lowercase DNS name",
    ],
    [['ALCOVE_RELAY_FRONT_ROUTES="bad;name=8443"'], "not a lowercase DNS name"],
    [[`ALCOVE_RELAY_REGISTRAR_NAME=${REALM}`], "the realm's name is coturn's"],
    [
      [`ALCOVE_RELAY_FRONT_ROUTES="${REALM}=8443"`],
      "the realm's name is coturn's",
    ],
    [
      [
        "ALCOVE_RELAY_REGISTRAR_NAME=registrar.example.org",
        'ALCOVE_RELAY_FRONT_ROUTES="registrar.example.org=9000"',
      ],
      "another route already claims",
    ],
    [['ALCOVE_RELAY_FRONT_ROUTES="signal.example.org=443"'], "the front's own"],
    [
      ['ALCOVE_RELAY_FRONT_ROUTES="signal.example.org=70000"'],
      "not a port number",
    ],
    [['ALCOVE_RELAY_FRONT_ROUTES="signal.example.org=0"'], "not a port number"],
    [
      ['ALCOVE_RELAY_FRONT_ROUTES="signal.example.org"'],
      "write each route as name=port",
    ],
    [['ALCOVE_RELAY_FRONT_ROUTES="*"'], "write each route as name=port"],
  ])("refuses %j", (envLines, message) => {
    const result = render(envLines);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stdout).toBe("");
  });

  it("refuses a host with no realm", () => {
    const root = fixtureDir();
    const envFile = join(root, "relay.env");
    writeFileSync(envFile, "ALCOVE_RELAY_REALM=\n");
    const result = spawnSync(BASH, [join(RELAY, "render-front.sh")], {
      encoding: "utf8",
      env: { ...process.env, ALCOVE_RELAY_ENV_FILE: envFile },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ALCOVE_RELAY_REALM is unset");
  });
});

describe("front.conf.tmpl", () => {
  const template = settings(read("front.conf.tmpl"));

  it("sends unrouted connections to the port and address coturn listens on", () => {
    const coturn = settings(read("turnserver.conf.tmpl"));
    const port = coturn
      .find((line) => line.startsWith("tls-listening-port="))
      .split("=")[1];
    expect(coturn).toContain("listening-ip=127.0.0.1");
    expect(coturn.filter((line) => line.startsWith("listening-ip="))).toEqual([
      "listening-ip=127.0.0.1",
    ]);
    expect(template).toContain(`default 127.0.0.1:${port};`);
  });

  it("listens on 443, reads the server name and opens no TLS", () => {
    expect(template).toContain("listen 443;");
    expect(template).toContain("ssl_preread on;");
    expect(
      template.some((line) =>
        /^ssl_(certificate|certificate_key)\b/.test(line),
      ),
    ).toBe(false);
    expect(template.some((line) => /^http\b/.test(line))).toBe(false);
  });

  it("bounds a connection's wait for its first bytes and its idle time", () => {
    expect(template).toContain("preread_timeout 10s;");
    expect(template).toContain("proxy_connect_timeout 5s;");
    const idle = template.find((line) => line.startsWith("proxy_timeout "));
    const lifetime = settings(read("turnserver.conf.tmpl"))
      .find((line) => line.startsWith("max-allocate-lifetime="))
      .split("=")[1];
    expect(Number.parseInt(idle.split(/\s+/)[1], 10)).toBeGreaterThan(
      Number(lifetime),
    );
  });

  // The front sees every client's address and the name it asked for; a log of
  // them would be a record of who used which service, which nothing here needs.
  it("writes no access log and keeps its error log at warnings and above", () => {
    expect(template.filter((line) => line.startsWith("access_log"))).toEqual([
      "access_log off;",
    ]);
    const errorLogs = template.filter((line) => line.startsWith("error_log"));
    expect(errorLogs).toEqual(["error_log /dev/stderr warn;"]);
  });
});

describe("the front's units", () => {
  const docker = read("alcove-relay-front-docker.service");
  const quadlet = read("alcove-relay-front.container");

  it("run the tag install.sh builds from front/Dockerfile, on either runtime", () => {
    const tag = "localhost/alcove-relay-front:installed";
    expect(docker).toContain(`  ${tag}\n`);
    expect(quadlet).toContain(`Image=${tag}\n`);
    expect(read("install.sh")).toContain(`FRONT_IMAGE=${tag}\n`);
    expect(read("front/Dockerfile")).toMatch(
      /^FROM docker\.io\/library\/nginx:[^@\s]+@sha256:[0-9a-f]{64}$/m,
    );
  });

  it("carry the same container flags", () => {
    const flags = [
      ["--network host", "Network=host"],
      ["--read-only", "ReadOnly=true"],
      ["--tmpfs /tmp", "Tmpfs=/tmp"],
      ["--log-driver journald", "LogDriver=journald"],
      [
        "-v /etc/alcove-relay/front.conf:/etc/nginx/nginx.conf:ro",
        "Volume=/etc/alcove-relay/front.conf:/etc/nginx/nginx.conf:ro",
      ],
    ];
    for (const [flag, directive] of flags) {
      expect(docker).toContain(flag);
      expect(quadlet).toContain(`${directive}\n`);
    }
    expect(docker.match(/ -v /g)).toHaveLength(1);
    expect(quadlet.match(/^Volume=/gm)).toHaveLength(1);
  });
});

describe("install.sh and the front", () => {
  const install = read("install.sh");

  it("installs the renderer and the template beside the other scripts", () => {
    expect(install).toContain('"$HERE/render-front.sh" "$LIBEXEC/"');
    expect(install).toContain('"$HERE/front.conf.tmpl"');
  });

  it("checks the rendered configuration with nginx -t before it goes live", () => {
    const check = install.indexOf('--entrypoint nginx "$FRONT_IMAGE" -t');
    const live = install.indexOf('mv "$FRONT_CANDIDATE" "$FRONT_CONF"');
    expect(check).toBeGreaterThan(0);
    expect(live).toBeGreaterThan(check);
  });

  it("restarts coturn off 443 before it starts the front on it", () => {
    const coturn = install.indexOf("systemctl restart alcove-relay.service");
    const front = install.indexOf(
      "systemctl restart alcove-relay-front.service",
    );
    expect(coturn).toBeGreaterThan(0);
    expect(front).toBeGreaterThan(coturn);
  });

  it("reads the private address verify.sh connects to from relay-ip", () => {
    expect(install).toContain("sed -n 's/^relay-ip=//p'");
    expect(settings(read("turnserver.conf.tmpl"))).toContain(
      "relay-ip=__RELAY_IP__",
    );
  });
});

describe("certs/renew.sh names", () => {
  // renew.sh copied beside a stub deploy hook, with a stub lego on PATH that
  // records its arguments and leaves the files a real run would.
  const renew = (envLines, extraEnv = {}) => {
    const root = fixtureDir();
    const certs = join(root, "certs");
    const bin = join(root, "bin");
    mkdirSync(certs);
    mkdirSync(bin);
    copyFileSync(join(RELAY, "certs/renew.sh"), join(certs, "renew.sh"));
    writeFileSync(join(certs, "deploy-hook.sh"), "#!/bin/bash\nexit 0\n");
    chmodSync(join(certs, "deploy-hook.sh"), 0o755);
    const argv = join(root, "lego-argv");
    writeFileSync(
      join(bin, "lego"),
      [
        "#!/bin/bash",
        `printf '%s\\n' "$*" > '${argv}'`,
        'while [ "$#" -gt 0 ]; do [ "$1" = --path ] && path="$2"; shift; done',
        `mkdir -p "$path/certificates"`,
        `echo crt > "$path/certificates/${REALM}.crt"`,
        `echo key > "$path/certificates/${REALM}.key"`,
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "lego"), 0o755);
    const envFile = join(root, "relay.env");
    writeFileSync(
      envFile,
      [`ALCOVE_RELAY_REALM=${REALM}`, ...envLines, ""].join("\n"),
    );
    const acmeEnv = join(root, "acme.env");
    writeFileSync(acmeEnv, "ALCOVE_RELAY_ACME_EMAIL=ops@example.org\n");
    const result = spawnSync(BASH, [join(certs, "renew.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ALCOVE_RELAY_ENV_FILE: envFile,
        ALCOVE_RELAY_ACME_ENV: acmeEnv,
        ALCOVE_RELAY_ACME_HOME: join(root, "acme"),
        ...extraEnv,
      },
    });
    return {
      result,
      argv: existsSync(argv) ? readFileSync(argv, "utf8").trim() : "",
    };
  };

  it("asks for the realm alone where the registrar has no name", () => {
    const { result, argv } = renew([]);
    expect(result.status, result.stderr).toBe(0);
    expect(argv).toContain(`--domains ${REALM} --path`);
    expect(argv).toContain("--renew-days 30");
  });

  it("asks for the registrar's name beside the realm, the realm first", () => {
    const { result, argv } = renew([
      "ALCOVE_RELAY_REGISTRAR_NAME=registrar.example.org",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(argv).toContain(
      `--domains ${REALM} --domains registrar.example.org --path`,
    );
  });

  it("widens the window to every day of the certificate's life when forced", () => {
    const { result, argv } = renew([], { ALCOVE_RELAY_RENEW_FORCE: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(argv).toContain("--renew-days 365");
  });

  it("refuses a force value other than 1 before it runs the client", () => {
    const { result, argv } = renew([], { ALCOVE_RELAY_RENEW_FORCE: "yes" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ALCOVE_RELAY_RENEW_FORCE is 'yes'");
    expect(argv).toBe("");
  });
});
