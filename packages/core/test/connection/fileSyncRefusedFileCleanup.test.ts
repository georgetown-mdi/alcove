import { afterEach, describe, expect, test, vi } from "vitest";

import { FileSyncConnection } from "../../src/connection/fileSyncConnection";
import {
  MESSAGE_TYPE_OBJECT,
  serializeFileSyncMessage,
} from "../../src/connection/fileSyncFraming";
import { ackMarkerName } from "../../src/connection/fileSyncNames";
import { ConnectionError, UsageError } from "../../src/errors";
import {
  driveUntilError,
  makeRetainConn,
} from "../utils/fileSyncConnectionFixture";
import { makeMockClient } from "../utils/support";

// Once the encryption layer has taken over, a partner's JSON message is
// refused as a security failure and its file consumed: deleted in delete mode,
// acknowledged in retain mode. A failure of that cleanup is warned of and the
// run still ends with the refusal.

const SELF = "self";
const PEER = "peer";
const CLEANUP_FAILURE = "EACCES: permission denied\nforged line";

interface Fixture {
  conn: FileSyncConnection;
  files: Map<string, Buffer>;
  messagePath: string;
  warn: ReturnType<typeof vi.fn>;
  failCleanupWith: (body: () => Promise<void>) => void;
}

const refusedMessage = (): Buffer =>
  serializeFileSyncMessage(
    MESSAGE_TYPE_OBJECT,
    0,
    Buffer.from(JSON.stringify({ terms: 1 })),
  );

function fixtureFor(
  conn: FileSyncConnection,
  files: Map<string, Buffer>,
  messagePath: string,
  failCleanupWith: Fixture["failCleanupWith"],
): Fixture {
  conn.requireBinaryFrames();
  const warn = vi.spyOn(conn.log, "warn").mockImplementation(() => {});
  return { conn, files, messagePath, warn, failCleanupWith };
}

const MODES = [
  {
    mode: "delete mode",
    build: (): Fixture => {
      const { client, files } = makeMockClient();
      const conn = new FileSyncConnection(client, {
        pollingFrequency: 10,
        timeToLive: new Date(Date.now() + 5_000),
        verbose: -1,
      });
      conn.id = SELF;
      conn.connected = true;
      conn.path = "/test";
      conn.peerId = PEER;
      const body = refusedMessage();
      const messagePath = `/test/${PEER}-${body.length}.json`;
      files.set(messagePath, body);
      return fixtureFor(conn, files, messagePath, (body) => {
        client.delete = body;
      });
    },
    consumed: (f: Fixture) => !f.files.has(f.messagePath),
    warning: (role: string) =>
      `[${role}] could not delete the refused message file: ` +
      "could not delete a partner message after reading it (two attempts). " +
      "In delete mode each message is deleted once read, so the account must " +
      "be allowed to delete files in the exchange directory. Grant that " +
      "permission, or have both parties set retain_files: true.",
  },
  {
    mode: "retain mode",
    build: (): Fixture => {
      const { client, files } = makeMockClient();
      const conn = makeRetainConn(client, SELF, PEER);
      const body = refusedMessage();
      const messagePath = `/shared/${PEER}-20260101T000000-000-${body.length}.json`;
      files.set(messagePath, body);
      return fixtureFor(conn, files, messagePath, (body) => {
        client.put = body;
      });
    },
    consumed: (f: Fixture) =>
      f.files.has(f.messagePath) &&
      f.files.has(
        `/shared/${ackMarkerName(
          SELF,
          f.messagePath.slice("/shared/".length, -".json".length),
        )}`,
      ),
    warning: (role: string) =>
      `[${role}] could not acknowledge the refused message file: ` +
      "EACCES: permission denied\\x0aforged line. In retain mode each message " +
      "read is acknowledged by writing a file, so the account must be allowed " +
      "to create files in the exchange directory. Grant that permission.",
  },
];

const open: FileSyncConnection[] = [];

afterEach(async () => {
  for (const conn of open.splice(0)) {
    conn.stop();
    await conn.close().catch(() => {});
  }
});

const expectRefusal = (err: unknown): void => {
  expect(err).toBeInstanceOf(ConnectionError);
  expect(err).not.toBeInstanceOf(UsageError);
  expect((err as ConnectionError).kind).toBe("security");
  expect((err as Error).message).toMatch(
    /unencrypted message on an encrypted channel/,
  );
};

describe.each(MODES)(
  "refused file cleanup in $mode",
  ({ build, consumed, warning }) => {
    test("a failed cleanup while the run is live warns once and ends with the refusal", async () => {
      const f = build();
      open.push(f.conn);
      f.failCleanupWith(async () => {
        throw new Error(CLEANUP_FAILURE);
      });

      const { errors } = await driveUntilError(f.conn);

      expect(errors).toHaveLength(1);
      expectRefusal(errors[0]);
      expect(f.warn.mock.calls.map(([message]) => message)).toEqual([
        warning(f.conn.role),
      ]);
      expect(f.warn.mock.calls[0][0]).not.toContain("[truncated]");
    });

    test("a successful cleanup logs no warning and ends with the refusal", async () => {
      const f = build();
      open.push(f.conn);

      const { errors } = await driveUntilError(f.conn);

      expect(errors).toHaveLength(1);
      expectRefusal(errors[0]);
      expect(f.warn).not.toHaveBeenCalled();
      expect(consumed(f)).toBe(true);
    });

    test("a cleanup that fails after the connection closed logs no warning and ends with no error", async () => {
      const f = build();
      open.push(f.conn);
      let enteredCleanup!: () => void;
      const entered = new Promise<void>(
        (resolve) => (enteredCleanup = resolve),
      );
      let failCleanup!: () => void;
      const gate = new Promise<void>((resolve) => (failCleanup = resolve));
      f.failCleanupWith(async () => {
        enteredCleanup();
        await gate;
        throw new Error(CLEANUP_FAILURE);
      });
      const errors: unknown[] = [];
      f.conn.on("error", (err) => errors.push(err));
      f.conn.start();
      await entered;

      const closing = f.conn.close();
      failCleanup();
      await closing;
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(f.warn).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
    });
  },
);
