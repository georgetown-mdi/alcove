// The memory an inbound frame takes, per byte of the frame, while it is read
// and handled. The figures and how each was measured: docs/spec/FILE_SYNC_MEMORY.md,
// "Memory an inbound frame takes".

import { CHUNKED_ENVELOPE_VERSION } from "./chunkedAead";

/**
 * The most memory opening a version-2 frame was measured to take above the
 * frame itself, at any size measured (docs/spec/TRANSPORT_BOUNDS.md, Inbound
 * frame-size bound).
 */
export const CHUNKED_OPEN_PEAK_BYTES = 101_023_744;

/** The measured multiples of an inbound frame's size, by what is done with it. */
export const INBOUND_FRAME_MEMORY_MULTIPLES = {
  /** Reading a frame and decrypting it with AES-GCM in one call (envelope version 1), the frame and its plaintext included. */
  aeadOpen: 4,
  /** Decoding a PSI request into the library's objects, beyond the frame itself. */
  psiDecode: 7.65,
  /** A PSI setup or response the engine takes in pieces, beyond the frame itself. */
  streamedSetup: 1,
  /** The copy of a frame the PSI worker holds. */
  workerClone: 1,
  /**
   * A single-pass reply handed to the PSI worker over file-sync, beyond the
   * frame: its setup in pieces and its response moved, not copied.
   */
  handedOverReply: 1.2,
  /**
   * A single-pass reply in one frame copied to the PSI worker, beyond the
   * frame: its setup and its response are views of the frame's buffer, and
   * posting each copies that whole buffer.
   */
  copiedReply: 3.9,
  /**
   * A single-pass request handed over to the PSI worker over file-sync and
   * masked there, beyond the frame: its decoding, the masking and the
   * response built.
   */
  handedOverRequest: 30.1,
  /**
   * A single-pass request copied to the PSI worker and masked there, beyond
   * the frame: the worker's copy, its decoding, the masking and the response
   * built.
   */
  copiedRequest: 31,
} as const;

/**
 * What the PSI engine does with a partner frame: decode it whole (a request),
 * or take it in pieces (a setup or a response).
 */
export type InboundPsiFrameUse = "decode" | "stream";

/**
 * The memory reading one frame of `frameBytes` takes: the frame and, on an
 * encrypted connection, its decryption. Under the chunked envelope
 * (`envelopeVersion` 2) that is the frame and {@link CHUNKED_OPEN_PEAK_BYTES};
 * under version 1, or before a version is negotiated, the `aeadOpen` multiple.
 */
export function inboundFrameReadBytes(
  frameBytes: number,
  encrypted: boolean,
  envelopeVersion?: number,
): number {
  if (!encrypted) return frameBytes;
  return envelopeVersion === CHUNKED_ENVELOPE_VERSION
    ? frameBytes + CHUNKED_OPEN_PEAK_BYTES
    : frameBytes * INBOUND_FRAME_MEMORY_MULTIPLES.aeadOpen;
}

/**
 * The memory handing a frame already read to the PSI worker adds: the
 * worker's copy, unless the frame is `transferred` rather than copied, and
 * what the engine builds from it.
 */
export function psiFrameHandlingBytes(
  frameBytes: number,
  use: InboundPsiFrameUse,
  transferred: boolean = false,
): number {
  const { workerClone, psiDecode, streamedSetup } =
    INBOUND_FRAME_MEMORY_MULTIPLES;
  return (
    frameBytes *
    ((transferred ? 0 : workerClone) +
      (use === "decode" ? psiDecode : streamedSetup))
  );
}

/**
 * The memory handing a single-pass request or reply read over file-sync to
 * the PSI worker adds, beyond the frame: the request moved and masked, at the
 * measured `handedOverRequest` multiple, or the reply at the measured
 * `handedOverReply` multiple.
 */
export function fileSyncSinglePassHandOffBytes(
  frameBytes: number,
  use: InboundPsiFrameUse,
): number {
  return (
    frameBytes *
    (use === "decode"
      ? INBOUND_FRAME_MEMORY_MULTIPLES.handedOverRequest
      : INBOUND_FRAME_MEMORY_MULTIPLES.handedOverReply)
  );
}

/**
 * The memory handing a single-pass request or reply read over WebRTC to the
 * PSI worker adds, beyond the frame: the request copied and masked, at the
 * measured `copiedRequest` multiple; a reply in one frame, not `inParts`, at
 * the measured `copiedReply` multiple; and a reply in parts at the worker's
 * copy and what the engine builds ({@link psiFrameHandlingBytes}).
 */
export function webRtcSinglePassHandOffBytes(
  frameBytes: number,
  use: InboundPsiFrameUse,
  inParts: boolean,
): number {
  if (use === "decode")
    return frameBytes * INBOUND_FRAME_MEMORY_MULTIPLES.copiedRequest;
  return inParts
    ? psiFrameHandlingBytes(frameBytes, use)
    : frameBytes * INBOUND_FRAME_MEMORY_MULTIPLES.copiedReply;
}

/**
 * The measured multiples of one part's size that a message sent in parts over
 * a WebRTC data channel takes beyond the message itself, under the application
 * envelope at version 2 (docs/spec/TRANSPORT_BOUNDS.md, Memory a message in
 * parts takes).
 */
export const WEBRTC_PART_MEMORY_MULTIPLES = {
  /** Receiving a message in parts and joining it, beyond the joined message. */
  read: 5,
  /** Sending a message in parts, beyond the message. */
  send: 5.2,
} as const;

/**
 * The memory receiving a message of `messageBytes` in parts of at most
 * `partBytes` takes over WebRTC: the joined message and the part being read.
 */
export function webRtcMessageReadBytes(
  messageBytes: number,
  partBytes: number,
): number {
  return (
    messageBytes +
    WEBRTC_PART_MEMORY_MULTIPLES.read * Math.min(messageBytes, partBytes)
  );
}

/**
 * The memory sending a message of `messageBytes` in parts of at most
 * `partBytes` takes over WebRTC: the message and the part being sent.
 */
export function webRtcMessageSendBytes(
  messageBytes: number,
  partBytes: number,
): number {
  return (
    messageBytes +
    WEBRTC_PART_MEMORY_MULTIPLES.send * Math.min(messageBytes, partBytes)
  );
}

/**
 * The most memory a single-pass frame of `frameBytes` read over file-sync
 * takes from its read to the end of its handling: the larger of the read,
 * charged as the file-sync read gate charges it ({@link inboundFrameReadBytes}),
 * and of the frame held beside its hand-off
 * ({@link fileSyncSinglePassHandOffBytes}). The two do not add, since a
 * collection between them releases the read's copies (docs/spec/FILE_SYNC_MEMORY.md,
 * "Memory an inbound frame takes").
 */
export function inboundPsiFramePeakBytes(
  frameBytes: number,
  use: InboundPsiFrameUse,
  encrypted: boolean,
  envelopeVersion: number | undefined,
): number {
  return Math.max(
    inboundFrameReadBytes(frameBytes, encrypted, envelopeVersion),
    frameBytes + fileSyncSinglePassHandOffBytes(frameBytes, use),
  );
}
