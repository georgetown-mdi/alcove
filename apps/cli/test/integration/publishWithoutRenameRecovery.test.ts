import fsp from "node:fs/promises";
import path from "node:path";

import { expect } from "vitest";
import { TransportPublishIndeterminateError } from "@alcove/core";
import { withCapturedLogs } from "@alcove/core/testing";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { startInProcessSftpServer } from "../sftpServer";
import type { InProcessSftpServer } from "../sftpServer/types";
import { inProcessOnly } from "../sftpBackendGate";
import { connectParty, type ConnectedParty } from "../sftpServer/connectParty";

// A put whose reply a dropped session lost, against the real SSH/SFTP stack. With
// write_without_renaming on, a put to the final name is the publish, so the
// recovery re-dial does not re-issue it blind: it reads what the destination
// holds (docs/spec/SFTP_SESSION_RECOVERY.md, "Re-issuing an operation"). A put
// to a protocol temp keeps its verbatim re-issue. The drop is staged by the
// in-process server's write-close tear, which cuts the session after the file is
// closed and before the reply, so only that backend runs these.

const TEST_TIMEOUT_MS = 60_000;
const STALL_DEADLINE_MS = 3_000;

// A header and a payload, the chunk list a message publish hands put().
const HEADER = Buffer.from([1, 2, 3, 4]);
const PAYLOAD = Buffer.alloc(256 * 1024, 7);
const SOURCE_BYTES = HEADER.length + PAYLOAD.length;

interface Party extends ConnectedParty {
  srv: InProcessSftpServer;
}

async function connectPartyOnOwnServer(): Promise<Party> {
  const srv = await startInProcessSftpServer();
  try {
    const party = await connectParty(srv.handle, {
      dirPrefix: "direct-put-",
      adapter: new SSH2SFTPClientAdapter({
        verbosity: -1,
        stallDeadlineMs: STALL_DEADLINE_MS,
      }),
      maxReconnectAttempts: 10,
    });
    return {
      ...party,
      srv,
      stop: async () => {
        srv.inject.tearAtWriteClose = null;
        await party.stop();
        await srv.stop();
      },
    };
  } catch (error: unknown) {
    await srv.stop();
    throw error;
  }
}

// Puts the chunk list to `name` with the next write-close torn as `tear`
// stages, and reports the outcome, how many times the server opened the file
// for writing, and its size afterwards (undefined when absent).
async function tornPut(
  party: Party,
  name: string,
  tear: "keep" | "remove" | "truncate",
): Promise<{ error: unknown; opens: number; size: number | undefined }> {
  const dest = `${party.remote}/${name}`;
  party.srv.inject.pathsOpenedForWrite = [];
  party.srv.inject.tearAtWriteClose = tear;
  const [error] = await withCapturedLogs(
    () =>
      party.adapter
        .put([HEADER, PAYLOAD], dest, { flags: "w", encoding: null })
        .then(
          () => undefined,
          (e: unknown) => e,
        ),
    (level) => level === "WARN" || level === "ERROR",
  );
  expect(party.srv.inject.tearAtWriteClose).toBeNull();
  const size = await fsp
    .stat(path.join(party.localDir, name))
    .then((st) => st.size)
    .catch(() => undefined);
  return {
    error,
    opens: party.srv.inject.pathsOpenedForWrite.filter((p) => p === dest)
      .length,
    size,
  };
}

inProcessOnly(
  "a direct put whose reply is lost is confirmed, re-issued once, or reported " +
    "indeterminate by what its destination holds",
  async () => {
    const party = await connectPartyOnOwnServer();
    try {
      // Consumed by the time the re-dialed session looks: not re-created.
      const consumed = await tornPut(party, "a-consumed.json", "remove");
      expect(consumed.error).toBeInstanceOf(TransportPublishIndeterminateError);
      expect(consumed.opens).toBe(1);
      expect(consumed.size).toBeUndefined();

      // Present and complete: the publish landed, and is not re-issued.
      const landed = await tornPut(party, "b-landed.json", "keep");
      expect(landed.error).toBeUndefined();
      expect(landed.opens).toBe(1);
      expect(landed.size).toBe(SOURCE_BYTES);

      // Present and short: re-issued exactly once, ending complete.
      const short = await tornPut(party, "c-short.json", "truncate");
      expect(short.error).toBeUndefined();
      expect(short.opens).toBe(2);
      expect(short.size).toBe(SOURCE_BYTES);

      // Each arm was a real drop the adapter re-dialed after.
      expect(party.adapter.midExchangeReconnectCount).toBe(3);
    } finally {
      await party.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "a put to a protocol temp whose reply is lost is re-issued verbatim",
  async () => {
    const party = await connectPartyOnOwnServer();
    try {
      const temp = await tornPut(
        party,
        "temp-3b1f5d0e-6a4c-4f2e-9d8b-7c6a5e4f3d2c.tmp",
        "remove",
      );
      expect(temp.error).toBeUndefined();
      expect(temp.opens).toBe(2);
      expect(temp.size).toBe(SOURCE_BYTES);
      expect(party.adapter.midExchangeReconnectCount).toBe(1);
    } finally {
      await party.stop();
    }
  },
  TEST_TIMEOUT_MS,
);
