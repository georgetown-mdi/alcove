import { vi } from "vitest";

/** Settings for {@link waitFor}. */
export interface WaitForOptions {
  /** How long the condition may stay false before the wait fails. */
  timeoutMs?: number;
  /** How often the condition is checked. */
  intervalMs?: number;
  /** The failure message once `timeoutMs` passes. */
  message?: string;
}

/** The deadline a wait gets when a test names none. */
export const DEFAULT_WAIT_TIMEOUT_MS = 5_000;

/**
 * Resolve once `condition` returns true, checking every `intervalMs`. Past
 * `timeoutMs` it rejects with `message`, so a condition that never holds fails
 * naming itself rather than as the test's own timeout. It polls through
 * `vi.waitFor`, which under fake timers advances the clock by `intervalMs` per
 * check instead of hanging. Has no Node import, so a browser suite can use it.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  {
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    intervalMs = 10,
    message = "condition not met in time",
  }: WaitForOptions = {},
): Promise<void> {
  await vi.waitFor(
    async () => {
      if (!(await condition())) throw new Error(message);
    },
    { timeout: timeoutMs, interval: intervalMs },
  );
}
