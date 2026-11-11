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
import { failureCauseSentence, markFailureCause } from "../failureCause.js";
import {
  connectionLayer,
  isPartnerAbortFrame,
  LOCAL_FAULT_ABORT_REASON,
  throwIfPartnerAbort,
} from "../partnerAbortFrame.js";

import type { MessageConnection } from "../connection/messageConnection.js";
import type { PsiProgressReporter } from "../psi/participant.js";

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

/**
 * The least time between two deliveries of a partner's progress figure to the
 * app, whatever rate the partner sends at. A working value: half the
 * interval, so a partner sending one frame per interval is never held back.
 */
export const PARTNER_PROGRESS_MIN_GAP_MS = 15_000;

/** The still-working frame with no progress figure, which states nothing but its presence. */
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
  return isPercent(percent) ? { percent } : undefined;
}

/** Whether `value` is a progress figure: an integer from 0 to 100. */
function isPercent(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 100
  );
}

/** Whether `frame` is a still-working frame ({@link parseStillWorkingFrame}). */
export function isStillWorkingFrame(frame: unknown): boolean {
  return parseStillWorkingFrame(frame) !== undefined;
}

/** This party's progress through its current crypto operation, read at each send. */
export interface OperationPercentTracker {
  /** Takes one PSI progress report. Never throws. */
  readonly report: PsiProgressReporter;
  /** The whole percent of the operation in flight done, rounded down, or `undefined` when none is. */
  readonly percent: () => number | undefined;
}

/**
 * A tracker of this party's current crypto operation: 0 when it starts, the
 * share of its elements processed as it moves, and none once it settles.
 * The count of the first round's values is not a crypto operation.
 */
export function operationPercentTracker(): OperationPercentTracker {
  let percent: number | undefined;
  return {
    report: ({ operation, state, elements, processed }) => {
      if (operation === "countFirstRoundValues") return;
      if (state === "started") percent = 0;
      else if (state === "progress") {
        const share = Math.floor((100 * (processed ?? 0)) / elements);
        percent =
          elements > 0 && Number.isFinite(share)
            ? Math.min(100, Math.max(0, share))
            : 0;
      } else percent = undefined;
    },
    percent: () => percent,
  };
}

/** The timing a {@link StillWorkingLayer} runs on; a test shortens it. */
export interface StillWorkingTiming {
  readonly intervalMs: number;
  readonly silenceBoundMs: number;
}

/**
 * Takes the partner's progress through its current crypto operation, an
 * integer from 0 to 100, or `undefined` to clear the figure shown.
 */
export type PartnerProgressReporter = (percent: number | undefined) => void;

/**
 * The layer one party's PSI phase, and the steps after it, send and receive
 * through on a connection whose parties exchange still-working frames.
 */
export interface StillWorkingLayer {
  /** The connection the PSI phase and the steps after it use. */
  readonly conn: MessageConnection;
  /**
   * Sends a still-working frame now, with no progress figure, then whenever
   * the interval passes with nothing sent, stating `ownPercent`'s figure when
   * it returns one.
   */
  start(ownPercent?: () => number | undefined): void;
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
 *
 * The partner's progress figure reaches `onPartnerProgress` only while the
 * reader waits in a receive, at most once per {@link
 * PARTNER_PROGRESS_MIN_GAP_MS}; a frame without a figure, a data frame, and
 * the end of the receive clear a figure delivered.
 */
export function stillWorkingLayer(
  conn: MessageConnection,
  timing: StillWorkingTiming = {
    intervalMs: STILL_WORKING_INTERVAL_MS,
    silenceBoundMs: PARTNER_SILENCE_BOUND_MS,
  },
  onPartnerProgress?: PartnerProgressReporter,
): StillWorkingLayer | undefined {
  if (conn.exchangesStillWorkingFrames?.() !== true) return undefined;

  let ownPercent: (() => number | undefined) | undefined;
  let partnerPercent: number | undefined;
  let shownPercent: number | undefined;
  let lastShownAt: number | undefined;
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

  const readOwnPercent = (): number | undefined => {
    try {
      const percent = ownPercent?.();
      return isPercent(percent) ? percent : undefined;
    } catch {
      return undefined;
    }
  };

  const sendStillWorking = (percent: number | undefined): void => {
    enqueue(
      percent === undefined
        ? STILL_WORKING_FRAME
        : { ...STILL_WORKING_FRAME, percent },
    ).catch(() => {
      sending = false;
      clearTimeout(timer);
    });
    restartTimer();
  };

  const deliverPartnerProgress = (percent: number | undefined): void => {
    shownPercent = percent;
    try {
      onPartnerProgress?.(percent);
    } catch {
      // A display fault does not end the wait.
    }
  };

  const showPartnerProgress = (): void => {
    if (!consumerReceiving || partnerPercent === shownPercent) return;
    if (partnerPercent === undefined) {
      deliverPartnerProgress(undefined);
      return;
    }
    const now = Date.now();
    const sinceShown =
      lastShownAt === undefined ? undefined : now - lastShownAt;
    if (
      sinceShown !== undefined &&
      sinceShown >= 0 &&
      sinceShown < PARTNER_PROGRESS_MIN_GAP_MS
    )
      return;
    lastShownAt = now;
    deliverPartnerProgress(partnerPercent);
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
      ) {
        const cause = { kind: "partner-stopped-at-matching" } as const;
        throw markStatesItsOwnNextStep(
          markFailureCause(
            new PartnerProtocolRefusalError(failureCauseSentence(cause), {
              cause: abort,
            }),
            cause,
          ),
        );
      }
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
    const stillWorking = parseStillWorkingFrame(frame);
    if (stillWorking !== undefined) {
      partnerFrameSeen = true;
      if (!boundArmed && !phaseEnded) {
        boundArmed = true;
        conn.armPartnerSilenceBound?.(timing.silenceBoundMs);
      }
      partnerPercent = stillWorking.percent;
      showPartnerProgress();
      return DROPPED;
    }
    if (hasWorkingKey(frame))
      throw new ConnectionError(
        "the partner sent a malformed still-working frame",
        "protocol",
      );
    partnerPercent = undefined;
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
    sendStillWorking(readOwnPercent());
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
      // A figure drained while this party computed is shown only if the
      // receive waits; a frame already queued brings a newer one or ends it.
      if (conn.nextQueuedMessageBytes?.() === undefined) showPartnerProgress();
      for (;;) {
        const frame = admit(await conn.receive(timeoutMs));
        if (frame !== DROPPED) return frame;
      }
    } finally {
      consumerReceiving = false;
      if (shownPercent !== undefined) deliverPartnerProgress(undefined);
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
    start: (readPercent) => {
      ownPercent = readPercent;
      sending = true;
      sendStillWorking(undefined);
    },
    endPhase: async () => {
      phaseEnded = true;
      await stopSending();
      if (boundArmed) conn.armPartnerSilenceBound?.(undefined);
    },
  };
}
