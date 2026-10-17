import { createSocket } from "node:dgram";

import type { RTCIceServer } from "werift";

/** RFC 5389 section 6: the fixed header every STUN message opens with. */
const STUN_HEADER_BYTES = 20;
const STUN_MAGIC_COOKIE = 0x2112a442;
const ERROR_CODE_ATTRIBUTE = 0x0009;
const ERROR_REASON = Buffer.from("Bad Request");

/** The error response type answering each request type the server refuses. */
const ERROR_RESPONSE_TYPE: ReadonlyMap<number, number> = new Map([
  [0x0001, 0x0111], // binding
  [0x0003, 0x0113], // TURN allocate
]);

/** A loopback STUN server the harness starts, and what a peer configures to use it. */
export interface RefusingStunServer {
  /** A configured list naming only this server, as a STUN server. */
  readonly iceServers: Array<RTCIceServer>;
  /** A configured list naming only this server, as a TURN server. */
  readonly turnIceServers: Array<RTCIceServer>;
  stop(): Promise<void>;
}

/**
 * An error response (400) of type `responseType` to `request`, echoing its
 * transaction id: the shape werift fails a binding or allocate query on at once.
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

/**
 * Start a STUN server on an ephemeral loopback port that answers every binding
 * and TURN allocate request with an error. werift gives up the query on the
 * answer instead of on its own timer, so a peer configured with it gathers the
 * same host-only candidates as one naming a server nobody answers, at once.
 * An ephemeral port keeps it off the fixed unanswered entry other files and
 * parallel runs rely on.
 */
export async function startRefusingStunServer(): Promise<RefusingStunServer> {
  const socket = createSocket("udp4");
  socket.on("message", (message, from) => {
    if (
      message.length < STUN_HEADER_BYTES ||
      message.readUInt32BE(4) !== STUN_MAGIC_COOKIE
    )
      return;
    const responseType = ERROR_RESPONSE_TYPE.get(message.readUInt16BE(0));
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
  const { port } = socket.address();
  return {
    iceServers: [{ urls: `stun:127.0.0.1:${port}` }],
    turnIceServers: [
      {
        urls: `turn:127.0.0.1:${port}?transport=udp`,
        username: "alcove",
        credential: "placeholder-not-a-secret",
      },
    ],
    stop: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}
