import { execFileSync } from "node:child_process";
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

test("a runtime that reports neither reading gives none", async () => {
  const { availableMemoryBytes } = await freshModule();
  vi.stubGlobal("process", {});
  const available = availableMemoryBytes();
  vi.unstubAllGlobals();
  expect(available).toBeUndefined();
});

test("on Node collectGarbage runs a collection", async () => {
  const { collectGarbage } = await freshModule();
  expect(collectGarbage()).toBe(true);
});

// This suite's Node may expose `gc`, and a global it set cannot be removed,
// so the run-time route runs in a Node started without the flag.
function inBareNode(script: string): string {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8", timeout: 20_000 },
  ).trim();
}

const MODULE_URL = new URL(
  "../../src/utils/availableMemory.ts",
  import.meta.url,
).href;

test("on a Node started without --expose-gc, collectGarbage obtains a collector that frees garbage", () => {
  const out = inBareNode(`
    import { getHeapStatistics } from "node:v8";
    const { collectGarbage } = await import(${JSON.stringify(MODULE_URL)});
    let garbage = Array.from({ length: 1_000_000 }, (_, i) => ({ i }));
    garbage = null;
    const before = getHeapStatistics().used_heap_size;
    const ran = collectGarbage();
    const after = getHeapStatistics().used_heap_size;
    console.log(JSON.stringify({ exposed: typeof globalThis.gc, ran, freed: before - after }));
  `);
  const { exposed, ran, freed } = JSON.parse(out) as {
    exposed: string;
    ran: boolean;
    freed: number;
  };
  expect(exposed).toBe("undefined");
  expect(ran).toBe(true);
  expect(freed).toBeGreaterThan(10 * 2 ** 20);
});

test("a runtime that can provide no collector runs none", () => {
  const out = inBareNode(`
    const { collectGarbage } = await import(${JSON.stringify(MODULE_URL)});
    const real = globalThis.process;
    Object.defineProperty(globalThis, "process", { value: {}, configurable: true });
    const ran = collectGarbage();
    Object.defineProperty(globalThis, "process", { value: real, configurable: true });
    console.log(String(ran));
  `);
  expect(out).toBe("false");
});
