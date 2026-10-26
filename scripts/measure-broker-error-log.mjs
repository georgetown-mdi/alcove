#!/usr/bin/env node
// Measures which request headers the broker's TLS front writes into its error
// log, for PRIVACY.md's TLS front error-log bullet.
//
//   node scripts/measure-broker-error-log.mjs
//
// Needs docker, openssl and free ports 8443 and 9411 on the loopback, so it
// runs from broker_front_error_log.yaml on a hosted runner. It renders
// infra/broker/nginx.conf.tmpl with render-config.sh, runs the image
// infra/broker/Dockerfile pins as alcove-broker-tls.service runs it (host
// network, read-only root, tmpfs /tmp), and stands in for the broker on
// 127.0.0.1:9411. Each request sends its own Host, Referer, User-Agent and
// Origin values and query string, and the run prints, for each error-log and
// access-log line the request wrote, which of those values the line contains.
// It exits 1 when the front does not start or a request gets no response; what
// the lines contain is reported, not judged.

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
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

/** Each request, the upstream behavior it meets, and what it is expected to provoke. */
const CASES = [
  {
    id: "refused",
    title: "WebSocket upgrade, upstream refuses the connection",
    upstream: "none",
    bytes: request("refused", {
      extra: [
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
      ],
    }),
  },
  {
    id: "closed",
    title: "GET, upstream closes before answering",
    upstream: "close",
    bytes: request("closed", { extra: ["Connection: close"] }),
  },
  {
    id: "buffered",
    title: "POST with a 20000-byte body, upstream refuses the connection",
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
    upstream: "hang",
    bytes: request("timedout", { extra: ["Connection: close"] }),
  },
];

const fail = (message) => {
  console.error(`measure-broker-error-log: ${message}`);
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

/** Starts a stand-in broker that closes or holds every connection, or none for a refused port. */
const startUpstream = (behavior) =>
  new Promise((done, reject) => {
    if (behavior === "none") return done(null);
    const held = new Set();
    const server = createServer((socket) => {
      socket.on("error", () => {});
      if (behavior === "close") socket.destroy();
      else held.add(socket);
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

const waitForFront = async () => {
  for (let attempt = 0; attempt < 60; attempt++) {
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
  "client IP": line.includes("127.0.0.1"),
});

const yesNo = (present) => (present ? "yes" : "no");

/** The error-log message without its timestamp, level, pid and request fields. */
const message = (line) =>
  line
    .replace(/^\S+ \S+ \[(\w+)\] \d+#\d+: (\*\d+ )?/, "[$1] ")
    .replace(/, client: .*$/, "");

const main = async () => {
  const image = readFileSync(join(BROKER, "Dockerfile"), "utf8").match(
    /^FROM (\S+)$/m,
  )?.[1];
  if (!image) return fail("infra/broker/Dockerfile names no FROM image");
  const work = mkdtempSync(join(tmpdir(), "broker-error-log-"));
  const envFile = join(work, "broker.env");
  const conf = join(work, "nginx.conf");
  writeFileSync(envFile, `ALCOVE_BROKER_NAME=${BROKER_NAME}\n`);
  writeFileSync(
    conf,
    run("bash", [join(BROKER, "render-config.sh")], {
      env: { ...process.env, ALCOVE_BROKER_ENV_FILE: envFile },
    }).stdout,
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

  const lines = [];
  spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  const front = spawn("docker", [
    "run",
    "--rm",
    "--name",
    CONTAINER,
    "--network",
    "host",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "-v",
    `${conf}:/etc/nginx/nginx.conf:ro`,
    "-v",
    `${work}:/etc/nginx/tls:ro`,
    image,
  ]);
  let exited = false;
  front.on("exit", () => (exited = true));
  for (const [stream, log] of [
    [front.stdout, "access"],
    [front.stderr, "error"],
  ]) {
    let partial = "";
    stream.on("data", (chunk) => {
      const parts = (partial + chunk.toString("utf8")).split("\n");
      partial = parts.pop();
      for (const text of parts) if (text.trim()) lines.push({ log, text });
    });
  }

  const results = [];
  try {
    if (!(await waitForFront()))
      return fail("the front did not accept a TLS connection within 30 s");
    await delay(SETTLE_MS);
    const startup = lines.splice(0);
    if (startup.length) {
      console.log("lines before the first request:");
      for (const { log, text } of startup) console.log(`  ${log}: ${text}`);
      console.log();
    }
    for (const testCase of CASES) {
      const upstream = await startUpstream(testCase.upstream);
      const status = await send(testCase.bytes);
      await delay(SETTLE_MS);
      await upstream?.close();
      const written = lines.splice(0);
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
      if (exited) return fail("the front exited during the run");
    }
  } finally {
    spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
    rmSync(work, { recursive: true, force: true });
  }

  const columns = [
    "Host",
    "Referer",
    "User-Agent",
    "Origin",
    "query string",
    "client IP",
  ];
  const table = [
    `Error log, ${version}, error_log level as in nginx.conf.tmpl.`,
    "",
    `| Request | Response | Error-log line | ${columns.join(" | ")} |`,
    `|${" --- |".repeat(columns.length + 3)}`,
  ];
  for (const { testCase, status, written } of results) {
    const errors = written.filter(({ log }) => log === "error");
    const response = status?.replace(/^HTTP\/\S+ /, "") ?? "none";
    if (!errors.length) {
      table.push(
        `| ${testCase.title} | ${response} | none |${" - |".repeat(columns.length)}`,
      );
    }
    for (const { text } of errors) {
      const found = contains(text, testCase.id);
      table.push(
        `| ${testCase.title} | ${response} | ${message(text)} | ${columns.map((column) => yesNo(found[column])).join(" | ")} |`,
      );
    }
  }
  const accessHits = results.flatMap(({ testCase, written }) =>
    written
      .filter(({ log }) => log === "access")
      .flatMap(({ text }) =>
        Object.entries(contains(text, testCase.id))
          .filter(([field, present]) => present && field !== "client IP")
          .map(([field]) => `${testCase.id}: ${field}`),
      ),
  );
  table.push(
    "",
    `Access log: ${accessHits.length ? `contains ${accessHits.join(", ")}` : "no line contains a sent Host, Referer, User-Agent or Origin value or the query string"}.`,
  );
  console.log(table.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table.join("\n")}\n`);
};

await main();
