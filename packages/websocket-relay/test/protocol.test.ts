import { describe, expect, it } from "vitest";

import { PEERJS_CHUNK_MTU, PeerJsFrameEncoder } from "@alcove/core";

import { RELAY_MAX_MESSAGE_BYTES } from "../src/protocol.ts";

// The widest envelope a chunk of core's framing takes around its slice: the
// map header, the four keys, three integers at BinaryPack's widest integer
// marker, and the slice's bin16 header (MAX_PEERJS_CHUNK_ENVELOPE_BYTES in
// packages/core/src/connection/webrtcOutboundBound.ts).
const WIDEST_CHUNK_ENVELOPE_BYTES = 1 + 11 + 2 + 5 + 6 + 3 * 9 + 3;

describe("the per-message cap", () => {
  it("is above the largest chunk core's framing sends, and within 16 KiB", () => {
    expect(PEERJS_CHUNK_MTU + WIDEST_CHUNK_ENVELOPE_BYTES).toBeLessThanOrEqual(
      RELAY_MAX_MESSAGE_BYTES,
    );
    expect(RELAY_MAX_MESSAGE_BYTES).toBe(16 * 1024);
  });

  it("passes every message core's encoder makes of a frame many chunks long", () => {
    const encoder = new PeerJsFrameEncoder();
    const frame = new Uint8Array(PEERJS_CHUNK_MTU * 300 + 17).fill(0xa5);
    const messages = encoder.encode(frame);
    expect(messages.length).toBeGreaterThan(300);
    const largest = Math.max(...messages.map((message) => message.byteLength));
    expect(largest).toBeGreaterThan(PEERJS_CHUNK_MTU);
    expect(largest).toBeLessThanOrEqual(RELAY_MAX_MESSAGE_BYTES);
  });
});
