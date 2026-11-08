import {
  PSI_ENCODED_ELEMENT_BYTES,
  PSI_SET_MAX_FRAMING_BYTES,
} from "./webrtcOutboundBound";

/**
 * Maximum size, in bytes, of a single inbound frame the transport reads into
 * memory, except a single-pass request or reply, which is held to the cap the
 * counts derive for it (docs/spec/TRANSPORT_BOUNDS.md, Inbound frame-size
 * bound). A literal rather than `buffer.constants`, so the AEAD decorator
 * importing it needs no Node `buffer`.
 */
export const MAX_FRAME_SIZE_BYTES = 536_870_888;

/**
 * The most a per-exchange cap raises the file-sync read gate to: the largest
 * exact integer, which is also Node's `buffer.constants.MAX_LENGTH` on a 64-bit
 * host. Nothing in the transport bounds a frame below it; memory is checked
 * before each read, and an encrypted connection holds a frame to the AEAD's
 * own limit.
 */
export const MAX_DERIVED_FRAME_BYTES = Number.MAX_SAFE_INTEGER;

/**
 * The most encrypted elements one PSI set may contain. A sender refuses its own
 * set over it before sending any part; a receiver checks an inbound set's declared
 * length and element scan against it before deserialization. Fixed, not configurable
 * (docs/spec/PROTOCOL.md, A PSI set is sent in parts).
 */
export const MAX_PSI_DECODE_ELEMENTS = 2 ** 24;

/**
 * The largest value of a uint32 field: the single-pass reply states its
 * setup's and its response's lengths and the sender's row count as uint32s.
 */
export const MAX_UINT32 = 0xffff_ffff;

/**
 * The most distinct values one single-pass set holds over file-sync, in place
 * of {@link MAX_PSI_DECODE_ELEMENTS}: the most whose setup, at 35 bytes an
 * element plus its framing, has a length a uint32 holds. A response is 35
 * bytes an element with no framing, so the setup binds first. A sender refuses
 * a set over it before masking any value (docs/spec/PROTOCOL.md, The limits
 * over file-sync).
 */
export const MAX_SINGLE_PASS_SET_ELEMENTS = Math.floor(
  (MAX_UINT32 - PSI_SET_MAX_FRAMING_BYTES) / PSI_ENCODED_ELEMENT_BYTES,
);

/**
 * The most elements a browser party accepts in a partner's PSI set: the
 * largest same-size round measured to complete in a browser tab in both PSI
 * roles. Stated as its receive ceiling on the terms exchange. Raise it only
 * from a fresh measurement in both roles (docs/spec/PROTOCOL.md, What a
 * browser tab can match).
 */
export const BROWSER_PSI_SET_MAX_ELEMENTS = 8_388_608;

/**
 * Upper bound on a decoded record count, enforced by `recordCountField` in
 * protocolSetup.ts, so the products in `singlePassDatasetExceedsCap` and
 * `psiElementBounds` (psi/singlePassSizing.ts) are exact integers by check
 * (docs/spec/PROTOCOL.md, The exact-integer precision of the cell-count gate is
 * a check).
 */
export const MAX_RECORD_COUNT = 1_000_000_000_000;
