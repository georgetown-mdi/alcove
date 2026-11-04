import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ConnectionError,
  FileSyncConnection,
  firstLinkBehindTransportWraps,
  fromEventConnection,
} from "@alcove/core";
import type { PutOptions, PutSource } from "@alcove/core";

import { LocalFSClient } from "../../../src/connection/localFSClient";
import { exitCodeForError } from "../../../src/util/exit";

// Once the encryption layer has taken over, a partner's JSON message is
// refused as a security failure and the file consumed: deleted in delete mode,
// acknowledged in retain mode. When that cleanup fails, the run warns and
// still ends with the refusal and its exit code. Each case drives the real
// FileSyncConnection over the CLI's filedrop client, through the real bridge,
// into the real exit mapping.

const A = "party-a";
const B = "party-b";

// The code the refusal ends with when its cleanup succeeds.
const REFUSAL_EXIT_CODE = 69;

const permissionDenied = (): Error =>
  Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });

class FaultingClient extends LocalFSClient {
  failDeletes = false;
  failPuts = false;

  override async delete(filePath: string): Promise<void> {
    if (this.failDeletes) throw permissionDenied();
    return super.delete(filePath);
  }

  override async put(
    src: PutSource,
    dest: string,
    options?: PutOptions,
  ): Promise<void> {
    if (this.failPuts) throw permissionDenied();
    return super.put(src, dest, options);
  }
}

let tmpDir: string;
let dropDir: string;
let open: FileSyncConnection[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-refused-cleanup-"));
  dropDir = path.join(tmpDir, "drop");
  fs.mkdirSync(dropDir);
  open = [];
});

afterEach(async () => {
  for (const conn of open) conn.stop();
  await Promise.allSettled(open.map((conn) => conn.close()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const MODES = [
  {
    mode: "delete mode",
    options: {},
    arm: (client: FaultingClient) => (client.failDeletes = true),
    warning:
      /could not delete the refused message file \(two attempts\)\. In delete mode/,
  },
  {
    mode: "retain mode",
    options: {
      retainFiles: true,
      timestampInFilename: true,
      locklessRendezvous: true,
    },
    arm: (client: FaultingClient) => (client.failPuts = true),
    warning:
      /could not acknowledge the refused message file: EACCES: permission denied\. In retain mode each message read is acknowledged by writing a file, so this party must be able to create files in the exchange directory\.$/,
  },
];

describe.each(MODES)("in $mode", ({ options, arm, warning }) => {
  test("a refused message whose cleanup fails warns and ends with the refusal", async () => {
    const client = new FaultingClient();
    const connA = new FileSyncConnection(client, {
      verbose: -1,
      pollingFrequency: 10,
      peerId: A,
    });
    const connB = new FileSyncConnection(new LocalFSClient(), {
      verbose: -1,
      pollingFrequency: 10,
      peerId: B,
    });
    open.push(connA, connB);
    const config = {
      channel: "filedrop" as const,
      path: dropDir,
      options: { inactivityTimeoutMs: 60_000, ...options },
    };
    await Promise.all([connA.open(config), connB.open(config)]);
    await Promise.all([connA.synchronize(), connB.synchronize()]);
    const warn = vi
      .spyOn(
        (connA as unknown as { log: { warn: (message: string) => void } }).log,
        "warn",
      )
      .mockImplementation(() => {});
    const bridge = fromEventConnection(connA, { inactivityTimeoutMs: 60_000 });
    connA.requireBinaryFrames();
    arm(client);
    await connB.send({ terms: 1 });
    connB.markLastSentUnread();
    connA.start();

    const outcome = await Promise.allSettled([bridge.receive()]);

    expect(outcome[0].status).toBe("rejected");
    const err = (outcome[0] as PromiseRejectedResult).reason as unknown;
    const refusal = firstLinkBehindTransportWraps(err);
    expect(refusal).toBeInstanceOf(ConnectionError);
    expect((refusal as ConnectionError).kind).toBe("security");
    expect((refusal as Error).message).toMatch(
      /unencrypted message on an encrypted channel/,
    );
    expect(exitCodeForError(err)).toBe(REFUSAL_EXIT_CODE);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      expect.stringMatching(warning),
    ]);
  });
});
