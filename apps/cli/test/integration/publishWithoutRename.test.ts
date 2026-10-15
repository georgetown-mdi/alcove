import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect } from "vitest";
import { sanitizeErrorForDisplay, type FileSyncOptions } from "@alcove/core";
import { withCapturedLogs } from "@alcove/core/testing";

import { runProtocol, type ProtocolConnectionConfig } from "../../src/protocol";
import { startInProcessSftpServer } from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";
import type { InProcessSftpServer } from "../sftpServer/types";
import { inProcessOnly } from "../sftpBackendGate";
import { preparedFor } from "../support";

// Writing without renaming against a server that refuses every RENAME, the
// deployment the option exists for: two whole runProtocol parties over the
// real SSH/SFTP stack, in each rendezvous and retention mode. With the option
// on, the exchange completes, no RENAME reaches the server and no temporary
// name is ever opened for writing. With it off, the run ends naming the
// option. Only the in-process backend can refuse renames on demand, so this
// runs there against its own server instance.

const TEST_TIMEOUT_MS = 120_000;
const PEER_TIMEOUT_MS = 30_000;

const ROWS_A = [{ first_name: "Bob" }, { first_name: "Carol" }];
const ROWS_B = [
  { first_name: "Bob" },
  { first_name: "Carol" },
  { first_name: "Dave" },
];

interface PartyOutcome {
  ok: boolean;
  rendered?: string;
}

let srv: InProcessSftpServer;
let work: string;

beforeAll(async () => {
  srv = await startInProcessSftpServer();
  work = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-no-rename-"));
});

afterAll(async () => {
  await srv?.stop();
  if (work !== undefined) fs.rmSync(work, { recursive: true, force: true });
});

// `bFirst` starts A only once B's hello is in the folder, so A arrives as the
// lock-path joiner.
async function runPair(
  tag: string,
  options: { a: FileSyncOptions; b: FileSyncOptions; bFirst?: boolean },
): Promise<{ a: PartyOutcome; b: PartyOutcome; outA: string; outB: string }> {
  const folder = path.join(srv.handle.backingDir, tag);
  await fsp.mkdir(folder, { recursive: true });
  const connection = (
    party: (typeof srv.handle)["usera"],
    partyOptions: FileSyncOptions,
  ): ProtocolConnectionConfig => ({
    channel: "sftp",
    server: {
      host: srv.handle.host,
      port: srv.handle.port,
      ...serverAuth(party),
      path: `${srv.handle.remoteRoot}/${tag}`,
    },
    options: {
      pollIntervalMs: 50,
      peerTimeoutMs: PEER_TIMEOUT_MS,
      inactivityTimeoutMs: PEER_TIMEOUT_MS,
      ...partyOptions,
    },
  });
  const outA = path.join(work, `${tag}-a`);
  const outB = path.join(work, `${tag}-b`);
  const settle = async (run: Promise<unknown>): Promise<PartyOutcome> =>
    run.then(
      () => ({ ok: true }),
      (error: unknown) => ({
        ok: false,
        rendered: sanitizeErrorForDisplay(error),
      }),
    );
  const [[a, b]] = await withCapturedLogs(async () => {
    const runB = settle(
      runProtocol({
        connection: connection(srv.handle.userb, options.b),
        auth: null,
        prepared: preparedFor("PartyB", ROWS_B),
        output: outB,
        verbosity: -1,
        loggerName: `${tag}-b`,
      }),
    );
    if (options.bFirst)
      await expect
        .poll(() =>
          fs.readdirSync(folder).some((n) => n.endsWith("-hello.json")),
        )
        .toBe(true);
    const runA = settle(
      runProtocol({
        connection: connection(srv.handle.usera, options.a),
        auth: null,
        prepared: preparedFor("PartyA", ROWS_A),
        output: outA,
        verbosity: -1,
        loggerName: `${tag}-a`,
      }),
    );
    return [await runA, await runB] as const;
  });
  return { a, b, outA, outB };
}

async function resultRows(folder: string): Promise<number> {
  const results = (await fsp.readdir(folder)).filter((name) =>
    name.startsWith("alcove-results-"),
  );
  expect(results).toHaveLength(1);
  const text = await fsp.readFile(path.join(folder, results[0]), "utf8");
  return text.trim().split("\n").length - 1;
}

const RETAIN: FileSyncOptions = {
  retainFiles: true,
  locklessRendezvous: true,
  timestampInFilename: true,
};

describe("against a server that refuses every rename", () => {
  for (const mode of [
    { name: "delete mode, lock rendezvous", options: {} },
    {
      name: "delete mode, lockless rendezvous",
      options: { locklessRendezvous: true },
    },
    { name: "retain mode", options: RETAIN },
  ]) {
    inProcessOnly(
      `${mode.name}: both parties writing without renaming complete, ` +
        "issuing no rename and opening no temporary name",
      async () => {
        srv.inject.refuseEveryRename = true;
        srv.inject.renamesReceived = 0;
        srv.inject.pathsOpenedForWrite = [];
        try {
          const tag = mode.name.replace(/[^a-z]+/g, "-");
          const options = { ...mode.options, writeWithoutRenaming: true };
          const run = await runPair(tag, { a: options, b: options });

          expect(run.a).toEqual({ ok: true });
          expect(run.b).toEqual({ ok: true });
          expect(await resultRows(run.outA)).toBe(2);
          expect(await resultRows(run.outB)).toBe(2);
          expect(srv.inject.renamesReceived).toBe(0);
          expect(srv.inject.pathsOpenedForWrite.length).toBeGreaterThan(0);
          expect(
            srv.inject.pathsOpenedForWrite.filter((p) =>
              path.posix.basename(p).startsWith("temp-"),
            ),
          ).toEqual([]);
        } finally {
          srv.inject.refuseEveryRename = false;
        }
      },
      TEST_TIMEOUT_MS,
    );
  }

  inProcessOnly(
    "a party without the option ends the run naming it as the likely remedy",
    async () => {
      srv.inject.refuseEveryRename = true;
      try {
        const run = await runPair("mode-off", {
          a: { peerTimeoutMs: 3_000 },
          b: { peerTimeoutMs: 3_000 },
        });
        for (const party of [run.a, run.b]) {
          expect(party.ok).toBe(false);
          expect(party.rendered).toContain("could not be written");
          expect(party.rendered).toContain("The server may not allow renames.");
          expect(party.rendered).toContain("--write-without-renaming");
        }
      } finally {
        srv.inject.refuseEveryRename = false;
      }
    },
    TEST_TIMEOUT_MS,
  );
});

inProcessOnly(
  "a lock-path joiner writing without renaming and a partner without it " +
    "complete the exchange",
  async () => {
    srv.inject.renamesReceived = 0;
    srv.inject.pathsOpenedForWrite = [];
    const run = await runPair("mixed", {
      a: { writeWithoutRenaming: true },
      b: {},
      bFirst: true,
    });
    const opened = srv.inject.pathsOpenedForWrite.map((p) =>
      path.posix.basename(p),
    );
    expect(opened.some((n) => n.endsWith("-joining.json"))).toBe(true);
    expect(opened.some((n) => n.startsWith("temp-hello-"))).toBe(true);
    expect(run.a).toEqual({ ok: true });
    expect(run.b).toEqual({ ok: true });
    expect(await resultRows(run.outA)).toBe(2);
    expect(await resultRows(run.outB)).toBe(2);
    expect(srv.inject.renamesReceived).toBeGreaterThan(0);
  },
  TEST_TIMEOUT_MS,
);
