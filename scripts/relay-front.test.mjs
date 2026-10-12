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

/** Renders the front for a host holding a registrar token only when asked. */
const render = (envLines, { registrarToken = false, realm = REALM } = {}) => {
  const root = fixtureDir();
  const envFile = join(root, "relay.env");
  writeFileSync(
    envFile,
    [`ALCOVE_RELAY_REALM=${realm}`, ...envLines, ""].join("\n"),
  );
  const tokenFile = join(root, "registrar-token");
  if (registrarToken) writeFileSync(tokenFile, "fixture-token\n");
  return spawnSync(BASH, [join(RELAY, "render-front.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      ALCOVE_RELAY_ENV_FILE: envFile,
      ALCOVE_RELAY_REGISTRAR_TOKEN_FILE: tokenFile,
    },
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
      ["ALCOVE_RELAY_REGISTRAR_NAME=registrar_x.example.org"],
      "not a lowercase DNS name",
    ],
    [
      ['ALCOVE_RELAY_FRONT_ROUTES="Signal.example.org=8443"'],
      "not a lowercase DNS name",
    ],
    ...["default", "include", "hostnames", "volatile"].map((keyword) => [
      [`ALCOVE_RELAY_FRONT_ROUTES="${keyword}=9000"`],
      `names '${keyword}', which nginx's map reads as a keyword`,
    ]),
    [
      ["ALCOVE_RELAY_REGISTRAR_NAME=Default"],
      "names 'default', which nginx's map reads as a keyword",
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
      ['ALCOVE_RELAY_FRONT_ROUTES="signal.example.org=0443"'],
      "not a port number",
    ],
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

  it.each([
    [
      "two listed routes",
      [
        'ALCOVE_RELAY_FRONT_ROUTES="signal.example.org=9500 ws.example.org=9500"',
      ],
      {},
      "ALCOVE_RELAY_FRONT_ROUTES routes ws.example.org to port 9500, which signal.example.org also uses",
    ],
    [
      "a listed route and the registrar's name",
      [
        "ALCOVE_RELAY_REGISTRAR_NAME=registrar.example.org",
        "ALCOVE_RELAY_REGISTRAR_PORT=8444",
        'ALCOVE_RELAY_FRONT_ROUTES="signal.example.org=8444"',
      ],
      {},
      "ALCOVE_RELAY_FRONT_ROUTES routes signal.example.org to port 8444, which registrar.example.org also uses",
    ],
    [
      "a listed route and the registrar's name on its unset port",
      [
        "ALCOVE_RELAY_REGISTRAR_NAME=registrar.example.org",
        'ALCOVE_RELAY_FRONT_ROUTES="signal.example.org=8443"',
      ],
      {},
      "ALCOVE_RELAY_FRONT_ROUTES routes signal.example.org to port 8443, which registrar.example.org also uses",
    ],
    [
      "a listed route and a registrar with no name on a host holding its token",
      ['ALCOVE_RELAY_FRONT_ROUTES="signal.example.org=8443"'],
      { registrarToken: true },
      "ALCOVE_RELAY_FRONT_ROUTES routes signal.example.org to port 8443, which the registrar (ALCOVE_RELAY_REGISTRAR_PORT) also uses",
    ],
  ])("refuses one port for %s", (_, envLines, options, message) => {
    const result = render(envLines, options);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stdout).toBe("");
  });

  // nginx's map matches a server name whatever its case.
  it.each([
    [
      "a listed route",
      [`ALCOVE_RELAY_FRONT_ROUTES="${REALM}=8443"`],
      "ALCOVE_RELAY_FRONT_ROUTES routes the realm",
    ],
    [
      "the registrar's name",
      ["ALCOVE_RELAY_REGISTRAR_NAME=RELAY.example.org"],
      "ALCOVE_RELAY_REGISTRAR_NAME routes the realm",
    ],
  ])("refuses %s for a realm written with capitals", (_, envLines, message) => {
    const result = render(envLines, { realm: "Relay.Example.ORG" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stdout).toBe("");
  });

  it("lowercases a registrar's name given with capitals before it compares or writes it", () => {
    const result = render([
      "ALCOVE_RELAY_REGISTRAR_NAME=Registrar.Example.org",
      "ALCOVE_RELAY_REGISTRAR_PORT=8444",
      'ALCOVE_RELAY_FRONT_ROUTES="registrar.example.org=9000"',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "routes registrar.example.org, which another route already claims",
    );
    const alone = render([
      "ALCOVE_RELAY_REGISTRAR_NAME=Registrar.Example.org",
      "ALCOVE_RELAY_REGISTRAR_PORT=8444",
    ]);
    expect(alone.status, alone.stderr).toBe(0);
    expect(mapEntries(alone.stdout)).toContainEqual([
      "registrar.example.org",
      "127.0.0.1:8444",
    ]);
  });

  it("routes to the registrar's unset port on a host with no registrar token", () => {
    const result = render([
      'ALCOVE_RELAY_FRONT_ROUTES="signal.example.org=8443"',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(mapEntries(result.stdout)).toContainEqual([
      "signal.example.org",
      "127.0.0.1:8443",
    ]);
  });

  it("accepts the shipped example's registrar port beside the broker's route", () => {
    const example = read("relay.env.example");
    const port = example.match(/^ALCOVE_RELAY_REGISTRAR_PORT=(\d+)$/m)[1];
    const result = render(
      [
        "ALCOVE_RELAY_REGISTRAR_NAME=registrar.example.org",
        `ALCOVE_RELAY_REGISTRAR_PORT=${port}`,
        'ALCOVE_RELAY_FRONT_ROUTES="signal.example.org=8443"',
      ],
      { registrarToken: true },
    );
    expect(result.status, result.stderr).toBe(0);
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

  it("drop every capability but the three nginx needs to bind 443 and start its worker", () => {
    const listed = (text, pattern) =>
      [...text.matchAll(pattern)].flatMap((match) => match[1].split(/\s+/));
    const kept = ["NET_BIND_SERVICE", "SETGID", "SETUID"];
    expect(listed(docker, /--cap-drop (\S+)/g)).toEqual(["ALL"]);
    expect(listed(quadlet, /^DropCapability=(.+)$/gm)).toEqual(["ALL"]);
    expect(listed(docker, /--cap-add (\S+)/g).sort()).toEqual(kept);
    expect(listed(quadlet, /^AddCapability=(.+)$/gm).sort()).toEqual(kept);
  });
});

describe("install.sh and the front", () => {
  const install = read("install.sh");

  it("installs the renderer and the template beside the other scripts", () => {
    expect(install).toContain('"$HERE/render-front.sh" "$LIBEXEC/"');
    expect(install).toContain('"$HERE/front.conf.tmpl"');
  });

  it("checks the routes before it installs or restarts anything", () => {
    const check = install.indexOf('"$HERE/render-front.sh" > /dev/null');
    expect(check).toBeGreaterThan(0);
    for (const change of [
      "dnf -y install",
      "record_env_value ALCOVE_RELAY_RUNTIME",
      "systemctl enable",
      "install -d ",
      " build ",
      "systemctl restart ",
    ]) {
      const first = install.indexOf(change);
      expect(first, change).toBeGreaterThan(check);
    }
  });

  it("checks the rendered configuration with nginx -t before it goes live", () => {
    const check = install.indexOf('--entrypoint nginx "$FRONT_IMAGE" -t');
    const live = install.indexOf('mv "$FRONT_CANDIDATE" "$FRONT_CONF"');
    expect(check).toBeGreaterThan(0);
    expect(live).toBeGreaterThan(check);
  });

  // turnserver.conf moves coturn onto loopback, so a front that fails after it
  // leaves nothing on 443 once coturn restarts.
  it("builds and checks the front before it changes anything coturn runs from", () => {
    const build = install.indexOf(
      'podman build --pull=newer -t "$FRONT_IMAGE" "$HERE/front"',
    );
    const render = install.indexOf(
      '"$HERE/render-front.sh" > "$FRONT_CANDIDATE"',
    );
    const check = install.indexOf('--entrypoint nginx "$FRONT_IMAGE" -t');
    expect(build).toBeGreaterThan(0);
    expect(render).toBeGreaterThan(build);
    expect(check).toBeGreaterThan(render);
    expect(install).not.toContain('"$LIBEXEC/render-front.sh"');
    for (const change of [
      'install -d -m 755 "$LIBEXEC"',
      'install -m 755 "$HERE/render-config.sh"',
      '"$HERE/turnserver.conf.tmpl"',
      '"$LIBEXEC/render-config.sh"',
      'install -m 644 "$HERE/$service.container"',
      "systemctl restart ",
    ]) {
      const first = install.indexOf(change);
      expect(first, change).toBeGreaterThan(check);
    }
    const buildRefused = install.indexOf(
      "esac \\\n  || die \"the front's image did not build;",
      build,
    );
    expect(buildRefused).toBeGreaterThan(build);
    expect(buildRefused).toBeLessThan(render);
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
