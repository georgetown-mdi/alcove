import { assertFirstRoundFitsFileSyncFrame } from "@alcove/core";
import type {
  ConnectionConfig,
  PreparedExchange,
  PsiProgressReporter,
} from "@alcove/core";

const passedFileSyncFirstRoundCheck = new WeakSet<PreparedExchange>();

/**
 * Refuse, on an SFTP or synced-folder connection, a first round too large for
 * one message file (`assertFirstRoundFitsFileSyncFrame`); a no-op on WebRTC,
 * whose own check runs as the transport is prepared. The refusal is decided
 * from local input, so a command runs this before the host-key step, whose
 * first-use probe contacts the server. `runProtocol` runs it again for a
 * caller that did not, and a prepared exchange that already passed is not
 * counted a second time. `onProgress` takes the count's progress reports.
 */
export async function assertFileSyncFirstRoundFits(
  connection: Pick<ConnectionConfig, "channel">,
  prepared: PreparedExchange,
  onProgress?: PsiProgressReporter,
): Promise<void> {
  if (connection.channel === "webrtc") return;
  if (passedFileSyncFirstRoundCheck.has(prepared)) return;
  await assertFirstRoundFitsFileSyncFrame(prepared, { onProgress });
  passedFileSyncFirstRoundCheck.add(prepared);
}
