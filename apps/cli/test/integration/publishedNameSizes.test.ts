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

// The rule an operator's external mover applies to a file an exchange put in
// the folder: a name ending in a byte count is complete only when the file's
// size equals that count, and any other final name is zero-length
// (docs/EXCHANGE_REFERENCE.md, Moving files out of the folder). Two whole
// runProtocol parties exchange over the real SSH/SFTP stack in each publish
// mode and rendezvous mode, and the server records the size of every file at
// the moment it was put in place. Only the in-process backend has that record.

const TEST_TIMEOUT_MS = 120_000;
const PEER_TIMEOUT_MS = 30_000;

// The one pattern a mover matches a sized name with.
const SIZED_NAME = /-([0-9]+)\.json$/;

let srv: InProcessSftpServer;
let work: string;

beforeAll(async () => {
  srv = await startInProcessSftpServer();
  work = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-name-sizes-"));
});

afterAll(async () => {
  await srv?.stop();
  if (work !== undefined) fs.rmSync(work, { recursive: true, force: true });
});

interface PartyOutcome {
  ok: boolean;
  rendered?: string;
}

// `bFirst` starts A only once B's hello is in the folder, so A arrives as the
// lock-path joiner and writes the joining sentinel.
async function runPair(
  tag: string,
  options: FileSyncOptions,
  bFirst: boolean,
): Promise<{ a: PartyOutcome; b: PartyOutcome }> {
  const folder = path.join(srv.handle.backingDir, tag);
  await fsp.mkdir(folder, { recursive: true });
  const connection = (
    party: (typeof srv.handle)["usera"],
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
      ...options,
    },
  });
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
        connection: connection(srv.handle.userb),
        auth: null,
        prepared: preparedFor("PartyB", [
          { first_name: "Bob" },
          { first_name: "Carol" },
          { first_name: "Dave" },
        ]),
        output: path.join(work, `${tag}-b`),
        verbosity: -1,
        loggerName: `${tag}-b`,
      }),
    );
    if (bFirst)
      await expect
        .poll(() =>
          fs.readdirSync(folder).some((n) => /-hello-[0-9]+\.json$/.test(n)),
        )
        .toBe(true);
    const runA = settle(
      runProtocol({
        connection: connection(srv.handle.usera),
        auth: null,
        prepared: preparedFor("PartyA", [
          { first_name: "Bob" },
          { first_name: "Carol" },
        ]),
        output: path.join(work, `${tag}-a`),
        verbosity: -1,
        loggerName: `${tag}-a`,
      }),
    );
    return [await runA, await runB] as const;
  });
  return { a, b };
}

const RENDEZVOUS_MODES: Array<{
  name: string;
  options: FileSyncOptions;
  bFirst: boolean;
  types: string[];
}> = [
  {
    name: "lock rendezvous, joiner arriving second",
    options: {},
    bFirst: true,
    types: ["hello", "joining"],
  },
  {
    name: "lockless rendezvous",
    options: { locklessRendezvous: true },
    bFirst: false,
    types: ["hello"],
  },
  {
    name: "retain mode",
    options: {
      retainFiles: true,
      locklessRendezvous: true,
      timestampInFilename: true,
    },
    bFirst: false,
    types: ["hello"],
  },
];

describe("every file an exchange puts in place under its final name states its size or is zero-length with no size", () => {
  for (const publish of [
    { name: "renaming into place", writeWithoutRenaming: false },
    { name: "writing without renaming", writeWithoutRenaming: true },
  ]) {
    for (const mode of RENDEZVOUS_MODES) {
      inProcessOnly(
        `${publish.name}, ${mode.name}`,
        async () => {
          srv.inject.filesPlaced = [];
          const tag = `${publish.name}-${mode.name}`.replace(/[^a-z]+/g, "-");
          const run = await runPair(
            tag,
            {
              ...mode.options,
              writeWithoutRenaming: publish.writeWithoutRenaming,
            },
            mode.bFirst,
          );
          expect(run.a).toEqual({ ok: true });
          expect(run.b).toEqual({ ok: true });

          const placed = srv.inject.filesPlaced;
          const temps = placed.filter((f) => f.name.startsWith("temp-"));
          const finals = placed.filter((f) => !f.name.startsWith("temp-"));
          if (publish.writeWithoutRenaming) expect(temps).toEqual([]);
          else
            for (const temp of temps)
              expect(temp.name).toMatch(/^temp-[0-9a-z-]+\.tmp$/);

          const offending = finals.filter((file) => {
            // The record is taken at CLOSE or RENAME, so a sized name is held
            // to its count even at 0 bytes.
            const match = SIZED_NAME.exec(file.name);
            if (match === null) return file.size !== 0;
            return Number(match[1]) !== file.size;
          });
          expect(offending).toEqual([]);

          // Not vacuous: the sized control files and the messages were seen.
          for (const type of mode.types)
            expect(
              finals.some((f) =>
                new RegExp(`-${type}-[0-9]+\\.json$`).test(f.name),
              ),
            ).toBe(true);
          expect(
            finals.some(
              (f) =>
                f.size > 0 &&
                !/-(hello|joining|abort)-[0-9]+\.json$/.test(f.name),
            ),
          ).toBe(true);
        },
        TEST_TIMEOUT_MS,
      );
    }
  }
});
