import {
  assertFirstRoundFitsFileSyncFrame,
  assertFirstRoundFitsWebRtcFrame,
} from "@alcove/core";
import type {
  ConnectionConfig,
  PreparedExchange,
  PsiProgressReporter,
} from "@alcove/core";

const passedFileSyncFirstRoundCheck = new WeakSet<PreparedExchange>();
const passedWebRtcFirstRoundCheck = new WeakSet<PreparedExchange>();

/**
 * Refuse, on an SFTP or synced-folder connection, a first round with more
 * values than one PSI set can hold (`assertFirstRoundFitsFileSyncFrame`),
 * the set itself being sent in parts; a no-op on WebRTC,
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

/**
 * Refuse a first round too large for the connection's channel: one WebRTC
 * message (`assertFirstRoundFitsWebRtcFrame`) or one PSI set on SFTP or a
 * synced folder ({@link assertFileSyncFirstRoundFits}). As there, a prepared
 * exchange that already passed is not counted a second time.
 */
export async function assertFirstRoundFits(
  connection: Pick<ConnectionConfig, "channel">,
  prepared: PreparedExchange,
  onProgress?: PsiProgressReporter,
): Promise<void> {
  if (connection.channel !== "webrtc")
    return assertFileSyncFirstRoundFits(connection, prepared, onProgress);
  if (passedWebRtcFirstRoundCheck.has(prepared)) return;
  await assertFirstRoundFitsWebRtcFrame(prepared, { onProgress });
  passedWebRtcFirstRoundCheck.add(prepared);
}
