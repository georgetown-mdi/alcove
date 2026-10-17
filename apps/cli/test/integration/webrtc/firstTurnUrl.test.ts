import { Socket, createSocket } from "node:dgram";
import dns from "node:dns";

import { RTCPeerConnection } from "werift";
import { afterEach, expect, test } from "vitest";

import {
  WERIFT_BUILT_IN_STUN_URI,
  buildPeerConfiguration,
  iceServersFromConnection,
} from "../../../src/connection/webrtc/weriftPeer";

/**
 * Which of the STUN and TURN urls a CLI run lists a real werift peer contacts
 * while it gathers. The parser test in webrtcIceConfiguration.test.ts pins
 * what `parseIceServers` keeps; this one counts the requests that reach each
 * server, so a release that gathered from more urls by any path reddens here.
 * The last records every DNS lookup and UDP send of a run that lists a TURN
 * url and no `stun` url, so a release that fell back to its built-in STUN
 * default past the unqueried entry reddens too. The assumptions and their
 * re-verification on a bump are in docs/spec/DEPENDENCY_PINS.md.
 */

/** RFC 5389 section 6: the fixed header every STUN message opens with. */
const STUN_HEADER_BYTES = 20;
const STUN_MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_ERROR_RESPONSE = 0x0111;
const ALLOCATE_REQUEST = 0x0003;
const ALLOCATE_ERROR_RESPONSE = 0x0113;
const ERROR_CODE_ATTRIBUTE = 0x0009;
const ERROR_REASON = Buffer.from("Bad Request");

/**
 * How long gathering may take. Every server answers at once with an error, so
 * gathering ends in well under a second; this leaves room for werift's own
 * timers should one of the answers be ignored.
 */
const GATHERING_TIMEOUT_MS = 30_000;

/** A loopback server that answers every STUN request with an error, counting them. */
interface CountingServer {
  readonly port: number;
  /** The STUN message types of every request received, in arrival order. */
  readonly requests: Array<number>;
  stop(): Promise<void>;
}

const openServers: Array<CountingServer> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.stop()));
});

/**
 * An error response (400) of type `responseType` to `request`, echoing its
 * transaction id: the shape werift ends a binding or allocate query on at once.
 */
function errorResponse(request: Buffer, responseType: number): Buffer {
  const valueBytes = 4 + ERROR_REASON.length;
  const paddedValueBytes = Math.ceil(valueBytes / 4) * 4;
  const response = Buffer.alloc(STUN_HEADER_BYTES + 4 + paddedValueBytes);
  response.writeUInt16BE(responseType, 0);
  response.writeUInt16BE(4 + paddedValueBytes, 2);
  request.copy(response, 4, 4, STUN_HEADER_BYTES);
  response.writeUInt16BE(ERROR_CODE_ATTRIBUTE, STUN_HEADER_BYTES);
  response.writeUInt16BE(valueBytes, STUN_HEADER_BYTES + 2);
  response.writeUInt8(4, STUN_HEADER_BYTES + 6);
  response.writeUInt8(0, STUN_HEADER_BYTES + 7);
  ERROR_REASON.copy(response, STUN_HEADER_BYTES + 8);
  return response;
}

const ERROR_RESPONSE_TYPE: ReadonlyMap<number, number> = new Map([
  [BINDING_REQUEST, BINDING_ERROR_RESPONSE],
  [ALLOCATE_REQUEST, ALLOCATE_ERROR_RESPONSE],
]);

