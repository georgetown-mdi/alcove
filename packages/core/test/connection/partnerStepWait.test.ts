import { afterEach, describe, expect, test, vi } from "vitest";

import {
  BROWSER_PSI_SET_MAX_ELEMENTS,
  MAX_PSI_DECODE_ELEMENTS,
} from "../../src/connection/frameSize";
import {
  QueuedMessageConnection,
  isReceiveDeadlineFailure,
} from "../../src/connection/messageConnection";
import {
  PARTNER_STEP_WAIT_FLOOR_MS,
  SLOWEST_RECORDED_PSI_STEP,
  partnerStepWaitMs,
} from "../../src/connection/partnerStepWait";
import { MAX_TIMER_MS } from "../../src/utils/promise";

import type { TransportControls } from "../../src/connection/messageConnection";

const HOUR_MS = 60 * 60 * 1000;

const atCeilings = (
  localValueSlots: number,
  partnerValueSlots: number,
  ceiling: number = MAX_PSI_DECODE_ELEMENTS,
) =>
  partnerStepWaitMs({
    localValueSlots,
    partnerValueSlots,
    localReceiveCeiling: ceiling,
    partnerReceiveCeiling: ceiling,
  });

describe("partnerStepWaitMs", () => {
  test("keeps the one-hour floor for a small exchange", () => {
    expect(PARTNER_STEP_WAIT_FLOOR_MS).toBe(HOUR_MS);
    expect(atCeilings(1, 1)).toBe(HOUR_MS);
    expect(atCeilings(100_000, 100_000)).toBe(HOUR_MS);
  });

  test("lengthens the wait only past the slots the recorded rate puts at one hour", () => {
    // 3,600 s at 4,219.7 s per 8,388,608 value slots is 7,156,667.3 slots.
    expect(atCeilings(3_578_333, 3_578_334)).toBe(HOUR_MS);
    expect(atCeilings(3_578_334, 3_578_334)).toBe(HOUR_MS + 1);
  });

  test("at the browser's ceiling a side is twice the slowest recorded step", () => {
    const wait = atCeilings(
      BROWSER_PSI_SET_MAX_ELEMENTS,
      BROWSER_PSI_SET_MAX_ELEMENTS,
      BROWSER_PSI_SET_MAX_ELEMENTS,
    );
    expect(SLOWEST_RECORDED_PSI_STEP.valueSlots).toBe(
      BROWSER_PSI_SET_MAX_ELEMENTS,
    );
    expect(wait).toBe(2 * SLOWEST_RECORDED_PSI_STEP.durationMs);
    expect(wait).toBe(8_439_400);
  });

  test("covers every PSI step recorded at the browser's ceiling, and the single-pass starter's whole run", () => {
    const wait = atCeilings(
      BROWSER_PSI_SET_MAX_ELEMENTS,
      BROWSER_PSI_SET_MAX_ELEMENTS,
      BROWSER_PSI_SET_MAX_ELEMENTS,
    );
    // docs/spec/PROTOCOL.md, What a browser tab can match: each step at
    // 8,388,608 value slots a side, and the single-pass starter's wall time.
    const recordedMs = [
      2_978_000, 2_977_600, 2_460_800, 2_426_400, 2_966_200, 2_965_900,
      2_452_200, 4_069_000, 3_136_500, 4_219_700, 3_789_100, 3_065_700,
      7_247_000,
    ];
    for (const ms of recordedMs) expect(wait).toBeGreaterThanOrEqual(ms);
  });

  test("holds each party's value slots to the ceiling the other states", () => {
    const capped = partnerStepWaitMs({
      localValueSlots: 50_000_000,
      partnerValueSlots: 50_000_000,
      localReceiveCeiling: BROWSER_PSI_SET_MAX_ELEMENTS,
      partnerReceiveCeiling: MAX_PSI_DECODE_ELEMENTS,
    });
    expect(capped).toBe(
      atCeilings(MAX_PSI_DECODE_ELEMENTS, BROWSER_PSI_SET_MAX_ELEMENTS),
    );
  });

  test("is at most four times the slowest recorded step, well inside a timer's range", () => {
    const most = partnerStepWaitMs({
      localValueSlots: Number.MAX_SAFE_INTEGER,
      partnerValueSlots: Number.MAX_SAFE_INTEGER,
      localReceiveCeiling: Number.MAX_SAFE_INTEGER,
      partnerReceiveCeiling: Number.MAX_SAFE_INTEGER,
    });
    expect(most).toBe(4 * SLOWEST_RECORDED_PSI_STEP.durationMs);
    expect(most).toBe(16_878_800);
    expect(most).toBeLessThan(MAX_TIMER_MS);
  });
});

