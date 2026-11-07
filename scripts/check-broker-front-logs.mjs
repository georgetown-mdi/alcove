#!/usr/bin/env node
// Drives each kind of failed request through the broker's TLS front and checks
// what its two logs write, for PRIVACY.md's TLS front bullets and
// infra/broker/README.md, Logging.
//
//   node scripts/check-broker-front-logs.mjs
//
// Needs docker, openssl and free ports 8443 and 9411 on the loopback, so it
// runs from broker_front_logs.yaml on a hosted runner. It renders
// infra/broker/nginx.conf.tmpl with render-config.sh, runs the image
// infra/broker/Dockerfile pins as alcove-broker-tls.service runs it (host
// network, read-only root, tmpfs /tmp, and the unit's capability flags read from
// it), and stands in for the broker on
// 127.0.0.1:9411. Each request sends its own Host, Referer, User-Agent and
// Origin values and query string, and the run prints, for each error-log and
// access-log line the request wrote, which of those values the line contains.
//
// After the cases it drives the front's two connection bounds. One address
// other than 127.0.0.1 opens more WebSocket upgrades than the front has room
// for, and must hold the template's per-address limit of them, each further
// one answered 503, while a second address still upgrades. Then 127.0.0.1,
// the address every connection through the relay front's 443 arrives from,
// holds upgrades until the front has no connection left, and the run prints
// the front's memory before and at that point.
//
// Before the cases it runs a positive control: the same template with its
// error_log level changed from emerg to warn, which must write an error-log
// line holding the refused case's query string, and one holding the exhaustion
// case's, so an unread error log or an exhaustion that was never reached fails
// the run.
//
// It exits 1 when the front does not start, the control fails, a request gets
// no response or no access-log line, any log line (including one after the last
// request) contains a request's query string, a request or the time after the
// last one writes an error-log line, a failure kind's access-log line does not
// show the fields README.md, Logging, says identify it, one address holds a
// number of upgrades other than the per-address limit, the second address is
// not upgraded, or 127.0.0.1's upgrades never run the front out of connections.

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { connect } from "node:tls";
import { fileURLToPath } from "node:url";

const BROKER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "infra/broker",
);
const BROKER_NAME = "broker.measure.example";
const CONTAINER = "alcove-broker-tls-measure";
const FRONT_PORT = 8443;
const UPSTREAM_PORT = 9411;
const SETTLE_MS = 1500;
// Over the template's proxy_read_timeout of 300 s, so the timed-out upstream
// request is answered by nginx and not cut off here.
const RESPONSE_DEADLINE_MS = 330_000;
// nginx's default client_body_buffer_size on x86-64, two 4 KiB memory pages: a
// request whose body is larger is buffered to a file under /tmp.
const CLIENT_BODY_BUFFER_BYTES = 8192;
// Each on the loopback, which Linux answers on all of 127.0.0.0/8.
const DIRECT_CLIENT = "127.0.0.2";
const SECOND_DIRECT_CLIENT = "127.0.0.3";
const ROUTE_HOP_CLIENT = "127.0.0.1";
const UPGRADE_ANSWER_MS = 3000;
// The exhaustion run stops after this many upgrades in a row are not upgraded.
const EXHAUSTED_AFTER = 3;

/** The header values a request sends, each with the marker that finds it in a log line. */
const FIELDS = [
  {
    label: "Host",
    header: "Host",
    value: (id) => `host-${id}.measure.example`,
    marker: (id) => `host-${id}.`,
  },
  {
    label: "Referer",
    header: "Referer",
    value: (id) => `https://referer-${id}.measure.example/page`,
    marker: (id) => `referer-${id}.`,
  },
  {
    label: "User-Agent",
    header: "User-Agent",
    value: (id) => `agent-${id}/1.0`,
    marker: (id) => `agent-${id}/`,
  },
  {
    label: "Origin",
    header: "Origin",
    value: (id) => `https://origin-${id}.measure.example`,
    marker: (id) => `origin-${id}.`,
  },
];
const queryMarker = (id) => `query-${id}`;

