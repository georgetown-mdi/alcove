import { expect, test } from "vitest";

import { MAX_WEBRTC_FRAME_BYTES } from "../../src/connection/binaryPackBounds";
import {
  BROWSER_PSI_SET_MAX_ELEMENTS,
  MAX_FRAME_SIZE_BYTES,
  MAX_PSI_DECODE_ELEMENTS,
  MAX_RECORD_COUNT,
  psiElementBounds,
} from "../../src/connection/frameSize";
import {
  psiSetByteBound,
  psiSetPartPayloadBytes,
} from "../../src/psi/psiSetParts";
import { MAX_LINKAGE_ENTRIES } from "../../src/config/linkageTermsSchema";
import {
  MAX_EFFECTIVE_KEY_COUNT,
  MAX_KEY_CANDIDATE_WIDTH,
} from "../../src/fanOutFunctions";
import { recordCountField } from "../../src/protocolSetup";

// --- MAX_RECORD_COUNT: the slot-count gate's exact-product dependency -------
// The slot-count gate (singlePassDatasetExceedsCap) decides effectiveKeyCount
// * recordCount > MAX_SINGLE_PASS_CELLS, and its precision argument holds
// only while that product is exact -- below 2^53. That once rested
// implicitly on the recordCount schema's `.int()` safe-integer ceiling;
// MAX_RECORD_COUNT makes it explicit. The check is against the EFFECTIVE key
// count (a declared width multiplies it), so a future raise of
// MAX_EFFECTIVE_KEY_COUNT or MAX_RECORD_COUNT that would cost the product
// precision fails here instead of silently corrupting the gate.

test("effectiveKeyCount * recordCount stays an exact integer at the schema maxima", () => {
  const productAtMaxima = MAX_EFFECTIVE_KEY_COUNT * MAX_RECORD_COUNT;
  expect(productAtMaxima).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  expect(Number.isSafeInteger(productAtMaxima)).toBe(true);
});

// The critical half of the same assumption: what keeps the product exact is
// that the ceiling binds the SUM of the per-key widths. Bounding each key at
// MAX_KEY_CANDIDATE_WIDTH and letting MAX_LINKAGE_ENTRIES of them stand would put
// the product past 2^53, so a change that re-keyed the ceiling onto the per-key
// width fails here rather than corrupting the gate silently.
test("bounding the per-key width alone would lose the exact product", () => {
  const perKeyCeilingSum = MAX_LINKAGE_ENTRIES * MAX_KEY_CANDIDATE_WIDTH;
  expect(perKeyCeilingSum).toBeGreaterThan(MAX_EFFECTIVE_KEY_COUNT);
  expect(Number.isSafeInteger(perKeyCeilingSum * MAX_RECORD_COUNT)).toBe(false);
});

test("recordCountField rejects a record count above the explicit bound at decode", () => {
  // The field rides the terms-exchange envelope (recordCount on termsMessage /
  // termsWithDecisionMessage); its bound is what keeps the cell-count gate exact.
  // At the bound: accepted.
  expect(recordCountField.safeParse(MAX_RECORD_COUNT).success).toBe(true);
  // One above the bound: a clean parse failure (a `too_big` issue), not a
  // silent pass that would feed the gate an inexact product. Over the wire this
  // is a `protocol` ConnectionError via receiveParsed.
  expect(recordCountField.safeParse(MAX_RECORD_COUNT + 1).success).toBe(false);
  // The prior `.int().nonnegative()` bounds still hold.
  expect(recordCountField.safeParse(-1).success).toBe(false);
  expect(recordCountField.safeParse(1.5).success).toBe(false);
});

// --- psiElementBounds: authenticated per-message decode-boundary caps --------
// Both parties derive identical bounds from the two exchanged record counts and
// the two declared effective key counts. The setup holds the sender's set; the
// request holds the receiver's. A response is held to the request this
// party sent instead (psiParticipant.test.ts).

test("psiElementBounds maps each message kind to the relevant party's value slots", () => {
  const bounds = psiElementBounds(
    { effectiveKeyCount: 3, recordCount: 10 },
    { effectiveKeyCount: 3, recordCount: 7 },
  );
  expect(bounds.setup).toBe(3 * 10); // sender's set
  expect(bounds.request).toBe(3 * 7); // receiver's set
});

test("psiElementBounds widens with the fanning-out party alone", () => {
  // A fan-out multiplies only its own party's slots, so a sender that fans out
  // does not loosen the bound on the receiver's request -- the bound each party
  // enforces stays derived from the OTHER party's own declaration.
  const bounds = psiElementBounds(
    { effectiveKeyCount: 22, recordCount: 10 },
    { effectiveKeyCount: 3, recordCount: 7 },
  );
  expect(bounds.setup).toBe(22 * 10);
  expect(bounds.request).toBe(3 * 7);
});

// --- MAX_PSI_DECODE_ELEMENTS: the per-set maximum and its security props ----
// The absolute element ceiling (connection/psiElementScan.ts is the enforcer) is
// the protocol's per-set maximum, a set being joined from parts rather than read
// as one frame. It rests on the numeric properties pinned here.

test("MAX_PSI_DECODE_ELEMENTS is 2^24, admits a full frame's elements, and bounds deserialize memory", () => {
  expect(MAX_PSI_DECODE_ELEMENTS).toBe(16_777_216);
  // At least the most real elements one max-size frame holds (a ~33-byte
  // curve point plus protobuf framing, ~35 bytes on the wire), so a set that
  // fits one frame is never refused for its count.
  const REAL_ELEMENT_WIRE_BYTES = 35;
  expect(MAX_PSI_DECODE_ELEMENTS).toBeGreaterThanOrEqual(
    Math.floor(MAX_FRAME_SIZE_BYTES / REAL_ELEMENT_WIRE_BYTES),
  );

  // At the measured ~211 bytes the protobuf deserializer allocates per
  // declared element, the worst ceiling-passing set stays under 4 GiB.
  const DESERIALIZE_BYTES_PER_ELEMENT = 211;
  expect(MAX_PSI_DECODE_ELEMENTS * DESERIALIZE_BYTES_PER_ELEMENT).toBeLessThan(
    4 * 1024 ** 3,
  );
});

test("a browser party's ceiling on a partner's set is the largest round measured in both roles, received in two WebRTC parts", () => {
  // 2^23, the largest same-size round measured to complete in a browser tab
  // as both the starter and the joiner (docs/spec/PROTOCOL.md, What a browser
  // tab can match). Not derived from any frame bound: a set at it is sent in
  // parts, each held to the per-frame bound.
  expect(BROWSER_PSI_SET_MAX_ELEMENTS).toBe(8_388_608);
  expect(BROWSER_PSI_SET_MAX_ELEMENTS).toBeLessThan(MAX_PSI_DECODE_ELEMENTS);
  const heldBytes = psiSetByteBound(BROWSER_PSI_SET_MAX_ELEMENTS);
  expect(heldBytes).toBe(293_601_286);
  expect(heldBytes).toBeGreaterThan(MAX_WEBRTC_FRAME_BYTES);
  const partBytes = psiSetPartPayloadBytes({
    send: () => Promise.resolve(),
    receive: () => Promise.resolve(undefined),
    close: () => Promise.resolve(),
    outboundWebRtcFrameBound: () => MAX_WEBRTC_FRAME_BYTES,
  });
  expect(Math.ceil(heldBytes / partBytes)).toBe(2);
});
