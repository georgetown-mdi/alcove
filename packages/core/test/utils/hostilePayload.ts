import type { MessageConnection } from "../../src/connection/messageConnection";
import { partFrame, payloadPartBody } from "./matchedListPartFrames";

/**
 * `conn` with this party's outbound payload frame swapped for `hostilePayload`
 * and every other frame untouched: a partner that reaches the wire directly
 * rather than through `prepareForExchange`/`runExchange`, bypassing the send
 * gate.
 */
export function withHostilePayload(
  conn: MessageConnection,
  hostilePayload: unknown,
): MessageConnection {
  return {
    send: (data) => {
      const outgoing =
        payloadPartBody(data) !== undefined ? partFrame(hostilePayload) : data;
      return conn.send(outgoing);
    },
    receive: (timeoutMs?: number) => conn.receive(timeoutMs),
    close: () => conn.close(),
  };
}
