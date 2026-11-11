import { createServer } from "node:http";
import { once } from "node:events";

import { findSshd, startNativeSshdServer } from "@alcove/testkit/nativeSshd";
import { SFTP_RELAY_PATH } from "@alcove/sftp-relay/protocol";
import { attachSftpRelay } from "@alcove/sftp-relay";

import type {
  NativeSshdHostKeyType,
  NativeSshdServer,
} from "@alcove/testkit/nativeSshd";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { SftpRelay } from "@alcove/sftp-relay";

/**
 * The Node half of the browser SSH client cases, registered as vitest browser
 * commands on the `browser` project (apps/web/vite.config.ts): a native sshd
 * (`@alcove/testkit/nativeSshd`) behind the SFTP relay (packages/sftp-relay),
 * attached in this process to a loopback HTTP server and admitting only the
 * page's own origin. A page cannot spawn sshd or authorize a key, so it asks
 * here. Loaded by Node's type stripping, not Vite: every relative import keeps
 * its `.ts` extension.
 */

/** What the page asks for. */
export interface SshTargetOptions {
  /** The page's `location.origin`, the one origin the relay admits. */
  origin: string;
  hostKeyTypes?: ReadonlyArray<NativeSshdHostKeyType>;
  extraDirectives?: ReadonlyArray<string>;
}

/** A started target, as the page sees it. */
export interface SshTarget {
  id: number;
  /** The relay's `ws://` url, its path included. */
  relayUrl: string;
  username: string;
  hostKeyFingerprints: Partial<Record<NativeSshdHostKeyType, string>>;
}

interface RunningTarget {
  sshd: NativeSshdServer;
  server: Server;
  relay: SftpRelay;
}

const targets = new Map<number, RunningTarget>();
let nextId = 1;

/**
 * Whether this machine has an sshd to start. A Linux sshd also needs its
 * privilege-separation directory, and without it fails to start, loudly,
 * rather than being skipped: only the browser legs need it.
 */
export function sshTargetAvailable(): boolean {
  return findSshd() !== null;
}

async function startTarget(options: SshTargetOptions): Promise<SshTarget> {
  const sshd = await startNativeSshdServer({
    ...(options.hostKeyTypes === undefined
      ? {}
      : { hostKeyTypes: options.hostKeyTypes }),
    ...(options.extraDirectives === undefined
      ? {}
      : { extraDirectives: options.extraDirectives }),
  });
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const relay = attachSftpRelay(server, {
    target: { host: sshd.handle.host, port: sshd.handle.port },
    allowedOrigins: [options.origin],
    reportFault: (message) => console.error(`[sftp-relay] ${message}`),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const id = nextId++;
  targets.set(id, { sshd, server, relay });
  return {
    id,
    relayUrl: `ws://127.0.0.1:${port}${SFTP_RELAY_PATH}`,
    username: sshd.handle.usera.username,
    hostKeyFingerprints: sshd.handle.hostKeyFingerprints,
  };
}

function running(id: number): RunningTarget {
  const target = targets.get(id);
  if (target === undefined) throw new Error(`no SSH target ${id} is running`);
  return target;
}

async function stopTarget(id: number): Promise<void> {
  const target = targets.get(id);
  if (target === undefined) return;
  targets.delete(id);
  target.relay.close();
  target.server.closeAllConnections();
  await new Promise((resolve) => target.server.close(resolve));
  await target.sshd.stop();
}

/** The commands, by the names the page calls them. */
export const sshTargetCommands = {
  sshTargetAvailable: (): boolean => sshTargetAvailable(),
  startSshTarget: (
    _context: unknown,
    options: SshTargetOptions,
  ): Promise<SshTarget> => startTarget(options),
  authorizeSshKey: (
    _context: unknown,
    id: number,
    line: string,
  ): Promise<void> => running(id).sshd.authorizeKey(line),
  stopSshTarget: (_context: unknown, id: number): Promise<void> =>
    stopTarget(id),
};