const headerLines = (id) =>
  FIELDS.map((field) => `${field.header}: ${field.value(id)}`);

const request = (
  id,
  { method = "GET", requestLine, extra = [], body = "" } = {},
) =>
  [
    requestLine ?? `${method} /api/peerjs?key=${queryMarker(id)} HTTP/1.1`,
    ...headerLines(id),
    ...extra,
    "",
    "",
  ].join("\r\n") + body;

const UPGRADE_HEADERS = [
  "Upgrade: websocket",
  "Connection: Upgrade",
  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
  "Sec-WebSocket-Version: 13",
];

const yesNo = (present) => (present ? "yes" : "no");

/** The access-log fields README.md, Logging, says tell one failure kind from another. */
const identity = (status, upstreamStatus, connected, bodyBuffered) =>
  `status=${status} upstream_status=${upstreamStatus} connected=${yesNo(connected)} body_buffered=${yesNo(bodyBuffered)}`;

/**
 * Each request, the upstream behavior it meets, and for a failure kind the
 * access-log identity that names it.
 */
const CASES = [
  {
    id: "refused",
    title: "WebSocket upgrade, upstream refuses the connection",
    identifiedBy: identity("502", "502", false, false),
    upstream: "none",
    bytes: request("refused", { extra: UPGRADE_HEADERS }),
  },
  {
    id: "closed",
    title: "GET, upstream closes before answering",
    identifiedBy: identity("502", "502", true, false),
    upstream: "close",
    bytes: request("closed", { extra: ["Connection: close"] }),
  },
  {
    id: "buffered",
    title: "POST with a 20000-byte body, upstream refuses the connection",
    identifiedBy: identity("502", "502", false, true),
    upstream: "none",
    bytes: request("buffered", {
      method: "POST",
      extra: ["Content-Length: 20000", "Connection: close"],
      body: "b".repeat(20000),
    }),
  },
  {
    id: "toolarge",
    title: "POST declaring a body over client_max_body_size",
    identifiedBy: identity("413", "-", false, false),
    upstream: "none",
    bytes: request("toolarge", {
      method: "POST",
      extra: ["Content-Length: 2000000", "Connection: close"],
    }),
  },
  {
    id: "badline",
    title: "malformed request line (invalid method)",
    upstream: "none",
    bytes: request("badline", {
      requestLine: `G@T /api/peerjs?key=${queryMarker("badline")} HTTP/1.1`,
      extra: ["Connection: close"],
    }),
  },
  {
    id: "badheader",
    title: "malformed headers (Content-Length with Transfer-Encoding)",
    upstream: "none",
    bytes: request("badheader", {
      method: "POST",
      extra: [
        "Content-Length: 4",
        "Transfer-Encoding: chunked",
        "Connection: close",
      ],
      body: "0\r\n\r\n",
    }),
  },
  {
    id: "bigheader",
    title: "oversized header line (9000 bytes)",
    upstream: "none",
    bytes: request("bigheader", {
      extra: [`X-Pad: ${"p".repeat(9000)}`, "Connection: close"],
    }),
  },
  {
    id: "timedout",
    title: "GET, upstream accepts and never answers (proxy_read_timeout)",
    identifiedBy: identity("504", "504", true, false),
    upstream: "hang",
    bytes: request("timedout", { extra: ["Connection: close"] }),
  },
];

/** The upgrades the two connection-bound runs open, by the query marker each sends. */
const PER_ADDRESS = "peraddress";
const EXHAUSTED = "exhausted";
const MARKED_IDS = [...CASES.map(({ id }) => id), PER_ADDRESS, EXHAUSTED];

/** The access-log identity of a request refused under the per-address limit. */
const PER_ADDRESS_REFUSAL = identity("503", "-", false, false);

