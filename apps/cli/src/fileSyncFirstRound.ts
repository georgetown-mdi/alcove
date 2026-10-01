import { assertFirstRoundWithinSetMaximum } from "@alcove/core";
import type { PreparedExchange, PsiProgressReporter } from "@alcove/core";

const passedFirstRoundCheck = new WeakSet<PreparedExchange>();

/**
 * Refuse, on any channel, a first round with more values than one PSI set can
 * hold (`assertFirstRoundWithinSetMaximum`), the set itself being sent in
 * parts. `runProtocol` runs it for a caller that did not, and a prepared
 * exchange that already passed is not counted a second time. The partner's
 * stated receive ceiling is checked once the terms are exchanged.
 */
export async function assertFirstRoundFits(
  prepared: PreparedExchange,
  onProgress?: PsiProgressReporter,
): Promise<void> {
  if (passedFirstRoundCheck.has(prepared)) return;
  await assertFirstRoundWithinSetMaximum(prepared, { onProgress });
  passedFirstRoundCheck.add(prepared);
}
