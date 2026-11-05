// The memory an inbound frame takes, per byte of the frame, while it is read
// and handled. The figures and how each was measured: docs/spec/FILE_SYNC.md,
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
 * worker's copy, and what the engine builds from it.
 */
export function psiFrameHandlingBytes(
  frameBytes: number,
  use: InboundPsiFrameUse,
): number {
  const { workerClone, psiDecode, streamedSetup } =
    INBOUND_FRAME_MEMORY_MULTIPLES;
  return (
    frameBytes * (workerClone + (use === "decode" ? psiDecode : streamedSetup))
  );
}

/**
 * The most memory a PSI frame of `frameBytes` takes from its read to the end
 * of its handling: the larger of the read, charged as the file-sync read gate
 * charges it ({@link inboundFrameReadBytes}), and of the frame held beside its
 * handling. The two do not add, since a collection between them releases
 * the read's copies (docs/spec/FILE_SYNC.md, "Memory an inbound frame takes").
 */
export function inboundPsiFramePeakBytes(
  frameBytes: number,
  use: InboundPsiFrameUse,
  encrypted: boolean,
  envelopeVersion: number | undefined,
): number {
  return Math.max(
    inboundFrameReadBytes(frameBytes, encrypted, envelopeVersion),
    frameBytes + psiFrameHandlingBytes(frameBytes, use),
  );
}
