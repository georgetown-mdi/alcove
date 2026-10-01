import { assertFirstRoundWithinSetMaximum } from "@alcove/core";
import type {
  ConnectionConfig,
  PreparedExchange,
  PsiProgressReporter,
} from "@alcove/core";

const passedFirstRoundCheck = new WeakSet<PreparedExchange>();

/**
 * Refuse, on an SFTP or synced-folder connection, a first round with more
 * values than one PSI set can hold ({@link assertFirstRoundFits}); a no-op on
 * WebRTC, whose check runs as the transport is prepared. The refusal is
 * decided from local input, so a command runs this before the host-key step,
 * whose first-use probe contacts the server. `onProgress` takes the count's
 * progress reports.
 */
export async function assertFileSyncFirstRoundFits(
  connection: Pick<ConnectionConfig, "channel">,
  prepared: PreparedExchange,
  onProgress?: PsiProgressReporter,
): Promise<void> {
  if (connection.channel === "webrtc") return;
  await assertFirstRoundFits(prepared, onProgress);
}

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
