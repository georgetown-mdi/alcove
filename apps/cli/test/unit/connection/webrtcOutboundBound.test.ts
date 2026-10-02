import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import {
  InProcessPsiEngine,
  MAX_WEBRTC_FRAME_BYTES,
  PSIParticipant,
} from "@alcove/core";
import {
  binaryPackByteStringLength,
  PSI_SET_PART_HEADER_BYTES,
  webrtcFrameReceiveCharge,
} from "@alcove/core/testing";

import { BoundedInboundFrames } from "../../../src/connection/webrtc/inboundBounds";
import {
  PEERJS_CHUNK_MTU,
  PeerJsFrameEncoder,
} from "../../../src/connection/webrtc/peerjsWire";
import { webRtcMessageConnection } from "../../../src/connection/webrtc/webrtcMessageConnection";

import type { WebRtcPeerSession } from "../../../src/connection/webrtc/weriftPeer";
import type { RTCDataChannel } from "werift";

// The CLI's half of the sender-side WebRTC frame bound: its data channel states
// the bound its own receive path applies, a PSI round over it sends a set past
// that bound in parts that path admits, and the charge the sizing weighs
// covers what this receive path charges for the frames its own chunker writes.

const psiLibrary = await PSI();

/**
 * A data channel that records what is sent and delivers nothing, calling
 * `onSend` with everything sent so far after each send.
 */
function recordingSession(
  onSend: (sent: Array<Uint8Array>) => void = () => {},
): {
  session: WebRtcPeerSession;
  sent: Array<Uint8Array>;
} {
  const sent: Array<Uint8Array> = [];
  const channel = {
    readyState: "open",
    bufferedAmount: 0,
    send: (data: Buffer) => {
      sent.push(new Uint8Array(data));
      onSend(sent);
    },
    close: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return {
    sent,
    session: {
      channel: channel as unknown as RTCDataChannel,
      isConnected: () => false,
      outboundAcknowledged: () => true,
      outboundTransmitted: () => true,
      onDisconnected: () => {},
      close: () => Promise.resolve(),
    },
  };
}

/** Every frame `datagrams` reassemble to on a receive path bounded at `max`. */
function received(datagrams: Array<Uint8Array>, max: number): Array<unknown> {
  const bounds = new BoundedInboundFrames({ maxFrameBytes: max });
  const frames: Array<unknown> = [];
  for (const datagram of datagrams) {
    const outcome = bounds.accept(datagram);
    if (outcome.kind === "frame") frames.push(outcome.value);
  }
  return frames;
}

test("the data channel states the receive bound it applies", () => {
  expect(
    webRtcMessageConnection(
      recordingSession().session,
    ).outboundWebRtcFrameBound?.(),
  ).toBe(MAX_WEBRTC_FRAME_BYTES);
  expect(
    webRtcMessageConnection(recordingSession().session, {
      inboundBounds: { maxFrameBytes: 4096 },
    }).outboundWebRtcFrameBound?.(),
  ).toBe(4096);
});

test("the check's charge covers what this receive path charges for a chunked frame", () => {
  // A receive path bounded at exactly the charge admits the frame, so a frame
  // the sender admits is never one this receiver refuses.
  for (const payload of [
    PEERJS_CHUNK_MTU,
    PEERJS_CHUNK_MTU * 2 + 7,
    PEERJS_CHUNK_MTU * 3 - 5,
    PEERJS_CHUNK_MTU * 5 + 200,
  ]) {
    const packed = binaryPackByteStringLength(payload);
    const datagrams = new PeerJsFrameEncoder().encode(new Uint8Array(payload));
    expect(received(datagrams, webrtcFrameReceiveCharge(packed))).toHaveLength(
      1,
    );
  }
});

/**
 * The parts of the setup a starter's round over the CLI data channel sends for
 * a set of `count` values, with the channel's receive bound at `bound`, as a
 * receive path bounded the same reassembles them.
 */
async function starterSetupParts(
  count: number,
  bound: number,
): Promise<unknown> {
  // A round that sent its setup waits for the partner, which never answers, so
  // the setup's last part reassembling on the bounded receive path is its end.
  let allSent: (parts: Array<Uint8Array>) => void = () => {};
  const setupOnWire = new Promise<Array<Uint8Array>>((resolve) => {
    allSent = resolve;
  });
  const { session } = recordingSession((datagrams) => {
    const parts = received(datagrams, bound).filter(
      (frame): frame is Uint8Array => frame instanceof Uint8Array,
    );
    if (parts.length === 0) return;
    const header = new DataView(parts[0].buffer, parts[0].byteOffset);
    if (parts.length === header.getUint32(4)) allSent(parts);
  });
  const conn = webRtcMessageConnection(session, {
    inboundBounds: { maxFrameBytes: bound },
  });
  const starter = new PSIParticipant(
    "server",
    psiLibrary,
    { role: "starter", verbose: -1 },
    {
      setup: Number.POSITIVE_INFINITY,
      request: Number.POSITIVE_INFINITY,
      response: Number.POSITIVE_INFINITY,
    },
  );
  const round = starter
    .identifyIntersection(
      conn,
      Array.from({ length: count }, (_unused, i) => `value-${i}`),
    )
    .then(
      () => undefined,
      (err: unknown) => err,
    );
  const settled = await Promise.race([round, setupOnWire]);
  await conn.close();
  starter.dispose();
  return settled;
}

test("a set over the bound goes in parts this receive path admits, and they hold the whole set", async () => {
  // Large enough that the setup crosses the chunk size, so the bound is the
  // chunked charge rather than the frame's own length.
  const count = 500;
  const engine = new InProcessPsiEngine(
    psiLibrary,
    "starter",
    "server",
    "identifier-revealing",
  );
  const { setup } = await engine.createServerSetup(
    Array.from({ length: count }, (_unused, i) => `value-${i}`),
  );
  engine.dispose();
  const packed = binaryPackByteStringLength(
    PSI_SET_PART_HEADER_BYTES + setup.byteLength,
  );
  expect(packed).toBeGreaterThan(PEERJS_CHUNK_MTU);
  const charge = webrtcFrameReceiveCharge(packed);

  // At the charge the setup goes whole; under it, in parts each admitted.
  for (const [bound, partCount] of [
    [charge, 1],
    [charge - 1, 2],
    [Math.floor(charge / 3), 3],
  ]) {
    const parts = await starterSetupParts(count, bound);
    expect(parts).toHaveLength(partCount);
    const setBytes = (parts as Array<Uint8Array>).reduce(
      (sum, part) => sum + part.byteLength - PSI_SET_PART_HEADER_BYTES,
      0,
    );
    expect(setBytes).toBe(setup.byteLength);
  }
});
