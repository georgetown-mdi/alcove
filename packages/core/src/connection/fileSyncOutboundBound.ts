// The send-side half of the file-sync inbound frame bound
// (docs/spec/FILE_SYNC.md, "Round set size limits"): the arithmetic a sender
// uses to size a PSI set's message files to the partner's read gate before
// any is written. The first-round count check and the size of each part a
// round sends (psi/psiSetParts.ts) both weigh a file against
// `MAX_FRAME_SIZE_BYTES`, the bound every file-sync receiver applies.

import { AEAD_ENVELOPE_OVERHEAD_BYTES } from "./encryptedMessageConnection";
import { MESSAGE_HEADER_BYTES } from "./fileSyncFraming";
import { MAX_FRAME_SIZE_BYTES } from "./frameSize";
import {
  PSI_ENCODED_ELEMENT_BYTES,
  PSI_SET_MAX_FRAMING_BYTES,
} from "./webrtcOutboundBound";

/**
 * The most values one PSI set in an SFTP or synced-folder message file can
 * hold under a frame bound of `maxFrameBytes`, whichever round's message
 * holds the set.
 */
export function fileSyncMaxRoundSetValues(
  maxFrameBytes: number = MAX_FRAME_SIZE_BYTES,
): number {
  // File header 10 + AEAD envelope 30 + setup framing 6, then 35 per value.
  const perFileBytes =
    MESSAGE_HEADER_BYTES +
    AEAD_ENVELOPE_OVERHEAD_BYTES +
    PSI_SET_MAX_FRAMING_BYTES;
  return Math.floor((maxFrameBytes - perFileBytes) / PSI_ENCODED_ELEMENT_BYTES);
}

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

/**
 * The remedy every file-sync set-size refusal of this party's own set names.
 */
export const SPLIT_INPUT_REMEDY =
  "Split the input into smaller files and run one exchange for each.";
