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
// refusals, the template's TURN server, logging and agreement with coturn's
// listener, coturn's listeners, the two front units, install.sh's order, and
// renew.sh's names. No nginx, coturn or ACME client runs here; what the front
// does with a real client is the host run's to measure
// (infra/relay/README.md, The 443 front).

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

/**
 * The entries of the map setting `variable` in a rendered configuration, as
 * [name, target] pairs: `$alcove_hop`, the server on 443's, or
 * `$alcove_route`, the route hop's.
 */
const mapEntries = (rendered, variable) => {
  const start = rendered.indexOf(`map $ssl_preread_server_name ${variable} {`);
  expect(start, variable).toBeGreaterThanOrEqual(0);
  const map = rendered.slice(start, rendered.indexOf("}", start));
  return settings(map)
    .slice(1)
    .map((line) => line.replace(/;$/, "").split(/\s+/));
};
const hopEntries = (rendered) => mapEntries(rendered, "$alcove_hop");
const routeEntries = (rendered) => mapEntries(rendered, "$alcove_route");

// render-front.sh's ports: the front's TURN server, its route hop, its
// WebSocket relay server, and coturn's tcp-proxy-port.
const portOf = (name) =>
  new RegExp(`^${name}=(\\d+)$`, "m").exec(read("render-front.sh"))[1];
const TURN = `127.0.0.1:${portOf("TURN_PORT")}`;
const HOP = `127.0.0.1:${portOf("HOP_PORT")}`;
const WEBSOCKET_TLS = `127.0.0.1:${portOf("WEBSOCKET_TLS_PORT")}`;

// The front's bound on the WebSocket relay sockets of one client address,
// keyed on the address set_real_ip_from takes from the PROXY header.
const WEBSOCKET_ZONE =
  "limit_conn_zone $binary_remote_addr zone=alcove_websocket_relay:1m;";
const WEBSOCKET_LIMIT = "limit_conn alcove_websocket_relay 8;";

