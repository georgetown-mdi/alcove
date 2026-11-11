import { afterEach, describe, expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";

import {
  ConnectionError,
  PartnerProtocolRefusalError,
  PeerAbortError,
  statesItsOwnNextStep,
} from "../../src/errors";
import {
  createMessagePipe,
  QueuedMessageConnection,
  type MessageConnection,
  type TransportControls,
} from "../../src/connection/messageConnection";
import {
  EncryptedMessageConnection,
  SINGLE_CALL_ENVELOPE_VERSION,
} from "../../src/connection/encryptedMessageConnection";
import { failureCauseOf } from "../../src/failureCause";
import {
  isPartnerStopAtMatchingStart,
  olderVersionOf,
} from "../../src/failureClass";
import { runExchange, type RunExchangeOptions } from "../../src/exchange";
import {
  connectionLayer,
  decisionOnlyAbortFrame,
  LOCAL_FAULT_ABORT_REASON,
  receiveAfterTerms,
  throwIfPartnerAbort,
} from "../../src/partnerAbortFrame";
import { sendLocalFaultAbort, sendTermsAbort } from "../../src/protocolSetup";
import {
  OLDER_PARTNER_AT_MATCHING_MESSAGE,
  PARTNER_PROGRESS_MIN_GAP_MS,
  PARTNER_SILENCE_BOUND_MS,
  STILL_WORKING_FRAME,
  STILL_WORKING_INTERVAL_MS,
  isStillWorkingFrame,
  operationPercentTracker,
  stillWorkingLayer,
  type StillWorkingLayer,
} from "../../src/exchange/stillWorking";
import { runPsiPhase } from "../../src/exchange/psiPhase";
import { MAX_PSI_DECODE_ELEMENTS } from "../../src/connection/frameSize";
import {
  InProcessPsiEngine,
  type PsiEngine,
  type PsiEngineMode,
} from "../../src/psi/psiEngine";
import { psiElementBounds } from "../../src/psi/singlePassSizing";
import type { StandardizedKeyIterable } from "../../src/standardization";
import type { PsiOperation, PsiProgress } from "../../src/psi/participant";
import { prepared } from "../utils/support";

const HOUR_MS = 3_600_000;
// The relay's idle limit less its close drain.
const RELAY_IDLE_LESS_DRAIN_MS = 8_439_400;

afterEach(() => {
  vi.useRealTimers();
});

function layerOver(conn: MessageConnection): StillWorkingLayer {
  const layer = stillWorkingLayer(conn);
  if (layer === undefined) throw new Error("no still-working layer");
  return layer;
}

// A connection that records what it is handed to send.
function recordingConnection(): {
  conn: MessageConnection;
  sent: Array<unknown>;
} {
  const sent: Array<unknown> = [];
  return {
    sent,
    conn: {
      send: (data) => {
        sent.push(data);
        return Promise.resolve();
      },
      receive: () => new Promise(() => {}),
      close: () => Promise.resolve(),
      exchangesStillWorkingFrames: () => true,
    },
  };
}

// The rejection of `promise`, observed at once so a fake-timer advance that
// settles it raises no unhandled rejection.
function settledOf(promise: Promise<unknown>): {
  readonly state: { value?: unknown; error?: unknown; settled: boolean };
} {
  const state: { value?: unknown; error?: unknown; settled: boolean } = {
    settled: false,
  };
  promise.then(
    (value) => {
      state.value = value;
      state.settled = true;
    },
    (error: unknown) => {
      state.error = error;
      state.settled = true;
    },
  );
  return { state };
}

// A PSI phase whose engine's dispose throws `disposeFailure`.
async function runPhaseOnThrowingDispose(
  layer: StillWorkingLayer,
  linkageKeyIterables: StandardizedKeyIterable[],
  disposeFailure: Error,
): ReturnType<typeof runPsiPhase> {
  const psiLibrary = await PSI();
  const own = prepared("Party A", [{ first_name: "ann" }]);
  // A refused progress observer makes the participant's constructor throw,
  // so the phase ends before any data frame.
  const engineFor = (
    role: "starter" | "joiner",
    id: string,
    mode: PsiEngineMode,
  ): PsiEngine => {
    const inner = new InProcessPsiEngine(psiLibrary, role, id, mode);
    return new Proxy(inner, {
      get(target, property) {
        if (property === "observeProcessedElements")
          return () => {
            throw new Error("progress observer refused");
          };
        if (property === "dispose")
          return () => {
            target.dispose();
            throw disposeFailure;
          };
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  };

  return runPsiPhase({
    conn: layer.conn,
    psiLibrary,
    psiEngineFactory: engineFor,
    isReceiver: false,
    countOnly: false,
    verbosity: 0,
    elementBounds: psiElementBounds(
      { effectiveKeyCount: 1, recordCount: 1 },
      { effectiveKeyCount: 1, recordCount: 1 },
    ),
    onPsiProgress: () => {},
    roundsSentInParts: true,
    localReceiveCeiling: MAX_PSI_DECODE_ELEMENTS,
    partnerReceiveCeiling: MAX_PSI_DECODE_ELEMENTS,
    stillWorking: layer,
    linkageKeyIterables,
    linkageTerms: own.linkageTerms,
    partnerTerms: own.linkageTerms,
    rowCount: 1,
    declaredRecordCount: 1,
    partnerRecordCount: 1,
    cardinality: "one-to-one",
    singlePassBounds: {
      partnerRecordCount: 1,
      keyWidths: [],
      localFanOutFactor: 1,
    },
    withholdSenderTable: false,
    onStage: () => {},
  });
}

describe("sending", () => {
  test("a party sends a still-working frame when its PSI phase starts and whenever the interval passes with nothing sent", async () => {
    vi.useFakeTimers();
    const { conn, sent } = recordingConnection();
    const layer = layerOver(conn);

    layer.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toStrictEqual([STILL_WORKING_FRAME]);

    await vi.advanceTimersByTimeAsync(STILL_WORKING_INTERVAL_MS - 1);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toStrictEqual([STILL_WORKING_FRAME, STILL_WORKING_FRAME]);

    // A frame the phase sends restarts the interval.
    await vi.advanceTimersByTimeAsync(10_000);
    await layer.conn.send({ round: 1 });
    await vi.advanceTimersByTimeAsync(STILL_WORKING_INTERVAL_MS - 1);
    expect(sent).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.at(-1)).toStrictEqual(STILL_WORKING_FRAME);
    expect(sent).toHaveLength(4);
  });

  test("a party with no crypto operation in flight sends exactly the bare frame", async () => {
    vi.useFakeTimers();
    const { conn, sent } = recordingConnection();
    const layer = layerOver(conn);

    layer.start(() => undefined);
    await vi.advanceTimersByTimeAsync(3 * STILL_WORKING_INTERVAL_MS);
    expect(sent).toHaveLength(4);
    expect(sent.map((frame) => JSON.stringify(frame))).toStrictEqual(
      Array(4).fill('{"working":true}'),
    );
    await layer.endPhase();
  });

  test("a party states its progress figure as read at each send, and its first frame states none", async () => {
    vi.useFakeTimers();
    const { conn, sent } = recordingConnection();
    const layer = layerOver(conn);
    let percent: number | undefined = 42;

    layer.start(() => percent);
    await vi.advanceTimersByTimeAsync(STILL_WORKING_INTERVAL_MS);
    percent = 57;
    await vi.advanceTimersByTimeAsync(STILL_WORKING_INTERVAL_MS);
    percent = undefined;
    await vi.advanceTimersByTimeAsync(STILL_WORKING_INTERVAL_MS);

    expect(sent.map((frame) => JSON.stringify(frame))).toStrictEqual([
      '{"working":true}',
      '{"working":true,"percent":42}',
      '{"working":true,"percent":57}',
      '{"working":true}',
    ]);
    await layer.endPhase();
  });

  test.each([
    ["101", () => 101],
    ["-1", () => -1],
    ["4.5", () => 4.5],
    ["NaN", () => Number.NaN],
    [
      "a throw",
      () => {
        throw new Error("reader failed");
      },
    ],
  ])(
    "a party whose progress reader returns %s sends the bare frame",
    async (_case, read) => {
      vi.useFakeTimers();
      const { conn, sent } = recordingConnection();
      const layer = layerOver(conn);

      layer.start(read);
      await vi.advanceTimersByTimeAsync(STILL_WORKING_INTERVAL_MS);
      expect(sent).toStrictEqual([STILL_WORKING_FRAME, STILL_WORKING_FRAME]);
      await layer.endPhase();
    },
  );

  test("a party sends no still-working frame once its PSI phase ends", async () => {
    vi.useFakeTimers();
    const { conn, sent } = recordingConnection();
    const layer = layerOver(conn);

    layer.start();
    await layer.endPhase();
    const atEnd = sent.length;
    await vi.advanceTimersByTimeAsync(10 * STILL_WORKING_INTERVAL_MS);
    await layer.conn.send({ result: 1 });
    await vi.advanceTimersByTimeAsync(10 * STILL_WORKING_INTERVAL_MS);
    expect(sent).toHaveLength(atEnd + 1);
    expect(sent.at(-1)).toStrictEqual({ result: 1 });
  });

  test("a party sends no still-working frame once it sends an abort", async () => {
    vi.useFakeTimers();
    const { conn, sent } = recordingConnection();
    const layer = layerOver(conn);

    layer.start();
    const abort = decisionOnlyAbortFrame(["stopped"]);
    await layer.conn.send(abort);
    await vi.advanceTimersByTimeAsync(10 * STILL_WORKING_INTERVAL_MS);
    expect(sent).toStrictEqual([STILL_WORKING_FRAME, abort]);
  });

  test("a still-working send never overlaps another send", async () => {
    let inFlight = 0;
    let most = 0;
    const releases: Array<() => void> = [];
    const conn: MessageConnection = {
      send: () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        return new Promise<void>((resolve) => {
          releases.push(() => {
            inFlight -= 1;
            resolve();
          });
        });
      },
      receive: () => new Promise(() => {}),
      close: () => Promise.resolve(),
      exchangesStillWorkingFrames: () => true,
    };
    const layer = layerOver(conn);

    layer.start();
    const data = layer.conn.send({ round: 1 });
    await Promise.resolve();
    expect(releases).toHaveLength(1);
    releases[0]();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]();
    await data;
    expect(most).toBe(1);
  });

  test("a party sends no still-working frame once its PSI phase ends on an engine whose dispose throws", async () => {
    vi.useFakeTimers();
    const { conn, sent } = recordingConnection();
    const layer = layerOver(conn);
    const disposeFailure = new Error("dispose failed");

    await expect(
      runPhaseOnThrowingDispose(layer, [], disposeFailure),
    ).rejects.toBe(disposeFailure);

    const atEnd = sent.length;
    await vi.advanceTimersByTimeAsync(10 * STILL_WORKING_INTERVAL_MS);
    expect(sent).toHaveLength(atEnd);
  });

  test("a PSI phase whose engine's dispose throws still closes each round's row reporting", async () => {
    const { conn } = recordingConnection();
    const layer = layerOver(conn);
    const disposeFailure = new Error("dispose failed");
    const closeRowReporting = vi.fn();
    const rounds = [{ closeRowReporting }, { closeRowReporting }];

    await expect(
      runPhaseOnThrowingDispose(
        layer,
        rounds as unknown as StandardizedKeyIterable[],
        disposeFailure,
      ),
    ).rejects.toBe(disposeFailure);

    expect(closeRowReporting).toHaveBeenCalledTimes(rounds.length);
  });

  test("a connection whose parties exchange no still-working frames takes no layer", () => {
    const [plain] = createMessagePipe();
    expect(stillWorkingLayer(plain)).toBeUndefined();
    const [stated] = createMessagePipe({ stillWorkingFrames: false });
    expect(stillWorkingLayer(stated)).toBeUndefined();
  });
});

describe("waiting through a partner's PSI step", () => {
  test("a waiting party keeps waiting while still-working frames arrive, past the relay's idle limit and the inactivity budget", async () => {
    vi.useFakeTimers();
    const [local, partner] = createMessagePipe({
      stillWorkingFrames: true,
      inactivityTimeoutMs: HOUR_MS,
    });
    const waiting = layerOver(local);
    const working = layerOver(partner);
    working.start();

    const { state } = settledOf(waiting.conn.receive());
    await vi.advanceTimersByTimeAsync(RELAY_IDLE_LESS_DRAIN_MS + HOUR_MS);
    expect(state.settled).toBe(false);

    await working.conn.send({ round: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(state).toStrictEqual({ settled: true, value: { round: 1 } });
    await working.endPhase();
  });

  test("a waiting party ends on the silence bound when the partner's still-working frames stop", async () => {
    vi.useFakeTimers();
    const [local, partner] = createMessagePipe({
      stillWorkingFrames: true,
      inactivityTimeoutMs: HOUR_MS,
    });
    const waiting = layerOver(local);
    await partner.send(STILL_WORKING_FRAME);

    const { state } = settledOf(waiting.conn.receive());
    await vi.advanceTimersByTimeAsync(PARTNER_SILENCE_BOUND_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);
    expect(state.error).toBeInstanceOf(ConnectionError);
    expect(failureCauseOf(state.error)).toStrictEqual({
      kind: "partner-stopped-responding",
      silentMs: PARTNER_SILENCE_BOUND_MS,
    });
  });

  test("the silence bound stays unarmed until the partner's first still-working frame", async () => {
    vi.useFakeTimers();
    const [local] = createMessagePipe({
      stillWorkingFrames: true,
      inactivityTimeoutMs: HOUR_MS,
    });
    const waiting = layerOver(local);

    const { state } = settledOf(waiting.conn.receive());
    await vi.advanceTimersByTimeAsync(HOUR_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.error).toBeInstanceOf(ConnectionError);
    expect(failureCauseOf(state.error)?.kind).not.toBe(
      "partner-stopped-responding",
    );
  });

  test("the end of this party's PSI phase clears the silence bound", async () => {
    vi.useFakeTimers();
    const [local, partner] = createMessagePipe({
      stillWorkingFrames: true,
      inactivityTimeoutMs: HOUR_MS,
    });
    const waiting = layerOver(local);
    await partner.send(STILL_WORKING_FRAME);
    await partner.send({ round: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(await waiting.conn.receive()).toStrictEqual({ round: 1 });
    await waiting.endPhase();

    const { state } = settledOf(waiting.conn.receive());
    await vi.advanceTimersByTimeAsync(10 * PARTNER_SILENCE_BOUND_MS);
    expect(state.settled).toBe(false);
  });

  test("each part of a frame that arrives restarts the silence bound", async () => {
    vi.useFakeTimers();
    let controls: TransportControls | undefined;
    const conn = new QueuedMessageConnection((given) => {
      controls = given;
      return { send: () => {}, close: () => {} };
    });
    conn.armPartnerSilenceBound(PARTNER_SILENCE_BOUND_MS);

    const { state } = settledOf(conn.receive());
    await vi.advanceTimersByTimeAsync(PARTNER_SILENCE_BOUND_MS - 1);
    controls?.inboundProgress();
    await vi.advanceTimersByTimeAsync(PARTNER_SILENCE_BOUND_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(failureCauseOf(state.error)?.kind).toBe(
      "partner-stopped-responding",
    );
  });

  test("a cleared silence bound no longer ends a parked receive", async () => {
    vi.useFakeTimers();
    const conn = new QueuedMessageConnection(() => ({
      send: () => {},
      close: () => {},
    }));
    conn.armPartnerSilenceBound(PARTNER_SILENCE_BOUND_MS);
    const { state } = settledOf(conn.receive());
    conn.armPartnerSilenceBound(undefined);
    await vi.advanceTimersByTimeAsync(10 * PARTNER_SILENCE_BOUND_MS);
    expect(state.settled).toBe(false);
  });
});

describe("still-working frames outside the PSI phase", () => {
  test("a still-working frame after the partner's first frame past this party's PSI phase is a protocol error", async () => {
    const [local, partner] = createMessagePipe({ stillWorkingFrames: true });
    const layer = layerOver(local);
    await partner.send(STILL_WORKING_FRAME);
    await partner.send({ round: 1 });
    expect(await layer.conn.receive()).toStrictEqual({ round: 1 });
    await layer.endPhase();

    // Still in flight from the partner's own PSI phase: dropped.
    await partner.send(STILL_WORKING_FRAME);
    await partner.send({ result: 1 });
    expect(await layer.conn.receive()).toStrictEqual({ result: 1 });

    await partner.send(STILL_WORKING_FRAME);
    const refused = await layer.conn.receive().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ConnectionError);
    expect((refused as ConnectionError).kind).toBe("protocol");
  });

  test.each([
    ["a false flag", { working: false }],
    ["an added key", { working: true, round: 1 }],
    ["an added key beside a figure", { working: true, percent: 57, round: 1 }],
  ])(
    "a still-working frame with %s is a protocol error",
    async (_label, frame) => {
      const [local, partner] = createMessagePipe({ stillWorkingFrames: true });
      const layer = layerOver(local);
      await partner.send(STILL_WORKING_FRAME);
      await partner.send(frame);
      const refused = await layer.conn
        .receive()
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ConnectionError);
      expect((refused as ConnectionError).kind).toBe("protocol");
    },
  );

  test("on a connection with no still-working frames, as file-sync, the awaited frame's parse refuses one", async () => {
    const [local, partner] = createMessagePipe();
    await partner.send(STILL_WORKING_FRAME);
    const schema = {
      parse(value: unknown): { round: number } {
        if (
          typeof value !== "object" ||
          value === null ||
          typeof (value as { round?: unknown }).round !== "number"
        )
          throw new Error("not a round");
        return value as { round: number };
      },
    };
    await expect(receiveAfterTerms(local, schema)).rejects.toThrow();
  });
});

describe("the progress figure on a received still-working frame", () => {
  const keying = {
    sessionKey: new Uint8Array(32).fill(0x42) as Uint8Array<ArrayBuffer>,
    negotiated: { kex: 3, protocol: 1, envelope: SINGLE_CALL_ENVELOPE_VERSION },
  };

  // The in-memory pipe hands the partner's object over as is; the encrypted
  // pair puts it through JSON, which writes NaN as null.
  const transports: Array<
    [string, () => Promise<[MessageConnection, MessageConnection]>]
  > = [
    [
      "an in-memory pipe",
      () => Promise.resolve(createMessagePipe({ stillWorkingFrames: true })),
    ],
    [
      "an encrypted connection",
      async () => {
        const [rawA, rawB] = createMessagePipe({ stillWorkingFrames: true });
        return Promise.all([
          EncryptedMessageConnection.create(rawA, keying, "initiator"),
          EncryptedMessageConnection.create(rawB, keying, "responder"),
        ]);
      },
    ],
  ];

  describe.each(transports)("over %s", (_label, pairOf) => {
    test.each([
      ["no figure", STILL_WORKING_FRAME],
      ["a figure of 0", { working: true, percent: 0 }],
      ["a figure of 57", { working: true, percent: 57 }],
      ["a figure of 100", { working: true, percent: 100 }],
      ["the figure first", { percent: 57, working: true }],
    ])("a still-working frame with %s is dropped", async (_case, frame) => {
      const [local, partner] = await pairOf();
      const layer = layerOver(local);
      await partner.send(frame);
      await partner.send({ round: 1 });
      expect(await layer.conn.receive()).toStrictEqual({ round: 1 });
    });

    test.each([
      ["a figure of -1", { working: true, percent: -1 }],
      ["a figure of 101", { working: true, percent: 101 }],
      ["a figure of 4.5", { working: true, percent: 4.5 }],
      ["a figure of the string 42", { working: true, percent: "42" }],
      ["a figure of null", { working: true, percent: null }],
      ["a figure of true", { working: true, percent: true }],
      ["a figure of NaN", { working: true, percent: Number.NaN }],
      ["a figure of an object", { working: true, percent: {} }],
      ["a false flag and a figure", { working: false, percent: 57 }],
    ])(
      "a still-working frame with %s is a protocol error",
      async (_case, frame) => {
        const [local, partner] = await pairOf();
        const layer = layerOver(local);
        await partner.send(STILL_WORKING_FRAME);
        await partner.send(frame);
        const refused = await layer.conn
          .receive()
          .catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(ConnectionError);
        expect((refused as ConnectionError).kind).toBe("protocol");
      },
    );
  });
});

describe("this party's progress through its crypto operation", () => {
  const report = (
    state: PsiProgress["state"],
    fields: Partial<PsiProgress> = {},
  ): PsiProgress => ({
    operation: "createClientRequest",
    elements: 1000,
    state,
    ...fields,
  });

  test("a tracker reads 0 when an operation starts, the share processed as it moves, and none once it settles", () => {
    const tracker = operationPercentTracker();
    expect(tracker.percent()).toBeUndefined();
    tracker.report(report("started"));
    expect(tracker.percent()).toBe(0);
    tracker.report(report("progress", { processed: 409 }));
    expect(tracker.percent()).toBe(40);
    tracker.report(report("progress", { processed: 999 }));
    expect(tracker.percent()).toBe(99);
    tracker.report(report("finished", { durationMs: 5 }));
    expect(tracker.percent()).toBeUndefined();
    tracker.report(report("started"));
    tracker.report(report("failed", { durationMs: 5 }));
    expect(tracker.percent()).toBeUndefined();
  });

  test.each([
    ["no elements", { elements: 0, processed: 0 }, 0],
    ["a negative element count", { elements: -10, processed: -5 }, 0],
    ["more processed than covered", { processed: 5000 }, 100],
    ["a negative processed count", { processed: -5 }, 0],
    ["no processed count", {}, 0],
  ])(
    "a tracker given %s reads a figure from 0 to 100",
    (_case, fields, percent) => {
      const tracker = operationPercentTracker();
      tracker.report(report("progress", fields));
      expect(tracker.percent()).toBe(percent);
    },
  );

  test("a tracker ignores the count of the first round's values", () => {
    const tracker = operationPercentTracker();
    tracker.report(report("started", { operation: "countFirstRoundValues" }));
    expect(tracker.percent()).toBeUndefined();
  });
});

describe("the partner's progress figure, shown to this party", () => {
  // A local layer reporting the partner's figure, over a pipe whose partner
  // end the test sends frames on directly.
  function waitingPair(): {
    layer: StillWorkingLayer;
    partner: MessageConnection;
    shown: Array<number | undefined>;
  } {
    const [local, partner] = createMessagePipe({
      stillWorkingFrames: true,
      inactivityTimeoutMs: 100 * HOUR_MS,
    });
    const shown: Array<number | undefined> = [];
    const layer = stillWorkingLayer(local, undefined, (percent) => {
      shown.push(percent);
    });
    if (layer === undefined) throw new Error("no still-working layer");
    return { layer, partner, shown };
  }

  test("a waiting party is shown the partner's figure, then the clear when the partner's data frame ends the wait", async () => {
    vi.useFakeTimers();
    const { layer, partner, shown } = waitingPair();
    const { state } = settledOf(layer.conn.receive());

    await partner.send({ working: true, percent: 40 });
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toStrictEqual([40]);

    await partner.send({ round: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(state).toStrictEqual({ settled: true, value: { round: 1 } });
    expect(shown).toStrictEqual([40, undefined]);
  });

  test("a frame without a figure clears the figure shown, and a party shown none is sent no clear", async () => {
    vi.useFakeTimers();
    const { layer, partner, shown } = waitingPair();
    settledOf(layer.conn.receive());

    await partner.send(STILL_WORKING_FRAME);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toStrictEqual([]);
    await partner.send({ working: true, percent: 40 });
    await partner.send(STILL_WORKING_FRAME);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toStrictEqual([40, undefined]);
    await partner.send(STILL_WORKING_FRAME);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toStrictEqual([40, undefined]);
  });

  test("a receive that fails clears the figure shown", async () => {
    vi.useFakeTimers();
    const { layer, partner, shown } = waitingPair();
    const { state } = settledOf(layer.conn.receive());

    await partner.send({ working: true, percent: 40 });
    await vi.advanceTimersByTimeAsync(0);
    await partner.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.error).toBeInstanceOf(ConnectionError);
    expect(shown).toStrictEqual([40, undefined]);
  });

  test("a refused still-working frame ends the wait with no figure shown", async () => {
    vi.useFakeTimers();
    const { layer, partner, shown } = waitingPair();
    const { state } = settledOf(layer.conn.receive());

    await partner.send(STILL_WORKING_FRAME);
    await partner.send({ working: true, percent: 101 });
    await vi.advanceTimersByTimeAsync(0);
    expect((state.error as ConnectionError).kind).toBe("protocol");
    expect(shown).toStrictEqual([]);
  });

  test("a figure drained while this party computes is shown only once it waits, and a data frame drained behind it drops it", async () => {
    vi.useFakeTimers();
    const keying = {
      sessionKey: new Uint8Array(32).fill(0x42) as Uint8Array<ArrayBuffer>,
      negotiated: {
        kex: 3,
        protocol: 1,
        envelope: SINGLE_CALL_ENVELOPE_VERSION,
      },
    };
    const [rawA, rawB] = createMessagePipe({
      stillWorkingFrames: true,
      inactivityTimeoutMs: 100 * HOUR_MS,
    });
    const [localEnd, partnerEnd] = await Promise.all([
      EncryptedMessageConnection.create(rawA, keying, "initiator"),
      EncryptedMessageConnection.create(rawB, keying, "responder"),
    ]);
    const shown: Array<number | undefined> = [];
    const layer = stillWorkingLayer(localEnd, undefined, (percent) => {
      shown.push(percent);
    });
    if (layer === undefined) throw new Error("no still-working layer");

    layer.start();
    await partnerEnd.send({ working: true, percent: 40 });
    await vi.advanceTimersByTimeAsync(STILL_WORKING_INTERVAL_MS);
    expect(localEnd.nextQueuedMessageBytes?.()).toBeUndefined();
    expect(shown).toStrictEqual([]);

    // The receive shows the figure once the drain's decrypt settles, which
    // runs in WebCrypto's thread pool where no timer advance reaches it.
    const received = layer.conn.receive();
    await vi.waitFor(() => expect(shown).toStrictEqual([40]));
    await partnerEnd.send({ round: 1 });
    expect(await received).toStrictEqual({ round: 1 });
    expect(shown).toStrictEqual([40, undefined]);

    // A figure drained ahead of a data frame already queued is not shown.
    await partnerEnd.send({ working: true, percent: 50 });
    await partnerEnd.send({ round: 2 });
    await vi.advanceTimersByTimeAsync(STILL_WORKING_INTERVAL_MS);
    expect(localEnd.nextQueuedMessageBytes?.()).toBeDefined();
    expect(await layer.conn.receive()).toStrictEqual({ round: 2 });
    expect(shown).toStrictEqual([40, undefined]);
    await layer.endPhase();
  });

  test("a partner flooding still-working frames is shown at most one figure per gap, and one clear after each", async () => {
    vi.useFakeTimers();
    const { layer, partner, shown } = waitingPair();
    settledOf(layer.conn.receive());
    const frames = 10_000;
    const stepMs = 10;

    for (let i = 0; i < frames; i++) {
      await partner.send(
        i % 2 === 0
          ? { working: true, percent: (i / 2) % 101 }
          : STILL_WORKING_FRAME,
      );
      await vi.advanceTimersByTimeAsync(stepMs);
    }

    const figures = shown.filter((percent) => percent !== undefined);
    const clears = shown.filter((percent) => percent === undefined);
    expect(figures).toHaveLength(
      Math.floor((frames * stepMs) / PARTNER_PROGRESS_MIN_GAP_MS) + 1,
    );
    expect(clears.length).toBeLessThanOrEqual(figures.length);
  });

  test("a figure that changes within the gap is shown once the gap has passed", async () => {
    vi.useFakeTimers();
    const { layer, partner, shown } = waitingPair();
    settledOf(layer.conn.receive());

    await partner.send({ working: true, percent: 20 });
    await vi.advanceTimersByTimeAsync(PARTNER_PROGRESS_MIN_GAP_MS - 1);
    await partner.send({ working: true, percent: 30 });
    await vi.advanceTimersByTimeAsync(1);
    expect(shown).toStrictEqual([20]);
    await partner.send({ working: true, percent: 40 });
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toStrictEqual([20, 40]);
  });

  test("an app callback that throws does not end the wait", async () => {
    vi.useFakeTimers();
    const [local, partner] = createMessagePipe({ stillWorkingFrames: true });
    const layer = stillWorkingLayer(local, undefined, () => {
      throw new Error("display failed");
    });
    if (layer === undefined) throw new Error("no still-working layer");
    const { state } = settledOf(layer.conn.receive());

    await partner.send({ working: true, percent: 40 });
    await partner.send({ round: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(state).toStrictEqual({ settled: true, value: { round: 1 } });
  });
});

describe("a partner on an older version", () => {
  test("a partner whose first PSI-phase frame is data is refused as running an older version", async () => {
    const [local, partner] = createMessagePipe({ stillWorkingFrames: true });
    const layer = layerOver(local);
    await partner.send({ round: 1 });
    const refused = await layer.conn.receive().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PartnerProtocolRefusalError);
    expect((refused as Error).message).toBe(OLDER_PARTNER_AT_MATCHING_MESSAGE);
    expect(olderVersionOf(refused)).toBe("partner");
    expect(isPartnerStopAtMatchingStart(refused)).toBe(false);
    expect(statesItsOwnNextStep(refused)).toBe(true);
  });

  test("a partner whose first PSI-phase frame is its local-fault abort is refused naming no older party, the abort kept as the cause", async () => {
    const [local, partner] = createMessagePipe({ stillWorkingFrames: true });
    const layer = layerOver(local);
    await partner.send(decisionOnlyAbortFrame([LOCAL_FAULT_ABORT_REASON]));
    const refused = await layer.conn.receive().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PartnerProtocolRefusalError);
    expect((refused as Error).message).toBe(
      "Matching could not start because your partner's run stopped.",
    );
    expect(failureCauseOf(refused)).toEqual({
      kind: "partner-stopped-at-matching",
    });
    expect(olderVersionOf(refused)).toBeUndefined();
    expect(isPartnerStopAtMatchingStart(refused)).toBe(true);
    expect(statesItsOwnNextStep(refused)).toBe(true);
    expect((refused as Error).cause).toBeInstanceOf(PeerAbortError);
  });

  test("a partner whose first PSI-phase frame is any other abort reaches the phase unchanged", async () => {
    const [local, partner] = createMessagePipe({ stillWorkingFrames: true });
    const layer = layerOver(local);
    const abort = decisionOnlyAbortFrame(["the terms do not match"]);
    await partner.send(abort);
    const frame = await layer.conn.receive();
    expect(frame).toStrictEqual(abort);
    expect(() => throwIfPartnerAbort(frame)).toThrow(PeerAbortError);
  });
});

describe("queued still-working frames", () => {
  const keying = {
    sessionKey: new Uint8Array(32).fill(0x42) as Uint8Array<ArrayBuffer>,
    negotiated: { kex: 3, protocol: 1, envelope: SINGLE_CALL_ENVELOPE_VERSION },
  };
  const fast = { intervalMs: 5, silenceBoundMs: 60_000 };

  async function encryptedPair(
    capacity: number,
  ): Promise<[MessageConnection, MessageConnection]> {
    const [rawA, rawB] = createMessagePipe({
      stillWorkingFrames: true,
      capacity,
    });
    return Promise.all([
      EncryptedMessageConnection.create(rawA, keying, "initiator"),
      EncryptedMessageConnection.create(rawB, keying, "responder"),
    ]);
  }

  test("a party not reading drops the partner's still-working frames queued at the head of its inbound queue", async () => {
    const [localEnd, partnerEnd] = await encryptedPair(4);
    const local = stillWorkingLayer(localEnd, fast);
    const partner = stillWorkingLayer(partnerEnd, fast);
    if (local === undefined || partner === undefined) throw new Error();
    local.start();
    partner.start();

    await new Promise((resolve) => setTimeout(resolve, 300));
    await partner.conn.send({ round: 1 });
    expect(await local.conn.receive()).toStrictEqual({ round: 1 });

    await Promise.all([local.endPhase(), partner.endPhase()]);
  });

  test("a queued frame the length of a still-working frame that is not one reaches the reader, in order", async () => {
    const [localEnd, partnerEnd] = await encryptedPair(64);
    const local = stillWorkingLayer(localEnd, fast);
    const partner = stillWorkingLayer(partnerEnd, fast);
    if (local === undefined || partner === undefined) throw new Error();
    local.start();
    partner.start();

    const sameLength = { abcdefg: true };
    expect(JSON.stringify(sameLength)).toHaveLength(
      JSON.stringify(STILL_WORKING_FRAME).length,
    );
    await partner.conn.send(sameLength);
    await partner.conn.send({ round: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await local.conn.receive()).toStrictEqual(sameLength);
    expect(await local.conn.receive()).toStrictEqual({ round: 1 });

    await Promise.all([local.endPhase(), partner.endPhase()]);
  });

  test.each([
    ["no figure", STILL_WORKING_FRAME, 16],
    ["a one-digit figure", { working: true, percent: 0 }, 28],
    ["a two-digit figure", { working: true, percent: 57 }, 29],
    ["a three-digit figure", { working: true, percent: 100 }, 30],
  ])(
    "a party not reading drops a queued still-working frame with %s and holds the data frame of its length behind it",
    async (_case, frame, frameBytes) => {
      expect(JSON.stringify(frame)).toHaveLength(frameBytes);
      const [localEnd, partnerEnd] = await encryptedPair(64);
      const local = stillWorkingLayer(localEnd, fast);
      if (local === undefined) throw new Error();
      // `{"x":""}` is 8 bytes, the padding brings it to the frame's length.
      const sameLength = { x: "a".repeat(frameBytes - 8) };
      expect(JSON.stringify(sameLength)).toHaveLength(frameBytes);

      await partnerEnd.send(frame);
      await partnerEnd.send(sameLength);
      await partnerEnd.send(frame);
      const reads = vi.spyOn(localEnd, "receive");
      local.start();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(reads).toHaveBeenCalledTimes(2);
      expect(localEnd.nextQueuedMessageBytes?.()).toBe(
        frameBytes + (localEnd.outboundFrameOverheadBytes?.(frameBytes) ?? 0),
      );
      expect(await local.conn.receive()).toStrictEqual(sameLength);

      await local.endPhase();
    },
  );
});

describe("a forged, replayed or altered still-working envelope", () => {
  const keying = {
    sessionKey: new Uint8Array(32).fill(0x42) as Uint8Array<ArrayBuffer>,
    negotiated: { kex: 3, protocol: 1, envelope: SINGLE_CALL_ENVELOPE_VERSION },
  };

  async function encryptedPair() {
    const [rawLocal, rawPartner] = createMessagePipe({
      stillWorkingFrames: true,
      capacity: 64,
    });
    const armed = vi.spyOn(rawLocal, "armPartnerSilenceBound");
    const [local, partner] = await Promise.all([
      EncryptedMessageConnection.create(rawLocal, keying, "initiator"),
      EncryptedMessageConnection.create(rawPartner, keying, "responder"),
    ]);
    return { rawPartner, local, partner, armed };
  }

  // The envelope `partner` puts on the wire for `frame`, delivered or not.
  async function envelopeOf(
    rawPartner: MessageConnection,
    partner: MessageConnection,
    frame: unknown,
    deliver: boolean,
  ): Promise<Uint8Array> {
    const send = rawPartner.send.bind(rawPartner);
    let captured: Uint8Array | undefined;
    vi.spyOn(rawPartner, "send").mockImplementationOnce((data) => {
      captured = data as Uint8Array;
      return deliver ? send(data) : Promise.resolve();
    });
    await partner.send(frame);
    if (captured === undefined) throw new Error("no envelope sent");
    return captured;
  }

  async function refusalOf(layer: StillWorkingLayer): Promise<unknown> {
    return layer.conn.receive().then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  function expectSecurityRefusal(error: unknown): void {
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as ConnectionError).kind).toBe("security");
  }

  test("random bytes the length of a still-working envelope are refused as a security error and leave the silence bound unarmed", async () => {
    const { rawPartner, local, armed } = await encryptedPair();
    const layer = layerOver(local);
    const frameBytes = JSON.stringify(STILL_WORKING_FRAME).length;
    const forged = new Uint8Array(
      frameBytes + local.outboundFrameOverheadBytes(frameBytes),
    );
    forged[0] = SINGLE_CALL_ENVELOPE_VERSION;
    crypto.getRandomValues(forged.subarray(1));
    await rawPartner.send(forged);

    expectSecurityRefusal(await refusalOf(layer));
    expect(armed).not.toHaveBeenCalled();
  });

  test("a genuine still-working envelope sent again is refused as a security error and does not arm the silence bound again", async () => {
    const { rawPartner, local, partner, armed } = await encryptedPair();
    const layer = layerOver(local);
    const genuine = await envelopeOf(
      rawPartner,
      partner,
      STILL_WORKING_FRAME,
      true,
    );
    await partner.send({ round: 1 });
    expect(await layer.conn.receive()).toStrictEqual({ round: 1 });
    expect(armed).toHaveBeenCalledTimes(1);
    expect(armed).toHaveBeenCalledWith(PARTNER_SILENCE_BOUND_MS);

    armed.mockClear();
    await rawPartner.send(genuine);

    expectSecurityRefusal(await refusalOf(layer));
    expect(armed).not.toHaveBeenCalled();
  });

  test.each([
    ["no figure", STILL_WORKING_FRAME],
    ["a figure", { working: true, percent: 57 }],
  ])(
    "a genuine still-working envelope with %s and a flipped tag byte is refused as a security error and leaves the silence bound unarmed",
    async (_case, frame) => {
      const { rawPartner, local, partner, armed } = await encryptedPair();
      const layer = layerOver(local);
      const genuine = await envelopeOf(rawPartner, partner, frame, false);
      const altered = new Uint8Array(genuine);
      altered[altered.length - 1] ^= 1;
      await rawPartner.send(altered);

      expectSecurityRefusal(await refusalOf(layer));
      expect(armed).not.toHaveBeenCalled();
    },
  );

  test.each(["forged", "altered"] as const)(
    "the drain holds a %s envelope it reads and raises it as a security error at the next receive",
    async (kind) => {
      const { rawPartner, local, partner, armed } = await encryptedPair();
      let queued: Uint8Array<ArrayBuffer>;
      if (kind === "forged") {
        const frameBytes = JSON.stringify(STILL_WORKING_FRAME).length;
        queued = new Uint8Array(
          frameBytes + local.outboundFrameOverheadBytes(frameBytes),
        );
        queued[0] = SINGLE_CALL_ENVELOPE_VERSION;
        crypto.getRandomValues(queued.subarray(1));
      } else {
        queued = new Uint8Array(
          await envelopeOf(rawPartner, partner, STILL_WORKING_FRAME, false),
        );
        queued[queued.length - 1] ^= 1;
      }
      await rawPartner.send(queued);

      const reads = vi.spyOn(local, "receive");
      vi.useFakeTimers();
      const layer = layerOver(local);
      layer.start();
      await vi.advanceTimersByTimeAsync(STILL_WORKING_INTERVAL_MS);

      expect(reads).toHaveBeenCalledTimes(1);
      await (reads.mock.results[0].value as Promise<unknown>).catch(() => {});
      await vi.advanceTimersByTimeAsync(PARTNER_SILENCE_BOUND_MS);
      expect(armed).not.toHaveBeenCalled();

      expect(reads).toHaveBeenCalledTimes(1);
      const refusal = refusalOf(layer);
      await vi.advanceTimersByTimeAsync(0);
      expectSecurityRefusal(await refusal);
      // The encrypted layer latches its failure, so a second read would
      // reject too; one read shows the error came from the drain's hold.
      expect(reads).toHaveBeenCalledTimes(1);
      await layer.endPhase();
    },
  );
});

describe("a whole exchange", () => {
  // `conn` with each frame it is handed to send recorded.
  function recordingSends(
    conn: MessageConnection,
    sent: Array<unknown>,
  ): MessageConnection {
    return connectionLayer(conn, {
      send: (data) => {
        sent.push(data);
        return conn.send(data);
      },
    });
  }

  test.each(["cascade", "single-pass"] as const)(
    "a %s exchange where both parties send still-working frames links as one without them",
    async (linkageStrategy) => {
      const psiLibrary = await PSI();
      const rows = (names: Array<string>) =>
        names.map((first_name) => ({ first_name }));
      const run = async (stillWorkingFrames: boolean) => {
        const [a, b] = createMessagePipe({ stillWorkingFrames });
        const sentByA: Array<unknown> = [];
        const [resultA, resultB] = await Promise.all([
          runExchange(
            recordingSends(a, sentByA),
            "initiator",
            prepared("Party A", rows(["ann", "bob", "cy"]), {
              terms: { linkageStrategy },
            }),
            { psiLibrary },
          ),
          runExchange(
            b,
            "responder",
            prepared("Party B", rows(["bob", "cy", "dee"]), {
              terms: { linkageStrategy },
            }),
            { psiLibrary },
          ),
        ]);
        return { resultA, resultB, sentByA };
      };

      const withFrames = await run(true);
      const without = await run(false);
      expect(withFrames.resultA.associationTable).toStrictEqual(
        without.resultA.associationTable,
      );
      expect(withFrames.resultB.associationTable).toStrictEqual(
        without.resultB.associationTable,
      );
      expect(withFrames.resultA.associationTable?.[0]).toHaveLength(2);
      expect(
        withFrames.sentByA.filter((frame) => isStillWorkingFrame(frame)),
      ).not.toHaveLength(0);
      expect(
        without.sentByA.filter((frame) => isStillWorkingFrame(frame)),
      ).toHaveLength(0);
    },
  );

  test("a party sends its progress through a long crypto operation, and its waiting partner is shown it, then the clear", async () => {
    const psiLibrary = await PSI();
    const cryptoOperations = new Set<PsiOperation>([
      "createServerSetup",
      "createClientRequest",
      "processClientRequest",
      "computeAssociationTable",
    ]);
    // Party A's engine reports one element processed at the start of its
    // first crypto operation, then runs it for two intervals.
    let slowedOnce = false;
    const slowEngine: RunExchangeOptions["psiEngineFactory"] = (
      role,
      id,
      mode,
    ) => {
      const inner = new InProcessPsiEngine(psiLibrary, role, id, mode);
      let observer: ((processed: number) => void) | undefined;
      return new Proxy(inner, {
        get(target, property) {
          if (property === "observeProcessedElements")
            return (report: (processed: number) => void) => {
              observer = report;
            };
          const member: unknown = Reflect.get(target, property, target);
          if (typeof member !== "function") return member;
          const bound = (member as (...args: unknown[]) => unknown).bind(
            target,
          );
          if (!cryptoOperations.has(property as PsiOperation) || slowedOnce)
            return bound;
          return async (...args: unknown[]) => {
            slowedOnce = true;
            observer?.(1);
            await new Promise((resolve) =>
              setTimeout(resolve, 2 * STILL_WORKING_INTERVAL_MS),
            );
            return bound(...args);
          };
        },
      });
    };
    const rows = (names: Array<string>) =>
      names.map((first_name) => ({ first_name }));
    const [a, b] = createMessagePipe({ stillWorkingFrames: true });
    const sentByA: Array<unknown> = [];
    const reportsOfA: Array<PsiProgress> = [];
    const shownToB: Array<number | undefined> = [];

    vi.useFakeTimers();
    const { state } = settledOf(
      Promise.all([
        runExchange(
          recordingSends(a, sentByA),
          "initiator",
          prepared("Party A", rows(["ann", "bob", "cy"])),
          {
            psiLibrary,
            psiEngineFactory: slowEngine,
            onPsiProgress: (progress) => reportsOfA.push(progress),
          },
        ),
        runExchange(
          b,
          "responder",
          prepared("Party B", rows(["bob", "cy", "dee"])),
          {
            psiLibrary,
            onPartnerProgress: (percent) => shownToB.push(percent),
          },
        ),
      ]),
    );
    for (let i = 0; i < 1000 && !state.settled; i++)
      await vi.advanceTimersByTimeAsync(1000);

    expect(state.error).toBeUndefined();
    const reported = reportsOfA.find(
      (progress) => progress.state === "progress",
    );
    if (reported?.processed === undefined) throw new Error("no progress");
    const percent = Math.floor((100 * reported.processed) / reported.elements);
    expect(
      sentByA.filter(
        (frame) =>
          JSON.stringify(frame) === JSON.stringify({ working: true, percent }),
      ),
    ).not.toHaveLength(0);
    expect(shownToB).toStrictEqual([percent, undefined]);
  });
});

test("an abort sent through the layer counts as sent on the connection under it", async () => {
  const [local, partner] = createMessagePipe({ stillWorkingFrames: true });
  const layer = layerOver(local);
  await sendTermsAbort(layer.conn, ["stopped"]);
  await sendLocalFaultAbort(local, 1_000);
  await local.close();

  const received: Array<unknown> = [];
  for (;;) {
    try {
      received.push(await partner.receive());
    } catch {
      break;
    }
  }
  expect(received).toStrictEqual([decisionOnlyAbortFrame(["stopped"])]);
});
