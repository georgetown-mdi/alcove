import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  FileSyncConnection,
  sanitizeErrorForDisplay,
  type FileSyncOptions,
  type SFTPConnectionConfig,
} from "@alcove/core";
import { withCapturedLogs } from "@alcove/core/testing";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { runProtocol, type ProtocolConnectionConfig } from "../../src/protocol";
import {
  ensureNamespace,
  remotePath,
  serverAuth,
  sftpServer,
} from "../sftpServer/testContext";
import { preparedFor } from "../support";

// A retain-mode folder on a real SFTP server, reused: two whole exchanges in
// one folder, and what the second run reads from the first one's files. It
// also measures the modification time a listing reports for a file the other
// party wrote, which the start-up age of an unanswered partner hello is read
// from (docs/spec/FILE_SYNC.md, "Reusing a retain-mode directory").

const TEST_TIMEOUT_MS = 120_000;
const PEER_TIMEOUT_MS = 30_000;

const ROWS_A = [{ first_name: "Bob" }, { first_name: "Carol" }];
const ROWS_B = [
  { first_name: "Bob" },
  { first_name: "Carol" },
  { first_name: "Dave" },
];

const RETAIN: FileSyncOptions = {
  retainFiles: true,
  locklessRendezvous: true,
  timestampInFilename: true,
};

const srv = sftpServer();
let work: string;

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-retain-reuse-"));
});

afterAll(() => {
  if (work !== undefined) fs.rmSync(work, { recursive: true, force: true });
});

const connectionFor = (
  party: (typeof srv)["usera"],
  namespace: string,
  options: FileSyncOptions = {},
): SFTPConnectionConfig & ProtocolConnectionConfig => ({
  channel: "sftp",
  server: {
    host: srv.host,
    port: srv.port,
    ...serverAuth(party),
    path: remotePath(srv, namespace),
  },
  options: {
    pollIntervalMs: 50,
    peerTimeoutMs: PEER_TIMEOUT_MS,
    inactivityTimeoutMs: PEER_TIMEOUT_MS,
    ...RETAIN,
    ...options,
  },
});

async function runPair(namespace: string, run: number): Promise<void> {
  const outA = path.join(work, `${namespace}-${run}-a`);
  const outB = path.join(work, `${namespace}-${run}-b`);
  await withCapturedLogs(() =>
    Promise.all([
      runProtocol({
        connection: connectionFor(srv.usera, namespace),
        auth: null,
        prepared: preparedFor("PartyA", ROWS_A),
        output: outA,
        verbosity: -1,
        loggerName: `${namespace}-${run}-a`,
      }),
      runProtocol({
        connection: connectionFor(srv.userb, namespace),
        auth: null,
        prepared: preparedFor("PartyB", ROWS_B),
        output: outB,
        verbosity: -1,
        loggerName: `${namespace}-${run}-b`,
      }),
    ]),
  );
  for (const out of [outA, outB]) {
    const results = (await fsp.readdir(out)).filter((name) =>
      name.startsWith("alcove-results-"),
    );
    expect(results).toHaveLength(1);
  }
}

describe("a retain folder on an SFTP server, reused", () => {
  test(
    "a second exchange completes, and each hello of the first has an ack named after it",
    async () => {
      const local = await ensureNamespace(srv, "retain-reuse");
      await runPair("retain-reuse", 1);
      const first = new Map<string, Buffer>();
      for (const name of await fsp.readdir(local))
        first.set(name, await fsp.readFile(path.join(local, name)));

      // What the first exchange left: each party's hello, and an ack named
      // after each hello written by the other party. That ack is how the
      // second run reads a hello as answered.
      const hellos = [...first.keys()].filter((n) =>
        /-hello-\d+\.json$/.test(n),
      );
      expect(hellos).toHaveLength(2);
      for (const hello of hellos) {
        const writer = hello.slice(0, hello.lastIndexOf("-hello-"));
        const acks = [...first.keys()].filter((n) =>
          n.endsWith(`-${hello.slice(0, -".json".length)}-ack.json`),
        );
        expect(acks).toHaveLength(1);
        expect(acks[0].startsWith(`${writer}-`)).toBe(false);
      }

      await runPair("retain-reuse", 2);
      for (const [name, body] of first)
        expect((await fsp.readFile(path.join(local, name))).equals(body)).toBe(
          true,
        );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a listing reports the server's stamp for a file the other party wrote",
    async () => {
      const namespace = "retain-reuse-mtime";
      const local = await ensureNamespace(srv, namespace);
      const open = async (party: (typeof srv)["usera"]) => {
        const conn = new FileSyncConnection(new SSH2SFTPClientAdapter(), {
          verbose: -1,
        });
        await conn.open(connectionFor(party, namespace));
        return conn;
      };
      const [writer, reader] = await withCapturedLogs(() =>
        Promise.all([open(srv.usera), open(srv.userb)]),
      ).then(([conns]) => conns);
      const adapterOf = (conn: FileSyncConnection) =>
        (conn as unknown as { client: SSH2SFTPClientAdapter }).client;
      try {
        const before = Date.now();
        await adapterOf(writer).put(
          Buffer.from("{}"),
          `${remotePath(srv, namespace)}/written.json`,
        );
        const after = Date.now();
        const [listed] = (
          await adapterOf(reader).list(remotePath(srv, namespace))
        ).filter((file) => file.name === "written.json");
        // Whole seconds: SFTP version 3 states a modification time in seconds.
        expect(listed.modifyTime % 1000).toBe(0);
        expect(listed.modifyTime).toBeGreaterThanOrEqual(
          Math.floor(before / 1000) * 1000,
        );
        expect(listed.modifyTime).toBeLessThanOrEqual(after);

        // The listing reports what the server's file system holds, whoever
        // set it: a time set back a day lists a day old, as a file a transfer
        // dated from its source, or a server clock running behind, would.
        const dayAgo = new Date(after - 86_400_000);
        await fsp.utimes(path.join(local, "written.json"), dayAgo, dayAgo);
        const [backdated] = (
          await adapterOf(reader).list(remotePath(srv, namespace))
        ).filter((file) => file.name === "written.json");
        expect(backdated.modifyTime).toBe(
          Math.floor(dayAgo.getTime() / 1000) * 1000,
        );
      } finally {
        await withCapturedLogs(() =>
          Promise.all([writer.close(), reader.close()]).catch(
            (err: unknown) => {
              throw new Error(sanitizeErrorForDisplay(err));
            },
          ),
        );
      }
    },
    TEST_TIMEOUT_MS,
  );
});