const fail = (message) => {
  console.error(`check-broker-front-logs: ${message}`);
  process.exitCode = 1;
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}: ${result.stderr}`,
    );
  }
  return result;
};

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Starts a stand-in broker that closes every connection, holds it unanswered,
 * or answers its upgrade and holds it, or none for a refused port.
 */
const startUpstream = (behavior) =>
  new Promise((done, reject) => {
    if (behavior === "none") return done(null);
    const held = new Set();
    const server = createServer((socket) => {
      socket.on("error", () => {});
      if (behavior === "close") return socket.destroy();
      held.add(socket);
      if (behavior !== "upgrade") return;
      let head = "";
      const answer = (chunk) => {
        head += chunk.toString("latin1");
        if (!head.includes("\r\n\r\n")) return;
        socket.off("data", answer);
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
        );
      };
      socket.on("data", answer);
    });
    server.on("error", reject);
    server.listen(UPSTREAM_PORT, "127.0.0.1", () =>
      done({
        close: () =>
          new Promise((closed) => {
            for (const socket of held) socket.destroy();
            server.close(() => closed());
          }),
      }),
    );
  });

/** Sends raw bytes over TLS and resolves with the status line, once the reply has settled. */
const send = (bytes) =>
  new Promise((done) => {
    let received = "";
    let settle;
    const socket = connect({
      host: "127.0.0.1",
      port: FRONT_PORT,
      servername: BROKER_NAME,
      rejectUnauthorized: false,
    });
    const finish = () => {
      clearTimeout(deadline);
      clearTimeout(settle);
      socket.destroy();
      done(received ? received.split("\r\n")[0] : null);
    };
    const deadline = setTimeout(finish, RESPONSE_DEADLINE_MS);
    socket.on("secureConnect", () => socket.write(bytes));
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
      clearTimeout(settle);
      settle = setTimeout(finish, SETTLE_MS);
    });
    socket.on("error", () => {});
    socket.on("close", finish);
  });

/**
 * Opens a WebSocket upgrade from a loopback address and resolves with its
 * status line, null when none arrives in time, and the socket, held open on a
 * 101 and destroyed otherwise.
 */
const openUpgrade = (localAddress, id) =>
  new Promise((done) => {
    let received = "";
    let finished = false;
    const socket = connect({
      host: "127.0.0.1",
      port: FRONT_PORT,
      localAddress,
      servername: BROKER_NAME,
      rejectUnauthorized: false,
    });
    const finish = (status) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      socket.removeAllListeners("data");
      socket.removeAllListeners("close");
      if (!status?.includes(" 101 ")) socket.destroy();
      done({ status, socket });
    };
    const deadline = setTimeout(() => finish(null), UPGRADE_ANSWER_MS);
    socket.on("secureConnect", () =>
      socket.write(request(id, { extra: UPGRADE_HEADERS })),
    );
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
      if (received.includes("\r\n")) finish(received.split("\r\n")[0]);
    });
    socket.on("error", () => {});
    socket.on("close", () => finish(null));
  });

/** The front container's memory use as `docker stats` gives it. */
const frontMemory = () =>
  spawnSync(
    "docker",
    ["stats", "--no-stream", "--format", "{{.MemUsage}}", CONTAINER],
    { encoding: "utf8" },
  ).stdout.trim() || "unread";

/** The value of a directive the rendered template sets once, or undefined. */
const directiveValue = (rendered, pattern) =>
  Number(pattern.exec(rendered)?.[1]) || undefined;

/**
 * Sends a request's headers and none of the body they announce, which holds
 * one of the front's connections while it waits for the body. nginx closes an
 * idle connection to reuse it when it runs out, but not one reading a request.
 */
const openPendingBody = () =>
  new Promise((done) => {
    const socket = connect({
      host: "127.0.0.1",
      port: FRONT_PORT,
      localAddress: ROUTE_HOP_CLIENT,
      servername: BROKER_NAME,
      rejectUnauthorized: false,
    });
    const deadline = setTimeout(() => done(socket), UPGRADE_ANSWER_MS);
    socket.on("secureConnect", () => {
      socket.write(
        request(EXHAUSTED, { method: "POST", extra: ["Content-Length: 1000"] }),
      );
      clearTimeout(deadline);
      setTimeout(() => done(socket), SETTLE_MS);
    });
    socket.on("error", () => {
      clearTimeout(deadline);
      done(socket);
    });
  });

/**
 * Opens upgrades from 127.0.0.1 until the front stops answering them, then
 * frees one upgrade's two connections, takes one with a request whose body
 * never arrives, and sends one more upgrade into the last, so a request
 * reaches the front with no connection left for the broker whichever count
 * the front started from. Then it releases them all. The stand-in broker
 * answers each upgrade it is passed.
 */
const runExhaustion = async (front, workerConnections) => {
  const upstream = await startUpstream("upgrade");
  const held = [];
  let notUpgraded = 0;
  let attempts = 0;
  const idleMemory = frontMemory();
  while (notUpgraded < EXHAUSTED_AFTER && attempts < workerConnections) {
    attempts++;
    const { status, socket } = await openUpgrade(ROUTE_HOP_CLIENT, EXHAUSTED);
    if (status?.includes(" 101 ")) {
      held.push(socket);
      notUpgraded = 0;
    } else {
      notUpgraded++;
    }
  }
  const fullMemory = frontMemory();
  const heldAtFull = held.length;
  const extra = [];
  if (notUpgraded >= EXHAUSTED_AFTER && held.length) {
    held.pop().destroy();
    await delay(SETTLE_MS);
    extra.push(await openPendingBody());
    const last = await openUpgrade(ROUTE_HOP_CLIENT, EXHAUSTED);
    extra.push(last.socket);
  }
  await delay(SETTLE_MS);
  for (const socket of [...held, ...extra]) socket.destroy();
  await upstream.close();
  await delay(SETTLE_MS);
  return {
    held: heldAtFull,
    exhausted: notUpgraded >= EXHAUSTED_AFTER,
    idleMemory,
    fullMemory,
    written: front.lines.splice(0),
  };
};

/**
 * Opens more upgrades from one address than the front has connections for,
 * then one from a second address, and releases them.
 */
const runPerAddress = async (front, workerConnections) => {
  const upstream = await startUpstream("upgrade");
  const held = [];
  const statuses = new Map();
  for (let attempt = 0; attempt < workerConnections / 2 + 8; attempt++) {
    const { status, socket } = await openUpgrade(DIRECT_CLIENT, PER_ADDRESS);
    const code = status?.split(" ")[1] ?? "none";
    statuses.set(code, (statuses.get(code) ?? 0) + 1);
    if (code === "101") held.push(socket);
  }
  const second = await openUpgrade(SECOND_DIRECT_CLIENT, PER_ADDRESS);
  await delay(SETTLE_MS);
  for (const socket of [...held, second.socket]) socket.destroy();
  await upstream.close();
  await delay(SETTLE_MS);
  return {
    held: held.length,
    statuses,
    secondStatus: second.status,
    written: front.lines.splice(0),
  };
};

const waitForFront = async (stopped) => {
  for (let attempt = 0; attempt < 60 && !stopped(); attempt++) {
    const up = await new Promise((done) => {
      const socket = connect({
        host: "127.0.0.1",
        port: FRONT_PORT,
        servername: BROKER_NAME,
        rejectUnauthorized: false,
      });
      socket.on("secureConnect", () => {
        socket.destroy();
        done(true);
      });
      socket.on("error", () => done(false));
    });
    if (up) return true;
    await delay(500);
  }
  return false;
};

const contains = (line, id) => ({
  ...Object.fromEntries(
    FIELDS.map((field) => [field.label, line.includes(field.marker(id))]),
  ),
  "query string": line.includes(queryMarker(id)),
  "client IP": /\bclient: 127\.0\.0\.1\b/.test(line),
});

/** The status and the `name=value` fields of a line the template's access-log format writes. */
const accessFields = (line) => ({
  status: /" (\d{3}) /.exec(line)?.[1],
  ...Object.fromEntries(
    [...line.matchAll(/ (\w+)=(\S*)/g)].map(([, name, value]) => [name, value]),
  ),
});

const observedIdentity = (line) => {
  const fields = accessFields(line);
  return identity(
    fields.status,
    fields.upstream_status,
    /^\d/.test(fields.upstream_connect ?? ""),
    Number(fields.request_bytes) > CLIENT_BODY_BUFFER_BYTES,
  );
};

/** The error-log message without its timestamp, level, pid and request fields. */
const message = (line) =>
  line
    .replace(/^\S+ \S+ \[(\w+)\] \d+#\d+: (\*\d+ )?/, "[$1] ")
    .replace(/, client: .*$/, "");

/** The `--cap-drop` and `--cap-add` arguments of the unit's ExecStart, in order. */
const unitCapabilityArguments = () => {
  const execStart = readFileSync(
    join(BROKER, "alcove-broker-tls.service"),
    "utf8",
  )
    .replace(/\\\n/g, " ")
    .match(/^ExecStart=.*$/m)?.[0];
  const flags = [...(execStart ?? "").matchAll(/--cap-(?:drop|add) (\S+)/g)];
  if (!flags.length) {
    throw new Error(
      "infra/broker/alcove-broker-tls.service has no --cap-drop or --cap-add in its ExecStart",
    );
  }
  return flags.flatMap((flag) => [flag[0].split(" ")[0], flag[1]]);
};

/**
 * Runs the image with one rendered configuration and collects what its two
 * log streams write, each line tagged with the stream it came from.
 */
const startFront = (image, confPath, work) => {
  spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  // Without CAP_DAC_OVERRIDE the container's root reads only what others may read.
  chmodSync(work, 0o755);
  for (const path of [
    confPath,
    join(work, "privkey.pem"),
    join(work, "fullchain.pem"),
  ])
    chmodSync(path, 0o644);
  const container = spawn("docker", [
    "run",
    "--rm",
    "--name",
    CONTAINER,
    "--network",
    "host",
    "--read-only",
    "--tmpfs",
    "/tmp",
    ...unitCapabilityArguments(),
    "-v",
    `${confPath}:/etc/nginx/nginx.conf:ro`,
    "-v",
    `${work}:/etc/nginx/tls:ro`,
    image,
  ]);
  const front = { lines: [], exited: false };
  container.on("exit", () => (front.exited = true));
  const closed = [container.stdout, container.stderr].map(
    (stream) => new Promise((done) => stream.on("close", done)),
  );
  for (const [stream, log] of [
    [container.stdout, "access"],
    [container.stderr, "error"],
  ]) {
    let partial = "";
    stream.on("data", (chunk) => {
      const parts = (partial + chunk.toString("utf8")).split("\n");
      partial = parts.pop();
      for (const text of parts)
        if (text.trim()) front.lines.push({ log, text });
    });
  }
  /** Removes the container, then waits for both log streams to close, up to 5 s. */
  front.stop = async () => {
    spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
    await Promise.race([Promise.all(closed), delay(5000)]);
  };
  return front;
};

/**
 * Renders the template with its error log at warn and drives the refused case
 * and the exhaustion case through it. The run fails unless the error log's
 * stream is captured and the query-string detector flags a line for each, so a
 * real run's empty error log means nothing was written and not that nothing
 * was read, nor that the front never ran out of connections.
 */
const runErrorLogControl = async (image, work, rendered, workerConnections) => {
  const controlRendered = rendered.replace(
    /^(error_log\s+\S+\s+)emerg;/m,
    "$1warn;",
  );
  if (controlRendered === rendered) {
    fail("control: the rendered template has no error_log line at emerg");
    return undefined;
  }
  const controlConf = join(work, "nginx.control.conf");
  writeFileSync(controlConf, controlRendered);
  const testCase = CASES.find(({ id }) => id === "refused");
  const front = startFront(image, controlConf, work);
  let refusedLines;
  let exhaustion;
  try {
    if (!(await waitForFront(() => front.exited))) {
      fail("control: the front did not accept a TLS connection");
      return undefined;
    }
    await delay(SETTLE_MS);
    front.lines.splice(0);
    const upstream = await startUpstream(testCase.upstream);
    await send(testCase.bytes);
    await delay(SETTLE_MS);
    await upstream?.close();
    refusedLines = front.lines.splice(0);
    exhaustion = await runExhaustion(front, workerConnections);
  } finally {
    await front.stop();
  }
  const summaries = [];
  for (const [id, lines] of [
    [testCase.id, refusedLines],
    [EXHAUSTED, exhaustion.written],
  ]) {
    const errors = lines.filter(({ log }) => log === "error");
    const flagged = errors.filter(
      ({ text }) => contains(text, id)["query string"],
    );
    console.log(
      `control: error_log at warn, ${id} case wrote ${errors.length} error-log lines, ${flagged.length} holding its query string`,
    );
    if (!errors.length) {
      fail(`control: ${id}: no error-log line was captured at warn`);
      return undefined;
    }
    if (!flagged.length) {
      fail(`control: ${id}: no captured error-log line holds its query string`);
      return undefined;
    }
    summaries.push(
      `the ${id} case wrote ${errors.length} error-log lines, ${flagged.length} holding its query string`,
    );
  }
  console.log();
  if (!exhaustion.exhausted) {
    fail("control: the front did not run out of connections");
    return undefined;
  }
  return `Positive control: with error_log at warn, ${summaries.join("; ")}.`;
};

const main = async () => {
  const image = readFileSync(join(BROKER, "Dockerfile"), "utf8").match(
    /^FROM (\S+)$/m,
  )?.[1];
  if (!image) return fail("infra/broker/Dockerfile names no FROM image");
  const work = mkdtempSync(join(tmpdir(), "broker-error-log-"));
  const envFile = join(work, "broker.env");
  const conf = join(work, "nginx.conf");
  writeFileSync(envFile, `ALCOVE_BROKER_NAME=${BROKER_NAME}\n`);
  const rendered = run("bash", [join(BROKER, "render-config.sh")], {
    env: { ...process.env, ALCOVE_BROKER_ENV_FILE: envFile },
  }).stdout;
  writeFileSync(conf, rendered);
  const workerConnections = directiveValue(
    rendered,
    /^\s*events\s*\{\s*worker_connections\s+(\d+);/m,
  );
  if (!workerConnections) {
    rmSync(work, { recursive: true, force: true });
    return fail("the rendered template sets no worker_connections");
  }
  const directLimit = directiveValue(
    rendered,
    /^\s*limit_conn\s+\S+\s+(\d+);/m,
  );
  run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    `/CN=${BROKER_NAME}`,
    "-keyout",
    join(work, "privkey.pem"),
    "-out",
    join(work, "fullchain.pem"),
  ]);
  run("docker", ["pull", "--quiet", image]);
  const version = run("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "nginx",
    image,
    "-v",
  ]).stderr.trim();
  console.log(`image: ${image}\n${version}\n`);

  const results = [];
  let startup = [];
  let controlSummary;
  let front;
  let perAddress;
  let exhaustion;
  try {
    controlSummary = await runErrorLogControl(
      image,
      work,
      rendered,
      workerConnections,
    );
    if (!controlSummary) return;
    front = startFront(image, conf, work);
    if (!(await waitForFront(() => front.exited))) {
      await delay(SETTLE_MS);
      console.log("front output before it stopped:");
      for (const { text } of front.lines.splice(0)) console.log(`  ${text}`);
      console.log();
      return fail(
        front.exited
          ? "the front exited before it accepted a TLS connection"
          : "the front did not accept a TLS connection within 30 s",
      );
    }
    await delay(SETTLE_MS);
    startup = front.lines.splice(0);
    if (startup.length) {
      console.log("lines before the first request:");
      for (const { text } of startup) console.log(`  start-up: ${text}`);
      console.log();
    }
    for (const testCase of CASES) {
      const upstream = await startUpstream(testCase.upstream);
      const status = await send(testCase.bytes);
      await delay(SETTLE_MS);
      await upstream?.close();
      const written = front.lines.splice(0);
      results.push({ testCase, status, written });
      console.log(`== ${testCase.id}: ${testCase.title}`);
      console.log(`response: ${status ?? "(none)"}`);
      if (!written.length) console.log("no log line");
      for (const { log, text } of written) {
        const found = contains(text, testCase.id);
        console.log(`${log} log: ${text}`);
        console.log(
          `  ${Object.entries(found)
            .map(([field, present]) => `${field}=${yesNo(present)}`)
            .join(" ")}`,
        );
      }
      console.log();
      if (!status) fail(`${testCase.id}: no response from the front`);
      if (front.exited) return fail("the front exited during the run");
    }
    perAddress = await runPerAddress(front, workerConnections);
    console.log(
      `== ${PER_ADDRESS}: ${workerConnections / 2 + 8} upgrades from ${DIRECT_CLIENT}, then one from ${SECOND_DIRECT_CLIENT}`,
    );
    console.log(
      `responses: ${[...perAddress.statuses].map(([code, count]) => `${code} x${count}`).join(", ")}; ${SECOND_DIRECT_CLIENT}: ${perAddress.secondStatus ?? "(none)"}`,
    );
    for (const { log, text } of perAddress.written)
      if (log === "error") console.log(`${log} log: ${text}`);
    console.log();
    if (front.exited) return fail("the front exited during the run");
    exhaustion = await runExhaustion(front, workerConnections);
    console.log(
      `== ${EXHAUSTED}: upgrades from ${ROUTE_HOP_CLIENT} until the front has no connection left`,
    );
    console.log(
      `held ${exhaustion.held} upgrades, two of the front's ${workerConnections} connections each; front memory idle ${exhaustion.idleMemory}, with them held ${exhaustion.fullMemory}`,
    );
    for (const { log, text } of exhaustion.written)
      if (log === "error") console.log(`${log} log: ${text}`);
    console.log();
    if (front.exited) return fail("the front exited during the run");
    await delay(SETTLE_MS);
  } finally {
    await front?.stop();
    rmSync(work, { recursive: true, force: true });
  }

  const trailing = front.lines.splice(0);
  if (trailing.length) {
    console.log("lines after the last request:");
    for (const { log, text } of trailing) console.log(`  ${log} log: ${text}`);
    console.log();
  }
  for (const { log } of trailing) {
    if (log === "error")
      fail("error log: a line arrived after the last request");
  }

  for (const { log, text } of [
    ...startup,
    ...results.flatMap(({ written }) => written),
    ...perAddress.written,
    ...exhaustion.written,
    ...trailing,
  ]) {
    const leaked = MARKED_IDS.find((id) => text.includes(queryMarker(id)));
    if (leaked) fail(`${log} log: a line contains ${leaked}'s query string`);
  }

  const perAddressRefusals = perAddress.written.filter(
    ({ log, text }) =>
      log === "access" && observedIdentity(text) === PER_ADDRESS_REFUSAL,
  );
  const refusedUpgrades = [...perAddress.statuses]
    .filter(([code]) => code !== "101")
    .reduce((sum, [, count]) => sum + count, 0);
  if (!directLimit) {
    fail("the rendered template sets no limit_conn for a direct client");
  } else if (perAddress.held !== directLimit) {
    fail(
      `${PER_ADDRESS}: ${DIRECT_CLIENT} held ${perAddress.held} upgrades, not the limit of ${directLimit}`,
    );
  }
  if (perAddress.statuses.get("503") !== refusedUpgrades) {
    fail(`${PER_ADDRESS}: an upgrade past the limit was not answered 503`);
  }
  if (perAddressRefusals.length !== refusedUpgrades) {
    fail(
      `${PER_ADDRESS}: ${perAddressRefusals.length} access-log lines show ${PER_ADDRESS_REFUSAL}, not ${refusedUpgrades}`,
    );
  }
  if (!perAddress.secondStatus?.includes(" 101 ")) {
    fail(
      `${PER_ADDRESS}: ${SECOND_DIRECT_CLIENT} was answered ${perAddress.secondStatus ?? "nothing"}, not 101`,
    );
  }
  if (!exhaustion.exhausted) {
    fail(`${EXHAUSTED}: the front did not run out of connections`);
  }
  for (const [id, written] of [
    [PER_ADDRESS, perAddress.written],
    [EXHAUSTED, exhaustion.written],
  ]) {
    const errors = written.filter(({ log }) => log === "error");
    if (errors.length)
      fail(`${id}: ${errors.length} error-log lines, not none`);
  }

  const table = [
    `${version}, with nginx.conf.tmpl as rendered.`,
    "",
    controlSummary,
    "",
    "| Request | Response | Access-log identity | Error-log lines |",
    "| --- | --- | --- | --- |",
  ];
  const identities = new Map();
  for (const { testCase, status, written } of results) {
    const errors = written.filter(({ log }) => log === "error");
    const accesses = written.filter(({ log }) => log === "access");
    if (errors.length) {
      fail(`${testCase.id}: ${errors.length} error-log lines, not none`);
    }
    if (!accesses.length) fail(`${testCase.id}: no access-log line`);
    const observed =
      accesses.length === 1 ? observedIdentity(accesses[0].text) : undefined;
    if (testCase.identifiedBy) {
      if (accesses.length !== 1) {
        fail(`${testCase.id}: ${accesses.length} access-log lines, not 1`);
      } else if (observed !== testCase.identifiedBy) {
        fail(
          `${testCase.id}: access log shows ${observed}, not ${testCase.identifiedBy}`,
        );
      }
      const twin = identities.get(observed);
      if (observed && twin) {
        fail(`${testCase.id} and ${twin} have one access-log identity`);
      }
      identities.set(observed, testCase.id);
    }
    const response = status?.replace(/^HTTP\/\S+ /, "") ?? "none";
    table.push(
      `| ${testCase.title} | ${response} | ${observed ?? "-"} | ${errors.length ? errors.map(({ text }) => message(text)).join("<br>") : "none"} |`,
    );
  }
  const twin = identities.get(PER_ADDRESS_REFUSAL);
  if (twin) fail(`${PER_ADDRESS} and ${twin} have one access-log identity`);
  for (const [title, response, observed, written] of [
    [
      `WebSocket upgrade from one direct client address past its ${directLimit ?? "(unset)"}`,
      perAddress.statuses.has("503") ? "503" : "none",
      perAddressRefusals.length ? PER_ADDRESS_REFUSAL : "-",
      perAddress.written,
    ],
    [
      `WebSocket upgrade from ${ROUTE_HOP_CLIENT} with the front's ${workerConnections} connections in use (${exhaustion.held} upgrades held; front memory ${exhaustion.idleMemory} idle, ${exhaustion.fullMemory} full)`,
      exhaustion.exhausted ? "not upgraded" : "upgraded",
      "-",
      exhaustion.written,
    ],
  ]) {
    const errors = written.filter(({ log }) => log === "error");
    table.push(
      `| ${title} | ${response} | ${observed} | ${errors.length ? errors.map(({ text }) => message(text)).join("<br>") : "none"} |`,
    );
  }
  console.log(table.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table.join("\n")}\n`);
};

await main();
