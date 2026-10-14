import net from "node:net";

// Reading what an SFTP dial OFFERED, off the wire: the first binary packet of an
// SSH connection is unencrypted, so a listener in front of a real server can
// decode the client's own SSH_MSG_KEXINIT without touching key material and
// without modelling any part of ssh2 (CLAUDE.md: drive the real stack).

const SSH_MSG_KEXINIT = 20;

/**
 * The message number of SSH_MSG_DISCONNECT, the first binary packet of a dial
 * the client ends before the server's identification reaches it.
 */
export const SSH_MSG_DISCONNECT = 1;

/**
 * The two names ssh2 appends outside the offer it filters: the `ext-info`
 * marker and the Terrapin (CVE-2023-48795) strict-key-exchange marker. Losing
 * either to the key-exchange capability constraint would trade a handshake
 * failure for a downgraded handshake.
 */
export const APPENDED_MARKERS = ["ext-info-c", "kex-strict-c-v00@openssh.com"];

/**
 * The key-exchange algorithms a decoded SSH_MSG_KEXINIT payload offers.
 *
 * The packet contains ten name-lists in wire order (RFC 4253 7.1); only the
 * first is read, and the rest are skipped to nothing, so this decodes exactly
 * one packet.
 */
export function decodeOfferedKexAlgorithms(payload: Buffer): string[] {
  if (payload.readUInt8(0) !== SSH_MSG_KEXINIT)
    throw new Error(`first packet was message ${payload.readUInt8(0)}`);
  // message type (1) + cookie (16)
  const length = payload.readUInt32BE(17);
  return payload
    .subarray(21, 21 + length)
    .toString("utf8")
    .split(",");
}

/** One dial through the relay, as far as its first binary packet. */
export interface RelayedDial {
  /** The port of the upstream this dial was relayed to. */
  upstreamPort: number;
  /** The message number of the dial's first binary packet, once it is whole. */
  firstMessage?: number;
  /** The key-exchange algorithms offered, when that packet was SSH_MSG_KEXINIT. */
  offer?: string[];
}

/**
 * A relay in front of a REAL SFTP server that records the key-exchange
 * algorithms of every dial that passes through it and otherwise copies bytes
 * both ways. It reads the offer of a dial that goes on to COMPLETE its
 * handshake -- the offer of a re-dial following a dropped session, or of a
 * cycle-start re-dial in a live connection-per-poll exchange.
 *
 * `offers` records what a dial that completes its handshake said; `accepted`
 * counts every dial, including one that abandons the handshake with its own
 * SSH_MSG_KEXINIT still unread here (measured). A case about how many dials
 * there were reads `accepted()`; a case about what was offered reads `offers`
 * and waits on `offers.length`.
 *
 * `dials` records each dial's upstream and first binary packet. A dial ended
 * before the server's identification reached it sends SSH_MSG_DISCONNECT
 * first and offers nothing (backendAgnostic/kexOfferRelay.test.ts), so it is
 * recorded there and never in `offers`.
 *
 * {@link pointAt} sends later dials to a different upstream, which from the
 * client's side is one endpoint answering with a different policy than the one
 * it agreed on.
 *
 * `close` waits for the connections it relayed to end: destroying a socket
 * whose client already ended its session gracefully resets a connection the
 * ssh2 client is still finishing with, which the adapter reports on the
 * console (measured) and the integration console sentinel fails the file on.
 * A case that ends with a session still live passes `destroyLiveSessions`, or
 * the wait would hang the runner.
 */
export function createKexinitRecordingRelay(initial: {
  host: string;
  port: number;
}): {
  port: Promise<number>;
  offers: string[][];
  dials: RelayedDial[];
  accepted: () => number;
  pointAt: (target: { host: string; port: number }) => void;
  close: (options?: { destroyLiveSessions?: boolean }) => Promise<void>;
} {
  const offers: string[][] = [];
  const dials: RelayedDial[] = [];
  let target = initial;
  let accepted = 0;
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => (resolvePort = resolve));
  const live = new Set<net.Socket>();

  const server = net.createServer((client) => {
    accepted++;
    const dial: RelayedDial = { upstreamPort: target.port };
    dials.push(dial);
    const upstream = net.connect(target.port, target.host);
    live.add(client);
    live.add(upstream);
    // Either side going takes the other with it: a session the server drops has
    // to reach the client as a closed socket, or the adapter's recovery would
    // wait out its deadline for a close this relay swallowed.
    const cut = (): void => {
      client.destroy();
      upstream.destroy();
      live.delete(client);
      live.delete(upstream);
    };
    for (const socket of [client, upstream]) {
      socket.on("error", cut);
      socket.on("close", cut);
    }
    upstream.on("data", (chunk: Buffer) => client.write(chunk));

    let sniffed = Buffer.alloc(0);
    let identificationConsumed = false;
    let recorded = false;
    client.on("data", (chunk: Buffer) => {
      upstream.write(chunk);
      if (recorded) return;
      sniffed = Buffer.concat([sniffed, chunk]);
      if (!identificationConsumed) {
        const end = sniffed.indexOf("\n");
        if (end === -1) return;
        sniffed = sniffed.subarray(end + 1);
        identificationConsumed = true;
      }
      if (sniffed.length < 4) return;
      const packetLength = sniffed.readUInt32BE(0);
      if (sniffed.length < 4 + packetLength) return;
      const paddingLength = sniffed.readUInt8(4);
      const payload = sniffed.subarray(5, 4 + packetLength - paddingLength);
      recorded = true;
      dial.firstMessage = payload.readUInt8(0);
      if (dial.firstMessage !== SSH_MSG_KEXINIT) return;
      dial.offer = decodeOfferedKexAlgorithms(payload);
      offers.push(dial.offer);
    });
  });
  server.listen(0, "127.0.0.1", () => {
    resolvePort((server.address() as net.AddressInfo).port);
  });
  return {
    port,
    offers,
    dials,
    accepted: () => accepted,
    pointAt: (next) => {
      target = next;
    },
    close: ({ destroyLiveSessions = false } = {}) =>
      new Promise<void>((resolve) => {
        if (destroyLiveSessions) {
          for (const socket of live) socket.destroy();
          live.clear();
        }
        server.close(() => resolve());
      }),
  };
}