function makeQueued(options: {
  inactivityTimeoutMs?: number;
  inactivityTimeoutRaisable?: boolean;
}): {
  conn: QueuedMessageConnection;
  controls: TransportControls;
  send: ReturnType<typeof vi.fn>;
} {
  let controls!: TransportControls;
  const send = vi.fn();
  const conn = new QueuedMessageConnection((c) => {
    controls = c;
    return { send, close: vi.fn() };
  }, options);
  return { conn, controls, send };
}

describe("raiseInactivityTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a receive parked through a partner step past the default is not ended once the budget is raised", async () => {
    vi.useFakeTimers();
    const { conn, controls } = makeQueued({
      inactivityTimeoutMs: HOUR_MS,
      inactivityTimeoutRaisable: true,
    });
    conn.raiseInactivityTimeout(3 * HOUR_MS);
    const received = conn.receive();
    await vi.advanceTimersByTimeAsync(3 * HOUR_MS - 1);
    controls.deliver("setup", 5);
    expect(await received).toBe("setup");
  });

  test("a partner silent past the raised budget ends the run with the peer-inactivity refusal", async () => {
    vi.useFakeTimers();
    const { conn } = makeQueued({
      inactivityTimeoutMs: HOUR_MS,
      inactivityTimeoutRaisable: true,
    });
    conn.raiseInactivityTimeout(3 * HOUR_MS);
    const received = conn.receive().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(3 * HOUR_MS);
    const failure = await received;
    expect(isReceiveDeadlineFailure(failure)).toBe(true);
    expect((failure as Error).message).toBe(
      `no message arrived within ${3 * HOUR_MS} ms; the partner appears to have gone silent`,
    );
  });

  test("a receive already parked waits the raised budget afresh", async () => {
    vi.useFakeTimers();
    const { conn, controls } = makeQueued({
      inactivityTimeoutMs: HOUR_MS,
      inactivityTimeoutRaisable: true,
    });
    const received = conn.receive();
    await vi.advanceTimersByTimeAsync(HOUR_MS - 1);
    conn.raiseInactivityTimeout(2 * HOUR_MS);
    await vi.advanceTimersByTimeAsync(2 * HOUR_MS - 1);
    controls.deliver("late", 4);
    expect(await received).toBe("late");
  });

  test("a budget that is not the transport's default is not raised", async () => {
    vi.useFakeTimers();
    const { conn } = makeQueued({ inactivityTimeoutMs: 10_000 });
    conn.raiseInactivityTimeout(3 * HOUR_MS);
    const received = conn.receive().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(isReceiveDeadlineFailure(await received)).toBe(true);
  });

  test("never lowers the budget, and ignores a value that is not finite", async () => {
    vi.useFakeTimers();
    const { conn, controls } = makeQueued({
      inactivityTimeoutMs: HOUR_MS,
      inactivityTimeoutRaisable: true,
    });
    conn.raiseInactivityTimeout(1_000);
    conn.raiseInactivityTimeout(Number.NaN);
    conn.raiseInactivityTimeout(Number.POSITIVE_INFINITY);
    const received = conn.receive();
    await vi.advanceTimersByTimeAsync(HOUR_MS - 1);
    controls.deliver("in time", 7);
    expect(await received).toBe("in time");
  });

  test("holds a raised budget to the longest a timer can wait", async () => {
    vi.useFakeTimers();
    const { conn, controls } = makeQueued({
      inactivityTimeoutMs: HOUR_MS,
      inactivityTimeoutRaisable: true,
    });
    conn.raiseInactivityTimeout(Number.MAX_SAFE_INTEGER);
    const received = conn.receive();
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    controls.deliver("still waiting", 13);
    expect(await received).toBe("still waiting");
  });

  test("a send's hand-off is bounded by the raised budget", async () => {
    vi.useFakeTimers();
    const { conn, send } = makeQueued({
      inactivityTimeoutMs: HOUR_MS,
      inactivityTimeoutRaisable: true,
    });
    conn.raiseInactivityTimeout(2 * HOUR_MS);
    send.mockReturnValue(new Promise(() => {}));
    let failure: unknown;
    const sending = conn.send("x").catch((e: unknown) => {
      failure = e;
    });
    await vi.advanceTimersByTimeAsync(2 * HOUR_MS - 1);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await sending;
    expect((failure as Error).message).toContain(
      `was not accepted for sending within ${2 * HOUR_MS} ms`,
    );
  });
});