/** A configuration's server blocks, each as its setting lines. */
const renderedServerBlocks = (text) =>
  text
    .split(/^ {2}server \{$/m)
    .slice(1)
    .map((block) => settings(block.slice(0, block.indexOf("\n  }"))));

describe("render-front.sh", () => {
  it("sends every connection to the TURN server when the host routes no name", () => {
    const result = render([]);
    expect(result.status, result.stderr).toBe(0);
    expect(hopEntries(result.stdout)).toEqual([["default", TURN]]);
    expect(routeEntries(result.stdout)).toEqual([["default", TURN]]);
    expect(result.stdout).not.toContain("__ROUTES__");
    expect(result.stdout).not.toContain("__ROUTE_HOPS__");
    expect(result.stdout).not.toContain("__REGISTRAR_ROUTE__");
    expect(result.stdout).not.toContain("__WEBSOCKET");
    expect(renderedServerBlocks(result.stdout)).toHaveLength(3);
    expect(
      settings(result.stdout).some((line) => line.includes(WEBSOCKET_TLS)),
    ).toBe(false);
    expect(
      settings(result.stdout).some((line) => line.startsWith("limit_conn")),
    ).toBe(false);
  });

  it("routes the WebSocket relay's name to the front's WebSocket relay server, which passes it to the relay's port", () => {
    const result = render([
      "ALCOVE_RELAY_WEBSOCKET_NAME=WSrelay.example.org.",
      "ALCOVE_RELAY_WEBSOCKET_PORT=9600",
      'ALCOVE_RELAY_FRONT_ROUTES="signal.example.org=8443"',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(hopEntries(result.stdout)).toEqual([
      ["default", TURN],
      ["wsrelay.example.org", WEBSOCKET_TLS],
      ["signal.example.org", HOP],
    ]);
    expect(routeEntries(result.stdout)).toEqual([
      ["default", TURN],
      ["signal.example.org", "127.0.0.1:8443"],
    ]);
    const servers = renderedServerBlocks(result.stdout);
    expect(servers).toHaveLength(4);
    expect(servers[3]).toContain(`listen ${WEBSOCKET_TLS} ssl proxy_protocol;`);
    expect(servers[3]).toContain("proxy_pass 127.0.0.1:9600;");
    expect(servers[3]).toContain(WEBSOCKET_LIMIT);
    expect(
      settings(result.stdout).filter((line) =>
        line.startsWith("limit_conn_zone "),
      ),
    ).toEqual([WEBSOCKET_ZONE]);
    expect(result.stdout).not.toContain("__WEBSOCKET");
  });

  it("passes the WebSocket relay's connections to 8446 when its port is unset", () => {
    const result = render(["ALCOVE_RELAY_WEBSOCKET_NAME=wsrelay.example.org"]);
    expect(result.status, result.stderr).toBe(0);
    expect(renderedServerBlocks(result.stdout)[3]).toContain(
      "proxy_pass 127.0.0.1:8446;",
    );
  });

  it.each([
    [
      [`ALCOVE_RELAY_WEBSOCKET_NAME=${REALM}`],
      "ALCOVE_RELAY_WEBSOCKET_NAME routes the realm",
    ],
    [
      [
        "ALCOVE_RELAY_REGISTRAR_NAME=registrar.example.org",
        "ALCOVE_RELAY_WEBSOCKET_NAME=registrar.example.org",
      ],
      "ALCOVE_RELAY_WEBSOCKET_NAME routes registrar.example.org, which another route already claims",
    ],
    [
      [
        "ALCOVE_RELAY_WEBSOCKET_NAME=wsrelay.example.org",
        'ALCOVE_RELAY_FRONT_ROUTES="wsrelay.example.org=9000"',
      ],
      "ALCOVE_RELAY_FRONT_ROUTES routes wsrelay.example.org, which another route already claims",
    ],
    [
      ["ALCOVE_RELAY_WEBSOCKET_NAME=ws_relay.example.org"],
      "not a lowercase DNS name",
    ],
    [
      [
        "ALCOVE_RELAY_WEBSOCKET_NAME=wsrelay.example.org",
        "ALCOVE_RELAY_WEBSOCKET_PORT=x",
      ],
      "ALCOVE_RELAY_WEBSOCKET_NAME routes wsrelay.example.org to 'x', which is not a port number",
    ],
    [
      [
        "ALCOVE_RELAY_WEBSOCKET_NAME=wsrelay.example.org",
        "ALCOVE_RELAY_WEBSOCKET_PORT=8443",
        'ALCOVE_RELAY_FRONT_ROUTES="signal.example.org=8443"',
      ],
      "ALCOVE_RELAY_FRONT_ROUTES routes signal.example.org to port 8443, which wsrelay.example.org also uses",
    ],
    [
      [
        "ALCOVE_RELAY_WEBSOCKET_NAME=wsrelay.example.org",
        "ALCOVE_RELAY_WEBSOCKET_PORT=5351",
      ],
      "ALCOVE_RELAY_WEBSOCKET_NAME routes wsrelay.example.org to port 5351, which the front's WebSocket relay server also uses",
    ],
    [
      [
        "ALCOVE_RELAY_WEBSOCKET_NAME=wsrelay.example.org",
        'ALCOVE_RELAY_FRONT_ROUTES="signal.example.org=5351"',
      ],
      "ALCOVE_RELAY_FRONT_ROUTES routes signal.example.org to port 5351, which the front's WebSocket relay server also uses",
    ],
  ])("refuses the WebSocket relay's route %j", (envLines, message) => {
    const result = render(envLines);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stdout).toBe("");
  });

  it("leaves the front's WebSocket relay server's port to a route where the host names no relay", () => {
    const result = render([
      'ALCOVE_RELAY_FRONT_ROUTES="signal.example.org=5351"',
    ]);
    expect(result.status, result.stderr).toBe(0);
  });

  it("routes the registrar's name to its front port from 443 and each listed name through the route hop to its own", () => {
    const result = render([
      "ALCOVE_RELAY_REGISTRAR_NAME=registrar.example.org",
      "ALCOVE_RELAY_REGISTRAR_PORT=8444",
      "ALCOVE_RELAY_REGISTRAR_FRONT_PORT=8446",
      'ALCOVE_RELAY_FRONT_ROUTES="signal.example.org=8443  ws.example.org=9500"',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(hopEntries(result.stdout)).toEqual([
      ["default", TURN],
      ["registrar.example.org", "127.0.0.1:8446"],
      ["signal.example.org", HOP],
      ["ws.example.org", HOP],
    ]);
    expect(routeEntries(result.stdout)).toEqual([
      ["default", TURN],
      ["signal.example.org", "127.0.0.1:8443"],
      ["ws.example.org", "127.0.0.1:9500"],
    ]);
  });

  it("routes the registrar's name to 8445 when its front port is unset", () => {
    const result = render([
      "ALCOVE_RELAY_REGISTRAR_NAME=registrar.example.org",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(hopEntries(result.stdout)).toContainEqual([
      "registrar.example.org",
      "127.0.0.1:8445",
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
      "a listed route and the registrar's port on a host naming the registrar",
      [
        "ALCOVE_RELAY_REGISTRAR_NAME=registrar.example.org",
        "ALCOVE_RELAY_REGISTRAR_PORT=8444",
        'ALCOVE_RELAY_FRONT_ROUTES="signal.example.org=8444"',
      ],
      {},
      "ALCOVE_RELAY_FRONT_ROUTES routes signal.example.org to port 8444, which the registrar (ALCOVE_RELAY_REGISTRAR_PORT) also uses",
    ],
    [
      "a listed route and the registrar's unset port on a host naming the registrar",
      [
        "ALCOVE_RELAY_REGISTRAR_NAME=registrar.example.org",
        'ALCOVE_RELAY_FRONT_ROUTES="signal.example.org=8443"',
      ],
      {},
      "ALCOVE_RELAY_FRONT_ROUTES routes signal.example.org to port 8443, which the registrar (ALCOVE_RELAY_REGISTRAR_PORT) also uses",
    ],
    [
      "a listed route and the registrar's unset front port",
      [
        "ALCOVE_RELAY_REGISTRAR_NAME=registrar.example.org",
        "ALCOVE_RELAY_REGISTRAR_PORT=8444",
        'ALCOVE_RELAY_FRONT_ROUTES="signal.example.org=8445"',
      ],
      {},
      "ALCOVE_RELAY_FRONT_ROUTES routes signal.example.org to port 8445, which registrar.example.org also uses",
    ],
    [
      "the registrar's port and its front port",
      [
        "ALCOVE_RELAY_REGISTRAR_NAME=registrar.example.org",
        "ALCOVE_RELAY_REGISTRAR_PORT=8444",
        "ALCOVE_RELAY_REGISTRAR_FRONT_PORT=8444",
      ],
      {},
      "ALCOVE_RELAY_REGISTRAR_FRONT_PORT is 8444, the registrar's own port (ALCOVE_RELAY_REGISTRAR_PORT); give it another",
    ],
    [
      "a listed route and the front's route hop",
      ['ALCOVE_RELAY_FRONT_ROUTES="signal.example.org=5348"'],
      {},
      "ALCOVE_RELAY_FRONT_ROUTES routes signal.example.org to port 5348, which the front's route hop also uses",
    ],
    [
      "a listed route and the front's TURN server",
      ['ALCOVE_RELAY_FRONT_ROUTES="signal.example.org=5347"'],
      {},
      "ALCOVE_RELAY_FRONT_ROUTES routes signal.example.org to port 5347, which the front's TURN server also uses",
    ],
    [
      "the registrar's front port and coturn's port",
      [
        "ALCOVE_RELAY_REGISTRAR_NAME=registrar.example.org",
        "ALCOVE_RELAY_REGISTRAR_FRONT_PORT=5350",
      ],
      {},
      "ALCOVE_RELAY_REGISTRAR_NAME routes registrar.example.org to port 5350, which coturn also uses",
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

  it.each([
    [
      "a listed route",
      [`ALCOVE_RELAY_FRONT_ROUTES="${REALM}=8443"`],
      "ALCOVE_RELAY_FRONT_ROUTES routes the realm",
    ],
    [
      "a listed route written with a trailing dot",
      [`ALCOVE_RELAY_FRONT_ROUTES="${REALM}.=8443"`],
      "ALCOVE_RELAY_FRONT_ROUTES routes the realm",
    ],
    [
      "the registrar's name",
      [`ALCOVE_RELAY_REGISTRAR_NAME=${REALM}`],
      "ALCOVE_RELAY_REGISTRAR_NAME routes the realm",
    ],
    [
      "the registrar's name written with a trailing dot",
      [`ALCOVE_RELAY_REGISTRAR_NAME=${REALM}.`],
      "ALCOVE_RELAY_REGISTRAR_NAME routes the realm",
    ],
  ])(
    "refuses %s for a realm written with a trailing dot",
    (_, envLines, message) => {
      const result = render(envLines, { realm: `${REALM}.` });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
      expect(result.stdout).toBe("");
    },
  );

  it("writes a route given with a trailing dot without it", () => {
    const result = render([
      'ALCOVE_RELAY_FRONT_ROUTES="signal.example.org.=8443"',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(routeEntries(result.stdout)).toContainEqual([
      "signal.example.org",
      "127.0.0.1:8443",
    ]);
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
    expect(hopEntries(alone.stdout)).toContainEqual([
      "registrar.example.org",
      "127.0.0.1:8445",
    ]);
  });

  it("routes to the registrar's unset port on a host with no registrar token", () => {
    const result = render([
      'ALCOVE_RELAY_FRONT_ROUTES="signal.example.org=8443"',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(routeEntries(result.stdout)).toContainEqual([
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

/** The template's server blocks, each as its setting lines. */
const serverBlocks = () => renderedServerBlocks(read("front.conf.tmpl"));

/** coturn's settings, from the template render-config.sh fills in. */
const coturnSettings = () => settings(read("turnserver.conf.tmpl"));
const coturnProxyPort = () =>
  coturnSettings()
    .find((line) => line.startsWith("tcp-proxy-port="))
    .split("=")[1];

describe("front.conf.tmpl", () => {
  const template = settings(read("front.conf.tmpl"));

  it("has four servers: 443, the TURN server, the route hop and the WebSocket relay server", () => {
    const servers = serverBlocks();
    expect(servers).toHaveLength(4);
    expect(servers[0]).toContain("listen 443;");
    expect(servers[1]).toContain(`listen ${TURN} ssl proxy_protocol;`);
    expect(servers[2]).toContain(`listen ${HOP} proxy_protocol;`);
    expect(servers[3]).toContain(`listen ${WEBSOCKET_TLS} ssl proxy_protocol;`);
    expect(template.some((line) => /^http\b/.test(line))).toBe(false);
  });

  it("writes the WebSocket relay server alone between the lines render-front.sh drops it by", () => {
    const text = read("front.conf.tmpl");
    const begin = text.indexOf("\n  # __WEBSOCKET_SERVER_BEGIN__\n");
    const end = text.indexOf("\n  # __WEBSOCKET_SERVER_END__\n");
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    const between = renderedServerBlocks(text.slice(begin, end));
    expect(between).toEqual([serverBlocks()[3]]);
  });

  // The relay is a Node HTTP server that reads no PROXY header; one ahead of
  // the upgrade is answered 400, so its server takes the header from 443 and
  // sends none on.
  it("terminates the WebSocket relay's TLS as TURN's and sends the relay no PROXY header", () => {
    const [, turn, , websocket] = serverBlocks();
    const tlsSettings = (server) =>
      server.filter((line) =>
        /^(ssl_|set_real_ip_from|proxy_connect_timeout)/.test(line),
      );
    expect(tlsSettings(websocket)).toEqual(tlsSettings(turn));
    expect(websocket.some((line) => line.startsWith("proxy_protocol "))).toBe(
      false,
    );
    expect(websocket).toContain("proxy_pass 127.0.0.1:__WEBSOCKET_PORT__;");
  });

  // The relay counts nothing by client address (docs/spec/WEBSOCKET_RELAY.md,
  // The endpoint), so the front bounds it. $binary_remote_addr is the address
  // set_real_ip_from in the same server takes from the header from 443;
  // verify.sh's per-address probe is what shows it applies on the host.
  it("holds 8 WebSocket relay connections from each client address, keyed on the address the PROXY header names", () => {
    const servers = serverBlocks();
    const websocket = servers[3];
    expect(websocket).toContain("set_real_ip_from 127.0.0.1;");
    expect(websocket.filter((line) => line.startsWith("limit_conn"))).toEqual([
      WEBSOCKET_LIMIT,
    ]);
    for (const server of servers.slice(0, 3)) {
      expect(server.some((line) => line.startsWith("limit_conn"))).toBe(false);
    }
    const text = read("front.conf.tmpl");
    expect(
      settings(text).filter((line) => line.startsWith("limit_conn_zone ")),
    ).toEqual([WEBSOCKET_ZONE]);
    const begin = text.indexOf("\n  # __WEBSOCKET_SERVER_BEGIN__\n");
    const end = text.indexOf("\n  # __WEBSOCKET_SERVER_END__\n");
    expect(settings(text.slice(begin, end))).toContain(WEBSOCKET_ZONE);
    const probeLimit = /^SOCKETS_PER_ADDRESS = (\d+)$/m.exec(
      read("websocket-address-limit.py"),
    )[1];
    expect(WEBSOCKET_LIMIT).toBe(
      `limit_conn alcove_websocket_relay ${probeLimit};`,
    );
  });

  it("reads the server name on 443 and terminates no TLS there or at the route hop", () => {
    const [first, , hop] = serverBlocks();
    for (const server of [first, hop]) {
      expect(server).toContain("ssl_preread on;");
      expect(
        server.some((line) => /^ssl_(certificate|protocols)\b/.test(line)),
      ).toBe(false);
      const listen = server.find((line) => line.startsWith("listen "));
      expect(listen.split(/[\s;]+/)).not.toContain("ssl");
    }
  });

  // nginx sends a PROXY header for a whole server block or not at all, so the
  // server on 443 sends it on every connection, and the registrar's front
  // port, the TURN server and the route hop, each on loopback, read it.
  it("sends the PROXY header from 443, and the route hop drops it", () => {
    const [first, , hop] = serverBlocks();
    expect(first).toContain("proxy_protocol on;");
    expect(first).toContain("proxy_pass $alcove_hop;");
    expect(hop).toContain("proxy_pass $alcove_route;");
    expect(hop.some((line) => line.startsWith("proxy_protocol "))).toBe(false);
  });

  it("terminates TURN's TLS under the relay's certificate, TLS 1.2 and 1.3 only", () => {
    const turn = serverBlocks()[1];
    expect(turn).toContain("ssl_certificate /etc/nginx/certs/fullchain.pem;");
    expect(turn).toContain("ssl_certificate_key /etc/nginx/certs/privkey.pem;");
    expect(turn).toContain("ssl_protocols TLSv1.2 TLSv1.3;");
    const ciphers = turn
      .find((line) => line.startsWith("ssl_ciphers "))
      .replace(/^ssl_ciphers /, "")
      .replace(/;$/, "")
      .split(":");
    expect(ciphers.length).toBeGreaterThan(0);
    for (const cipher of ciphers) {
      expect(cipher).toMatch(
        /^ECDHE-(ECDSA|RSA)-(AES(128|256)-GCM-SHA(256|384)|CHACHA20-POLY1305)$/,
      );
    }
    expect(turn).toContain("ssl_handshake_timeout 10s;");
  });

  // The certificate the units mount at /etc/nginx/certs is the directory
  // certs/deploy-hook.sh writes fullchain.pem and privkey.pem into.
  it("reads the certificate from the directory the units mount and the deploy hook writes", () => {
    const mount = "/etc/alcove-relay/certs:/etc/nginx/certs:ro";
    expect(read("alcove-relay-front-docker.service")).toContain(`-v ${mount}`);
    expect(read("alcove-relay-front.container")).toContain(`Volume=${mount}\n`);
    const hook = read("certs/deploy-hook.sh");
    expect(hook).toContain('DEST="${ALCOVE_RELAY_CERT_DIR:-$ETC/certs}"');
    expect(hook).toContain('"$DEST/fullchain.pem"');
    expect(hook).toContain('"$DEST/privkey.pem"');
  });

  // coturn reports the address the TURN server's header names, so that server
  // takes it from the header the server on 443 sent, and sends it on.
  it("passes the client's address from the header on 443 to coturn's proxy port", () => {
    const turn = serverBlocks()[1];
    expect(turn).toContain("set_real_ip_from 127.0.0.1;");
    expect(turn).toContain("proxy_protocol on;");
    expect(turn).toContain(`proxy_pass 127.0.0.1:${coturnProxyPort()};`);
    expect(portOf("COTURN_PORT")).toBe(coturnProxyPort());
  });

  it("bounds a connection's wait for its first bytes and its idle time at every server", () => {
    const [first, turn, hop, websocket] = serverBlocks();
    for (const server of [first, hop]) {
      expect(server).toContain("preread_timeout 10s;");
    }
    for (const server of [first, turn, hop, websocket]) {
      expect(server).toContain("proxy_connect_timeout 5s;");
    }
    for (const server of [first, turn, hop]) {
      expect(server).toContain("proxy_timeout 900s;");
    }
    expect(websocket).toContain("proxy_timeout 300s;");
  });

  // docs/spec/WEBSOCKET_RELAY.md, Keepalive: the relay's ping is a tenth of
  // the idle timeout of the front's WebSocket relay server.
  it("closes an idle WebSocket relay connection at ten of the relay's ping intervals", () => {
    const websocket = serverBlocks()[3];
    const idle = websocket.find((line) => line.startsWith("proxy_timeout "));
    const pingMs = Number(
      /^export const RELAY_PING_INTERVAL_MS = ([\d_]+);$/m
        .exec(
          readFileSync(
            resolve(here, "..", "packages/websocket-relay/src/protocol.ts"),
            "utf8",
          ),
        )[1]
        .replaceAll("_", ""),
    );
    expect(Number.parseInt(idle.split(/\s+/)[1], 10) * 1000).toBe(10 * pingMs);
  });

  it("runs one worker with a bounded number of connections", () => {
    expect(template).toContain("worker_processes 1;");
    const events = template.find((line) => line.startsWith("events "));
    const connections = Number(/worker_connections (\d+);/.exec(events)[1]);
    const totalQuota = Number(
      /^ALCOVE_RELAY_TOTAL_QUOTA=(\d+)$/m.exec(read("relay.env.example"))[1],
    );
    const brokerConnections = Number(
      /worker_connections (\d+);/.exec(read("../broker/nginx.conf.tmpl"))[1],
    );
    // Four connections for each TURN or routed-service client, room for every
    // allocation the total quota admits, and room for every WebSocket client
    // the broker's front admits at two connections each.
    expect(connections / 4).toBeGreaterThanOrEqual(totalQuota);
    expect(connections / 4).toBeGreaterThanOrEqual(brokerConnections / 2);
    expect(connections).toBeLessThanOrEqual(1024);
  });

  it("keeps an idle connection longer than coturn's allocation lifetime", () => {
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

describe("turnserver.conf.tmpl's listeners", () => {
  // The front holds 443 on every address; coturn listens on loopback alone,
  // on its proxy port, with plain TCP enabled for that port and no TLS
  // listener or key of its own.
  it("listens on loopback only, on the proxy port, with no TLS listener", () => {
    const coturn = coturnSettings();
    expect(coturn.filter((line) => line.startsWith("listening-ip="))).toEqual([
      "listening-ip=127.0.0.1",
    ]);
    expect(coturnProxyPort()).toMatch(/^\d+$/);
    const names = coturn.map((line) => line.split("=")[0]);
    for (const absent of [
      "no-tcp",
      "tls-listening-port",
      "alt-tls-listening-port",
      "listening-port",
      "alt-listening-port",
      "cert",
      "pkey",
    ]) {
      expect(names, absent).not.toContain(absent);
    }
  });

  it("keeps UDP listeners off and every peer restriction", () => {
    const coturn = coturnSettings();
    for (const kept of ["no-udp", "no-tcp-relay", "no-multicast-peers"]) {
      expect(coturn).toContain(kept);
    }
    for (const range of [
      "denied-peer-ip=10.0.0.0-10.255.255.255",
      "denied-peer-ip=127.0.0.0-127.255.255.255",
      "denied-peer-ip=169.254.0.0-169.254.255.255",
      "denied-peer-ip=::1",
    ]) {
      expect(coturn).toContain(range);
    }
  });

  it("mounts no certificate into coturn's container", () => {
    for (const unit of [
      "alcove-relay-docker.service",
      "alcove-relay.container",
    ]) {
      expect(read(unit)).not.toContain("/etc/alcove-relay/certs");
    }
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
      [
        "-v /etc/alcove-relay/certs:/etc/nginx/certs:ro",
        "Volume=/etc/alcove-relay/certs:/etc/nginx/certs:ro",
      ],
    ];
    for (const [flag, directive] of flags) {
      expect(docker).toContain(flag);
      expect(quadlet).toContain(`${directive}\n`);
    }
    expect(docker.match(/ -v /g)).toHaveLength(2);
    expect(quadlet.match(/^Volume=/gm)).toHaveLength(2);
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

  // nginx -t loads the TURN server's certificate, which a first install has
  // not obtained yet.
  it("checks it against the relay's certificate, or a throwaway one where there is none yet", () => {
    const check = install.indexOf('--entrypoint nginx "$FRONT_IMAGE" -t');
    const mount = install.indexOf(
      '-v "$FRONT_CHECK_CERTS:/etc/nginx/certs:ro"',
    );
    expect(mount).toBeGreaterThan(0);
    expect(mount).toBeLessThan(check);
    expect(install).toContain('FRONT_CHECK_CERTS="$ETC/certs"');
    expect(install).toContain('FRONT_CHECK_CERTS="$THROWAWAY_CERTS"');
    const openssl = install.indexOf("command -v openssl");
    expect(openssl).toBeGreaterThan(0);
    expect(openssl).toBeLessThan(
      install.indexOf('THROWAWAY_CERTS="$(mktemp -d)"'),
    );
  });

  it("gives root the certificate it finds, which the front reads the key as", () => {
    expect(install).toContain(
      'chown 0:0 "$ETC/certs" "$ETC/certs/fullchain.pem" "$ETC/certs/privkey.pem"',
    );
    expect(install).not.toMatch(/chown "\$IMAGE_UID" "\$ETC\/certs/);
  });

  it("installs the client-address probe verify.sh runs", () => {
    expect(install).toContain('"$HERE/stun-binding.py"');
    expect(read("verify.sh")).toContain('"$HERE/stun-binding.py"');
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

  it("asks for the WebSocket relay's name beside the realm and the registrar's", () => {
    const { result, argv } = renew([
      "ALCOVE_RELAY_REGISTRAR_NAME=registrar.example.org",
      "ALCOVE_RELAY_WEBSOCKET_NAME=wsrelay.example.org",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(argv).toContain(
      `--domains ${REALM} --domains registrar.example.org --domains wsrelay.example.org --path`,
    );
    const alone = renew(["ALCOVE_RELAY_WEBSOCKET_NAME=wsrelay.example.org"]);
    expect(alone.argv).toContain(
      `--domains ${REALM} --domains wsrelay.example.org --path`,
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
