import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// infra/relay/stun-binding.py, verify.sh's client-address probe, driven
// against a TLS server here that answers its Binding request as the test
// chooses. What coturn answers through the real front is the host run's to
// record (infra/relay/README.md, The 443 front).

const here = dirname(fileURLToPath(import.meta.url));
const PROBE = resolve(here, "..", "infra/relay/stun-binding.py");
const NAME = "relay.example";
const MAGIC_COOKIE = 0x2112a442;

let certDir;

beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), "relay-stun-binding-"));
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

const servers = [];

afterEach(async () => {
  while (servers.length > 0) {
    await new Promise((done) => servers.pop().close(done));
  }
});

/** A STUN attribute: type, length, value padded to four bytes. */
const attribute = (type, value) => {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(value.length, 2);
  const padding = Buffer.alloc((4 - (value.length % 4)) % 4);
  return Buffer.concat([header, value, padding]);
};

/** An XOR-MAPPED-ADDRESS value for an IPv4 or IPv6 address under a transaction id. */
const xorMappedAddress = (address, port, transactionId) => {
  const mask = Buffer.concat([Buffer.alloc(4), transactionId]);
  mask.writeUInt32BE(MAGIC_COOKIE, 0);
  const packed = address.includes(":")
    ? Buffer.from(
        address
          .split(":")
          .map((group) => group.padStart(4, "0"))
          .join(""),
        "hex",
      )
    : Buffer.from(address.split(".").map(Number));
  const value = Buffer.alloc(4 + packed.length);
  value[1] = packed.length === 4 ? 0x01 : 0x02;
  value.writeUInt16BE(port ^ (MAGIC_COOKIE >>> 16), 2);
  for (let i = 0; i < packed.length; i++) value[4 + i] = packed[i] ^ mask[i];
  return value;
};

