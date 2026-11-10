// The still-working frames two parties exchange through the PSI phase on a
// WebRTC data channel or a WebSocket relay, and the bound on a partner whose
// frames stop. docs/spec/WEBRTC_TRANSPORT.md, "The wait through a partner's
// PSI step"; docs/spec/PROTOCOL.md, "The still-working frame".
import {
  ConnectionError,
  markStatesItsOwnNextStep,
  PartnerProtocolRefusalError,
  PeerAbortError,
} from "../errors.js";
import {
  connectionLayer,
  isPartnerAbortFrame,
  LOCAL_FAULT_ABORT_REASON,
  throwIfPartnerAbort,
} from "../partnerAbortFrame.js";

import type { MessageConnection } from "../connection/messageConnection.js";

/**
 * How long a party in its PSI phase lets pass since it last sent a frame
 * before it sends a still-working frame. A working value not yet measured in
 * a real browser.
 */
export const STILL_WORKING_INTERVAL_MS = 30_000;

/**
 * How long a parked receive waits with nothing arriving from a partner that
 * has sent a still-working frame before the run ends. A working value not yet
 * measured in a real browser.
 */
export const PARTNER_SILENCE_BOUND_MS = 120_000;

/** The still-working frame this build sends, which states nothing but its presence. */
export const STILL_WORKING_FRAME: { readonly working: true } = Object.freeze({
  working: true,
});

const STILL_WORKING_FRAME_KEYS: ReadonlySet<string> = new Set([
  "working",
  "percent",
]);

// The plaintext lengths of the still-working frames the parse admits, as
// JSON.stringify encodes them: no figure, and a figure of one, two and three
// digits.
const STILL_WORKING_FRAME_BYTES: ReadonlyArray<number> = [
  STILL_WORKING_FRAME,
  { ...STILL_WORKING_FRAME, percent: 0 },
  { ...STILL_WORKING_FRAME, percent: 10 },
  { ...STILL_WORKING_FRAME, percent: 100 },
].map((frame) => JSON.stringify(frame).length);

/**
 * The refusal of a partner whose first frame of the PSI phase is data: a
 * partner on this build sends a still-working frame first.
 */
export const OLDER_PARTNER_AT_MATCHING_MESSAGE =
  "Matching could not start, most likely because your partner runs an " +
  "older version of Alcove. Ask them to update Alcove, then run again.";

/**
 * What to do after a partner's first frame of the PSI phase was its
 * local-fault abort. An older build sends one after reading this party's first
 * still-working frame as a protocol error, and a partner on this build sends
 * one when its run faults before its first still-working frame, so the step
 * names no party as the one to update.
 */
export const PARTNER_STOPPED_AT_MATCHING_REMEDY =
  "Make sure you both run the current version of Alcove, then run the " +
  "exchange again.";

/** The refusal of a partner whose first frame of the PSI phase is its
 * local-fault abort ({@link PARTNER_STOPPED_AT_MATCHING_REMEDY}). */
export const PARTNER_STOPPED_AT_MATCHING_MESSAGE =
  "Matching could not start because your partner's run stopped. " +
  PARTNER_STOPPED_AT_MATCHING_REMEDY;

function hasWorkingKey(frame: unknown): boolean {
  return (
    typeof frame === "object" &&
    frame !== null &&
    !Array.isArray(frame) &&
    Object.hasOwn(frame, "working")
  );
}

/** A still-working frame as received: the partner's progress figure, if it sent one. */
interface ReceivedStillWorkingFrame {
  readonly percent: number | undefined;
}

/**
 * `frame` read as a still-working frame, or `undefined` when it is not one:
 * its keys are `working` and optionally `percent`, `working` is `true`, and
 * `percent`, when present, is an integer from 0 to 100.
 */
function parseStillWorkingFrame(
  frame: unknown,
): ReceivedStillWorkingFrame | undefined {
  if (!hasWorkingKey(frame)) return undefined;
  const fields = frame as { working: unknown; percent?: unknown };
  if (
    fields.working !== true ||
    Object.keys(fields).some((key) => !STILL_WORKING_FRAME_KEYS.has(key))
  )
    return undefined;
  if (!Object.hasOwn(fields, "percent")) return { percent: undefined };
  const { percent } = fields;
  return typeof percent === "number" &&
    Number.isInteger(percent) &&
    percent >= 0 &&
    percent <= 100
    ? { percent }
    : undefined;
}

/** Whether `frame` is a still-working frame ({@link parseStillWorkingFrame}). */
export function isStillWorkingFrame(frame: unknown): boolean {
  return parseStillWorkingFrame(frame) !== undefined;
}

/** The timing a {@link StillWorkingLayer} runs on; a test shortens it. */
export interface StillWorkingTiming {
  readonly intervalMs: number;
  readonly silenceBoundMs: number;
}

/**
 * The layer one party's PSI phase, and the steps after it, send and receive
 * through on a connection whose parties exchange still-working frames.
 */
export interface StillWorkingLayer {
  /** The connection the PSI phase and the steps after it use. */
  readonly conn: MessageConnection;
  /** Sends a still-working frame now, then whenever the interval passes with nothing sent. */
  start(): void;
  /**
   * Ends this party's PSI phase: stops sending, waits for a still-working
   * send in flight, and clears the partner-silence bound. Never rejects.
   */
  endPhase(): Promise<void>;
}

const DROPPED = Symbol("dropped still-working frame");

