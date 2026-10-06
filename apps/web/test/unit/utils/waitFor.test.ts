import { afterEach, describe, expect, test, vi } from "vitest";

import { waitFor } from "../../utils/waitFor";

afterEach(() => {
  vi.useRealTimers();
});

describe("the shared poll helper", () => {
  test("resolves once the condition holds", async () => {
    let checks = 0;
    await waitFor(() => ++checks >= 3, { intervalMs: 1 });
    expect(checks).toBe(3);
  });

  test("awaits an async condition", async () => {
    let checks = 0;
    await waitFor(() => Promise.resolve(++checks >= 2), { intervalMs: 1 });
    expect(checks).toBe(2);
  });

  test("fails with its message once the deadline passes", async () => {
    await expect(
      waitFor(() => false, {
        timeoutMs: 30,
        intervalMs: 5,
        message: "the record never settled",
      }),
    ).rejects.toThrow("the record never settled");
  });

  test("advances fake timers rather than hanging under them", async () => {
    vi.useFakeTimers();
    let fired = false;
    setTimeout(() => (fired = true), 300);
    await waitFor(() => fired, { intervalMs: 100 });
    expect(fired).toBe(true);
  });
});
