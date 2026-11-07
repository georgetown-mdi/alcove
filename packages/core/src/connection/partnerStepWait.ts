// The parked-receive budget a WebRTC or relay exchange waits under once the
// terms exchange has fixed both parties' sizes: long enough for the partner's
// PSI steps at the slowest rate recorded. docs/spec/WEBRTC_TRANSPORT.md,
// "The wait through a partner's PSI step".
import { MAX_PSI_DECODE_ELEMENTS } from "./frameSize";

/**
 * The least budget {@link partnerStepWaitMs} gives: the one-hour parked-receive
 * default of the WebRTC and relay transports, so an exchange whose steps the
 * rate puts under it keeps that default.
 */
export const PARTNER_STEP_WAIT_FLOOR_MS = 60 * 60 * 1000;

/**
 * The slowest rate a value slot recorded for a PSI step with the streamed
 * match, which {@link partnerStepWaitMs} scales by with no factor above it:
 * a browser party creating its single-pass request at 8,388,608 value slots a
 * side in 4,219.7 s, about 503.0 microseconds a value slot, in the development
 * container (docs/spec/PROTOCOL.md, "Single-pass in a browser").
 */
export const SLOWEST_RECORDED_PSI_STEP = {
  durationMs: 4_219_700,
  valueSlots: 8_388_608,
} as const;

/** The two parties' sizes as the terms exchange fixed them. */
export interface PartnerStepWaitSizes {
  /** This party's value slots (`effectiveKeyCount * recordCount`). */
  readonly localValueSlots: number;
  /** The partner's value slots, from its declared record count. */
  readonly partnerValueSlots: number;
  /** The most values a PSI set this party receives may hold, as it stated. */
  readonly localReceiveCeiling: number;
  /** The most values a PSI set the partner receives may hold, as it stated. */
  readonly partnerReceiveCeiling: number;
}

/**
 * The parked-receive budget, in milliseconds, that waits through the partner's
 * PSI steps on an exchange of these sizes: {@link SLOWEST_RECORDED_PSI_STEP}'s
 * rate times the two parties' value slots together, and at least
 * {@link PARTNER_STEP_WAIT_FLOOR_MS}. The sum covers single-pass's longest
 * wait, the sender's setup and answer back to back, and a cascade's one step.
 *
 * Each party's value slots are held to the receive ceiling the other party
 * states, and to {@link MAX_PSI_DECODE_ELEMENTS}, since no set it sends may
 * hold more; so the budget is at most the rate times twice that maximum.
 */
export function partnerStepWaitMs(sizes: PartnerStepWaitSizes): number {
  const slots =
    Math.min(
      sizes.localValueSlots,
      sizes.partnerReceiveCeiling,
      MAX_PSI_DECODE_ELEMENTS,
    ) +
    Math.min(
      sizes.partnerValueSlots,
      sizes.localReceiveCeiling,
      MAX_PSI_DECODE_ELEMENTS,
    );
  return Math.max(
    PARTNER_STEP_WAIT_FLOOR_MS,
    Math.ceil(
      (slots * SLOWEST_RECORDED_PSI_STEP.durationMs) /
        SLOWEST_RECORDED_PSI_STEP.valueSlots,
    ),
  );
}
