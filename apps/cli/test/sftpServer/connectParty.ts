import fsp from "node:fs/promises";
import path from "node:path";

import { FileSyncConnection } from "@alcove/core";
import { withCapturedLogs } from "@alcove/core/testing";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { serverAuth } from "./testContext";
import type { SftpServerHandle } from "./types";

/** One party connected to the test server over a directory of its own. */
export interface ConnectedParty {
  adapter: SSH2SFTPClientAdapter;
  conn: FileSyncConnection;
  /** The party's directory as the server path the connection opened. */
  remote: string;
  /** The same directory on the host, for planting and reading files. */
  localDir: string;
  /** Close the connection and remove the directory. */
  stop: () => Promise<void>;
}

/** How {@link connectParty} builds and dials the party. */
export interface ConnectPartyOptions {
  /** Prefix of the party's directory name under the served root. */
  dirPrefix: string;
  /**
   * The adapter to dial with, for a case that instruments it before the dial;
   * by default a quiet one built as protocol.ts builds it.
   */
  adapter?: SSH2SFTPClientAdapter;
  pollingFrequency?: number;
  maxReconnectAttempts?: number;
  /** Capture the dial's log lines instead of letting them reach the console. */
  quietOpen?: boolean;
}

/**
 * Connect one party to `server` over a fresh directory of its own (never a
 * shared one; see sftpConnection.test.ts's header). A dial that fails closes
 * what it opened and removes the directory before rethrowing, since no caller
 * holds either yet.
 */
export async function connectParty(
  server: SftpServerHandle,
  options: ConnectPartyOptions,
): Promise<ConnectedParty> {
  let allocatedDir: string | undefined;
  let openedConn: FileSyncConnection | undefined;
  try {
    const localDir = await fsp.mkdtemp(
      path.join(server.backingDir, options.dirPrefix),
    );
    allocatedDir = localDir;
    const remote = `${server.remoteRoot}/${path.basename(localDir)}`;
    const adapter =
      options.adapter ?? new SSH2SFTPClientAdapter({ verbosity: -1 });
    const conn = new FileSyncConnection(adapter, {
      verbose: -1,
      pollingFrequency: options.pollingFrequency ?? 10,
    });
    openedConn = conn;
    conn.on("error", () => {});
    const open = () =>
      conn.open({
        channel: "sftp",
        server: {
          host: server.host,
          port: server.port,
          ...serverAuth(server.usera),
          path: remote,
        },
        ...(options.maxReconnectAttempts === undefined
          ? {}
          : {
              options: { maxReconnectAttempts: options.maxReconnectAttempts },
            }),
      });
    if (options.quietOpen) await withCapturedLogs(open, () => true);
    else await open();
    return {
      adapter,
      conn,
      remote,
      localDir,
      stop: async () => {
        await conn.close().catch(() => {});
        await fsp.rm(localDir, { recursive: true, force: true });
      },
    };
  } catch (error: unknown) {
    await openedConn?.close().catch(() => {});
    if (allocatedDir !== undefined)
      await fsp.rm(allocatedDir, { recursive: true, force: true });
    throw error;
  }
}