/**
 * The still-working layer over `conn`, or `undefined` where its parties
 * exchange no still-working frames ({@link
 * MessageConnection.exchangesStillWorkingFrames}).
 *
 * Sending: from {@link StillWorkingLayer.start} until the PSI phase ends or
 * this party sends an abort, every frame goes through one queue, so a
 * still-working send never overlaps another send.
 *
 * Receiving: from the start until this party reads the partner's first other
 * frame after its own PSI phase ended, a still-working frame is dropped and
 * any other frame with a `working` key is a `protocol` error, as is a
 * still-working frame after it. The partner's first still-working frame arms
 * the partner-silence bound; the end of this party's PSI phase clears it.
 * Each time the interval passes, still-working frames at the head of the
 * inbound queue are read and dropped; one behind a data frame waits for the
 * reader, charged against the queue's message-count and byte bounds.
 */
export function stillWorkingLayer(
  conn: MessageConnection,
  timing: StillWorkingTiming = {
    intervalMs: STILL_WORKING_INTERVAL_MS,
    silenceBoundMs: PARTNER_SILENCE_BOUND_MS,
  },
): StillWorkingLayer | undefined {
  if (conn.exchangesStillWorkingFrames?.() !== true) return undefined;

  let sending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sendQueue: Promise<void> = Promise.resolve();
  let phaseEnded = false;
  let windowOpen = true;
  let partnerFrameSeen = false;
  let boundArmed = false;
  let held: { frame: unknown } | { error: unknown } | undefined;
  let receiving: Promise<void> | undefined;
  let consumerReceiving = false;

  const enqueue = (data: unknown): Promise<void> => {
    const sent = sendQueue.then(() => conn.send(data));
    sendQueue = sent.catch(() => {});
    return sent;
  };

  const stopSending = async (): Promise<void> => {
    sending = false;
    clearTimeout(timer);
    timer = undefined;
    await sendQueue;
  };

  const restartTimer = (): void => {
    clearTimeout(timer);
    timer = sending ? setTimeout(tick, timing.intervalMs) : undefined;
  };

  const sendStillWorking = (): void => {
    enqueue(STILL_WORKING_FRAME).catch(() => {
      sending = false;
      clearTimeout(timer);
    });
    restartTimer();
  };

  const refuseFirstFrame = (frame: unknown): void => {
    if (!isPartnerAbortFrame(frame))
      throw markStatesItsOwnNextStep(
        new PartnerProtocolRefusalError(OLDER_PARTNER_AT_MATCHING_MESSAGE, {
          olderVersion: "partner",
        }),
      );
    try {
      throwIfPartnerAbort(frame);
    } catch (abort) {
      if (
        abort instanceof PeerAbortError &&
        abort.partnerReason === LOCAL_FAULT_ABORT_REASON
      )
        throw markStatesItsOwnNextStep(
          new PartnerProtocolRefusalError(PARTNER_STOPPED_AT_MATCHING_MESSAGE, {
            cause: abort,
          }),
        );
    }
  };

  const admit = (frame: unknown): unknown => {
    if (!windowOpen) {
      if (hasWorkingKey(frame))
        throw new ConnectionError(
          "the partner sent a still-working frame outside the PSI phase",
          "protocol",
        );
      return frame;
    }
    if (parseStillWorkingFrame(frame) !== undefined) {
      partnerFrameSeen = true;
      if (!boundArmed && !phaseEnded) {
        boundArmed = true;
        conn.armPartnerSilenceBound?.(timing.silenceBoundMs);
      }
      return DROPPED;
    }
    if (hasWorkingKey(frame))
      throw new ConnectionError(
        "the partner sent a malformed still-working frame",
        "protocol",
      );
    if (!partnerFrameSeen) {
      partnerFrameSeen = true;
      refuseFirstFrame(frame);
    }
    if (phaseEnded) windowOpen = false;
    return frame;
  };

  const drainQueued = async (): Promise<void> => {
    const wireBytes = new Set(
      STILL_WORKING_FRAME_BYTES.map(
        (frameBytes) =>
          frameBytes + (conn.outboundFrameOverheadBytes?.(frameBytes) ?? 0),
      ),
    );
    const nextIsStillWorkingLength = (): boolean => {
      const next = conn.nextQueuedMessageBytes?.();
      return next !== undefined && wireBytes.has(next);
    };
    try {
      while (held === undefined && nextIsStillWorkingLength()) {
        const frame = admit(await conn.receive());
        if (frame !== DROPPED) held = { frame };
      }
    } catch (error) {
      held = { error };
    }
  };

  const tick = (): void => {
    timer = undefined;
    if (!sending) return;
    if (receiving === undefined && !consumerReceiving && held === undefined)
      receiving = drainQueued().finally(() => {
        receiving = undefined;
      });
    sendStillWorking();
  };

  const receive = async (timeoutMs?: number): Promise<unknown> => {
    while (receiving !== undefined) await receiving;
    consumerReceiving = true;
    try {
      if (held !== undefined) {
        const taken = held;
        held = undefined;
        if ("error" in taken) throw taken.error;
        if (phaseEnded) windowOpen = false;
        return taken.frame;
      }
      for (;;) {
        const frame = admit(await conn.receive(timeoutMs));
        if (frame !== DROPPED) return frame;
      }
    } finally {
      consumerReceiving = false;
    }
  };

  const layered = connectionLayer(conn, {
    send: async (data: unknown) => {
      if (isPartnerAbortFrame(data)) await stopSending();
      const sent = enqueue(data);
      restartTimer();
      return sent;
    },
    receive,
    close: async () => {
      await stopSending();
      return conn.close();
    },
  });

  return {
    conn: layered,
    start: () => {
      sending = true;
      sendStillWorking();
    },
    endPhase: async () => {
      phaseEnded = true;
      await stopSending();
      if (boundArmed) conn.armPartnerSilenceBound?.(undefined);
    },
  };
}
