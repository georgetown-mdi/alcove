import { describe, expect, it } from "vitest";

import { DIAGNOSTIC_RATE_LIMIT_WINDOW_MS } from "@alcove/peerjs-broker/diagnostics";

import { createFaultLatch } from "../src/faultLatch.ts";
import { RELAY_FAULT_REPORT_WINDOW_MS } from "../src/protocol.ts";

describe("createFaultLatch", () => {
  it("admits one report under a key in each window", () => {
    let now = 0;
    const latch = createFaultLatch(1000, () => now);
    expect(latch.admit("exchange-1")).toBe(true);
    now = 999;
    expect(latch.admit("exchange-1")).toBe(false);
    now = 1000;
    expect(latch.admit("exchange-1")).toBe(true);
    now = 1500;
    expect(latch.admit("exchange-1")).toBe(false);
  });

  it("keeps each key's window apart", () => {
    let now = 0;
    const latch = createFaultLatch(1000, () => now);
    expect(latch.admit("exchange-1")).toBe(true);
    now = 500;
    expect(latch.admit("exchange-2")).toBe(true);
    expect(latch.admit("exchange-1")).toBe(false);
    now = 1000;
    expect(latch.admit("exchange-1")).toBe(true);
    expect(latch.admit("exchange-2")).toBe(false);
    now = 1500;
    expect(latch.admit("exchange-2")).toBe(true);
  });

  it("uses the signaling broker's diagnostics window", () => {
    expect(RELAY_FAULT_REPORT_WINDOW_MS).toBe(DIAGNOSTIC_RATE_LIMIT_WINDOW_MS);
  });
});
