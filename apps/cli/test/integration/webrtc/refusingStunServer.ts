import { createSocket } from "node:dgram";

import type { RTCIceServer } from "werift";

/** RFC 5389 section 6: the fixed header every STUN message opens with. */
const STUN_HEADER_BYTES = 20;
const STUN_MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_ERROR_RESPONSE = 0x0111;
const ERROR_CODE_ATTRIBUTE = 0x0009;
const ERROR_REASON = Buffer.from("Bad Request");

/** A loopback STUN server the harness starts, and what a peer configures to use it. */
export interface RefusingStunServer {
  /** A configured list naming only this server. */
  readonly iceServers: Array<RTCIceServer>;
  stop(): Promise<void>;
}

/**
 * A binding error response (400) to `request`, echoing its transaction id: the
 * shape werift fails the binding query on at once.
 */
function bindingErrorResponse(request: Buffer): Buffer {
  const valueBytes = 4 + ERROR_REASON.length;
  const paddedValueBytes = Math.ceil(valueBytes / 4) * 4;
  const response = Buffer.alloc(STUN_HEADER_BYTES + 4 + paddedValueBytes);
  response.writeUInt16BE(BINDING_ERROR_RESPONSE, 0);
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
 * request with an error. werift gives up the server-reflexive query on the
 * answer instead of on its 5 s gathering timer, so a peer configured with it
 * gathers the same host-only candidates as one naming a server nobody answers.
 * An ephemeral port keeps it off the fixed unanswered entry other files and
 * parallel runs rely on.
 */
export async function startRefusingStunServer(): Promise<RefusingStunServer> {
  const socket = createSocket("udp4");
  socket.on("message", (message, from) => {
    if (
      message.length < STUN_HEADER_BYTES ||
      message.readUInt16BE(0) !== BINDING_REQUEST ||
      message.readUInt32BE(4) !== STUN_MAGIC_COOKIE
    )
      return;
    socket.send(bindingErrorResponse(message), from.port, from.address, () => {
      // A peer closed before its answer landed has no query left to end.
    });
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
    stop: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}
