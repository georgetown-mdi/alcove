// The file-sync send side of the inbound frame bound (docs/spec/FILE_SYNC.md,
// "Round set size limits"): the size of the message file a frame is written
// as, against which psi/psiSetParts.ts sizes each part a round sends to
// `MAX_FRAME_SIZE_BYTES`, the bound every file-sync receiver applies.

import { MESSAGE_HEADER_BYTES } from "./fileSyncFraming";

/**
 * The size of the message file that holds a frame of `frameBytes`, sent inside
 * an envelope of `envelopeBytes`: the size the receiver's read gate compares
 * against its bound.
 */
export function fileSyncMessageFileBytes(
  frameBytes: number,
  envelopeBytes: number,
): number {
  return MESSAGE_HEADER_BYTES + envelopeBytes + frameBytes;
}
