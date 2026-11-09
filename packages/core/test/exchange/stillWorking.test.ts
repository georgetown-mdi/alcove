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
import { olderVersionOf } from "../../src/failureClass";
import { runExchange } from "../../src/exchange";
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
  PARTNER_SILENCE_BOUND_MS,
  STILL_WORKING_FRAME,
  STILL_WORKING_INTERVAL_MS,
  isStillWorkingFrame,
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

describe("a partner on an older version", () => {
  test("a partner whose first PSI-phase frame is data is refused as running an older version", async () => {
    const [local, partner] = createMessagePipe({ stillWorkingFrames: true });
    const layer = layerOver(local);
    await partner.send({ round: 1 });
    const refused = await layer.conn.receive().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PartnerProtocolRefusalError);
    expect((refused as Error).message).toBe(OLDER_PARTNER_AT_MATCHING_MESSAGE);
    expect(olderVersionOf(refused)).toBe("partner");
    expect(statesItsOwnNextStep(refused)).toBe(true);
  });

  test("a partner whose first PSI-phase frame is its local-fault abort is refused as running an older version, the abort kept as the cause", async () => {
    const [local, partner] = createMessagePipe({ stillWorkingFrames: true });
    const layer = layerOver(local);
    await partner.send(decisionOnlyAbortFrame([LOCAL_FAULT_ABORT_REASON]));
    const refused = await layer.conn.receive().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PartnerProtocolRefusalError);
    expect(olderVersionOf(refused)).toBe("partner");
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
