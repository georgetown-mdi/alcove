import fsp from "node:fs/promises";
import path from "node:path";

import { afterAll, expect, test } from "vitest";
import { withCapturedLogs } from "@alcove/core/testing";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { selectedBackend, startInProcessSftpServer } from "../sftpServer";
import { remotePath, serverAuth, sftpServer } from "../sftpServer/testContext";
import { inProcessOnly } from "../sftpBackendGate";

// The SFTP adapter's put retry, driven against a real server: a refused write is
// re-issued on the same session only for SSH_FX_FAILURE (4), and a put that loses
// its session goes to session recovery instead. Attempts are read from the
// adapter's transportRetryCount, which counts every re-issue past the first.
// The raw client's status codes these rest on: sftpStackPremises.test.ts.

const TEST_TIMEOUT_MS = 60_000;

// The adapter's re-issue budget for a put when the connect options name none.
const DEFAULT_PUT_RETRIES = 5;

const SSH_FX_NO_SUCH_FILE = 2;
const SSH_FX_PERMISSION_DENIED = 3;
const SSH_FX_FAILURE = 4;

const srv = sftpServer();
const backend = selectedBackend();
const rendezvousDirs: string[] = [];

afterAll(async () => {
  for (const dir of rendezvousDirs) {
    await fsp.chmod(dir, 0o755).catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

async function freshDirectory(): Promise<{ local: string; remote: string }> {
  const local = await fsp.mkdtemp(path.join(srv.backingDir, "put-status-"));
  rendezvousDirs.push(local);
  return { local, remote: remotePath(srv, path.basename(local)) };
}

interface PutResult {
  code: unknown;
  retries: number;
}

async function putOnce(dest: string): Promise<PutResult> {
  const adapter = new SSH2SFTPClientAdapter();
  try {
    await adapter.connect({
      host: srv.host,
      port: srv.port,
      ...serverAuth(srv.usera),
    });
    const code = await adapter.put(Buffer.from("payload"), dest).then(
      () => "resolved",
      (err: unknown) => (err as { code?: unknown } | null)?.code,
    );
    return { code, retries: adapter.transportRetryCount };
  } finally {
    await adapter.end().catch(() => {});
  }
}

test(
  "a put into a missing directory fails at once, with no re-issue",
  async () => {
    const { remote } = await freshDirectory();
    expect(await putOnce(`${remote}/absent/out.bin`)).toEqual({
      code: SSH_FX_NO_SUCH_FILE,
      retries: 0,
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "a put onto a directory is re-issued within the budget and then fails",
  async () => {
    const { local, remote } = await freshDirectory();
    await fsp.mkdir(path.join(local, "subdir"));
    expect(await putOnce(`${remote}/subdir`)).toEqual({
      code: SSH_FX_FAILURE,
      retries: DEFAULT_PUT_RETRIES,
    });
  },
  TEST_TIMEOUT_MS,
);

// OpenSSH reports a write refused by file permissions as SSH_FX_PERMISSION_DENIED,
// which is not re-issued; the in-process server reports every failed open as
// SSH_FX_FAILURE, which is. Root ignores the mode bits, so the case cannot be
// staged where the server session runs as root (the native chroot profile).
test.skipIf(process.getuid?.() === 0)(
  "a put into a read-only directory is re-issued only where the server reports " +
    "SSH_FX_FAILURE",
  async () => {
    const { local, remote } = await freshDirectory();
    await fsp.chmod(local, 0o555);
    const expected =
      backend === "native"
        ? { code: SSH_FX_PERMISSION_DENIED, retries: 0 }
        : { code: SSH_FX_FAILURE, retries: DEFAULT_PUT_RETRIES };
    expect(await putOnce(`${remote}/out.bin`)).toEqual(expected);
  },
  TEST_TIMEOUT_MS,
);

// Only the in-process server can be told to drop a live session on a chosen
// operation (see test/sftpServer/types.ts), so this case stands up its own.
inProcessOnly(
  "a put whose session drops is recovered on a new session, not re-issued on " +
    "the dead one",
  async () => {
    const own = await startInProcessSftpServer();
    const local = await fsp.mkdtemp(
      path.join(own.handle.backingDir, "put-drop-"),
    );
    const remote = `${own.handle.remoteRoot}/${path.basename(local)}`;
    const adapter = new SSH2SFTPClientAdapter();
    try {
      await adapter.connect({
        host: own.handle.host,
        port: own.handle.port,
        ...serverAuth(own.handle.usera),
      });
      own.sessionControls.resetHandshakeCount();
      // The drop lands on the put's first request, its OPEN.
      own.sessionControls.dropActiveAfterOps(1);

      const [, logs] = await withCapturedLogs(
        () => adapter.put(Buffer.from("payload"), `${remote}/out.bin`),
        (level) => level === "WARN" || level === "ERROR",
      );

      expect({
        landed: await fsp.readFile(path.join(local, "out.bin"), "utf8"),
        sessionsLost: adapter.midExchangeReconnectCount,
        handshakes: own.sessionControls.handshakeCount(),
        sameSessionRetries: adapter.transportRetryCount,
        recoveryWarnings: logs.filter((entry) =>
          entry.message.includes("dropped mid-exchange and was transparently"),
        ).length,
      }).toEqual({
        landed: "payload",
        sessionsLost: 1,
        handshakes: 1,
        sameSessionRetries: 0,
        recoveryWarnings: 1,
      });
    } finally {
      own.sessionControls.dropActiveAfterOps(0);
      await adapter.end().catch(() => {});
      await fsp.rm(local, { recursive: true, force: true });
      await own.stop();
    }
  },
  TEST_TIMEOUT_MS,
);
