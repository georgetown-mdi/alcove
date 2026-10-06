import { vi } from "vitest";
import type { MockInstance } from "vitest";

/**
 * Replace `process.exit` with a throw for the duration of a test, so a command
 * handler that exits can be driven to completion and its code asserted.
 *
 * The throw is what makes the capture usable: `process.exit` is typed `never`
 * and the handlers rely on that, so a mock that merely records the code and
 * returns would let the code AFTER the exit run -- an exit boundary would then
 * be tested against a control flow production never takes. The message form is
 * `exit:<code>`, which a test matches with `toThrow("exit:64")` where the code
 * is what it is asserting, and the spy's `toHaveBeenCalledWith` where it is not.
 *
 * The caller restores it (`exitSpy.mockRestore()` in a `finally`, or vitest's
 * `restoreMocks`): a leaked mock turns a later test's real exit into a throw in
 * whatever frame happened to call it.
 *
 * @internal test-only
 */
export function captureProcessExit(): MockInstance<typeof process.exit> {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
}

/**
 * Run `body` under a {@link captureProcessExit} spy the caller installed,
 * returning normally whether it exits or not: the capture's `exit:<code>` throw
 * is absorbed and any other error is rethrown. For a helper whose callers
 * assert on the recorded calls rather than on one expected exit.
 *
 * @internal test-only
 */
export async function runToExit(body: () => unknown): Promise<void> {
  try {
    await body();
  } catch (error: unknown) {
    if (!(error instanceof Error) || !/^exit:\d+$/.test(error.message))
      throw error;
  }
}

/**
 * Replace `process.exit` with a no-op that records its code, for an exit made
 * from a signal listener, a timer, or a last-resort `.catch`: a throw there has
 * no awaiting caller, so {@link captureProcessExit} would turn it into an
 * uncaught error. A handler the test awaits takes {@link captureProcessExit}.
 * The caller restores it, as above.
 *
 * @internal test-only
 */
export function recordProcessExit(): MockInstance<typeof process.exit> {
  return vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
}