/** A STUN message of a type, under a transaction id, holding attributes. */
const message = (type, transactionId, attributes) => {
  const body = Buffer.concat(attributes);
  const header = Buffer.alloc(8);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(body.length, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  return Buffer.concat([header, transactionId, body]);
};

/**
 * A TLS server on loopback that reads one Binding request and writes what
 * `answer` returns for its transaction id, or nothing for `null`.
 */
const startServer = async (answer) => {
  const requests = [];
  const server = tls.createServer(
    {
      key: readFileSync(join(certDir, "privkey.pem")),
      cert: readFileSync(join(certDir, "fullchain.pem")),
    },
    (socket) => {
      let received = Buffer.alloc(0);
      socket.on("error", () => {});
      socket.on("data", (data) => {
        received = Buffer.concat([received, data]);
        if (received.length < 20) return;
        requests.push(received.subarray(0, 20));
        const reply = answer(received.subarray(8, 20));
        if (reply !== null) socket.write(reply);
      });
    },
  );
  servers.push(server);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { port: server.address().port, requests };
};

const mapped = (address, port) => (transactionId) =>
  message(0x0101, transactionId, [
    attribute(0x0020, xorMappedAddress(address, port, transactionId)),
  ]);

/** Runs the probe without blocking the server's event loop. */
const probe = (port, extra = [], name = NAME) =>
  new Promise((done) => {
    const child = spawn(
      "python3",
      [
        "-B",
        PROBE,
        "127.0.0.1",
        String(port),
        name,
        "--cafile",
        join(certDir, "fullchain.pem"),
        ...extra,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });

describe("stun-binding.py", () => {
  it("sends one Binding request with the magic cookie and prints the address the server names", async () => {
    const { port, requests } = await startServer(mapped("203.0.113.7", 40000));
    const result = await probe(port);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("XOR-MAPPED-ADDRESS 203.0.113.7:40000\n");
    expect(requests).toHaveLength(1);
    expect(requests[0].readUInt16BE(0)).toBe(0x0001);
    expect(requests[0].readUInt16BE(2)).toBe(0);
    expect(requests[0].readUInt32BE(4)).toBe(MAGIC_COOKIE);
  });

  it.each([
    ["127.0.0.1", "127.0.0.1:45732 (loopback)"],
    ["127.4.5.6", "127.4.5.6:45732 (loopback)"],
    ["0:0:0:0:0:0:0:1", "[::1]:45732 (loopback)"],
    ["0:0:0:0:0:ffff:7f00:1", "[::ffff:7f00:1]:45732 (loopback)"],
  ])("exits 5 on the loopback address %s", async (address, shown) => {
    const { port } = await startServer(mapped(address, 45732));
    const result = await probe(port);
    expect(result.status, result.stderr).toBe(5);
    expect(result.stdout).toBe(`XOR-MAPPED-ADDRESS ${shown}\n`);
  });

  it("prints an IPv6 address in brackets", async () => {
    const { port } = await startServer(mapped("2001:db8:0:0:0:0:0:5", 50000));
    const result = await probe(port);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("XOR-MAPPED-ADDRESS [2001:db8::5]:50000\n");
  });

  it("hides a public address under --redact and keeps a private one", async () => {
    const outside = await startServer(mapped("8.8.8.8", 50001));
    const redacted = await probe(outside.port, ["--redact"]);
    expect(redacted.status, redacted.stderr).toBe(0);
    expect(redacted.stdout).toBe("XOR-MAPPED-ADDRESS <public>:50001\n");
    const inside = await startServer(mapped("10.0.0.96", 50002));
    const kept = await probe(inside.port, ["--redact"]);
    expect(kept.stdout).toBe("XOR-MAPPED-ADDRESS 10.0.0.96:50002\n");
  });

  it("exits 4 on a Binding error", async () => {
    const { port } = await startServer((transactionId) =>
      message(0x0111, transactionId, [
        attribute(0x0009, Buffer.from([0, 0, 4, 0])),
      ]),
    );
    const result = await probe(port);
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("not a Binding success");
  });

  it("exits 4 on an answer under another transaction id", async () => {
    const { port } = await startServer(() =>
      mapped("203.0.113.7", 40000)(Buffer.alloc(12, 7)),
    );
    const result = await probe(port);
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("not a STUN answer to this request");
  });

  it("exits 4 on a success with no XOR-MAPPED-ADDRESS", async () => {
    const { port } = await startServer((transactionId) =>
      message(0x0101, transactionId, [attribute(0x8022, Buffer.from("x"))]),
    );
    const result = await probe(port);
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("no XOR-MAPPED-ADDRESS");
  });

  // What the front gives while coturn behind it is not yet listening: the TLS
  // handshake completes and the connection closes unanswered.
  it.each([
    ["with a TLS close", (socket) => socket.end()],
    ["without one", (socket) => socket.destroy()],
  ])("exits 3 on a connection closed unanswered %s", async (_, close) => {
    const server = tls.createServer(
      {
        key: readFileSync(join(certDir, "privkey.pem")),
        cert: readFileSync(join(certDir, "fullchain.pem")),
      },
      (socket) => {
        socket.on("error", () => {});
        socket.once("data", () => close(socket));
      },
    );
    servers.push(server);
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const result = await probe(server.address().port);
    expect(result.status, result.stderr).toBe(3);
    expect(result.stdout).toBe("");
  });

  it("exits 2 on a certificate that does not verify for the name", async () => {
    const { port, requests } = await startServer(mapped("203.0.113.7", 40000));
    const result = await probe(port, [], "other.example");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("TLS handshake");
    expect(result.stderr).toMatch(/certificate verify failed|match/i);
    expect(requests).toHaveLength(0);
  });

  it("exits 2 when nothing listens", async () => {
    const { port } = await startServer(mapped("203.0.113.7", 40000));
    await new Promise((done) => servers.pop().close(done));
    const result = await probe(port);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("could not connect");
  });

  it("refuses a usage it does not take", () => {
    const child = spawnSync("python3", ["-B", PROBE, "127.0.0.1", "443"], {
      encoding: "utf8",
    });
    expect(child.status).toBe(64);
    expect(child.stderr).toContain("usage: stun-binding.py");
  });
});
