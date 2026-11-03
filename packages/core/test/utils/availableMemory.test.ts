import { getHeapStatistics } from "node:v8";
import { totalmem } from "node:os";

import { afterEach, expect, test, vi } from "vitest";

import type * as AvailableMemory from "../../src/utils/availableMemory";

// A fresh module per test, since the container limit is read once per module.
async function freshModule(): Promise<typeof AvailableMemory> {
  vi.resetModules();
  return import("../../src/utils/availableMemory");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("on Node it reports no more than the V8 heap's headroom", async () => {
  const { availableMemoryBytes } = await freshModule();
  const available = availableMemoryBytes();
  const heap = getHeapStatistics();
  expect(available).toBeGreaterThan(0);
  expect(available).toBeLessThanOrEqual(heap.heap_size_limit);
});

test("in a container it reports no more than the limit less the resident set", async () => {
  const limit = Math.floor(totalmem() / 2);
  vi.spyOn(process, "constrainedMemory").mockReturnValue(limit);
  vi.spyOn(process.memoryUsage, "rss").mockReturnValue(limit - 1_000);
  const { availableMemoryBytes } = await freshModule();
  expect(availableMemoryBytes()).toBe(1_000);
});

test("a constraint at or past the host's memory is no container limit", async () => {
  vi.spyOn(process, "constrainedMemory").mockReturnValue(totalmem() * 4);
  vi.spyOn(process.memoryUsage, "rss").mockReturnValue(totalmem() * 4);
  const { availableMemoryBytes } = await freshModule();
  expect(availableMemoryBytes()).toBeGreaterThan(0);
});

test("a container read that fails is no reading", async () => {
  vi.spyOn(process, "constrainedMemory").mockImplementation(() => {
    throw new Error("cgroup read failed");
  });
  const { availableMemoryBytes } = await freshModule();
  expect(availableMemoryBytes()).toBeGreaterThan(0);
});

test("a tab heap reading lower than the others is the one reported", async () => {
  Object.defineProperty(performance, "memory", {
    configurable: true,
    value: { jsHeapSizeLimit: 5_000, usedJSHeapSize: 4_500 },
  });
  try {
    const { availableMemoryBytes } = await freshModule();
    expect(availableMemoryBytes()).toBe(500);
  } finally {
    delete (performance as { memory?: unknown }).memory;
  }
});

test("a runtime that reports nothing is assumed to have the fixed figure", async () => {
  const { availableMemoryBytes, UNREPORTED_AVAILABLE_MEMORY_BYTES } =
    await freshModule();
  vi.stubGlobal("process", {});
  const available = availableMemoryBytes();
  vi.unstubAllGlobals();
  expect(available).toBe(UNREPORTED_AVAILABLE_MEMORY_BYTES);
});

test("collectGarbage says whether the runtime exposes a collector it ran", async () => {
  const { collectGarbage } = await freshModule();
  const exposed = typeof (globalThis as { gc?: unknown }).gc === "function";
  expect(collectGarbage()).toBe(exposed);
});