async function startCountingServer(): Promise<CountingServer> {
  const socket: Socket = createSocket("udp4");
  const requests: Array<number> = [];
  socket.on("message", (message, from) => {
    if (
      message.length < STUN_HEADER_BYTES ||
      message.readUInt32BE(4) !== STUN_MAGIC_COOKIE
    )
      return;
    const messageType = message.readUInt16BE(0);
    requests.push(messageType);
    const responseType = ERROR_RESPONSE_TYPE.get(messageType);
    if (responseType === undefined) return;
    socket.send(
      errorResponse(message, responseType),
      from.port,
      from.address,
      () => {
        // A peer closed before its answer landed has no query left to end.
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      socket.off("error", reject);
      resolve();
    });
  });
  const server: CountingServer = {
    port: socket.address().port,
    requests,
    stop: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
  openServers.push(server);
  return server;
}

test(
  "a CLI peer contacts only the first STUN url and the first TURN url it lists",
  { timeout: GATHERING_TIMEOUT_MS + 10_000 },
  async () => {
    const [firstStun, secondStun, firstTurn, secondTurn] = await Promise.all([
      startCountingServer(),
      startCountingServer(),
      startCountingServer(),
      startCountingServer(),
    ]);
    const configuration = buildPeerConfiguration(
      iceServersFromConnection({
        stun: [
          `stun:127.0.0.1:${firstStun.port}`,
          `stun:127.0.0.1:${secondStun.port}`,
        ],
        turn: [
          {
            url: `turn:127.0.0.1:${firstTurn.port}?transport=udp`,
            username: "first-user",
            credential: "placeholder-not-a-secret",
          },
          {
            url: `turn:127.0.0.1:${secondTurn.port}?transport=udp`,
            username: "second-user",
            credential: "placeholder-not-a-secret",
          },
        ],
      }),
    );
    expect(configuration.iceServers).toHaveLength(4);

    await gatherOnce(configuration);

    expect(firstStun.requests).toContain(BINDING_REQUEST);
    expect(firstTurn.requests).toContain(ALLOCATE_REQUEST);
    expect(secondStun.requests).toEqual([]);
    expect(secondTurn.requests).toEqual([]);
  },
);

async function gatherOnce(
  configuration: ReturnType<typeof buildPeerConfiguration>,
): Promise<void> {
  const peer = new RTCPeerConnection(configuration);
  try {
    const gatheringComplete = peer.iceGatheringStateChange.watch(
      (state) => state === "complete",
      GATHERING_TIMEOUT_MS,
    );
    peer.createDataChannel("first-url-probe");
    await peer.setLocalDescription(await peer.createOffer());
    await gatheringComplete;
  } finally {
    await peer.close();
  }
}

test(
  "a CLI peer allocates on the relay allowed_relays lists, not on the invitation's relay it leaves out",
  { timeout: GATHERING_TIMEOUT_MS + 10_000 },
  async () => {
    const [leftOut, listed] = await Promise.all([
      startCountingServer(),
      startCountingServer(),
    ]);
    const configuration = buildPeerConfiguration(
      iceServersFromConnection(
        {
          invitationRelay: {
            turn: [
              `turn:127.0.0.1:${leftOut.port}?transport=udp`,
              `turn:127.0.0.1:${listed.port}?transport=udp`,
            ],
          },
          allowedRelays: [`127.0.0.1:${listed.port}`],
        },
        {
          username: "1:alcove",
          credential: "placeholder-not-a-secret",
          expiresAt: new Date(1000),
        },
      ),
    );

    await gatherOnce(configuration);

    expect(listed.requests).toContain(ALLOCATE_REQUEST);
    expect(leftOut.requests).toEqual([]);
  },
);

/** What a gather looked up and sent, and how long it took. */
interface GatherTraffic {
  /** Every hostname resolved through either form of `dns.lookup`. */
  lookups: Array<string>;
  /** The `host:port` of every datagram sent by a socket other than `servers`. */
  sends: Array<string>;
  gatheringMs: number;
}

/**
 * Gather once with `configuration`, recording every DNS lookup and every UDP
 * send. A lookup is failed rather than answered, so nothing reaches the
 * network; the attempt alone is what the assertions read.
 */
async function gatherRecordingTraffic(
  configuration: ReturnType<typeof buildPeerConfiguration>,
  servers: ReadonlyArray<CountingServer> = [],
): Promise<GatherTraffic> {
  const serverPorts = new Set(servers.map((server) => server.port));
  const traffic: GatherTraffic = { lookups: [], sends: [], gatheringMs: 0 };
  const realPromiseLookup = dns.promises.lookup;
  const realCallbackLookup = dns.lookup;
  const realSend = Socket.prototype.send;
  (dns.promises as { lookup: unknown }).lookup = (hostname: string) => {
    traffic.lookups.push(hostname);
    return Promise.reject(new Error("lookup refused by the traffic check"));
  };
  (dns as { lookup: unknown }).lookup = (
    hostname: string,
    options: unknown,
    callback: unknown,
  ): void => {
    traffic.lookups.push(hostname);
    const cb = (typeof options === "function" ? options : callback) as (
      err: Error,
    ) => void;
    cb(new Error("lookup refused by the traffic check"));
  };
  (Socket.prototype as { send: unknown }).send = function (
    this: Socket,
    ...args: Array<unknown>
  ) {
    if (!serverPorts.has(this.address().port)) {
      const [port, address] =
        typeof args[1] === "number" ? [args[1], args[2]] : [args[3], args[4]];
      traffic.sends.push(`${String(address)}:${String(port)}`);
    }
    return (realSend as (...rest: Array<unknown>) => void).apply(this, args);
  };
  const startedAt = Date.now();
  try {
    await gatherOnce(configuration);
  } finally {
    traffic.gatheringMs = Date.now() - startedAt;
    (dns.promises as { lookup: unknown }).lookup = realPromiseLookup;
    (dns as { lookup: unknown }).lookup = realCallbackLookup;
    (Socket.prototype as { send: unknown }).send = realSend;
  }
  return traffic;
}

/**
 * werift's own wait for a STUN answer is 5 s; a gather that ends well inside it
 * queried no server that did not answer.
 */
const PROMPT_GATHERING_MS = 2_500;

test(
  "a CLI peer whose connection names a TURN url and no stun url contacts only that relay",
  { timeout: GATHERING_TIMEOUT_MS + 10_000 },
  async () => {
    const relay = await startCountingServer();
    const listed = iceServersFromConnection({
      turn: [
        {
          url: `turn:127.0.0.1:${relay.port}?transport=udp`,
          username: "alcove",
          credential: "placeholder-not-a-secret",
        },
      ],
    });
    const traffic = await gatherRecordingTraffic(
      buildPeerConfiguration(listed),
      [relay],
    );
    expect(traffic.lookups).toEqual([]);
    expect(traffic.sends.length).toBeGreaterThan(0);
    for (const send of traffic.sends)
      expect(send).toBe(`127.0.0.1:${relay.port}`);
    expect(relay.requests).toContain(ALLOCATE_REQUEST);
    expect(relay.requests).not.toContain(BINDING_REQUEST);
    expect(traffic.gatheringMs).toBeLessThan(PROMPT_GATHERING_MS);

    // The control: the same list handed to werift as it stands gathers against
    // its built-in default, whose lookup the recorder sees.
    const bare = await gatherRecordingTraffic({ iceServers: listed }, [relay]);
    expect(bare.lookups).toContain(
      /^stun:([^:]+):/.exec(WERIFT_BUILT_IN_STUN_URI)?.[1],
    );
  },
);
